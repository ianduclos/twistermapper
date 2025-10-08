// src/cli/index.ts
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import midiLib from "@julusian/midi";
import { NodeMidiDriver } from "../io/midiDriver.js"; // real driver from Codex task
import { LedReconciler } from "../render/ledReconciler.js";
import { PageManager } from "../core/pageManager.js";
import { BasicPage } from "../pages/basic.js";
import { createInputDecoder } from "../io/inputDecoder.js";
import { createOsc } from "../io/osc.js";
import { runRandomSplash, settleFocused } from "../boot/bootSplashes.js";
import { SLOT_INDICES, slotFromLabel, slotLabel, } from "../core/types.js";
import { clamp } from "../util/scale.js";
// ---- Port selection via CLI/env (optional but handy) ----
const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : undefined;
};
const inSel = arg("--in") ?? process.env.TWISTER_IN ?? "twister";
const outSel = arg("--out") ?? process.env.TWISTER_OUT ?? "twister";
// ---- MIDI in/out + reconciler ----
let midiIo = new NodeMidiDriver();
console.log("MIDI IN :", midiIo.getInPortName?.() ?? "(unknown)");
console.log("MIDI OUT:", midiIo.getOutPortName?.() ?? "(unknown)");
let rec = new LedReconciler(midiIo);
// --- OSC transport (defaults: in 57121, out 57120) ---
const osc = createOsc();
const resolution = 128;
const modifiers = {
    shiftLeft: false,
    shiftRight: false,
    globalLeft: false,
    globalRight: false,
};
const baseCtx = {
    modifiers,
    resolution,
    osc: { send: (path, ...args) => osc.send(path, ...args) },
};
// Track focused slot locally so overlay can highlight it
let focusedSlot = 0;
// Overlay state
let overlayActive = false;
let overlayLatched = false;
let pendingUnlock = false; // set when main pressed without shift while latched
// Slot colors (use your config if you prefer)
const SLOT_COLOR = {
    0: 110, // purple
    1: 1, // blue
    2: 60, // green
    3: 66, // yellow
    4: 74, // orange
    5: 80, // red
    6: 33, // cyan
    7: 20, // magenta-ish
};
const SLOTS_CONFIG_PATH = resolvePath(process.cwd(), "configs/slots.json");
const DEFAULT_PAGE_NAME = "Basic";
const DEFAULT_ENCODER_COLOR = 110;
const PAGE_FACTORIES = {
    Basic: (config) => BasicPage(config),
};
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const sanitizeEncoderColors = (raw) => {
    if (!Array.isArray(raw))
        return undefined;
    const out = [];
    for (let i = 0; i < 16; i++) {
        const val = raw[i];
        let numeric;
        if (typeof val === "number" && Number.isFinite(val)) {
            numeric = val;
        }
        else if (typeof val === "bigint") {
            numeric = Number(val);
        }
        else {
            numeric = DEFAULT_ENCODER_COLOR;
        }
        out.push(clamp(Math.round(numeric), 1, 126));
    }
    return out;
};
const loadSlotDefinitions = () => {
    const defaults = SLOT_INDICES.map(() => ({
        pageName: DEFAULT_PAGE_NAME,
        createPage: () => BasicPage(),
        hasCustomColors: false,
    }));
    let parsed;
    try {
        const raw = readFileSync(SLOTS_CONFIG_PATH, "utf8");
        parsed = JSON.parse(raw);
    }
    catch (err) {
        const code = err?.code;
        if (code && code !== "ENOENT") {
            console.warn("[Slots] Failed to read configs/slots.json:", err);
        }
        return defaults;
    }
    if (!isRecord(parsed))
        return defaults;
    const slotsNode = isRecord(parsed.slots) ? parsed.slots : {};
    const result = [];
    for (const slot of SLOT_INDICES) {
        const label = slotLabel(slot);
        const entry = isRecord(slotsNode[label]) ? slotsNode[label] : undefined;
        const rawPageName = entry && typeof entry.page === "string" ? entry.page : DEFAULT_PAGE_NAME;
        const factory = PAGE_FACTORIES[rawPageName] ?? PAGE_FACTORIES[DEFAULT_PAGE_NAME];
        const pageName = factory === PAGE_FACTORIES[rawPageName] ? rawPageName : DEFAULT_PAGE_NAME;
        if (factory !== PAGE_FACTORIES[rawPageName]) {
            console.warn(`[Slots] Slot ${label}: unknown page "${rawPageName}", defaulting to ${DEFAULT_PAGE_NAME}`);
        }
        let hasCustomColors = false;
        let encoderColors;
        if (pageName === "Basic") {
            const configNode = entry && isRecord(entry.config)
                ? entry.config
                : undefined;
            if (Array.isArray(configNode?.encoderColors)) {
                hasCustomColors = true;
            }
            encoderColors = sanitizeEncoderColors(configNode?.encoderColors);
        }
        const createPage = () => {
            if (pageName === "Basic") {
                const cfg = encoderColors
                    ? { encoderColors: [...encoderColors] }
                    : undefined;
                return BasicPage(cfg);
            }
            return factory();
        };
        result.push({
            pageName,
            createPage,
            hasCustomColors,
        });
    }
    return result;
};
const slotDefinitions = loadSlotDefinitions();
const slotPageNames = slotDefinitions.map((def) => def.pageName);
const pageSummary = SLOT_INDICES.map((slot, idx) => `${slotLabel(slot)}=${slotDefinitions[idx].pageName}`).join(", ");
const customColorLabels = SLOT_INDICES.filter((slot, idx) => slotDefinitions[idx].hasCustomColors).map((slot) => slotLabel(slot));
const colorsSummary = customColorLabels.length > 0
    ? `custom on ${customColorLabels.join(",")}`
    : "default";
console.log(`Slots: ${pageSummary} (colors: ${colorsSummary})`);
const parseSlotInput = (value) => {
    if (typeof value === "number" && Number.isInteger(value)) {
        const idx = value;
        return idx >= 0 && idx < SLOT_INDICES.length ? SLOT_INDICES[idx] : undefined;
    }
    if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (/^\d+$/.test(lower)) {
            return parseSlotInput(Number(lower));
        }
        return slotFromLabel(lower);
    }
    return undefined;
};
function renderOverlay(focus) {
    const mk = (o = {}) => ({
        ring: 0,
        rgb: 110,
        ledBrightness: 0,
        ringBrightness: 31,
        anim: "none",
        ...o,
    });
    const frame = {};
    // Initialize all 16 encoders "off"
    for (let i = 0; i < 16; i = (i + 1)) {
        frame[i] = mk();
    }
    // Light encoders 0..7 for slots A..H
    for (const s of SLOT_INDICES) {
        frame[s] = mk({ rgb: SLOT_COLOR[s], ledBrightness: 5 });
    }
    // Highlight currently focused slot
    frame[focus] = mk({ rgb: SLOT_COLOR[focus], ledBrightness: 29 });
    return frame;
}
function paintOverlay() {
    rec.beginFocusPaint();
    rec.push(renderOverlay(focusedSlot));
}
function paintFocusedPage() {
    rec.beginFocusPaint();
    rec.push(pm.getDesiredFocused());
}
// ---- Page manager: guard pushes while overlay is active ----
const pm = new PageManager(baseCtx, (frame, reason) => {
    if (overlayActive)
        return; // overlay owns the LEDs
    if (reason === "focus")
        rec.beginFocusPaint();
    rec.push(frame);
});
// Load & focus slot A (and remember which)
void (async () => {
    await runRandomSplash(rec);
    SLOT_INDICES.forEach((slot, idx) => {
        pm.load(slot, slotDefinitions[idx].createPage);
    });
    pm.focus(0);
    settleFocused(pm, rec);
    startTwisterWatcher(pm);
})();
// ---- Input: decoder wiring ----
const dec = createInputDecoder();
dec.setShiftInterceptGlobals(false);
// Update modifiers + route encoder events
dec.onEvent((ev) => {
    // Keep modifiers updated
    switch (ev.type) {
        case "side/shift":
            if (ev.side === "left")
                modifiers.shiftLeft = ev.down;
            else
                modifiers.shiftRight = ev.down;
            return;
        case "side/global":
            if (ev.side === "left") {
                modifiers.globalLeft = ev.down;
                return;
            }
            // Right global (overlay control)
            modifiers.globalRight = ev.down;
            if (ev.down) {
                if (modifiers.shiftRight && !overlayLatched) {
                    // LOCK overlay
                    overlayLatched = true;
                    overlayActive = true;
                    pendingUnlock = false;
                    paintOverlay();
                }
                else if (!modifiers.shiftRight) {
                    if (overlayLatched) {
                        // Prepare to UNLOCK on release
                        pendingUnlock = true;
                        // keep overlayActive true; repaint not needed
                    }
                    else if (!overlayActive) {
                        // Momentary overlay
                        overlayActive = true;
                        paintOverlay();
                    }
                }
            }
            else {
                // Button released
                if (pendingUnlock) {
                    // UNLOCK now
                    pendingUnlock = false;
                    overlayLatched = false;
                    overlayActive = false;
                    paintFocusedPage();
                }
                else if (!overlayLatched && overlayActive) {
                    // End momentary overlay
                    overlayActive = false;
                    paintFocusedPage();
                }
            }
            return;
        default:
            break;
    }
    // While overlay is active, only handle encoder button presses 0..7
    if (overlayActive) {
        if (ev.type === "encoder/press" && ev.down && ev.id >= 0 && ev.id <= 7) {
            const s = ev.id;
            focusedSlot = s;
            pm.focus(s);
            // repaint overlay to update highlight; pageManager's repaint is suppressed by the guard
            paintOverlay();
        }
        // Swallow all other events while overlay is up
        return;
    }
    // Normal routed events when overlay is not active
    if (ev.type === "encoder/turn" || ev.type === "encoder/press") {
        pm.onEvent(ev);
    }
});
// Translate raw MIDI (from NodeMidiDriver) to decoder messages
midiIo.onMessage((msg) => dec.pushRaw(msg));
console.log('Daemon up. Using port "Midi Fighter Twister". Twist & press to test.');
// OSC input → core routes
osc.onMessage((path, args) => {
    // /twister_in/focus {0..7 | a..h}
    if (path === "/twister_in/focus") {
        const slot = parseSlotInput(args[0]);
        if (slot !== undefined) {
            focusedSlot = slot;
            pm.focus(slot);
            if (overlayActive)
                paintOverlay();
        }
        return;
    }
    // /twister_in/clock 1   (reserved; no clock logic yet)
    if (path === "/twister_in/clock") {
        // you could fan this out to pages later
        return;
    }
    // /twister_in/page_{a|...|h}/...
    const m = path.match(/^\/twister_in\/page_([a-hA-H])\/(.+)$/);
    if (m) {
        const slot = slotFromLabel(m[1]);
        if (slot !== undefined) {
            const sub = `/` + m[2]; // pass the remainder to the page
            if ((sub === "/config/encoderColors" ||
                sub === "/config/encoderColor" ||
                sub === "/dump") &&
                slotPageNames[slot] !== "Basic") {
                const label = slotLabel(slot);
                console.warn(`[OSC] Slot ${label} (${slotPageNames[slot]}) does not support ${sub}`);
                return;
            }
            pm.routeOscToPage(slot, sub, args);
        }
        return;
    }
});
console.log("Daemon up: MIDI+OSC live. In: 57121  Out: 57120");
console.log("Try: focus → /twister_in/focus a   | set → /twister_in/page_a/set/0 0.5");
async function rebuildIoAndSplash(pm) {
    try {
        midiIo.close();
    }
    catch {
        // ignore close errors; device may already be gone
    }
    midiIo = new NodeMidiDriver();
    rec = new LedReconciler(midiIo);
    midiIo.onMessage((msg) => dec.pushRaw(msg));
    await runRandomSplash(rec);
    settleFocused(pm, rec);
    if (overlayActive)
        paintOverlay();
}
function startTwisterWatcher(pm) {
    const intervalMs = 1500;
    const match = "midi fighter twister";
    const hasTwisterOutput = () => {
        const out = new midiLib.Output();
        try {
            const count = out.getPortCount();
            for (let i = 0; i < count; i++) {
                const name = out.getPortName(i);
                if (name.toLowerCase().includes(match))
                    return true;
            }
            return false;
        }
        catch {
            return false;
        }
        finally {
            try {
                out.closePort();
            }
            catch {
                // nothing was opened
            }
        }
    };
    let previousPresent = hasTwisterOutput();
    let pollInFlight = false;
    const check = async () => {
        if (pollInFlight)
            return;
        pollInFlight = true;
        try {
            const present = hasTwisterOutput();
            if (!previousPresent && present) {
                console.log("[Hotplug] Twister reconnected → splash");
                await rebuildIoAndSplash(pm);
            }
            previousPresent = present;
        }
        finally {
            pollInFlight = false;
        }
    };
    setInterval(() => {
        void check();
    }, intervalMs);
}
