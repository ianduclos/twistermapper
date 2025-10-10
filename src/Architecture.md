Overview (human-readable)

This project is a headless Node.js “brain” for the MIDI Fighter Twister (MFT). It does three big things: 1. Decouples input from feedback. We treat encoder turns as relative deltas and render LEDs from our own virtual page state, not from the device firmware’s built-ins. That lets us build features like multiple “pages,” record/playback gestures, and visual overlays. 2. Owns the LEDs with a renderer + rate limits. We keep a cached “last sent” LED frame per encoder and diff to the new desired frame. A LedReconciler sends only what changed, in the right order, under strict burst and rolling caps so the Twister stays happy. Animations (e.g., pulse) are handled carefully to avoid clobbering brightness. 3. Speaks OSC to the DAW/Max world. Page changes and value changes go out over OSC as normalized floats; pages can also receive OSC to set values. We use simple, routable paths (e.g., /twister/out/page/a/index/1/value 0.92). There’s no GUI; the app is meant to sit between the Twister and your audio software.

We currently ship two page prototypes: BasicPage (16 normalized values with direct LED monitoring) and GesturePage (per-encoder record→playback looper with proper loop wrap and “silence at end” recording). A Main overlay uses the side buttons to temporarily focus an index-selection page that highlights page slots and lets you switch focus with encoder presses. On boot we run a short boot splash (frames of LED color/brightness) to “warm” the hardware and then immediately paint the focused page twice to settle brightness deterministically.

⸻

Goal

Headless Node.js app that decouples input deltas from LED feedback, with 8 loadable pages (A–H). The app drives a physical MIDI Fighter Twister and talks OSC. No UI.

Environment & build
• Node + TypeScript (NodeNext ESM).
• macOS target; default MIDI port name: “Midi Fighter Twister”.
• Strict types for core/page/render layers; JSON config for device map & colors.
• Null stubs exist (e.g., NullMidi) for running without hardware.

Device map (channels are zero-based 0–15 in code)

Input (from MFT):
• Encoder deltas: CC# 0..15 on CH 0. Payloads are relative deltas; we accept any integer (±1 typical).
• Encoder button: NOTE# 0..15 on CH 1 (velocity 127 = down, 0 = up).
• Side buttons: on CH 3 — Left upper CC8 (shift L), left lower CC9 (global L), right upper CC11 (shift R), right lower CC12 (global R). 127 = down, 0 = up.

Output (to MFT):
• Ring level: CC on CH 0; cc number = encoder id; value 0..127.
• RGB color: NOTE on CH 1; note = encoder id; velocity 1..126 selects color (1 and 126 are blue in the Twister’s cyclic palette).
• LED (under-knob) brightness: CC on CH 2, value 18..47. Human 0..29 → device = 18 + human.
• Ring (indicator) brightness: CC on CH 2, value 65..95. Human 1..31 → device = 64 + human.
• Pulse animation: CC on CH 2, value 13.

Animation precedence:
• Sending pulse implies full LED brightness at the device.
• Sending a brightness value cancels pulse.

These channel choices match the working setup; do not change unless you also change the device map.

⸻

Events & routing
• Only the focused page receives encoder turns, encoder button presses, and shift modifiers.
• Shift intercepts globals: while a shift is held, the lower “global” buttons aren’t handled globally; the focused page sees modifiers.shiftLeft/shiftRight/global\* and may reinterpret.

Delta policy
• Treat encoder payloads as deltas (±1 typical, but may be larger).
• Pages accumulate deltas into their internal values; clamp to 0..127 after accumulation.
• Do not clamp/filter the raw deltas themselves.

⸻

OSC

Out (core + page-specific):
• /twister/out/hello → emitted once when OSC transport is ready.
• /twister/out/page/<slot>/type <string> → page identity handshake (init + focus).
• /twister/out/page/<slot>/index/<id>/value <0..1> → normalized value broadcast (Basic, StepSeq, Gesture).
• /twister/out/page/<slot>/index/<id>/press <1|0> → encoder button state for pages that surface presses.
• /twister/out/page/<slot>/config/color/map <16 ints> → BasicPage palette dump (response to `/twister/in/dump/global`).
• /twister/out/page/<slot>/index/all/value <16 floats> → BasicPage normalized value dump.
• Example (BasicPage): /twister/out/page/a/index/1/value 0.77380 (≤ 5 decimals).

In (core):
• /twister/in/focus/page <slotLetter> → focus page by letter (`a`–`h`).
• /twister/in/clock <int> → external clock tick broadcast to all pages (StepSeqPage consumes IDs 0–3).
• /twister/in/dump/global → request palette/value dumps from Basic pages.

In (page):
• /twister/in/page/<slot>/index/<id>/set <normalized> → set internal value (page decides if it’s allowed; e.g., GesturePage only in standby).
• /twister/in/page/<slot>/config/color/map <16 ints> → replace BasicPage encoder palette (ignored if the slot isn’t BasicPage).
• /twister/in/page/<slot>/config/color/enc/<id>/set <color> → update a single BasicPage encoder color.
• /twister/in/page/<slot>/config/colorbrightness/map <16 ints> → replace BasicPage encoder brightness map.
• /twister/in/page/<slot>/config/colorbrightness/enc/<id>/set <int> → update a single BasicPage encoder brightness.

OSC numeric rules:
• Floats emitted with max 5 decimals.
• Normalization is value / 127 on output; input normalized back to 0..127 (rounded).

⸻

Page model
• PageContext (injected): { modifiers, resolution, osc, setDirty }
• resolution ∈ 128 | 256 | 512 → delta step = 128 / resolution (Basic/Gesture).
• osc.send(path, ...args) for page-initiated OSC.
• setDirty() requests a render of this page; if focused, it will push immediately.
• Lifecycle: init(ctx), onFocus(), onBlur(), dispose().
• Handlers: onEvent(ev, ctx), onOsc(path, args, ctx), render(ctx) → LedFrame | undefined.
• Background behavior: pages may keep timers running while unfocused (e.g., GesturePage playback); unfocused pages update desired frames but those frames are not sent until focused.

BasicPage (reference)
• 16 values 0..127.
• Turn: vals[id] += deltaStep → clamp 0..127.
• LED ring mirrors value (scaled 0..127).
• Defaults: purple (110), ledBrightness = 5 (device 23), ringBrightness = 31.
• Press (hold): temporarily set ledBrightness = 29 (max); release restores.
• OSC out on change: /twister/out/page/<slot>/index/<id>/value <val/127> (≤ 5 dp) and /twister/out/page/<slot>/index/<id>/press <1|0> when encoder buttons change.
• OSC in (optional): /twister/in/page/<slot>/index/<id>/set <norm>.

GesturePage (record / playback looper)
• Per encoder mode: standby (blue, brightness 5) → record (red + pulse animation) → playback (green, brightness 10).
• Record: capture (t, v0..127) points with strictly increasing timestamps (ms since record start). Append only on value change; on finalize always append a last point at button press time (even if value didn’t change) so end silence is recorded.
• Playback: 20 ms tick; modular interpolation between points; wrap using a synthetic segment to the first value so loops are smooth. Ignore deltas while in playback.
• OSC in: only accept /set in standby (external param control); reject in record/playback.
• Keeps timers running off-focus; only LEDs for the focused page are sent.

StepSeqPage (clocked 4-track sequencer)
• Four tracks (encoders 0–3) each with 12 steps, individual playhead, loop start/end, and per-step probability.
• Tracks emit `/twister/out/page/<slot>/index/<track>/value <valueNorm>` on every `/twister/in/clock <id>` tick; LEDs show per-track values (highlighted track at brightness 29, others 10). When a probability roll fails, the playhead holds for one extra tick before retrying.
• Encoders 4–15 display the highlighted track’s 12 steps: loop inclusion uses dim/bright states, playhead flashes at track color+13 and brightness 29. Holding right shift swaps the view to probability percentages (rings scale 0–100%).
• Turning step encoders edits values in normal mode; with right shift held they adjust that step’s probability (0–100%). Top encoders 0–3 adjust all probabilities within the track while shift is held. Pressing steps sets loop ends or ranges (press+press chord). Loop edits keep playhead inside bounds and can trigger immediate output updates.
• Step button presses also broadcast `/twister/out/page/<slot>/index/<id>/press <1|0>`; page keeps running while unfocused so clock ticks advance playheads regardless of focus.

⸻

Main overlay (page focus selector)
• Lower-right “main” button controls the overlay: hold ≥ mainHoldThresholdMs (default 200 ms) for a momentary overlay, double-click within mainDoubleClickMs (default 320 ms) to toggle latch ON/OFF, and single short taps are ignored. Debounce defaults to 20 ms.
• Shows 8 selectors (encoders 0–7) for pages A–H with distinct colors; the focused slot is shown at full brightness. Pressing a selector focuses that page.
• While the overlay is up, route encoder/press events to the overlay; on exit, return to normal page routing. Latch changes are logged (“Main latch: ON/OFF”).

⸻

Renderer & rate limits
• Keep a per-encoder device cache (LedFrame) for last-sent state.
• Build a pending diff per encoder and send only changed fields.
• Flush order per encoder:
ledBrightness → ringBrightness → rgb → ring (except pulse case below).

Pulse policy (important):
• If desired.anim === 'pulse': send pulse (once on transition) and skip only ledBrightness in that burst; still send ringBrightness, rgb, and ring.
• If switching pulse → none, we mark ledBrightness force and send it immediately to cancel pulse at the device.

Rate limits (initial):
• Burst window: 5 ms.
• Max 64 MIDI msgs/burst.
• Global cap: 400 msgs/sec (rolling window).
• On focus, beginFocusPaint() allows a one-time larger burst up to 128 to “paint” fast.

Draining pending work:
• If a burst/rolling cap prevents sending the full diff, keep the remaining per-encoder changes pending and schedule a small self-drain (~5 ms) to continue flushing the latest desired frame until the queue is empty.

⸻

Boot splash (startup warm-up)
• On boot, run a short LED boot splash (e.g., Blue-fade + color walk) to “warm” the device, no pulse used.
• After the splash, paint the focused page twice (two pushes ~8 ms apart) to settle brightness deterministically.
• Splash patterns live in a separate module and can be added freely (e.g., “Blue Fade + Drunk Walk”, “Blue Fade + Straight Walk”, “Purple Landing + Straight Walk” that back-solves to land on a target hue at the last frame).

⸻

Config (JSON)
• Color indices, channel/CC/note map, and any optional encoder index offset/map are defined in JSON.
• configs/slots.json selects page prototypes (A–H) and optional BasicPage encoder color/brightness palettes.
• StepSeq slots may provide per-track clock lists (e.g., `{"tracks":[{"clockIds":[0,2,5]},...]}`) to decide which `/twister/in/clock` IDs advance each track (default 0).
• configs/settings.json defines interaction timings (double-click window, hold threshold, debounce) for the Main overlay trigger.
• Only the MIDI driver knows about device numbers & channels; core code works with human-readable values:
• LED brightness: human 0..29 → device 18..47.
• Ring brightness: human 1..31 → device 65..95.
• Color: 1..126 (wraps).

⸻

Dirty & OSC semantics
• routeOscToPage(slot, path, args) calls page.onOsc, then re-renders that page.
• PageContext.setDirty() asks PageManager to re-render the calling page.
• If the re-rendered page is focused, push the new desired frame to the LedReconciler immediately. If not focused, store the desired frame (LEDs won’t be sent until that page is focused).

⸻

MIDI driver (Node)
• Auto-selects the “Midi Fighter Twister” ports (exact/substr match); can be overridden via options.
• Provides setRing, setRGB, setLedBrightness, setRingBrightness, setPulse with the mappings above.
• Exposes onMessage(cb) with decoded { type: 'cc'|'note', channel, number, value }.
• close() releases ports cleanly (for tools/tests).

⸻

Rate-limiting implementation details
• No global FIFO of encoded ops; instead, maintain a per-encoder pending state built from the latest desired frame and flush in numeric encoder order to keep behavior stable under load.
• Enforce two limits during flush: 1. Burst: ≤ 64 ops per 5 ms (first flush after beginFocusPaint() may send up to 128). 2. Rolling: < 400 msgs/sec via a 1-second ring buffer of timestamps.
• If limits trip, keep pending and trigger self-drain.

⸻

Rules (IDs)
• R1 Delta policy: treat inputs as deltas; pages clamp 0..127.
• R2 LED fields & human→device: LED 0..29 → 18..47, RING 1..31 → 65..95.
• R3 Animation precedence: pulse overrides LED brightness that burst; brightness cancels pulse.
• R4 Flush order: ledB → ringB → rgb → ring.
• R5 Rate caps: 64/5ms, 400/sec, 128 initial focus burst.
• R6 Focus routing: only focused page handles input; shift intercepts globals.
• R7 Dirty/OSC: setDirty & routeOscToPage re-render; push if focused.
• R8 OSC floats: ≤ 5 decimals; normalized 0..1.
• R9 Pages may run off-focus: timers okay; LEDs only sent for focused page.

⸻

Known-good behaviors to preserve
• BasicPage: realtime OSC out on value change; press-to-brighten works; default purple color & brightness levels render correctly on first focus after boot splash.
• GesturePage: record → playback loop wraps smoothly; end silence is recorded (final point always appended); playback ignores deltas.
• StepSeqPage: clock ticks advance all four tracks, respect per-step probability delays, emit OSC per track, maintain loop bounds, and honor highlighted track LED/probability views.
• Main overlay: momentary hold or double-click latch; selector colors/brightness show focus; switching focus repaints the new page frame using beginFocusPaint() + normal rate limits.

⸻

Out of scope for now (future ideas)
• Hot-plug watcher to re-run splash on USB reconnect.
• Full state sync at startup (Max → Node) via /twister/in/state … and /twister/out/state/ack.
• More page types (sequencers, LFOs), pagination beyond A–H.
