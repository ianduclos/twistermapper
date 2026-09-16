Overview (human-readable)

This project is a headless Node.js “brain” for the MIDI Fighter Twister (MFT). It does three big things: 1. Decouples input from feedback. We treat encoder turns as relative deltas and render LEDs from our own virtual page state, not from the device firmware’s built-ins. That lets us build features like multiple “pages,” record/playback gestures, and visual overlays. 2. Owns the LEDs with a renderer + rate limits. We keep a cached “last sent” LED frame per encoder and diff to the new desired frame. A LedReconciler sends only what changed, in the right order, under strict burst and rolling caps so the Twister stays happy. Animations (e.g., pulse) are handled carefully to avoid clobbering brightness. 3. Speaks OSC to the DAW/Max world. Page changes and value changes go out over OSC as normalized floats; pages can also receive OSC to set values. We use simple, routable paths (e.g., /twister/out/page/a/index/1/value 0.92). There’s no GUI; the app is meant to sit between the Twister and your audio software.

We currently ship six page prototypes: BasicPage (16 normalized values with selectable press modes), GesturePage (per-encoder record→playback looper with proper loop wrap and “silence at end” recording), StepSeqPage (clocked 4-track step sequencer), MorphPage (scene morph with a dissolving phantom snapshot), HotelierPage (gig-specific copy of GesturePage), and BlankPage (inert placeholder — ignores all input, LEDs stay dark; for slots not in use yet). A Main overlay uses the side buttons to temporarily focus an index-selection page that highlights page slots and lets you switch focus with encoder presses. On boot we run a short boot splash (frames of LED color/brightness) to “warm” the hardware and then immediately paint the focused page twice to settle brightness deterministically.

⸻

Goal

Headless Node.js app that decouples input deltas from LED feedback, with 8 loadable pages (A–H). The app drives a physical MIDI Fighter Twister and talks OSC. No GUI required (an optional web UI exists for control/monitoring, and a `--fake` virtual-device mode for development without hardware).

Environment & build
• Node + TypeScript (NodeNext ESM).
• macOS target; default MIDI port name: “Midi Fighter Twister”.
• MIDI selection honors the requested name (case-insensitive exact match, then substring) or index. An unavailable port fails startup/reconnection with an error listing available ports; it never falls back to an unrelated device. This prevents LED feedback looping through a virtual MIDI bus as encoder input. Use `--fake` without hardware. Failed driver initialization closes any partially opened ports.
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
• /twister/out/focus/page <slotLetter> → emitted when focus changes (OSC + web UI), so external surfaces can track the focused slot.
• /twister/out/page/<slot>/mode <note|precision|recall> → BasicPage current mode (on init/focus/change).
• /twister/out/preset/list <names…> → saved preset names (on connect, and after save/load/delete).
• /twister/out/preset/active <name|""> → name of the active preset, "" when custom/unsaved.
• /twister/out/settings <json> → current global settings (interaction timings + render.fps) as a JSON string.
• /twister/out/pong <args…> → reply to /twister/in/ping, echoing the ping's args (e.g. a token).
• Example (BasicPage): /twister/out/page/a/index/1/value 0.77380 (≤ 5 decimals).

In (core):
• /twister/in/focus/page <slotLetter> → focus page by letter (`a`–`h`).
• /twister/in/clock <int> → external clock tick broadcast to all pages (StepSeqPage consumes IDs 0–3).
• /twister/in/dump/global → request dumps from pages that support it (Basic: palette/values; Morph: scene vectors).
• /twister/in/ping <token?> → liveness check; replies /twister/out/pong echoing any args. (/twister/out/hello only fires at daemon boot, so a patch opened later uses this to detect the daemon.)

In (presets & global settings):
• /twister/in/preset/list → request the preset list (replies /twister/out/preset/list).
• /twister/in/preset/save <name> → snapshot the live interface (soft capture: structural config — page per slot, palette/brightness, clock routing — NOT knob/step values) to configs/presets/<name>.json and mark it active.
• /twister/in/preset/load <name> → apply a saved preset live (reloads all slots) and persist it to slots.json.
• /twister/in/preset/delete <name> → delete configs/presets/<name>.json.
• /twister/in/slot/<slot>/page <PageName> → reassign one slot's page live (Basic|Blank|Gesture|Hotelier|Morph|StepSeq); persists to slots.json and clears the active-preset marker.
• /twister/in/settings/get → request current global settings (replies /twister/out/settings).
• /twister/in/settings/set <key> <value> → set one global setting live (keys: mainDoubleClickMs|mainHoldThresholdMs|debounceMs|fps); persists to settings.json; an fps change rebuilds the render loop. osc.inPort/osc.outPort are NOT live-settable here — see settings.json note below.
• Names are restricted to [A-Za-z0-9 _-]{1,48} (safe filename; maps cleanly to a Max patch name later).

In (page):
• /twister/in/page/<slot>/index/<id>/set <normalized> → set internal value (page decides if it’s allowed; e.g., GesturePage only in standby).
  – Echo suppression: when this arrives over OSC, the page's resulting /index/<id>/value is NOT sent back on the OSC wire — the sender already knows the value, and a patch that both sends and listens would feed back on itself. The web UI still receives it (it is not the sender). A set that arrives from the web UI is unaffected and still emits to OSC. Only /index/<id>/set is treated this way; every other in-route emits normally. See docs/max-handshake.md.
• /twister/in/page/<slot>/config/color/map <16 ints> → replace BasicPage encoder palette (ignored if the slot isn’t BasicPage).
• /twister/in/page/<slot>/config/color/enc/<id>/set <color> → update a single BasicPage encoder color.
• /twister/in/page/<slot>/config/colorbrightness/map <16 ints> → replace BasicPage encoder brightness map.
• /twister/in/page/<slot>/config/colorbrightness/enc/<id>/set <int> → update a single BasicPage encoder brightness.
• /twister/in/page/<slot>/scene/<k>/set <12 floats> → restore MorphPage scene k (k 0–3); ignored if the slot isn't MorphPage.
• /twister/in/page/<slot>/dump — and the global /twister/in/dump/global — ask a page to re-emit its state. Every slot receives it; pages that implement it answer, pages that don't ignore it (no page-name gate). Basic: /config/color/map + /index/all/value. Gesture and Hotelier: /index/all/value + /index/all/mode (16 of standby|record|play — /set is only accepted in standby, so this is how a host learns which encoders are writable). Morph: /scene/<k>/values. All re-send /page/<slot>/type first, and a dump bypasses per-encoder dedup so it always reports the full picture.
• /twister/in/page/<slot>/mode <note|precision|recall> → set BasicPage mode (ignored by other pages); page echoes /twister/out/page/<slot>/mode.

OSC numeric rules:
• Floats emitted with max 5 decimals.
• Basic and Gesture keep values as native floats 0..1 (no internal quantization); StepSeq and Morph keep 0..127 ints internally and normalize by /127 outbound, scaling inputs back (rounded).

⸻

Control surface (OSC + optional web UI)
• All inbound control (OSC and web UI) is dispatched through one shared router (routeControl in src/cli/index.ts), so both speak the same /twister/in/... vocabulary.
• All outbound twister messages go through emitOut(): out to OSC/UDP AND mirrored to any connected web UI.
• Web UI is OFF by default; enable with --ui or TWISTER_UI=1 (port via --ui-port / TWISTER_UI_PORT, default 57190). The daemon is fully headless without it.
• Transport: there is NO internal clock. The pulse generator lives in the web UI (BPM, play/stop, skip %, per-pulse clock id 0–3), sending /twister/in/clock <id>. Browser timer jitter is acceptable for irregular/experimental use; move server-side only if tight timing is needed.
• src/io/controlServer.ts: tiny HTTP + WebSocket. HTTP serves the web/ directory as static files (an extension allowlist — .html/.css/.js/.json/.svg/.png/.ico — and every path resolved and checked for containment inside the directory before the filesystem is touched; unknown paths 404). WS protocol mirrors OSC as JSON { path, args }. On connect it pushes a state snapshot (fake-vs-hardware mode, current focus, each slot's page type, preset list + active preset, global settings, and the current LED frame) so a late-joining UI is correct immediately.
• Web UI files (web/, plain ES modules, NO build step): index.html is markup only; style.css + flexoki.css (the Flexoki scale, vendored verbatim from kepano/flexoki); bus.js (WebSocket transport); panels.js (page focus, value strip, press mode, presets, settings, pulse generator, log); twister.js (the encoder grid); lib/knobMath.js (pure input maths, unit-tested); app.js (boot + routing). cli/index.ts resolves web/ relative to the module, not process.cwd().
• /twister/out/mode <fake|hardware> is emitted on connect. The encoder grid leads the Control tab in BOTH modes — a mirror of the thing you are playing is still the most useful object on screen — and --fake only enlarges it, since there is no MIDI ceiling to respect.
• Web UI visual model: two materials, not one. The sixteen encoders sit on a single shrink-wrapped 950 "faceplate" with no per-cell borders; every other panel is a sentence-case legend over a hairline rule with no box at all, and that difference carries the whole hierarchy. Flexoki accents are used semantically — blue for focus and the primary action, green for connected and the active preset, yellow for pulse and an armed shift, red for stop, and a per-page-type hue on the slot tiles. Type is system-only (no webfonts: the page must work offline): ui-rounded for legends and controls, ui-monospace with tabular-nums for every live number. A held shift outlines the plate itself rather than one small button.
• Virtual Twister (`--fake` / TWISTER_FAKE=1): runs the daemon with no MIDI hardware — FakeMidiDriver (src/io/fakeMidiDriver.ts) no-ops the device, the hotplug watcher is skipped, and the web UI is forced on. Pages, OSC, and presets behave identically; the web UI's 4×4 encoder grid becomes the device.
• /twister/ui/... is the virtual-device vocabulary, dispatched through the same routeControl (so external OSC apps can drive it too). Inputs synthesize InputEvents and feed handleInputEvent() — the exact code path hardware input takes, so modifiers, page routing, and Main-overlay hold/latch behave identically:
  - /twister/ui/enc/turn <id 0..15> <delta ±1..16 int> → encoder turn (shift flag from current modifiers).
  - /twister/ui/enc/press <id 0..15> <1|0> → encoder button.
  - /twister/ui/side/shift <left|right> <1|0> → shift buttons.
  - /twister/ui/side/global <left|right> <1|0> → global/Main buttons (right = Main: hold opens the overlay, double-tap latches).
• LED mirror: the render loop broadcasts /twister/ui/leds <json> — 16 [ring, rgb, ledBrightness, ringBrightness, pulse01] tuples in human units — to web UI clients ONLY (never over OSC/UDP; a 30fps JSON stream would spam Max). Gated on frame change, so an idle daemon is silent. The browser diffs per encoder and coalesces into one animation frame, so an unchanged encoder costs no DOM writes. MFT color indices are approximated to CSS hues (vtColorIndexToHue), then rendered in three roles — cap, bloom and ring — pulled out of full saturation so they sit in the Flexoki register.
• Encoder rendering: an LED emits rather than fills. Each cell stacks a bloom circle, the cap, and a fixed specular that never needs rewriting, with ledBrightness 0..29 driving bloom opacity 0→0.22 and cap opacity 0.18→1 — so an unlit encoder reads as a dark cap, not a coloured sticker. No SVG filters: sixteen cells at 60fps cannot afford them. The value arc takes the encoder's own hue (the ring and cap are one LED on the device, not a permanently blue indicator) and uses a butt linecap — with the old round cap, a zero-length arc still painted a dot on every encoder sitting at 0. The 90° gap at the bottom of the ring is where the value readout lives, always visible rather than shown on hover. Pulse animates the bloom, not the cap's opacity.
• Value strip: the focused page's raw 0..1 values, rendered one bar per index and sized to the indices the page actually reports (floor of 16) — a page whose value count does not map onto the 4×4 matrix finally displays correctly, which is what this panel exists for. It is deliberately cheap in space; the encoder readouts carry the per-knob numbers.
• Virtual Twister input model: the whole cell is the hit target, and the zone under the pointer decides what it does — centre disc (r < 0.24 of the cell) = the button, everything else = the knob. Dragging from the centre turns while the press is held, which is press-and-turn as on the device; press and turn stay independent axes. Pointer Events with setPointerCapture, so a drag survives leaving the cell or the window. Drag has velocity-scaled acceleration (1x–6x), Alt = fine (1px/step, no acceleration), Cmd = coarse; the wheel normalises deltaMode and accumulates real pixels (~40px/step); keyboard arrows turn (Shift for 10) and Space/Enter press. Turns batch into one animation frame and go out chunked to ±16, the daemon's own clamp.
• Ring prediction: the browser moves the ring the instant it is dragged and reconciles afterwards, rather than waiting for the round trip plus the next render tick. ONLY the ring is predicted — colour, brightness and pulse are page logic the browser cannot model. A prediction holds while turns are in flight and expires 140ms after the last one, at which point the daemon's value wins; a page that clamps or quantizes therefore corrects once after the gesture rather than fighting it mid-drag. See reconcile() in web/lib/knobMath.js.
• Global presets: a preset is an interface-only SystemConfig (slot→page + per-page config), one file per preset under configs/presets/. The active config lives in configs/slots.json. src/core/systemConfig.ts owns sanitize→factory (shared by boot + live apply); src/core/presetStore.ts is the filesystem layer. applySystemConfig() in cli/index.ts reloads pages live via PageManager.load and repaints through the render loop (no direct device push). This is the channel a Max patch will use to set the interface per open patch.

⸻

Page model
• PageContext (injected): { modifiers, resolution, osc, setDirty }
• resolution ∈ 128 | 256 | 512 → delta step = 128 / resolution (Basic/Gesture).
• osc.send(path, ...args) for page-initiated OSC.
• setDirty() requests a render of this page; if focused, it will push immediately.
• Lifecycle: init(ctx), onFocus(), onBlur(), dispose().
• Handlers: onEvent(ev, ctx), onOsc(path, args, ctx), render(ctx) → LedFrame | undefined.
• serialize() (optional) → page's structural config for preset capture (e.g. Basic {encoderColors,encoderBrightness}, StepSeq {tracks:[{clockIds}]}); MUST exclude transient runtime values (encoder positions, sequencer steps, playhead).
• Background behavior: pages may keep timers running while unfocused (e.g., GesturePage playback); unfocused pages update desired frames but those frames are not sent until focused.

BasicPage (reference)
• 16 values as **float 0..1** (the real value/OSC resolution); the 0..127 LED ring is display only (`ring = round(val·127)`). Turn: `val += delta·normalStep`, `normalStep = (128/resolution)/127` → clamp 0..1.
• Defaults: purple (110), ledBrightness = 5 (device 23), ringBrightness = 31.
• **Modes** (per page, runtime, default `note`; reassign the encoder press):
  - `note` — press = note on/off: brightness bump + `/twister/out/page/<slot>/index/<id>/press <1|0>`.
  - `precision` — hold a knob → its turns are fine (`normalStep / PRECISION_DIVISOR`, default 8); brightness bump as feedback; no `/press`.
  - `recall` — one saved scene/page: knob press recalls that knob's value; L+R shift together saves the scene (knobs flash); L shift alone (on release, if R wasn't pressed) recalls the whole scene; no `/press`. R shift alone reserved for future multi-scene.
• OSC out on change: /twister/out/page/<slot>/index/<id>/value <0..1> (≤ 5 dp), /twister/out/page/<slot>/index/<id>/press <1|0> (note mode only), and /twister/out/page/<slot>/mode <note|precision|recall> (on init/focus/change).
• OSC in: /twister/in/page/<slot>/index/<id>/set <0..1>; /twister/in/page/<slot>/mode <note|precision|recall>.

GesturePage (record / playback looper)
• Values are **float 0..1** like BasicPage (`val += delta·normalStep`, `normalStep = (128/resolution)/127`, clamp 0..1); the 0..127 LED ring is display only.
• Per encoder mode: standby (blue, brightness 5) → record (red + pulse animation) → playback (green, brightness 10); a third press returns to standby and clears the recording.
• Record: capture (t ms, v float) points with strictly increasing timestamps (ms since record start). Append only on value change; on finalize always append a last point at button press time (even if value didn’t change) so end silence is recorded.
• Playback: 20 ms tick; continuous (unquantized) linear interpolation between points; wrap using a synthetic segment to the first value so loops are smooth. Ignore deltas while in playback.
• OSC out dedupes per encoder against the last-sent 5-decimal value, so flat/held loop segments don't re-emit every tick.
• OSC in: only accept /set in standby (external param control, clamp 0..1, no rounding); reject in record/playback.
• Keeps timers running off-focus; only LEDs for the focused page are sent.

HotelierPage (gig-specific prototype)
• Independent copy of GesturePage in `src/pages/hotelier.ts`; initially identical controls, recording, playback, and OSC value/set behavior.
• Registered as `Hotelier`, selectable through the web UI or `/twister/in/slot/<slot>/page Hotelier`; announces type `Hotelier`. No slot is assigned by default.
• Neither Gesture nor Hotelier currently assigns shift-specific behavior; shifted encoder input follows normal behavior.
• Full Gesture OSC contract: `docs/gestures-osc.md` (also applies to Hotelier, except the type string).

StepSeqPage (clocked 4-track sequencer)
• Four tracks (encoders 0–3) each with 12 steps, individual playhead, loop start/end, and per-step probability.
• Tracks emit `/twister/out/page/<slot>/index/<track>/value <valueNorm>` on every `/twister/in/clock <id>` tick; LEDs show per-track values (highlighted track at brightness 29, others 10). When a probability roll fails, the playhead holds for one extra tick before retrying.
• Encoders 4–15 display the highlighted track’s 12 steps: loop inclusion uses dim/bright states, playhead flashes at track color+13 and brightness 29. Holding right shift swaps the view to probability percentages (rings scale 0–100%).
• Turning step encoders edits values in normal mode; with right shift held they adjust that step’s probability (0–100%). Top encoders 0–3 adjust all probabilities within the track while shift is held. Pressing steps sets loop ends or ranges (press+press chord). Loop edits keep playhead inside bounds and can trigger immediate output updates.
• Step button presses also broadcast `/twister/out/page/<slot>/index/<id>/press <1|0>`; page keeps running while unfocused so clock ticks advance playheads regardless of focus.

⸻

MorphPage (4-corner vector morph)
• Top 12 encoders (0–11) are the OUTPUT (12 values); bottom 4 (12–15) are scene faders. There are 4 saved scenes plus a live "phantom" snapshot P. The phantom is not a peer scene — `out[i] = wp·P[i] + (1−wp)·(Σ wₖ·Sₖ[i] / Σwₖ)` where `wp = max(0, 1 − travel/PHANTOM_DECAY)`.
• Moving a value knob snapshots the current output into P and resets `travel` (phantom → 100%), then edits P — so value knobs are always 1:1 free, and the faders keep their positions (never reset). Moving any fader (up or down) adds to `travel`, dissolving the phantom toward the scene blend; once dissolved, one fader at max = that scene pure. Faders are absolute 0..127 and blend together; pushing a maxed fader further reduces the other faders. `PHANTOM_DECAY` (default 127 ≈ one fader sweep) tunes how fast the phantom dissolves.
• Press a top encoder to toggle a value LOCK (reddish-orange): a locked param leaves the blend and becomes a free direct control (out = its live value, immune to the morph).
• Press a bottom encoder = recall: loads that scene into the (unlocked) phantom and clears the faders → the pure scene. Shift+press = save current output into that scene (the encoder pulses to confirm). Bottom presses broadcast `/twister/out/page/<slot>/index/<id>/press <1|0>`.
• LEDs: top rings = output value (blue, or reddish-orange when locked); bottom rings = each fader weight, one color per scene, dominant fader brightest.
• OSC out: `/twister/out/page/<slot>/index/<0–11>/value` (outputs) and `/index/<12–15>/value` (fader weights). Persistence is Max's job (no serialize): on `/dump` it emits `/twister/out/page/<slot>/scene/<k>/values <12 floats>` for k=0–3; `/twister/in/page/<slot>/scene/<k>/set <12 floats>` restores a scene.

⸻

Main overlay (page focus selector)
• Lower-right “main” button controls the overlay: hold ≥ mainHoldThresholdMs (default 200 ms) for a momentary overlay, double-click within mainDoubleClickMs (default 320 ms) to toggle latch ON/OFF, and single short taps are ignored. Debounce defaults to 20 ms.
• Shows 8 selectors (encoders 0–7) for pages A–H with distinct colors; the focused slot is shown at full brightness. Pressing a selector focuses that page.
• While the overlay is up, route encoder/press events to the overlay; on exit, return to normal page routing. Latch changes are logged (“Main latch: ON/OFF”).

⸻

Render loop (single output path)
• A fixed-rate render loop (default 30 FPS; configs/settings.json → render.fps, clamped 1..120) is the ONLY thing that pushes to the device (src/render/renderLoop.ts, wired in src/cli/index.ts).
• Each frame it pushes the "current desired" frame: the overlay frame while the overlay is active, otherwise the focused page's desired frame. The reconciler diffs, so an unchanged frame sends zero MIDI.
• Input events, OSC, clock ticks, and setDirty() update page desired state but DO NOT push directly — they are coalesced into the next frame. This bounds output to the rate caps and makes the loop its own self-drain (the reconciler keeps unsent work pending and recomputes from the latest desired each frame).
• Only LED/MIDI output is frame-gated. OSC out (e.g. BasicPage value broadcasts) still happens immediately inside page handlers, so DAW-facing data stays realtime.
• Focus/overlay transitions request a one-time fast focus paint (128-msg burst, beginFocusPaint) so page switches snap. The loop is paused during boot splash and device hotplug so the splash isn't fought. (Note: a forced full repaint on page change was tried and reverted — the ~64-msg burst floods the newer firmware and drops LED brightness; diff-on-focus is the working behavior.)

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
• If a burst/rolling cap prevents sending the full diff, keep the remaining per-encoder changes pending. The render loop is the drain: the next frame re-pushes the latest desired frame and the reconciler continues flushing from its pending state until the queue is empty. (The reconciler does not run its own timer; the loop paces it.)

⸻

Boot splash (startup warm-up)
• On boot, run a short LED boot splash (e.g., Blue-fade + color walk) to “warm” the device, no pulse used.
• After the splash, paint the focused page twice (two pushes ~8 ms apart) to settle brightness deterministically.
• Splash patterns live in a separate module and can be added freely (e.g., “Blue Fade + Drunk Walk”, “Blue Fade + Straight Walk”, “Purple Landing + Straight Walk” that back-solves to land on a target hue at the last frame).

⸻

Config (JSON)
• Color indices, channel/CC/note map, and any optional encoder index offset/map are defined in JSON.
• configs/slots.json is the active SystemConfig: selects page prototypes (A–H), optional BasicPage encoder color/brightness palettes, and an optional `activePreset` marker. configs/presets/<name>.json hold saved interface-only SystemConfigs (same shape, no activePreset).
• StepSeq slots may provide per-track clock lists (e.g., `{"tracks":[{"clockIds":[0,2,5]},...]}`) to decide which `/twister/in/clock` IDs advance each track (default 0).
• configs/settings.json defines interaction timings (double-click window, hold threshold, debounce) for the Main overlay trigger, render.fps (render-loop rate, default 30, clamped 1..120), and osc.inPort/osc.outPort (UDP ports, default 57121/57120, clamped 1..65535). OSC ports are read once at boot to bind the UDP socket — unlike fps, changing them requires a daemon restart, not just a live settings/set.
• Only the MIDI driver knows about device numbers & channels; core code works with human-readable values:
• LED brightness: human 0..29 → device 18..47.
• Ring brightness: human 1..31 → device 65..95.
• Color: 1..126 (wraps).

⸻

Dirty & OSC semantics
• routeOscToPage(slot, path, args) calls page.onOsc, then re-renders that page.
• PageContext.setDirty() asks PageManager to re-render the calling page.
• Re-rendering updates the page's stored desired frame. It is NOT pushed to the device on the spot — the render loop pushes the focused page's (or overlay's) desired frame on the next frame (see "Render loop"). Unfocused pages just keep their desired frame updated; it is sent once they become focused.

⸻

MIDI driver (Node)
• Auto-selects the “Midi Fighter Twister” ports (exact/substr match); overridable at the CLI via `--in`/`--out` flags or `TWISTER_IN`/`TWISTER_OUT` env (both driver and hotplug watcher honor the override).
• Provides setRing, setRGB, setLedBrightness, setRingBrightness, setPulse with the mappings above.
• Exposes onMessage(cb) with decoded { type: 'cc'|'note', channel, number, value }.
• close() releases ports cleanly (for tools/tests).
• Hotplug: a 1.5 s watcher polls for the configured output port. On disconnect it pauses the render loop (no MIDI at a dead port); on reconnect it rebuilds driver + reconciler, re-runs the boot splash, and resumes the loop. Skipped entirely in `--fake` mode.
• FakeMidiDriver (src/io/fakeMidiDriver.ts): same interface, all device I/O no-ops — the `--fake` stand-in. LED feedback reaches the web UI via the render-loop mirror (/twister/ui/leds), not this driver.

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
• R7 Dirty/OSC: setDirty & routeOscToPage re-render (update desired); the render loop pushes the focused/overlay frame each frame. No direct pushes from events.
• R8 OSC floats: ≤ 5 decimals; normalized 0..1.
• R9 Pages may run off-focus: timers okay; LEDs only sent for focused page.
• R10 Render loop: a fixed-rate loop (default 30 FPS, render.fps) is the single output path; it coalesces state into one diff/frame and is its own self-drain. 30 FPS is chosen for the MFT's LED throughput ceiling (R5), so in --fake mode — where FakeMidiDriver no-ops every device write and the only consumer is the browser — the loop runs at max(render.fps, 60). The stored setting is unchanged; hardware mode always uses render.fps exactly.

⸻

Known-good behaviors to preserve
• BasicPage: realtime OSC out on value change; press-to-brighten works; default purple color & brightness levels render correctly on first focus after boot splash.
• GesturePage: record → playback loop wraps smoothly; end silence is recorded (final point always appended); playback ignores deltas.
• StepSeqPage: clock ticks advance all four tracks, respect per-step probability delays, emit OSC per track, maintain loop bounds, and honor highlighted track LED/probability views.
• Main overlay: momentary hold or double-click latch; selector colors/brightness show focus; switching focus repaints the new page frame using beginFocusPaint() + normal rate limits.

⸻

Out of scope for now (future ideas)
• Full state sync at startup (Max → Node) via /twister/in/state … and /twister/out/state/ack.
• More page types (sequencers, LFOs), pagination beyond A–H.
