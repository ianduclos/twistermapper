# Roadmap — render loop, pulse control, web UI

Status as of 2026-06-01. Source of truth for behavior remains `src/Architecture.md`; this is the plan/intent doc. Decisions captured from planning with Ian.

## Guiding idea
The LED-refresh problem and the "I can't control playback" problem share a root: output was driven ad-hoc by input events. We separate concerns into two clocks:
- **Render clock (30Hz, configurable)** governs *MIDI LED output* — coalesces state into one diff per frame.
- **Pulse clock (BPM, lives in the UI)** *generates* `/twister/in/clock <id>` pulses; the daemon stays clock-source-agnostic.

## Effective MIDI rate (today)
Software caps in `ledReconciler.ts`: burst ≤64 msgs/5ms, rolling <400 msgs/sec, one-time 128 focus paint. ~400 msgs/sec is the real ceiling (MFT firmware LED rendering flickers under flood). A "message" is a changed field, not a frame — diffing keeps frames small. 30fps → ~13 msg/frame sustained budget; a playhead move is ~4–8 msgs.

## Phase 1 — Render loop (refresh fix) — IN PROGRESS
- Fixed-rate loop (default 30Hz, `settings.json` knob) pushes the current focused/overlay desired frame once per frame; reconciler no-ops when unchanged.
- `setDirty()` and events stop pushing directly; the loop is the single output path and the natural self-drain (reconciler keeps pending and recomputes from latest desired each frame). No separate self-drain timer needed.
- `beginFocusPaint()` (128 burst) on focus/overlay transitions for instant page switches.
- LED output only is frame-gated; OSC *out* stays realtime inside page handlers.
- Files: new `src/render/renderLoop.ts`; edits to `src/cli/index.ts`. Tests: loop cadence (fake timers) + existing reconciler diff tests.

## Phase 2 — Pulse generator + web UI (merged) — DONE (2026-06-01)
The old "core transport" idea is dropped — the pulse generator lives in the **UI** so pulses can be regular, skipped, or irregular, with per-pulse clock-id (0–3) selection driving StepSeq per-track `clockIds`. Shipped: shared `routeControl`, `src/io/controlServer.ts` (HTTP+WS, `--ui`/`TWISTER_UI=1`, port 57190), `web/index.html` (pulse gen + A–H focus + live monitor), `/twister/out/focus/page` emit, onConnect state snapshot. `ws` dependency added. End-to-end verified (HTTP 200, snapshot, focus echo, clock→StepSeq value round-trip). 22/22 tests green.

Original Phase 2 design notes (for reference):
- Refactor `cli/index.ts` OSC `onMessage` body into a shared `routeControl(path, args)` so OSC and the web UI dispatch identically (also unlocks external OSC apps for free).
- Add optional HTTP + WebSocket server (`src/io/controlServer.ts`), off by default (`--ui` / `TWISTER_UI=1`, port 57190). One dep: `ws`.
- WS protocol = JSON `{path, args}` mirroring OSC. Browser→daemon → `routeControl`; daemon→browser forwards selected `/twister/out/...` for live monitoring.
- `web/index.html` (no build step): **pulse generator** (BPM, play/stop, skip/irregular, clock-id select), **A–H focus buttons**, **live monitor** (page type + values + pulse state).
- Timing note: browser `setInterval` jitters / throttles when backgrounded. Fine for irregular/experimental use; if tight timing is needed later, move the *scheduler* server-side while keeping the *pattern* defined in the UI.

## Phase 3 — Global presets — DONE (2026-06-01)
Named, swappable whole-system layouts (page per slot + per-page config), saved/loaded live from the web UI over the same `/twister/in/...` vocabulary (so a Max patch can later set the interface per open patch). Shipped: `src/core/systemConfig.ts` (shared sanitize→factory, used at boot + live apply), `src/core/presetStore.ts` (one file per preset under `configs/presets/`, active config in `slots.json`, safe-name validation), optional `Page.serialize()` (soft capture — structural config only, not knob/step values) on Basic + StepSeq, `applySystemConfig`/`captureSystemConfig` in `cli/index.ts`, routes `preset/list|save|load|delete`, `slot/<a-h>/page`, `settings/get|set`, and a UI split into **Control** / **Setup** tabs. Verified end-to-end over WS.

## Phase 4 — Cleanup + Virtual Twister + ops — DONE (2026-07-04)
Three parallel/sequential work packages (Sonnet subagents, orchestrated), all verified by tsc + 32/32 tests + a live WS end-to-end run in fake mode:
- **Cleanup:** GesturePage modernized to float 0..1 values (unquantized playback, 5dp OSC dedup, debug log + stale comments removed); StepSeq `handleStepPressUp` no longer double-applies the loop endpoint; indentation normalized; CLAUDE.md test note unstaled.
- **Virtual Twister:** `--fake`/`TWISTER_FAKE=1` runs without hardware (`src/io/fakeMidiDriver.ts`); web UI gained an interactive 4×4 encoder grid; `/twister/ui/...` input vocabulary synthesizes InputEvents through the same `handleInputEvent()` as hardware (overlay hold/latch included); render loop mirrors LED frames to UI clients only via `/twister/ui/leds` (change-gated, never OSC/UDP). `src/util/fakeMidi.ts` (test double) intentionally untouched.
- **Ops:** `/twister/in/ping` → `/twister/out/pong` (args echoed) for daemon liveness detection; hotplug watcher now pauses the render loop on disconnect (was reconnect-only); the previously dead `--in`/`--out`/`TWISTER_IN`/`TWISTER_OUT` port overrides are actually wired into the driver and the watcher.

## Phase 5 — Virtual Twister: responsiveness + feel — DONE (2026-09-12)
The `--fake` grid is the instrument when no hardware is attached, but it was a prototype bolted onto a monitoring page. Six commits, each verified in a real browser (Playwright) as well as by tsc + tests; 63 tests green.

- **Perf triage.** `handleIn()` logged *every* inbound message before dispatching, LED frames included — a `JSON.stringify` of a 16-tuple array plus a full `textContent` rebuild of a 4000-char block, i.e. a synchronous layout per frame on the same thread as the drag handler. LED frames now dispatch first and stay out of the log behind a default-off toggle; the log is a 200-line ring buffer flushed once per rAF and skipped while off-screen. Frames are diffed per encoder (was ~80 DOM writes/frame regardless of what moved).
- **File split.** `web/` is now plain ES modules (`index.html`, `style.css`, `flexoki.css`, `bus.js`, `panels.js`, `twister.js`, `lib/knobMath.js`, `app.js`), still no build step; `controlServer` serves the directory with an extension allowlist and a containment check (traversal test confirmed by mutation — without the check, `/../package.json` returns 200). The UI path resolves relative to the module rather than `process.cwd()`.
- **Input rework.** The knob was far harder to grab than it looked: SVG hit-testing follows the dash pattern, and the value arc is drawn with `stroke-dasharray`, so only the *painted* part responded — the target grew with the value, and an encoder at 0 could be dragged from exactly one spot. Measured before: 1 of 19 points around the ring; after: 19 of 19 plus corners. Whole cell is now the target, zone decides knob vs button, press-and-turn works from the centre. Pointer Events + `setPointerCapture` (drag survives leaving the window), velocity acceleration 1x–6x (the same 160px of travel gives 42/85/127 by speed), Alt fine / Cmd coarse, wheel normalised across `deltaMode` (a notch is 3 steps, was 1), keyboard support, turns batched per rAF and chunked to the daemon's ±16 clamp.
- **Prediction.** The ring moves immediately and reconciles after; only the ring is predicted. Verified by stubbing `WebSocket.send` so nothing could reach the daemon — the ring still tracked the drag, then snapped back once the 140ms settle expired. At the clamp there is no visible snap at all, because the local prediction clamps the same way the page does.
- **Frame rate.** Fake mode runs the loop at `max(render.fps, 60)` — the 30fps default exists for the MFT's ~400 msgs/sec LED ceiling (R5), which `FakeMidiDriver` does not have. Measured 61fps / 16ms median gap, was 30/33ms. Hardware mode untouched.
- **Visuals.** Flexoki (raw scale vendored from kepano/flexoki, dark roles per kepano's mapping — every role verified against the scale by computed style, body text at 11.98:1). The grid leads the Control tab in fake mode (`/twister/out/mode` tells the UI which mode it is in) with 131px knobs. Fixed horizontal overflow that had always been present below ~860px (211px of it at phone width); no overflow now from 1280px down to 380px.

**Left open deliberately:** a real 127-entry MFT colour LUT (the hue-anchor approximation stands), true pulse *phase* sync (would need a timestamp on the wire), and per-page encoder labels.

## Phase 6 — Declared page settings — PLANNED (2026-09-12)

Ported from gridmapper, which solved this first (`../gridmapper/src/core/pageModule.ts`,
`src/pages/registry.ts`, and the `SPECS`/`applySetting`/`emitSettings` trio in
`src/pages/isometric.ts`). Scope decision: **`SettingSpec` only**. Auto-discovery
(`registry.ts`) and settings-in-presets are explicitly out — see "Deliberately out
of scope" below.

### Why

Twistermapper has no way for a page to say what it can be tuned. Three symptoms
of the same gap:

- Per-page config is a static blob in `configs/slots.json` applied at construction
  (`Basic.encoderColors`, `StepSeq.tracks`). There is no live path to it.
- Live edits ride bespoke routes (`/config/color/map`, `/config/colorbrightness/...`,
  `/mode`) gated by `BASIC_ONLY_PATTERNS` in `src/cli/index.ts` — a hardcoded list
  that makes the daemon know which pages support which addresses.
- `web/panels.js` hardcodes a Basic-only mode dropdown (`MODE_OPTIONS`).

Meanwhile every page's real tuning sits in module-level consts no one can reach:
Morph's `PHANTOM_DECAY` and `SAVE_PULSE_MS`, StepSeq's per-track `clockIds`,
Hotelier's and Gestures' timings, Basic's `PRECISION_DIVISOR`.

### The shape

1. **`src/core/pageModule.ts`** — a new file holding `SettingSpec`, copied from
   gridmapper so the two repos stay one mental model:
   `{ key, label?, type: "number" | "toggle" | "enum", min?, max?, step?, options?, default }`.

2. **Declaration.** Twistermapper registers pages through the hand-written
   `PAGE_FACTORIES` map in `src/core/systemConfig.ts`, not gridmapper's auto-discovered
   modules — so each page file additionally exports `SETTINGS: SettingSpec[]`, and
   `systemConfig.ts` becomes `name → { create, settings }`. `PAGE_NAMES` keeps working.
   Add `pageSettings(name)` alongside it.

3. **Page side**, three members, exactly gridmapper's pattern:
   - `SPEC_BY_KEY` for validation,
   - `applySetting(key, raw): boolean` — clamps against the spec, returns whether the
     key was known,
   - `settings()` returning the current values, and `emitSettings(ctx)` sending
     `/twister/out/page/<slot>/settings <json>`.
   Announce settings on `init` and `onFocus`, next to the existing `/type` emit.

4. **Routes.** `/twister/in/page/<slot>/setting/<key> <value>` and
   `/twister/in/page/<slot>/settings/get`. Tolerate the terse `/<key> <value>` and
   value-in-path `/<key>/<value>` forms, as gridmapper's page protocol does.

5. **Echo discipline.** A settings write that arrives over OSC must not echo its
   `/settings` reply back to OSC — the same feedback hazard the Phase 5 tail fixed for
   `/index/<i>/set`. Extend the existing origin-aware suppression in `emitOut`
   (`suppressOscEcho` + `ControlOrigin`) to cover setting writes. Do not blanket-suppress
   everything a page emits during OSC dispatch.

6. **Retire `BASIC_ONLY_PATTERNS`.** Once a page validates its own keys, an unknown
   key is simply ignored by the page and the daemon needs no per-page knowledge. The
   existing `/config/color/*` and `/mode` routes fold into Basic's own settings.

7. **Web UI.** The browser cannot import the registry the way gridmapper's sim does,
   so the daemon sends the manifest: add `/twister/out/pagespecs <json>` (page name →
   `SettingSpec[]`) to `controlServer`'s `onConnect` snapshot, next to `/preset/list`
   and `/settings`. `panels.js` renders the focused slot's panel from it — number →
   range+number, toggle → checkbox, enum → select — and the hardcoded mode dropdown
   goes away.

### Candidate settings per page

| Page | Keys |
|---|---|
| Basic | `mode` (enum: note/precision/recall), `precisionDivisor`, palette + brightness (fold in the `/config/*` routes) |
| Morph | `phantomDecay`, `savePulseMs`, the four scene colours |
| StepSeq | per-track `clockIds`, `steps`, latch behaviour |
| Gestures / Hotelier | the recording + playback timings currently const |
| Blank | none — a page with no settings declares nothing and needs no `onOsc` |

### Verification

`applySetting` is pure and per-page, so unit-test it directly: out-of-range clamps,
unknown key returns false, enum rejects a value not in `options`, and a round trip
`settings() → applySetting → settings()`. Add a `controlServer` case for the
`/twister/out/pagespecs` snapshot. `tsc --noEmit` clean, full suite green. Panel
rendering is provisional until Ian looks at it.

### Deliberately out of scope

- **Auto-discovery** (gridmapper's `registry.ts`): top-level-await dynamic import over
  `readdirSync` would have to work under the launchd agent's `dist/` build, and it
  touches `systemConfig`, preset sanitize and the boot path. Worth doing later, on its own.
- **Settings in presets**: extending `serialize()` so a preset captures and restores
  page settings changes the preset file format. gridmapper has the same gap
  (its `STATUS.md` next-item: "one page's serialize() to restore()") — better to let it
  solve that first and port the answer, as with `SettingSpec` itself.

## Phase 7 — Port what gridmapper got right — PLANNED (2026-09-12)

Five items, all confirmed present in `../gridmapper` and absent here. Agreed as
hard yes on 2026-09-12; ordered by cost, not by appetite. Phase 6 (declared page
settings) comes first — **c** is its natural follow-on and assumes it.

**a. Atomic config writes.** `persistSettings()` and `writeActiveConfig()` do a
bare `writeFileSync`. A crash, a full disk or a kill mid-write truncates
`configs/slots.json`, which is the file the daemon boots from. gridmapper's
`src/core/settings.ts` writes to a temp path and `renameSync`s over the target,
behind a 300 ms debounce so a slider drag doesn't thrash the disk. Copy both
halves. Smallest item here and the only one that fixes a live failure mode.

**b. A page-authoring protocol.** `../gridmapper/docs/PAGE_PROTOCOL.md` is
written for "a person or an LLM" and states the boundary hard — you own input
handling and `render()`, you never touch `src/io/`, and importing from there
means you are outside the contract — plus `src/pages/_template.ts`, an inert
template that the loader skips by the `_` prefix. We have `Architecture.md`,
which is a specification, not a guide. The evidence we need one: `HotelierPage`
was made by copying `GesturePage` whole.

**c. Auto-discovery.** `../gridmapper/src/pages/registry.ts` scans the pages
directory at startup and registers every module that exports `page`, so dropping
a file in is the whole install step. Replaces the hand-maintained
`PAGE_FACTORIES` map in `src/core/systemConfig.ts`. The risk to settle first:
it uses top-level await over `readdirSync` + dynamic import, which has to work
under the launchd agent running the compiled `dist/` build, not just under tsx.
Prove that before rewriting the boot path.

**d. A real clock.** `../gridmapper/src/core/clock.ts`: four lanes, each with its
own source (internal/external) and divisor, a master rate in Hz, run state that
deliberately boots stopped, and an optional tick echo. Pages declare a `lane`
setting and follow it. We have `/twister/in/clock <int>` broadcast to every page
and nothing else. **Consider bridging before building** — gridmapper's own
`STATUS.md` lists "twistermapper clock bridge (~20 lines now that lane IDs
match)", which would give us lanes without a second implementation to keep in
sync. Decide bridge-vs-build at the top of this item.

**e. Idle management.** `../gridmapper/src/core/idleManager.ts` sleeps the render
loop after N minutes of no input, with separate timeouts for device-attached and
device-absent, a caffeinate override, and `/wake`//`sleep` routes. Note
gridmapper's own comment: sleeping does not blank the grid, because the device
holds its own LED state — the same is true of the MFT, so an idle Twister keeps
its lights. Lowest urgency of the five (our per-frame cost is microseconds over
16 encoders, not 128 cells), but it is an always-on daemon on a login agent and
a loop that never stops is a loop nobody can reason about.

**Not in scope.** External shift over OSC (`/grid/in/shift`) — only worth it if
Max should drive the overlay remotely; ask before building. `serialize()` →
`restore()` stays parked until gridmapper solves it, per Phase 6's note.

**The traffic is not one-way.** twistermapper has the single-instance guard
gridmapper still lists as a `next`, and now the OSC echo discipline; the
handshake brief at `docs/gridmapper-handshake-prompt.md` asks them to adopt it.

## Known issues / follow-ups
- ~~**Single-slot page change resets all 8 pages**~~ **FIXED (2026-06-01).** `applySystemConfig` now takes `reloadSlots` (default all, for preset load); the `slot/<x>/page` route passes only the edited slot, so the other pages keep their live runtime state. Verified: setting a value on slot D survives changing slot C's page.
- ~~Minor: double page-type broadcast~~ **FIXED (2026-06-01).** Dropped `broadcastPageTypes()`; reloaded pages already re-emit `/type` on `init()`.
- Micro-opt (2026-06-01): `ledReconciler.pruneSentTimestamps` now drops expired entries with one `splice` instead of O(n) `shift` per entry (hot path, ~400 sends/sec).

## Performance headroom (assessed 2026-06-01)
The daemon is extremely light: per 30fps frame it does a cached-frame fetch + 16-encoder field diff + sort of only changed encoders → microseconds, well under 1% of a core. Max DSP runs in its own process/thread, so no CPU starvation. The real ceiling is **MIDI LED throughput** (≤400 msgs/sec, intrinsic to MFT firmware), not CPU. More intensive pages are fine provided: (1) page event handlers stay non-blocking (chunk/defer any multi-ms compute — single event loop), and (2) expect LED *update rate* (not compute) to be throughput-capped.

## Ground rules
- Each phase is its own commit with tests green and `src/Architecture.md` updated in the same commit.
- Existing page semantics unchanged; we add output scheduling + control inputs.
- Headless default stays fully intact (UI is opt-in).
