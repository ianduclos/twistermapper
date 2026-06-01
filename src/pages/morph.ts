/* MorphPage — 4-corner vector morph (Prophet-VS / pattr-style interpolation).
 *
 * Layout: top 12 encoders (0–11) are the morph OUTPUT; bottom 4 (12–15) are
 * scene weights. Four stored "scenes" (12 values each) are blended by the four
 * weights as a normalized weighted average — the same math Max `pattrstorage`
 * uses, so the weights map straight onto a pattr recall.
 *
 * Phantom "live scene": the currently dialed output P is an implicit anchor with
 * weight aₚ = max(0, 1 − Σaₖ). At rest (all weights 0) output = P, so there is no
 * jump on first touch; as you turn a weight up the phantom dissolves smoothly and
 * once Σaₖ ≥ 1 you're in the pure 4-scene field. Pressing a weight is the one
 * intentional jump (hard recall).
 *
 * Persistence is Max's job (no serialize()): respond to /dump with each scene's
 * values; accept /scene/<k>/set <12 floats> to restore. Soft-state (P, weights)
 * is transient.
 */

import { Page, LedFrame, EncId, PageContext } from "../core/types.js"
import { clamp, toFixedN, to127 } from "../util/scale.js"

const OUTPUT_COUNT = 12
const SCENE_COUNT = 4
const WEIGHT_OFFSET = 12 // encoders 12..15 are the scene weights

const TOP_COLOR = 1 // blue — outputs
const SCENE_COLORS = [80, 60, 66, 110] as const // red, green, yellow, purple
const TOP_BRIGHTNESS = 6
const SCENE_BRIGHTNESS_IDLE = 10
const SCENE_BRIGHTNESS_DOMINANT = 29
const SAVE_PULSE_MS = 90

export function MorphPage(): Page {
	const live = new Array<number>(OUTPUT_COUNT).fill(0) // phantom scene P (0..127)
	const scenes = Array.from({ length: SCENE_COUNT }, () => new Array<number>(OUTPUT_COUNT).fill(0))
	const weights = new Array<number>(SCENE_COUNT).fill(0) // 0..127
	const out = new Array<number>(OUTPUT_COUNT).fill(0) // derived output (0..127)
	const lastSent = new Array<number>(OUTPUT_COUNT + SCENE_COUNT).fill(-1)
	const pulseScene = new Array<boolean>(SCENE_COUNT).fill(false)
	let pulseTimer: NodeJS.Timeout | null = null
	let dirty = true
	let ctxRef: PageContext | null = null

	const emitType = (ctx: PageContext) => {
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/type`, "Morph")
	}

	const stepFor = (ctx: PageContext, delta: number) =>
		Math.round(delta * (128 / ctx.resolution))

	// Recompute the 12 outputs from phantom + weighted scenes (normalized).
	const recompute = () => {
		let sumA = 0
		const a = weights.map((w) => {
			const x = w / 127
			sumA += x
			return x
		})
		const aPhantom = Math.max(0, 1 - sumA)
		const denom = aPhantom + sumA // == max(1, sumA); never 0
		for (let i = 0; i < OUTPUT_COUNT; i++) {
			let acc = aPhantom * live[i]
			for (let k = 0; k < SCENE_COUNT; k++) acc += a[k] * scenes[k][i]
			out[i] = clamp(Math.round(acc / denom), 0, 127)
		}
	}

	// Emit changed outputs (index 0..11) and weights (index 12..15) as normalized.
	const emit = (ctx: PageContext) => {
		for (let i = 0; i < OUTPUT_COUNT; i++) {
			const v = toFixedN(out[i] / 127, 5)
			if (lastSent[i] !== v) {
				lastSent[i] = v
				ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/${i}/value`, v)
			}
		}
		for (let k = 0; k < SCENE_COUNT; k++) {
			const idx = WEIGHT_OFFSET + k
			const v = toFixedN(weights[k] / 127, 5)
			if (lastSent[idx] !== v) {
				lastSent[idx] = v
				ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/${idx}/value`, v)
			}
		}
	}

	const apply = (ctx: PageContext) => {
		recompute()
		emit(ctx)
		dirty = true
	}

	// One-shot save confirmation pulse on the saved scene's encoder.
	const triggerSavePulse = (k: number, ctx: PageContext) => {
		pulseScene[k] = true
		dirty = true
		ctx.setDirty()
		if (pulseTimer) clearTimeout(pulseTimer)
		pulseTimer = setTimeout(() => {
			pulseTimer = null
			pulseScene.fill(false)
			dirty = true
			ctxRef?.setDirty()
		}, SAVE_PULSE_MS)
	}

	const frame = (): LedFrame => {
		const f = {} as LedFrame
		for (let i = 0; i < OUTPUT_COUNT; i++) {
			f[i as EncId] = {
				ring: to127(out[i]),
				rgb: TOP_COLOR,
				ledBrightness: TOP_BRIGHTNESS,
				ringBrightness: 31,
				anim: "none",
			}
		}
		let maxW = 0
		for (const w of weights) if (w > maxW) maxW = w
		for (let k = 0; k < SCENE_COUNT; k++) {
			const enc = (WEIGHT_OFFSET + k) as EncId
			const dominant = weights[k] > 0 && weights[k] >= maxW
			f[enc] = {
				ring: to127(weights[k]),
				rgb: SCENE_COLORS[k],
				ledBrightness: dominant ? SCENE_BRIGHTNESS_DOMINANT : SCENE_BRIGHTNESS_IDLE,
				ringBrightness: 31,
				anim: pulseScene[k] ? "pulse" : "none",
			}
		}
		return f
	}

	return {
		init(ctx) {
			ctxRef = ctx
			emitType(ctx)
			apply(ctx)
		},
		onFocus(ctx) {
			ctxRef = ctx
			emitType(ctx)
			dirty = true
		},
		onBlur() {},
		onEvent(ev, ctx) {
			ctxRef = ctx
			if (ev.type === "encoder/turn") {
				const d = stepFor(ctx, ev.delta)
				if (!d) return
				if (ev.id >= 0 && ev.id < OUTPUT_COUNT) {
					// Grab the current output as the new phantom scene, drop the
					// weights, then apply the edit — sound stays continuous.
					for (let i = 0; i < OUTPUT_COUNT; i++) live[i] = out[i]
					weights.fill(0)
					live[ev.id] = clamp(live[ev.id] + d, 0, 127)
					apply(ctx)
				} else if (ev.id >= WEIGHT_OFFSET && ev.id < WEIGHT_OFFSET + SCENE_COUNT) {
					const k = ev.id - WEIGHT_OFFSET
					weights[k] = clamp(weights[k] + d, 0, 127)
					apply(ctx)
				}
				return
			}
			if (ev.type === "encoder/press") {
				if (ev.id < WEIGHT_OFFSET || ev.id >= WEIGHT_OFFSET + SCENE_COUNT) return
				const k = ev.id - WEIGHT_OFFSET
				ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/${ev.id}/press`, ev.down ? 1 : 0)
				if (!ev.down) return
				const shift = ctx.modifiers.shiftLeft || ctx.modifiers.shiftRight
				if (shift) {
					// Save: snapshot the current output into scene k (does not move sound).
					for (let i = 0; i < OUTPUT_COUNT; i++) scenes[k][i] = out[i]
					triggerSavePulse(k, ctx)
				} else {
					// Recall: hard jump to scene k.
					weights.fill(0)
					weights[k] = 127
					apply(ctx)
				}
				return
			}
		},
		onOsc(path, args, ctx) {
			ctxRef = ctx
			const sceneSet = path.match(/^\/scene\/(\d)\/set$/)
			if (sceneSet) {
				const k = Number(sceneSet[1])
				if (k >= 0 && k < SCENE_COUNT) {
					for (let i = 0; i < OUTPUT_COUNT; i++) {
						const v = Number(args[i])
						if (Number.isFinite(v)) scenes[k][i] = clamp(Math.round(v * 127), 0, 127)
					}
					apply(ctx)
				}
				return
			}
			if (path === "/dump") {
				for (let k = 0; k < SCENE_COUNT; k++) {
					const vals = scenes[k].map((v) => toFixedN(v / 127, 5))
					ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/scene/${k}/values`, ...vals)
				}
				return
			}
		},
		render() {
			if (!dirty) return
			dirty = false
			return frame()
		},
		dispose() {
			if (pulseTimer) {
				clearTimeout(pulseTimer)
				pulseTimer = null
			}
			ctxRef = null
		},
	}
}
