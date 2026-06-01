import { describe, it, expect } from "vitest"
import { createInputDecoder } from "../src/io/inputDecoder.js"
import type { InputEvent } from "../src/core/types.js"

// Device map (see src/config/device-map.json):
//   encoder turns: CC ch0, cc 0..15
//   encoder button: NOTE ch1, note 0..15
//   side left:  ch3 cc8 (shift) / cc9 (global)
//   side right: ch3 cc11 (shift) / cc12 (global)

function collect() {
	const dec = createInputDecoder()
	const events: InputEvent[] = []
	dec.onEvent((e) => events.push(e))
	return { dec, events }
}

describe("inputDecoder", () => {
	it("decodes encoder turns: 63 -> -1, 64 -> +1, otherwise value-64", () => {
		const { dec, events } = collect()
		dec.pushRaw({ type: "cc", channel: 0, number: 0, value: 63 })
		dec.pushRaw({ type: "cc", channel: 0, number: 5, value: 64 })
		dec.pushRaw({ type: "cc", channel: 0, number: 5, value: 70 })
		expect(events).toEqual([
			{ type: "encoder/turn", id: 0, delta: -1, shift: false },
			{ type: "encoder/turn", id: 5, delta: 1, shift: false },
			{ type: "encoder/turn", id: 5, delta: 6, shift: false },
		])
	})

	it("decodes encoder button presses (note ch1)", () => {
		const { dec, events } = collect()
		dec.pushRaw({ type: "note", channel: 1, number: 3, value: 127 })
		dec.pushRaw({ type: "note", channel: 1, number: 3, value: 0 })
		expect(events).toEqual([
			{ type: "encoder/press", id: 3, down: true, shift: false },
			{ type: "encoder/press", id: 3, down: false, shift: false },
		])
	})

	it("tracks shift state and stamps it on subsequent turns", () => {
		const { dec, events } = collect()
		dec.pushRaw({ type: "cc", channel: 3, number: 11, value: 127 }) // shift right down
		dec.pushRaw({ type: "cc", channel: 0, number: 1, value: 64 }) // turn while shifted
		expect(events[0]).toEqual({ type: "side/shift", side: "right", down: true })
		expect(events[1]).toMatchObject({ type: "encoder/turn", id: 1, shift: true })
	})

	it("intercepts global buttons while a shift is held (default)", () => {
		const { dec, events } = collect()
		dec.pushRaw({ type: "cc", channel: 3, number: 8, value: 127 }) // shift left down
		dec.pushRaw({ type: "cc", channel: 3, number: 9, value: 127 }) // global left -> suppressed
		const globals = events.filter((e) => e.type === "side/global")
		expect(globals).toHaveLength(0)
	})

	it("passes global buttons through when interceptGlobals is off", () => {
		const { dec, events } = collect()
		dec.setShiftInterceptGlobals(false)
		dec.pushRaw({ type: "cc", channel: 3, number: 8, value: 127 }) // shift left
		dec.pushRaw({ type: "cc", channel: 3, number: 9, value: 127 }) // global left
		const globals = events.filter((e) => e.type === "side/global")
		expect(globals).toEqual([{ type: "side/global", side: "left", down: true }])
	})
})
