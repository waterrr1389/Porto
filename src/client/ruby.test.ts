import { test } from 'node:test';
import assert from 'node:assert/strict';
import { furiganaParts, hasKanji } from './ruby.ts';

test('puts the kanji reading over its run and leaves the kana alone', () => {
  assert.deepEqual(furiganaParts('食べる', 'たべる'), [
    { text: '食', ruby: 'た' },
    { text: 'べる' },
  ]);
});

test('aligns several kanji runs against their kana anchors', () => {
  assert.deepEqual(furiganaParts('申し込み', 'もうしこみ'), [
    { text: '申', ruby: 'もう' },
    { text: 'し' },
    { text: '込', ruby: 'こ' },
    { text: 'み' },
  ]);
});

test('a trailing kanji run takes the rest of the reading', () => {
  assert.deepEqual(furiganaParts('日本語', 'にほんご'), [{ text: '日本語', ruby: 'にほんご' }]);
  assert.deepEqual(furiganaParts('お茶', 'おちゃ'), [{ text: 'お' }, { text: '茶', ruby: 'ちゃ' }]);
});

test('gives up when the kana anchors do not match', () => {
  assert.equal(furiganaParts('食べる', 'たべます'), null);
});

test('kana-only or already-identical readings need no ruby', () => {
  assert.equal(furiganaParts('たべる', 'たべる'), null);
  assert.equal(furiganaParts('たべる', 'タベル'), null);
  assert.equal(furiganaParts('日本', ''), null);
});

test('hasKanji detects CJK and iteration marks', () => {
  assert.equal(hasKanji('日本'), true);
  assert.equal(hasKanji('時々'), true);
  assert.equal(hasKanji('たべる'), false);
  assert.equal(hasKanji('abc'), false);
});
