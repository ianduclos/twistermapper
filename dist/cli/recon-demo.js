import { LedReconciler } from "../render/ledReconciler.js";
import { FakeMidi } from "../util/fakeMidi.js";
const mk = (over = {}) => ({
    ring: 0,
    rgb: 110,
    ledBrightness: 5,
    ringBrightness: 31,
    anim: "none",
    ...over,
});
const frame = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, mk()]));
frame[0] = mk({ ledBrightness: 7, ringBrightness: 20, rgb: 74, ring: 64 });
const midi = new FakeMidi();
const rec = new LedReconciler(midi);
rec.push(frame);
console.log(midi.calls.slice(0, 4)); // should be ['ledB:0:7','ringB:0:20','rgb:0:74','ring:0:64']
