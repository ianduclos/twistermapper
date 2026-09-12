/* Everything on the page that is not the virtual Twister: page focus, the value
 * monitor, the layout/preset editor, global settings, the pulse generator, and
 * the raw log.
 *
 * All of this is state the daemon owns and broadcasts; the panels render what
 * arrives and send intent back. The one exception is the pulse generator, whose
 * clock genuinely lives here (see Architecture.md — there is no internal clock).
 */

const SLOTS = ["a", "b", "c", "d", "e", "f", "g", "h"]
const PAGE_OPTIONS = ["Basic", "Gesture", "Hotelier", "Morph", "StepSeq"]
const MODE_OPTIONS = ["note", "precision", "recall"]
const MODE_HELP = {
	note: "A press sends a note on, releasing sends note off.",
	precision: "Hold a knob to make its turns fine.",
	recall: "Press recalls a saved position. Both shifts save, left shift recalls every knob.",
}

export function initPanels({ send }) {
	let focused = null
	const types = {}   // slot -> page type
	const modes = {}   // slot -> Basic mode
	const values = {}  // slot -> { index -> 0..1 }
	SLOTS.forEach((s) => (values[s] = {}))
	let presets = []
	let activePreset = ""
	let settings = null

	// ---- Raw log ----------------------------------------------------------
	// A capped ring buffer flushed at most once per animation frame. Rebuilding
	// textContent per message forced a synchronous layout on every inbound
	// frame; at LED-frame rates that was the UI's dominant main-thread cost,
	// competing with the drag handler for the same thread.
	const logEl = document.getElementById("log")
	const logLedsEl = document.getElementById("logLeds")
	const LOG_MAX_LINES = 200
	const logLines = []
	let logDirty = false
	let logFlushHandle = null

	function scheduleLogFlush() {
		if (logFlushHandle === null) logFlushHandle = requestAnimationFrame(flushLog)
	}
	function flushLog() {
		logFlushHandle = null
		if (!logDirty) return
		// Off-screen (other tab): keep buffering and stay dirty, skip the paint.
		if (!logEl.offsetParent) return
		logDirty = false
		logEl.textContent = logLines.join("\n")
	}
	function log(line) {
		logLines.unshift(line)
		if (logLines.length > LOG_MAX_LINES) logLines.length = LOG_MAX_LINES
		logDirty = true
		scheduleLogFlush()
	}
	// Both of these sit inside the <summary>, where a click would otherwise
	// toggle the disclosure as well as doing its own job.
	document.getElementById("clearLog").onclick = (e) => {
		e.preventDefault()
		e.stopPropagation()
		logLines.length = 0
		logDirty = true
		scheduleLogFlush()
	}
	logLedsEl.closest("label").addEventListener("click", (e) => e.stopPropagation())

	// ---- Focus grid -------------------------------------------------------
	const focusGrid = document.getElementById("focusGrid")
	function renderFocusGrid() {
		focusGrid.innerHTML = ""
		SLOTS.forEach((s) => {
			const el = document.createElement("button")
			el.type = "button"
			el.className = "slot" + (s === focused ? " focused" : "")
			// The colour bar is keyed off this, so a slot is identifiable at a
			// glance without reading the label.
			if (types[s]) el.dataset.type = types[s]
			el.setAttribute("aria-pressed", String(s === focused))
			el.innerHTML = `<span class="l">${s.toUpperCase()}</span><span class="t">${types[s] || "–"}</span>`
			el.onclick = () => send("/twister/in/focus/page", s)
			focusGrid.appendChild(el)
		})
	}
	const chipEl = document.getElementById("monSlot")
	function renderSlotChip() {
		if (!focused) return
		chipEl.textContent =
			focused.toUpperCase() + (types[focused] ? ` ${types[focused].toLowerCase()}` : "")
	}
	function setFocus(slot) {
		if (!SLOTS.includes(slot)) return
		focused = slot
		renderSlotChip()
		renderFocusGrid()
		renderValues()
		renderModeControl()
	}

	// ---- Value monitor ----------------------------------------------------
	const valuesEl = document.getElementById("values")
	// Sized to the indices the page actually reports, floored at 16. The old
	// fixed 4x4 could not show a page with more values than the matrix has
	// encoders, which was the one thing this panel existed for.
	function renderValues() {
		valuesEl.innerHTML = ""
		const v = values[focused] || {}
		const highest = Object.keys(v).reduce((m, k) => Math.max(m, Number(k)), -1)
		const n = Math.max(16, highest + 1)
		for (let i = 0; i < n; i++) {
			const val = Math.max(0, Math.min(1, v[i] ?? 0))
			const tick = document.createElement("i")
			tick.className = "tick"
			// Full height always, with the fill drawn into it — sixteen stubs at
			// zero read as a broken widget rather than as sixteen zeros.
			tick.style.setProperty("--v", `${(val * 100).toFixed(1)}%`)
			tick.title = `${i}: ${val.toFixed(3)}`
			valuesEl.appendChild(tick)
		}
	}

	// ---- Layout (page per slot) -------------------------------------------
	const layoutGrid = document.getElementById("layoutGrid")
	function renderLayout() {
		layoutGrid.innerHTML = ""
		SLOTS.forEach((s) => {
			const cell = document.createElement("div")
			cell.className = "lcell"
			const lab = document.createElement("div")
			lab.className = "llab"
			lab.textContent = s.toUpperCase()
			const sel = document.createElement("select")
			PAGE_OPTIONS.forEach((p) => {
				const o = document.createElement("option")
				o.value = p
				o.textContent = p
				if (types[s] === p) o.selected = true
				sel.appendChild(o)
			})
			sel.onchange = () => send(`/twister/in/slot/${s}/page`, sel.value)
			cell.appendChild(lab)
			cell.appendChild(sel)
			layoutGrid.appendChild(cell)
		})
	}

	// ---- Basic page mode (for the focused slot) ---------------------------
	const modeRow = document.getElementById("modeRow")
	const modeSel = document.getElementById("modeSel")
	MODE_OPTIONS.forEach((mo) => {
		const o = document.createElement("option")
		o.value = mo
		o.textContent = mo
		modeSel.appendChild(o)
	})
	modeSel.onchange = () => {
		modeHelp.textContent = MODE_HELP[modeSel.value] || ""
		if (focused) send(`/twister/in/page/${focused}/mode`, modeSel.value)
	}
	const modeHelp = document.getElementById("modeHelp")
	function renderModeControl() {
		const on = !!focused && types[focused] === "Basic"
		modeRow.hidden = !on
		if (!on) return
		modeSel.value = modes[focused] || "note"
		modeHelp.textContent = MODE_HELP[modeSel.value] || ""
	}

	// ---- Presets ----------------------------------------------------------
	const presetList = document.getElementById("presetList")
	const activeEl = document.getElementById("activePreset")
	function renderPresets() {
		activeEl.textContent = activePreset || "unsaved"
		presetList.innerHTML = ""
		if (!presets.length) {
			presetList.innerHTML = '<p class="help">No presets yet. Save one to keep this layout.</p>'
			return
		}
		presets.forEach((name) => {
			const row = document.createElement("div")
			row.className = "row prow"
			const nm = document.createElement("span")
			nm.className = "pname" + (name === activePreset ? " active" : "")
			nm.textContent = name
			const load = document.createElement("button")
			load.textContent = "Load"
			load.onclick = () => send("/twister/in/preset/load", name)
			const del = document.createElement("button")
			del.textContent = "Delete"
			del.onclick = () => {
				if (confirm(`Delete preset "${name}"?`)) send("/twister/in/preset/delete", name)
			}
			row.appendChild(nm)
			row.appendChild(load)
			row.appendChild(del)
			presetList.appendChild(row)
		})
	}

	const presetNameEl = document.getElementById("presetName")
	document.getElementById("savePreset").onclick = () => {
		const name = presetNameEl.value.trim()
		if (!name) return
		send("/twister/in/preset/save", name)
		presetNameEl.value = ""
	}
	presetNameEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter") document.getElementById("savePreset").click()
	})

	// ---- Global settings --------------------------------------------------
	function renderSettings() {
		if (!settings) return
		document.getElementById("set_mainDoubleClickMs").value = settings.interaction.mainDoubleClickMs
		document.getElementById("set_mainHoldThresholdMs").value = settings.interaction.mainHoldThresholdMs
		document.getElementById("set_debounceMs").value = settings.interaction.debounceMs
		document.getElementById("set_fps").value = settings.render.fps
	}
	document.getElementById("saveSettings").onclick = () => {
		const set = (k, id) => {
			const v = Number(document.getElementById(id).value)
			if (Number.isFinite(v)) send("/twister/in/settings/set", k, v)
		}
		set("mainDoubleClickMs", "set_mainDoubleClickMs")
		set("mainHoldThresholdMs", "set_mainHoldThresholdMs")
		set("debounceMs", "set_debounceMs")
		set("fps", "set_fps")
	}

	// ---- Pulse generator --------------------------------------------------
	// The daemon has no internal clock by design; this is the clock source.
	let playing = false
	let timer = null
	let pulseN = 0
	let cyclePos = 0
	const playBtn = document.getElementById("playBtn")
	const led = document.getElementById("pulseLed")
	const pulseCount = document.getElementById("pulseCount")
	const bpmEl = document.getElementById("bpm")
	const spbEl = document.getElementById("spb")
	const clockIdEl = document.getElementById("clockId")
	const skipEl = document.getElementById("skip")
	const skipVal = document.getElementById("skipVal")

	function intervalMs() {
		const bpm = Math.max(1, Number(bpmEl.value) || 120)
		const spb = Number(spbEl.value) || 4
		return 60000 / (bpm * spb)
	}
	function tick() {
		const skip = Number(skipEl.value)
		if (skip > 0 && Math.random() * 100 < skip) return // dropped pulse
		let id
		if (clockIdEl.value === "cycle") {
			id = cyclePos % 4
			cyclePos++
		} else id = Number(clockIdEl.value)
		send("/twister/in/clock", id)
		pulseN++
		pulseCount.textContent = `${pulseN} pulses`
		led.classList.add("flash")
		setTimeout(() => led.classList.remove("flash"), 40)
	}
	function restartTimer() {
		if (timer) clearInterval(timer)
		timer = setInterval(tick, intervalMs())
	}
	function setPlaying(on) {
		playing = on
		playBtn.classList.toggle("playing", on)
		playBtn.setAttribute("aria-label", on ? "Stop" : "Play")
		if (on) {
			cyclePos = 0
			restartTimer()
		} else if (timer) {
			clearInterval(timer)
			timer = null
		}
	}
	playBtn.onclick = () => setPlaying(!playing)
	bpmEl.oninput = () => { if (playing) restartTimer() }
	spbEl.oninput = () => { if (playing) restartTimer() }
	skipEl.oninput = () => { skipVal.textContent = `${skipEl.value}%` }

	// The log skips painting while it is off-screen, and a closed <details>
	// counts as off-screen — so opening it has to ask for the buffered repaint,
	// exactly as switching tabs does.
	logEl.closest("details")?.addEventListener("toggle", scheduleLogFlush)

	// ---- Tabs -------------------------------------------------------------
	document.querySelectorAll(".tabs button").forEach((btn) => {
		btn.onclick = () => {
			document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn))
			document.querySelectorAll("main.tab").forEach((m) => m.classList.toggle("active", m.id === btn.dataset.tab))
			// The log skips painting while hidden; repaint whatever it buffered.
			scheduleLogFlush()
		}
	})

	// ---- Inbound routing --------------------------------------------------
	/** Handle one daemon message. Returns false if the path isn't ours. */
	function handle(path, args) {
		if (path === "/twister/out/mode") {
			document.body.classList.toggle("fake-mode", args[0] === "fake")
			return true
		}
		if (path === "/twister/out/focus/page") { setFocus(args[0]); return true }
		if (path === "/twister/out/preset/list") { presets = args.slice(); renderPresets(); return true }
		if (path === "/twister/out/preset/active") { activePreset = args[0] || ""; renderPresets(); return true }
		if (path === "/twister/out/settings") {
			try { settings = JSON.parse(args[0]) } catch {}
			renderSettings()
			return true
		}
		let m = path.match(/^\/twister\/out\/page\/([a-h])\/type$/)
		if (m) { types[m[1]] = args[0]; renderSlotChip(); renderFocusGrid(); renderLayout(); renderModeControl(); return true }
		m = path.match(/^\/twister\/out\/page\/([a-h])\/mode$/)
		if (m) { modes[m[1]] = args[0]; renderModeControl(); return true }
		m = path.match(/^\/twister\/out\/page\/([a-h])\/index\/(\d+)\/value$/)
		if (m) {
			values[m[1]][+m[2]] = Number(args[0])
			if (m[1] === focused) renderValues()
			return true
		}
		return false
	}

	function render() {
		renderFocusGrid()
		renderValues()
		renderLayout()
		renderModeControl()
		renderPresets()
	}

	return {
		render,
		handle,
		log,
		scheduleLogFlush,
		shouldLogLeds: () => logLedsEl.checked,
	}
}
