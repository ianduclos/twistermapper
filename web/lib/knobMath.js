/* Pure input maths for the virtual Twister's encoders.
 *
 * Deliberately free of DOM and daemon references so it can be tested directly
 * (test/knobMath.test.ts). Everything here works in device units: encoder
 * values are 0..127 and turns are relative deltas, never absolutes (R1).
 */

/** Centre disc radius as a fraction of the cell's half-width. Inside = press. */
export const CENTER_FRAC = 0.24
/** Pixels of drag per step at 1x. */
export const BASE_STEP_PX = 4
/** Pixels of drag per step in fine mode (Alt). */
export const FINE_STEP_PX = 1
/**
 * Pixels of accumulated wheel travel per step. Sized off a mouse notch, which
 * Chrome reports as ~120px: that lands on 3 steps, while a trackpad swipe of a
 * few hundred pixels gives a proportionate sweep. The old code emitted exactly
 * one step per event regardless, so a notch crawled and a trackpad bolted.
 */
export const WHEEL_STEP_PX = 40
/** Ceiling on the velocity multiplier. */
export const MAX_ACCEL = 6
/** Below this speed (px/ms) a drag stays 1:1. */
export const ACCEL_FLOOR = 0.5
/** How long a prediction outlives the last turn before the daemon wins. */
export const SETTLE_MS = 140
/** The daemon clamps a single turn to this (parseUiDelta in cli/index.ts). */
export const MAX_DELTA_PER_MSG = 16

/**
 * Which part of a cell a point falls in, from coordinates normalised to 0..1
 * across the cell. The centre disc is the button; everything else — including
 * the corners — turns, so the target is the whole cell rather than the few
 * pixels of painted ring stroke it used to be.
 */
export function hitZone(nx, ny, centerFrac = CENTER_FRAC) {
	const dx = nx - 0.5
	const dy = ny - 0.5
	return Math.hypot(dx, dy) < centerFrac ? "center" : "ring"
}

/**
 * A wheel event's deltaY in pixels. Trackpads report pixels, mice usually
 * report lines, and some browsers report pages; treating all three as one
 * notch is what made the wheel crawl on a mouse and bolt on a trackpad.
 */
export function normalizeWheel(deltaY, deltaMode = 0) {
	const d = Number(deltaY) || 0
	if (deltaMode === 1) return d * 16 // lines
	if (deltaMode === 2) return d * 400 // pages
	return d // pixels
}

/**
 * Velocity-scaled multiplier for a drag. Slow, deliberate movement stays 1:1 so
 * single values remain reachable; a fast flick multiplies up to MAX_ACCEL, which
 * is what makes a full 0..127 sweep one gesture instead of a 508px haul.
 * `velocity` is px/ms.
 */
export function applyAcceleration(velocity, max = MAX_ACCEL) {
	const v = Math.abs(Number(velocity) || 0)
	if (!Number.isFinite(v) || v <= ACCEL_FLOOR) return 1
	return Math.min(max, 1 + (v - ACCEL_FLOOR) * 2)
}

/** Step size for the active modifiers. Alt = fine, Meta = coarse. */
export function stepPxFor({ fine = false, coarse = false } = {}) {
	if (fine) return FINE_STEP_PX
	if (coarse) return BASE_STEP_PX / 4
	return BASE_STEP_PX
}

/**
 * Fold one pointer movement into a drag accumulator.
 *
 * Returns the carried-over pixels and the integer delta to emit (0 while the
 * movement is still under one step). Fine mode pins the multiplier to 1 — the
 * point of holding Alt is that the knob stops second-guessing you.
 */
export function accumulateDrag(carryPx, { dy, dt = 0, fine = false, coarse = false, maxAccel = MAX_ACCEL }) {
	const stepPx = stepPxFor({ fine, coarse })
	const px = (Number(carryPx) || 0) + (Number(dy) || 0)
	const steps = Math.trunc(px / stepPx)
	if (steps === 0) return { carryPx: px, delta: 0 }

	const velocity = dt > 0 ? Math.abs(Number(dy) || 0) / dt : 0
	const mult = fine ? 1 : applyAcceleration(velocity, maxAccel)
	const scaled = Math.round(steps * mult)
	// Never let rounding swallow a step the user actually made.
	const delta = scaled === 0 ? Math.sign(steps) : scaled
	return { carryPx: px - steps * stepPx, delta }
}

/**
 * Split a delta into messages the daemon will accept whole. parseUiDelta clamps
 * each turn to +/-16, so a hard flick has to arrive as several messages rather
 * than one that gets silently truncated.
 */
export function chunkDelta(delta, max = MAX_DELTA_PER_MSG) {
	const out = []
	let left = Math.trunc(Number(delta) || 0)
	const sign = Math.sign(left)
	while (left !== 0) {
		const take = Math.min(Math.abs(left), max)
		out.push(sign * take)
		left -= sign * take
	}
	return out
}

/**
 * What the ring should show this frame.
 *
 * The browser moves the ring the instant you drag it, but only pages can say
 * what a turn really means — they clamp, quantize, or ignore it. So a
 * prediction holds only while turns are still in flight; once the settle window
 * passes, the daemon's value is the truth. A page that clamps therefore snaps
 * back once, after the gesture, rather than fighting it mid-drag.
 */
export function reconcile({ predicted, authoritative, pendingSince, now, settleMs = SETTLE_MS }) {
	if (predicted == null || pendingSince == null) {
		return { value: authoritative, predicting: false }
	}
	if (now - pendingSince > settleMs) {
		return { value: authoritative, predicting: false }
	}
	return { value: predicted, predicting: true }
}

/** Encoder values are 0..127; deltas accumulate into that range, never past it. */
export function clampValue(v) {
	return Math.max(0, Math.min(127, Math.round(Number(v) || 0)))
}
