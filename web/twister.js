/* The virtual Twister: a 4x4 encoder grid that mirrors the device's LEDs and
 * drives input back through the same path hardware takes.
 *
 * LED frames arrive as /twister/ui/leds — 16 [ring, rgb, ledBrightness,
 * ringBrightness, pulse01] tuples in human units, broadcast by the render loop
 * to UI clients only. Input goes out as /twister/ui/... which cli/index.ts
 * synthesizes into the same InputEvents the MIDI decoder produces.
 *
 * Index 0 is top-left, 15 bottom-right.
 */

// Ring is an arc sweeping ~270° clockwise with a gap centred at the bottom.
// Angle convention: 0° = top (12 o'clock), increasing clockwise.
const VT_R = 38          // ring radius (viewBox is 0 0 100 100)
const VT_START_DEG = 225 // ring value = 0 (just past the bottom gap, left side)
const VT_END_DEG = 495   // ring value = 127 (225 + 270° sweep)
const SVG_NS = "http://www.w3.org/2000/svg"
const VT_DRAG_STEP_PX = 4

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
	const vtEls = []
	const vtPressDown = new Set()
	let vtDrag = null // { id, lastY, accum } while dragging a ring

	function renderGrid() {
		vtGrid.innerHTML = ""
		vtEls.length = 0
		for (let id = 0; id < 16; id++) {
			const cell = document.createElement("div")
			cell.className = "vtenc"
			const svg = svgEl("svg", { viewBox: "0 0 100 100" })

			const bg = svgEl("path", { class: "vt-ring-bg", d: VT_ARC_D })
			const val = svgEl("path", {
				class: "vt-ring-val", d: VT_ARC_D, pathLength: "1",
				"stroke-dasharray": "0 2", "stroke-dashoffset": "0",
			})
			const center = svgEl("circle", { class: "vt-center", cx: 50, cy: 50, r: 22 })
			const label = svgEl("text", { class: "vt-label", x: 50, y: 80 })
			label.textContent = String(id)

			svg.appendChild(bg)
			svg.appendChild(val)
			svg.appendChild(center)
			svg.appendChild(label)
			cell.appendChild(svg)
			vtGrid.appendChild(cell)
			vtEls[id] = { valuePath: val, centerCircle: center }

			// Ring = the "knob": vertical drag (±1 per ~4px) and wheel (±1/notch).
			val.addEventListener("mousedown", (e) => {
				e.preventDefault()
				vtDrag = { id, lastY: e.clientY, accum: 0 }
			})
			val.addEventListener("wheel", (e) => {
				e.preventDefault()
				send("/twister/ui/enc/turn", id, e.deltaY < 0 ? 1 : -1)
			}, { passive: false })

			// Centre circle = the button.
			center.addEventListener("mousedown", (e) => {
				e.preventDefault()
				vtPressDown.add(id)
				send("/twister/ui/enc/press", id, 1)
			})
			const release = () => {
				if (vtPressDown.has(id)) {
					vtPressDown.delete(id)
					send("/twister/ui/enc/press", id, 0)
				}
			}
			center.addEventListener("mouseup", release)
			center.addEventListener("mouseleave", release)

			// Seed a dim default so the grid isn't blank before the first LED frame.
			// Deliberately not cached in lastTuples: the first real frame should
			// always paint, even if it happens to match this placeholder.
			updateEncoder(id, [0, 1, 0, 1, 0])
		}
	}

	document.addEventListener("mousemove", (e) => {
		if (!vtDrag) return
		const dy = vtDrag.lastY - e.clientY // dragging up = positive
		vtDrag.lastY = e.clientY
		vtDrag.accum += dy
		while (Math.abs(vtDrag.accum) >= VT_DRAG_STEP_PX) {
			const dir = vtDrag.accum > 0 ? 1 : -1
			send("/twister/ui/enc/turn", vtDrag.id, dir)
			vtDrag.accum -= dir * VT_DRAG_STEP_PX
		}
	})
	document.addEventListener("mouseup", () => { vtDrag = null })

	function updateEncoder(id, tuple) {
		const els = vtEls[id]
		if (!els || !Array.isArray(tuple)) return
		const [ring, rgb, ledBrightness, ringBrightness, pulse01] = tuple
		const ringFrac = Math.max(0, Math.min(1, (Number(ring) || 0) / 127))
		els.valuePath.setAttribute("stroke-dasharray", `${ringFrac} 2`)
		els.valuePath.style.opacity = Math.max(0.05, Math.min(1, (Number(ringBrightness) || 0) / 31))
		els.centerCircle.setAttribute("fill", vtColorIndexToCss(rgb))
		const ledOpacity = 0.12 + (Math.max(0, Math.min(29, Number(ledBrightness) || 0)) / 29) * 0.88
		els.centerCircle.style.fillOpacity = ledOpacity
		els.centerCircle.classList.toggle("vt-pulse", !!pulse01)
	}

	// ---- Frame application ------------------------------------------------
	// A frame carries all 16 encoders but usually only one of them moved.
	// Comparing the five fields first turns ~80 DOM writes per frame into the
	// handful that actually changed; rAF coalescing means several frames landing
	// inside one animation frame only paint the newest.
	const lastTuples = new Array(16).fill(null)
	let latestFrame = null
	let frameDirty = false
	let frameHandle = null

	function sameTuple(a, b) {
		if (!a || !b || a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
		return true
	}
	function schedulePaint() {
		if (frameHandle === null) frameHandle = requestAnimationFrame(paintFrame)
	}
	function paintFrame() {
		frameHandle = null
		if (!frameDirty || !latestFrame) return
		frameDirty = false
		const frame = latestFrame
		const n = Math.min(16, frame.length)
		for (let id = 0; id < n; id++) {
			const tuple = frame[id]
			if (!Array.isArray(tuple)) continue
			if (sameTuple(lastTuples[id], tuple)) continue
			lastTuples[id] = tuple.slice()
			updateEncoder(id, tuple)
		}
	}

	/** Take one raw /twister/ui/leds payload (a JSON string). */
	function applyLedFrame(json) {
		let frame
		try { frame = JSON.parse(json) } catch { return }
		if (!Array.isArray(frame)) return
		latestFrame = frame
		frameDirty = true
		schedulePaint()
	}

	// rAF is paused while the tab is hidden, so buffered work lands stale.
	// On return, drop the per-encoder cache and repaint from the latest frame.
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) return
		lastTuples.fill(null)
		if (latestFrame) {
			frameDirty = true
			schedulePaint()
		}
	})

	// ---- Side buttons -----------------------------------------------------
	// Shift is a sticky toggle; Global L / Main R are momentary (hold).
	function stickyToggle(btnId, side) {
		const btn = document.getElementById(btnId)
		let down = false
		btn.onclick = () => {
			down = !down
			btn.classList.toggle("active", down)
			send("/twister/ui/side/shift", side, down ? 1 : 0)
		}
	}
	function momentary(btnId, side) {
		const btn = document.getElementById(btnId)
		btn.addEventListener("mousedown", (e) => {
			e.preventDefault()
			btn.classList.add("active")
			send("/twister/ui/side/global", side, 1)
		})
		const up = () => {
			if (btn.classList.contains("active")) {
				btn.classList.remove("active")
				send("/twister/ui/side/global", side, 0)
			}
		}
		btn.addEventListener("mouseup", up)
		btn.addEventListener("mouseleave", up)
	}
	stickyToggle("vtShiftL", "left")
	stickyToggle("vtShiftR", "right")
	momentary("vtGlobalL", "left")
	momentary("vtMainR", "right")

	renderGrid()

	return { applyLedFrame }
}
