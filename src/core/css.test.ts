import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeCss } from './css.ts';

const squash = (css: string) => css.replace(/\s+/g, ' ').trim();

test('prefixes each selector of each rule', () => {
  assert.equal(
    squash(scopeCss('a, .b > c { color: red }\n.d{margin:0}', '[x]')),
    '[x] a, [x] .b > c { color: red } [x] .d {margin:0}',
  );
});

test('drops comments', () => {
  assert.equal(squash(scopeCss('/* a{} */ .b { c: d }', '[x]')), '[x] .b { c: d }');
});

test('scopes rules inside media queries but not the query', () => {
  assert.equal(
    squash(scopeCss('@media (max-width: 9px) { .a { b: c } } .d { e: f }', '[x]')),
    '@media (max-width: 9px) { [x] .a { b: c } } [x] .d { e: f }',
  );
});

test('leaves descriptor blocks alone', () => {
  assert.equal(
    squash(scopeCss('@keyframes k { from { a: b } to { a: c } } .d { e: f }', '[x]')),
    '@keyframes k { from { a: b } to { a: c } } [x] .d { e: f }',
  );
  assert.equal(squash(scopeCss('@font-face { font-family: f }', '[x]')), '@font-face { font-family: f }');
});

test('scopes attribute selectors across lines', () => {
  assert.equal(
    squash(scopeCss('span[data-sc-class="w"],\ndiv[data-sc-class="e"] { a: b }', '[x]')),
    '[x] span[data-sc-class="w"], [x] div[data-sc-class="e"] { a: b }',
  );
});
