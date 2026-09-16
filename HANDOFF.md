---
project: twistermapper
updated: 2026-09-12
entries: 2
---

### Morph page flashing — opened 2026-09-12, owner: claude
- done: Ian reported "crazy flashing" on switching a slot to Morph, and suspects it is not confined to that page. Ruled out by reading: there is only one writer to the LEDs (`renderTick`, `src/cli/index.ts`), Morph's frame is deterministic and cannot oscillate on its own, and the web UI's page selector cannot feed back (`renderLayout()` rebuilds the `<select>` rather than setting its value). Established that Morph is in no slot in the committed config, so it was loaded live via the Setup tab — meaning the suspect path is `applySystemConfig` → `pm.load` → fresh page → focus repaint, not Morph's steady state. Separately found a real reconciler defect while looking: when an encoder enters `pulse`, the suppressed `ledBrightness` is never cleared from `pending` and the cache is never updated, so that encoder stays in the pending map forever and the brightness change it carried is silently lost (`src/render/ledReconciler.ts`, the `skipLedBrightness` branch). Not yet tied to the flashing. Morph pulses on scene save; Gestures pulses while recording.
- next: `./scripts/agent.sh stop`, then `npm run dev -- --fake`, switch a slot to Morph in the Setup tab and watch the browser grid. Flashing in the browser too ⇒ daemon-side, chase it from the LED mirror. Hardware only ⇒ it is the hotplug entry below replaying the boot splash, and the two reports are one bug.
- blockers: needs a live run; the agent holds the MIDI/OSC ports and the single-instance lock, so it must be stopped first and restarted after.
- context: `src/cli/index.ts` (`renderTick`, `applySystemConfig`, `currentDesired`); `src/render/ledReconciler.ts`; `src/pages/morph.ts`; the entry below.

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
- **Runtime (2026-09-16):** launchd agent `com.ianduclos.twistermapper` is
  stopped; `npm run dev -- --fake` is serving the virtual Twister on 57190
  at Ian's request. To return to hardware, stop that dev process and run
  `./scripts/agent.sh start` with the Twister connected. The rebuilt `dist/`
  rejects missing MIDI devices instead of selecting an unrelated bus.
- **Live state and next steps live in `STATUS.md`** (Phases 1–4 done: render
  loop, StepSeq, global presets, virtual Twister; 32/32 tests green). Known
  in-progress: StepSeq "latch in shift" interaction — discuss before
  "fixing" (CLAUDE.md known gaps).

---

## Session log (newest first)
### 2026-09-16 — Codex
Diagnosed active slot A (Hotelier) flashing: live LED mirror cycled record →
playback → standby at ~30fps; passive monitoring of Midi Bus Bus 1 captured
600 LED messages in two seconds. No Twister input was enumerated, and the
running daemon's last startup selected that bus for both input and output.
RGB notes therefore returned as encoder presses. No new hotplug log entries
occurred during the report; this is a confirmed loopback cause, distinct from
the older suspected polling issue.
- **Changed:** `src/io/midiDriver.ts` now rejects unmatched port names instead
  of falling back to another device; closes partially opened ports on failure.
  Device mappings unchanged. Added six driver tests; updated Architecture.md.
- **Verified:** three regressions failed before the fix; 69/69 tests pass,
  `npx tsc --noEmit` and build pass. Compiled driver rejected the real absent
  Twister and listed available ports. Visual outcome awaits Ian's check.
- **Deployment:** rebuilt `dist/`. Ian then requested Twister or virtual input,
  never fallback; stopped the looping launchd agent and started
  `npm run dev -- --fake`. Live socket reports fake mode and one unchanged
  LED snapshot across five seconds, replacing the ~30fps mode oscillation.
  No global launchd configuration was changed; virtual mode is this session's
  dev process. Transient recordings/values were reset by the switch.
- **Next:** Ian checks the browser. For hardware, stop the virtual dev process,
  reconnect Twister, and start the agent. Hardware mode fails startup while
  absent (launchd KeepAlive retries). Investigate hotplug polling separately
  if needed.
- **Gotcha:** imported `~/.Codex/HOST.md` remains absent; no cross-project feed
  location available. STATUS.md untouched per project instructions.

### 2026-09-12 — Claude
Two sessions in one day. The first (separate, hit the usage limit mid-question)
landed Phase 5: six commits reworking the virtual Twister and giving the web UI
its design pass. This one answered the three questions left hanging on that
limit and built the Max boot handshake.
- **Handshake:** `docs/max-handshake.md` — ping/pong liveness,
  `/twister/in/preset/load` with `/twister/out/preset/active` as the completion
  signal, the value push, failure modes. Behavior change behind it: a value set
  arriving over OSC no longer echoes back as `/index/<i>/value`, so a patch that
  both sends and listens cannot feed back on itself. `routeControl` now takes an
  origin, so web-UI sets still reach Max and the UI still sees Max's sets.
  Recorded in `src/Architecture.md` under "In (page)".
- **UI:** per-row Overwrite button on presets (saving under an existing name
  always replaced it; there was just no way to reach that without retyping).
  Knobs lost the specular — bloom and cap stay, both `ledBrightness`-driven.
- **Config:** `configs/presets/hotelier.json` committed as the gig layout the
  handshake loads by name; `slots.json` now carries it as active.
- **Planned:** roadmap Phase 6 — declared page settings ported from gridmapper's
  `SettingSpec`. Scope settled, auto-discovery and settings-in-presets scoped out
  with reasons.
- **Cross-repo:** `docs/gridmapper-handshake-prompt.md`, a ready-to-use brief for
  giving gridmapper the same handshake. Nothing written into that repo.
- **Verified?** `tsc --noEmit` clean, 63/63 tests green. The echo suppression is
  NOT live-tested against a running daemon, and the UI changes are ready for Ian
  to look at, not confirmed.
- **Deployment:** none. `dist/` is from 01:57 and predates the echo suppression;
  the agent is up and still running that build.
- **Next:** rebuild + restart the agent; live-verify the echo suppression; the
  Morph flashing entry above.

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
