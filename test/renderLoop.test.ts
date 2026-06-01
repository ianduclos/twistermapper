import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createRenderLoop } from "../src/render/renderLoop.js"

describe("createRenderLoop", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("derives interval from fps and clamps out-of-range values", () => {
		expect(createRenderLoop({ fps: 30, onFrame: () => {} }).intervalMs).toBeCloseTo(33.333, 2)
		expect(createRenderLoop({ fps: 60, onFrame: () => {} }).intervalMs).toBeCloseTo(16.666, 2)
		expect(createRenderLoop({ fps: 0, onFrame: () => {} }).intervalMs).toBeCloseTo(33.333, 2)
		expect(createRenderLoop({ fps: 99999, onFrame: () => {} }).intervalMs).toBeCloseTo(1000 / 120, 2)
	})

	it("calls onFrame once per interval while running", () => {
		let frames = 0
		const loop = createRenderLoop({ fps: 30, onFrame: () => frames++ })
		loop.start()
		vi.advanceTimersByTime(1000) // ~30 frames in one second
		expect(frames).toBe(30)
	})

	it("stops firing after stop()", () => {
		let frames = 0
		const loop = createRenderLoop({ fps: 30, onFrame: () => frames++ })
		loop.start()
		vi.advanceTimersByTime(100)
		const atStop = frames
		loop.stop()
		vi.advanceTimersByTime(1000)
		expect(frames).toBe(atStop)
		expect(loop.running).toBe(false)
	})

	it("start() is idempotent (no double scheduling)", () => {
		let frames = 0
		const loop = createRenderLoop({ fps: 30, onFrame: () => frames++ })
		loop.start()
		loop.start()
		vi.advanceTimersByTime(1000)
		expect(frames).toBe(30)
	})

	it("isolates frame errors so the loop keeps running", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		let frames = 0
		const loop = createRenderLoop({
			fps: 30,
			onFrame: () => {
				frames++
				if (frames === 2) throw new Error("boom")
			},
		})
		loop.start()
		vi.advanceTimersByTime(1000 / 30 * 4)
		expect(frames).toBe(4) // kept ticking past the throwing frame
		errSpy.mockRestore()
	})
})
