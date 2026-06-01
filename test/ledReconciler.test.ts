import { describe, it, expect, beforeEach } from "vitest"
import { LedReconciler } from "../src/render/ledReconciler.js"
import { FakeMidi } from "../src/util/fakeMidi.js"
import type { LedFrame, LedState, EncId } from "../src/core/types.js"

// Build a full 16-encoder frame from a single base state, with optional per-encoder overrides.
function frame(base: LedState, overrides: Partial<Record<EncId, Partial<LedState>>> = {}): LedFrame {
	const f = {} as LedFrame
	for (let i = 0; i < 16; i++) {
		const enc = i as EncId
		f[enc] = { ...base, ...(overrides[enc] ?? {}) }
	}
	return f
}

const BASE: LedState = { ring: 0, rgb: 110, ledBrightness: 5, ringBrightness: 31, anim: "none" }

// Parse "field:enc:value" / "pulse:enc" call strings for a given encoder.
function callsFor(midi: FakeMidi, enc: number) {
	return midi.calls.filter((c) => c.split(":")[1] === String(enc))
}

describe("LedReconciler", () => {
	let midi: FakeMidi
	let rec: LedReconciler

	beforeEach(() => {
		midi = new FakeMidi()
		rec = new LedReconciler(midi)
	})

	it("sends changed fields in order ledB -> ringB -> rgb -> ring on first paint", () => {
		rec.push(frame(BASE, { 0: { ring: 10, rgb: 60, ledBrightness: 7, ringBrightness: 20 } }))
		expect(callsFor(midi, 0)).toEqual(["ledB:0:7", "ringB:0:20", "rgb:0:60", "ring:0:10"])
	})

	it("suppresses unchanged fields on a repeat push", () => {
		const f = frame(BASE)
		rec.push(f)
		const after = midi.calls.length
		expect(after).toBeGreaterThan(0)
		rec.push(f) // identical -> nothing new
		expect(midi.calls.length).toBe(after)
	})

	it("sends only the field that changed", () => {
		rec.beginFocusPaint()
		rec.push(frame(BASE))
		midi.calls.length = 0
		rec.push(frame(BASE, { 2: { ring: 99 } }))
		expect(midi.calls).toEqual(["ring:2:99"])
	})

	it("pulse transition sends pulse and skips ledBrightness, but still updates ring", () => {
		rec.beginFocusPaint()
		rec.push(frame(BASE))
		midi.calls.length = 0
		rec.push(frame(BASE, { 0: { anim: "pulse", ring: 42 } }))
		const c = callsFor(midi, 0)
		expect(c).toContain("pulse:0")
		expect(c).toContain("ring:0:42")
		expect(c.some((x) => x.startsWith("ledB:0"))).toBe(false)
	})

	it("leaving pulse forces a ledBrightness send to cancel the animation", () => {
		rec.beginFocusPaint()
		rec.push(frame(BASE))
		rec.push(frame(BASE, { 0: { anim: "pulse" } }))
		midi.calls.length = 0
		rec.push(frame(BASE, { 0: { anim: "none", ledBrightness: 5 } }))
		expect(callsFor(midi, 0)).toContain("ledB:0:5")
	})
})
