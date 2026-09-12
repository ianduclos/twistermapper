# Max ↔ daemon boot handshake

The contract a Max patch follows to bring the Twister up in a known state when
the patch opens: check the daemon is alive, load a named preset, push the
patch's current parameter values into the pages, then run normally.

Written against the daemon as of 2026-09-12. Addresses are the same ones the
web UI uses — both go through `routeControl()` in `src/cli/index.ts`.

## Transport

- Daemon **listens** on UDP **57121**, **sends** on UDP **57120**, localhost.
- Both come from `configs/settings.json` → `osc.inPort` / `osc.outPort`, read
  once at boot. Changing them needs a daemon restart.
- Floats on the wire are normalized `0..1`, ≤5 decimal places.
- Slots are letters `a`–`h`; encoder indices are `0`–`15`.

## Phase 0 — is the daemon up?

    Max  → /twister/in/ping <token>
    Max  ← /twister/out/pong <token>

`<token>` is echoed verbatim (int or string); use it to match the reply to the
request. No pong within ~500 ms means the daemon isn't running — the launchd
agent (`com.ianduclos.twistermapper`) is stopped, or a dev session has the
ports. The daemon emits nothing unsolicited at boot, so **Max must initiate**;
there is no "daemon came up" broadcast to wait on.

## Phase 1 — load the preset

    Max  → /twister/in/preset/load hotelier

The daemon rebuilds all eight pages from `configs/presets/hotelier.json` and
emits, in this order:

    Max  ← /twister/out/page/<slot>/type <PageName>    (once per slot, a..h)
    Max  ← /twister/out/preset/active hotelier

**Wait for `/twister/out/preset/active` carrying the name you asked for.** That
is the completion signal; the pages do not exist until it arrives. If it comes
back empty (`""`) or with a different name, the load failed — bad name, or no
such file. The `hotelier` preset is currently `a: Hotelier`, `b: Gesture`,
`c`–`h: Basic`.

Loading a preset resets every page's live values to 0. That is the point:
phase 2 is what puts them where the patch thinks they are.

## Phase 2 — push the patch's values in

For each parameter the patch owns:

    Max  → /twister/in/page/<slot>/index/<i>/set <0..1>

The daemon clamps to `0..1`, stores it, and repaints that encoder's LEDs.

- **Nothing is echoed back.** A value set that arrives over OSC deliberately
  does not emit a `/value` reply, so the patch cannot feed back on itself and
  needs no gate around its receive. (The web UI still sees the change — it is
  not the thing that sent it.)
- **Hotelier and Gesture only accept `/set` on an encoder in `standby`** — not
  one that is recording or playing back. Straight after a preset load everything
  is in standby, so a boot-time push always lands. Mid-session it may not: ask
  for `/twister/in/dump/global` and read `/index/all/mode` to find out which
  encoders are writable.
- A burst of 16–32 sets is fine. OSC input is not rate limited; the LED
  reconciler is (R5: 64 msgs/5 ms, 400 msgs/sec), so the rings settle over a
  frame or two rather than instantly. Nothing is dropped.

## Phase 3 — normal running

Unchanged from what the patch already does:

    Max  ← /twister/out/page/<slot>/index/<i>/value <0..1>   knob turned
    Max  ← /twister/out/page/<slot>/index/<i>/press <0|1>    knob pressed
                                                             (Basic in `note`
                                                             mode; Morph faders)

## Also available

    /twister/in/focus/page <a..h>     switch the focused page
    → /twister/out/focus/page <slot>  confirmation

    /twister/in/dump/global           ask every slot to re-emit its state — the
                                      re-sync path when the patch reopens while
                                      the daemon keeps running, instead of
                                      re-running phase 1

Pages that implement `/dump` answer it; pages that don't ignore it. Basic sends
its palette and `/index/all/value`; Gesture and Hotelier send
`/index/all/value` plus `/index/all/mode` (sixteen of `standby|record|play`);
Morph sends its four scene vectors. All of them re-send `/page/<slot>/type`
first.

`/index/all/mode` is the one to read before pushing: `/set` is only accepted on
an encoder in `standby`, so the mode array tells the patch which encoders it may
write to right now. Straight after a preset load every encoder is in standby.

A dump deliberately ignores the per-encoder dedup, so it always reports the full
picture even if nothing has changed since the last message.

    /twister/in/preset/list           → /twister/out/preset/list <names…>
    /twister/in/preset/save <name>    overwrite/create from the live layout
    /twister/in/slot/<a-h>/page <P>   change one slot without disturbing the
                                      other seven

Basic pages also emit a bulk dump in response to `/dump`:

    /twister/out/page/<slot>/index/all/value <16 floats>

## Failure modes worth handling in the patch

| Symptom | Meaning |
|---|---|
| No `/pong` | Daemon down, or ports held by a dev run |
| `/preset/active ""` | Load failed — bad name or missing file |
| `/set` has no visible effect on slot `a` | That Hotelier encoder is not in standby — check `/index/all/mode` |
| Values stop arriving mid-session | Daemon restarted; re-run phases 0–2 |

Because the daemon announces nothing on restart, give the patch a manual
"re-handshake" button rather than relying on it noticing.
