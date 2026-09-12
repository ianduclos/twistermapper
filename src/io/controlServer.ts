/* Optional control surface: a tiny HTTP + WebSocket server for the web UI.
 *
 * Off by default; enabled via --ui flag or TWISTER_UI=1 (see cli/index.ts).
 * The daemon stays fully headless without it.
 *
 * Protocol (intentionally mirrors OSC so the UI and OSC share one vocabulary):
 *   browser -> daemon : JSON { path: string, args: any[] }  -> routeControl()
 *   daemon  -> browser: JSON { path: string, args: any[] }  (selected /twister/out/...)
 *
 * The HTTP side serves the web/ directory as plain static files — ES modules,
 * no build step. Only the handful of extensions below are served, and every
 * path is resolved and checked for containment before the filesystem is
 * touched, so a traversal attempt cannot escape the directory.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { resolve, extname, sep } from "node:path"
import { WebSocketServer, WebSocket } from "ws"

export interface ControlServer {
	/** Forward an outbound twister message to all connected UIs. */
	broadcast: (path: string, args: Array<number | string | boolean>) => void
	close: () => void
	/** Number of currently OPEN WebSocket clients. */
	readonly clientCount: number
}

export interface ControlServerOptions {
	port: number
	/** Absolute path to the directory of static UI files to serve. */
	staticDir: string
	/** Called for each inbound { path, args } from a UI client. */
	onMessage: (path: string, args: any[]) => void
	/** Called when a UI connects, to push a state snapshot to just that client. */
	onConnect?: (send: (path: string, args: Array<number | string | boolean>) => void) => void
}

/** The only extensions we serve, and the type each is served as. */
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
}

/**
 * Map a request URL to a file inside staticDir, or null to 404.
 *
 * Exported for testing. The containment check — not the "../" spelling — is what
 * makes this safe: whatever the request encodes, the resolved path must still
 * sit inside staticDir.
 */
export function resolveStaticPath(staticDir: string, urlPath: string): string | null {
	let decoded: string
	try {
		decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0])
	} catch {
		return null // malformed percent-encoding
	}
	if (decoded.includes("\0")) return null
	if (decoded === "" || decoded === "/") decoded = "/index.html"
	if (!decoded.startsWith("/")) return null

	const root = resolve(staticDir)
	const full = resolve(root, "." + decoded)
	if (full !== root && !full.startsWith(root + sep)) return null
	if (!(extname(full).toLowerCase() in CONTENT_TYPES)) return null
	return full
}

export function createControlServer(opts: ControlServerOptions): ControlServer {
	const { port, staticDir, onMessage, onConnect } = opts

	const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "GET") {
			res.writeHead(405).end("Method Not Allowed")
			return
		}
		const file = resolveStaticPath(staticDir, req.url ?? "/")
		if (!file) {
			res.writeHead(404).end("Not Found")
			return
		}
		try {
			const body = readFileSync(file)
			res.writeHead(200, {
				"Content-Type": CONTENT_TYPES[extname(file).toLowerCase()],
				// The UI is edited live during development; never let a stale
				// module survive a reload.
				"Cache-Control": "no-cache",
			})
			res.end(body)
		} catch {
			res.writeHead(404).end("Not Found")
		}
	})

	const wss = new WebSocketServer({ server: httpServer })

	wss.on("connection", (ws: WebSocket) => {
		// Push a one-time state snapshot to the freshly connected client.
		onConnect?.((path, args) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ path, args }))
		})
		ws.on("message", (data) => {
			let parsed: unknown
			try {
				parsed = JSON.parse(data.toString())
			} catch {
				return // ignore non-JSON frames
			}
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				typeof (parsed as any).path === "string"
			) {
				const path = (parsed as any).path as string
				const args = Array.isArray((parsed as any).args) ? (parsed as any).args : []
				onMessage(path, args)
			}
		})
	})

	wss.on("error", (err) => console.error("[UI] WebSocket error:", err))
	httpServer.on("error", (err) => console.error("[UI] HTTP error:", err))

	httpServer.listen(port, () => {
		console.log(`UI up: http://localhost:${port}`)
	})

	return {
		broadcast(path, args) {
			const msg = JSON.stringify({ path, args })
			for (const client of wss.clients) {
				if (client.readyState === WebSocket.OPEN) client.send(msg)
			}
		},
		close() {
			try {
				wss.close()
			} catch {}
			try {
				httpServer.close()
			} catch {}
		},
		get clientCount() {
			let count = 0
			for (const client of wss.clients) {
				if (client.readyState === WebSocket.OPEN) count++
			}
			return count
		},
	}
}
