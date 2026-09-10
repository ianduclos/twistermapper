---
project: twistermapper
updated: 2026-07-19
entries: 1
---

### LED flash-to-zero on hotplug reconnect — opened 2026-07-19, owner: claude
- done: Ian reported knob LEDs jumping to 0 during normal use. Log shows a burst of `[Hotplug] Twister reconnected → splash` cycles right after each daemon (re)start, each preceded by a `MidiOutCore::getPortName: the 'portNumber' argument (N) is invalid` warning and a fallback to the wrong port ("Midi Bus Bus 1") — i.e. the watcher briefly thinks the Twister disconnected, rebuilds the driver, and replays the boot splash, which is the flash Ian sees. `ioreg -p IOUSB` shows the physical device staying registered/active/busy-0 throughout, so this points away from a cable/hardware fault and at `startTwisterWatcher()`'s polling itself: `hasTwisterOutput()` (src/cli/index.ts, near `rebuildIoAndSplash`) spins up a brand-new `midiLib.Output()` purely to enumerate ports every 1.5s, then closes it — plausibly racing CoreMIDI's port list against the real open output and producing false disconnect/reconnect flips.
- next: confirm it's still happening during idle/normal use (not just post-restart jitter) by watching `~/Library/Logs/twistermapper.log` for `Hotplug`/`getPortName` lines with the agent running and untouched for a few minutes. If confirmed, stop treating one failed enumeration as a real disconnect — e.g. reuse a single long-lived `Output()` for the poll instead of recreating it every cycle, or require two consecutive misses before declaring "disconnected."
- blockers: needs to be watched live against the real hardware; last input from Ian was "yeah still there" but the session moved to the Blank-page/OSC-port feature work before re-confirming post-diagnosis.
- context: `src/cli/index.ts` — `startTwisterWatcher()`, `hasTwisterOutput()`, `rebuildIoAndSplash()`; `~/Library/Logs/twistermapper.log`.

# twistermapper — Session Handoff

**Read this first.** Single shared source of truth for *where we are* and
*what changed*, across sessions and across agents — **Claude Code** (main
environment) and **Codex** (backup bench). It lives in the repo so it
travels with the code. Any `###` entries between the frontmatter and this
title are open wrapup-contract items (cross-session work); the sections
below are this project's own session ritual.

## Who does what
- **Claude Code** — primary environment; structural & architectural work
  (pageManager, reconciler, render loop, driver, OSC protocol) and ecosystem
  publishing (`STATUS.md`, the cross-project change feed, pushes).
- **Codex** — backup bench, two modes: (1) **heavy mechanical work under a
  written brief** (a Session-log "next" item, a contract entry above, or a
  spec file) — refactor sweeps, test buildout, iterate-until-green loops;
  (2) **overflow** when Claude is at usage limits. Structural changes need a
  brief that says so; if a task outgrows its brief, log it and stop rather
  than improvise. More authority (STATUS.md, push, agent restarts) only when
  Ian explicitly grants it.
- **Ian** — decides direction, turns the knobs, grants exceptions.
- Deep reference: `src/Architecture.md` (source of truth, R1–R9);
  `CLAUDE.md` (commands, invariants, gotchas).

## Session protocol
**At start:** read *Current state* + the top 2–3 *Session log* entries. For
behavior changes, read the relevant `src/Architecture.md` section first.

**During:** the device map in `midiDriver.ts` is sacred; deltas stay
relative; don't break R1–R9 without intent stated in your brief.

**Before finishing:** `npx tsc --noEmit` clean, `npm test` green. Live
checks via `--fake` need the launchd agent stopped first
(`./scripts/agent.sh stop` / `start`).

**At end:** (1) update *Current state* if it changed; (2) **prepend** a
*Session log* entry — date · agent · what changed (+ files) · verified? ·
next · any new gotcha; (3) commit (conventional style); if behavior changed,
`src/Architecture.md` was updated in the same change. Keep entries short
and factual.

---

## Current state
- **Prototype:** `Hotelier` copies Gestures, available in source via UI/OSC page
  selection; not assigned to a slot or deployed. See `docs/gestures-osc.md`.
- **Run:** `npm run dev` (daemon; needs the MFT), `-- --ui` for the web UI,
  `-- --fake` for the virtual Twister (no hardware). `npm test` ·
  `npx tsc --noEmit` · `npm run build`. Diagnostics: `probe`, `raw:probe`,
  `log`, `osc:send`.
- **Deployed:** launchd agent `com.ianduclos.twistermapper` runs `dist/`
  always-on (`./scripts/agent.sh {stop|start|status|logs}`) — it holds the
  MIDI/OSC ports and the single-instance lock, so stop it before any dev run.
- **Live state and next steps live in `STATUS.md`** (Phases 1–4 done: render
  loop, StepSeq, global presets, virtual Twister; 32/32 tests green). Known
  in-progress: StepSeq "latch in shift" interaction — discuss before
  "fixing" (CLAUDE.md known gaps).

---

## Session log (newest first)
### 2026-09-10 — Codex
Added `HotelierPage` as an independent copy of GesturePage, registered as
`Hotelier` in the factory and web UI selector. No slot assignment changed.
Documented the prototype in `src/Architecture.md` and the Gestures OSC
contract/unused shifts in `docs/gestures-osc.md`.
- **Verified?** `npx tsc --noEmit` clean; 32/32 tests green; copy diff reviewed.
  Hardware, Max, and web UI behavior are ready for Ian to check, not live-tested.
- **Deployment:** no build or agent restart; running `dist/` is unchanged.
- **Next:** choose a Hotelier slot and specify gig-specific controls.
- **Gotcha:** imported `~/.Codex/HOST.md` was absent; cross-project feed location
  could not be resolved. Changes stay within this repo.

### 2026-07-19 — Claude
Added `BlankPage` (inert no-op, LEDs off — `src/pages/blank.ts`, registered in
`PAGE_FACTORIES`) and moved OSC in/out UDP ports from hardcoded 57121/57120
to `configs/settings.json` → `osc.inPort`/`osc.outPort` (same defaults, read
once at boot before the transport binds; not live-settable like fps).
Also investigated an LED-flash-to-zero report — root cause traced to the
hotplug watcher's polling method but not yet confirmed live; see the open
handoff entry above.
- **Verified?** Yes — `--fake` mode: bound to a non-default configured port,
  correct `EADDRINUSE` on a taken port, `/twister/out/page/<slot>/type
  "Blank"` + all-zero LED mirror over the web UI socket. `tsc --noEmit`
  clean, 32/32 tests green.
- **Next:** confirm/fix the hotplug polling issue (see handoff entry);
  rebuild + restart the launchd agent to deploy Blank/OSC-port when ready
  (not done this session — agent still runs the pre-change build).
### 2026-07-07 — Claude
Established the cross-agent handoff layer: this file + `AGENTS.md` (Codex
joins as backup bench — written-brief and overflow lanes), mirroring the
gridmapper pattern. No code changes.
- **Verified?** N/A (docs only).
- **Next:** per `STATUS.md` — finish StepSeq latch-in-shift; consider
  per-track mute/loop + playhead viz in the web UI.
