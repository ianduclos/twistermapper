// src/boot/bootSplashes.ts
import type { LedFrame, EncId } from "../core/types.js"
import { LedReconciler } from "../render/ledReconciler.js"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** splash signature */
export type BootSplash = (
	rec: LedReconciler,
	opts?: Record<string, unknown>
) => Promise<void>

/** wrap color to 1..126 (1 and 126 are both blue on the Twister) */
function wrapColor(n: number): number {
	let x = Math.round(n)
	// bring into [0..125], then shift to [1..126]
	x = ((((x - 1) % 126) + 126) % 126) + 1
	return x
}

/** random integer in [-step..+step] */
function randStepNonZero(max = 6): number {
	const mag = Math.floor(Math.random() * max) + 1 // 1..max
	return Math.random() < 0.5 ? -mag : mag
}

/**
 * Blue Fade + Drunk Walk
 * - Start: all encoders RGB=blue(1), ledBrightness=max (29), ringBrightness=31, ring=0
 * - Each tick: ledBrightness -= 1 until 1; each RGB does ±4 "drunk walk" with wrapping (1..126)
 * - No pulse animation (anim: 'none') to avoid override behavior
 */
export const blueFadeStraightWalk: BootSplash = async (rec) => {
	const startBright = 29 // human 0..29
	const endBright = 1 // stop at 1
	const steps = startBright - endBright + 1 // inclusive 29..1
	const intervalMs = 80
	const ringBright = 31

	// per-encoder color state + fixed per-encoder delta
	const color = new Array<number>(16).fill(1) // start blue
	const delta = new Array<number>(16).fill(0).map(() => randStepNonZero(3)) // ±1..±6, no 0

	rec.beginFocusPaint()
	for (let s = 0; s < steps; s++) {
		const b = startBright - s
		const frame = {} as LedFrame

		for (let i = 0 as EncId; i < 16; i = (i + 1) as EncId) {
			color[i] = wrapColor(color[i] + delta[i]) // straight line per encoder
			frame[i] = {
				ring: 0,
				rgb: color[i],
				ledBrightness: b,
				ringBrightness: ringBright,
				anim: "none",
			}
		}

		rec.push(frame)
		await sleep(intervalMs)
	}
}

export const purpleLandingStraightWalk: BootSplash = async (rec, opts) => {
	const startBright = (opts?.startBright as number) ?? 29 // human 0..29
	const endBright = (opts?.endBright as number) ?? 1 // stop at 1
	const steps = startBright - endBright + 1 // inclusive frames
	const intervalMs = (opts?.intervalMs as number) ?? 80
	const ringBright = (opts?.ringBrightness as number) ?? 31

	const targetPurple = 110 // Twister purple; wraps 1..126
	const color = new Array<number>(16)
	const delta = new Array<number>(16)

	// choose per-encoder step and backtrack start color so final hits purple
	for (let i = 0; i < 16; i++) {
		const d = randStepNonZero(3) // ±1..±6 (never 0)
		delta[i] = d
		// after (steps-1) additions, color_end = start + d*(steps-1) ≡ target (mod 126)
		// ⇒ start ≡ target - d*(steps-1) (mod 126), wrapped to 1..126
		color[i] = wrapColor(targetPurple - d * (steps - 1))
	}

	rec.beginFocusPaint()
	for (let s = 0; s < steps; s++) {
		const b = startBright - s // 29..1
		const frame = {} as LedFrame

		for (let i = 0 as EncId; i < 16; i = (i + 1) as EncId) {
			if (s > 0) color[i] = wrapColor(color[i] + delta[i]) // march straight each tick
			frame[i] = {
				ring: 0,
				rgb: color[i],
				ledBrightness: b,
				ringBrightness: ringBright,
				anim: "none",
			}
		}

		rec.push(frame)
		await new Promise<void>((r) => setTimeout(r, intervalMs))
	}
}

/** registry of splashes (add more later) */
export const BOOT_SPLASHES: BootSplash[] = [
	//blueFadeStraightWalk,
	purpleLandingStraightWalk,
	// add more: fancyPulse, swirl, checkerboard, etc.
]

/** pick one at random and run it */
export async function runRandomSplash(rec: LedReconciler) {
	const idx = Math.floor(Math.random() * BOOT_SPLASHES.length)
	await BOOT_SPLASHES[idx](rec)
}

/** after splash, paint the focused page twice to settle brightness deterministically */
export function settleFocused(
	pm: { getDesiredFocused(): LedFrame | undefined },
	rec: LedReconciler
) {
	const frame = pm.getDesiredFocused()
	if (!frame) return
	rec.beginFocusPaint()
	rec.push(frame)
	setTimeout(() => rec.push(frame), 8)
}
