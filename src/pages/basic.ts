/* Task: Implement BasicPage (values 0..127, brightness bump on press)
Spec: /src/Architecture.md — section "BasicPage (reference page)" and "OSC"

Acceptance Criteria:
- Internal: 16 integer values 0..127; default 0.
- onEvent('encoder/turn'): vals[id] += delta * (128 / ctx.resolution); clamp 0..127.
- onEvent('encoder/press'): while down => ledBrightness=max (29) for that encoder; on release => restore resting brightness.
- render(): returns LedFrame if any state changed since last render; otherwise undefined.
- OSC out: on value change, send `/twister/out/page_a/index/<id>/value <normalized float <= 5 dp>` (use ctx.osc.send).
- Optional OSC in: `/twister/in/page_a/index/<id>/set <normalized float>` sets value (clamped).
- Do not import MIDI here; only express desired LED state.
*/

import { Page, LedFrame, EncId, PageContext } from "../core/types.js"
import { clamp, toFixedN, to127 } from "../util/scale.js"

export interface BasicPageConfig {
	encoderColors?: unknown
	encoderBrightness?: unknown
}

const DEFAULT_COLOR = 110
const DEFAULT_BRIGHTNESS = 5
const PRESSED_BRIGHTNESS = 29
const COLOR_MIN = 1
const COLOR_MAX = 126
const BRIGHTNESS_MIN = 0
const BRIGHTNESS_MAX = 29

export function BasicPage(config?: BasicPageConfig): Page {
	const vals = new Int16Array(16) // 0..127
	const pressed = new Array<boolean>(16).fill(false)
	const colors = new Array<number>(16).fill(DEFAULT_COLOR)
	const baseBrightness = new Array<number>(16).fill(DEFAULT_BRIGHTNESS)
	const initialColorSource = config?.encoderColors
	const initialBrightnessSource = config?.encoderBrightness
	let dirty = true
	let ctxRef: PageContext | null = null

	const emitPageType = (ctx: PageContext) => {
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/type`, "Basic")
	}

	const clampColor = (value: unknown): number => {
		if (typeof value === "number" && Number.isFinite(value)) {
			return clamp(Math.round(value), COLOR_MIN, COLOR_MAX)
		}
		if (typeof value === "bigint") {
			return clamp(Number(value), COLOR_MIN, COLOR_MAX)
		}
		return DEFAULT_COLOR
	}

	const applyEncoderColors = (input: unknown): boolean => {
		const src = Array.isArray(input) ? input : []
		let changed = false
		for (let i = 0; i < 16; i++) {
			const next = clampColor(src[i])
			if (colors[i] !== next) {
				colors[i] = next
				changed = true
			}
		}
		return changed
	}

	const clampBrightness = (value: unknown): number => {
		if (typeof value === "number" && Number.isFinite(value)) {
			return clamp(Math.round(value), BRIGHTNESS_MIN, BRIGHTNESS_MAX)
		}
		if (typeof value === "bigint") {
			return clamp(Number(value), BRIGHTNESS_MIN, BRIGHTNESS_MAX)
		}
		return DEFAULT_BRIGHTNESS
	}

	const applyEncoderBrightness = (input: unknown): boolean => {
		const src = Array.isArray(input) ? input : []
		let changed = false
		for (let i = 0; i < 16; i++) {
			const next = clampBrightness(src[i])
			if (baseBrightness[i] !== next) {
				baseBrightness[i] = next
				changed = true
			}
		}
		return changed
	}

	const updateSingleColor = (encId: number, value: unknown): boolean => {
		if (!Number.isInteger(encId) || encId < 0 || encId > 15) return false
		const next = clampColor(value)
		if (colors[encId] === next) return false
		colors[encId] = next
		return true
	}

	const updateSingleBrightness = (encId: number, value: unknown): boolean => {
		if (!Number.isInteger(encId) || encId < 0 || encId > 15) return false
		const next = clampBrightness(value)
		if (baseBrightness[encId] === next) return false
		baseBrightness[encId] = next
		return true
	}

	const sendDump = (ctx: PageContext) => {
		const colorPayload = colors.map((c) => c)
		const valuePayload = Array.from(vals, (v) => toFixedN(v / 127, 5))
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/config/color/map`, ...colorPayload)
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/all/value`, ...valuePayload)
	}

	const frame = (): LedFrame => {
		const out: any = {}
		for (let i = 0; i < 16; i++) {
			out[i] = {
				ring: to127(vals[i]),
				rgb: colors[i],
				ledBrightness: pressed[i] ? PRESSED_BRIGHTNESS : baseBrightness[i],
				ringBrightness: 31,
				anim: "none",
			}
		}
		return out
	}

	return {
		init(ctx) {
			ctxRef = ctx
			emitPageType(ctx)
			for (let i = 0; i < 16; i++) vals[i] = 0
			applyEncoderColors(initialColorSource)
			applyEncoderBrightness(initialBrightnessSource)
			dirty = true
		},
		onFocus(ctx) {
			emitPageType(ctx)
			dirty = true
		},
		onBlur() {},
		onEvent(ev, ctx) {
			if (ev.type === "encoder/turn") {
				const step = 128 / ctx.resolution
				vals[ev.id] = clamp(vals[ev.id] + Math.round(ev.delta * step), 0, 127)
				// OSC out: /twister/out/page_<slot>/index/<id>/value <0..1>
				ctx.osc.send(
					`/twister/out/page/${ctx.slotLabel}/index/${ev.id}/value`,
					toFixedN(vals[ev.id] / 127, 5)
				)
				dirty = true
			}
			if (ev.type === "encoder/press") {
				pressed[ev.id] = ev.down
				ctx.osc.send(
					`/twister/out/page/${ctx.slotLabel}/index/${ev.id}/press`,
					ev.down ? 1 : 0
				)
				dirty = true
			}
		},
		onOsc(path, args, ctx) {
			if (path === "/config/color/map") {
				const changed = applyEncoderColors(args)
				if (changed) {
					dirty = true
					ctx.setDirty()
				}
				return
			}

			if (path === "/config/colorbrightness/map") {
				const changed = applyEncoderBrightness(args)
				if (changed) {
					dirty = true
					ctx.setDirty()
				}
				return
			}

			const colorSingleMatch = path.match(/^\/config\/color\/enc\/(\d{1,2})\/set$/)
			if (colorSingleMatch) {
				const encId = Number(colorSingleMatch[1])
				const color = args[0]
				if (updateSingleColor(encId, color)) {
					dirty = true
					ctx.setDirty()
				}
				return
			}

			const brightnessSingleMatch = path.match(
				/^\/config\/colorbrightness\/enc\/(\d{1,2})\/set$/
			)
			if (brightnessSingleMatch) {
				const encId = Number(brightnessSingleMatch[1])
				const brightness = args[0]
				if (updateSingleBrightness(encId, brightness)) {
					dirty = true
					ctx.setDirty()
				}
				return
			}

			if (path === "/dump") {
				sendDump(ctx)
				return
			}

			// /twister/in/page/<slot>/index/<id>/set <normFloat>
			const setMatch = path.match(/^\/index\/(\d{1,2})\/set$/)
			if (setMatch) {
				const id = Number(setMatch[1]) | 0
				const v = Number(args[0])
				if (id >= 0 && id < 16 && Number.isFinite(v)) {
					vals[id] = clamp(Math.round(v * 127), 0, 127)
					// Also emit OSC out so external clients see the update
					ctx.osc.send(
						`/twister/out/page/${ctx.slotLabel}/index/${id}/value`,
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
		dispose() {
			ctxRef = null
		},
	}
}
