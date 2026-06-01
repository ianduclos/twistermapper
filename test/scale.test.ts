import { describe, it, expect } from "vitest"
import {
	clamp,
	to127,
	toFixedN,
	ledBrightHumanToDev,
	ringBrightHumanToDev,
} from "../src/util/scale.js"

describe("scale", () => {
	it("clamps within bounds", () => {
		expect(clamp(5, 0, 10)).toBe(5)
		expect(clamp(-1, 0, 10)).toBe(0)
		expect(clamp(11, 0, 10)).toBe(10)
	})

	it("to127 rounds and clamps to 0..127", () => {
		expect(to127(-3)).toBe(0)
		expect(to127(200)).toBe(127)
		expect(to127(63.6)).toBe(64)
	})

	it("toFixedN trims to 5 decimals by default", () => {
		expect(toFixedN(0.123456789)).toBe(0.12346)
		expect(toFixedN(1)).toBe(1)
	})

	it("maps LED brightness human 0..29 -> device 18..47", () => {
		expect(ledBrightHumanToDev(0)).toBe(18)
		expect(ledBrightHumanToDev(29)).toBe(47)
		// out of range clamps before offset
		expect(ledBrightHumanToDev(99)).toBe(47)
		expect(ledBrightHumanToDev(-5)).toBe(18)
	})

	it("maps ring brightness human 1..31 -> device 65..95", () => {
		expect(ringBrightHumanToDev(1)).toBe(65)
		expect(ringBrightHumanToDev(31)).toBe(95)
		expect(ringBrightHumanToDev(99)).toBe(95)
	})
})
