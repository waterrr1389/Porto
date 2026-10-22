// Imports Yomitan dictionary zips into the dictionary database.
// Usage: npm run import-dicts [-- file.zip ...]   (default: dicts/*.zip, sorted)
// Order is priority order; dictionaries already present are skipped.
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importDictionaries } from '../src/server/adapters/dictionary/index.ts';
import { paths } from '../src/server/paths.ts';

const args = process.argv.slice(2);
const files =
  args.length > 0
    ? args.map((file) => resolve(file))
    : readdirSync(paths.dicts)
        .filter((name) => name.endsWith('.zip'))
        .sort()
        .map((name) => join(paths.dicts, name));
if (files.length === 0) {
  console.error(`no dictionaries given and none in ${paths.dicts}`);
  process.exit(1);
}

mkdirSync(paths.cache, { recursive: true });
let failed = false;
for (const result of await importDictionaries(paths.dictionaryDatabase, files)) {
  const time = `${result.seconds.toFixed(1)}s`;
  if (result.outcome === 'imported') console.log(`imported ${result.title} from ${result.file} in ${time}`);
  else if (result.outcome === 'skipped') console.log(`skipped ${result.file}: already imported`);
  else {
    failed = true;
    console.error(`failed ${result.file}: ${result.outcome.error}`);
  }
}
process.exitCode = failed ? 1 : 0;
