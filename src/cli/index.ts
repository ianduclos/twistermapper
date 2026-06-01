// src/cli/index.ts
import { readFileSync, writeFileSync } from "node:fs"
import { resolve as resolvePath, join as joinPath } from "node:path"
import { tmpdir } from "node:os"
import midiLib from "@julusian/midi"
import { tryAcquireLock, releaseLock } from "../util/singleInstance.js"
import { NodeMidiDriver } from "../io/midiDriver.js" // real driver from Codex task
import { LedReconciler } from "../render/ledReconciler.js"
import { createRenderLoop, type RenderLoop } from "../render/renderLoop.js"
import { PageManager } from "../core/pageManager.js"
import {
	sanitizeSystemConfig,
	buildSlotDefinition,
	PAGE_FACTORIES,
	type SystemConfig,
	type SlotConfig,
	type SlotDefinition,
} from "../core/systemConfig.js"
import {
	listPresets,
	readPreset,
	writePreset,
	deletePreset,
	readActiveConfig,
	writeActiveConfig,
	isValidPresetName,
} from "../core/presetStore.js"
import { createInputDecoder } from "../io/inputDecoder.js"
import { createOsc } from "../io/osc.js"
import { createControlServer, type ControlServer } from "../io/controlServer.js"
import { runRandomSplash, settleFocused } from "../boot/bootSplashes.js"
import type {
	PageContext,
	Slot,
	LedState,
	LedFrame,
	EncId,
} from "../core/types.js"
import {
	SLOT_INDICES,
	slotFromLabel,
	slotLabel,
} from "../core/types.js"
import { clamp } from "../util/scale.js"

// ---- Single-instance guard (before opening any MIDI/OSC ports) ----
// A duplicate launch (e.g. a Max loadbang firing every patch open) detects the
// live instance and exits cleanly. Bypass with TWISTER_ALLOW_MULTI=1.
if (process.env.TWISTER_ALLOW_MULTI !== "1") {
	const lockPath = joinPath(tmpdir(), "twister-manager.lock")
	const lock = tryAcquireLock(lockPath)
	if (!lock.acquired) {
		console.error(
			`[SingleInstance] Already running (pid ${lock.holderPid}). Exiting.`
		)
		process.exit(0)
	}
	const cleanup = () => releaseLock(lockPath)
	process.on("exit", cleanup)
	// Ensure 'exit' (and cleanup) runs on Ctrl-C / kill.
	process.on("SIGINT", () => process.exit(0))
	process.on("SIGTERM", () => process.exit(0))
}

// ---- Port selection via CLI/env (optional but handy) ----
const arg = (name: string) => {
	const i = process.argv.indexOf(name)
	return i > -1 ? process.argv[i + 1] : undefined
}
const inSel = arg("--in") ?? process.env.TWISTER_IN ?? "twister"
const outSel = arg("--out") ?? process.env.TWISTER_OUT ?? "twister"

// Optional web UI (off by default). Enable with --ui or TWISTER_UI=1.
const uiEnabled =
	process.argv.includes("--ui") || process.env.TWISTER_UI === "1"
const uiPort = Number(arg("--ui-port") ?? process.env.TWISTER_UI_PORT ?? 57190)

// ---- MIDI in/out + reconciler ----
let midiIo = new NodeMidiDriver()
console.log("MIDI IN :", midiIo.getInPortName?.() ?? "(unknown)")
console.log("MIDI OUT:", midiIo.getOutPortName?.() ?? "(unknown)")

let rec = new LedReconciler(midiIo)

// Render-loop output state: renderTick() pushes the current desired frame each
// frame; this flag asks the next frame to be a fast focus paint (128-msg burst).
let needsFocusPaint = false

// Optional web UI control server (null when --ui is off).
let controlServer: ControlServer | null = null

// All outbound twister messages go through here: out to OSC/UDP, and mirrored
// to any connected web UI so it can monitor live.
function emitOut(path: string, ...args: Array<number | string | boolean>) {
	osc.send(path, ...args)
	controlServer?.broadcast(path, args)
}

// --- OSC transport (defaults: in 57121, out 57120) ---
const osc = createOsc()
osc.send("/twister/out/hello")

// ---- Base context (resolution must be a literal 128|256|512) ----
type Resolution = PageContext["resolution"]
const resolution: Resolution = 128

const modifiers = {
	shiftLeft: false,
	shiftRight: false,
	globalLeft: false,
	globalRight: false,
}

const baseCtx: Omit<PageContext, "setDirty" | "slot" | "slotLabel"> = {
    modifiers,
    resolution,
    osc: { send: (path, ...args) => emitOut(path, ...args) },
}

// Track focused slot locally so overlay can highlight it
let focusedSlot: Slot = 0

// Overlay state
type OverlayState = {
	active: boolean
	latched: boolean
}

type MainButtonState = {
	pressAt: number
	holdTimer: NodeJS.Timeout | null
	holdActive: boolean
	lastShortPressAt: number
	lastEdgeAt: number
	isDown: boolean
}

const overlayState: OverlayState = {
	active: false,
	latched: false,
}

const mainButtonState: MainButtonState = {
	pressAt: 0,
	holdTimer: null,
	holdActive: false,
	lastShortPressAt: 0,
	lastEdgeAt: 0,
	isDown: false,
}

// Slot colors (use your config if you prefer)
const SLOT_COLOR: Record<Slot, number> = {
	0: 110, // purple
	1: 1, // blue
	2: 60, // green
	3: 66, // yellow
	4: 74, // orange
	5: 80, // red
	6: 33, // cyan
	7: 20, // magenta-ish
}

const SETTINGS_CONFIG_PATH = resolvePath(process.cwd(), "configs/settings.json")
const UI_INDEX_PATH = resolvePath(process.cwd(), "web/index.html")

type Settings = {
	interaction: {
		mainDoubleClickMs: number
		mainHoldThresholdMs: number
		debounceMs: number
	}
	render: {
		fps: number
	}
}

const DEFAULT_SETTINGS: Settings = {
	interaction: {
		mainDoubleClickMs: 320,
		mainHoldThresholdMs: 200,
		debounceMs: 20,
	},
	render: {
		fps: 30,
	},
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

// Load interaction timing overrides, tolerating missing or malformed files.
const loadSettings = (): Settings => {
	let parsed: unknown
	try {
		const raw = readFileSync(SETTINGS_CONFIG_PATH, "utf8")
		parsed = JSON.parse(raw)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code
		if (code && code !== "ENOENT") {
			console.warn("[Settings] Failed to read configs/settings.json:", err)
		}
		return { ...DEFAULT_SETTINGS }
	}

	if (!isRecord(parsed)) return { ...DEFAULT_SETTINGS }

	const interactionNode = isRecord(parsed.interaction)
		? (parsed.interaction as Record<string, unknown>)
		: {}
	const renderNode = isRecord(parsed.render)
		? (parsed.render as Record<string, unknown>)
		: {}

	const cleanNumber = (value: unknown, fallback: number) => {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value
		}
		if (typeof value === "bigint" && value > 0n) {
			return Number(value)
		}
		return fallback
	}

	return {
		interaction: {
			mainDoubleClickMs: cleanNumber(
				interactionNode.mainDoubleClickMs,
				DEFAULT_SETTINGS.interaction.mainDoubleClickMs
			),
			mainHoldThresholdMs: cleanNumber(
				interactionNode.mainHoldThresholdMs,
				DEFAULT_SETTINGS.interaction.mainHoldThresholdMs
			),
			debounceMs: cleanNumber(
				interactionNode.debounceMs,
				DEFAULT_SETTINGS.interaction.debounceMs
			),
		},
		render: {
			fps: clamp(
				cleanNumber(renderNode.fps, DEFAULT_SETTINGS.render.fps),
				1,
				120
			),
		},
	}
}

// Build per-slot page factories from a SystemConfig. Shared by boot and live
// preset apply, so the same sanitize→factory path runs everywhere.
const buildSlotDefinitions = (config: SystemConfig): SlotDefinition[] =>
	SLOT_INDICES.map((slot) => buildSlotDefinition(config.slots[slotLabel(slot)]))

const logSlotSummary = () => {
	const pageSummary = SLOT_INDICES.map(
		(slot, idx) => `${slotLabel(slot)}=${slotDefinitions[idx].pageName}`
	).join(", ")
	const customColorLabels = SLOT_INDICES.filter(
		(_slot, idx) => slotDefinitions[idx].hasCustomColors
	).map((slot) => slotLabel(slot))
	const colorsSummary =
		customColorLabels.length > 0 ? `custom on ${customColorLabels.join(",")}` : "default"
	const customBrightnessLabels = SLOT_INDICES.filter(
		(_slot, idx) => slotDefinitions[idx].hasCustomBrightness
	).map((slot) => slotLabel(slot))
	const brightnessSummary =
		customBrightnessLabels.length > 0
			? `custom on ${customBrightnessLabels.join(",")}`
			: "default"
	console.log(
		`Slots: ${pageSummary} (colors: ${colorsSummary}; brightness: ${brightnessSummary})`
	)
}

// Active system configuration — mirrors configs/slots.json and is mutated live by
// preset load / single-slot edits. slotDefinitions/slotPageNames are caches of it.
let activeConfig: SystemConfig = readActiveConfig()
let slotDefinitions: SlotDefinition[] = buildSlotDefinitions(activeConfig)
let slotPageNames: string[] = slotDefinitions.map((def) => def.pageName)
let activePresetName: string | null = activeConfig.activePreset ?? null
logSlotSummary()

const BASIC_ONLY_PATTERNS = [
	/^\/config\/color\/map$/,
	/^\/config\/color\/enc\/\d{1,2}\/set$/,
	/^\/config\/colorbrightness\/map$/,
	/^\/config\/colorbrightness\/enc\/\d{1,2}\/set$/,
	/^\/dump$/,
] as const

const matchesBasicOnlyPath = (path: string): boolean =>
	BASIC_ONLY_PATTERNS.some((regex) => regex.test(path))

const isBasicSlot = (slot: Slot) => slotPageNames[slot] === "Basic"
const isMorphSlot = (slot: Slot) => slotPageNames[slot] === "Morph"

const allowBasicOnlyRoute = (slot: Slot, subPath: string): boolean => {
	if (!matchesBasicOnlyPath(subPath)) return true
	if (isBasicSlot(slot)) return true
	console.warn(
		`[OSC] Slot ${slotLabel(slot)} (${slotPageNames[slot]}) does not support ${subPath}`
	)
	return false
}

// Mutable so the Global Settings UI can retune timings/fps live (read at use sites).
let settings = loadSettings()

const parseSlotLabel = (value: unknown): Slot | undefined => {
	if (typeof value !== "string") return undefined
	return slotFromLabel(value)
}

function renderOverlay(focus: Slot): LedFrame {
	const mk = (o: Partial<LedState> = {}): LedState => ({
		ring: 0,
		rgb: 110,
		ledBrightness: 0,
		ringBrightness: 31,
		anim: "none",
		...o,
	})

	const frame = {} as LedFrame

	// Initialize all 16 encoders "off"
	for (let i = 0 as EncId; i < 16; i = (i + 1) as EncId) {
		frame[i] = mk()
	}

	// Light encoders 0..7 for slots A..H
	for (const s of SLOT_INDICES) {
		frame[s as EncId] = mk({ rgb: SLOT_COLOR[s], ledBrightness: 5 })
	}

	// Highlight currently focused slot
	frame[focus as EncId] = mk({ rgb: SLOT_COLOR[focus], ledBrightness: 29 })

	return frame
}

// Output is driven by the render loop (see renderTick below), not by direct
// pushes. These helpers just request that the next frame be a fast focus paint;
// renderTick() reads whatever the "current desired" frame is (overlay or page).
function paintOverlay() {
	needsFocusPaint = true
}

function paintFocusedPage() {
	needsFocusPaint = true
}

// The frame the device should currently show: overlay owns the LEDs while active.
function currentDesired(): LedFrame | undefined {
	return overlayState.active ? renderOverlay(focusedSlot) : pm.getDesiredFocused()
}

// One render frame: push the current desired state. The reconciler diffs, so an
// unchanged frame sends zero MIDI; a fast focus paint is requested via the flag.
function renderTick() {
	const frame = currentDesired()
	if (!frame) return
	if (needsFocusPaint) {
		rec.beginFocusPaint()
		needsFocusPaint = false
	}
	rec.push(frame)
}

function clearMainHoldTimer() {
	if (mainButtonState.holdTimer) {
		clearTimeout(mainButtonState.holdTimer)
		mainButtonState.holdTimer = null
	}
}

function activateOverlayMomentary() {
	if (!overlayState.active) {
		overlayState.active = true
		paintOverlay()
	}
	mainButtonState.holdActive = true
}

function deactivateOverlayIfMomentary() {
	mainButtonState.holdActive = false
	if (!overlayState.latched && overlayState.active) {
		overlayState.active = false
		paintFocusedPage()
	}
}

function setOverlayLatch(next: boolean) {
	if (overlayState.latched === next) return
	overlayState.latched = next
	if (overlayState.latched) {
		overlayState.active = true
		paintOverlay()
		console.log("Main latch: ON")
	} else {
		overlayState.active = false
		paintFocusedPage()
		console.log("Main latch: OFF")
	}
}

// ---- Page manager ----
// The page manager keeps each page's desired frame up to date; the render loop
// (renderTick) is the single thing that pushes to the device. The only thing we
// need from this callback is to request a fast focus paint on focus changes.
const pm = new PageManager(baseCtx, (_frame, reason) => {
	if (reason === "focus") needsFocusPaint = true
})

// Fixed-rate render loop: the single output path to the device.
// Reassignable so a live fps change can rebuild the loop (see applyGlobalSettings).
let renderLoop: RenderLoop = createRenderLoop({ fps: settings.render.fps, onFrame: renderTick })

// Load & focus slot A (and remember which)
void (async () => {
	await runRandomSplash(rec)
	SLOT_INDICES.forEach((slot, idx) => {
		pm.load(slot, slotDefinitions[idx].createPage)
	})
	pm.focus(0 as Slot)
	settleFocused(pm, rec)
	// Hand ongoing output to the render loop now that the splash/settle are done.
	needsFocusPaint = true
	renderLoop.start()
	startTwisterWatcher(pm)
})()

// ---- Input: decoder wiring ----
const dec = createInputDecoder()

dec.setShiftInterceptGlobals(false)

// Update modifiers + route encoder events

dec.onEvent((ev) => {
	// Keep modifiers updated
	let routeToPage = false
	switch (ev.type) {
		case "side/shift":
			if (ev.side === "left") modifiers.shiftLeft = ev.down
			else modifiers.shiftRight = ev.down
			routeToPage = true
			break

		case "side/global":
			if (ev.side === "left") {
				modifiers.globalLeft = ev.down
				return
			}

			modifiers.globalRight = ev.down
			const now = Date.now()
			if (
				now - mainButtonState.lastEdgeAt < settings.interaction.debounceMs &&
				ev.down === mainButtonState.isDown
			)
				return
			mainButtonState.lastEdgeAt = now
			mainButtonState.isDown = ev.down

			if (ev.down) {
				mainButtonState.pressAt = now
				mainButtonState.holdActive = false
				clearMainHoldTimer()
				mainButtonState.holdTimer = setTimeout(() => {
					mainButtonState.holdTimer = null
					activateOverlayMomentary()
				}, settings.interaction.mainHoldThresholdMs)
				return
			}

			const pressDuration = now - mainButtonState.pressAt
			clearMainHoldTimer()
			if (pressDuration >= settings.interaction.mainHoldThresholdMs || mainButtonState.holdActive) {
				deactivateOverlayIfMomentary()
				return
			}

			if (overlayState.latched) {
				setOverlayLatch(false)
				mainButtonState.lastShortPressAt = 0
				return
			}

			if (
				mainButtonState.lastShortPressAt &&
				now - mainButtonState.lastShortPressAt <= settings.interaction.mainDoubleClickMs
			) {
				mainButtonState.lastShortPressAt = 0
				setOverlayLatch(true)
				return
			}

			mainButtonState.lastShortPressAt = now
			return

		default:
			break
	}

	// While overlay is active, only handle encoder button presses 0..7
	if (overlayState.active) {
		if (ev.type === "encoder/press" && ev.down && ev.id >= 0 && ev.id <= 7) {
			const s = ev.id as Slot
			focusedSlot = s
			pm.focus(s)
			emitOut("/twister/out/focus/page", slotLabel(s))
			// repaint overlay to update highlight; pageManager's repaint is suppressed by the guard
			paintOverlay()
		}
		// Swallow all other events while overlay is up
		return
	}

	// Normal routed events when overlay is not active
	if (routeToPage || ev.type === "encoder/turn" || ev.type === "encoder/press") {
		pm.onEvent(ev)
	}
})

// Translate raw MIDI (from NodeMidiDriver) to decoder messages
midiIo.onMessage((msg) => dec.pushRaw(msg))
console.log(
	'Daemon up. Using port "Midi Fighter Twister". Twist & press to test.'
)

// --- Presets & global settings -----------------------------------------------

// Push current preset list + active marker to all listeners.
function broadcastPresetState() {
	emitOut("/twister/out/preset/list", ...listPresets())
	emitOut("/twister/out/preset/active", activePresetName ?? "")
}

// Apply a SystemConfig live, reloading the given slots' pages (default: all, for
// preset load). A single-slot edit passes only that slot so the other pages keep
// their live runtime state. Reloaded pages re-emit their /type on init, so no
// separate type broadcast is needed. Honors R10 — no direct device push; we set
// needsFocusPaint and let the loop flush.
function applySystemConfig(
	config: SystemConfig,
	opts: { persist?: boolean; presetName?: string | null; reloadSlots?: readonly Slot[] } = {}
) {
	activeConfig = sanitizeSystemConfig(config)
	slotDefinitions = buildSlotDefinitions(activeConfig)
	slotPageNames = slotDefinitions.map((def) => def.pageName)
	const reload = opts.reloadSlots ?? SLOT_INDICES
	for (const slot of reload) pm.load(slot, slotDefinitions[slot].createPage)
	if (reload.includes(focusedSlot)) needsFocusPaint = true
	logSlotSummary()

	if (opts.persist) {
		activePresetName = opts.presetName ?? null
		activeConfig.activePreset = activePresetName
		writeActiveConfig(activeConfig)
		emitOut("/twister/out/preset/active", activePresetName ?? "")
	}
}

// Snapshot the live interface (soft capture: structural config, not knob/step values).
function captureSystemConfig(): SystemConfig {
	const slots = {} as Record<ReturnType<typeof slotLabel>, SlotConfig>
	for (const slot of SLOT_INDICES) {
		const label = slotLabel(slot)
		const config = pm.serialize(slot)
		slots[label] = config !== undefined ? { page: slotPageNames[slot], config } : { page: slotPageNames[slot] }
	}
	return sanitizeSystemConfig({ version: 1, slots })
}

function persistSettings(s: Settings) {
	try {
		writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify(s, null, "\t")}\n`)
	} catch (err) {
		console.warn("[Settings] Failed to write configs/settings.json:", err)
	}
}

// Apply global settings live: persist, rebuild the render loop if fps changed.
function applyGlobalSettings(next: Settings) {
	const fpsChanged = next.render.fps !== settings.render.fps
	settings = next
	persistSettings(next)
	if (fpsChanged) {
		renderLoop.stop()
		renderLoop = createRenderLoop({ fps: settings.render.fps, onFrame: renderTick })
		needsFocusPaint = true
		renderLoop.start()
	}
	emitOut("/twister/out/settings", JSON.stringify(settings))
}

function setSettingsKey(key: string, rawValue: unknown) {
	const value = Number(rawValue)
	if (!Number.isFinite(value)) return
	const next: Settings = {
		interaction: { ...settings.interaction },
		render: { ...settings.render },
	}
	switch (key) {
		case "mainDoubleClickMs":
		case "mainHoldThresholdMs":
		case "debounceMs":
			next.interaction[key] = clamp(Math.round(value), 1, 5000)
			break
		case "fps":
			next.render.fps = clamp(Math.round(value), 1, 120)
			break
		default:
			return
	}
	applyGlobalSettings(next)
}

// Shared control router: both OSC input and the web UI dispatch through this,
// so they speak one vocabulary (the /twister/in/... paths).
function routeControl(path: string, args: any[]) {
	// /twister/in/focus/page <a..h>
	if (path === "/twister/in/focus/page") {
		const slot = parseSlotLabel(args[0])
		if (slot !== undefined) {
			focusedSlot = slot
			pm.focus(slot)
			emitOut("/twister/out/focus/page", slotLabel(slot))
			if (overlayState.active) paintOverlay()
		}
		return
	}
	// /twister/in/clock <int> → broadcast to all pages (StepSeq uses this)
	if (path === "/twister/in/clock") {
		for (const slot of SLOT_INDICES) {
			pm.routeOscToPage(slot, path, args)
		}
		return
	}
	// /twister/in/dump/global → request dumps from pages that support /dump
	// (Basic: palette/values; Morph: scene vectors).
	if (path === "/twister/in/dump/global") {
		for (const slot of SLOT_INDICES) {
			if (isBasicSlot(slot) || isMorphSlot(slot)) pm.routeOscToPage(slot, "/dump", [])
		}
		return
	}
	// --- Presets ---
	if (path === "/twister/in/preset/list") {
		broadcastPresetState()
		return
	}
	if (path === "/twister/in/preset/save") {
		const name = args[0]
		if (isValidPresetName(name)) {
			const captured = captureSystemConfig()
			if (writePreset(name, captured)) {
				// Active config now equals the saved snapshot.
				activeConfig = captured
				activePresetName = name
				activeConfig.activePreset = name
				writeActiveConfig(activeConfig)
				broadcastPresetState()
			}
		}
		return
	}
	if (path === "/twister/in/preset/load") {
		const name = args[0]
		if (isValidPresetName(name)) {
			const cfg = readPreset(name)
			if (cfg) applySystemConfig(cfg, { persist: true, presetName: name })
		}
		broadcastPresetState()
		return
	}
	if (path === "/twister/in/preset/delete") {
		const name = args[0]
		if (isValidPresetName(name)) {
			deletePreset(name)
			if (activePresetName === name) {
				activePresetName = null
				activeConfig.activePreset = null
				writeActiveConfig(activeConfig)
			}
		}
		broadcastPresetState()
		return
	}
	// --- Single-slot live page re-assign: /twister/in/slot/<a-h>/page <PageName> ---
	const slotPageMatch = path.match(/^\/twister\/in\/slot\/([a-hA-H])\/page$/)
	if (slotPageMatch) {
		const slot = slotFromLabel(slotPageMatch[1])
		const pageName = args[0]
		if (slot !== undefined && typeof pageName === "string" && PAGE_FACTORIES[pageName]) {
			const nextSlots = { ...activeConfig.slots, [slotLabel(slot)]: { page: pageName } }
			// Reload only this slot so the other pages keep their live runtime state.
			applySystemConfig(
				{ version: 1, slots: nextSlots },
				{ persist: true, presetName: null, reloadSlots: [slot] }
			)
		}
		return
	}
	// --- Global settings ---
	if (path === "/twister/in/settings/get") {
		emitOut("/twister/out/settings", JSON.stringify(settings))
		return
	}
	if (path === "/twister/in/settings/set") {
		if (typeof args[0] === "string") setSettingsKey(args[0], args[1])
		return
	}
	// /twister/in/page/<slot>/...
	const m = path.match(/^\/twister\/in\/page\/([a-hA-H])\/(.+)$/)
	if (m) {
		const slot = slotFromLabel(m[1])
		if (slot !== undefined) {
			const sub = `/${m[2]}` // pass the remainder to the page
			if (allowBasicOnlyRoute(slot, sub)) pm.routeOscToPage(slot, sub, args)
		}
		return
	}
}

// OSC input → shared router
osc.onMessage((path, args) => routeControl(path, args))

// Optional web UI: same router for inbound, mirrored OSC-out for monitoring.
if (uiEnabled) {
	controlServer = createControlServer({
		port: uiPort,
		staticFile: UI_INDEX_PATH,
		onMessage: routeControl,
		onConnect: (send) => {
			// Snapshot so a late-joining UI reflects current state immediately.
			send("/twister/out/focus/page", [slotLabel(focusedSlot)])
			for (const slot of SLOT_INDICES) {
				send(`/twister/out/page/${slotLabel(slot)}/type`, [slotPageNames[slot]])
			}
			send("/twister/out/preset/list", listPresets())
			send("/twister/out/preset/active", [activePresetName ?? ""])
			send("/twister/out/settings", [JSON.stringify(settings)])
		},
	})
}

console.log("Daemon up: MIDI+OSC live. In: 57121  Out: 57120")
console.log(
	"Try: focus → /twister/in/focus/page a   | set → /twister/in/page/a/index/0/set 0.5"
)

async function rebuildIoAndSplash(pm: PageManager) {
	// Pause the render loop so it doesn't fight the splash for the new device.
	renderLoop.stop()
	try {
		midiIo.close()
	} catch {
		// ignore close errors; device may already be gone
	}
	midiIo = new NodeMidiDriver()
	rec = new LedReconciler(midiIo)
	midiIo.onMessage((msg) => dec.pushRaw(msg))
	await runRandomSplash(rec)
	settleFocused(pm, rec)
	// Resume steady-state output; first frame repaints with the new reconciler.
	needsFocusPaint = true
	renderLoop.start()
}

function startTwisterWatcher(pm: PageManager) {
	const intervalMs = 1500
	const match = "midi fighter twister"

	const hasTwisterOutput = (): boolean => {
		const out = new midiLib.Output()
		try {
			const count = out.getPortCount()
			for (let i = 0; i < count; i++) {
				const name = out.getPortName(i)
				if (name.toLowerCase().includes(match)) return true
			}
			return false
		} catch {
			return false
		} finally {
			try {
				out.closePort()
			} catch {
				// nothing was opened
			}
		}
	}

	let previousPresent = hasTwisterOutput()
	let pollInFlight = false

	const check = async () => {
		if (pollInFlight) return
		pollInFlight = true
		try {
			const present = hasTwisterOutput()
			if (!previousPresent && present) {
				console.log("[Hotplug] Twister reconnected → splash")
				await rebuildIoAndSplash(pm)
			}
			previousPresent = present
		} finally {
			pollInFlight = false
		}
	}

	setInterval(() => {
		void check()
	}, intervalMs)
}
