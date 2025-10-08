const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** wrap color to 1..126 (1 and 126 are both blue on the Twister) */
function wrapColor(n) {
    let x = Math.round(n);
    // bring into [0..125], then shift to [1..126]
    x = ((((x - 1) % 126) + 126) % 126) + 1;
    return x;
}
/** random integer in [-step..+step] */
function randStepNonZero(max = 6) {
    const mag = Math.floor(Math.random() * max) + 1; // 1..max
    return Math.random() < 0.5 ? -mag : mag;
}
/**
 * Blue Fade + Drunk Walk
 * - Start: all encoders RGB=blue(1), ledBrightness=max (29), ringBrightness=31, ring=0
 * - Each tick: ledBrightness -= 1 until 1; each RGB does ±4 "drunk walk" with wrapping (1..126)
 * - No pulse animation (anim: 'none') to avoid override behavior
 */
export const blueFadeStraightWalk = async (rec) => {
    const startBright = 29; // human 0..29
    const endBright = 1; // stop at 1
    const steps = startBright - endBright + 1; // inclusive 29..1
    const intervalMs = 80;
    const ringBright = 31;
    // per-encoder color state + fixed per-encoder delta
    const color = new Array(16).fill(1); // start blue
    const delta = new Array(16).fill(0).map(() => randStepNonZero(3)); // ±1..±6, no 0
    rec.beginFocusPaint();
    for (let s = 0; s < steps; s++) {
        const b = startBright - s;
        const frame = {};
        for (let i = 0; i < 16; i = (i + 1)) {
            color[i] = wrapColor(color[i] + delta[i]); // straight line per encoder
            frame[i] = {
                ring: 0,
                rgb: color[i],
                ledBrightness: b,
                ringBrightness: ringBright,
                anim: "none",
            };
        }
        rec.push(frame);
        await sleep(intervalMs);
    }
};
export const purpleLandingStraightWalk = async (rec, opts) => {
    const startBright = opts?.startBright ?? 29; // human 0..29
    const endBright = opts?.endBright ?? 1; // stop at 1
    const steps = startBright - endBright + 1; // inclusive frames
    const intervalMs = opts?.intervalMs ?? 80;
    const ringBright = opts?.ringBrightness ?? 31;
    const targetPurple = 110; // Twister purple; wraps 1..126
    const color = new Array(16);
    const delta = new Array(16);
    // choose per-encoder step and backtrack start color so final hits purple
    for (let i = 0; i < 16; i++) {
        const d = randStepNonZero(3); // ±1..±6 (never 0)
        delta[i] = d;
        // after (steps-1) additions, color_end = start + d*(steps-1) ≡ target (mod 126)
        // ⇒ start ≡ target - d*(steps-1) (mod 126), wrapped to 1..126
        color[i] = wrapColor(targetPurple - d * (steps - 1));
    }
    rec.beginFocusPaint();
    for (let s = 0; s < steps; s++) {
        const b = startBright - s; // 29..1
        const frame = {};
        for (let i = 0; i < 16; i = (i + 1)) {
            if (s > 0)
                color[i] = wrapColor(color[i] + delta[i]); // march straight each tick
            frame[i] = {
                ring: 0,
                rgb: color[i],
                ledBrightness: b,
                ringBrightness: ringBright,
                anim: "none",
            };
        }
        rec.push(frame);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
};
/** registry of splashes (add more later) */
export const BOOT_SPLASHES = [
    //blueFadeStraightWalk,
    purpleLandingStraightWalk,
    // add more: fancyPulse, swirl, checkerboard, etc.
];
/** pick one at random and run it */
export async function runRandomSplash(rec) {
    const idx = Math.floor(Math.random() * BOOT_SPLASHES.length);
    await BOOT_SPLASHES[idx](rec);
}
/** after splash, paint the focused page twice to settle brightness deterministically */
export function settleFocused(pm, rec) {
    const frame = pm.getDesiredFocused();
    if (!frame)
        return;
    rec.beginFocusPaint();
    rec.push(frame);
    setTimeout(() => rec.push(frame), 8);
}
