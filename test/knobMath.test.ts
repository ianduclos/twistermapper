import { describe, it, expect } from "vitest"
import {
	hitZone,
	normalizeWheel,
	applyAcceleration,
	accumulateDrag,
	chunkDelta,
	reconcile,
	clampValue,
	stepPxFor,
	BASE_STEP_PX,
	FINE_STEP_PX,
	MAX_ACCEL,
	SETTLE_MS,
	MAX_DELTA_PER_MSG,
	WHEEL_STEP_PX,
} from "../web/lib/knobMath.js"

describe("hitZone", () => {
	it("treats the centre disc as the button and everything else as the knob", () => {
		expect(hitZone(0.5, 0.5)).toBe("center")
		expect(hitZone(0.5, 0.35)).toBe("center") // 0.15 from centre
		expect(hitZone(0.5, 0.2)).toBe("ring") // 0.30 from centre
		expect(hitZone(0.5, 0.0)).toBe("ring")
		expect(hitZone(0.0, 0.0)).toBe("ring") // corners turn too
		expect(hitZone(1.0, 1.0)).toBe("ring")
	})

	it("covers far more of the cell with the knob than the button", () => {
		let center = 0
		let ring = 0
		for (let i = 0; i < 100; i++) {
			for (let j = 0; j < 100; j++) {
				hitZone(i / 99, j / 99) === "center" ? center++ : ring++
			}
		}
		// The old target was the painted arc stroke only; now the knob owns the
		// large majority of the cell.
		expect(ring / (ring + center)).toBeGreaterThan(0.8)
	})
})

describe("normalizeWheel", () => {
	it("converts every deltaMode to pixels", () => {
		expect(normalizeWheel(120, 0)).toBe(120) // pixels
		expect(normalizeWheel(3, 1)).toBe(48) // lines
		expect(normalizeWheel(1, 2)).toBe(400) // pages
	})

	it("keeps sign and tolerates junk", () => {
		expect(normalizeWheel(-3, 1)).toBe(-48)
		expect(normalizeWheel(undefined as any, 0)).toBe(0)
		expect(normalizeWheel(NaN, 0)).toBe(0)
	})

	it("makes a mouse notch outweigh a trackpad twitch", () => {
		// The bug this fixes: both used to become exactly one step.
		expect(Math.abs(normalizeWheel(3, 1))).toBeGreaterThan(Math.abs(normalizeWheel(2, 0)))
	})
})

describe("applyAcceleration", () => {
	it("stays 1:1 for slow, deliberate movement", () => {
		expect(applyAcceleration(0)).toBe(1)
		expect(applyAcceleration(0.2)).toBe(1)
		expect(applyAcceleration(0.5)).toBe(1)
	})

	it("scales up with speed and never exceeds the ceiling", () => {
		expect(applyAcceleration(1)).toBeGreaterThan(1)
		expect(applyAcceleration(1)).toBeLessThan(MAX_ACCEL)
		expect(applyAcceleration(100)).toBe(MAX_ACCEL)
		expect(applyAcceleration(-100)).toBe(MAX_ACCEL) // direction-agnostic
	})

	it("is monotonic in speed", () => {
		const speeds = [0.5, 0.8, 1.2, 2, 4, 8]
		const mults = speeds.map((s) => applyAcceleration(s))
		for (let i = 1; i < mults.length; i++) expect(mults[i]).toBeGreaterThanOrEqual(mults[i - 1])
	})
})

describe("stepPxFor", () => {
	it("maps modifiers to step sizes", () => {
		expect(stepPxFor()).toBe(BASE_STEP_PX)
		expect(stepPxFor({ fine: true })).toBe(FINE_STEP_PX)
		expect(stepPxFor({ coarse: true })).toBeLessThan(BASE_STEP_PX)
		expect(stepPxFor({ fine: true, coarse: true })).toBe(FINE_STEP_PX) // fine wins
	})
})

describe("accumulateDrag", () => {
	it("emits nothing until a full step has been travelled", () => {
		const a = accumulateDrag(0, { dy: 3 })
		expect(a.delta).toBe(0)
		expect(a.carryPx).toBe(3)
	})

	it("emits a step once the threshold is crossed and carries the remainder", () => {
		const a = accumulateDrag(0, { dy: BASE_STEP_PX + 1, dt: 100 })
		expect(a.delta).toBe(1)
		expect(a.carryPx).toBe(1)
	})

	it("accumulates across several small movements", () => {
		let carry = 0
		let total = 0
		for (let i = 0; i < 8; i++) {
			const r = accumulateDrag(carry, { dy: 1, dt: 100 })
			carry = r.carryPx
			total += r.delta
		}
		expect(total).toBe(2) // 8px at 4px/step, slow enough for no acceleration
	})

	it("is symmetric for downward drags", () => {
		const up = accumulateDrag(0, { dy: 20, dt: 100 })
		const down = accumulateDrag(0, { dy: -20, dt: 100 })
		expect(down.delta).toBe(-up.delta)
	})

	it("accelerates a fast flick", () => {
		const slow = accumulateDrag(0, { dy: 40, dt: 400 }) // 0.1 px/ms
		const fast = accumulateDrag(0, { dy: 40, dt: 10 }) // 4 px/ms
		expect(slow.delta).toBe(10)
		expect(fast.delta).toBeGreaterThan(slow.delta)
		expect(fast.delta).toBeLessThanOrEqual(10 * MAX_ACCEL)
	})

	it("pins fine mode to 1:1 however fast you move", () => {
		const fast = accumulateDrag(0, { dy: 10, dt: 1, fine: true })
		expect(fast.delta).toBe(10) // 1px per step, no multiplier
	})

	it("lets fine mode reach a single value the base step would skip", () => {
		expect(accumulateDrag(0, { dy: 1, fine: true }).delta).toBe(1)
		expect(accumulateDrag(0, { dy: 1 }).delta).toBe(0)
	})

	it("never swallows a step that was actually made", () => {
		const r = accumulateDrag(0, { dy: BASE_STEP_PX, dt: 1e9 })
		expect(Math.abs(r.delta)).toBeGreaterThanOrEqual(1)
	})
})

describe("chunkDelta", () => {
	it("passes small deltas through whole", () => {
		expect(chunkDelta(5)).toEqual([5])
		expect(chunkDelta(-5)).toEqual([-5])
		expect(chunkDelta(0)).toEqual([])
	})

	it("splits anything the daemon would clamp", () => {
		// parseUiDelta clamps to +/-16, so a 40-step flick must not arrive as one
		// message that silently becomes 16.
		expect(chunkDelta(40)).toEqual([16, 16, 8])
		expect(chunkDelta(-40)).toEqual([-16, -16, -8])
	})

	it("preserves the total exactly", () => {
		for (const d of [1, 16, 17, 33, 99, -47]) {
			expect(chunkDelta(d).reduce((a, b) => a + b, 0)).toBe(d)
			for (const c of chunkDelta(d)) expect(Math.abs(c)).toBeLessThanOrEqual(MAX_DELTA_PER_MSG)
		}
	})
})

describe("reconcile", () => {
	it("uses the daemon value when nothing is predicted", () => {
		expect(reconcile({ predicted: null, authoritative: 40, pendingSince: null, now: 0 }))
			.toEqual({ value: 40, predicting: false })
	})

	it("shows the prediction while turns are still in flight", () => {
		const r = reconcile({ predicted: 60, authoritative: 40, pendingSince: 1000, now: 1000 + SETTLE_MS - 1 })
		expect(r).toEqual({ value: 60, predicting: true })
	})

	it("hands back to the daemon once the settle window passes", () => {
		const r = reconcile({ predicted: 60, authoritative: 40, pendingSince: 1000, now: 1000 + SETTLE_MS + 1 })
		expect(r).toEqual({ value: 40, predicting: false })
	})

	it("snaps a clamped page back exactly once, after the gesture", () => {
		// Page clamps at 127; the user kept dragging past it.
		const steps = [0, 50, 139, 200].map((dt) =>
			reconcile({ predicted: 200, authoritative: 127, pendingSince: 0, now: dt })
		)
		expect(steps.map((s) => s.value)).toEqual([200, 200, 200, 127])
		expect(steps.filter((s) => !s.predicting)).toHaveLength(1)
	})
})

describe("clampValue", () => {
	it("holds values inside the device range", () => {
		expect(clampValue(-5)).toBe(0)
		expect(clampValue(200)).toBe(127)
		expect(clampValue(63.4)).toBe(63)
		expect(clampValue(NaN)).toBe(0)
	})
})

describe("wheel step sizing", () => {
	it("turns a mouse notch into a few steps, not ten", () => {
		// Chrome reports a notch as ~120px in pixel mode.
		const notchSteps = Math.trunc(normalizeWheel(120, 0) / WHEEL_STEP_PX)
		expect(notchSteps).toBeGreaterThanOrEqual(2)
		expect(notchSteps).toBeLessThanOrEqual(4)
	})

	it("gives a trackpad swipe a proportionate sweep", () => {
		// A few hundred px of two-finger travel, arriving as many small events.
		let carry = 0
		let steps = 0
		for (let i = 0; i < 60; i++) {
			const total = carry + normalizeWheel(6, 0)
			const s = Math.trunc(total / WHEEL_STEP_PX)
			carry = total - s * WHEEL_STEP_PX
			steps += s
		}
		expect(steps).toBeGreaterThan(4)
		expect(steps).toBeLessThan(30)
	})
})
