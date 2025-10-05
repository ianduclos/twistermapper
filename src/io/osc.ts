/* Task: Implement OSC I/O (udp)
Spec: /src/Architecture.md — "OSC"

Acceptance Criteria:
- export function createOsc(opts?: { localPort?: number; remoteAddress?: string; remotePort?: number })
  returns { send(path: string, ...args: (number|string|boolean)[]): void; onMessage(cb:(path:string,args:any[])=>void): void; close(): void }
- Default localPort=57121, remoteAddress='127.0.0.1', remotePort=57120.
- Use 'osc' package with ESM import; UDP ports.
- onMessage: invoke cb for each incoming OSC message (string path + JS array args).
- send: serialize to OSC and send to remote.
- No globals; safe to instantiate once from the daemon and pass ctx.osc to pages.
*/

// src/io/osc.ts
import { toFixedN } from "../util/scale.js"

// The 'osc' package often lacks TS types; keep it as any for NodeNext ESM.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import osc from "osc"

export type Osc = {
	send: (path: string, ...args: Array<number | string | boolean>) => void
	onMessage: (cb: (path: string, args: any[]) => void) => void
	close: () => void
}

export function createOsc(opts?: {
	localAddress?: string // default 0.0.0.0
	localPort?: number // default 57121
	remoteAddress?: string // default 127.0.0.1
	remotePort?: number // default 57120
}): Osc {
	const udpPort = new osc.UDPPort({
		localAddress: opts?.localAddress ?? "0.0.0.0",
		localPort: opts?.localPort ?? 57121,
		remoteAddress: opts?.remoteAddress ?? "127.0.0.1",
		remotePort: opts?.remotePort ?? 57120,
		metadata: true, // explicit types
	})

	let ready = false
	const queue: { address: string; args: any[] }[] = []

	udpPort.on("ready", () => {
		ready = true
		// flush any queued sends
		while (queue.length) {
			const m = queue.shift()!
			udpPort.send(m) // ✅ DO NOT pass the address here
		}
	})

	udpPort.on("error", (err: unknown) => {
		// optional: add your own logger
		console.error("[OSC] UDP error:", err)
	})

	// Normalize args to OSC metadata
	const buildArgs = (args: Array<number | string | boolean>) =>
		args.map((a) => {
			if (typeof a === "boolean") return { type: a ? "T" : "F" }
			if (typeof a === "number") {
				if (Number.isInteger(a)) return { type: "i", value: a | 0 }
				return { type: "f", value: toFixedN(a, 5) }
			}
			return { type: "s", value: String(a) }
		})

	const send = (path: string, ...args: Array<number | string | boolean>) => {
		const msg = { address: path, args: buildArgs(args) }
		if (!ready) {
			queue.push(msg)
			return
		}
		udpPort.send(msg) // ✅ DO NOT pass the path here
	}

	const onMessage = (cb: (path: string, args: any[]) => void) => {
		udpPort.on("message", (m: any) => {
			const args = (m.args ?? []).map((a: any) => {
				if (a.type === "T") return true
				if (a.type === "F") return false
				return a.value ?? a // i,f,s…
			})
			cb(m.address, args)
		})
	}

	const close = () => {
		try {
			udpPort.close()
		} catch {}
	}

	udpPort.open()
	return { send, onMessage, close }
}
