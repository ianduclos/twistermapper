// src/cli/osc-send.ts
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import osc from "osc"

const udp = new osc.UDPPort({
	localAddress: "0.0.0.0",
	localPort: 57122,
	remoteAddress: "127.0.0.1",
	remotePort: 57121,
	metadata: true,
})
udp.on("ready", () => {
	const msg = (address: string, ...args: any[]) =>
		udp.send(
			{
				address,
				args: args.map((v) =>
					typeof v === "number" && !Number.isInteger(v)
						? { type: "f", value: Number(v.toFixed(5)) }
						: typeof v === "number"
						? { type: "i", value: v | 0 }
						: { type: "s", value: String(v) }
				),
			},
			address
		)

	// Focus slot A
	msg("/twister/in/focus/page", "a")
	// Set index 0 to 0.75 on BasicPage
	msg("/twister/in/page/a/index/0/set", 0.75)

	setTimeout(() => udp.close(), 100)
})
udp.open()
