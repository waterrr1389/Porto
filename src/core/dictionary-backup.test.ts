import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviveBackupRow, selectTitles } from './dictionary-backup.ts';

test('revives an inbound row and drops types and the inline key', () => {
  const raw = {
    expression: '食べる',
    reading: 'たべる',
    glossary: ['to eat', { tag: 'span', content: 'eat' }],
    dictionary: 'Fixture',
    id: 42,
    $types: {
      glossary: 'arrayNonindexKeys',
      'glossary.1.content': 'arrayNonindexKeys',
    },
  };
  assert.deepEqual(reviveBackupRow(raw), {
    expression: '食べる',
    reading: 'たべる',
    glossary: ['to eat', { tag: 'span', content: 'eat' }],
    dictionary: 'Fixture',
  });
});

test('revives an out-of-line row wrapped in $', () => {
  const raw = {
    $: [7, { title: 'Fixture', version: 3, counts: { terms: { total: 2 } } }],
    $types: { $: { '': 'arrayNonindexKeys' } },
  };
  assert.deepEqual(reviveBackupRow(raw), {
    title: 'Fixture',
    version: 3,
    counts: { terms: { total: 2 } },
  });
});

test('decodes binary media content to bytes', () => {
  const raw = {
    dictionary: 'Fixture',
    path: 'gaiji/a.svg',
    mediaType: 'image/svg+xml',
    content: 'aGVsbG8=',
    $types: { content: 'arraybuffer' },
  };
  const row = reviveBackupRow(raw);
  assert.ok(row);
  const content = row.content;
  assert.ok(content instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(content), 'hello');
});

test('restores arrays encoded as index-keyed objects and dates', () => {
  const raw = {
    glossary: { 0: 'a', 1: 'b' },
    importDate: 1_700_000_000_000,
    $types: { glossary: 'arrayNonindexKeys', importDate: 'date' },
  };
  const row = reviveBackupRow(raw);
  assert.ok(row);
  assert.deepEqual(row.glossary, ['a', 'b']);
  assert.ok(row.importDate instanceof Date);
  assert.equal((row.importDate as Date).getTime(), 1_700_000_000_000);
});

test('rejects values that are not rows', () => {
  for (const raw of [null, 1, 'x', [], { $: [1] }, { $: [1, 'value'] }]) {
    assert.equal(reviveBackupRow(raw), null, JSON.stringify(raw));
  }
});

test('selects titles by include and exclude lists', () => {
  const titles = ['Main', 'CED24', ' COBUILD10 ', 'Jiten'];
  assert.deepEqual(selectTitles(titles), { selected: titles, excluded: [] });
  assert.deepEqual(selectTitles(titles, { include: ['Main', 'Jiten'] }), {
    selected: ['Main', 'Jiten'],
    excluded: ['CED24', ' COBUILD10 '],
  });
  assert.deepEqual(selectTitles(titles, { exclude: ['CED24', ' Jiten '] }), {
    selected: ['Main', ' COBUILD10 '],
    excluded: ['CED24', 'Jiten'],
  });
  assert.deepEqual(selectTitles(titles, { include: ['Main', 'CED24'], exclude: ['CED24'] }), {
    selected: ['Main'],
    excluded: ['CED24', ' COBUILD10 ', 'Jiten'],
  });
  assert.deepEqual(selectTitles(titles, { include: [] }), { selected: [], excluded: titles });
  assert.deepEqual(selectTitles(titles, { exclude: ['', '  '] }), { selected: titles, excluded: [] });
});
