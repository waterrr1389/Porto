import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPreference, resolveTheme } from './theme.ts';

test('an explicit preference ignores the system appearance', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('system follows the current appearance', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('the control cycles system, light, dark and back', () => {
  assert.equal(nextPreference('system'), 'light');
  assert.equal(nextPreference('light'), 'dark');
  assert.equal(nextPreference('dark'), 'system');
});
