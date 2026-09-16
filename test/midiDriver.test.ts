import { beforeEach, describe, expect, it, vi } from "vitest"

const ports = vi.hoisted(() => ({
	input: [] as string[],
	output: [] as string[],
	opened: [] as string[],
	closed: [] as string[],
}))

// Replace CoreMIDI only: exercise the real driver's selection and cleanup.
vi.mock("@julusian/midi", () => {
	class Port {
		constructor(private kind: "input" | "output") {}
		getPortCount() { return ports[this.kind].length }
		getPortName(index: number) { return ports[this.kind][index] }
		openPort(index: number) { ports.opened.push(`${this.kind}:${ports[this.kind][index]}`) }
		closePort() { ports.closed.push(this.kind) }
		on() {}
	}
	return { default: {
		Input: class extends Port { constructor() { super("input") } },
		Output: class extends Port { constructor() { super("output") } },
	} }
})

import { NodeMidiDriver } from "../src/io/midiDriver.js"

beforeEach(() => {
	ports.input = ["Midi Bus Bus 1"]
	ports.output = ["Midi Bus Bus 1"]
	ports.opened = []
	ports.closed = []
})

describe("MIDI port selection", () => {
	it("rejects a missing Twister without opening the loopback bus", () => {
		expect(() => new NodeMidiDriver()).toThrow(/input.*Midi Bus Bus 1/)
		expect(ports.opened).toEqual([])
	})

	it("honors a requested name instead of substituting the default device", () => {
		ports.input.push("Midi Fighter Twister")
		expect(() => new NodeMidiDriver({ inPort: "missing controller" })).toThrow(/missing controller/)
		expect(ports.opened).toEqual([])
	})

	it("closes an already opened input when the requested output is absent", () => {
		ports.input.push("Midi Fighter Twister")
		expect(() => new NodeMidiDriver()).toThrow(/output.*Midi Bus Bus 1/)
		expect(ports.opened).toEqual(["input:Midi Fighter Twister"])
		expect(ports.closed).toContain("input")
	})

	it("selects a case-insensitive substring match after an unrelated port", () => {
		ports.input.push("Midi Fighter Twister")
		ports.output.push("Midi Fighter Twister")
		const driver = new NodeMidiDriver({ inPort: "TWISTER", outPort: "twister" })
		expect(driver.getInPortName()).toBe("Midi Fighter Twister")
		expect(driver.getOutPortName()).toBe("Midi Fighter Twister")
		driver.close()
	})

	it("prefers an exact match over an earlier substring match", () => {
		ports.input = ports.output = ["Twister extra", "Twister"]
		const driver = new NodeMidiDriver({ inPort: "twister", outPort: "twister" })
		expect(ports.opened).toEqual(["input:Twister", "output:Twister"])
		driver.close()
	})

	it("allows an explicitly selected loopback port", () => {
		const driver = new NodeMidiDriver({ inPort: 0, outPort: "Midi Bus Bus 1" })
		expect(ports.opened).toEqual(["input:Midi Bus Bus 1", "output:Midi Bus Bus 1"])
		driver.close()
	})
})
