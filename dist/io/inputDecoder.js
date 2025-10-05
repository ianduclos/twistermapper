import deviceMap from "../config/device-map.json" with { type: "json" };
export function createInputDecoder() {
    const subs = [];
    const emit = (e) => subs.forEach((cb) => cb(e));
    // Shift/global state
    let shiftLeft = false, shiftRight = false;
    // Whether to suppress global buttons if any shift is held
    let interceptGlobals = true;
    const enc = deviceMap.input.encoderDelta;
    const btn = deviceMap.input.encoderButton;
    const L = deviceMap.input.sideLeft;
    const R = deviceMap.input.sideRight;
    const inEncRange = (num, start, count) => num >= start && num < start + count;
    // Convert CC value to a signed delta:
    // - Prefer your explicit MFT convention (63=-1, 64=+1).
    // - Fallback to common "signed offset around 64": delta = value - 64 (64=0).
    const ccToDelta = (val) => {
        if (val === 63)
            return -1;
        if (val === 64)
            return +1;
        return val - 64; // supports other relative modes without special-casing
    };
    const anyShift = () => shiftLeft || shiftRight;
    const pushRaw = (msg) => {
        // Encoder turns (CC on enc.channel, numbers ccStart..ccStart+15)
        if (msg.type === "cc" &&
            msg.channel === enc.channel &&
            inEncRange(msg.number, enc.ccStart, enc.count)) {
            const id = (msg.number - enc.ccStart);
            const delta = ccToDelta(msg.value);
            emit({ type: "encoder/turn", id, delta, shift: anyShift() });
            return;
        }
        // Encoder button presses (NOTE on btn.channel, notes noteStart..noteStart+15)
        if (msg.type === "note" &&
            msg.channel === btn.channel &&
            inEncRange(msg.number, btn.noteStart, btn.count)) {
            const id = (msg.number - btn.noteStart);
            const down = msg.value > 0;
            emit({ type: "encoder/press", id, down, shift: anyShift() });
            return;
        }
        // Side buttons: LEFT block
        if (msg.channel === L.channel) {
            // Shift Left (upper)
            if (msg.type === "cc" && msg.number === L.upper) {
                const down = msg.value > 0;
                shiftLeft = down;
                emit({ type: "side/shift", side: "left", down });
                return;
            }
            // Global Left (lower)
            if (msg.type === "cc" && msg.number === L.lower) {
                const down = msg.value > 0;
                if (!(interceptGlobals && anyShift())) {
                    emit({ type: "side/global", side: "left", down });
                }
                return;
            }
        }
        // Side buttons: RIGHT block
        if (msg.channel === R.channel) {
            // Shift Right (upper)
            if (msg.type === "cc" && msg.number === R.upper) {
                const down = msg.value > 0;
                shiftRight = down;
                emit({ type: "side/shift", side: "right", down });
                return;
            }
            // Global Right (lower)
            if (msg.type === "cc" && msg.number === R.lower) {
                const down = msg.value > 0;
                if (!(interceptGlobals && anyShift())) {
                    emit({ type: "side/global", side: "right", down });
                }
                return;
            }
        }
    };
    return {
        pushRaw,
        onEvent(cb) {
            subs.push(cb);
        },
        setShiftInterceptGlobals(on) {
            interceptGlobals = on;
        },
    };
}
