import { describe, it, expect } from "vitest"
import { FakeMidiDriver } from "../src/io/fakeMidiDriver.js"

describe("FakeMidiDriver", () => {
	it("constructs with no arguments and no hardware dependency", () => {
		expect(() => new FakeMidiDriver()).not.toThrow()
	})

	it("all MidiOut methods are callable without throwing", () => {
		const driver = new FakeMidiDriver()
		expect(() => driver.setRing(0, 64)).not.toThrow()
		expect(() => driver.setRGB(0, 110)).not.toThrow()
		expect(() => driver.setLedBrightness(0, 5)).not.toThrow()
		expect(() => driver.setRingBrightness(0, 31)).not.toThrow()
		expect(() => driver.setPulse(0)).not.toThrow()
		expect(() => driver.close()).not.toThrow()
	})

	it("reports fake port names for diagnostics", () => {
		const driver = new FakeMidiDriver()
		expect(driver.getInPortName()).toBe("Fake Twister (virtual)")
		expect(driver.getOutPortName()).toBe("Fake Twister (virtual)")
	})

	it("onMessage accepts a callback but never invokes it", () => {
		const driver = new FakeMidiDriver()
		let called = false
		expect(() => driver.onMessage(() => { called = true })).not.toThrow()
		expect(called).toBe(false)
	})
})
