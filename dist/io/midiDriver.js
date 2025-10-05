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
import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import midi from "@julusian/midi";
import deviceMap from "../config/device-map.json" with { type: "json" };
export class NodeMidiDriver {
    input;
    output;
    subscribers = [];
    map;
    inPortName = "";
    outPortName = "";
    constructor(opts = {}) {
        this.map = opts.deviceMapPath
            ? this.loadDeviceMap(opts.deviceMapPath)
            : deviceMap;
        this.input = new midi.Input();
        this.output = new midi.Output();
        const inInfo = this.openPort(this.input, opts.inPort, "input");
        const outInfo = this.openPort(this.output, opts.outPort, "output");
        this.inPortName = inInfo.name;
        this.outPortName = outInfo.name;
        this.input.on("message", (_delta, message) => {
            const parsed = this.parseMessage(message);
            if (!parsed)
                return;
            for (const cb of this.subscribers)
                cb(parsed);
        });
    }
    onMessage(cb) {
        this.subscribers.push(cb);
    }
    setRing(enc, value0_127) {
        const channel = this.map.output.ringLevel.channel;
        this.sendCc(channel, enc, clamp(value0_127, 0, 127));
    }
    setRGB(enc, colorIdx1_126) {
        const channel = this.map.output.rgbColor.channel;
        this.sendNote(channel, enc, clamp(colorIdx1_126, 1, 126));
    }
    setLedBrightness(enc, human0_29) {
        const channel = this.map.output.ledBrightness.channel;
        const deviceValue = 18 + clamp(human0_29, 0, 29);
        this.sendCc(channel, enc, deviceValue);
    }
    setRingBrightness(enc, human1_31) {
        const channel = this.map.output.ringBrightness.channel;
        const deviceValue = 64 + clamp(human1_31, 1, 31);
        this.sendCc(channel, enc, deviceValue);
    }
    setPulse(enc) {
        const { channel, value } = this.map.output.pulseAnimation;
        this.sendCc(channel, enc, clamp(value ?? 13, 0, 127));
    }
    getInPortName() {
        return this.inPortName;
    }
    getOutPortName() {
        return this.outPortName;
    }
    loadDeviceMap(path) {
        const resolved = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
        try {
            const json = readFileSync(resolved, "utf8");
            return JSON.parse(json);
        }
        catch (err) {
            throw new Error(`Failed to load device map at ${path}: ${err.message}`);
        }
    }
    openPort(io, spec, kind) {
        const names = this.listPorts(io);
        if (!names.length) {
            throw new Error(`No ${kind} MIDI ports available.`);
        }
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
        for (let i = 0; i < count; i++) {
            names.push(io.getPortName(i));
        }
        return names;
    }
    resolvePort(names, spec, kind) {
        if (typeof spec === "number") {
            if (!Number.isInteger(spec) || spec < 0 || spec >= names.length) {
                throw new Error(`Invalid ${kind} port index ${spec}. Available: ${names.join(", ")}`);
            }
            return { index: spec, name: names[spec] };
        }
        const lowerNames = names.map((n) => n.toLowerCase());
        if (typeof spec === "string") {
            const target = spec.toLowerCase();
            const idx = lowerNames.findIndex((n) => n.includes(target));
            if (idx !== -1) {
                return { index: idx, name: names[idx] };
            }
            throw new Error(`Cannot find ${kind} port containing '${spec}'. Available: ${names.join(", ")}`);
        }
        const defaultIdx = lowerNames.findIndex((n) => n.includes("twister"));
        const index = defaultIdx !== -1 ? defaultIdx : 0;
        return { index, name: names[index] };
    }
    parseMessage(message) {
        if (!message.length)
            return null;
        const status = message[0] ?? 0;
        const typeNibble = status & 0xf0;
        const channel = status & 0x0f;
        const number = message[1] ?? 0;
        const value = message[2] ?? 0;
        if (typeNibble === 0xb0) {
            return { type: "cc", channel, number, value };
        }
        if (typeNibble === 0x90 || typeNibble === 0x80) {
            return { type: "note", channel, number, value };
        }
        return null;
    }
    sendCc(channel, controller, value) {
        this.sendMessage(0xb0, channel, controller, value);
    }
    sendNote(channel, note, velocity) {
        this.sendMessage(0x90, channel, note, velocity);
    }
    sendMessage(status, channel, data1, data2) {
        const statusByte = (status & 0xf0) | (channel & 0x0f);
        this.output.sendMessage([statusByte, data1 & 0x7f, data2 & 0x7f]);
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
