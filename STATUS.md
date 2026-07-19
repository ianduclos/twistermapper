---
project: twistermapper
state: active
updated: 2026-07-19
machine: mac
summary: Blank page + configurable OSC ports committed (32/32 tests green); a knob-LED-flash-to-zero bug is under active investigation, likely in the hotplug watcher's own polling, not confirmed fixed.
next:
  - Confirm/fix the hotplug-polling LED-flash bug (see HANDOFF.md)
  - Rebuild + restart the launchd agent to deploy Blank page / OSC-port settings (not yet deployed)
  - Finish StepSeq latch-in-shift interaction (in-progress, see CLAUDE.md known gaps)
  - Consider per-track mute/loop + playhead viz in web UI (roadmap follow-ups)
handoff_for: claude
---

# twistermapper — status

Phases 1–4 done (render loop, StepSeq, global presets, virtual Twister +
ops). New: `BlankPage` (inert, LEDs off) and OSC in/out ports moved to
`configs/settings.json` (defaults unchanged, boot-time only). Deployed via
launchd agent (`./scripts/agent.sh`); dev sessions must stop the agent first
(port/lock gotcha in CLAUDE.md). Source of truth for behavior and rules
R1–R9 is `src/Architecture.md` — it wins over CLAUDE.md on disagreement.
Sibling of `../gridmapper` (shared architecture, different driver/page
semantics).

Open issue: Ian reported knob LEDs flashing to 0 during use. Traced to
`startTwisterWatcher()`'s hotplug polling likely producing false
disconnect/reconnect cycles (each one replays the boot splash). Root cause
identified but not yet confirmed live or fixed — see `HANDOFF.md`.

Test suites: 7 (ledReconciler, renderLoop, inputDecoder, controlServer,
singleInstance, scale, fakeMidiDriver), 32 tests, all green as of
2026-07-19. The launchd agent still runs the pre-session build (dist/ not
rebuilt/redeployed this session).
