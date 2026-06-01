import { describe, it, expect, afterEach } from "vitest"
import { WebSocket } from "ws"
import { createControlServer, type ControlServer } from "../src/io/controlServer.js"

const PORT = 7991
const WS_URL = `ws://localhost:${PORT}`
const UI_FILE = new URL("../web/index.html", import.meta.url).pathname

let server: ControlServer | null = null
afterEach(() => {
	server?.close()
	server = null
})

function open(ws: WebSocket): Promise<void> {
	return new Promise((resolve) => ws.once("open", () => resolve()))
}

// Buffer every inbound frame from connection time so we never miss one to a race.
function collect(ws: WebSocket) {
	const msgs: any[] = []
	const waiters: Array<() => void> = []
	ws.on("message", (d) => {
		msgs.push(JSON.parse(d.toString()))
		waiters.shift()?.()
	})
	return {
		msgs,
		async waitFor(n: number) {
			while (msgs.length < n) await new Promise<void>((r) => waiters.push(r))
		},
	}
}

describe("controlServer", () => {
	it("sends the onConnect snapshot, routes inbound, and broadcasts outbound", async () => {
		const received: Array<{ path: string; args: any[] }> = []
		server = createControlServer({
			port: PORT,
			staticFile: UI_FILE,
			onMessage: (path, args) => received.push({ path, args }),
			onConnect: (send) => send("/twister/out/focus/page", ["a"]),
		})

		const ws = new WebSocket(WS_URL)
		const inbox = collect(ws)
		await open(ws)

		// 1) snapshot pushed on connect
		await inbox.waitFor(1)
		expect(inbox.msgs[0]).toEqual({ path: "/twister/out/focus/page", args: ["a"] })

		// 2) inbound { path, args } reaches onMessage
		ws.send(JSON.stringify({ path: "/twister/in/clock", args: [2] }))
		await new Promise((r) => setTimeout(r, 50))
		expect(received).toContainEqual({ path: "/twister/in/clock", args: [2] })

		// 3) broadcast reaches the client
		server.broadcast("/twister/out/page/a/index/0/value", [0.5])
		await inbox.waitFor(2)
		expect(inbox.msgs[1]).toEqual({ path: "/twister/out/page/a/index/0/value", args: [0.5] })

		ws.close()
	})

	it("ignores malformed frames without throwing", async () => {
		const received: any[] = []
		server = createControlServer({
			port: PORT,
			staticFile: UI_FILE,
			onMessage: (path, args) => received.push({ path, args }),
		})
		const ws = new WebSocket(WS_URL)
		await open(ws)
		ws.send("not json")
		ws.send(JSON.stringify({ nope: true }))
		await new Promise((r) => setTimeout(r, 50))
		expect(received).toHaveLength(0)
		ws.close()
	})
})
