// Dictionary lookups with Yomitan's importer and translator, unmodified, over
// a SQLite store. Importing is a separate, explicit step (`npm run
// import-dicts` for zips, `npm run import-yomitan` for an exported
// collection) because it takes seconds per dictionary; opening only reads.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { orderByPriority } from '../../../core/dictionary-order.ts';
import type { DictionaryInfo, Glossary, LookupResponse, TermEntry } from '../../../shared/api.ts';
import { SqliteDictionaryDatabase } from './database.ts';
import { registerYomitanLibs, yomitanDir } from './yomitan-libs.ts';

export { importYomitanBackup } from './backup.ts';
export type {
  BackupDictionaryResult,
  BackupImportResult,
  BackupProgress,
  YomitanBackupOptions,
} from './backup.ts';

export interface Dictionary {
  /** Imported dictionaries in priority order: the first is the main dictionary. */
  dictionaries(): DictionaryInfo[];
  /** Longest-match lookup with deinflection, from the start of `text`. */
  lookup(text: string): Promise<LookupResponse>;
  /** A file bundled with a dictionary (images its definitions show), or null when there is none. */
  media(dictionary: string, path: string): { mediaType: string; content: Uint8Array } | null;
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

export interface DictionaryOptions {
  /** Dictionary titles to show and consult first, in this order. */
  dictionaryOrder?: readonly string[];
}

/** Opens the database at `databasePath`, creating an empty one if needed. */
export async function openDictionary(databasePath: string, options: DictionaryOptions = {}): Promise<Dictionary> {
  const yomitan = await loadYomitan();
  const db = new SqliteDictionaryDatabase(databasePath);
  const priority = options.dictionaryOrder ?? [];
  const infos = orderByPriority(
    await db.getDictionaryInfo(),
    (info) => String(info.title),
    priority,
  );
  const translator = new yomitan.Translator(db);
  translator.prepare();
  const findOptions = findTermsOptions(infos.map((info) => String(info.title)));
  const dictionaries = infos.map((info) => ({
    title: String(info.title),
    styles: typeof info.styles === 'string' ? info.styles : '',
  }));

  return {
    dictionaries: () => dictionaries,
    async lookup(text) {
      const { dictionaryEntries, originalTextLength } = await translator.findTerms('group', text, findOptions);
      return {
        matchLength: originalTextLength,
        entries: dictionaryEntries.map((entry) => toTermEntry(entry, priority)),
      };
    },
    media: (dictionary, path) => db.getMedia(dictionary, path),
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
  inflectionRuleChainCandidates?: { inflectionRules: { name: string; description?: string }[] }[];
  frequencies?: {
    dictionary: string;
    dictionaryAlias?: string;
    frequency: number;
    displayValue: string | null;
    headwordIndex?: number;
  }[];
  pronunciations?: {
    dictionary: string;
    dictionaryAlias?: string;
    headwordIndex?: number;
    pronunciations: { type: string; positions?: unknown }[];
  }[];
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

function toTermEntry(entry: YomitanEntry, priority: readonly string[]): TermEntry {
  const frequencies = orderByPriority(frequencyEntries(entry), (frequency) => frequency.dictionary, priority);
  const pitchAccents = orderByPriority(pitchAccentEntries(entry), (accent) => accent.dictionary, priority);
  const definitions = orderByPriority(definitionGroups(entry), (group) => group.dictionary, priority);

  return {
    headwords: entry.headwords.map(({ term, reading }) => ({ term, reading })),
    inflections:
      entry.inflectionRuleChainCandidates?.[0]?.inflectionRules.map((rule) =>
        rule.description ? { name: rule.name, description: rule.description } : { name: rule.name },
      ) ?? [],
    frequencies,
    pitches: pitchAccents.flatMap((accent) => accent.positions),
    pitchAccents,
    definitions,
  };
}

function definitionGroups(entry: YomitanEntry): TermEntry['definitions'] {
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
  return definitions;
}

/**
 * One frequency per dictionary and reading, in Yomitan's order. The value is
 * the display string Yomitan shows, falling back to the plain number.
 */
function frequencyEntries(entry: YomitanEntry): TermEntry['frequencies'] {
  const seen = new Set<string>();
  const frequencies: TermEntry['frequencies'] = [];
  for (const frequency of entry.frequencies ?? []) {
    const dictionary = frequency.dictionaryAlias ?? frequency.dictionary;
    const reading = entry.headwords[frequency.headwordIndex ?? -1]?.reading ?? '';
    const key = `${dictionary}\0${reading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frequencies.push({ dictionary, value: frequency.displayValue ?? String(frequency.frequency) });
  }
  return frequencies;
}

/** Pitch positions per dictionary and reading, deduplicated and in Yomitan's order. */
function pitchAccentEntries(entry: YomitanEntry): TermEntry['pitchAccents'] {
  const accents = new Map<string, TermEntry['pitchAccents'][number]>();
  for (const group of entry.pronunciations ?? []) {
    const headword = entry.headwords[group.headwordIndex ?? -1];
    if (headword === undefined) continue;
    const dictionary = group.dictionaryAlias ?? group.dictionary;
    for (const pronunciation of group.pronunciations) {
      if (pronunciation.type !== 'pitch-accent' || typeof pronunciation.positions !== 'number') continue;
      const key = `${dictionary}\0${headword.reading}`;
      let accent = accents.get(key);
      if (accent === undefined) {
        accent = { dictionary, reading: headword.reading, positions: [] };
        accents.set(key, accent);
      }
      if (!accent.positions.includes(pronunciation.positions)) accent.positions.push(pronunciation.positions);
    }
  }
  return [...accents.values()];
}

/** Text and structured content are kept; images and deinflection glossaries are dropped. */
function toGlossary(item: unknown): Glossary | null {
  if (typeof item === 'string') return { type: 'text', text: item };
  if (typeof item !== 'object' || item === null || !('type' in item)) return null;
  if (item.type === 'text' && 'text' in item && typeof item.text === 'string') return { type: 'text', text: item.text };
  if (item.type === 'structured-content' && 'content' in item) return { type: 'structured-content', content: item.content };
  return null;
}
