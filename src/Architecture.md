Overview (human-readable)

This project is a headless Node.js “brain” for the MIDI Fighter Twister (MFT). It does three big things: 1. Decouples input from feedback. We treat encoder turns as relative deltas and render LEDs from our own virtual page state, not from the device firmware’s built-ins. That lets us build features like multiple “pages,” record/playback gestures, and visual overlays. 2. Owns the LEDs with a renderer + rate limits. We keep a cached “last sent” LED frame per encoder and diff to the new desired frame. A LedReconciler sends only what changed, in the right order, under strict burst and rolling caps so the Twister stays happy. Animations (e.g., pulse) are handled carefully to avoid clobbering brightness. 3. Speaks OSC to the DAW/Max world. Page changes and value changes go out over OSC as normalized floats; pages can also receive OSC to set values. We use simple, routable paths (e.g., /twister_out/page_a 1 0.92). There’s no GUI; the app is meant to sit between the Twister and your audio software.

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

Out (page-specific):
• /\*_ twister*out / page*{a|b|c|d|e|f|g|h} _/ <encId 0..15> <valueNormalized 0..1>
• Example (BasicPage): /twister_out/page_a 1 0.77380 (≤ 5 decimals).

In (core):
• /twister_in/focus {a|b|c|d|e|f|g|h | 0|1|2|3|4|5|6|7} → focus page by letter or index.
• /twister_in/clock 1 → reserved; no clock logic yet.

In (page):
• /twister*in/page*{a|b|c|d|e|f|g|h}/set <encId> <normalized> → set internal value (page decides if it’s allowed; e.g., GesturePage only in standby).

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
• Press (hold): temporarily set ledBrightness = 10; release restores.
• OSC out on change: /twister_out/page_x <id> <val/127> (≤ 5 dp).
• OSC in (optional): /twister_in/page_x/set <id> <norm>.

GesturePage (record / playback looper)
• Per encoder mode: standby (blue, brightness 5) → record (red + pulse animation) → playback (green, brightness 10).
• Record: capture (t, v0..127) points with strictly increasing timestamps (ms since record start). Append only on value change; on finalize always append a last point at button press time (even if value didn’t change) so end silence is recorded.
• Playback: 20 ms tick; modular interpolation between points; wrap using a synthetic segment to the first value so loops are smooth. Ignore deltas while in playback.
• OSC in: only accept /set in standby (external param control); reject in record/playback.
• Keeps timers running off-focus; only LEDs for the focused page are sent.

⸻

Main overlay (page focus selector)
• Invoked while holding the lower right “main” button; latch by pressing with upper right shift, release (unlatch) by pressing main again (on release).
• Shows 8 selectors (encoders 0–7) for pages A–H with distinct colors; the focused slot is shown at full brightness. Pressing a selector focuses that page.
• While the overlay is up, route encoder/press events to the overlay; on exit, return to normal page routing.

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
• Main overlay: momentary with latch via shift+main, release via main; selector colors/brightness show focus; switching focus repaints the new page frame using beginFocusPaint() + normal rate limits.

⸻

Out of scope for now (future ideas)
• Hot-plug watcher to re-run splash on USB reconnect.
• Full state sync at startup (Max → Node) via /twister_in/state … and /twister_out/state_ack.
• More page types (sequencers, LFOs), pagination beyond A–H.
