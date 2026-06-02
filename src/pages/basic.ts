/* BasicPage — 16 value encoders with selectable press modes.
 *
 * Value is a float 0..1 (the real processing/OSC resolution); the 0..127 ring is
 * LED feedback only. Three runtime modes (set via /mode, default "note") re-purpose
 * the encoder press:
 *   - note      : press = note on/off (+ /press OSC + brightness bump). [current]
 *   - precision : hold a knob → its turns are fine (normalStep / PRECISION_DIVISOR);
 *                 no /press OSC. Brightness bump shows "fine engaged".
 *   - recall    : one saved scene per page. Knob press recalls that knob's value;
 *                 L+R shift together saves the scene (flash); L shift alone (on
 *                 release, if R wasn't pressed) recalls the whole scene. No /press.
 *                 R shift alone is reserved for future multi-scene.
 *
 * OSC: value out `/index/<id>/value <0..1>`; in `/index/<id>/set <0..1>`. Mode out
 * `/page/<slot>/mode <name>` (on init/focus/change); in via `/mode <name>`.
 */

import { Page, LedFrame, EncId, PageContext } from "../core/types.js"
import { clamp, toFixedN, to127 } from "../util/scale.js"

export interface BasicPageConfig {
	encoderColors?: unknown
	encoderBrightness?: unknown
}

type BasicMode = "note" | "precision" | "recall"
const MODES: readonly BasicMode[] = ["note", "precision", "recall"]

const DEFAULT_COLOR = 110
const DEFAULT_BRIGHTNESS = 5
const PRESSED_BRIGHTNESS = 29
const COLOR_MIN = 1
const COLOR_MAX = 126
const BRIGHTNESS_MIN = 0
const BRIGHTNESS_MAX = 29
const PRECISION_DIVISOR = 8 // fine-tune step = normalStep / this (tunable)
const SAVE_FLASH_MS = 120

export function BasicPage(config?: BasicPageConfig): Page {
	const vals = new Array<number>(16).fill(0) // float 0..1 (LED 0..127 is display only)
	const pressed = new Array<boolean>(16).fill(false)
	const colors = new Array<number>(16).fill(DEFAULT_COLOR)
	const baseBrightness = new Array<number>(16).fill(DEFAULT_BRIGHTNESS)
	const initialColorSource = config?.encoderColors
	const initialBrightnessSource = config?.encoderBrightness

	let mode: BasicMode = "note"
	const savedScene = new Array<number>(16).fill(0) // recall-mode snapshot
	let lDown = false
	let rDown = false
	let savedDuringL = false // L+R save happened this L-hold → suppress L-release recall
	let flashing = false
	let flashTimer: NodeJS.Timeout | null = null

	let dirty = true
	let ctxRef: PageContext | null = null

	const emitPageType = (ctx: PageContext) => {
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/type`, "Basic")
	}
	const emitMode = (ctx: PageContext) => {
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/mode`, mode)
	}
	const emitValue = (ctx: PageContext, id: number) => {
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/${id}/value`, toFixedN(vals[id], 5))
	}
	const normalStep = (ctx: PageContext) => 128 / ctx.resolution / 127

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

	const setMode = (ctx: PageContext, raw: unknown) => {
		const next = MODES.find((m) => m === raw)
		if (!next || next === mode) return
		mode = next
		// Clear transient gesture state on any mode change.
		pressed.fill(false)
		lDown = rDown = savedDuringL = false
		emitMode(ctx)
		dirty = true
		ctx.setDirty()
	}

	const triggerSaveFlash = (ctx: PageContext) => {
		flashing = true
		dirty = true
		ctx.setDirty()
		if (flashTimer) clearTimeout(flashTimer)
		flashTimer = setTimeout(() => {
			flashTimer = null
			flashing = false
			dirty = true
			ctxRef?.setDirty()
		}, SAVE_FLASH_MS)
	}

	const recallAll = (ctx: PageContext) => {
		for (let i = 0; i < 16; i++) {
			vals[i] = savedScene[i]
			emitValue(ctx, i)
		}
		dirty = true
	}

	const sendDump = (ctx: PageContext) => {
		const colorPayload = colors.map((c) => c)
		const valuePayload = vals.map((v) => toFixedN(v, 5))
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/config/color/map`, ...colorPayload)
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/all/value`, ...valuePayload)
	}

	const frame = (): LedFrame => {
		const out: any = {}
		for (let i = 0; i < 16; i++) {
			out[i] = {
				ring: to127(vals[i] * 127),
				rgb: colors[i],
				ledBrightness: flashing || pressed[i] ? PRESSED_BRIGHTNESS : baseBrightness[i],
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
			emitMode(ctx)
			dirty = true
		},
		onFocus(ctx) {
			ctxRef = ctx
			emitPageType(ctx)
			emitMode(ctx)
			dirty = true
		},
		onBlur() {},
		onEvent(ev, ctx) {
			ctxRef = ctx
			if (ev.type === "encoder/turn") {
				const fine = mode === "precision" && pressed[ev.id]
				const step = fine ? normalStep(ctx) / PRECISION_DIVISOR : normalStep(ctx)
				vals[ev.id] = clamp(vals[ev.id] + ev.delta * step, 0, 1)
				emitValue(ctx, ev.id)
				dirty = true
				return
			}
			if (ev.type === "encoder/press") {
				if (mode === "recall") {
					if (ev.down) {
						vals[ev.id] = savedScene[ev.id] // recall this knob
						emitValue(ctx, ev.id)
						dirty = true
					}
					return
				}
				if (mode === "precision") {
					pressed[ev.id] = ev.down // gate fine turns + brightness; no /press
					dirty = true
					return
				}
				// note (default): brightness bump + /press OSC
				pressed[ev.id] = ev.down
				ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/${ev.id}/press`, ev.down ? 1 : 0)
				dirty = true
				return
			}
			if (ev.type === "side/shift") {
				if (mode !== "recall") return
				if (ev.side === "left") {
					if (ev.down) {
						lDown = true
						savedDuringL = false
						if (rDown) {
							savedScene.splice(0, 16, ...vals)
							savedDuringL = true
							triggerSaveFlash(ctx)
						}
					} else {
						if (!savedDuringL) recallAll(ctx)
						lDown = false
						savedDuringL = false
					}
				} else {
					if (ev.down) {
						rDown = true
						if (lDown) {
							savedScene.splice(0, 16, ...vals)
							savedDuringL = true
							triggerSaveFlash(ctx)
						}
					} else {
						rDown = false
					}
				}
				return
			}
		},
		onOsc(path, args, ctx) {
			if (path === "/mode") {
				setMode(ctx, args[0])
				return
			}
			if (path === "/config/color/map") {
				if (applyEncoderColors(args)) {
					dirty = true
					ctx.setDirty()
				}
				return
			}
			if (path === "/config/colorbrightness/map") {
				if (applyEncoderBrightness(args)) {
					dirty = true
					ctx.setDirty()
				}
				return
			}
			const colorSingleMatch = path.match(/^\/config\/color\/enc\/(\d{1,2})\/set$/)
			if (colorSingleMatch) {
				if (updateSingleColor(Number(colorSingleMatch[1]), args[0])) {
					dirty = true
					ctx.setDirty()
				}
				return
			}
			const brightnessSingleMatch = path.match(/^\/config\/colorbrightness\/enc\/(\d{1,2})\/set$/)
			if (brightnessSingleMatch) {
				if (updateSingleBrightness(Number(brightnessSingleMatch[1]), args[0])) {
					dirty = true
					ctx.setDirty()
				}
				return
			}
			if (path === "/dump") {
				sendDump(ctx)
				return
			}
			// /twister/in/page/<slot>/index/<id>/set <0..1>
			const setMatch = path.match(/^\/index\/(\d{1,2})\/set$/)
			if (setMatch) {
				const id = Number(setMatch[1]) | 0
				const v = Number(args[0])
				if (id >= 0 && id < 16 && Number.isFinite(v)) {
					vals[id] = clamp(v, 0, 1)
					emitValue(ctx, id)
					dirty = true
				}
			}
		},
		render() {
			if (!dirty) return
			dirty = false
			return frame()
		},
		serialize() {
			// Structural config only: live palette + brightness, not encoder values.
			return {
				encoderColors: [...colors],
				encoderBrightness: [...baseBrightness],
			}
		},
		dispose() {
			if (flashTimer) {
				clearTimeout(flashTimer)
				flashTimer = null
			}
			ctxRef = null
		},
	}
}
