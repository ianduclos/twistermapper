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
