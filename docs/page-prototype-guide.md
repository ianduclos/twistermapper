# Creating a New Page Prototype

This project renders the MIDI Fighter Twister headlessly. Page prototypes define LED/state behaviour for each slot. Follow the steps below to add a new page without breaking existing behaviour.

## 1. Review Architectural Rules
- Read `src/Architecture.md`, especially the *Page model*, *OSC*, and *Renderer & rate limits* sections.
- Confirm the new page keeps MIDI channel/CC mappings unchanged. Only the driver may talk to hardware.

## 2. Scaffold the Page Module
- Create `src/pages/<name>.ts` that exports `function YourPage(): Page`.
- Implement all lifecycle hooks required by `Page` (`init`, `onFocus`, `onBlur`, `onEvent`, `render`, `dispose`).
- Use `ctx.osc.send` for all outward OSC traffic. Clamp numeric values with helpers in `src/util/scale.ts`.
- Provide a unique `type` message by emitting `/twister_out/page_${ctx.slotLabel}/type <YourType>` in `init` and `onFocus` (mirroring Basic/Gesture).
- Ensure encoder button presses call `/twister_out/page_${ctx.slotLabel}/press <encId> <0|1>` if the page overrides button behaviour.

## 3. Manage Internal State Thoughtfully
- Maintain per-encoder state (values, modes, timers) so `render` can return a full `LedFrame` when dirty.
- On `render`, return `undefined` when nothing changed to avoid unnecessary reconciler work.
- Use `ctx.setDirty()` whenever asynchronous operations (timers, OSC callbacks) change state.
- Clean up resources (timers, intervals, listeners) inside `dispose`.

## 4. Wire the Page into the CLI
- Import the new page in `src/cli/index.ts` and register it in `PAGE_FACTORIES`.
- If the page needs configuration, extend `BasicPageConfig`-style sanitizers or introduce a new config parser near the slots loader.
- Update `configs/slots.json` to point any slots at the new type (e.g., `{ "page": "YourPage" }`).
- Provide sensible defaults so missing config entries fallback gracefully.

## 5. Hook up OSC & Type Messages
- Confirm `/twister_out/page_${slot}/type` fires on boot and focus (already handled in Basic/Gesture examples).
- If the page introduces new OSC routes, document them in `Architecture.md` and the README.

## 6. Test the Page
- Run `npm run build` to satisfy TypeScript.
- Use `npm run dev` (or your preferred tsx command) with the Twister connected to verify LEDs, press events, and OSC traffic.
- Watch the console for rate-limit warnings. Adjust animation cadence if the reconciler throttles updates.

## 7. Documentation & Maintenance
- Update `Architecture.md` and `README.md` with the new page type and OSC controls.
- If the page requires dedicated configuration, add details to `docs/page-prototype-guide.md` and the main docs.
- Keep comments concise and up-to-date to avoid confusing future changes.

Following these steps keeps the daemon consistent with its architecture, ensures hotplug/overlay features continue to work, and prevents unexpected regressions in OSC behaviour.
