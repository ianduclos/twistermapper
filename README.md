# Twister Manager 2

Headless Node.js/TypeScript daemon that drives a MIDI Fighter Twister (MFT), renders LEDs, and proxies MIDI↔OSC for multiple “pages” of controls. The process boots with a splash animation, then repaints the focused page twice to settle device brightness.

## Page Prototypes

- **BasicPage** – 16 continuous controls (0–127), per-encoder color/brightness palette, press-to-max-brightness feedback, OSC mirroring (`/twister_out/page_{slot}`). Accepts `/twister_in/page_{slot}/set`, optional palette updates, and `/dump` requests.
- **GesturePage** – Per-encoder record/playback looper with standby/record/playback states, pulse animation on record, smooth looping playback, and OSC mirroring while values evolve.

## Overlay & Interaction

- Lower-right *main* button: hold ≥ `mainHoldThresholdMs` (default 200 ms) for a momentary overlay, double-click within `mainDoubleClickMs` (default 320 ms) to toggle latch ON/OFF. Single short taps do nothing. Latch transitions log `Main latch: ON/OFF`.
- Overlay exposes encoders 0–7 as page selectors (A–H). Latched overlay stays active until the next double-click.

## OSC Messages

**Outgoing**
- `/twister_out/page_{a..h} <encId 0..15> <value 0..1>` – value updates.
- `/twister_out/page_{slot}/encoderColors <16 ints>` – BasicPage palette dump (in response to `/dump`).
- `/twister_out/page_{slot}/allvalues <16 floats>` – BasicPage normalized values (in response to `/dump`).

**Incoming (core)**
- `/twister_in/focus {a..h|0..7}` – focus slot.
- `/twister_in/clock 1` – reserved.

**Incoming (page scoped)**
- `/twister_in/page_{slot}/set <encId> <norm>` – set value (BasicPage; GesturePage only in standby).
- `/twister_in/page_{slot}/config/encoderColors <16 ints>` – replace BasicPage palette.
- `/twister_in/page_{slot}/config/encoderColor <encId> <int>` – update one BasicPage encoder color.
- `/twister_in/page_{slot}/dump` – request encoder colors + values.

## Slots & Settings

- `configs/slots.json` maps slots A–H to page factories and optional BasicPage encoder color/brightness palettes.
- `configs/settings.json` tweaks main-button interaction timings (double-click window, hold threshold, debounce).

## Configuration Files

- `configs/slots.json` – maps slots A–H to page factories and optional BasicPage encoder palettes.
- `configs/settings.json` – interaction timings (double-click window, hold threshold, debounce) for the main-button overlay trigger.

## Building & Running

- Install dependencies: `npm install`
- Type-check: `npm run build`
- Run daemon (w/ tsx): `npm run dev`

The project targets NodeNext ESM and keeps MIDI channel mappings, rate limits, and page logic centralized in `src/Architecture.md`.
