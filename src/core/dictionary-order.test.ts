import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderByPriority } from './dictionary-order.ts';

interface Item {
  dictionary: string;
  value: number;
}

const items: Item[] = [
  { dictionary: 'Jiten', value: 1 },
  { dictionary: 'JPDB', value: 2 },
  { dictionary: '明鏡', value: 3 },
];

const names = (result: Item[]): string[] => result.map((item) => item.dictionary);

test('keeps the original order without a priority list', () => {
  assert.deepEqual(names(orderByPriority(items, (item) => item.dictionary, [])), ['Jiten', 'JPDB', '明鏡']);
});

test('puts listed dictionaries first, in list order', () => {
  assert.deepEqual(names(orderByPriority(items, (item) => item.dictionary, ['明鏡', 'Jiten'])), [
    '明鏡',
    'Jiten',
    'JPDB',
  ]);
});

test('ignores priorities that name no item and keeps the rest in import order', () => {
  assert.deepEqual(names(orderByPriority(items, (item) => item.dictionary, ['Missing', 'JPDB'])), [
    'JPDB',
    'Jiten',
    '明鏡',
  ]);
});

test('a dictionary listed twice keeps its first position', () => {
  assert.deepEqual(names(orderByPriority(items, (item) => item.dictionary, ['JPDB', 'Jiten', 'JPDB'])), [
    'JPDB',
    'Jiten',
    '明鏡',
  ]);
});

test('returns a new array and leaves the input untouched', () => {
  const result = orderByPriority(items, (item) => item.dictionary, ['明鏡']);
  assert.notEqual(result, items);
  assert.deepEqual(names(items), ['Jiten', 'JPDB', '明鏡']);
});
