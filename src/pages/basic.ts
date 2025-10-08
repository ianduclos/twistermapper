/* Task: Implement BasicPage (values 0..127, brightness bump on press)
Spec: /src/Architecture.md — section "BasicPage (reference page)" and "OSC"

Acceptance Criteria:
- Internal: 16 integer values 0..127; default 0.
- onEvent('encoder/turn'): vals[id] += delta * (128 / ctx.resolution); clamp 0..127.
- onEvent('encoder/press'): while down => ledBrightness=10 for that encoder; on release => restore 5.
- render(): returns LedFrame if any state changed since last render; otherwise undefined.
- OSC out: on value change, send `/twister_out/page_a {id} {normalized float <= 5 dp}` (use ctx.osc.send).
- Optional OSC in: `/twister_in/page_a/set/{id} {normalized float}` sets value (clamped).
- Do not import MIDI here; only express desired LED state.
*/

import { Page, LedFrame, EncId } from "../core/types.js"
import { clamp, toFixedN, to127 } from "../util/scale.js"

export function BasicPage(): Page {
	const vals = new Int16Array(16) // 0..127
	const pressed = new Array<boolean>(16).fill(false)
	let dirty = true

	const frame = (): LedFrame => {
		const out: any = {}
		for (let i = 0; i < 16; i++) {
			out[i] = {
				ring: to127(vals[i]),
				rgb: 110,
				ledBrightness: pressed[i] ? 10 : 5,
				ringBrightness: 31,
				anim: "none",
			}
		}
		return out
	}

	return {
		init() {
			for (let i = 0; i < 16; i++) vals[i] = 0
			dirty = true
		},
		onFocus() {
			dirty = true
		},
		onBlur() {},
		onEvent(ev, ctx) {
			if (ev.type === "encoder/turn") {
				const step = 128 / ctx.resolution
				vals[ev.id] = clamp(vals[ev.id] + Math.round(ev.delta * step), 0, 127)
				// OSC out: /twister_out/page_{a..h} {id} {0..1}
				ctx.osc.send(
					`/twister_out/page_${ctx.slotLabel}`,
					ev.id,
					toFixedN(vals[ev.id] / 127, 5)
				)
				dirty = true
			}
			if (ev.type === "encoder/press") {
				pressed[ev.id] = ev.down
				dirty = true
			}
		},
		onOsc(path, args, ctx) {
			// /twister_in/page_{x}/set/{id} {normFloat}
			const m = path.match(/\/set\/(\d{1,2})$/)
			if (m) {
				const id = Number(m[1]) | 0
				const v = Number(args[0])
				if (id >= 0 && id < 16 && Number.isFinite(v)) {
					vals[id] = clamp(Math.round(v * 127), 0, 127)
					// Also emit OSC out so external clients see the update
					ctx.osc.send(
						`/twister_out/page_${ctx.slotLabel}`,
						id,
						toFixedN(vals[id] / 127, 5)
					)
					dirty = true
				}
			}
		},
		render() {
			if (!dirty) return
			dirty = false
			return frame()
		},
		dispose() {},
	}
}
