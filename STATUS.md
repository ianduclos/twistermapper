---
project: twistermapper
state: active
updated: 2026-07-05
machine: mac
summary: Phase 4 committed — virtual Twister (--fake, web-UI 4x4 grid), ping/pong liveness, hotplug pause, working port overrides; 32/32 tests green, launchd agent runs the Phase 4 build.
next:
  - Finish StepSeq latch-in-shift interaction (in-progress, see CLAUDE.md known gaps)
  - Consider per-track mute/loop + playhead viz in web UI (roadmap follow-ups)
  - Native-mode RGB-over-SysEx driver feature (true color; enable in MFT editor first)
handoff_for: null
---

# twistermapper — status

Phases 1–4 done (render loop, StepSeq, global presets, virtual Twister +
ops). Deployed via launchd agent (`./scripts/agent.sh`); dev sessions must
stop the agent first (port/lock gotcha in CLAUDE.md). Source of truth for
behavior and rules R1–R9 is `src/Architecture.md` — it wins over CLAUDE.md
on disagreement. Sibling of `../gridmapper` (shared architecture, different
driver/page semantics).

Test suites: 7 (ledReconciler, renderLoop, inputDecoder, controlServer,
singleInstance, scale, fakeMidiDriver), 32 tests, all green as of
2026-07-05.
