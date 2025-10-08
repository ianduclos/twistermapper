/* Task: Implement BasicPage (values 0..127, brightness bump on press)
Spec: /src/Architecture.md — section "BasicPage (reference page)" and "OSC"

Acceptance Criteria:
- Internal: 16 integer values 0..127; default 0.
- onEvent('encoder/turn'): vals[id] += delta * (128 / ctx.resolution); clamp 0..127.
- onEvent('encoder/press'): while down => ledBrightness=10 for that encoder; on release => restore 5.
- render(): returns LedFrame if any state changed since last render; otherwise undefined.
- OSC out: on value change, send `/twister_out/page_a {id} {normalized float <= 5 dp}` (use ctx.osc.send).
- Optional OSC in: `/twister_in/page_a/set/{id} {normalized float}` sets value (clamped).
- Do not import MIDI here; only express desired LED state.
*/
import { clamp, toFixedN, to127 } from "../util/scale.js";
const DEFAULT_COLOR = 110;
const DEFAULT_BRIGHTNESS = 5;
const PRESSED_BRIGHTNESS = 29;
const COLOR_MIN = 1;
const COLOR_MAX = 126;
const BRIGHTNESS_MIN = 0;
const BRIGHTNESS_MAX = 29;
export function BasicPage(config) {
    const vals = new Int16Array(16); // 0..127
    const pressed = new Array(16).fill(false);
    const colors = new Array(16).fill(DEFAULT_COLOR);
    const baseBrightness = new Array(16).fill(DEFAULT_BRIGHTNESS);
    const initialColorSource = config?.encoderColors;
    const initialBrightnessSource = config?.encoderBrightness;
    let dirty = true;
    const clampColor = (value) => {
        if (typeof value === "number" && Number.isFinite(value)) {
            return clamp(Math.round(value), COLOR_MIN, COLOR_MAX);
        }
        if (typeof value === "bigint") {
            return clamp(Number(value), COLOR_MIN, COLOR_MAX);
        }
        return DEFAULT_COLOR;
    };
    const applyEncoderColors = (input) => {
        const src = Array.isArray(input) ? input : [];
        let changed = false;
        for (let i = 0; i < 16; i++) {
            const next = clampColor(src[i]);
            if (colors[i] !== next) {
                colors[i] = next;
                changed = true;
            }
        }
        return changed;
    };
    const clampBrightness = (value) => {
        if (typeof value === "number" && Number.isFinite(value)) {
            return clamp(Math.round(value), BRIGHTNESS_MIN, BRIGHTNESS_MAX);
        }
        if (typeof value === "bigint") {
            return clamp(Number(value), BRIGHTNESS_MIN, BRIGHTNESS_MAX);
        }
        return DEFAULT_BRIGHTNESS;
    };
    const applyEncoderBrightness = (input) => {
        const src = Array.isArray(input) ? input : [];
        let changed = false;
        for (let i = 0; i < 16; i++) {
            const next = clampBrightness(src[i]);
            if (baseBrightness[i] !== next) {
                baseBrightness[i] = next;
                changed = true;
            }
        }
        return changed;
    };
    const updateSingleColor = (encId, value) => {
        if (!Number.isInteger(encId) || encId < 0 || encId > 15)
            return false;
        const next = clampColor(value);
        if (colors[encId] === next)
            return false;
        colors[encId] = next;
        return true;
    };
    const sendDump = (ctx) => {
        const colorPayload = colors.map((c) => c);
        const valuePayload = Array.from(vals, (v) => toFixedN(v / 127, 5));
        ctx.osc.send(`/twister_out/page_${ctx.slotLabel}/encoderColors`, ...colorPayload);
        ctx.osc.send(`/twister_out/page_${ctx.slotLabel}/allvalues`, ...valuePayload);
    };
    const frame = () => {
        const out = {};
        for (let i = 0; i < 16; i++) {
            out[i] = {
                ring: to127(vals[i]),
                rgb: colors[i],
                ledBrightness: pressed[i] ? PRESSED_BRIGHTNESS : baseBrightness[i],
                ringBrightness: 31,
                anim: "none",
            };
        }
        return out;
    };
    return {
        init() {
            for (let i = 0; i < 16; i++)
                vals[i] = 0;
            applyEncoderColors(initialColorSource);
            applyEncoderBrightness(initialBrightnessSource);
            dirty = true;
        },
        onFocus() {
            dirty = true;
        },
        onBlur() { },
        onEvent(ev, ctx) {
            if (ev.type === "encoder/turn") {
                const step = 128 / ctx.resolution;
                vals[ev.id] = clamp(vals[ev.id] + Math.round(ev.delta * step), 0, 127);
                // OSC out: /twister_out/page_{a..h} {id} {0..1}
                ctx.osc.send(`/twister_out/page_${ctx.slotLabel}`, ev.id, toFixedN(vals[ev.id] / 127, 5));
                dirty = true;
            }
            if (ev.type === "encoder/press") {
                pressed[ev.id] = ev.down;
                dirty = true;
            }
        },
        onOsc(path, args, ctx) {
            if (path === "/config/encoderColors") {
                const changed = applyEncoderColors(args);
                if (changed) {
                    dirty = true;
                    ctx.setDirty();
                }
                return;
            }
            if (path === "/config/encoderColor") {
                const encId = Number(args[0]);
                const color = args[1];
                if (updateSingleColor(encId, color)) {
                    dirty = true;
                    ctx.setDirty();
                }
                return;
            }
            if (path === "/dump") {
                sendDump(ctx);
                return;
            }
            // /twister_in/page_{x}/set/{id} {normFloat}
            const m = path.match(/\/set\/(\d{1,2})$/);
            if (m) {
                const id = Number(m[1]) | 0;
                const v = Number(args[0]);
                if (id >= 0 && id < 16 && Number.isFinite(v)) {
                    vals[id] = clamp(Math.round(v * 127), 0, 127);
                    // Also emit OSC out so external clients see the update
                    ctx.osc.send(`/twister_out/page_${ctx.slotLabel}`, id, toFixedN(vals[id] / 127, 5));
                    dirty = true;
                }
            }
        },
        render() {
            if (!dirty)
                return;
            dirty = false;
            return frame();
        },
        dispose() { },
    };
}
