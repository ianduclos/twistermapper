/* HotelierPage — gig-specific prototype copied from GesturePage.
 * Initially preserves its per-encoder record/playback behavior.
 *
 * Value is a float 0..1 (the real processing/OSC resolution); the 0..127 ring is
 * LED feedback only. Each encoder cycles through three modes on button press:
 *   standby  (blue,  brightness 5)  — turns edit the value directly; OSC /set
 *                                     is accepted.
 *   record   (red, pulsing)         — turns edit the value and are appended to
 *                                     a timeline of (t, v) points.
 *   playback (green, brightness 10) — the recorded timeline loops on a 20ms
 *                                     tick with linear interpolation; turns
 *                                     are ignored.
 * A third press (from playback) returns to standby and clears the recording.
 *
 * OSC: value out `/index/<id>/value <0..1>` on any change — playback ticks
 * dedupe against the last-sent 5dp value so a static (or held) loop segment
 * doesn't spam identical messages every 20ms. In: `/index/<id>/set <0..1>`,
 * accepted only in standby.
 */

import { Page, LedFrame, EncId, PageContext } from "../core/types.js"
import colors from "../config/colors.json" with { type: "json" }
import { clamp, to127, toFixedN } from "../util/scale.js"

type Mode = "standby" | "record" | "playback"

type Point = { t: number; v: number } // ms since record start, value float 0..1

const asEncId = (n: number): EncId => {
	if (!Number.isInteger(n) || n < 0 || n > 15) throw new Error(`EncId out of range: ${n}`)
	return n as EncId
}

const COLOR_BLUE = Number(colors.blue ?? 1)
const COLOR_RED = Number(colors.red ?? 80)
const COLOR_GREEN = Number(colors.green ?? 60)

const STANDBY_BRIGHTNESS = 5
const RECORD_BRIGHTNESS = 29 // pulse overrides brightness at the device (R3)
const PLAYBACK_BRIGHTNESS = 10
const PLAYBACK_TICK_MS = 20

export function HotelierPage(): Page {
	const vals = new Array<number>(16).fill(0) // float 0..1 (LED 0..127 is display only)
	const mode = Array<Mode>(16).fill("standby")
	const rec = Array.from({ length: 16 }, () => [] as Point[]) // recorded timelines
	const recT0 = new Array<number>(16).fill(0)
	const playT0 = new Array<number>(16).fill(0)
	const timers = new Array<ReturnType<typeof setInterval> | null>(16).fill(null)
	const lastEmitted = new Array<number>(16).fill(NaN) // last 5dp value sent, per encoder

	let dirty = true
	let ctxRef: PageContext | null = null

	const emitPageType = (ctx: PageContext) => {
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/type`, "Hotelier")
	}

	const emitOsc = (ctx: PageContext, i: EncId) => {
		const v = toFixedN(vals[i], 5)
		if (lastEmitted[i] === v) return
		lastEmitted[i] = v
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/${i}/value`, v)
	}

	// /dump — re-emit everything a host needs to re-sync this page without a
	// reload: the type, all sixteen values, and the per-encoder mode. The mode
	// matters because /set is only accepted on an encoder in standby, so a host
	// that dumps knows which ones it may push to. Bypasses the per-encoder
	// dedup in emitOsc on purpose: a dump is a request for the whole picture,
	// not a change notification.
	const sendDump = (ctx: PageContext) => {
		emitPageType(ctx)
		const valuePayload = vals.map((v) => toFixedN(v, 5))
		for (let i = 0; i < 16; i++) lastEmitted[i] = valuePayload[i]
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/all/value`, ...valuePayload)
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/index/all/mode`, ...mode)
	}

	const stopTimer = (i: EncId) => {
		if (timers[i]) {
			clearInterval(timers[i]!)
			timers[i] = null
		}
	}

	const beginRecord = (i: EncId) => {
		stopTimer(i)
		rec[i] = [{ t: 0, v: vals[i] }] // start from the current value
		recT0[i] = Date.now()
		mode[i] = "record"
		dirty = true
	}

	const finalizeRecording = (i: EncId) => {
		const tl = rec[i]
		let t = Date.now() - recT0[i]
		if (tl.length === 0) tl.push({ t: 0, v: vals[i] }) // no turns happened; start at t=0
		const last = tl[tl.length - 1]
		// Force strictly increasing time so playback duration is always > 0.
		if (t <= last.t) t = last.t + 1
		// Always append a final point, even if the value didn't change, so
		// trailing silence at the end of the take is recorded and loops cleanly.
		tl.push({ t, v: vals[i] })
	}

	const beginPlayback = (i: EncId) => {
		stopTimer(i)
		mode[i] = "playback"
		const tl = rec[i]
		if (tl.length < 2) {
			// Nothing to interpolate; hold the static value.
			dirty = true
			return
		}
		playT0[i] = Date.now()
		timers[i] = setInterval(() => tickPlayback(i), PLAYBACK_TICK_MS)
		dirty = true
	}

	const backToStandby = (i: EncId) => {
		stopTimer(i)
		rec[i] = []
		mode[i] = "standby"
		dirty = true
	}

	// Playback interpolation at the current time; modular over the take's
	// duration, wrapping via a synthetic segment back to the first value.
	const tickPlayback = (i: EncId) => {
		if (!ctxRef) return
		const tl = rec[i]
		if (tl.length < 2) return

		const dur = tl[tl.length - 1].t // ms total
		if (dur <= 0) return

		const t = (Date.now() - playT0[i]) % dur // 0..dur-ε

		// First point with t past the current time (always exists: last.t == dur > t).
		let idx = 0
		while (idx < tl.length && tl[idx].t <= t) idx++

		const a = tl[Math.max(0, idx - 1)]
		const b = idx >= tl.length ? { t: dur, v: tl[0].v } : tl[idx]

		const span = Math.max(1, b.t - a.t)
		const u = (t - a.t) / span // 0..1
		const v = clamp(a.v + u * (b.v - a.v), 0, 1)

		if (v !== vals[i]) {
			vals[i] = v
			dirty = true
			ctxRef.setDirty()
			emitOsc(ctxRef, i)
		}
	}

	return {
		init(ctx) {
			ctxRef = ctx
			emitPageType(ctx)
			for (let i = 0; i < 16; i++) vals[i] = 0
			dirty = true
		},
		onFocus(ctx) {
			ctxRef = ctx
			emitPageType(ctx)
			dirty = true
		},
		onBlur() {
			// Keep timers running (playback continues); LEDs simply aren't
			// pushed for an unfocused page (R6).
		},
		onEvent(ev, ctx) {
			ctxRef = ctx
			if (ev.type === "encoder/press") {
				if (!ev.down) return
				const i = ev.id
				if (mode[i] === "standby") {
					beginRecord(i)
				} else if (mode[i] === "record") {
					finalizeRecording(i)
					beginPlayback(i)
				} else {
					backToStandby(i)
				}
				return
			}
			if (ev.type === "encoder/turn") {
				const i = ev.id
				if (mode[i] === "playback") return // ignore deltas while playing
				const step = (128 / ctx.resolution) / 127
				vals[i] = clamp(vals[i] + ev.delta * step, 0, 1)

				if (mode[i] === "record") {
					// Monotonic timestamp: force strictly increasing so two turns in
					// the same millisecond don't collapse into one point.
					const tRaw = Date.now() - recT0[i]
					const tl = rec[i]
					const lastT = tl.length ? tl[tl.length - 1].t : 0
					const t = tRaw <= lastT ? lastT + 1 : tRaw
					// Only append when the value changed, to keep the timeline compact.
					if (tl.length === 0 || tl[tl.length - 1].v !== vals[i]) {
						tl.push({ t, v: vals[i] })
					}
				}

				dirty = true
				emitOsc(ctx, i)
			}
		},
		onOsc(path, args, ctx) {
			ctxRef = ctx
			if (path === "/dump") {
				sendDump(ctx)
				return
			}
			// Only accept /set while in standby.
			const m = path.match(/^\/index\/(\d{1,2})\/set$/)
			if (!m) return
			const idNum = Number(m[1])
			if (!Number.isInteger(idNum) || idNum < 0 || idNum > 15) return
			const id = asEncId(idNum)
			if (mode[id] !== "standby") return

			const v = Number(args[0])
			if (!Number.isFinite(v)) return

			vals[id] = clamp(v, 0, 1)
			dirty = true
			emitOsc(ctx, id)
		},
		render(): LedFrame | undefined {
			if (!dirty) return
			dirty = false

			const out: any = {}
			for (let i = 0; i < 16; i++) {
				const m = mode[i]
				const base =
					m === "standby"
						? { rgb: COLOR_BLUE, ledBrightness: STANDBY_BRIGHTNESS, anim: "none" }
						: m === "record"
							? { rgb: COLOR_RED, ledBrightness: RECORD_BRIGHTNESS, anim: "pulse" }
							: { rgb: COLOR_GREEN, ledBrightness: PLAYBACK_BRIGHTNESS, anim: "none" }
				out[i] = {
					ring: to127(vals[i] * 127),
					ringBrightness: 31,
					...base,
				}
			}
			return out
		},
		dispose() {
			for (let i = 0; i < 16; i++) stopTimer(i as EncId)
			ctxRef = null
		},
	}
}
