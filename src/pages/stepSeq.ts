import type { Page, PageContext, LedFrame, LedState, EncId } from "../core/types.js"
import { clamp, toFixedN } from "../util/scale.js"
import colors from "../config/colors.json" with { type: "json" }

const TRACK_COUNT = 4
const STEP_COUNT = 12
const STEP_ENCODER_OFFSET = 4
const TRACK_ENCODERS = [0, 1, 2, 3] as const
const STEP_ENCODERS = Array.from({ length: STEP_COUNT }, (_, i) => STEP_ENCODER_OFFSET + i) as EncId[]
const DEFAULT_CLOCK_IDS = [0, 1, 2, 3] as const

type TrackState = {
	steps: number[]
	probabilities: number[]
	loopStart: number
	loopEnd: number
	playhead: number
	delay: number
}

export interface StepSeqTrackConfig {
	clockIds?: number[]
}

export interface StepSeqConfig {
	tracks?: StepSeqTrackConfig[]
}

type LoopEditState = {
	primary: number
	secondary?: number
	triggeredRange: boolean
}

const clampColorIndex = (value: number): number => {
	if (!Number.isFinite(value)) return 1
	const rounded = Math.round(value)
	if (rounded < 1) return 1
	if (rounded > 126) return 126
	return rounded
}

const TRACK_COLORS = [
	clampColorIndex(Number(colors.purple ?? 110)),
	clampColorIndex(Number(colors.cyan ?? 33)),
	clampColorIndex(Number(colors.yellow ?? 66)),
	clampColorIndex(Number(colors.red ?? 80)),
] as const

const createTrack = (): TrackState => ({
	steps: new Array<number>(STEP_COUNT).fill(0),
	probabilities: new Array<number>(STEP_COUNT).fill(100),
	loopStart: 0,
	loopEnd: STEP_COUNT - 1,
	playhead: 0,
	delay: 0,
})

const sanitizeClockIds = (ids: number[] | undefined): number[] => {
	if (!ids || ids.length === 0) return [...DEFAULT_CLOCK_IDS]
	const out: number[] = []
	for (const id of ids) {
		const n = Math.round(Number(id))
		if (!Number.isFinite(n)) continue
		const clamped = clamp(n, 0, 5)
		const normalized = ((clamped % 4) + 4) % 4
		if (!out.includes(normalized)) out.push(normalized)
	}
	if (!out.length) return [...DEFAULT_CLOCK_IDS]
	out.sort((a, b) => a - b)
	return out
}

export function StepSeqPage(config?: StepSeqConfig): Page {
const tracks = Array.from({ length: TRACK_COUNT }, () => createTrack())
const lastOutputs = new Array<number>(TRACK_COUNT).fill(0)
let highlightedTrack = 0
let dirty = true
let ctxRef: PageContext | null = null
const trackClockFilters = Array.from({ length: TRACK_COUNT }, (_, idx) =>
 sanitizeClockIds(config?.tracks?.[idx]?.clockIds)
)

const SHIFT_LATCH_DOUBLE_MS = 320
let probabilityLatched = false
let lastShiftTapAt = 0

	const stepButtonsDown = new Set<number>()
	let loopEdit: LoopEditState | null = null

	const emitPageType = (ctx: PageContext) => {
		ctx.osc.send(`/twister/out/page/${ctx.slotLabel}/type`, "StepSeq")
	}

	const emitTrackValue = (ctx: PageContext, trackId: number) => {
		const value = tracks[trackId].steps[tracks[trackId].playhead]
		lastOutputs[trackId] = value
		ctx.osc.send(
			`/twister/out/page/${ctx.slotLabel}/index/${trackId}/value`,
			toFixedN(value / 127, 5)
		)
	}

	const clampStepIndex = (step: number) => clamp(step, 0, STEP_COUNT - 1)

	const applyLoopRange = (
		ctx: PageContext,
		trackId: number,
		start: number,
		end: number
	) => {
		const track = tracks[trackId]
		const loopStart = clampStepIndex(Math.min(start, end))
		const loopEnd = clampStepIndex(Math.max(start, end))
		track.loopStart = loopStart
		track.loopEnd = loopEnd
		if (track.playhead < loopStart || track.playhead > loopEnd) {
			track.playhead = loopStart
			emitTrackValue(ctx, trackId)
		}
		dirty = true
		ctx.setDirty()
	}

	const setSingleLoopEndpoint = (ctx: PageContext, step: number) => {
		const track = tracks[highlightedTrack]
		const end = clampStepIndex(step)
		if (track.loopStart > end) {
			track.loopStart = 0
		}
		track.loopEnd = end
		if (track.playhead < track.loopStart || track.playhead > track.loopEnd) {
			track.playhead = track.loopStart
			emitTrackValue(ctx, highlightedTrack)
		}
		dirty = true
		ctx.setDirty()
	}

	const advanceTrack = (ctx: PageContext, trackId: number) => {
		const track = tracks[trackId]
		if (track.loopStart > track.loopEnd) {
			track.loopStart = 0
			track.loopEnd = STEP_COUNT - 1
		}
		if (track.playhead < track.loopStart || track.playhead > track.loopEnd) {
			track.playhead = track.loopStart
		}
		if (track.delay > 0) {
			track.delay -= 1
			emitTrackValue(ctx, trackId)
			return
		}
	const probability = clamp(track.probabilities[track.playhead], 0, 100)
	const roll = Math.random() * 100
	if (roll >= probability) {
		track.delay = 1
		emitTrackValue(ctx, trackId)
		return
	}
		let next = track.playhead + 1
		if (next > track.loopEnd) next = track.loopStart
		track.playhead = clampStepIndex(next)
		emitTrackValue(ctx, trackId)
	}

const clampProbability = (value: number) => clamp(Math.round(value), 0, 100)

const handleTrackPress = (ctx: PageContext, trackId: number) => {
	if (highlightedTrack === trackId) return
	highlightedTrack = trackId
	dirty = true
	ctx.setDirty()
}

const isProbabilityMode = (ctx: PageContext) => probabilityLatched || ctx.modifiers.shiftRight

const probabilityStepSize = (ctx: PageContext) => Math.max(1, Math.round(128 / ctx.resolution))

const adjustTrackProbability = (ctx: PageContext, trackId: number, delta: number) => {
	const change = delta * probabilityStepSize(ctx)
	if (!change) return
	const track = tracks[trackId]
	let changed = false
	for (let i = 0; i < STEP_COUNT; i++) {
		const next = clampProbability(track.probabilities[i] + change)
		if (next !== track.probabilities[i]) {
			track.probabilities[i] = next
			changed = true
		}
	}
	if (!changed) return
	dirty = true
	ctx.setDirty()
}

const adjustStepProbability = (ctx: PageContext, trackId: number, stepIdx: number, delta: number) => {
	const change = delta * probabilityStepSize(ctx)
	if (!change) return
	const track = tracks[trackId]
	const next = clampProbability(track.probabilities[stepIdx] + change)
	if (next === track.probabilities[stepIdx]) return
	track.probabilities[stepIdx] = next
	dirty = true
	ctx.setDirty()
}

const handleStepTurn = (ctx: PageContext, stepEncIndex: number, delta: number) => {
	const stepIdx = clampStepIndex(stepEncIndex)
	if (isProbabilityMode(ctx)) {
		adjustStepProbability(ctx, highlightedTrack, stepIdx, delta)
		return
	}
	const track = tracks[highlightedTrack]
	const stepSize = Math.max(1, Math.round(128 / ctx.resolution))
	const nextValue = clamp(track.steps[stepIdx] + delta * stepSize, 0, 127)
	if (track.steps[stepIdx] === nextValue) return
	track.steps[stepIdx] = nextValue
	if (track.playhead === stepIdx) {
		emitTrackValue(ctx, highlightedTrack)
	}
	dirty = true
	ctx.setDirty()
}

const handleStepPressDown = (stepIdx: number, ctx: PageContext) => {
	stepButtonsDown.add(stepIdx)
	if (!loopEdit) {
		loopEdit = { primary: stepIdx, triggeredRange: false }
		return
	}
	if (!loopEdit.triggeredRange && stepIdx !== loopEdit.primary) {
		loopEdit.secondary = stepIdx
		loopEdit.triggeredRange = true
		applyLoopRange(ctx, highlightedTrack, loopEdit.primary, stepIdx)
	}
}

const handleStepPressUp = (stepIdx: number, ctx: PageContext) => {
	stepButtonsDown.delete(stepIdx)
	if (!loopEdit) return
	if (!loopEdit.triggeredRange && stepIdx === loopEdit.primary) {
		setSingleLoopEndpoint(ctx, stepIdx)
	}
	if (stepButtonsDown.size === 0) {
		if (!loopEdit.triggeredRange && stepIdx === loopEdit.primary) {
			setSingleLoopEndpoint(ctx, stepIdx)
		}
		loopEdit = null
	}
}

	const renderFrame = (): LedFrame => {
		const frame = {} as LedFrame
		const showProbability = probabilityLatched || (ctxRef?.modifiers.shiftRight ?? false)

	for (const trackEnc of TRACK_ENCODERS) {
		const trackId = trackEnc
		const isHighlighted = highlightedTrack === trackId
		const ringValue = showProbability ? 0 : clamp(lastOutputs[trackId], 0, 127)
		frame[trackEnc as EncId] = {
			ring: ringValue,
			rgb: TRACK_COLORS[trackId],
			ledBrightness: isHighlighted ? 29 : 10,
			ringBrightness: 31,
			anim: "none",
		}
	}

		const track = tracks[highlightedTrack]
		const baseColor = TRACK_COLORS[highlightedTrack]
		const playheadColor = clampColorIndex(baseColor + 13)

		for (const encId of STEP_ENCODERS) {
			const stepIndex = encId - STEP_ENCODER_OFFSET
			const withinLoop =
				stepIndex >= track.loopStart && stepIndex <= track.loopEnd
			const isPlayhead = withinLoop && stepIndex === track.playhead
			const ledBrightness = isPlayhead ? 29 : withinLoop ? 15 : 3
		const ringValue = showProbability
			? clamp(Math.round((track.probabilities[stepIndex] / 100) * 127), 0, 127)
			: track.steps[stepIndex]
			const rgb = isPlayhead ? playheadColor : baseColor

			const state: LedState = {
				ring: clamp(ringValue, 0, 127),
				rgb,
				ledBrightness,
				ringBrightness: 31,
				anim: "none",
			}

			frame[encId] = state
		}

		return frame
	}

	return {
		init(ctx) {
			ctxRef = ctx
			emitPageType(ctx)
			for (let t = 0; t < TRACK_COUNT; t++) {
				emitTrackValue(ctx, t)
			}
			dirty = true
		},
		onFocus(ctx) {
			ctxRef = ctx
			emitPageType(ctx)
			dirty = true
		},
		onBlur() {},
		onEvent(ev, ctx) {
			switch (ev.type) {
				case "encoder/press": {
					if (ev.id >= 0 && ev.id <= 3 && ev.down) {
						handleTrackPress(ctx, ev.id)
						return
					}
					if (ev.id >= STEP_ENCODER_OFFSET && ev.id <= STEP_ENCODER_OFFSET + STEP_COUNT - 1) {
						const stepIdx = ev.id - STEP_ENCODER_OFFSET
						if (ev.down) handleStepPressDown(stepIdx, ctx)
						else handleStepPressUp(stepIdx, ctx)
					}
					return
				}
			case "encoder/turn": {
				if (ev.id >= 0 && ev.id <= 3) {
					if (isProbabilityMode(ctx)) {
						adjustTrackProbability(ctx, ev.id, ev.delta)
					}
					return
				}
				if (
					ev.id >= STEP_ENCODER_OFFSET &&
					ev.id <= STEP_ENCODER_OFFSET + STEP_COUNT - 1
				) {
					handleStepTurn(ctx, ev.id - STEP_ENCODER_OFFSET, ev.delta)
				}
				return
			}
			case "side/shift": {
				if (ev.side === "right") {
					if (ev.down) {
						const now = Date.now()
						if (probabilityLatched) {
							probabilityLatched = false
						} else if (now - lastShiftTapAt <= SHIFT_LATCH_DOUBLE_MS) {
							probabilityLatched = true
						}
						lastShiftTapAt = now
						dirty = true
						ctx.setDirty()
					} else if (!probabilityLatched) {
						dirty = true
						ctx.setDirty()
					}
				}
				return
			}
			default:
				return
			}
		},
		onOsc(path, args, ctx) {
			if (path === "/twister/in/clock") {
				const rawId = Number(args?.[0])
				if (!Number.isFinite(rawId)) return
				const clockId = ((Math.round(rawId) % 4) + 4) % 4
				let ticked = false
				for (let t = 0; t < TRACK_COUNT; t++) {
					if (!trackClockFilters[t].includes(clockId)) continue
					advanceTrack(ctx, t)
					ticked = true
				}
				if (ticked) {
					dirty = true
					ctx.setDirty()
				}
			}
		},
		render() {
			if (!dirty) return
			dirty = false
			return renderFrame()
		},
		dispose() {
			stepButtonsDown.clear()
			loopEdit = null
			ctxRef = null
			probabilityLatched = false
			lastShiftTapAt = 0
		},
	}
}
