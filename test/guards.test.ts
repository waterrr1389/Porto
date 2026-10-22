// Enforces the import boundaries listed under Invariants in ARCHITECTURE.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** Module specifiers of static imports, re-exports and dynamic imports. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const patterns = [
    /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

function sourceFiles(pattern: string): string[] {
  return globSync(pattern, { cwd: root }).map((f) => resolve(root, f));
}

test('core imports nothing outside core', () => {
  const core = resolve(root, 'src/core');
  for (const file of sourceFiles('src/core/**/*.ts')) {
    for (const spec of importsOf(file)) {
      const ok = spec.startsWith('.') && !relative(core, resolve(dirname(file), spec)).startsWith('..');
      assert.ok(ok, `${relative(root, file)} imports ${spec}`);
    }
  }
});

test('only adapters/dictionary and views/panel import Yomitan', () => {
  const allowed = [
    resolve(root, 'src/server/adapters/dictionary'),
    resolve(root, 'src/client/views/panel'),
  ];
  const isAllowed = (file: string) =>
    allowed.some((dir) => file === `${dir}.ts` || !relative(dir, file).startsWith('..'));
  for (const file of sourceFiles('src/**/*.ts')) {
    if (isAllowed(file)) continue;
    for (const spec of importsOf(file)) {
      assert.ok(!/vendor(-build)?\/|yomitan/i.test(spec), `${relative(root, file)} imports ${spec}`);
    }
  }
});
