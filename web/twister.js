/* The virtual Twister: a 4x4 encoder grid that mirrors the device's LEDs and
 * drives input back through the same path hardware takes.
 *
 * LED frames arrive as /twister/ui/leds — 16 [ring, rgb, ledBrightness,
 * ringBrightness, pulse01] tuples in human units, broadcast by the render loop
 * to UI clients only. Input goes out as /twister/ui/... which cli/index.ts
 * synthesizes into the same InputEvents the MIDI decoder produces.
 *
 * Index 0 is top-left, 15 bottom-right.
 *
 * Input model — press and turn are independent axes, as on the device:
 *   centre disc  press; dragging from it turns *and* holds the press, which is
 *                press-and-turn exactly as the hardware does it
 *   everywhere   turn
 *   else
 * The whole cell is live. Previously only the *painted* part of the value arc
 * responded, because SVG hit-testing follows the dash pattern — so the target
 * grew with the value, and an encoder sitting at 0 could be dragged from
 * exactly one spot on the ring.
 */

import {
	hitZone,
	normalizeWheel,
	accumulateDrag,
	chunkDelta,
	clampValue,
	reconcile,
	WHEEL_STEP_PX,
	SETTLE_MS,
} from "./lib/knobMath.js"

// Ring is an arc sweeping ~270° clockwise with a gap centred at the bottom.
// Angle convention: 0° = top (12 o'clock), increasing clockwise.
const VT_R = 38          // ring radius (viewBox is 0 0 100 100)
const VT_START_DEG = 225 // ring value = 0 (just past the bottom gap, left side)
const VT_END_DEG = 495   // ring value = 127 (225 + 270° sweep)
const SVG_NS = "http://www.w3.org/2000/svg"

function vtPoint(deg) {
	const rad = (deg * Math.PI) / 180
	return { x: 50 + VT_R * Math.sin(rad), y: 50 - VT_R * Math.cos(rad) }
}
function vtArcPath(fromDeg, toDeg) {
	const large = toDeg - fromDeg > 180 ? 1 : 0
	const p0 = vtPoint(fromDeg)
	const p1 = vtPoint(toDeg)
	return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${VT_R} ${VT_R} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`
}
const VT_ARC_D = vtArcPath(VT_START_DEG, VT_END_DEG)

// MFT colour index (1..126) -> CSS hue. Approximate by design: piecewise-linear
// interpolation between a handful of anchor points sampled from the device's
// cyclic palette, walked along the *descending* raw-degree path (so it wraps
// through negative values) then reduced mod 360.
const VT_COLOR_ANCHORS = [
	[1, 240], [33, 180], [60, 120], [66, 60], [74, 30], [80, 0], [110, -75], [126, -115],
]
export function vtColorIndexToCss(idx) {
	const c = Math.max(1, Math.min(126, Number(idx) || 1))
	for (let i = 0; i < VT_COLOR_ANCHORS.length - 1; i++) {
		const [i0, h0] = VT_COLOR_ANCHORS[i]
		const [i1, h1] = VT_COLOR_ANCHORS[i + 1]
		if (c >= i0 && c <= i1) {
			const t = (c - i0) / (i1 - i0)
			const h = h0 + (h1 - h0) * t
			return `hsl(${((h % 360) + 360) % 360}, 100%, 55%)`
		}
	}
	const [, hLast] = VT_COLOR_ANCHORS[VT_COLOR_ANCHORS.length - 1]
	return `hsl(${((hLast % 360) + 360) % 360}, 100%, 55%)`
}

function svgEl(tag, attrs) {
	const el = document.createElementNS(SVG_NS, tag)
	for (const k in attrs) el.setAttribute(k, attrs[k])
	return el
}

export function initTwister({ send }) {
	const vtGrid = document.getElementById("vtGrid")
	const cells = []          // per id: { root, valuePath, centerCircle, readout }
	const pressed = new Set() // ids currently held down (pointer or keyboard)

	// One drag at a time — a pointer id, the cell it captured, and its carry.
	let drag = null
	// Turns accumulated this animation frame, flushed as one batch per encoder.
	const pendingTurns = new Map()
	let turnFlushHandle = null

	// ---- Outbound ---------------------------------------------------------
	function queueTurn(id, delta) {
		if (!delta) return
		pendingTurns.set(id, (pendingTurns.get(id) || 0) + delta)
		if (turnFlushHandle === null) turnFlushHandle = requestAnimationFrame(flushTurns)
		predictTurn(id, delta)
	}
	function flushTurns() {
		turnFlushHandle = null
		for (const [id, total] of pendingTurns) {
			// The daemon clamps each turn to +/-16, so a hard flick goes as several
			// messages rather than one that silently truncates.
			for (const chunk of chunkDelta(total)) send("/twister/ui/enc/turn", id, chunk)
		}
		pendingTurns.clear()
	}
	function pressDown(id) {
		if (pressed.has(id)) return
		pressed.add(id)
		cells[id]?.root.classList.add("pressed")
		send("/twister/ui/enc/press", id, 1)
	}
	function pressUp(id) {
		if (!pressed.has(id)) return
		pressed.delete(id)
		cells[id]?.root.classList.remove("pressed")
		send("/twister/ui/enc/press", id, 0)
	}

	// ---- Grid -------------------------------------------------------------
	function renderGrid() {
		vtGrid.innerHTML = ""
		cells.length = 0
		for (let id = 0; id < 16; id++) {
			const root = document.createElement("div")
			root.className = "vtenc"
			root.tabIndex = 0
			root.setAttribute("role", "slider")
			root.setAttribute("aria-label", `Encoder ${id}`)
			root.setAttribute("aria-valuemin", "0")
			root.setAttribute("aria-valuemax", "127")

			const svg = svgEl("svg", { viewBox: "0 0 100 100" })
			const bg = svgEl("path", { class: "vt-ring-bg", d: VT_ARC_D })
			const val = svgEl("path", {
				class: "vt-ring-val", d: VT_ARC_D, pathLength: "1",
				"stroke-dasharray": "0 2", "stroke-dashoffset": "0",
			})
			const center = svgEl("circle", { class: "vt-center", cx: 50, cy: 50, r: 22 })
			const label = svgEl("text", { class: "vt-label", x: 50, y: 82 })
			label.textContent = String(id)
			const readout = svgEl("text", { class: "vt-readout", x: 50, y: 56 })
			readout.textContent = ""

			svg.append(bg, val, center, label, readout)
			root.appendChild(svg)
			// Nothing inside the cell should intercept the pointer: the cell itself
			// is the hit target, and the zone is decided from the coordinates.
			svg.style.pointerEvents = "none"
			vtGrid.appendChild(root)
			cells[id] = { root, valuePath: val, centerCircle: center, readout }

			attachPointer(root, id)
			attachKeyboard(root, id)

			// Seed a dim default so the grid isn't blank before the first LED frame,
			// and give prediction something to build on if a turn somehow lands
			// first. lastRendered stays null, so the first real frame always paints.
			authTuples[id] = [0, 1, 0, 1, 0]
			updateEncoder(id, authTuples[id])
		}
	}

	// ---- Pointer input ----------------------------------------------------
	function zoneAt(root, e) {
		const r = root.getBoundingClientRect()
		return hitZone((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
	}

	function attachPointer(root, id) {
		root.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 && e.pointerType === "mouse") return
			e.preventDefault()
			root.focus({ preventScroll: true })
			// Capture so the drag survives leaving the cell — or the window.
			try { root.setPointerCapture(e.pointerId) } catch {}
			drag = { id, pointerId: e.pointerId, lastY: e.clientY, lastT: e.timeStamp, carryPx: 0 }
			root.classList.add("dragging")
			// Centre = the button. A drag starting here still turns, which is
			// press-and-turn, exactly as the hardware behaves.
			if (zoneAt(root, e) === "center") pressDown(id)
		})

		root.addEventListener("pointermove", (e) => {
			if (!drag || drag.pointerId !== e.pointerId) return
			const dy = drag.lastY - e.clientY // dragging up = positive
			const dt = Math.max(0, e.timeStamp - drag.lastT)
			drag.lastY = e.clientY
			drag.lastT = e.timeStamp
			const { carryPx, delta } = accumulateDrag(drag.carryPx, {
				dy, dt, fine: e.altKey, coarse: e.metaKey || e.ctrlKey,
			})
			drag.carryPx = carryPx
			queueTurn(drag.id, delta)
		})

		// Cursor follows the zone under the pointer: the centre is a button, the
		// rest is a knob. Written only when it changes.
		root.addEventListener("pointermove", (e) => {
			if (drag) return
			root.classList.toggle("over-center", zoneAt(root, e) === "center")
		})
		root.addEventListener("pointerleave", () => root.classList.remove("over-center"))

		const end = (e) => {
			if (!drag || drag.pointerId !== e.pointerId) return
			try { root.releasePointerCapture(e.pointerId) } catch {}
			root.classList.remove("dragging")
			drag = null
			pressUp(id)
		}
		root.addEventListener("pointerup", end)
		root.addEventListener("pointercancel", end)

		root.addEventListener("wheel", (e) => {
			e.preventDefault()
			// Accumulate real pixels: a mouse notch and a trackpad twitch are not
			// the same gesture, and treating both as one step made the wheel crawl
			// on one device and bolt on the other.
			const px = normalizeWheel(e.deltaY, e.deltaMode)
			const w = wheelCarry.get(id) || 0
			const total = w - px // wheel up (negative deltaY) = increase
			const steps = Math.trunc(total / WHEEL_STEP_PX)
			wheelCarry.set(id, total - steps * WHEEL_STEP_PX)
			queueTurn(id, steps)
		}, { passive: false })
	}
	const wheelCarry = new Map()

	// ---- Keyboard input ---------------------------------------------------
	function attachKeyboard(root, id) {
		root.addEventListener("keydown", (e) => {
			const big = e.shiftKey ? 10 : 1
			switch (e.key) {
				case "ArrowUp": case "ArrowRight":
					e.preventDefault(); queueTurn(id, big); return
				case "ArrowDown": case "ArrowLeft":
					e.preventDefault(); queueTurn(id, -big); return
				case " ": case "Enter":
					e.preventDefault()
					if (!e.repeat) pressDown(id)
					return
				case "Escape":
					pressUp(id); root.blur(); return
			}
		})
		root.addEventListener("keyup", (e) => {
			if (e.key === " " || e.key === "Enter") pressUp(id)
		})
		// A key held while focus moves away would otherwise stay stuck down.
		root.addEventListener("blur", () => pressUp(id))
	}

	// ---- Rendering --------------------------------------------------------
	function updateEncoder(id, tuple) {
		const els = cells[id]
		if (!els || !Array.isArray(tuple)) return
		const [ring, rgb, ledBrightness, ringBrightness, pulse01] = tuple
		const value = clampValue(ring)
		els.valuePath.setAttribute("stroke-dasharray", `${value / 127} 2`)
		els.valuePath.style.opacity = Math.max(0.05, Math.min(1, (Number(ringBrightness) || 0) / 31))
		els.centerCircle.setAttribute("fill", vtColorIndexToCss(rgb))
		const ledOpacity = 0.12 + (Math.max(0, Math.min(29, Number(ledBrightness) || 0)) / 29) * 0.88
		els.centerCircle.style.fillOpacity = ledOpacity
		els.centerCircle.classList.toggle("vt-pulse", !!pulse01)
		els.readout.textContent = String(value)
		els.root.setAttribute("aria-valuenow", String(value))
	}

	// ---- Prediction + frame application -----------------------------------
	// The ring moves the moment you drag it, rather than waiting for the round
	// trip through the daemon and the next render tick. Only the ring is
	// predicted: it is the one thing a turn moves, and colour, brightness and
	// pulse are page logic the browser has no way to model.
	//
	// A prediction holds only while turns are still in flight. Once the settle
	// window passes, the daemon's value is the truth — so a page that clamps or
	// quantizes snaps back once, after the gesture, instead of fighting it
	// mid-drag. See reconcile() in lib/knobMath.js.
	const authTuples = new Array(16).fill(null)   // last frame from the daemon
	const predicted = new Array(16).fill(null)    // local ring guess, or null
	const pendingSince = new Array(16).fill(null) // when this encoder last turned
	const lastRendered = new Array(16).fill(null) // what is actually on screen
	let frameHandle = null
	let settleHandle = null

	function sameTuple(a, b) {
		if (!a || !b || a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
		return true
	}

	function predictTurn(id, delta) {
		const base = predicted[id] ?? (authTuples[id] ? clampValue(authTuples[id][0]) : 0)
		predicted[id] = clampValue(base + delta)
		pendingSince[id] = performance.now()
		schedulePaint()
		// Nothing else will necessarily wake us when the window expires, so make
		// sure the hand-back to the daemon's value actually happens.
		if (settleHandle === null) {
			settleHandle = setTimeout(() => {
				settleHandle = null
				schedulePaint()
			}, SETTLE_MS + 20)
		}
	}

	/** What encoder `id` should show right now, prediction included. */
	function effectiveTuple(id, now) {
		const a = authTuples[id]
		if (!a) return null
		const { value, predicting } = reconcile({
			predicted: predicted[id],
			authoritative: clampValue(a[0]),
			pendingSince: pendingSince[id],
			now,
		})
		if (!predicting) {
			predicted[id] = null
			pendingSince[id] = null
		}
		return [value, a[1], a[2], a[3], a[4]]
	}

	function schedulePaint() {
		if (frameHandle === null) frameHandle = requestAnimationFrame(paintFrame)
	}

	// A frame carries all 16 encoders but usually only one of them moved.
	// Comparing the five fields first turns ~80 DOM writes per frame into the
	// handful that actually changed; rAF coalescing means several frames landing
	// inside one animation frame only paint the newest.
	function paintFrame() {
		frameHandle = null
		const now = performance.now()
		for (let id = 0; id < 16; id++) {
			const eff = effectiveTuple(id, now)
			if (!eff) continue
			if (sameTuple(lastRendered[id], eff)) continue
			lastRendered[id] = eff
			updateEncoder(id, eff)
		}
	}

	/** Take one raw /twister/ui/leds payload (a JSON string). */
	function applyLedFrame(json) {
		let frame
		try { frame = JSON.parse(json) } catch { return }
		if (!Array.isArray(frame)) return
		const n = Math.min(16, frame.length)
		for (let id = 0; id < n; id++) {
			if (Array.isArray(frame[id])) authTuples[id] = frame[id]
		}
		schedulePaint()
	}

	// rAF is paused while the tab is hidden, so buffered work lands stale.
	// On return, drop what we think is on screen and repaint from the latest
	// frame; any prediction from before the tab was hidden is long expired.
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) return
		lastRendered.fill(null)
		schedulePaint()
	})

	// ---- Side buttons -----------------------------------------------------
	// Shift is a sticky toggle; Global L / Main R are momentary (hold).
	function stickyToggle(btnId, side) {
		const btn = document.getElementById(btnId)
		let down = false
		btn.onclick = () => {
			down = !down
			btn.classList.toggle("active", down)
			// A held shift changes what every turn means; make that impossible to
			// miss rather than leaving it to one small button's styling.
			vtGrid.classList.toggle("shifted", anyShiftActive())
			send("/twister/ui/side/shift", side, down ? 1 : 0)
		}
	}
	function anyShiftActive() {
		return ["vtShiftL", "vtShiftR"].some((b) => document.getElementById(b).classList.contains("active"))
	}
	function momentary(btnId, side) {
		const btn = document.getElementById(btnId)
		btn.addEventListener("pointerdown", (e) => {
			e.preventDefault()
			try { btn.setPointerCapture(e.pointerId) } catch {}
			btn.classList.add("active")
			send("/twister/ui/side/global", side, 1)
		})
		const up = () => {
			if (btn.classList.contains("active")) {
				btn.classList.remove("active")
				send("/twister/ui/side/global", side, 0)
			}
		}
		btn.addEventListener("pointerup", up)
		btn.addEventListener("pointercancel", up)
	}
	stickyToggle("vtShiftL", "left")
	stickyToggle("vtShiftR", "right")
	momentary("vtGlobalL", "left")
	momentary("vtMainR", "right")

	// A drag interrupted by the window losing focus must not leave a key or
	// button stuck down in the daemon.
	window.addEventListener("blur", () => {
		if (drag) {
			cells[drag.id]?.root.classList.remove("dragging")
			drag = null
		}
		for (const id of [...pressed]) pressUp(id)
	})

	renderGrid()

	return { applyLedFrame }
}
