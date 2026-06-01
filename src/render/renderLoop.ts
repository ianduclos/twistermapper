/* Render loop: a fixed-rate clock that drives LED output.
 *
 * Why: previously every input event / OSC message / clock tick pushed to the
 * LedReconciler immediately. Under sustained load (e.g. a fast clock driving
 * StepSeq) those pushes collided with the reconciler's burst/rolling caps and,
 * with no drain, LEDs lagged or stuck.
 *
 * Instead we tick at a fixed rate (default 30Hz) and push the *current* desired
 * frame once per frame. The reconciler diffs, so an unchanged frame sends zero
 * MIDI; and because it keeps unsent work pending and recomputes from the latest
 * desired each push, the loop itself is the self-drain. LED output is the only
 * thing frame-gated here — OSC out still happens immediately inside pages.
 */

export interface RenderLoop {
	start(): void
	stop(): void
	readonly running: boolean
	readonly intervalMs: number
}

export interface RenderLoopOptions {
	/** Target frames per second (clamped to 1..120). Default 30. */
	fps?: number
	/** Called once per frame while running. */
	onFrame: () => void
}

export function createRenderLoop(opts: RenderLoopOptions): RenderLoop {
	const fps = clampFps(opts.fps ?? 30)
	const intervalMs = 1000 / fps
	let timer: ReturnType<typeof setInterval> | null = null

	return {
		start() {
			if (timer) return
			timer = setInterval(() => {
				try {
					opts.onFrame()
				} catch (err) {
					console.error("[RenderLoop] frame error:", err)
				}
			}, intervalMs)
		},
		stop() {
			if (!timer) return
			clearInterval(timer)
			timer = null
		},
		get running() {
			return timer !== null
		},
		get intervalMs() {
			return intervalMs
		},
	}
}

function clampFps(fps: number): number {
	if (!Number.isFinite(fps) || fps <= 0) return 30
	return Math.max(1, Math.min(120, fps))
}
