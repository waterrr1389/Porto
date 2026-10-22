// HTTP-level test of the dictionary adapter with a small generated dictionary.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { createHandler } from '../../http.ts';
import type { LookupResponse } from '../../../shared/api.ts';
import { importDictionaries, openDictionary, type Dictionary } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'sla-dict-'));
const databasePath = join(dir, 'db', 'dictionaries.sqlite');
const zipPath = join(dir, 'fixture.zip');
let dictionary: Dictionary;
let server: Server;
let base: string;

async function writeFixtureZip(): Promise<void> {
  const files: Record<string, unknown> = {
    'index.json': { title: 'Fixture', revision: '1', format: 3, sequenced: false },
    'term_bank_1.json': [
      ['食べる', 'たべる', '', 'v1', 0, ['to eat'], 1, ''],
      ['行く', 'いく', '', 'v5', 0, [{ type: 'structured-content', content: { tag: 'span', content: 'to go' } }], 2, ''],
    ],
  };
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  for (const [name, content] of Object.entries(files)) {
    await writer.add(name, new TextReader(JSON.stringify(content)));
  }
  await writer.add('styles.css', new TextReader('.word { color: red; }'));
  writeFileSync(zipPath, Buffer.from(await (await writer.close()).arrayBuffer()));
}

before(async () => {
  await writeFixtureZip();
  dictionary = await openDictionary(databasePath).then(async (empty) => {
    empty.close();
    const [first] = await importDictionaries(databasePath, [zipPath]);
    assert.equal(first?.outcome, 'imported');
    return openDictionary(databasePath);
  });
  const library = { series: async () => [], episode: async () => null };
  const progress = { progress: () => null, allProgress: () => new Map(), saveProgress: () => {} };
  const media = { prepare: async () => '', prewarm: () => {} };
  const cards = { mine: async () => ({ noteId: 0, duplicates: 0 }), duplicates: async () => ({}) };
  server = createServer(createHandler({ dictionary, library, progress, media, cards, publicDir: dir }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  dictionary.close();
  rmSync(dir, { recursive: true, force: true });
});

const lookup = async (text: string): Promise<LookupResponse> =>
  (await fetch(`${base}/api/lookup?text=${encodeURIComponent(text)}`)).json() as Promise<LookupResponse>;

test('lists imported dictionaries with their styles', async () => {
  const res = await fetch(`${base}/api/dictionaries`);
  assert.deepEqual(await res.json(), [{ title: 'Fixture', styles: '.word { color: red; }' }]);
});

test('deinflects and reports the matched length', async () => {
  const result = await lookup('食べさせられたよ');
  assert.equal(result.matchLength, 7);
  const [entry] = result.entries;
  assert.deepEqual(entry?.headwords, [{ term: '食べる', reading: 'たべる' }]);
  assert.ok((entry?.inflections.length ?? 0) > 0);
  assert.deepEqual(entry?.definitions, [{ dictionary: 'Fixture', glossary: [{ type: 'text', text: 'to eat' }] }]);
});

test('keeps structured content for the client to render', async () => {
  const result = await lookup('行かなきゃ');
  assert.deepEqual(result.entries[0]?.definitions[0]?.glossary, [
    { type: 'structured-content', content: { tag: 'span', content: 'to go' } },
  ]);
});

test('returns no entries for unknown text', async () => {
  assert.deepEqual(await lookup('ぬ'), { matchLength: 0, entries: [] });
});

test('importing the same dictionary again is skipped', async () => {
  const [result] = await importDictionaries(databasePath, [zipPath]);
  assert.equal(result?.outcome, 'skipped');
});
