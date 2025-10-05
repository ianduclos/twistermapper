// src/cli/brightness-probe.ts
import { NodeMidiDriver } from "../io/midiDriver.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

;(async () => {
	const m = new NodeMidiDriver() // defaults to "Midi Fighter Twister"
	console.log("MIDI IN :", m.getInPortName?.())
	console.log("MIDI OUT:", m.getOutPortName?.())

	// Big visible change on encoder 0 first
	console.log("E0: ledB=5 → 29, ringB=10 → 31")
	m.setLedBrightness(0, 5)
	m.setRingBrightness(0, 10)
	await sleep(400)
	m.setLedBrightness(0, 29)
	m.setRingBrightness(0, 31)
	await sleep(400)

	// Pattern A: staggered under-LED + ring brightness across all encoders
	console.log("Pattern A across all encoders…")
	for (let i = 0; i < 16; i++) {
		m.setLedBrightness(i, (i * 2) % 30)
		m.setRingBrightness(i, 10 + (i % 22))
	}
	await sleep(800)

	// Pattern B: invert so it *always* looks different on a re-run
	console.log("Pattern B (inverted)…")
	for (let i = 0; i < 16; i++) {
		m.setLedBrightness(i, 29 - ((i * 2) % 30))
		m.setRingBrightness(i, 31 - (i % 22))
	}
	await sleep(1200)

	m.close() // <- release ports cleanly
})()
