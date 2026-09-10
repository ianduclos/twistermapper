# Gestures OSC contract

Verified against `src/pages/gestures.ts`, `src/cli/index.ts`, `src/io/osc.ts`,
and `configs/settings.json`. The registered page name is `Gesture` (singular).
Hotelier initially uses the same contract, with page name/type `Hotelier`.

## Transport and addressing

Max sends UDP to twistermapper port **57121**. Twistermapper sends to
**127.0.0.1:57120**; Max listens there. Ports are configured in
`configs/settings.json` and read at daemon startup.

`<slot>` is `a`–`h`; `<id>` is encoder `0`–`15`. Addresses are slot-based,
not page-name-based. Current saved Gestures slots are `a` and `b`.

## Page messages

| # | Direction | Address | Argument and behavior |
| --- | --- | --- | --- |
| 1 | Max → Twister | `/twister/in/page/<slot>/index/<id>/set` | One numeric value, clamped to 0–1. Accepted only while that encoder is in standby; ignored during record/playback. Non-finite values and invalid IDs are ignored. |
| 2 | Twister → Max | `/twister/out/page/<slot>/index/<id>/value` | One normalized number 0–1, rounded to five decimal places. Emitted on turns, accepted sets, and playback changes, deduplicated against the last emitted rounded value. |
| 3 | Twister → Max | `/twister/out/page/<slot>/type` | String `Gesture` on initialization and focus (`Hotelier` for Hotelier). |

The transport encodes whole numbers (including 0 and 1) as OSC `i`; fractional
values as OSC `f`; type names as OSC `s`. Accept both numeric types in Max.

Initialization starts all values at zero but does **not** send a value snapshot.
Focusing also does not send a snapshot. An accepted `/set` can echo `/value`,
subject to deduplication. `/set` also reaches unfocused pages.

There are no page-specific OSC commands for record, play, stop, clear, mode
query, or value dump, and no outgoing press or mode notifications.
`/twister/in/dump/global` does not dump Gestures.

## Controls and timing

Each encoder press-down cycles standby → record → playback → standby;
returning to standby erases the take and retains the current value. Releases
have no page action. Turns edit in standby/record and are ignored in playback.
Neither left nor right shift has a separate page behavior: shifted presses and
turns behave normally. Both modifiers are available for future Hotelier actions.

Playback interpolates on a 20 ms timer and continues emitting while unfocused.
It uses elapsed milliseconds, not incoming OSC clock ticks. Values are native
0–1 numbers internally; the LED ring alone is quantized to 0–127.

## Relevant shared commands

1. `/twister/in/focus/page a` focuses slot a.
2. `/twister/in/slot/a/page Gesture` assigns Gesture to a; use `Hotelier` for
   the prototype. This replaces that slot's page, persists the assignment,
   and clears the active-preset marker.
3. `/twister/in/ping token` receives `/twister/out/pong token`.
4. `/twister/ui/enc/press 0 1` followed by `/twister/ui/enc/press 0 0`
   simulates one knob press/release through the shared input router. It targets
   the focused page, not a named slot; an active Main overlay can intercept it.
   This vocabulary is accepted over OSC as well as the web UI.

Example for Max (while encoder 0 in slot a is in standby):

```text
send:    /twister/in/page/a/index/0/set 0.5
receive: /twister/out/page/a/index/0/value 0.5
```
