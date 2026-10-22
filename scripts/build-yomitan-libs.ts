// Builds the third-party libraries that Yomitan's modules import from
// `ext/lib/` into `vendor-build/`, from the pinned npm packages in
// package.json. Yomitan's own build:libs needs a git dependency, so only the
// libraries reached by the importer, the translator and the structured-content
// renderer are built here.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'vendor-build');
const schemaDir = join(root, 'vendor/yomitan/ext/data/schemas');

/** Output file name -> module source, mirroring vendor/yomitan/dev/lib. */
const libs: Record<string, string> = {
  'zip.js': "export * from '@zip.js/zip.js/lib/zip.js';",
  'kanji-processor.js': "export * from 'kanji-processor';",
  'hangul-js.js': "export * as Hangul from 'hangul-js';",
  'ucs2length.js':
    "import runtime from 'ajv/dist/runtime/ucs2length.js';\nexport const ucs2length = runtime.default;",
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const [name, contents] of Object.entries(libs)) {
  await build({
    stdin: { contents, resolveDir: root, sourcefile: name },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile: join(outDir, name),
    logLevel: 'warning',
  });
}

// Schema validators are compiled ahead of time, as Yomitan does, because the
// extension's content security policy forbids generating code at runtime.
const schemas = readdirSync(schemaDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(schemaDir, name), 'utf8')));
const ajv = new Ajv.default({ schemas, code: { source: true, esm: true }, allowUnionTypes: true });
const validators = standaloneCode.default(ajv).replaceAll(
  'require("ajv/dist/runtime/ucs2length").default',
  'ucs2length',
);
writeFileSync(join(outDir, 'validate-schemas.js'), `import {ucs2length} from './ucs2length.js';\n${validators}`);

console.log(`built ${Object.keys(libs).length + 1} libraries into ${outDir}`);
