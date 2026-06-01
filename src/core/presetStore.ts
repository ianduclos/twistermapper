/* Preset store: filesystem layer for named system configurations.
 *
 * Presets are interface-only SystemConfigs (slot→page + per-page config), one
 * JSON file per preset under configs/presets/<name>.json. The active config lives
 * in configs/slots.json (the single "what's loaded now"). All reads pass through
 * sanitizeSystemConfig so malformed/partial files degrade gracefully.
 *
 * Names are restricted to a safe filename charset so a preset name can later map
 * directly to a Max patch name without path-traversal risk.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from "node:fs"
import { resolve as resolvePath, join as joinPath } from "node:path"
import {
	sanitizeSystemConfig,
	defaultSystemConfig,
	type SystemConfig,
} from "./systemConfig.js"

const CONFIGS_DIR = resolvePath(process.cwd(), "configs")
const PRESETS_DIR = joinPath(CONFIGS_DIR, "presets")
const SLOTS_PATH = joinPath(CONFIGS_DIR, "slots.json")

const NAME_RE = /^[A-Za-z0-9 _-]{1,48}$/

/** True if `name` is a safe preset name (no path separators, sane length). */
export const isValidPresetName = (name: unknown): name is string =>
	typeof name === "string" && NAME_RE.test(name)

const presetPath = (name: string) => joinPath(PRESETS_DIR, `${name}.json`)

const stringify = (config: SystemConfig) => `${JSON.stringify(config, null, "\t")}\n`

/** List preset names (file basenames), sorted; tolerant of a missing dir. */
export const listPresets = (): string[] => {
	let entries: string[]
	try {
		entries = readdirSync(PRESETS_DIR)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code
		if (code && code !== "ENOENT") console.warn("[Presets] Failed to list presets:", err)
		return []
	}
	return entries
		.filter((f) => f.toLowerCase().endsWith(".json"))
		.map((f) => f.slice(0, -5))
		.filter(isValidPresetName)
		.sort((a, b) => a.localeCompare(b))
}

/** Read & sanitize a preset; null if missing/invalid name/unreadable. */
export const readPreset = (name: string): SystemConfig | null => {
	if (!isValidPresetName(name)) return null
	try {
		const raw = readFileSync(presetPath(name), "utf8")
		const cfg = sanitizeSystemConfig(JSON.parse(raw))
		delete cfg.activePreset // preset files are pure interface; no active marker
		return cfg
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code
		if (code && code !== "ENOENT") console.warn(`[Presets] Failed to read "${name}":`, err)
		return null
	}
}

/** Write a preset file (interface only; strips any activePreset marker). Returns success. */
export const writePreset = (name: string, config: SystemConfig): boolean => {
	if (!isValidPresetName(name)) return false
	const clean = sanitizeSystemConfig(config)
	delete clean.activePreset
	try {
		mkdirSync(PRESETS_DIR, { recursive: true })
		writeFileSync(presetPath(name), stringify(clean))
		return true
	} catch (err) {
		console.warn(`[Presets] Failed to write "${name}":`, err)
		return false
	}
}

/** Delete a preset file. Returns true if it existed and was removed. */
export const deletePreset = (name: string): boolean => {
	if (!isValidPresetName(name)) return false
	try {
		unlinkSync(presetPath(name))
		return true
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code
		if (code && code !== "ENOENT") console.warn(`[Presets] Failed to delete "${name}":`, err)
		return false
	}
}

/** Read & sanitize the active config (slots.json); falls back to all-default. */
export const readActiveConfig = (): SystemConfig => {
	try {
		const raw = readFileSync(SLOTS_PATH, "utf8")
		return sanitizeSystemConfig(JSON.parse(raw))
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code
		if (code && code !== "ENOENT") console.warn("[Slots] Failed to read configs/slots.json:", err)
		return defaultSystemConfig()
	}
}

/** Persist the active config to slots.json (includes the activePreset marker). */
export const writeActiveConfig = (config: SystemConfig): boolean => {
	const clean = sanitizeSystemConfig(config)
	clean.activePreset = config.activePreset ?? null
	try {
		mkdirSync(CONFIGS_DIR, { recursive: true })
		writeFileSync(SLOTS_PATH, stringify(clean))
		return true
	} catch (err) {
		console.warn("[Slots] Failed to write configs/slots.json:", err)
		return false
	}
}
