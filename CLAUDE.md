# CLAUDE.md

Guidance for Claude Code when working in this repo. Keep this file short and current; the deep spec lives in **`src/Architecture.md`** — treat that as the source of truth for behavior, device mappings, and rules (R1–R9). When behavior and this file disagree, Architecture.md wins; if you change behavior, update Architecture.md in the same change.

## What this is

Headless Node/TypeScript daemon that sits between a **MIDI Fighter Twister (MFT)** and a DAW/Max world over **OSC**. It decouples encoder input (relative deltas) from LED feedback (rendered from our own virtual page state), supports 8 swappable "pages" (slots A–H), and owns the LEDs through a diffing reconciler under strict MIDI rate limits. No GUI.

## Commands

- `npm run dev` — run the daemon via tsx (`src/cli/index.ts`). Needs the MFT plugged in for real LEDs; OSC in 57121 / out 57120.
- `npm run dev -- --ui` — also start the optional web UI (default http://localhost:57190; or `TWISTER_UI=1`, port via `--ui-port`/`TWISTER_UI_PORT`). Off by default; daemon is fully headless without it.
- `npm run build` — `tsc` typecheck + emit to `dist/`. Use `npx tsc --noEmit` for a quick check.
- `npm test` — vitest (no tests exist yet; see Known gaps).
- Diagnostic CLIs: `npm run probe` (LED probe), `npm run raw:probe` (raw MIDI), `npm run log` (log input), `npm run osc:send`.

Port override: `--in`/`--out` flags or `TWISTER_IN`/`TWISTER_OUT` env (substring match on port name; defaults to "twister").

## Layout

- `src/core/` — `types.ts` (Page/LedFrame/InputEvent contracts), `pageManager.ts` (focus + routing + dirty→render→push).
- `src/io/` — `midiDriver.ts` (the ONLY place that knows device channels/CC numbers), `inputDecoder.ts` (raw MIDI → InputEvent), `osc.ts` (UDP transport), `controlServer.ts` (optional HTTP+WS for the web UI).
- `src/render/ledReconciler.ts` — per-encoder diff, flush ordering, pulse precedence, rate limiting. `renderLoop.ts` — fixed-rate loop, the single LED output path.
- `web/index.html` — the optional web UI (no build step): pulse generator, page focus, live monitor. Talks WS `{path,args}` mirroring OSC.
- `src/pages/` — `basic.ts`, `gestures.ts`, `stepSeq.ts` (page prototypes).
- `src/boot/bootSplashes.ts` — startup warm-up + deterministic settle paint.
- `configs/slots.json` — slot→page mapping + per-page config. `configs/settings.json` — main-button interaction timings.

## Invariants (do not break without intent)

- **Device map is sacred.** Channels/CC/note numbers in `midiDriver.ts` match the working hardware setup. Core/page code works in human-readable values; only the driver humanizes→device. See Architecture.md "Device map".
- **Deltas, not absolutes** (R1): encoder turns are relative; pages accumulate and clamp 0..127. Never clamp raw deltas.
- **Pulse precedence** (R3): pulse implies full LED brightness that burst; sending brightness cancels pulse.
- **Flush order per encoder** (R4): ledBrightness → ringBrightness → rgb → ring.
- **Rate caps** (R5): 64 msgs / 5ms burst, 400 msgs/sec rolling, 128 one-time focus paint.
- **Focus routing** (R6): only the focused page receives input; unfocused pages may keep timers running but their LED frames are not pushed until focused.

## launchd agent (always-on)

A login agent (`com.ianduclos.twistermapper`) runs the compiled daemon at login with KeepAlive. Manage it with `./scripts/agent.sh {install|uninstall|start|stop|status|logs}`; log at `~/Library/Logs/twistermapper.log`.

**Dev gotcha:** the agent holds the MIDI/OSC ports and the single-instance lock, so `npm run dev` will print `Already running … Exiting` while the agent is up. Run `./scripts/agent.sh stop` before dev, `start` after. (Or `TWISTER_ALLOW_MULTI=1` to bypass the guard — but it'll fight the agent for the device.) The agent runs `dist/`, so `npm run build` after changes you want it to pick up.

## Known gaps / WIP (discuss before "fixing")

- **StepSeq** commit notes "only lacks latch in shift" — an in-progress interaction not finished.
- Possible future work: per-track mute/loop controls + playhead viz in the web UI; remote param control; standalone-binary/tray packaging for distribution. See `docs/roadmap.md`.

## Conventions

- NodeNext ESM: **relative imports must use `.js` extensions** even from `.ts` files.
- Tabs for indentation (matches existing files).
- JSON config is sanitized defensively on load (clamp to device ranges, tolerate malformed/missing) — follow that pattern when adding config.
- OSC floats: ≤5 decimals; values normalized value/127 outbound, rounded back inbound.
