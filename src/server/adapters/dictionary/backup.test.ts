import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importYomitanBackup, openDictionary } from './index.ts';

const work = await mkdtemp(join(tmpdir(), 'sla-backup-'));
after(() => rm(work, { recursive: true, force: true }));

const MAIN = 'Fixture Backup';
const OTHER = 'Excluded Dict';

function dictionaryRow(title: string): Record<string, unknown> {
  return {
    title,
    revision: `${title} 1`,
    sequenced: false,
    version: 3,
    importDate: 1_700_000_000_000,
    prefixWildcardsSupported: false,
    counts: {
      terms: { total: 1 },
      termMeta: { total: 1 },
      kanji: { total: 0 },
      kanjiMeta: { total: 0 },
      tagMeta: { total: 0 },
      media: { total: 0 },
    },
    styles: '',
    importSuccess: true,
    frequencyMode: 'rank-based',
  };
}

function outbound(key: number, value: Record<string, unknown>): Record<string, unknown> {
  return { $: [key, value], $types: { $: { '': 'arrayNonindexKeys' } } };
}

/** A small export with the same table order and encodings as the real one. */
function fixture(): string {
  const tables: [string, unknown[], boolean][] = [
    ['dictionaries', [outbound(1, dictionaryRow(MAIN)), outbound(2, dictionaryRow(OTHER))], false],
    ['kanji', [], true],
    ['kanjiMeta', [], false],
    [
      'media',
      [
        {
          dictionary: MAIN,
          path: 'gaiji/a.svg',
          mediaType: 'image/svg+xml',
          width: 10,
          height: 10,
          content: Buffer.from('<svg/>').toString('base64'),
          $types: { content: 'arraybuffer' },
        },
      ],
      true,
    ],
    ['tagMeta', [], true],
    [
      'termMeta',
      [
        outbound(1, {
          expression: '食べる',
          mode: 'freq',
          data: { value: 123, displayValue: '123' },
          dictionary: MAIN,
        }),
        outbound(2, {
          expression: '食べる',
          mode: 'pitch',
          data: { reading: 'たべる', pitches: [{ position: 1 }] },
          dictionary: MAIN,
        }),
        outbound(3, {
          expression: '飲む',
          mode: 'freq',
          data: { value: 9, displayValue: '9' },
          dictionary: OTHER,
        }),
      ],
      false,
    ],
    [
      'terms',
      [
        {
          expression: '食べる',
          reading: 'たべる',
          definitionTags: '',
          rules: '',
          score: 10,
          glossary: ['to eat', { type: 'structured-content', content: { tag: 'span', content: 'eat' } }],
          sequence: 1,
          termTags: '',
          dictionary: MAIN,
          id: 1,
          $types: { glossary: 'arrayNonindexKeys', 'glossary.1.content': 'arrayNonindexKeys' },
        },
        {
          expression: '飲む',
          reading: 'のむ',
          definitionTags: '',
          rules: '',
          score: 0,
          glossary: ['to drink'],
          sequence: 2,
          termTags: '',
          dictionary: OTHER,
          id: 2,
          $types: { glossary: 'arrayNonindexKeys' },
        },
      ],
      true,
    ],
  ];

  return JSON.stringify({
    formatName: 'dexie',
    formatVersion: 1,
    data: {
      databaseName: 'dict',
      databaseVersion: 6,
      tables: tables.map(([name, rows]) => ({ name, schema: '++id', rowCount: rows.length })),
      data: tables.map(([tableName, rows, inbound]) => ({ tableName, inbound, rows })),
    },
  });
}

async function fixtureFile(name: string): Promise<string> {
  const path = join(work, name);
  await writeFile(path, fixture());
  return path;
}

function counts(path: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result: Record<string, number> = {};
    for (const table of ['dictionaries', 'terms', 'termMeta', 'media']) {
      const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      result[table] = row.n;
    }
    return result;
  } finally {
    db.close();
  }
}

test('imports a Dexie backup, preserving rows and types', async () => {
  const backup = await fixtureFile('backup.json');
  const database = join(work, 'full.sqlite');
  const result = await importYomitanBackup(database, backup);

  assert.deepEqual(
    result.dictionaries.map((dictionary) => [dictionary.title, dictionary.outcome, dictionary.reason]),
    [
      [MAIN, 'imported', undefined],
      [OTHER, 'imported', undefined],
    ],
  );
  assert.equal(counts(database).terms, 2);
  assert.equal(counts(database).termMeta, 3);
  assert.equal(counts(database).media, 1);

  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const media = db.prepare('SELECT json FROM media LIMIT 1').get() as { json: string };
    assert.equal((JSON.parse(media.json) as { content: string }).content, Buffer.from('<svg/>').toString('base64'));
  } finally {
    db.close();
  }

  const dictionary = await openDictionary(database);
  try {
    const lookup = await dictionary.lookup('食べる');
    const entry = lookup.entries.find((candidate) => candidate.definitions.some((group) => group.dictionary === MAIN));
    assert.ok(entry);
    assert.deepEqual(entry.headwords, [{ term: '食べる', reading: 'たべる' }]);
    assert.deepEqual(entry.frequencies, [{ dictionary: MAIN, value: '123' }]);
    assert.deepEqual(entry.pitches, [1]);
    const glossary = entry.definitions.flatMap((group) => group.glossary);
    assert.ok(glossary.some((item) => item.type === 'text' && item.text === 'to eat'));
    assert.ok(glossary.some((item) => item.type === 'structured-content'));
  } finally {
    dictionary.close();
  }
});

test('skips dictionaries whose title already exists', async () => {
  const backup = await fixtureFile('backup-skip.json');
  const database = join(work, 'skip.sqlite');
  await importYomitanBackup(database, backup);

  const second = await importYomitanBackup(database, backup);
  assert.deepEqual(
    second.dictionaries.map((dictionary) => [dictionary.title, dictionary.outcome, dictionary.reason, dictionary.rows]),
    [
      [MAIN, 'skipped', 'existing', 0],
      [OTHER, 'skipped', 'existing', 0],
    ],
  );
  assert.equal(counts(database).terms, 2, 'nothing was inserted twice');
});

test('imports only the titles outside the exclude list', async () => {
  const backup = await fixtureFile('backup-exclude.json');
  const database = join(work, 'exclude.sqlite');
  const result = await importYomitanBackup(database, backup, { exclude: [OTHER] });

  assert.deepEqual(
    result.dictionaries.map((dictionary) => [dictionary.title, dictionary.outcome, dictionary.reason]),
    [
      [MAIN, 'imported', undefined],
      [OTHER, 'skipped', 'filtered'],
    ],
  );
  assert.equal(counts(database).terms, 1);
  assert.equal(counts(database).termMeta, 2);

  const dictionary = await openDictionary(database);
  try {
    assert.equal((await dictionary.lookup('飲む')).entries.length, 0);
    assert.ok((await dictionary.lookup('食べる')).entries.length > 0);
  } finally {
    dictionary.close();
  }
});

test('parses the same backup when it is split into tiny chunks', async () => {
  const backup = await fixtureFile('backup-chunks.json');
  const whole = join(work, 'whole.sqlite');
  const chunked = join(work, 'chunked.sqlite');
  await importYomitanBackup(whole, backup);
  const result = await importYomitanBackup(chunked, backup, { chunkSize: 7 });

  assert.equal(result.seconds >= 0, true);
  assert.deepEqual(counts(chunked), counts(whole));
  assert.deepEqual(counts(chunked), { dictionaries: 2, terms: 2, termMeta: 3, media: 1 });

  const dictionary = await openDictionary(chunked);
  try {
    const entry = (await dictionary.lookup('食べる')).entries[0];
    assert.ok(entry);
    assert.deepEqual(entry.pitches, [1]);
  } finally {
    dictionary.close();
  }
});
