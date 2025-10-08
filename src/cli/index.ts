// src/cli/index.ts
import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import midiLib from "@julusian/midi"
import { NodeMidiDriver } from "../io/midiDriver.js" // real driver from Codex task
import { LedReconciler } from "../render/ledReconciler.js"
import { PageManager } from "../core/pageManager.js"
import { BasicPage } from "../pages/basic.js"
import { GesturePage } from "../pages/gestures.js"
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

// --- OSC transport (defaults: in 57121, out 57120) ---
const osc = createOsc()

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
}

const DEFAULT_SETTINGS: Settings = {
	interaction: {
		mainDoubleClickMs: 320,
		mainHoldThresholdMs: 200,
		debounceMs: 20,
	},
}

type SlotDefinition = {
	pageName: string
	createPage: () => Page
	hasCustomColors: boolean
	hasCustomBrightness: boolean
}

type PageFactory = (config?: BasicPageConfig) => Page

const PAGE_FACTORIES: Record<string, PageFactory> = {
	Basic: (config?: BasicPageConfig) => BasicPage(config),
	Gesture: () => GesturePage(),
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
		let encoderColors: number[] | undefined
		let encoderBrightness: number[] | undefined
		if (pageName === "Basic") {
			const configNode =
				entry && isRecord(entry.config)
					? (entry.config as Record<string, unknown>)
					: undefined
			encoderColors = sanitizeEncoderColors(configNode?.encoderColors)
			hasCustomColors = encoderColors !== undefined
			encoderBrightness = sanitizeEncoderBrightness(configNode?.encoderBrightness)
			hasCustomBrightness = encoderBrightness !== undefined
		}

		const createPage = () => {
			if (pageName === "Basic") {
				const cfg: BasicPageConfig | undefined = encoderColors || encoderBrightness
					? {
						encoderColors: encoderColors ? [...encoderColors] : undefined,
						encoderBrightness: encoderBrightness
							? [...encoderBrightness]
							: undefined,
					}
					: undefined
				return BasicPage(cfg)
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

const BASIC_ONLY_SUB_PATHS = new Set<string>([
	"/config/encoderColors",
	"/config/encoderColor",
	"/dump",
])

const isBasicSlot = (slot: Slot) => slotPageNames[slot] === "Basic"

const allowBasicOnlyRoute = (slot: Slot, subPath: string): boolean => {
	if (!BASIC_ONLY_SUB_PATHS.has(subPath)) return true
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

const parseSlotInput = (value: unknown): Slot | undefined => {
	if (typeof value === "number" && Number.isInteger(value)) {
		const idx = value as number
		return idx >= 0 && idx < SLOT_INDICES.length ? SLOT_INDICES[idx] : undefined
	}
	if (typeof value === "string") {
		const lower = value.toLowerCase()
		if (/^\d+$/.test(lower)) {
			return parseSlotInput(Number(lower))
		}
		return slotFromLabel(lower)
	}
	return undefined
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

function paintOverlay() {
	rec.beginFocusPaint()
	rec.push(renderOverlay(focusedSlot))
}

function paintFocusedPage() {
	rec.beginFocusPaint()
	rec.push(pm.getDesiredFocused())
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

// ---- Page manager: guard pushes while overlay is active ----
const pm = new PageManager(baseCtx, (frame, reason) => {
	if (overlayState.active) return // overlay owns the LEDs
	if (reason === "focus") rec.beginFocusPaint()
	rec.push(frame)
})

// Load & focus slot A (and remember which)
void (async () => {
	await runRandomSplash(rec)
	SLOT_INDICES.forEach((slot, idx) => {
		pm.load(slot, slotDefinitions[idx].createPage)
	})
	pm.focus(0 as Slot)
	settleFocused(pm, rec)
	startTwisterWatcher(pm)
})()

// ---- Input: decoder wiring ----
const dec = createInputDecoder()

dec.setShiftInterceptGlobals(false)

// Update modifiers + route encoder events

dec.onEvent((ev) => {
	// Keep modifiers updated
	switch (ev.type) {
		case "side/shift":
			if (ev.side === "left") modifiers.shiftLeft = ev.down
			else modifiers.shiftRight = ev.down
			return

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
	if (ev.type === "encoder/turn" || ev.type === "encoder/press") {
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
	// /twister_in/focus {0..7 | a..h}
	if (path === "/twister_in/focus") {
		const slot = parseSlotInput(args[0])
		if (slot !== undefined) {
			focusedSlot = slot
			pm.focus(slot)
			if (overlayState.active) paintOverlay()
		}
		return
	}
	// /twister_in/clock 1   (reserved; no clock logic yet)
	if (path === "/twister_in/clock") {
		// you could fan this out to pages later
		return
	}
	// /twister_in/page_{a|...|h}/...
	const m = path.match(/^\/twister_in\/page_([a-hA-H])\/(.+)$/)
	if (m) {
		const slot = slotFromLabel(m[1])
		if (slot !== undefined) {
			const sub = `/` + m[2] // pass the remainder to the page
			if (allowBasicOnlyRoute(slot, sub)) pm.routeOscToPage(slot, sub, args)
		}
		return
	}
})

console.log("Daemon up: MIDI+OSC live. In: 57121  Out: 57120")
console.log(
	"Try: focus → /twister_in/focus a   | set → /twister_in/page_a/set/0 0.5"
)

async function rebuildIoAndSplash(pm: PageManager) {
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
	if (overlayState.active) paintOverlay()
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
