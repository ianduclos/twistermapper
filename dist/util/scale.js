export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const to127 = (n) => clamp(Math.round(n), 0, 127);
export const toFixedN = (x, dp = 5) => Number(x.toFixed(dp));
export const ledBrightHumanToDev = (h) => 18 + Math.round(clamp(h, 0, 29));
export const ringBrightHumanToDev = (h) => 64 + Math.round(clamp(h, 1, 31));
