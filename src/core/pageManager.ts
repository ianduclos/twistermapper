/* Task: Complete PageManager focus/routing
Spec: /src/Architecture.md — sections: "Pages & focus", "OSC"

Acceptance Criteria:
- load(slot, factory): disposes existing page; calls init(ctx); stores initial desired frame via render().
- focus(slot): calls onBlur() on previous; set new focused; call onFocus(); refresh desired for focused via render().
- onEvent(ev): deliver ONLY to focused page; after onEvent, refresh desired for focused via render().
- routeOscToPage(slot, path, args): if page has onOsc, call it; if slot is focused, refresh desired via render().
- getDesiredFocused(): returns latest LedFrame | undefined.
- Keep ctx reference as provided; do not mutate ctx shape.
*/

import {
	Page,
	LedFrame,
	InputEvent,
	PageContext,
	Slot,
	SlotLabel,
	OnFrame,
} from "./types.js"

const SLOTS: readonly Slot[] = [0, 1, 2, 3] as const
const LABELS: readonly SlotLabel[] = ["a", "b", "c", "d"] as const

export class PageManager {
	private pages: (Page | null)[] = [null, null, null, null]
	private desired: (LedFrame | undefined)[] = [
		undefined,
		undefined,
		undefined,
		undefined,
	]
	private focused: 0 | 1 | 2 | 3 = 0

	// We keep a separate ctx per slot so setDirty knows who called.
	private ctxPerSlot: PageContext[] = []
	private onFrame?: OnFrame

	constructor(
		baseCtx: Omit<PageContext, "setDirty" | "slot" | "slotLabel">,
		onFrame?: OnFrame
	) {
		this.onFrame = onFrame

		for (const slot of SLOTS) {
			this.ctxPerSlot[slot] = {
				...baseCtx,
				slot,
				slotLabel: LABELS[slot],
				setDirty: () => {
					const p = this.pages[slot]
					if (!p) return
					const frame = p.render(this.ctxPerSlot[slot])
					this.desired[slot] = frame ?? this.desired[slot]
					if (slot === this.focused && this.onFrame)
						this.onFrame(this.desired[slot], "dirty")
				},
			}
		}
	}

	load(slot: 0 | 1 | 2 | 3, factory: () => Page) {
		this.pages[slot]?.dispose()
		const p = factory()
		this.pages[slot] = p
		p.init(this.ctxPerSlot[slot])
		this.desired[slot] = p.render(this.ctxPerSlot[slot])
		// no push here unless it's focused; keep device quiet
		if (slot === this.focused && this.onFrame)
			this.onFrame(this.desired[slot], "event")
	}

	focus(slot: 0 | 1 | 2 | 3) {
		if (slot === this.focused) return
		this.pages[this.focused]?.onBlur(this.ctxPerSlot[this.focused])
		this.focused = slot
		this.pages[slot]?.onFocus(this.ctxPerSlot[slot])
		this.desired[slot] = this.pages[slot]?.render(this.ctxPerSlot[slot])
		if (this.onFrame) this.onFrame(this.desired[slot], "focus")
	}

	onEvent(ev: InputEvent) {
		const p = this.pages[this.focused]
		if (!p) return
		p.onEvent(ev, this.ctxPerSlot[this.focused])
		const frame = p.render(this.ctxPerSlot[this.focused])
		this.desired[this.focused] = frame ?? this.desired[this.focused]
		if (this.onFrame) this.onFrame(this.desired[this.focused], "event")
	}

	routeOscToPage(slot: 0 | 1 | 2 | 3, path: string, args: any[]) {
		const p = this.pages[slot]
		if (!p?.onOsc) return
		p.onOsc(path, args, this.ctxPerSlot[slot])
		const frame = p.render(this.ctxPerSlot[slot])
		this.desired[slot] = frame ?? this.desired[slot]
		if (slot === this.focused && this.onFrame)
			this.onFrame(this.desired[slot], "osc")
	}

	getDesiredFocused(): LedFrame | undefined {
		return this.desired[this.focused]
	}
}
