/* BlankPage — inert placeholder. Ignores all input, LEDs stay dark. For slots
 * that aren't in use yet, so they don't advertise a real page identity.
 */

import { Page, LedFrame } from "../core/types.js"

const OFF_FRAME: LedFrame = (() => {
	const out: any = {}
	for (let i = 0; i < 16; i++) {
		out[i] = { ring: 0, rgb: 0, ledBrightness: 0, ringBrightness: 0, anim: "none" }
	}
	return out
})()

export function BlankPage(): Page {
	let dirty = true

	return {
		init(ctx) {
			ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/type`, "Blank")
			dirty = true
		},
		onFocus(ctx) {
			ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/type`, "Blank")
			dirty = true
		},
		onBlur() {},
		onEvent() {},
		render() {
			if (!dirty) return
			dirty = false
			return OFF_FRAME
		},
		dispose() {},
	}
}
