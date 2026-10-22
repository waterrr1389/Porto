// Dictionary lookup service: Yomitan's importer and translator over SQLite.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteDictionaryDatabase } from './dictionary-db.mjs';

const glossaryImageStub = {
  // Image media is not imported yet; structured-content images stay blank.
  async getImageDetails(content) { return { content, width: 100, height: 100 }; },
};

export async function createLookup({ yomitanDir, dictsDir }) {
  const mod = (p) => import(pathToFileURL(join(yomitanDir, p)).href);
  // Yomitan modules probe these extension globals at runtime.
  globalThis.self ??= globalThis;
  globalThis.chrome ??= { runtime: { getURL: (p) => pathToFileURL(join(yomitanDir, 'ext', p)).href } };

  const { DictionaryImporter } = await mod('ext/js/dictionary/dictionary-importer.js');
  const { Translator } = await mod('ext/js/language/translator.js');

  const db = new SqliteDictionaryDatabase(join(dictsDir, 'dictionaries.sqlite'));
  const zips = readdirSync(dictsDir).filter((n) => n.endsWith('.zip')).sort();
  for (const name of zips) {
    const data = readFileSync(join(dictsDir, name));
    const t0 = performance.now();
    const { errors, result } = await new DictionaryImporter(glossaryImageStub)
      .importDictionary(db, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), {
        prefixWildcardsSupported: false,
        yomitanVersion: '0.0.0.0',
      })
      .catch((e) => ({ errors: [e], result: null }));
    // Already-imported dictionaries are rejected by the importer; that is the
    // expected path on every start after the first.
    if (result) console.log(`imported ${result.title} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    else if (!/already imported/i.test(String(errors[0]?.message))) console.warn(`import ${name} failed:`, errors[0]);
  }

  const dictionaries = await db.getDictionaryInfo();
  const translator = new Translator(db);
  translator.prepare();

  const enabledDictionaryMap = new Map(dictionaries.map((d, index) => [d.title, {
    index,
    alias: d.title,
    allowSecondarySearches: false,
    partsOfSpeechFilter: true,
    useDeinflections: true,
  }]));
  const options = {
    matchType: 'exact',
    deinflect: true,
    mainDictionary: dictionaries[0]?.title ?? '',
    sortFrequencyDictionary: null,
    sortFrequencyDictionaryOrder: 'descending',
    removeNonJapaneseCharacters: true,
    primaryReading: '',
    textReplacements: [null],
    enabledDictionaryMap,
    excludeDictionaryDefinitions: null,
    searchResolution: 'letter',
    language: 'ja',
    useAllFrequencyDictionaries: false,
  };

  return {
    dictionaries: dictionaries.map(({ title, styles }) => ({ title, styles: styles ?? '' })),
    async lookup(text) {
      const { dictionaryEntries, originalTextLength } = await translator.findTerms('group', text, options);
      return { originalTextLength, entries: dictionaryEntries };
    },
  };
}
