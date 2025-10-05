Goal
Headless Node.js app that decouples input deltas from LED feedback, with 4 loadable pages. The app drives a physical MIDI Fighter Twister (MFT) and talks OSC. No UI yet.

Device map (zero-based channels 0–15 in our code)

Input (from MFT):
• Encoder deltas: CC#0..15 on CH 0. Payloads are deltas; we accept any integer (±1 typical).
• Encoder button: NOTE#0..15 on CH 1 (vel 127=down, 0=up).
• Side buttons: CH 3 — Left upper CC8 (shift L), left lower CC9 (global L), right upper CC11 (shift R), right lower CC12 (global R). 127=down, 0=up.

Output (to MFT):
• Ring level: CC on CH 0; cc number = encoder id; value 0..127.
• RGB color: NOTE on CH 1; note = encoder id; velocity 1..126 color index.
• LED brightness (under-knob RGB): CC on CH 2, value 18..47. Human readable 0..29 → device 18 + human.
• Ring brightness (indicator): CC on CH 2, value 65..95. Human readable 1..31 → device 64 + human.
• Pulse animation: CC on CH 2, value 13.

Animation precedence: Sending pulse implies full brightness; sending brightness cancels pulse.
Policy:
• If desired.anim === pulse: send pulse, skip brightness that flush.
• If switching pulse→none: immediately send brightness.

Events and routing
• Only the focused page receives encoder/press/shift events.
• Shift intercepts globals: while a shift is held, lower “global” buttons are not handled globally; the focused page sees modifiers.shift\* and can reinterpret.

Delta policy
• Treat encoder payloads as deltas (could be ±1 or larger).
• Pages accumulate into their values; clamp result to 0..127. Do not clamp deltas.

OSC
• Out (page-specific): /twister*out/slot*{a|b|c|d}/{...}
Basic page example: /twister*out/slot_a/0 0.77380 (value normalized 0..1, ≤ 5 decimals).
• In (core):
• /twister_in/focus {0..3} // 0=a, 1=b, 2=c, 3=d
• /twister_in/clock 1 // reserved hook, no clock logic yet
• In (page): /twister_in/slot*{a|b|c|d}/{...} routed to that page’s onOsc.

Renderer & rate limits
• Keep a device cache of last-sent LED frame for diffing.
• Flush order per encoder:
brightness LED → brightness ring → RGB → ring level, except when anim==='pulse' (send pulse only).
• Rate limits (initial):
• Burst window: 5 ms
• Max 64 MIDI msgs/burst
• Global cap 400 msgs/sec (rolling)
• On focus, allow a one-time larger burst up to 128 to “paint” fast.

BasicPage (reference page)
• 16 values in 0..127.
• Turn: val[id] += delta → clamp 0..127.
• LED ring mirrors value.
• Default color = purple (110).
• Default ledBrightness = 5 (human → device 23).
• Press down: set ledBrightness=10; release: restore.
• OSC out on change: /twister_out/slot_x/{id} {val/127 as float ≤ 5 dp}.
• Optional OSC in: /twister_in/slot_x/set/{id} {normalized float} → set internal value.

Config (JSON)
• Color indices, channel/CC/note map, per-page assignments. The MIDI driver is the only place that knows about device numbers.

Dirty & OSC semantics
• routeOscToPage(slot, path, args) must call page.onOsc, then re-render that page.
• PageContext.setDirty() instructs PageManager to re-render the calling page.
• If the re-rendered page is focused, the app should immediately push the new desired frame to the LedReconciler. If not focused, the desired frame is stored but not sent.

Rate-limiting implementation
• Use a global FIFO queue of encoded LED ops built from the per-encoder diff.
• Enforce two limits during flushes: 1. Burst: ≤ 64 ops per 5 ms (first flush after beginFocusPaint() may send up to 128). 2. Rolling: token bucket with capacity = 400, refill 400/sec.
• If the diff exceeds limits, keep remaining ops queued; schedule the next 5 ms flush with setTimeout(5).

Rules (IDs):
R1 Delta policy: treat inputs as deltas; pages clamp 0..127
R2 LED fields & human→device: LED 0..29→18..47, RING 1..31→65..95
R3 Animation precedence: pulse overrides; brightness cancels pulse
R4 Flush order: ledB → ringB → rgb → ring
R5 Rate caps: 64/5ms, 400/sec, 128 initial focus burst
R6 Focus routing: only focused page handles input; shift intercepts globals
R7 Dirty/OSC: setDirty & routeOscToPage re-render; push if focused
