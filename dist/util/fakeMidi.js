export class FakeMidi {
    calls = [];
    setRing(e, v) {
        this.calls.push(`ring:${e}:${v}`);
    }
    setRGB(e, c) {
        this.calls.push(`rgb:${e}:${c}`);
    }
    setLedBrightness(e, b) {
        this.calls.push(`ledB:${e}:${b}`);
    }
    setRingBrightness(e, b) {
        this.calls.push(`ringB:${e}:${b}`);
    }
    setPulse(e) {
        this.calls.push(`pulse:${e}`);
    }
}
