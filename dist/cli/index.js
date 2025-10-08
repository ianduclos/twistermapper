// src/cli/index.ts
import midiLib from "@julusian/midi";
import { NodeMidiDriver } from "../io/midiDriver.js"; // real driver from Codex task
import { LedReconciler } from "../render/ledReconciler.js";
import { PageManager } from "../core/pageManager.js";
import { BasicPage } from "../pages/basic.js";
import { GesturePage } from "../pages/gestures.js";
import { createInputDecoder } from "../io/inputDecoder.js";
import { createOsc } from "../io/osc.js";
import { runRandomSplash, settleFocused } from "../boot/bootSplashes.js";
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
};
const SLOTS = [0, 1, 2, 3];
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
    // Light encoders 0..3 for slots A..D
    for (const s of SLOTS) {
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
    pm.load(0, BasicPage);
    pm.load(1, GesturePage);
    pm.load(2, BasicPage);
    pm.load(3, GesturePage);
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
    // While overlay is active, only handle encoder button presses 0..3
    if (overlayActive) {
        if (ev.type === "encoder/press" && ev.down && ev.id >= 0 && ev.id <= 3) {
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
    // /twister_in/focus 0..3
    if (path === "/twister_in/focus") {
        const s = Number(args[0]);
        if (s >= 0 && s <= 3)
            pm.focus(s);
        return;
    }
    // /twister_in/clock 1   (reserved; no clock logic yet)
    if (path === "/twister_in/clock") {
        // you could fan this out to pages later
        return;
    }
    // /twister_in/slot_{a|b|c|d}/...
    const m = path.match(/^\/twister_in\/slot_([abcd])\/(.+)$/);
    if (m) {
        const letter = m[1];
        const slot = (letter === "a" ? 0 : letter === "b" ? 1 : letter === "c" ? 2 : 3);
        const sub = `/` + m[2]; // pass the remainder to the page
        pm.routeOscToPage(slot, sub, args);
        return;
    }
});
console.log("Daemon up: MIDI+OSC live. In: 57121  Out: 57120");
console.log("Try: focus → /twister_in/focus 0   | set → /twister_in/slot_a/set/0 0.5");
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
