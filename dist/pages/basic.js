/* Task: Implement BasicPage (values 0..127, brightness bump on press)
Spec: /src/Architecture.md — section "BasicPage (reference page)" and "OSC"

Acceptance Criteria:
- Internal: 16 integer values 0..127; default 0.
- onEvent('encoder/turn'): vals[id] += delta * (128 / ctx.resolution); clamp 0..127.
- onEvent('encoder/press'): while down => ledBrightness=10 for that encoder; on release => restore 5.
- render(): returns LedFrame if any state changed since last render; otherwise undefined.
- OSC out: on value change, send `/twister_out/slot_a/{id} {normalized float <= 5 dp}` (use ctx.osc.send).
- Optional OSC in: `/twister_in/slot_a/set/{id} {normalized float}` sets value (clamped).
- Do not import MIDI here; only express desired LED state.
*/
import { clamp, toFixedN } from "../util/scale.js";
export function BasicPage() {
    const vals = new Uint8Array(16);
    const pressed = new Array(16).fill(false);
    let dirty = true;
    const frame = () => {
        const out = {};
        for (let i = 0; i < 16; i++) {
            const enc = i;
            out[enc] = {
                ring: vals[i],
                rgb: 110,
                ledBrightness: pressed[i] ? 10 : 5,
                ringBrightness: 31, // full indicator brightness (human)
                anim: "none",
            };
        }
        return out;
    };
    return {
        init(ctx) {
            for (let i = 0; i < 16; i++) {
                vals[i] = 0;
                pressed[i] = false;
            }
            dirty = true;
        },
        onFocus() {
            dirty = true;
        },
        onBlur() { },
        onEvent(ev, ctx) {
            if (ev.type === "encoder/turn") {
                const step = 128 / ctx.resolution;
                const prev = vals[ev.id];
                const delta = Math.round(ev.delta * step);
                if (delta !== 0) {
                    const next = clamp(prev + delta, 0, 127);
                    if (next !== prev) {
                        vals[ev.id] = next;
                        dirty = true;
                        ctx.osc.send(`/twister_out/slot_a/${ev.id}`, toFixedN(next / 127, 5));
                    }
                }
            }
            if (ev.type === "encoder/press") {
                if (pressed[ev.id] !== ev.down) {
                    pressed[ev.id] = ev.down;
                    dirty = true;
                }
            }
        },
        onOsc(path, args, ctx) {
            // Optional: /twister_in/slot_a/set/{id} {normFloat}
            const m = path.match(/\/set\/(\d{1,2})$/);
            if (m) {
                const id = Number(m[1]) | 0;
                const v = Number(args[0]);
                if (id >= 0 && id < 16 && Number.isFinite(v)) {
                    const next = clamp(Math.round(v * 127), 0, 127);
                    if (vals[id] !== next) {
                        vals[id] = next;
                        dirty = true;
                    }
                }
            }
        },
        render(ctx) {
            if (!dirty)
                return;
            dirty = false;
            return frame();
        },
        dispose() { },
    };
}
