---
project: twistermapper
updated: 2026-07-07
entries: 0
---

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
### 2026-07-07 — Claude
Established the cross-agent handoff layer: this file + `AGENTS.md` (Codex
joins as backup bench — written-brief and overflow lanes), mirroring the
gridmapper pattern. No code changes.
- **Verified?** N/A (docs only).
- **Next:** per `STATUS.md` — finish StepSeq latch-in-shift; consider
  per-track mute/loop + playhead viz in the web UI.
