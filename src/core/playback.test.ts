import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cue } from './subtitles.ts';
import { classifyMove, cueStepTarget, swipeOffset } from './playback.ts';

const cues: Cue[] = [
  { id: 0, start: 10, end: 12, text: 'a' },
  { id: 1, start: 15, end: 18, text: 'b' },
  { id: 2, start: 15, end: 16, text: 'c' },
  { id: 3, start: 30, end: 33, text: 'd' },
];

test('next goes to the first line starting after the playhead', () => {
  assert.equal(cueStepTarget(cues, 0, 1), 10);
  assert.equal(cueStepTarget(cues, 10, 1), 15);
  assert.equal(cueStepTarget(cues, 16, 1), 30);
  assert.equal(cueStepTarget(cues, 30, 1), null);
});

test('previous goes to the line before the one on screen, whatever its progress', () => {
  assert.equal(cueStepTarget(cues, 17, -1), 10);
  assert.equal(cueStepTarget(cues, 15, -1), 10);
  assert.equal(cueStepTarget(cues, 15.5, -1), 10);
  assert.equal(cueStepTarget(cues, 10.5, -1), null);
  assert.equal(cueStepTarget(cues, 13, -1), 10);
  assert.equal(cueStepTarget(cues, 19, -1), 15);
  assert.equal(cueStepTarget([], 10, -1), null);
});

test('a press is a tap or hold until it moves, then a swipe only when horizontal', () => {
  assert.equal(classifyMove(3, 4), 'pending');
  assert.equal(classifyMove(-20, 5), 'swipe');
  assert.equal(classifyMove(10, 20), 'cancel');
});

test('swipe offsets are fine for short swipes and grow with distance', () => {
  assert.equal(swipeOffset(10, 1000), 1);
  assert.equal(swipeOffset(-10, 1000), -1);
  assert.equal(swipeOffset(500, 1000), 90);
  assert.equal(swipeOffset(2000, 1000), 300);
  assert.equal(swipeOffset(10, 0), 0);
});
