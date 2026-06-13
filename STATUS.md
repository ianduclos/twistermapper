---
project: twistermapper
state: active
updated: 2026-06-13
machine: mac
summary: Headless MFT↔OSC daemon working — 8 page slots, LED reconciler under MIDI rate limits, optional web UI; recent work on basic-mode presses and morph behavior.
next:
  - Add tests (vitest is wired but no tests exist — the known gap)
handoff_for: null
---

# twistermapper — status

Seeded 2026-06-13 by the hub from repo docs and git history; refine on next
real session. Source of truth for behavior and rules R1–R9 is
`src/Architecture.md` — it wins over CLAUDE.md on disagreement. Sibling of
`../gridmapper` (shared architecture, different driver/page semantics).
