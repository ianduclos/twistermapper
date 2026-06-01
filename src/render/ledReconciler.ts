/* Task: Implement LedReconciler (diff + precedence + rate limits)
Spec: Obey /src/Architecture.md — sections:
- "Renderer & rate limits" (burst window, caps, flush ordering, initial paint)
- "Animation precedence" (pulse vs brightness)
- "Device map" (value ranges are already humanized here)

Acceptance Criteria:
1) State:
   - Maintain an internal device cache (LedFrame) of last-sent values.
   - First push() initializes cache on-demand (full diff) and sends only what is needed.
2) push(desired):
   - If desired is undefined, do nothing.
   - Compute per-encoder, per-field diffs; last-write-wins within a burst.
   - Precedence:
     a) If desired.anim === 'pulse' => call midi.setPulse(enc) and SKIP brightness sends this burst.
     b) If previous anim was 'pulse' and now 'none' => send setLedBrightness(enc, desired.ledBrightness) immediately.
   - Flush ordering per encoder: ledBrightness -> ringBrightness -> rgb -> ring.
   - Update the cache to reflect what was actually sent this burst.
3) Rate limiting:
   - Burst window: 5 ms; max 64 MIDI messages per burst.
   - Rolling cap: 400 messages/sec overall.
   - After beginFocusPaint(), allow a one-time initial burst up to 128 messages, then revert.
   - If the desired diff exceeds the burst allowance, queue remaining changes for the next burst(s).
4) API:
   - constructor(midi: MidiOut)
   - beginFocusPaint(): enables the one-time larger burst for the next flush only.
   - push(desired: LedFrame | undefined): void
   - getters: get msgsSentLastBurst(): number; get msgsPerSec(): number
5) Constraints:
   - Do NOT change MidiOut interface or imports.
   - ESM (NodeNext). No external deps. Keep code readable and commented.
*/

import { performance } from "node:perf_hooks"
import { EncId, LedFrame } from "../core/types.js"
import { MidiOut } from "../io/midiDriver.js"

export class LedReconciler {
	private readonly midi: MidiOut
	private cache: LedFrame | null = null
	private pending = new Map<number, PendingEncoderState>()
	private readonly burstMax = 64
	private readonly allowInitialPaint = 128
	private burstWindowStart = 0
	private burstWindowCount = 0
	private burstWindowLimit = this.burstMax
	private lastBurstCount = 0
	private focusBurstPending = false
	private sentTimestamps: number[] = []

	constructor(midi: MidiOut) {
		this.midi = midi
	}

	beginFocusPaint() {
		this.focusBurstPending = true
		if (this.burstWindowCount === 0) {
			this.burstWindowLimit = this.allowInitialPaint
		}
	}

	push(desired: LedFrame | undefined) {
		if (!desired) return
		if (!this.cache) {
			this.cache = this.createEmptyCache()
		}

		// Update pending diffs so the queue represents the latest desired state.
		for (let i = 0; i < 16; i++) {
			const enc = i as EncId
			const target = desired[enc]
			if (!target) continue
			const cacheState = this.cache[enc]
			const pendingState = this.pending.get(enc) ?? createEmptyPending()

			const targetIsPulse = target.anim === "pulse"
			if (targetIsPulse) {
				if (cacheState.anim !== "pulse") {
					pendingState.pulse = true
				} else {
					delete pendingState.pulse
				}
			} else {
				delete pendingState.pulse
			}

			const forceBrightness = !targetIsPulse && cacheState.anim === "pulse"
			const brightnessChanged =
				cacheState.ledBrightness !== target.ledBrightness
			if (forceBrightness || brightnessChanged) {
				pendingState.ledBrightness = {
					value: target.ledBrightness,
					force: forceBrightness || pendingState.ledBrightness?.force || false,
				}
			} else if (!pendingState.ledBrightness?.force) {
				delete pendingState.ledBrightness
			}

			if (cacheState.ringBrightness !== target.ringBrightness) {
				pendingState.ringBrightness = target.ringBrightness
			} else {
				delete pendingState.ringBrightness
			}

			if (cacheState.rgb !== target.rgb) {
				pendingState.rgb = target.rgb
			} else {
				delete pendingState.rgb
			}

			if (cacheState.ring !== target.ring) {
				pendingState.ring = target.ring
			} else {
				delete pendingState.ring
			}

			if (hasPendingWork(pendingState)) {
				this.pending.set(enc, pendingState)
			} else {
				this.pending.delete(enc)
			}
		}

		this.flush(desired)
	}

	get msgsSentLastBurst(): number {
		return this.lastBurstCount
	}

	get msgsPerSec(): number {
		const now = performance.now()
		this.pruneSentTimestamps(now)
		return this.sentTimestamps.length
	}

	private flush(desired: LedFrame) {
		if (!this.cache) return

		// Process encoders in numeric order for stable behavior
		const encoders = Array.from(this.pending.keys()).sort((a, b) => a - b)

		for (const enc of encoders) {
			const encId = enc as EncId

			// Check/reset the 5ms burst window
			this.ensureBurstWindow(performance.now())

			const desiredState = desired[encId]
			const pendingState = this.pending.get(enc)

			if (!pendingState || !desiredState) {
				this.pending.delete(enc)
				continue
			}

			// --- Animation precedence: 'pulse' overrides LED brightness for THIS BURST only ---
			// We still allow ringBrightness, RGB, and ring to update while pulsing.
			let skipLedBrightness = false

			if (desiredState.anim === "pulse") {
				if (pendingState.pulse) {
					// Send pulse (only once when transitioning into pulse)
					if (!this.sendWithLimits(() => this.midi.setPulse(enc))) break
					this.cache[encId].anim = "pulse"
					delete pendingState.pulse
				}
				// While in pulse, don't send setLedBrightness this burst
				skipLedBrightness = true
			}
			// If we are leaving pulse, push() has already marked ledBrightness.force=true,
			// so the brightness send below will also clear anim->'none' immediately.

			// --- Flush order per encoder: ledBrightness -> ringBrightness -> rgb -> ring ---

			// 1) LED brightness (unless suppressed by pulse this burst)
			if (!skipLedBrightness && pendingState.ledBrightness) {
				const { value, force } = pendingState.ledBrightness
				if (force || this.cache[encId].ledBrightness !== value) {
					if (
						!this.sendWithLimits(() => this.midi.setLedBrightness(enc, value))
					)
						break
					this.cache[encId].ledBrightness = value
					// Leaving pulse is handled by forcing brightness; ensure cache anim reflects that
					this.cache[encId].anim = "none"
				}
				delete pendingState.ledBrightness
			}

			// 2) Ring brightness
			if (pendingState.ringBrightness !== undefined) {
				const value = pendingState.ringBrightness
				if (this.cache[encId].ringBrightness !== value) {
					if (
						!this.sendWithLimits(() => this.midi.setRingBrightness(enc, value))
					)
						break
					this.cache[encId].ringBrightness = value
				}
				delete pendingState.ringBrightness
			}

			// 3) RGB color
			if (pendingState.rgb !== undefined) {
				const value = pendingState.rgb
				if (this.cache[encId].rgb !== value) {
					if (!this.sendWithLimits(() => this.midi.setRGB(enc, value))) break
					this.cache[encId].rgb = value
				}
				delete pendingState.rgb
			}

			// 4) Ring level
			if (pendingState.ring !== undefined) {
				const value = pendingState.ring
				if (this.cache[encId].ring !== value) {
					if (!this.sendWithLimits(() => this.midi.setRing(enc, value))) break
					this.cache[encId].ring = value
				}
				delete pendingState.ring
			}

			// Clean up if nothing left for this encoder
			if (!hasPendingWork(pendingState)) {
				this.pending.delete(enc)
			}
		}
	}

	private sendWithLimits(sender: () => void): boolean {
		const now = performance.now()
		this.ensureBurstWindow(now)
		if (!this.hasBurstCapacity()) return false
		if (!this.hasRollingCapacity(now)) return false
		sender()
		this.recordSend(now)
		return true
	}

	private hasBurstCapacity(): boolean {
		return this.burstWindowCount < this.burstWindowLimit
	}

	private hasRollingCapacity(now: number): boolean {
		this.pruneSentTimestamps(now)
		return this.sentTimestamps.length < 400
	}

	private recordSend(now: number) {
		this.burstWindowCount += 1
		this.sentTimestamps.push(now)
	}

	private pruneSentTimestamps(now: number) {
		// Drop everything older than 1s in a single splice (vs. O(n) shift per entry).
		let expired = 0
		while (
			expired < this.sentTimestamps.length &&
			now - this.sentTimestamps[expired] > 1000
		) {
			expired++
		}
		if (expired > 0) this.sentTimestamps.splice(0, expired)
	}

	private ensureBurstWindow(now: number) {
		if (this.burstWindowStart === 0 || now - this.burstWindowStart >= 5) {
			if (this.burstWindowStart !== 0) {
				this.lastBurstCount = this.burstWindowCount
			}
			this.burstWindowStart = now
			this.burstWindowCount = 0
			this.burstWindowLimit = this.focusBurstPending
				? this.allowInitialPaint
				: this.burstMax
			this.focusBurstPending = false
		}
	}

	private createEmptyCache(): LedFrame {
		const frame = {} as LedFrame
		for (let i = 0; i < 16; i++) {
			const enc = i as EncId
			frame[enc] = {
				ring: -1,
				rgb: -1,
				ledBrightness: -1,
				ringBrightness: -1,
				anim: "none",
			}
		}
		return frame
	}
}

interface PendingEncoderState {
	ledBrightness?: { value: number; force?: boolean }
	ringBrightness?: number
	rgb?: number
	ring?: number
	pulse?: boolean
}

function createEmptyPending(): PendingEncoderState {
	return {}
}

function hasPendingWork(state: PendingEncoderState): boolean {
	return (
		!!state.pulse ||
		state.ledBrightness !== undefined ||
		state.ringBrightness !== undefined ||
		state.rgb !== undefined ||
		state.ring !== undefined
	)
}
