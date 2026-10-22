import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightRange, isLookupStart, scanText } from './scan.ts';

test('isLookupStart accepts kana, ideographs and iteration marks', () => {
  for (const char of ['あ', 'ん', 'ア', 'ヴ', 'ー', 'ｱ', 'ｦ', '漢', '語', '㐀', '豈', '々', '〆', '〇']) {
    assert.equal(isLookupStart(char), true, char);
  }
});

test('isLookupStart rejects everything else', () => {
  for (const char of ['A', 'a', '1', ' ', '\n', '。', '、', '，', '😀', 'ﾞ', '']) {
    assert.equal(isLookupStart(char), false, JSON.stringify(char));
  }
});

test('scanText returns the rest of the line from the tapped character', () => {
  assert.equal(scanText('日本語の文です', 0), '日本語の文です');
  assert.equal(scanText('日本語の文です', 2), '語の文です');
});

test('scanText honours maxLength in code units', () => {
  assert.equal(scanText('あいうえお', 1, 2), 'いう');
  assert.equal(scanText('あいうえお', 4, 10), 'お');
  assert.equal(scanText('あいうえお', 0, 0), '');
});

test('scanText stops before a newline', () => {
  assert.equal(scanText('あい\nうえお', 0), 'あい');
  assert.equal(scanText('あい\nうえお', 3), 'うえお');
  assert.equal(scanText('あい\nうえお', 2), null);
});

test('scanText never splits a surrogate pair at the limit', () => {
  const text = 'あ𠮟る';
  assert.equal(scanText(text, 0, 2), 'あ');
  assert.equal(scanText(text, 0, 3), 'あ𠮟');
  assert.equal(scanText(text, 0, 4), 'あ𠮟る');
  assert.equal(scanText(text, 1), null);
});

test('scanText returns null when the tapped character cannot start a lookup', () => {
  assert.equal(scanText('abc', 0), null);
  assert.equal(scanText('漢abc', 1), null);
  assert.equal(scanText('。あ', 0), null);
});

test('scanText returns null for offsets outside the text', () => {
  assert.equal(scanText('あい', -1), null);
  assert.equal(scanText('あい', 2), null);
  assert.equal(scanText('あい', 10), null);
  assert.equal(scanText('あい', Number.NaN), null);
  assert.equal(scanText('あい', 1.5), null);
  assert.equal(scanText('', 0), null);
});

test('scanText defaults to 32 code units', () => {
  assert.equal(scanText('あ'.repeat(40), 0), 'あ'.repeat(32));
});

test('highlightRange highlights the matched length', () => {
  assert.deepEqual(highlightRange('日本語の文', 1, 2), { start: 1, end: 3 });
});

test('highlightRange highlights at least one character', () => {
  assert.deepEqual(highlightRange('日本語', 1, 0), { start: 1, end: 2 });
  assert.deepEqual(highlightRange('日本語', 1, -4), { start: 1, end: 2 });
  assert.deepEqual(highlightRange('あ𠮟る', 1, 0), { start: 1, end: 3 });
});

test('highlightRange clips to the end of the tapped line', () => {
  assert.deepEqual(highlightRange('あい\nうえ', 1, 10), { start: 1, end: 2 });
  assert.deepEqual(highlightRange('あい\nうえ', 0, 99), { start: 0, end: 2 });
  assert.deepEqual(highlightRange('あい\nうえ', 2, 2), { start: 2, end: 2 });
  assert.deepEqual(highlightRange('あい\nうえ', 3, 99), { start: 3, end: 5 });
});

test('highlightRange clamps offsets outside the text', () => {
  assert.deepEqual(highlightRange('あい', 99, 1), { start: 2, end: 2 });
  assert.deepEqual(highlightRange('あい', -5, 1), { start: 0, end: 1 });
});
