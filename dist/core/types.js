export const SLOT_INDICES = [0, 1, 2, 3, 4, 5, 6, 7];
export const SLOT_LABELS = [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
];
export const slotLabel = (slot) => SLOT_LABELS[slot];
export const slotFromLabel = (label) => {
    const lower = label.toLowerCase();
    const idx = SLOT_LABELS.findIndex((entry) => entry === lower);
    if (idx === -1)
        return undefined;
    return SLOT_INDICES[idx];
};
