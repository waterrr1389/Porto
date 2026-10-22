// Feasibility check: run Yomitan's importer and translator under Node.
// Usage: node spike/lookup.mjs <yomitan-checkout> <dictionary.zip> <text>...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [yomitanDir, zipPath, ...queries] = process.argv.slice(2);
const mod = (p) => import(pathToFileURL(join(yomitanDir, p)).href);

const { chrome, fetch } = await mod('test/mocks/common.js');
Object.assign(globalThis, { chrome, fetch, self: globalThis });

const { SqliteDictionaryDatabase } = await import('../server/dictionary-db.mjs');
const { DictionaryImporter } = await mod('ext/js/dictionary/dictionary-importer.js');
const { Translator } = await mod('ext/js/language/translator.js');
const { DictionaryImporterMediaLoader } = await mod('test/mocks/dictionary-importer-media-loader.js');
const { createFindTermsOptions } = await mod('test/utilities/translator.js');

const db = new SqliteDictionaryDatabase(zipPath.replace(/\.zip$/, '.sqlite'));
let t0 = performance.now();
let [summary] = await db.getDictionaryInfo();
if (!summary) {
  const { errors, result } = await new DictionaryImporter(new DictionaryImporterMediaLoader())
    .importDictionary(db, readFileSync(zipPath).buffer, {
      prefixWildcardsSupported: false,
      yomitanVersion: '0.0.0.0',
    });
  if (errors.length) console.log('import errors:', errors.slice(0, 3));
  summary = result;
  console.log(`imported "${summary.title}" in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
const title = summary.title;

const translator = new Translator(db);
translator.prepare();
const options = createFindTermsOptions(title, {
  d: {
    type: 'terms', matchType: 'exact', deinflect: true, mainDictionary: title,
    sortFrequencyDictionary: null, sortFrequencyDictionaryOrder: 'descending',
    removeNonJapaneseCharacters: true, language: 'ja', textReplacements: [null],
    enabledDictionaryMap: [[title, {
      index: 0, alias: title, allowSecondarySearches: false,
      partsOfSpeechFilter: true, useDeinflections: true,
    }]],
  },
}, 'd');

const glossText = (g) => (typeof g === 'string' ? g : JSON.stringify(g)).replace(/\s+/g, ' ');
for (const text of queries) {
  t0 = performance.now();
  const { dictionaryEntries, originalTextLength } = await translator.findTerms('group', text, options);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`\n=== ${text} → matched ${originalTextLength} chars, ${dictionaryEntries.length} entries, ${ms}ms`);
  for (const e of dictionaryEntries.slice(0, 3)) {
    const h = e.headwords[0];
    const chain = e.inflectionRuleChainCandidates?.[0]?.inflectionRules?.map((r) => r.name).join(' « ') ?? '';
    console.log(`- ${h.term}【${h.reading}】 source="${h.sources[0]?.originalText}" ${chain ? `[${chain}]` : ''}`);
    console.log(`    ${glossText(e.definitions[0]?.entries?.[0] ?? '').slice(0, 160)}`);
  }
}
