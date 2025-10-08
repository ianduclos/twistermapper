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
	dispose(): void
}

export type Slot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
export type SlotLabel = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h"

export type OnFrameReason = "event" | "osc" | "dirty" | "focus"

export type OnFrame = (
	frame: LedFrame | undefined,
	reason: OnFrameReason
) => void
