export class FakeMidi {
	public calls: string[] = []
	setRing(e: number, v: number) {
		this.calls.push(`ring:${e}:${v}`)
	}
	setRGB(e: number, c: number) {
		this.calls.push(`rgb:${e}:${c}`)
	}
	setLedBrightness(e: number, b: number) {
		this.calls.push(`ledB:${e}:${b}`)
	}
	setRingBrightness(e: number, b: number) {
		this.calls.push(`ringB:${e}:${b}`)
	}
	setPulse(e: number) {
		this.calls.push(`pulse:${e}`)
	}
}
