export type EncId =
	| 0
	| 1
	| 2
	| 3
	| 4
	| 5
	| 6
	| 7
	| 8
	| 9
	| 10
	| 11
	| 12
	| 13
	| 14
	| 15

export type InputEvent =
	| { type: "encoder/turn"; id: EncId; delta: number; shift: boolean }
	| { type: "encoder/press"; id: EncId; down: boolean; shift: boolean }
	| { type: "side/shift"; side: "left" | "right"; down: boolean }
	| { type: "side/global"; side: "left" | "right"; down: boolean }

export type LedAnim = "none" | "pulse"
export interface LedState {
	ring: number
	rgb: number
	ledBrightness: number
	ringBrightness: number
	anim: LedAnim
}
export type LedFrame = Record<EncId, LedState>

export interface PageContext {
	modifiers: {
		shiftLeft: boolean
		shiftRight: boolean
		globalLeft: boolean
		globalRight: boolean
	}
	resolution: 128 | 256 | 512
	osc: {
		send: (path: string, ...args: Array<number | string | boolean>) => void
	}
	slot: Slot
	slotLabel: SlotLabel
	setDirty: () => void
}

export interface Page {
	init(ctx: PageContext): void
	onFocus(ctx: PageContext): void
	onBlur(ctx: PageContext): void
	onEvent(ev: InputEvent, ctx: PageContext): void
	onOsc?(path: string, args: any[], ctx: PageContext): void
	render(ctx: PageContext): LedFrame | undefined
	/**
	 * Return this page's structural config (e.g. color palette, clock routing) for
	 * capturing into a preset, or undefined if the page has no config. Must NOT
	 * include transient runtime values (encoder positions, sequencer steps, playhead).
	 */
	serialize?(): unknown
	dispose(): void
}

export type Slot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
export type SlotLabel = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h"

export const SLOT_INDICES: readonly Slot[] = [0, 1, 2, 3, 4, 5, 6, 7] as const
export const SLOT_LABELS: readonly SlotLabel[] = [
	"a",
	"b",
	"c",
	"d",
	"e",
	"f",
	"g",
	"h",
] as const

export const slotLabel = (slot: Slot): SlotLabel => SLOT_LABELS[slot]

export const slotFromLabel = (label: string): Slot | undefined => {
	const lower = label.toLowerCase()
	const idx = SLOT_LABELS.findIndex((entry) => entry === lower)
	if (idx === -1) return undefined
	return SLOT_INDICES[idx]
}

export type OnFrameReason = "event" | "osc" | "dirty" | "focus"

export type OnFrame = (
	frame: LedFrame | undefined,
	reason: OnFrameReason
) => void
