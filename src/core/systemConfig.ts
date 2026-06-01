/* System configuration: the whole-machine interface layout.
 *
 * A SystemConfig describes which page each slot (a–h) runs and that page's
 * structural config (Basic colors/brightness, StepSeq clock routing). It is the
 * shape of configs/slots.json AND of every preset under configs/presets/.
 *
 * This module is the single place that knows how to:
 *   - sanitize raw JSON into a clean SystemConfig (clamp/tolerate per CLAUDE.md), and
 *   - build a runnable page factory (SlotDefinition) from a slot's config.
 *
 * It runs both at boot (cli/index.ts) and at runtime when a preset is applied, so
 * the same validation path is shared everywhere. Device humanization stays in the
 * driver; this only deals in human-readable config values.
 */

import { BasicPage, type BasicPageConfig } from "../pages/basic.js"
import { GesturePage } from "../pages/gestures.js"
import { MorphPage } from "../pages/morph.js"
import { StepSeqPage, type StepSeqConfig } from "../pages/stepSeq.js"
import { clamp } from "../util/scale.js"
import {
	SLOT_INDICES,
	slotLabel,
	type Page,
	type SlotLabel,
} from "./types.js"

export type SlotConfig = {
	page: string
	config?: unknown
}

export type SystemConfig = {
	version: 1
	slots: Record<SlotLabel, SlotConfig>
	/** Name of the preset this config came from, or null if custom/unsaved. Only meaningful in slots.json. */
	activePreset?: string | null
}

export type SlotDefinition = {
	pageName: string
	createPage: () => Page
	hasCustomColors: boolean
	hasCustomBrightness: boolean
}

export const DEFAULT_PAGE_NAME = "Basic"
const DEFAULT_ENCODER_COLOR = 110
const DEFAULT_BRIGHTNESS = 5

type PageFactory = (config?: unknown) => Page

export const PAGE_FACTORIES: Record<string, PageFactory> = {
	Basic: (config?: unknown) => BasicPage(config as BasicPageConfig | undefined),
	Gesture: () => GesturePage(),
	Morph: () => MorphPage(),
	StepSeq: (config?: unknown) => StepSeqPage(config as StepSeqConfig | undefined),
}

/** Page names the UI/protocol may assign to a slot. */
export const PAGE_NAMES = Object.keys(PAGE_FACTORIES)

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

// Expect an array-like palette; undefined when absent. Clamp into device range.
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

/** Resolve a raw page name to a known one, logging when it falls back. */
const resolvePageName = (raw: unknown, slotForLog?: SlotLabel): string => {
	const name = typeof raw === "string" ? raw : DEFAULT_PAGE_NAME
	if (PAGE_FACTORIES[name]) return name
	if (slotForLog) {
		console.warn(
			`[Slots] Slot ${slotForLog}: unknown page "${name}", defaulting to ${DEFAULT_PAGE_NAME}`
		)
	}
	return DEFAULT_PAGE_NAME
}

/**
 * Normalize a single slot's per-page config into its canonical shape and report
 * whether it carries custom colors/brightness (used for log summaries).
 */
const sanitizePageConfig = (
	pageName: string,
	rawConfig: unknown
): { config?: unknown; hasCustomColors: boolean; hasCustomBrightness: boolean } => {
	if (pageName === "Basic") {
		const node = isRecord(rawConfig) ? rawConfig : undefined
		const encoderColors = sanitizeEncoderColors(node?.encoderColors)
		const encoderBrightness = sanitizeEncoderBrightness(node?.encoderBrightness)
		const config =
			encoderColors || encoderBrightness
				? {
					encoderColors: encoderColors ? [...encoderColors] : undefined,
					encoderBrightness: encoderBrightness ? [...encoderBrightness] : undefined,
				}
				: undefined
		return {
			config,
			hasCustomColors: encoderColors !== undefined,
			hasCustomBrightness: encoderBrightness !== undefined,
		}
	}
	if (pageName === "StepSeq") {
		return {
			config: sanitizeStepSeqConfig(isRecord(rawConfig) ? rawConfig : undefined),
			hasCustomColors: false,
			hasCustomBrightness: false,
		}
	}
	return { config: undefined, hasCustomColors: false, hasCustomBrightness: false }
}

/** Sanitize raw parsed JSON (slots.json or a preset file) into a clean SystemConfig. */
export const sanitizeSystemConfig = (raw: unknown): SystemConfig => {
	const root = isRecord(raw) ? raw : {}
	const slotsNode = isRecord(root.slots) ? (root.slots as Record<string, unknown>) : {}
	const slots = {} as Record<SlotLabel, SlotConfig>

	for (const slot of SLOT_INDICES) {
		const label = slotLabel(slot)
		const entry = isRecord(slotsNode[label]) ? (slotsNode[label] as Record<string, unknown>) : undefined
		const pageName = resolvePageName(entry?.page, label)
		const { config } = sanitizePageConfig(pageName, entry?.config)
		slots[label] = config !== undefined ? { page: pageName, config } : { page: pageName }
	}

	const activePreset =
		typeof root.activePreset === "string"
			? root.activePreset
			: root.activePreset === null
				? null
				: undefined

	const out: SystemConfig = { version: 1, slots }
	if (activePreset !== undefined) out.activePreset = activePreset
	return out
}

/** Build a runnable page factory from a single (sanitized) slot config. */
export const buildSlotDefinition = (slot: SlotConfig): SlotDefinition => {
	const pageName = resolvePageName(slot.page)
	const { config, hasCustomColors, hasCustomBrightness } = sanitizePageConfig(pageName, slot.config)
	const factory = PAGE_FACTORIES[pageName] ?? PAGE_FACTORIES[DEFAULT_PAGE_NAME]

	const createPage = () => {
		if (pageName === "Basic") return factory(config)
		if (pageName === "StepSeq") {
			const cfg = config as StepSeqConfig | undefined
			return factory(
				cfg
					? { tracks: cfg.tracks?.map((t) => ({ clockIds: t.clockIds ? [...t.clockIds] : undefined })) }
					: undefined
			)
		}
		return factory()
	}

	return { pageName, createPage, hasCustomColors, hasCustomBrightness }
}

/** A SystemConfig where every slot runs the default page (used as a safe fallback). */
export const defaultSystemConfig = (): SystemConfig => {
	const slots = {} as Record<SlotLabel, SlotConfig>
	for (const slot of SLOT_INDICES) slots[slotLabel(slot)] = { page: DEFAULT_PAGE_NAME }
	return { version: 1, slots }
}
