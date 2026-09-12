# Prompt: give gridmapper a Max boot handshake over OSC

Build the OSC boot handshake for gridmapper, mirroring the one twistermapper
just got (`../twistermapper/docs/max-handshake.md`, commit `6ca8d20`). The goal:
a Max patch opens, checks the daemon is alive, loads a named preset, restores
page state, and then runs normally — with no chance of the patch feeding back on
itself.

This is already `STATUS.md`'s third `next` item ("Max OSC handshake (systemConfig
+ presetStore), starting with one page's serialize() to restore()"). Treat that
as the brief and this as its detail.

## What already exists — do not rebuild

- `src/core/oscRouter.ts` is the single `(path, args) => void` router; web and Max
  speak the same `/grid/in/...` dialect through it.
- `/grid/in/focus/page <a..h>` → `/grid/out/focus/page <slot>`
- `/grid/in/slot/<a-h>/page <name>` → `/grid/out/slots <8 names>`
- `/grid/in/settings/get` → `/grid/out/settings <json>`; `/grid/in/settings/<section>/<key> <v>`
- `/grid/in/page/<a-h>/<rest>` → `page.onOsc`, which is how per-page settings
  already work: `/setting/<key> <value>`, `/settings/get`, and the page replies
  `/grid/out/page/<slot>/settings <json>`.
- `/grid/in/connect` (force a fresh device handshake), `/grid/in/heartbeat`
  (deliberately inert), `/grid/in/wake`, `/grid/in/sleep`.
- Clock: `/grid/in/clock/{run,tick,reset,get}` → `/grid/out/clock <json>`.
- Ports: UDP **in 57131 / out 57130**, from `configs/settings.json`, boot-only.
- `Page.serialize?()` exists on the interface and `PageManager.serialize(slot)`
  calls it. `meadowphysics` already returns its declared settings plus the whole
  patch; `isometric` returns its settings, chords, patterns and tracks.

## What is missing — build this

**1. Liveness.** There is no ping. Add `/grid/in/ping <token>` →
`/grid/out/pong <token>`, token echoed verbatim, matching twistermapper exactly.
`/grid/in/heartbeat` stays inert; it is a different thing and the comment
explaining why should survive.

**2. Presets.** gridmapper has no preset layer at all. Port twistermapper's,
adapting rather than copying:
- `src/core/systemConfig.ts` — a sanitize→factory path shared by boot and live
  apply, over the existing `registry.ts` (`isPageType`, `pageFactory`), so an
  unknown page name degrades to `DEFAULT_PAGE` instead of throwing.
- `src/core/presetStore.ts` — one JSON file per preset under `configs/presets/`,
  names restricted to `[A-Za-z0-9 _-]{1,48}`, an active-preset marker in the
  persisted config, atomic-ish writes (gridmapper's `settings.ts` already does
  write+rename — follow that, twistermapper does not).
- Routes: `/grid/in/preset/{list,save,load,delete}` →
  `/grid/out/preset/list <names…>` and `/grid/out/preset/active <name>`.

**3. `/grid/out/preset/active` is the completion signal.** It must be emitted
*after* every slot's page is constructed and has announced itself. Max waits on
it and sends nothing before it. An empty string means the load failed.

**4. serialize() → restore().** This is where gridmapper goes further than
twistermapper, and it is the interesting half. twistermapper's preset is
structural only (which page is in which slot), so Max has to push every value
back in afterwards. gridmapper's pages already serialize their real state, so a
preset can restore it and Max only pushes what is genuinely live.
- Add the inverse to the `Page` interface: `restore?(config: unknown): void`,
  defensive about shape — a preset written by an older build must not throw.
- Implement it on **one page first** (isometric is the richer test: settings,
  8 chord presets, 4 pattern recorders, 4 tracks; meadowphysics is the simpler
  one if you want the smaller first step). Round-trip test it:
  serialize → write → read → restore → serialize, and assert deep equality.
- Transient runtime state must not survive the round trip — held keys, the
  arpeggiator's current voice, a recorder mid-take. `docs/PAGE_PROTOCOL.md` §
  on serialize already says this; keep it true and update the doc.

**5. Echo discipline — the part that is easy to miss.** An OSC-originated
`/grid/in/page/<slot>/setting/<key>` currently ends with the page re-emitting
`/grid/out/page/<slot>/settings`, so a patch that both sends settings and listens
for them feeds back on itself. Adopt twistermapper's fix: give the router an
`origin: "osc" | "ui"` parameter, and while dispatching an OSC-originated setting
write, suppress the page's reply on the OSC wire only — the web UI must still
receive it, because it is not what sent the message, and a setting changed *from*
the web UI must still reach Max. See `emitOut`/`suppressOscEcho` in
`../twistermapper/src/cli/index.ts`.
Note the asymmetry with twistermapper: there the suppressed route is a value set
(`/index/<i>/set`); here it is a settings write. Same principle, different path —
do not blanket-suppress everything a page emits during OSC dispatch.

**6. Write it down.** `docs/max-handshake.md`, mirroring twistermapper's:
transport, the phases, the "also available" addresses, and a failure-mode table.
Add the new routes to whatever the OSC reference is, and a line to
`docs/PAGE_PROTOCOL.md` about `restore?()` so page authors know it exists.

## The handshake the patch will follow

1. `/grid/in/ping <token>` → wait for `/grid/out/pong <token>`; no reply ≈ 500 ms
   means the daemon is down. gridmapper announces nothing at boot, so the patch
   always initiates.
2. `/grid/in/preset/load <name>` → wait for `/grid/out/preset/active <name>`.
   Along the way it will see `/grid/out/slots`, each page's
   `/grid/out/page/<slot>/type`, and each page's `/settings`.
3. Push whatever the patch owns that the preset does not:
   `/grid/in/page/<slot>/setting/<key> <value>`. Nothing echoes back.
4. Run: `/grid/out/page/<slot>/...` note and state messages as now.
5. `/grid/in/settings/get`, `/grid/in/page/<slot>/settings/get` and
   `/grid/in/clock/get` are the re-sync path if the patch reopens while the
   daemon keeps running — no reload needed.

## Constraints

- Do not break the page-authoring contract: pages never touch `src/io/`, never
  decide when to push, and a page with no settings still needs no `onOsc`,
  `serialize` or `restore`.
- Auto-discovery stays — no central page list to edit.
- `npx tsc --noEmit` clean and the full vitest suite green (287 tests at last
  count) before you claim it works. Hardware behavior is provisional until Ian
  plays it.
- Ports and the two-tier settings model (`osc.*` boot-only, everything else live
  and persisted) are as documented in `src/core/settings.ts` — do not quietly
  make `osc.*` live-settable.
