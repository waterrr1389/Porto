// Bundles the client into dist/: index.html, app.js (including core/ and the
// Yomitan renderer) and app.css (from the stylesheets main.ts imports).
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'dist');
const clientDir = join(root, 'src/client');
const yomitanDir = join(root, 'vendor/yomitan/ext');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: { app: join(clientDir, 'main.ts') },
  bundle: true,
  format: 'esm',
  // iPadOS / iOS 17 Safari is the oldest target.
  target: 'safari17',
  sourcemap: true,
  outdir: outDir,
  logLevel: 'warning',
  alias: {
    // Yomitan is imported by bare specifier so TypeScript can use site-local declarations.
    'yomitan/structured-content-generator': join(yomitanDir, 'js/display/structured-content-generator.js'),
    'yomitan/structured-content.css': join(yomitanDir, 'css/structured-content.css'),
  },
});
copyFileSync(join(clientDir, 'index.html'), join(outDir, 'index.html'));
console.log(`built client into ${outDir}`);
