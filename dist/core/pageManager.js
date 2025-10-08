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
const SLOTS = [0, 1, 2, 3];
const LABELS = ["a", "b", "c", "d"];
export class PageManager {
    pages = [null, null, null, null];
    desired = [
        undefined,
        undefined,
        undefined,
        undefined,
    ];
    focused = 0;
    // We keep a separate ctx per slot so setDirty knows who called.
    ctxPerSlot = [];
    onFrame;
    constructor(baseCtx, onFrame) {
        this.onFrame = onFrame;
        for (const slot of SLOTS) {
            this.ctxPerSlot[slot] = {
                ...baseCtx,
                slot,
                slotLabel: LABELS[slot],
                setDirty: () => {
                    const p = this.pages[slot];
                    if (!p)
                        return;
                    const frame = p.render(this.ctxPerSlot[slot]);
                    this.desired[slot] = frame ?? this.desired[slot];
                    if (slot === this.focused && this.onFrame)
                        this.onFrame(this.desired[slot], "dirty");
                },
            };
        }
    }
    load(slot, factory) {
        this.pages[slot]?.dispose();
        const p = factory();
        this.pages[slot] = p;
        p.init(this.ctxPerSlot[slot]);
        this.desired[slot] = p.render(this.ctxPerSlot[slot]);
        // no push here unless it's focused; keep device quiet
        if (slot === this.focused && this.onFrame)
            this.onFrame(this.desired[slot], "event");
    }
    focus(slot) {
        if (slot === this.focused)
            return;
        this.pages[this.focused]?.onBlur(this.ctxPerSlot[this.focused]);
        this.focused = slot;
        this.pages[slot]?.onFocus(this.ctxPerSlot[slot]);
        this.desired[slot] = this.pages[slot]?.render(this.ctxPerSlot[slot]);
        if (this.onFrame)
            this.onFrame(this.desired[slot], "focus");
    }
    onEvent(ev) {
        const p = this.pages[this.focused];
        if (!p)
            return;
        p.onEvent(ev, this.ctxPerSlot[this.focused]);
        const frame = p.render(this.ctxPerSlot[this.focused]);
        this.desired[this.focused] = frame ?? this.desired[this.focused];
        if (this.onFrame)
            this.onFrame(this.desired[this.focused], "event");
    }
    routeOscToPage(slot, path, args) {
        const p = this.pages[slot];
        if (!p?.onOsc)
            return;
        p.onOsc(path, args, this.ctxPerSlot[slot]);
        const frame = p.render(this.ctxPerSlot[slot]);
        this.desired[slot] = frame ?? this.desired[slot];
        if (slot === this.focused && this.onFrame)
            this.onFrame(this.desired[slot], "osc");
    }
    getDesiredFocused() {
        return this.desired[this.focused];
    }
}
