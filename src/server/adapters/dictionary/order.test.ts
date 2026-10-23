import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDictionary } from './index.ts';
import { SqliteDictionaryDatabase } from './database.ts';

const work = await mkdtemp(join(tmpdir(), 'sla-dict-order-'));
after(() => rm(work, { recursive: true, force: true }));

const ALPHA = 'Alpha Dictionary';
const BETA = 'Beta Dictionary';

type Row = Record<string, unknown>;

const dictionaryRow = (title: string): Row => ({
  title,
  revision: `${title} 1`,
  version: 3,
  styles: '',
  frequencyMode: 'rank-based',
});

const termRow = (dictionary: string, glossary: string): Row => ({
  expression: '食べる',
  reading: 'たべる',
  definitionTags: '',
  rules: '',
  score: 0,
  glossary: [glossary],
  sequence: 1,
  termTags: '',
  dictionary,
});

const metaRow = (dictionary: string, mode: string, data: unknown): Row => ({
  expression: '食べる',
  mode,
  data,
  dictionary,
});

async function createDatabase(path: string): Promise<void> {
  const db = new SqliteDictionaryDatabase(path);
  try {
    await db.bulkAdd('dictionaries', [dictionaryRow(ALPHA), dictionaryRow(BETA)], 0, 2);
    await db.bulkAdd('terms', [termRow(ALPHA, 'alpha definition'), termRow(BETA, 'beta definition')], 0, 2);
    await db.bulkAdd(
      'termMeta',
      [
        metaRow(ALPHA, 'freq', { value: 10, displayValue: 'ten' }),
        // A second frequency for the same dictionary and reading must not show twice.
        metaRow(ALPHA, 'freq', { value: 11, displayValue: 'eleven' }),
        metaRow(BETA, 'freq', { value: 20 }),
        metaRow(ALPHA, 'pitch', { reading: 'たべる', pitches: [{ position: 1 }, { position: 2 }, { position: 1 }] }),
        metaRow(BETA, 'pitch', { reading: 'たべる', pitches: [{ position: 0 }] }),
        // Not the headword's reading, so it must not attach.
        metaRow(ALPHA, 'pitch', { reading: 'よむ', pitches: [{ position: 3 }] }),
      ],
      0,
      6,
    );
  } finally {
    db.close();
  }
}

test('orders dictionaries, definitions, frequencies and pitch by the priority list', async () => {
  const database = join(work, 'ordered.sqlite');
  await createDatabase(database);

  const dictionary = await openDictionary(database, { dictionaryOrder: [BETA, 'Missing Dictionary'] });
  try {
    assert.deepEqual(
      dictionary.dictionaries().map((info) => info.title),
      [BETA, ALPHA],
    );

    const entry = (await dictionary.lookup('食べる')).entries[0];
    assert.ok(entry);
    assert.deepEqual(
      entry.definitions.map((group) => group.dictionary),
      [BETA, ALPHA],
    );
    assert.deepEqual(entry.frequencies, [
      { dictionary: BETA, value: '20' },
      { dictionary: ALPHA, value: 'ten' },
    ]);
    assert.deepEqual(entry.pitchAccents, [
      { dictionary: BETA, reading: 'たべる', positions: [0] },
      { dictionary: ALPHA, reading: 'たべる', positions: [1, 2] },
    ]);
    assert.deepEqual(entry.pitches, [0, 1, 2]);
  } finally {
    dictionary.close();
  }
});

test('falls back to import order without a priority list', async () => {
  const database = join(work, 'import-order.sqlite');
  await createDatabase(database);

  const dictionary = await openDictionary(database);
  try {
    assert.deepEqual(
      dictionary.dictionaries().map((info) => info.title),
      [ALPHA, BETA],
    );
    const entry = (await dictionary.lookup('食べる')).entries[0];
    assert.ok(entry);
    assert.deepEqual(
      entry.definitions.map((group) => group.dictionary),
      [ALPHA, BETA],
    );
    assert.deepEqual(entry.frequencies, [
      { dictionary: ALPHA, value: 'ten' },
      { dictionary: BETA, value: '20' },
    ]);
    assert.deepEqual(entry.pitchAccents, [
      { dictionary: ALPHA, reading: 'たべる', positions: [1, 2] },
      { dictionary: BETA, reading: 'たべる', positions: [0] },
    ]);
  } finally {
    dictionary.close();
  }
});
