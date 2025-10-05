import midi from "@julusian/midi"
import { createInputDecoder } from "../io/inputDecoder.js"

// Pick first input whose name includes 'Twister' or fallback to 0
const input = new midi.Input()
let portIndex = 0
for (let i = 0; i < input.getPortCount(); i++) {
	const name = input.getPortName(i)
	if (name.toLowerCase().includes("twister")) {
		portIndex = i
		break
	}
}
console.log("Opening MIDI IN port:", input.getPortName(portIndex))
input.openPort(portIndex)
input.ignoreTypes(false, false, false) // listen to everything

const dec = createInputDecoder()
dec.onEvent((ev) => console.log("EV:", ev))

// Translate raw MIDI bytes to our RawMsg shape
input.on("message", (_deltaTime: number, bytes: number[]) => {
	const [status, num, val] = bytes
	const typeNibble = status >> 4
	const chan = status & 0x0f // 0..15
	if (typeNibble === 0xb) {
		// CC
		dec.pushRaw({ type: "cc", channel: chan, number: num, value: val })
	} else if (typeNibble === 0x9 || typeNibble === 0x8) {
		// Note on/off
		const v = typeNibble === 0x8 ? 0 : val
		dec.pushRaw({ type: "note", channel: chan, number: num, value: v })
	}
})

process.on("SIGINT", () => {
	input.closePort()
	process.exit(0)
})
