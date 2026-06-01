// src/cli/index.ts
import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import midiLib from "@julusian/midi"
import { NodeMidiDriver } from "../io/midiDriver.js" // real driver from Codex task
import { LedReconciler } from "../render/ledReconciler.js"
import { createRenderLoop } from "../render/renderLoop.js"
import { PageManager } from "../core/pageManager.js"
import { BasicPage } from "../pages/basic.js"
import { GesturePage } from "../pages/gestures.js"
import { StepSeqPage } from "../pages/stepSeq.js"
import { createInputDecoder } from "../io/inputDecoder.js"
import { createOsc } from "../io/osc.js"
import { runRandomSplash, settleFocused } from "../boot/bootSplashes.js"
import type {
	Page,
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
import type { BasicPageConfig } from "../pages/basic.js"
import type { StepSeqConfig } from "../pages/stepSeq.js"
import { clamp } from "../util/scale.js"

// ---- Port selection via CLI/env (optional but handy) ----
const arg = (name: string) => {
	const i = process.argv.indexOf(name)
	return i > -1 ? process.argv[i + 1] : undefined
}
const inSel = arg("--in") ?? process.env.TWISTER_IN ?? "twister"
const outSel = arg("--out") ?? process.env.TWISTER_OUT ?? "twister"

// ---- MIDI in/out + reconciler ----
let midiIo = new NodeMidiDriver()
console.log("MIDI IN :", midiIo.getInPortName?.() ?? "(unknown)")
console.log("MIDI OUT:", midiIo.getOutPortName?.() ?? "(unknown)")

let rec = new LedReconciler(midiIo)

// Render-loop output state: renderTick() pushes the current desired frame each
// frame; this flag asks the next frame to be a fast focus paint (128-msg burst).
let needsFocusPaint = false

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
    osc: { send: (path, ...args) => osc.send(path, ...args) },
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

const SLOTS_CONFIG_PATH = resolvePath(process.cwd(), "configs/slots.json")
const SETTINGS_CONFIG_PATH = resolvePath(process.cwd(), "configs/settings.json")
const DEFAULT_PAGE_NAME = "Basic"
const DEFAULT_ENCODER_COLOR = 110
const DEFAULT_BRIGHTNESS = 5

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

type SlotDefinition = {
	pageName: string
	createPage: () => Page
	hasCustomColors: boolean
	hasCustomBrightness: boolean
}

type PageFactory = (config?: unknown) => Page

const PAGE_FACTORIES: Record<string, PageFactory> = {
	Basic: (config?: unknown) => BasicPage(config as BasicPageConfig | undefined),
	Gesture: () => GesturePage(),
	StepSeq: (config?: unknown) => StepSeqPage(config as StepSeqConfig | undefined),
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

// Expect an array-like palette; fallback to defaults while clamping into device range.
const sanitizeEncoderColors = (raw: unknown): number[] | undefined => {
	if (!Array.isArray(raw)) return undefined
	const out: number[] = []
	for (let i = 0; i < 16; i++) {
		const val = raw[i]
		let numeric: number
		if (typeof val === "number" && Number.isFinite(val)) {
			numeric = val
		} else if (typeof val === "bigint") {
			numeric = Number(val)
		} else {
			numeric = DEFAULT_ENCODER_COLOR
		}
		out.push(clamp(Math.round(numeric), 1, 126))
	}
	return out
}

// Accept optional per-encoder brightness array (human 0..29).
const sanitizeEncoderBrightness = (raw: unknown): number[] | undefined => {
	if (!Array.isArray(raw)) return undefined
	const out: number[] = []
	for (let i = 0; i < 16; i++) {
		const val = raw[i]
		let numeric: number
		if (typeof val === "number" && Number.isFinite(val)) {
			numeric = val
		} else if (typeof val === "bigint") {
			numeric = Number(val)
		} else {
			numeric = DEFAULT_BRIGHTNESS
		}
		out.push(clamp(Math.round(numeric), 0, 29))
	}
	return out
}

const STEPSEQ_TRACK_COUNT = 4
const DEFAULT_STEPSEQ_CLOCK_IDS = [0] as const

const sanitizeClockIdList = (value: unknown): number[] => {
	const arr = Array.isArray(value) ? value : value === undefined ? undefined : [value]
	if (!arr) return [...DEFAULT_STEPSEQ_CLOCK_IDS]
	const ids: number[] = []
	for (const item of arr) {
		const n = Math.round(Number(item))
		if (!Number.isFinite(n)) continue
		const clamped = clamp(n, 0, 5)
		if (!ids.includes(clamped)) ids.push(clamped)
	}
	if (!ids.length) return [...DEFAULT_STEPSEQ_CLOCK_IDS]
	ids.sort((a, b) => a - b)
	return ids
}

const arraysEqual = (a: number[], b: readonly number[]) =>
	a.length === b.length && a.every((v, i) => v === b[i])

const sanitizeStepSeqConfig = (raw: unknown): StepSeqConfig | undefined => {
	if (!isRecord(raw)) return undefined
	const tracksValue = (raw as Record<string, unknown>)["tracks"]
	const tracksRaw = Array.isArray(tracksValue) ? tracksValue : []
	let custom = false
	const tracks: StepSeqConfig["tracks"] = Array.from({ length: STEPSEQ_TRACK_COUNT }, (_, idx) => {
		const node = isRecord(tracksRaw[idx]) ? (tracksRaw[idx] as Record<string, unknown>) : undefined
		const clockIds = sanitizeClockIdList(node?.["clockIds"])
		if (!arraysEqual(clockIds, DEFAULT_STEPSEQ_CLOCK_IDS)) custom = true
		return { clockIds }
	})
	return custom ? { tracks } : undefined
}

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

const loadSlotDefinitions = (): SlotDefinition[] => {
	const defaults = SLOT_INDICES.map<SlotDefinition>(() => ({
		pageName: DEFAULT_PAGE_NAME,
		createPage: () => BasicPage(),
		hasCustomColors: false,
		hasCustomBrightness: false,
	}))

	let parsed: unknown
	try {
		const raw = readFileSync(SLOTS_CONFIG_PATH, "utf8")
		parsed = JSON.parse(raw)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code
		if (code && code !== "ENOENT") {
			console.warn("[Slots] Failed to read configs/slots.json:", err)
		}
		return defaults
	}

	if (!isRecord(parsed)) return defaults

	const slotsNode = isRecord(parsed.slots) ? (parsed.slots as Record<string, unknown>) : {}
	const result: SlotDefinition[] = []

	for (const slot of SLOT_INDICES) {
		const label = slotLabel(slot)
		const entry = isRecord(slotsNode[label]) ? slotsNode[label] : undefined
		const rawPageName =
			entry && typeof entry.page === "string" ? entry.page : DEFAULT_PAGE_NAME
		const factory = PAGE_FACTORIES[rawPageName] ?? PAGE_FACTORIES[DEFAULT_PAGE_NAME]
		const pageName = factory === PAGE_FACTORIES[rawPageName] ? rawPageName : DEFAULT_PAGE_NAME
		if (factory !== PAGE_FACTORIES[rawPageName]) {
			console.warn(
				`[Slots] Slot ${label}: unknown page "${rawPageName}", defaulting to ${DEFAULT_PAGE_NAME}`
			)
		}

		let hasCustomColors = false
		let hasCustomBrightness = false
		let pageConfig: unknown
		if (pageName === "Basic") {
			const configNode =
				entry && isRecord(entry.config)
					? (entry.config as Record<string, unknown>)
					: undefined
			const encoderColors = sanitizeEncoderColors(configNode?.encoderColors)
			hasCustomColors = encoderColors !== undefined
			const encoderBrightness = sanitizeEncoderBrightness(configNode?.encoderBrightness)
			hasCustomBrightness = encoderBrightness !== undefined
			pageConfig =
				encoderColors || encoderBrightness
					? {
						encoderColors: encoderColors ? [...encoderColors] : undefined,
						encoderBrightness: encoderBrightness
							? [...encoderBrightness]
							: undefined,
					}
					: undefined
		} else if (pageName === "StepSeq") {
			const configNode =
				entry && isRecord(entry.config)
					? (entry.config as Record<string, unknown>)
					: undefined
			pageConfig = sanitizeStepSeqConfig(configNode)
		}

		const createPage = () => {
			if (pageName === "Basic") {
				return factory(pageConfig)
			}
			if (pageName === "StepSeq") {
				const cfg = pageConfig as StepSeqConfig | undefined
				return factory(
					cfg
						? {
							tracks: cfg.tracks?.map((t) => ({
								clockIds: t.clockIds ? [...t.clockIds] : undefined,
							})),
						}
						: undefined
				)
			}
			return factory()
		}

		result.push({
			pageName,
			createPage,
			hasCustomColors,
			hasCustomBrightness,
		})
	}

	return result
}

const slotDefinitions = loadSlotDefinitions()
const slotPageNames = slotDefinitions.map((def) => def.pageName)
const pageSummary = SLOT_INDICES.map(
	(slot, idx) => `${slotLabel(slot)}=${slotDefinitions[idx].pageName}`
).join(", ")
const customColorLabels = SLOT_INDICES.filter(
	(slot, idx) => slotDefinitions[idx].hasCustomColors
).map((slot) => slotLabel(slot))
const colorsSummary =
	customColorLabels.length > 0
		? `custom on ${customColorLabels.join(",")}`
		: "default"

const customBrightnessLabels = SLOT_INDICES.filter(
	(slot, idx) => slotDefinitions[idx].hasCustomBrightness
).map((slot) => slotLabel(slot))
const brightnessSummary =
	customBrightnessLabels.length > 0
		? `custom on ${customBrightnessLabels.join(",")}`
		: "default"

console.log(
	`Slots: ${pageSummary} (colors: ${colorsSummary}; brightness: ${brightnessSummary})`
)

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

const allowBasicOnlyRoute = (slot: Slot, subPath: string): boolean => {
	if (!matchesBasicOnlyPath(subPath)) return true
	if (isBasicSlot(slot)) return true
	console.warn(
		`[OSC] Slot ${slotLabel(slot)} (${slotPageNames[slot]}) does not support ${subPath}`
	)
	return false
}

const settings = loadSettings()
const {
	mainDoubleClickMs,
	mainHoldThresholdMs,
	debounceMs,
} = settings.interaction

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
const renderLoop = createRenderLoop({ fps: settings.render.fps, onFrame: renderTick })

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
			if (now - mainButtonState.lastEdgeAt < debounceMs && ev.down === mainButtonState.isDown)
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
				}, mainHoldThresholdMs)
				return
			}

			const pressDuration = now - mainButtonState.pressAt
			clearMainHoldTimer()
			if (pressDuration >= mainHoldThresholdMs || mainButtonState.holdActive) {
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
				now - mainButtonState.lastShortPressAt <= mainDoubleClickMs
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

// OSC input → core routes
osc.onMessage((path, args) => {
	// /twister/in/focus/page <a..h>
	if (path === "/twister/in/focus/page") {
		const slot = parseSlotLabel(args[0])
		if (slot !== undefined) {
			focusedSlot = slot
			pm.focus(slot)
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
	// /twister/in/dump/global → request palette/value dumps from Basic pages
	if (path === "/twister/in/dump/global") {
		for (const slot of SLOT_INDICES) {
			if (isBasicSlot(slot)) pm.routeOscToPage(slot, "/dump", [])
		}
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
})

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
