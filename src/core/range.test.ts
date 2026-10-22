import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRange } from './range.ts';

test('no or malformed header serves the whole file', () => {
  assert.deepEqual(decideRange(undefined, 100), { status: 200 });
  assert.deepEqual(decideRange('items=0-1', 100), { status: 200 });
  assert.deepEqual(decideRange('bytes=0-1,5-6', 100), { status: 200 });
  assert.deepEqual(decideRange('bytes=-', 100), { status: 200 });
});

test('closed and open ranges', () => {
  assert.deepEqual(decideRange('bytes=0-1', 100), { status: 206, start: 0, end: 1 });
  assert.deepEqual(decideRange('bytes=10-', 100), { status: 206, start: 10, end: 99 });
  assert.deepEqual(decideRange('bytes=90-200', 100), { status: 206, start: 90, end: 99 });
});

test('suffix ranges', () => {
  assert.deepEqual(decideRange('bytes=-10', 100), { status: 206, start: 90, end: 99 });
  assert.deepEqual(decideRange('bytes=-500', 100), { status: 206, start: 0, end: 99 });
  assert.deepEqual(decideRange('bytes=-0', 100), { status: 416 });
});

test('unsatisfiable ranges', () => {
  assert.deepEqual(decideRange('bytes=100-', 100), { status: 416 });
  assert.deepEqual(decideRange('bytes=5-4', 100), { status: 416 });
  assert.deepEqual(decideRange('bytes=0-0', 0), { status: 416 });
});
