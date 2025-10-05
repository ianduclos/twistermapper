// src/cli/index.ts
import { NullMidi } from "../io/midiDriver.js";
import { LedReconciler } from "../render/ledReconciler.js";
import { PageManager } from "../core/pageManager.js";
import { BasicPage } from "../pages/basic.js";
// MIDI (noop for now — swap for NodeMidiDriver when ready)
const midi = new NullMidi();
const rec = new LedReconciler(midi);
const resolution = 128;
const baseCtx = {
    modifiers: {
        shiftLeft: false,
        shiftRight: false,
        globalLeft: false,
        globalRight: false,
    },
    resolution,
    osc: { send: (..._args) => { } },
};
// Push LED frames automatically whenever the focused page changes
const pm = new PageManager(baseCtx, (frame, reason) => {
    if (reason === "focus")
        rec.beginFocusPaint();
    rec.push(frame);
});
// Load BasicPage into slot A (0) and focus it (triggers initial paint)
pm.load(0, BasicPage);
pm.focus(0);
console.log("Twister daemon running with BasicPage on slot A (0).");
