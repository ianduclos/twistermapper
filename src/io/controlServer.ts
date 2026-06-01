/* Optional control surface: a tiny HTTP + WebSocket server for the web UI.
 *
 * Off by default; enabled via --ui flag or TWISTER_UI=1 (see cli/index.ts).
 * The daemon stays fully headless without it.
 *
 * Protocol (intentionally mirrors OSC so the UI and OSC share one vocabulary):
 *   browser -> daemon : JSON { path: string, args: any[] }  -> routeControl()
 *   daemon  -> browser: JSON { path: string, args: any[] }  (selected /twister/out/...)
 *
 * The HTTP side serves a single static index.html (no build step).
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { WebSocketServer, WebSocket } from "ws"

export interface ControlServer {
	/** Forward an outbound twister message to all connected UIs. */
	broadcast: (path: string, args: Array<number | string | boolean>) => void
	close: () => void
}

export interface ControlServerOptions {
	port: number
	/** Absolute path to the static index.html to serve. */
	staticFile: string
	/** Called for each inbound { path, args } from a UI client. */
	onMessage: (path: string, args: any[]) => void
	/** Called when a UI connects, to push a state snapshot to just that client. */
	onConnect?: (send: (path: string, args: Array<number | string | boolean>) => void) => void
}

export function createControlServer(opts: ControlServerOptions): ControlServer {
	const { port, staticFile, onMessage, onConnect } = opts

	const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
		// Single-page app: serve index.html for any GET; everything else is over WS.
		if (req.method !== "GET") {
			res.writeHead(405).end("Method Not Allowed")
			return
		}
		try {
			const html = readFileSync(staticFile)
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			res.end(html)
		} catch (err) {
			res.writeHead(500).end("Failed to read UI file")
			console.error("[UI] could not read", staticFile, err)
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
	}
}
