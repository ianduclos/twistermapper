# Agent guide — twistermapper

For coding agents that aren't Claude Code — currently **Codex** (backup
bench). Claude Code is the primary architecture/coding environment.

**Read `HANDOFF.md` first** — who does what, session protocol, current state.

Then, as needed:
- `CLAUDE.md` — commands, layout, invariants, the launchd gotcha.
- `src/Architecture.md` — **source of truth** for behavior, device mappings,
  and rules R1–R9. When it and CLAUDE.md disagree, Architecture.md wins; if
  you change behavior, update Architecture.md in the same change.

Invariants (summaries — full versions in CLAUDE.md / Architecture.md):
- **Device map is sacred.** Channels/CC/note numbers in
  `src/io/midiDriver.ts` match the working hardware; core/page code works in
  human-readable values, only the driver humanizes→device.
- Deltas, not absolutes (R1) — never clamp raw encoder deltas.
- Pulse precedence (R3), flush order per encoder (R4), rate caps (R5),
  focus routing (R6).

Verify before finishing: `npx tsc --noEmit` clean and `npm test` green
(vitest). For live checks, `npm run dev -- --fake` runs a virtual Twister
(no hardware; web UI mirrors LEDs) — but **stop the launchd agent first**
(`./scripts/agent.sh stop`; it holds the OSC ports + single-instance lock;
`start` again after). The agent runs `dist/`, so `npm run build` if it
should pick up your changes — and say so in your log entry.

Working agreement: Codex works from a **brief** — a `HANDOFF.md` item or
spec Claude wrote, or an explicit prompt from Ian. Heavy mechanical work and
overflow (when Claude is at usage limits) are its lane; structural changes
(pageManager / reconciler / render loop / driver) need a brief that says so.
When done: prepend a Session log entry to `HANDOFF.md`, commit (conventional
style). Don't push and don't edit `STATUS.md` unless Ian explicitly asks.
