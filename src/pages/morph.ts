/* MorphPage — scene morph with a dissolving "phantom" snapshot.
 *
 * Layout: top 12 encoders (0–11) are the OUTPUT (12 values); bottom 4 (12–15) are
 * scene faders. There are 4 saved scenes plus a live "phantom" scene P.
 *
 * The phantom is NOT a peer of the scenes — it's a fresh snapshot of what you're
 * currently seeing, taken whenever you move a value knob, with weight 100%. So:
 *   - Move a value knob → P = snapshot(current output), phantom weight → 100%,
 *     then edit it. Output = P (your edit, 1:1 free). Faders keep their positions.
 *   - Move any fader (up OR down) → the phantom weight decays toward 0, crossfading
 *     the output from the snapshot into the scene blend.
 *   - Faders are absolute 0..127 and blend together (multiple at once); pushing a
 *     maxed fader further reduces the other faders.
 *     out[i] = wp·P[i] + (1−wp)·(Σ wₖ·Sₖ[i] / Σwₖ),  wp = max(0, 1 − travel/DECAY)
 *
 * Press a top knob to toggle a value LOCK (reddish-orange): a locked param is a
 * free direct control (out = its live value, immune to the morph). Press a fader
 * to recall its scene; shift+press to save. Persistence is Max's (no serialize):
 * /dump emits each scene's values; /scene/<k>/set <12 floats> restores one.
 */

import { Page, LedFrame, EncId, PageContext } from "../core/types.js"
import { clamp, toFixedN, to127 } from "../util/scale.js"

const OUTPUT_COUNT = 12
const SCENE_COUNT = 4
const FADER_OFFSET = 12 // encoders 12..15 are the scene faders

// Fader travel (sum of |deltas| since the last value-knob move) needed to fully
// dissolve the phantom. ~one full fader sweep. Tunable.
const PHANTOM_DECAY = 127

const TOP_COLOR = 1 // blue — outputs
const LOCK_COLOR = 77 // reddish orange — locked (free/direct) outputs
const SCENE_COLORS = [80, 60, 66, 110] as const // red, green, yellow, purple
const TOP_BRIGHTNESS = 6
const SCENE_BRIGHTNESS_IDLE = 10
const SCENE_BRIGHTNESS_DOMINANT = 29
const SAVE_PULSE_MS = 90

export function MorphPage(): Page {
	const live = new Array<number>(OUTPUT_COUNT).fill(0) // phantom snapshot P
	const scenes = Array.from({ length: SCENE_COUNT }, () => new Array<number>(OUTPUT_COUNT).fill(0))
	const weights = new Array<number>(SCENE_COUNT).fill(0) // absolute fader weights 0..127
	const out = new Array<number>(OUTPUT_COUNT).fill(0) // derived output (0..127)
	const locked = new Array<boolean>(OUTPUT_COUNT).fill(false) // press-to-toggle; out = live (free)
	const lastSent = new Array<number>(OUTPUT_COUNT + SCENE_COUNT).fill(-1)
	const pulseScene = new Array<boolean>(SCENE_COUNT).fill(false)
	let travel = 0 // fader activity since last value move → phantom weight wp = 1 − travel/DECAY
	let pulseTimer: NodeJS.Timeout | null = null
	let dirty = true
	let ctxRef: PageContext | null = null

	const emitType = (ctx: PageContext) => {
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/type`, "Morph")
	}

	const stepFor = (ctx: PageContext, delta: number) =>
		Math.round(delta * (128 / ctx.resolution))

	// Crossfade the snapshot (phantom) into the scene blend by wp; locked params
	// bypass the blend entirely (free direct control).
	const recompute = () => {
		const wp = Math.max(0, 1 - travel / PHANTOM_DECAY)
		let sumW = 0
		for (const w of weights) sumW += w
		for (let i = 0; i < OUTPUT_COUNT; i++) {
			if (locked[i] || sumW === 0) {
				out[i] = live[i] // free direct, or phantom-only when no fader is up
				continue
			}
			let s = 0
			for (let k = 0; k < SCENE_COUNT; k++) s += weights[k] * scenes[k][i]
			const sceneBlend = s / sumW
			out[i] = clamp(Math.round(wp * live[i] + (1 - wp) * sceneBlend), 0, 127)
		}
	}

	// Emit changed outputs (index 0..11) and fader weights (index 12..15).
	const emit = (ctx: PageContext) => {
		for (let i = 0; i < OUTPUT_COUNT; i++) {
			const v = toFixedN(out[i] / 127, 5)
			if (lastSent[i] !== v) {
				lastSent[i] = v
				ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/${i}/value`, v)
			}
		}
		for (let k = 0; k < SCENE_COUNT; k++) {
			const idx = FADER_OFFSET + k
			const v = toFixedN(weights[k] / 127, 5)
			if (lastSent[idx] !== v) {
				lastSent[idx] = v
				ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/${idx}/value`, v)
			}
		}
	}

	const apply = (ctx: PageContext) => {
		recompute()
		emit(ctx)
		dirty = true
	}

	// One-shot save confirmation pulse on the saved scene's encoder.
	const triggerSavePulse = (k: number, ctx: PageContext) => {
		pulseScene[k] = true
		dirty = true
		ctx.setDirty()
		if (pulseTimer) clearTimeout(pulseTimer)
		pulseTimer = setTimeout(() => {
			pulseTimer = null
			pulseScene.fill(false)
			dirty = true
			ctxRef?.setDirty()
		}, SAVE_PULSE_MS)
	}

	// Turn a fader: absolute 0..127; pushing a maxed fader further reduces the
	// others; any movement adds to travel (dissolves the phantom).
	const turnFader = (k: number, d: number) => {
		travel += Math.abs(d)
		if (d > 0) {
			const room = 127 - weights[k]
			if (d <= room) {
				weights[k] += d
			} else {
				weights[k] = 127
				const overflow = d - room
				for (let j = 0; j < SCENE_COUNT; j++) {
					if (j !== k) weights[j] = clamp(weights[j] - overflow, 0, 127)
				}
			}
		} else {
			weights[k] = clamp(weights[k] + d, 0, 127)
		}
	}

	const frame = (): LedFrame => {
		const f = {} as LedFrame
		for (let i = 0; i < OUTPUT_COUNT; i++) {
			f[i as EncId] = {
				ring: to127(out[i]),
				rgb: locked[i] ? LOCK_COLOR : TOP_COLOR,
				ledBrightness: TOP_BRIGHTNESS,
				ringBrightness: 31,
				anim: "none",
			}
		}
		let maxW = 0
		for (const w of weights) if (w > maxW) maxW = w
		for (let k = 0; k < SCENE_COUNT; k++) {
			const enc = (FADER_OFFSET + k) as EncId
			const dominant = weights[k] > 0 && weights[k] >= maxW
			f[enc] = {
				ring: to127(weights[k]),
				rgb: SCENE_COLORS[k],
				ledBrightness: dominant ? SCENE_BRIGHTNESS_DOMINANT : SCENE_BRIGHTNESS_IDLE,
				ringBrightness: 31,
				anim: pulseScene[k] ? "pulse" : "none",
			}
		}
		return f
	}

	return {
		init(ctx) {
			ctxRef = ctx
			emitType(ctx)
			apply(ctx)
		},
		onFocus(ctx) {
			ctxRef = ctx
			emitType(ctx)
			dirty = true
		},
		onBlur() {},
		onEvent(ev, ctx) {
			ctxRef = ctx
			if (ev.type === "encoder/turn") {
				const d = stepFor(ctx, ev.delta)
				if (!d) return
				if (ev.id >= 0 && ev.id < OUTPUT_COUNT) {
					// Value knob: snapshot what we're seeing into the phantom at 100%,
					// then edit it. Output follows 1:1; faders keep their positions.
					for (let i = 0; i < OUTPUT_COUNT; i++) live[i] = out[i]
					travel = 0
					live[ev.id] = clamp(live[ev.id] + d, 0, 127)
					apply(ctx)
				} else if (ev.id >= FADER_OFFSET && ev.id < FADER_OFFSET + SCENE_COUNT) {
					turnFader(ev.id - FADER_OFFSET, d)
					apply(ctx)
				}
				return
			}
			if (ev.type === "encoder/press") {
				// Top knobs (0..11): press toggles a value lock → free direct control.
				if (ev.id >= 0 && ev.id < OUTPUT_COUNT) {
					if (!ev.down) return
					locked[ev.id] = !locked[ev.id]
					apply(ctx)
					return
				}
				if (ev.id < FADER_OFFSET || ev.id >= FADER_OFFSET + SCENE_COUNT) return
				const k = ev.id - FADER_OFFSET
				ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/${ev.id}/press`, ev.down ? 1 : 0)
				if (!ev.down) return
				const shift = ctx.modifiers.shiftLeft || ctx.modifiers.shiftRight
				if (shift) {
					// Save: snapshot the current output into scene k.
					for (let i = 0; i < OUTPUT_COUNT; i++) scenes[k][i] = out[i]
					triggerSavePulse(k, ctx)
				} else {
					// Recall: pure scene k (phantom fully dissolved, only fader k up).
					weights.fill(0)
					weights[k] = 127
					travel = PHANTOM_DECAY
					apply(ctx)
				}
				return
			}
		},
		onOsc(path, args, ctx) {
			ctxRef = ctx
			const sceneSet = path.match(/^\/scene\/(\d)\/set$/)
			if (sceneSet) {
				const k = Number(sceneSet[1])
				if (k >= 0 && k < SCENE_COUNT) {
					for (let i = 0; i < OUTPUT_COUNT; i++) {
						const v = Number(args[i])
						if (Number.isFinite(v)) scenes[k][i] = clamp(Math.round(v * 127), 0, 127)
					}
					apply(ctx)
				}
				return
			}
			if (path === "/dump") {
				for (let k = 0; k < SCENE_COUNT; k++) {
					const vals = scenes[k].map((v) => toFixedN(v / 127, 5))
					ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/scene/${k}/values`, ...vals)
				}
				return
			}
		},
		render() {
			if (!dirty) return
			dirty = false
			return frame()
		},
		dispose() {
			if (pulseTimer) {
				clearTimeout(pulseTimer)
				pulseTimer = null
			}
			ctxRef = null
		},
	}
}
