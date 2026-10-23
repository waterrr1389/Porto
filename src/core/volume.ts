// The player's own volume steps. iPadOS's hardware steps are coarse and the
// lowest is already loud, so the app attenuates below them. Steps are spaced
// in decibels rather than linearly, which makes the quiet end finer.

/** Gain per level, quietest first; the last level is the unaltered signal. */
export const VOLUME_GAINS = [0.06, 0.1, 0.16, 0.25, 0.35, 0.5, 0.7, 1] as const;

/** Half the original loudness. */
export const DEFAULT_VOLUME_LEVEL = 5;

/** Level selected at `fraction` (0 = bottom, 1 = top) of a slider with one segment per level. */
export function levelAt(fraction: number): number {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return Math.min(Math.floor(clamped * VOLUME_GAINS.length), VOLUME_GAINS.length - 1);
}

/** A stored level, or the default when it is missing or out of range. */
export function parseLevel(stored: string | null): number {
  const level = Number(stored);
  return stored !== null && stored.trim() !== '' && Number.isInteger(level) && level >= 0 && level < VOLUME_GAINS.length
    ? level
    : DEFAULT_VOLUME_LEVEL;
}
