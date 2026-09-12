/* Boot and wiring. Owns nothing itself: it creates the transport, hands `send`
 * to the two surfaces, and routes each inbound message to whichever one cares.
 */

import { createBus } from "./bus.js"
import { initPanels } from "./panels.js"
import { initTwister } from "./twister.js"

let panels = null
let twister = null

const bus = createBus({
	onMessage({ path, args }) {
		// LED frames arrive at the render-loop rate for as long as anything is
		// moving. Dispatch them first and keep them out of the log unless asked:
		// stringifying a 16-tuple array per frame is pure waste otherwise.
		if (path === "/twister/ui/leds") {
			if (panels.shouldLogLeds()) panels.log(`← ${path} ${args[0]}`)
			twister.applyLedFrame(args[0])
			return
		}
		panels.log(`← ${path} ${JSON.stringify(args)}`)
		panels.handle(path, args)
	},
})

panels = initPanels({ send: bus.send })
twister = initTwister({ send: bus.send })
panels.render()
bus.connect()
