// src/cli/raw-midi-probe.ts
import midi from "@julusian/midi";
const DEVICE = "Midi Fighter Twister"; // exact, case-insensitive
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findPort(out, want) {
    const lower = want.toLowerCase();
    let exact = -1, partial = -1;
    for (let i = 0; i < out.getPortCount(); i++) {
        const name = out.getPortName(i);
        const n = name.toLowerCase();
        if (n === lower)
            exact = i;
        if (partial === -1 && n.includes(lower))
            partial = i;
        console.log(`[PORT ${i}] ${name}`);
    }
    if (exact !== -1)
        return exact;
    if (partial !== -1)
        return partial;
    throw new Error(`No port matching "${want}" found.`);
}
function cc(statusCC, enc, value) {
    return [statusCC, enc & 0x7f, value & 0x7f];
}
;
(async () => {
    const out = new midi.Output();
    const idx = findPort(out, DEVICE);
    console.log(`Opening OUTPUT port ${idx}…`);
    out.openPort(idx);
    // Twister channels (zero-based)
    const CH_RING_LEVEL = 0; // ring value (0..127)
    const CH_RGB_NOTE = 2; // note velocity selects color (1..126)
    const CH_PARAMS = 3; // LED/Ring brightness + pulse anim
    const S_CC_RING = 0xb0 | CH_RING_LEVEL;
    const S_CC_PARAMS = 0xb0 | CH_PARAMS;
    const S_NOTE_RGB = 0x90 | CH_RGB_NOTE;
    const enc = 0;
    console.log("— Big obvious test on encoder 0 —");
    // set RGB purple (110)
    out.sendMessage([S_NOTE_RGB, enc, 110]);
    // ring value to 0, then 96
    out.sendMessage(cc(S_CC_RING, enc, 0));
    await sleep(200);
    out.sendMessage(cc(S_CC_RING, enc, 96));
    // LED under-knob brightness: 18..47  (we use 5 -> 23, then 29 -> 47)
    console.log("LED under brightness 5 → 29…");
    out.sendMessage(cc(S_CC_PARAMS, enc, 18 + 5)); // 23
    await sleep(200);
    out.sendMessage(cc(S_CC_PARAMS, enc, 18 + 29)); // 47
    // Ring brightness: 65..95 (we use 10 -> 74, then 31 -> 95)
    console.log("Ring brightness 10 → 31…");
    out.sendMessage(cc(S_CC_PARAMS, enc, 64 + 10)); // 74
    await sleep(200);
    out.sendMessage(cc(S_CC_PARAMS, enc, 64 + 31)); // 95
    // Pulse animation (value 13 on CH_PARAMS); should override LED brightness
    console.log("Pulse anim…");
    out.sendMessage(cc(S_CC_PARAMS, enc, 13));
    await sleep(400);
    console.log("Cancel pulse by sending LED brightness again…");
    out.sendMessage(cc(S_CC_PARAMS, enc, 18 + 5));
    // Pattern across all encoders for under-LED brightness
    console.log("Pattern across all 16 encoders (under-LED brightness)…");
    for (let i = 0; i < 16; i++)
        out.sendMessage(cc(S_CC_PARAMS, i, 18 + ((i * 2) % 30)));
    await sleep(1200);
    out.closePort();
    console.log("Done.");
})();
