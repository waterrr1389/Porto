// Pure rules behind the player's touch controls: stepping between subtitle
// lines, telling a swipe from a tap or a hold, and turning a swipe into a seek.
import type { Cue } from './subtitles.ts';

/** A press held this long without moving speeds playback up. */
export const HOLD_MS = 400;
/** Playback rate while the stage is held. */
export const HOLD_RATE = 2;

/** Movement below this many pixels still counts as a tap or a hold. */
const SLOP_PX = 10;
/** Within this many seconds of a line's start, "previous" skips to the line before it. */
const RESTART_WINDOW_S = 1;
/** Keeps "next" from landing on the line the playhead has just been put on. */
const EPSILON_S = 0.05;

/**
 * Start time of the line to jump to, or null when there is none. Backwards
 * restarts the current line unless it started less than a second ago, the way
 * a "previous track" button does; `cues` must be sorted by start.
 */
export function cueStepTarget(cues: readonly Cue[], time: number, direction: -1 | 1): number | null {
  if (direction === 1) {
    for (const cue of cues) if (cue.start > time + EPSILON_S) return cue.start;
    return null;
  }
  let target: number | null = null;
  for (const cue of cues) {
    if (cue.start >= time - RESTART_WINDOW_S) break;
    target = cue.start;
  }
  return target;
}

export type MoveKind = 'pending' | 'swipe' | 'cancel';

/** Classifies a press by how far it has moved: a mostly horizontal drag is a swipe, any other drag is neither tap nor swipe. */
export function classifyMove(dx: number, dy: number): MoveKind {
  if (Math.hypot(dx, dy) < SLOP_PX) return 'pending';
  return Math.abs(dx) > Math.abs(dy) * 1.5 ? 'swipe' : 'cancel';
}

/**
 * Seconds to seek for a horizontal swipe of `dx` pixels over a surface `width`
 * pixels wide. Short swipes move by single seconds; the step grows with
 * distance so a full-width swipe covers five minutes.
 */
export function swipeOffset(dx: number, width: number): number {
  if (width <= 0) return 0;
  const ratio = Math.min(Math.abs(dx) / width, 1);
  return Math.sign(dx) * Math.round(ratio * 60 + ratio * ratio * 240);
}
