/* Task: GesturePage (standby/record/playback per-encoder with looping)
Spec: /src/Architecture.md
- Values are 0..127 ints; deltas apply only in standby/record; ignored in playback.
- States:
  Standby  -> Blue,  brightness 5,  anim none; values may be set via OSC.
  Record   -> Red,   anim 'pulse' (brightness ignored that burst); record timeline.
  Playback -> Green, brightness 10, anim none; loop recorded gesture.
- Cycle on encoder button press: Standby -> Record -> Playback -> Standby (clear rec).
- OSC out on any value change: /twister_out/slot_{a|b|c|d}/{id} {0..1 <= 5dp}
- OSC in (only in standby): /twister_in/slot_{x}/set/{id} {normFloat}
*/

import type { Page, LedFrame, LedState, EncId, PageContext } from '../core/types.js';
import colors from '../config/colors.json' with { type: 'json' };
import { clamp, to127, toFixedN } from '../util/scale.js';

type Mode = 'standby' | 'record' | 'playback';

type Point = { t: number; v: number }; // ms since record start, value 0..127

const asEncId = (n: number): EncId => {
  if (!Number.isInteger(n) || n < 0 || n > 15) throw new Error(`EncId out of range: ${n}`);
  return n as EncId;
};

export function GesturePage(): Page {
  // Per-encoder state
  const vals   = new Int16Array(16);                 // 0..127
  const mode   = Array<Mode>(16).fill('standby');    // current mode per enc
  const rec    = Array.from({ length: 16 }, () => [] as Point[]); // recorded timelines
    const recT0:  number[] = Array(16).fill(0);  // ✅ safe up to 2^53
    const playT0: number[] = Array(16).fill(0);  // ✅ safe up to 2^53
  const timers = new Array<ReturnType<typeof setInterval> | null>(16).fill(null);

  let dirty = true;
  let ctxRef: PageContext | null = null;

  const COLOR_BLUE  = Number(colors.blue  ?? 1);
  const COLOR_RED   = Number(colors.red   ?? 80);
  const COLOR_GREEN = Number(colors.green ?? 60);

  // --- helpers ---------------------------------------------------------------

  const beginRecord = (i: EncId) => {
    stopTimer(i);
    rec[i] = [{ t: 0, v: vals[i] }];     // start from current value
    recT0[i] = Date.now();
    mode[i] = 'record';
    markDirty();
  };

  const finalizeRecording = (i: EncId) => {
  const tl = rec[i];
  let t = Date.now() - recT0[i];

  if (tl.length === 0) {
    // no turns happened at all — start at t=0 for completeness
    tl.push({ t: 0, v: vals[i] });
  }

  const last = tl[tl.length - 1];

  // ensure strictly increasing time so dur > 0
  if (t <= last.t) t = last.t + 1;

  // ALWAYS push a final endpoint, even if value didn't change
  tl.push({ t, v: vals[i] });
};

  const beginPlayback = (i: EncId) => {
  stopTimer(i);
  const tl = rec[i];
  if (tl.length < 2) {
    // static playback; nothing to interpolate
    mode[i] = 'playback';
    markDirty();
    return;
  }
  mode[i] = 'playback';
  playT0[i] = Date.now();
  timers[i] = setInterval(() => tickPlayback(i), 20);
  console.log('PLAY dur=', rec[i][rec[i].length-1].t, 'pts=', rec[i].length, rec[i].slice(-5));
  markDirty();
};

  const backToStandby = (i: EncId) => {
    stopTimer(i);
    rec[i] = [];
    mode[i] = 'standby';
    markDirty();
  };

  const stopTimer = (i: EncId) => {
    if (timers[i]) { clearInterval(timers[i]!); timers[i] = null; }
  };

  const markDirty = () => {
    dirty = true;
    // If the page is focused, this will push immediately (PageManager wiring)
    ctxRef?.setDirty();
  };

  const emitOsc = (i: EncId) => {
    if (!ctxRef) return;
    const f = toFixedN(vals[i] / 127, 5);
    ctxRef.osc.send(`/twister_out/slot_${ctxRef.slotLabel}/${i}`, f);
  };

  // Playback interpolation at current time
  const tickPlayback = (i: EncId) => {
  const tl = rec[i];
  if (tl.length < 2) return;

  const dur = tl[tl.length - 1].t;     // ms total
  if (dur <= 0) return;

  const t = (Date.now() - playT0[i]) % dur; // 0..dur-ε

  // Find first idx with tl[idx].t > t (there is always one, because last.t == dur > t)
  let idx = 0;
  while (idx < tl.length && tl[idx].t <= t) idx++;

  // Segment [a,b]; for wrap, b is a synthetic endpoint at (dur, first.v)
  const a = tl[Math.max(0, idx - 1)];
  const b = (idx >= tl.length)
    ? { t: dur, v: tl[0].v }
    : tl[idx];

  const span = Math.max(1, b.t - a.t);
  const u = (t - a.t) / span;                 // 0..1
  const v = Math.round(a.v + u * (b.v - a.v));

  if (v !== vals[i]) {
    vals[i] = clamp(v, 0, 127);
    emitOsc(i);
    markDirty();
  }
};

  // --- Page interface --------------------------------------------------------

  return {
    init(ctx) {
      ctxRef = ctx;
      for (let i = 0; i < 16; i++) vals[i] = 0;
      dirty = true;
    },
    onFocus() { /* paint will happen via render */ dirty = true; },
    onBlur()  { /* keep timers running; LEDs won’t update while unfocused */ },
    dispose() { for (let i = 0; i < 16; i++) stopTimer(i as EncId); ctxRef = null; },

    onEvent(ev, ctx) {
    if (ev.type === 'encoder/press' && ev.down) {
        const i = ev.id;
        if (mode[i] === 'standby') {
            beginRecord(i);
        } else if (mode[i] === 'record') {
            finalizeRecording(i as EncId);   // ✅ add final point
            beginPlayback(i as EncId);
        } else { // playback
            backToStandby(i as EncId);
        }
        return;
    }

      if (ev.type === 'encoder/turn') {
        const i = ev.id;
        if (mode[i] === 'playback') return; // ignore deltas while playing
        // apply delta (standby or record)
        const step = 128 / ctx.resolution;
        const before = vals[i];
        vals[i] = clamp(before + Math.round(ev.delta * step), 0, 127);

        if (mode[i] === 'record') {
    // Monotonic timestamp
    const tRaw = Date.now() - recT0[i];
    const tl = rec[i];
    const lastT = tl.length ? tl[tl.length - 1].t : 0;
    const t = tRaw <= lastT ? lastT + 1 : tRaw;

    // Only append when value changed (keeps shape compact) — time is strictly increasing now
    if (tl.length === 0 || tl[tl.length - 1].v !== vals[i]) {
      tl.push({ t, v: vals[i] });
    }
  }
        if (vals[i] !== before) {
          emitOsc(i);
          markDirty();
        }
      }
    },

   onOsc(path, args, ctx) {
        // Only accept set when in standby
        const m = path.match(/\/set\/(\d{1,2})$/);
        if (!m) return;

        const idNum = Number(m[1]) | 0;       // or: parseInt(m[1], 10)
        if (idNum < 0 || idNum > 15) return;

        const id = asEncId(idNum);            // ✅ narrow to EncId
        if (mode[id] !== 'standby') return;

        const v = Number(args[0]);
        if (!Number.isFinite(v)) return;

        const val = clamp(Math.round(v * 127), 0, 127);
        if (val !== vals[id]) {
            vals[id] = val;
            emitOsc(id);                        // ✅ now EncId
            markDirty();
        }
    },

    render(ctx): LedFrame | undefined {
      if (!dirty) return;
      dirty = false;

      const mk = (o: Partial<LedState> = {}): LedState =>
        ({ ring: 0, rgb: 110, ledBrightness: 5, ringBrightness: 31, anim: 'none', ...o });

      const frame = {} as LedFrame;
      for (let i = 0 as EncId; i < 16; i = (i + 1) as EncId) {
        const m = mode[i];
        const base: Partial<LedState> =
          m === 'standby'  ? { rgb: COLOR_BLUE,  ledBrightness: 5,  anim: 'none'  } :
          m === 'record'   ? { rgb: COLOR_RED,   ledBrightness: 29, anim: 'pulse' } : // pulse overrides brightness
                             { rgb: COLOR_GREEN, ledBrightness: 10, anim: 'none'  };
        frame[i] = mk({ ...base, ring: to127(vals[i]) });
      }
      return frame;
    }
  };
}