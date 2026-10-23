// Imports a Yomitan "Export Dictionary Collection" backup into the dictionary
// database. Usage:
//   npm run import-yomitan -- <backup.json> [--exclude "A,B"] [--only "A,B"]
import { resolve } from 'node:path';
import { importYomitanBackup } from '../src/server/adapters/dictionary/index.ts';
import { paths } from '../src/server/paths.ts';

const args = process.argv.slice(2);
let backup: string | null = null;
let include: string[] | undefined;
let exclude: string[] | undefined;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] as string;
  if (arg === '--exclude' || arg === '--only') {
    const value = args[index + 1];
    if (value === undefined) {
      console.error(`${arg} needs a comma-separated list of dictionary titles`);
      process.exit(1);
    }
    index += 1;
    const titles = value
      .split(',')
      .map((title) => title.trim())
      .filter((title) => title !== '');
    if (arg === '--exclude') exclude = titles;
    else include = titles;
  } else if (backup === null && !arg.startsWith('--')) {
    backup = resolve(arg);
  } else {
    console.error(`unexpected argument: ${arg}`);
    process.exit(1);
  }
}

if (backup === null) {
  console.error('usage: npm run import-yomitan -- <backup.json> [--exclude "A,B"] [--only "A,B"]');
  process.exit(1);
}

try {
  const result = await importYomitanBackup(paths.dictionaryDatabase, backup, {
    include,
    exclude,
    onProgress: ({ table, rows }) => console.log(`${table}: ${rows.toLocaleString()} rows`),
  });
  for (const dictionary of result.dictionaries) {
    if (dictionary.outcome === 'imported') {
      console.log(`imported ${dictionary.title}: ${dictionary.rows.toLocaleString()} rows`);
    } else {
      console.log(`skipped ${dictionary.title}: ${dictionary.reason}`);
    }
  }
  console.log(`done in ${result.seconds.toFixed(1)}s`);
} catch (error) {
  console.error(`import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
