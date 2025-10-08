/* Task: Implement NodeMidi driver (input + output)
Spec: Obey /src/Architecture.md — sections:
- "Device map" (channels, CC/Note layout, ranges)
- "Output (to MFT)" mapping and human→device scaling rules

Acceptance Criteria:
1) Provide class NodeMidiDriver that implements MidiOut & MidiIn:
   - constructor(opts?: { inPort?: number|string; outPort?: number|string; deviceMapPath?: string })
     * Ports: if number => open that index; if string => first port containing substring (case-insensitive).
     * If unspecified, pick the first port whose name includes 'twister' for both in/out; fallback to index 0.
   - onMessage(cb): wire MIDI IN and translate to RawMsg shape {type:'cc'|'note', channel(0..15), number, value}
   - setRing(enc, val0_127): CC on output.ringLevel.channel, cc=enc, value=val
   - setRGB(enc, color1_126): NOTE on output.rgbColor.channel, note=enc, velocity=color
   - setLedBrightness(enc, human0_29): map -> 18..47, send CC on output.ledBrightness.channel
   - setRingBrightness(enc, human1_31): map -> 65..95, send CC on output.ringBrightness.channel
   - setPulse(enc): send CC (value from output.pulseAnimation.value) on output.pulseAnimation.channel
2) Implementation details:
   - Zero-based channels (0..15) in our code; convert to MIDI status byte channel bits.
   - ESM (NodeNext). Use `import midi from '@julusian/midi'`.
   - Load device-map from ../config/device-map.json (with { type: 'json' } import attribute).
3) Safety:
   - If ports cannot open, throw a helpful Error listing available ports.
   - Expose getInPortName()/getOutPortName() for diagnostics.
4) Constraints:
   - Do not change existing interfaces (MidiOut, MidiIn).
   - No global state; allow multiple instances.
*/
// src/io/midiDriver.ts
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import midi from '@julusian/midi';
import deviceMap from '../config/device-map.json' with { type: 'json' };
const DEFAULT_DEVICE_NAME = 'Midi Fighter Twister';
const DEBUG = process.env.TWISTER_DEBUG === '1';
export class NodeMidiDriver {
    input;
    output;
    subscribers = [];
    map;
    inPortName = '';
    outPortName = '';
    constructor(opts = {}) {
        this.map = opts.deviceMapPath ? this.loadDeviceMap(opts.deviceMapPath) : deviceMap;
        this.input = new midi.Input();
        this.output = new midi.Output();
        // Optional: drop timing/active sensing noise
        // this.input.ignoreTypes(true, true, true);
        const inInfo = this.openPort(this.input, opts.inPort ?? DEFAULT_DEVICE_NAME, 'input');
        const outInfo = this.openPort(this.output, opts.outPort ?? DEFAULT_DEVICE_NAME, 'output');
        this.inPortName = inInfo.name;
        this.outPortName = outInfo.name;
        this.input.on('message', (_delta, message) => {
            const parsed = this.parseMessage(message);
            if (!parsed)
                return;
            for (const cb of this.subscribers)
                cb(parsed);
        });
    }
    // ---- MidiIn ----
    onMessage(cb) { this.subscribers.push(cb); }
    getInPortName() { return this.inPortName; }
    getOutPortName() { return this.outPortName; }
    // ---- MidiOut (Twister mappings) ----
    setRing(enc, value0_127) {
        const ch = this.map.output.ringLevel.channel; // 0
        this.sendCc(ch, enc, clamp(value0_127, 0, 127));
    }
    setRGB(enc, colorIdx1_126) {
        const ch = this.map.output.rgbColor.channel; // 2
        this.sendNote(ch, enc, clamp(colorIdx1_126, 1, 126)); // velocity as color
    }
    setLedBrightness(enc, human0_29) {
        const ch = this.map.output.ledBrightness.channel; // 3
        const val = 18 + clamp(human0_29, 0, 29); // 18..47
        // controller number = encoder index, value = brightness code
        this.sendCc(ch, enc, val);
    }
    setRingBrightness(enc, human1_31) {
        const ch = this.map.output.ringBrightness.channel; // 3
        const val = 64 + clamp(human1_31, 1, 31); // 65..95
        this.sendCc(ch, enc, val);
    }
    setPulse(enc) {
        const { channel, value } = this.map.output.pulseAnimation; // 3 / 13
        this.sendCc(channel, enc, clamp(value ?? 13, 0, 127));
    }
    // ---- internals ----
    loadDeviceMap(path) {
        const resolved = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
        const json = readFileSync(resolved, 'utf8');
        return JSON.parse(json);
    }
    openPort(io, spec, kind) {
        const names = this.listPorts(io);
        if (!names.length)
            throw new Error(`No ${kind} MIDI ports available.`);
        const { index, name } = this.resolvePort(names, spec, kind);
        try {
            io.openPort(index);
        }
        catch (err) {
            throw new Error(`Unable to open ${kind} port '${name}': ${err.message}`);
        }
        return { index, name };
    }
    listPorts(io) {
        const count = io.getPortCount();
        const names = [];
        for (let i = 0; i < count; i++)
            names.push(io.getPortName(i));
        return names;
    }
    resolvePort(names, spec, kind) {
        if (typeof spec === 'number') {
            if (!Number.isInteger(spec) || spec < 0 || spec >= names.length) {
                throw new Error(`Invalid ${kind} port index ${spec}. Available: ${names.join(', ')}`);
            }
            return { index: spec, name: names[spec] };
        }
        const lower = names.map(n => n.toLowerCase());
        const target = spec.toLowerCase();
        // exact first
        let idx = lower.findIndex(n => n === target);
        if (idx !== -1)
            return { index: idx, name: names[idx] };
        // substring next
        idx = lower.findIndex(n => n.includes(target));
        if (idx !== -1)
            return { index: idx, name: names[idx] };
        // fallback: prefer exact DEFAULT_DEVICE_NAME, then substring, else first
        const want = DEFAULT_DEVICE_NAME.toLowerCase();
        idx = lower.findIndex(n => n === want);
        if (idx !== -1)
            return { index: idx, name: names[idx] };
        idx = lower.findIndex(n => n.includes(want));
        if (idx !== -1)
            return { index: idx, name: names[idx] };
        return { index: 0, name: names[0] };
    }
    parseMessage(message) {
        if (!message.length)
            return null;
        const status = message[0] ?? 0;
        const typeNibble = status & 0xF0;
        const channel = status & 0x0F;
        const number = message[1] ?? 0;
        const value = message[2] ?? 0;
        if (typeNibble === 0xB0)
            return { type: 'cc', channel, number, value };
        if (typeNibble === 0x90 || typeNibble === 0x80)
            return { type: 'note', channel, number, value };
        return null;
    }
    sendCc(channel, controller, value) {
        this.sendMessage(0xB0, channel, controller, value);
    }
    sendNote(channel, note, velocity) {
        this.sendMessage(0x90, channel, note, velocity);
    }
    sendMessage(status, channel, data1, data2) {
        const statusByte = (status & 0xF0) | (channel & 0x0F);
        if (DEBUG) {
            const kind = (statusByte & 0xF0) === 0xB0 ? 'CC' : ((statusByte & 0xF0) === 0x90 ? 'NOTE' : '??');
            // eslint-disable-next-line no-console
            console.log(`[MIDI→] ${kind} ch=${channel} d1=${data1} d2=${data2}`);
        }
        this.output.sendMessage([statusByte, data1 & 0x7F, data2 & 0x7F]);
    }
    close() {
        try {
            this.input.closePort();
        }
        catch { }
        try {
            this.output.closePort();
        }
        catch { }
    }
}
// Temporary no-op so the app runs without device libs:
export class NullMidi {
    onMessage() { }
    setRing() { }
    setRGB() { }
    setLedBrightness() { }
    setRingBrightness() { }
    setPulse() { }
}
function clamp(value, min, max) {
    if (Number.isNaN(value))
        return min;
    if (value < min)
        return min;
    if (value > max)
        return max;
    return value;
}
