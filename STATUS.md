---
project: twistermapper
state: active
updated: 2026-09-12
machine: mac
summary: The web UI's Phase 5 design pass landed and the daemon gained a Max boot handshake — ping/pong, preset load, and value sets that no longer echo back — but the launchd agent still runs a pre-handshake build and a Morph page flashing report is undiagnosed.
next:
  - Rebuild and restart the launchd agent — dist/ predates today's echo suppression, so the running daemon still echoes
  - Live-verify the echo suppression, then build the Max side against docs/max-handshake.md
  - Diagnose the Morph page flashing Ian reported (see HANDOFF.md)
  - Build Phase 6 — declared page settings, planned in docs/roadmap.md
  - Confirm or close the July hotplug LED-flash bug (see HANDOFF.md)
handoff_for: claude
---

# twistermapper — status

Headless MIDI Fighter Twister ↔ OSC daemon. Source of truth for behavior and
rules R1–R10 is `src/Architecture.md` — it wins over `CLAUDE.md` on
disagreement. Sibling of `../gridmapper` (shared architecture, different
driver and page semantics).

**Phases 1–5 done.** Render loop, StepSeq, global presets, virtual Twister, and
— as of 2026-09-12 — the web UI reworked from a monitoring page into an
instrument: encoders on one plate, Flexoki palette vendored from source,
emissive LEDs, prediction on the ring, 60fps in `--fake`. Phase 5's three
deliberate omissions (a real 127-entry MFT colour LUT, true pulse *phase* sync,
per-page encoder labels) stand. 63 tests green.

**Max boot handshake.** `docs/max-handshake.md` is the contract a patch follows
to bring the Twister up in a known state: `/twister/in/ping` → `/pong` for
liveness, `/twister/in/preset/load <name>` with `/twister/out/preset/active` as
the completion signal, then a push of values over
`/twister/in/page/<slot>/index/<i>/set`. The behavior change that made it safe:
a value set arriving **over OSC** no longer echoes back as `/index/<i>/value`,
so a patch that both sends and listens cannot feed back on itself. Sets arriving
from the web UI still emit to OSC, and the UI still sees Max's sets —
`routeControl` takes an origin to tell them apart. Documented in
`src/Architecture.md` under "In (page)".

**Deployed layout.** `configs/presets/hotelier.json` is the gig layout the
handshake loads by name (a: Hotelier, b: Gesture, c–h: Basic) and is the active
config. StepSeq is not in it; a preset naming it brings it back.

**Not deployed.** The launchd agent (`com.ianduclos.twistermapper`) is running,
but `dist/` was built at 01:57 today — before the echo suppression. Until
`npm run build` + `./scripts/agent.sh restart`, the live daemon still echoes.
Dev runs need the agent stopped first (it holds the MIDI/OSC ports and the
single-instance lock).

**Planned.** `docs/roadmap.md` Phase 6 — declared page settings, ported from
gridmapper's `SettingSpec`. Scope is settled: pages export a `SETTINGS` array
alongside their factory, the browser gets the manifest as
`/twister/out/pagespecs`, and `BASIC_ONLY_PATTERNS` retires. Auto-discovery and
settings-in-presets are scoped out with reasons.

**Cross-repo.** `docs/gridmapper-handshake-prompt.md` is a ready-to-use brief
for giving gridmapper the same handshake — it lacks ping/pong and any preset
layer, and has the same settings-echo hazard. Nothing has been written into that
repo.
