export const clamp = (n: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, n))
export const to127 = (n: number) => clamp(Math.round(n), 0, 127)
export const toFixedN = (x: number, dp = 5) => Number(x.toFixed(dp))
export const ledBrightHumanToDev = (h: number) =>
	18 + Math.round(clamp(h, 0, 29))
export const ringBrightHumanToDev = (h: number) =>
	64 + Math.round(clamp(h, 1, 31))
