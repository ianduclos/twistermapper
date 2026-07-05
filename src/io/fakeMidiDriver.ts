/* FakeMidiDriver: lets the daemon run with no MIDI hardware attached ("Virtual
 * Twister" mode, see cli/index.ts --fake / TWISTER_FAKE=1).
 *
 * All MidiOut methods are no-ops — there is no device to push LED state to.
 * The web UI still sees LED feedback, but not through this driver: cli/index.ts
 * mirrors each render-loop frame straight to the control server (see
 * renderTick()/controlServer.broadcast in src/cli/index.ts), which is the one
 * output path per R10. This class never fires onMessage callbacks either,
 * because UI-originated input does not arrive as raw MIDI — it comes in as
 * InputEvents synthesized directly by routeControl's /twister/ui/... handlers
 * and fed through the same handleInputEvent() the hardware path uses.
 *
 * No dependencies (no @julusian/midi, no ports) so this is safe to construct
 * anywhere, including in tests.
 */

import type { MidiOut, MidiIn } from "./midiDriver.js"

const FAKE_PORT_NAME = "Fake Twister (virtual)"

export class FakeMidiDriver implements MidiOut, MidiIn {
	// ---- MidiOut: no-ops, nothing to push to ----
	setRing(_enc: number, _value0_127: number) {}
	setRGB(_enc: number, _colorIdx1_126: number) {}
	setLedBrightness(_enc: number, _human0_29: number) {}
	setRingBrightness(_enc: number, _human1_31: number) {}
	setPulse(_enc: number) {}

	// ---- MidiIn: stores the callback but never invokes it ----
	onMessage(_cb: (msg: { type: "cc" | "note"; channel: number; number: number; value: number }) => void) {
		// Intentionally never fires — see header comment.
	}

	getInPortName() {
		return FAKE_PORT_NAME
	}
	getOutPortName() {
		return FAKE_PORT_NAME
	}

	close() {}
}
