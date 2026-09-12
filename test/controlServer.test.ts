import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { WebSocket } from "ws"
import { connect } from "node:net"
import { createControlServer, resolveStaticPath, type ControlServer } from "../src/io/controlServer.js"

// A fresh port per test: undici pools keep-alive connections per origin, so
// reusing one port across servers lets a dead socket from the previous test
// surface as ECONNRESET in the next one.
let nextPort = 7991
let PORT = nextPort
let WS_URL = `ws://localhost:${PORT}`
let BASE = `http://localhost:${PORT}`
const UI_DIR = new URL("../web", import.meta.url).pathname

beforeEach(() => {
	PORT = nextPort++
	WS_URL = `ws://localhost:${PORT}`
	BASE = `http://localhost:${PORT}`
})

let server: ControlServer | null = null
afterEach(() => {
	server?.close()
	server = null
})

/** Send a request line verbatim, bypassing any client-side URL normalisation. */
function rawGet(port: number, path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const sock = connect(port, "localhost", () => {
			sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)
		})
		let buf = ""
		sock.on("data", (d) => (buf += d.toString()))
		sock.on("end", () => resolve(buf))
		sock.on("error", reject)
	})
}

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
			staticDir: UI_DIR,
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

	it("tracks clientCount as clients connect and disconnect", async () => {
		server = createControlServer({
			port: PORT,
			staticDir: UI_DIR,
			onMessage: () => {},
		})
		expect(server.clientCount).toBe(0)

		const ws = new WebSocket(WS_URL)
		await open(ws)
		// Give the server's 'connection' handler a tick to register the client.
		await new Promise((r) => setTimeout(r, 50))
		expect(server.clientCount).toBe(1)

		ws.close()
		await new Promise((r) => setTimeout(r, 50))
		expect(server.clientCount).toBe(0)
	})

	it("ignores malformed frames without throwing", async () => {
		const received: any[] = []
		server = createControlServer({
			port: PORT,
			staticDir: UI_DIR,
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

describe("controlServer static files", () => {
	// The UI is plain ES modules served straight from web/ — no build step — so
	// the server has to hand back several files, with types the browser accepts.
	it("serves index.html at / and the module/style files by name", async () => {
		server = createControlServer({ port: PORT, staticDir: UI_DIR, onMessage: () => {} })

		const root = await fetch(`${BASE}/`)
		expect(root.status).toBe(200)
		expect(root.headers.get("content-type")).toContain("text/html")
		expect(await root.text()).toContain('<script type="module" src="app.js">')

		for (const [name, type] of [
			["app.js", "text/javascript"],
			["twister.js", "text/javascript"],
			["style.css", "text/css"],
		] as const) {
			const res = await fetch(`${BASE}/${name}`)
			expect(res.status, name).toBe(200)
			expect(res.headers.get("content-type"), name).toContain(type)
		}
	})

	it("404s unknown paths and non-servable extensions", async () => {
		server = createControlServer({ port: PORT, staticDir: UI_DIR, onMessage: () => {} })
		for (const path of ["/nope.js", "/does/not/exist.html", "/index.txt"]) {
			expect((await fetch(`${BASE}${path}`)).status, path).toBe(404)
		}
	})

	it("refuses to serve anything outside the static dir", async () => {
		server = createControlServer({ port: PORT, staticDir: UI_DIR, onMessage: () => {} })
		// Sent over a raw socket, not fetch: fetch normalises "/../" away in the
		// client, so it never reaches the server and proves nothing. package.json
		// sits one level above web/ and is readable — a traversal that worked
		// would hand it back.
		const attempts = [
			"/../package.json",
			"/..%2Fpackage.json",
			"/%2e%2e/package.json",
			"/%252e%252e/package.json",
			"/web/../../package.json",
			"/../../../../../../etc/hosts",
			"/./../package.json",
		]
		for (const path of attempts) {
			const raw = await rawGet(PORT, path)
			expect(raw, path).toMatch(/^HTTP\/1\.1 404 /)
			expect(raw, path).not.toContain("twistermapper")
		}
	})

	it("resolveStaticPath rejects escapes and non-servable types directly", () => {
		expect(resolveStaticPath(UI_DIR, "/")).toMatch(/index\.html$/)
		expect(resolveStaticPath(UI_DIR, "/app.js")).toMatch(/app\.js$/)
		expect(resolveStaticPath(UI_DIR, "/app.js?v=2")).toMatch(/app\.js$/)
		expect(resolveStaticPath(UI_DIR, "/../package.json")).toBeNull()
		expect(resolveStaticPath(UI_DIR, "/../../etc/hosts")).toBeNull()
		expect(resolveStaticPath(UI_DIR, "/notes.txt")).toBeNull()
		expect(resolveStaticPath(UI_DIR, "/app%00.js")).toBeNull()
		expect(resolveStaticPath(UI_DIR, "/%ZZ")).toBeNull()
	})
})
