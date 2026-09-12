/* WebSocket transport to the daemon.
 *
 * The wire format mirrors OSC exactly — { path, args } — so the UI and any OSC
 * client speak the same vocabulary (see routeControl in src/cli/index.ts).
 * This module owns the socket, the reconnect loop, and the header status dot;
 * it knows nothing about what any particular path means.
 */

export function createBus({ onMessage }) {
	const dot = document.getElementById("dot")
	const statusText = document.getElementById("statusText")
	let ws = null

	function connect() {
		ws = new WebSocket(`ws://${location.host}`)
		ws.onopen = () => {
			dot.classList.add("on")
			statusText.textContent = "connected"
		}
		ws.onclose = () => {
			dot.classList.remove("on")
			statusText.textContent = "disconnected — retrying…"
			setTimeout(connect, 1000)
		}
		ws.onmessage = (e) => {
			try {
				onMessage(JSON.parse(e.data))
			} catch {}
		}
	}

	function send(path, ...args) {
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ path, args }))
	}

	return { connect, send }
}
