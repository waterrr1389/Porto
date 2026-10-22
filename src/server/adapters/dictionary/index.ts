// Dictionary lookups with Yomitan's importer and translator, unmodified, over
// a SQLite store. Importing is a separate, explicit step (`npm run
// import-dicts`) because it takes seconds per dictionary; opening only reads.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { DictionaryInfo, Glossary, LookupResponse, TermEntry } from '../../../shared/api.ts';
import { SqliteDictionaryDatabase } from './database.ts';
import { registerYomitanLibs, yomitanDir } from './yomitan-libs.ts';

export interface Dictionary {
  /** Imported dictionaries in priority order: the first is the main dictionary. */
  dictionaries(): DictionaryInfo[];
  /** Longest-match lookup with deinflection, from the start of `text`. */
  lookup(text: string): Promise<LookupResponse>;
  close(): void;
}

export interface ImportResult {
  file: string;
  /** Title from the dictionary's index, or null when the import failed. */
  title: string | null;
  /** 'imported', 'skipped' when a dictionary with that title exists, or the error. */
  outcome: 'imported' | 'skipped' | { error: string };
  seconds: number;
}

/** Opens the database at `databasePath`, creating an empty one if needed. */
export async function openDictionary(databasePath: string): Promise<Dictionary> {
  const yomitan = await loadYomitan();
  const db = new SqliteDictionaryDatabase(databasePath);
  const infos = await db.getDictionaryInfo();
  const translator = new yomitan.Translator(db);
  translator.prepare();
  const options = findTermsOptions(infos.map((info) => String(info.title)));
  const dictionaries = infos.map((info) => ({
    title: String(info.title),
    styles: typeof info.styles === 'string' ? info.styles : '',
  }));

  return {
    dictionaries: () => dictionaries,
    async lookup(text) {
      const { dictionaryEntries, originalTextLength } = await translator.findTerms('group', text, options);
      return { matchLength: originalTextLength, entries: dictionaryEntries.map(toTermEntry) };
    },
    close: () => db.close(),
  };
}

/**
 * Imports Yomitan dictionary zips into the database at `databasePath`, in the
 * given order, which becomes their priority order.
 */
export async function importDictionaries(databasePath: string, files: string[]): Promise<ImportResult[]> {
  const yomitan = await loadYomitan();
  const db = new SqliteDictionaryDatabase(databasePath);
  const results: ImportResult[] = [];
  try {
    for (const file of files) {
      const started = performance.now();
      const data = await readFile(file);
      const archive = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const { result, errors } = await new yomitan.DictionaryImporter(imageStub)
        .importDictionary(db, archive, { prefixWildcardsSupported: false, yomitanVersion: '0.0.0.0' })
        .catch((error: unknown) => ({ result: null, errors: [error] }));
      const seconds = (performance.now() - started) / 1000;
      const message = errors[0] instanceof Error ? errors[0].message : String(errors[0] ?? '');
      if (result) {
        results.push({ file, title: result.title, outcome: 'imported', seconds });
      } else if (/already imported/i.test(message)) {
        results.push({ file, title: null, outcome: 'skipped', seconds });
      } else {
        results.push({ file, title: null, outcome: { error: message || 'unknown error' }, seconds });
      }
    }
  } finally {
    db.close();
  }
  return results;
}

// Minimal declarations for the parts of Yomitan used here; tsc never checks vendor/.

interface YomitanEntry {
  headwords: { term: string; reading: string }[];
  inflectionRuleChainCandidates?: { inflectionRules: { name: string }[] }[];
  frequencies?: { dictionary: string; dictionaryAlias?: string; frequency: number; displayValue: string | null }[];
  pronunciations?: { pronunciations: { type: string; positions?: unknown }[] }[];
  definitions: { dictionary: string; entries: unknown[] }[];
}

interface Yomitan {
  Translator: new (db: SqliteDictionaryDatabase) => {
    prepare(): void;
    findTerms(
      mode: 'group',
      text: string,
      options: object,
    ): Promise<{ dictionaryEntries: YomitanEntry[]; originalTextLength: number }>;
  };
  DictionaryImporter: new (mediaLoader: object) => {
    importDictionary(
      db: SqliteDictionaryDatabase,
      archive: ArrayBuffer,
      details: object,
    ): Promise<{ result: { title: string } | null; errors: unknown[] }>;
  };
}

let yomitanModules: Promise<Yomitan> | undefined;

function loadYomitan(): Promise<Yomitan> {
  yomitanModules ??= (async () => {
    registerYomitanLibs();
    // Yomitan's modules probe these extension globals at load time.
    const scope = globalThis as Record<string, unknown>;
    scope.self ??= globalThis;
    scope.chrome ??= { runtime: { getURL: (path: string) => pathToFileURL(join(yomitanDir, 'ext', path)).href } };
    const load = (path: string) => import(pathToFileURL(join(yomitanDir, path)).href);
    const [translator, importer] = await Promise.all([
      load('ext/js/language/translator.js'),
      load('ext/js/dictionary/dictionary-importer.js'),
    ]);
    return { Translator: translator.Translator, DictionaryImporter: importer.DictionaryImporter };
  })();
  return yomitanModules;
}

/** Dictionary images are not imported; structured-content images render blank. */
const imageStub = {
  async getImageDetails(content: ArrayBuffer) {
    return { content, width: 100, height: 100 };
  },
};

function findTermsOptions(titles: string[]): object {
  return {
    matchType: 'exact',
    deinflect: true,
    mainDictionary: titles[0] ?? '',
    sortFrequencyDictionary: null,
    sortFrequencyDictionaryOrder: 'descending',
    removeNonJapaneseCharacters: true,
    primaryReading: '',
    textReplacements: [null],
    enabledDictionaryMap: new Map(
      titles.map((title, index) => [
        title,
        { index, alias: title, allowSecondarySearches: false, partsOfSpeechFilter: true, useDeinflections: true },
      ]),
    ),
    excludeDictionaryDefinitions: null,
    searchResolution: 'letter',
    language: 'ja',
    useAllFrequencyDictionaries: false,
  };
}

function toTermEntry(entry: YomitanEntry): TermEntry {
  const definitions: TermEntry['definitions'] = [];
  for (const definition of entry.definitions) {
    let group = definitions.find((d) => d.dictionary === definition.dictionary);
    if (!group) {
      group = { dictionary: definition.dictionary, glossary: [] };
      definitions.push(group);
    }
    for (const item of definition.entries) {
      const glossary = toGlossary(item);
      if (glossary) group.glossary.push(glossary);
    }
  }
  const pitches: number[] = [];
  for (const group of entry.pronunciations ?? []) {
    for (const p of group.pronunciations) {
      if (p.type === 'pitch-accent' && typeof p.positions === 'number') pitches.push(p.positions);
    }
  }
  return {
    headwords: entry.headwords.map(({ term, reading }) => ({ term, reading })),
    inflections: entry.inflectionRuleChainCandidates?.[0]?.inflectionRules.map((rule) => rule.name) ?? [],
    frequencies: (entry.frequencies ?? []).map((f) => ({
      dictionary: f.dictionaryAlias ?? f.dictionary,
      value: f.displayValue ?? String(f.frequency),
    })),
    pitches,
    definitions,
  };
}

/** Text and structured content are kept; images and deinflection glossaries are dropped. */
function toGlossary(item: unknown): Glossary | null {
  if (typeof item === 'string') return { type: 'text', text: item };
  if (typeof item !== 'object' || item === null || !('type' in item)) return null;
  if (item.type === 'text' && 'text' in item && typeof item.text === 'string') return { type: 'text', text: item.text };
  if (item.type === 'structured-content' && 'content' in item) return { type: 'structured-content', content: item.content };
  return null;
}
