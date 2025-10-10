# Twister Manager 2

Headless Node.js/TypeScript daemon that drives a MIDI Fighter Twister (MFT), renders LEDs, and proxies MIDI↔OSC for multiple “pages” of controls. The process boots with a splash animation, then repaints the focused page twice to settle device brightness.

## Page Prototypes

- **BasicPage** – 16 continuous controls (0–127), per-encoder color/brightness palette, press-to-max-brightness feedback, OSC mirroring (`/twister/out/page/<slot>/index/<id>/value`). Accepts `/twister/in/page/<slot>/index/<id>/set`, palette updates under `/config/color/...`, brightness updates under `/config/colorbrightness/...`, and participates in `/twister/in/dump/global`.
- **GesturePage** – Per-encoder record/playback looper with standby/record/playback states, pulse animation on record, smooth looping playback, and OSC mirroring while values evolve.
- **StepSeqPage** – Four-track, 12-step sequencer driven by `/twister/in/clock` ticks. Steps hold value and probability layers: normal mode edits values and shows current step output; holding right shift flips encoders to probability view, where step rings show 0–100% chance and top encoders adjust all probabilities per track. Every tick emits `/twister/out/page/<slot>/index/<track>/value <norm>`.

## Overlay & Interaction

- Lower-right *main* button: hold ≥ `mainHoldThresholdMs` (default 200 ms) for a momentary overlay, double-click within `mainDoubleClickMs` (default 320 ms) to toggle latch ON/OFF. Single short taps do nothing. Latch transitions log `Main latch: ON/OFF`.
- Overlay exposes encoders 0–7 as page selectors (A–H). Latched overlay stays active until the next double-click.

## OSC Messages

**Outgoing**
- `/twister/out/hello` – sent once when the OSC transport comes up.
- `/twister/out/page/<slot>/type <string>` – page identity (emitted on init/focus).
- `/twister/out/page/<slot>/index/<id>/value <0..1>` – value broadcasts (Basic, StepSeq, Gesture).
- `/twister/out/page/<slot>/index/<id>/press <1|0>` – encoder button state (pages that surface presses).
- `/twister/out/page/<slot>/config/color/map <16 ints>` – BasicPage palette dump (in response to `/twister/in/dump/global`).
- `/twister/out/page/<slot>/index/all/value <16 floats>` – BasicPage normalized values dump.

**Incoming (core)**
- `/twister/in/focus/page <slotLetter>` – focus slot (letters `a`–`h` only).
- `/twister/in/clock <int>` – external clock tick (broadcast to pages; StepSeq consumes IDs 0–3).
- `/twister/in/dump/global` – request palette/value dumps from Basic pages.

**Incoming (page scoped)**
- `/twister/in/page/<slot>/index/<id>/set <norm>` – set value (BasicPage; GesturePage only in standby).
- `/twister/in/page/<slot>/config/color/map <16 ints>` – replace BasicPage palette.
- `/twister/in/page/<slot>/config/color/enc/<id>/set <int>` – update one BasicPage encoder color.
- `/twister/in/page/<slot>/config/colorbrightness/map <16 ints>` – replace BasicPage brightness map.
- `/twister/in/page/<slot>/config/colorbrightness/enc/<id>/set <int>` – update one BasicPage encoder brightness.

## Slots & Settings

- `configs/slots.json` maps slots A–H to page factories and optional BasicPage encoder color/brightness palettes.
- `configs/settings.json` tweaks main-button interaction timings (double-click window, hold threshold, debounce).
- `configs/slots.json` → StepSeq slots may include `{"tracks": [{"clockIds": [0,2,5]}, ...]}` to choose which `/twister/in/clock` IDs each track advances on (defaults to 0).

## Configuration Files

- `configs/slots.json` – maps slots A–H to page factories and optional BasicPage encoder palettes.
- `configs/settings.json` – interaction timings (double-click window, hold threshold, debounce) for the main-button overlay trigger.

## Building & Running

- Install dependencies: `npm install`
- Type-check: `npm run build`
- Run daemon (w/ tsx): `npm run dev`

The project targets NodeNext ESM and keeps MIDI channel mappings, rate limits, and page logic centralized in `src/Architecture.md`.
