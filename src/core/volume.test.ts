import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VOLUME_LEVEL, VOLUME_GAINS, levelAt, parseLevel } from './volume.ts';

test('gains rise to the unaltered signal', () => {
  for (let index = 1; index < VOLUME_GAINS.length; index += 1) {
    assert.ok((VOLUME_GAINS[index] as number) > (VOLUME_GAINS[index - 1] as number));
  }
  assert.equal(VOLUME_GAINS.at(-1), 1);
});

test('a slider position maps to one segment per level', () => {
  assert.equal(levelAt(0), 0);
  assert.equal(levelAt(-1), 0);
  assert.equal(levelAt(0.13), 1);
  assert.equal(levelAt(0.99), VOLUME_GAINS.length - 1);
  assert.equal(levelAt(1), VOLUME_GAINS.length - 1);
});

test('stored levels fall back to the default when invalid', () => {
  assert.equal(parseLevel('2'), 2);
  assert.equal(parseLevel(null), DEFAULT_VOLUME_LEVEL);
  assert.equal(parseLevel(''), DEFAULT_VOLUME_LEVEL);
  assert.equal(parseLevel('8'), DEFAULT_VOLUME_LEVEL);
  assert.equal(parseLevel('1.5'), DEFAULT_VOLUME_LEVEL);
});
