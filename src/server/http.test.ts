import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, type DictionaryService } from './http.ts';
import type { LookupResponse } from '../shared/api.ts';

const dir = mkdtempSync(join(tmpdir(), 'sla-http-'));
const publicDir = join(dir, 'public');
const mediaDir = join(dir, 'media');
const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
let server: Server;
let base: string;
const lookups: string[] = [];

const dictionary: DictionaryService = {
  dictionaries: () => [{ title: 'Fixture', styles: '.x{}' }],
  async lookup(text): Promise<LookupResponse> {
    lookups.push(text);
    if (text === 'boom') throw new Error('broken');
    return { matchLength: 2, entries: [] };
  },
};

before(async () => {
  mkdirSync(publicDir);
  mkdirSync(join(mediaDir, 'show'), { recursive: true });
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, 'secret.txt'), 'secret');
  writeFileSync(join(mediaDir, 'show', 'ep 1.mp4'), video);
  server = createServer(createHandler({ dictionary, publicDir, mediaDir }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('serves index.html at the root', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(await res.text(), '<!doctype html>');
});

test('lists dictionaries', async () => {
  const res = await fetch(`${base}/api/dictionaries`);
  assert.deepEqual(await res.json(), [{ title: 'Fixture', styles: '.x{}' }]);
});

test('looks up text and validates its length', async () => {
  const ok = await fetch(`${base}/api/lookup?text=${encodeURIComponent('食べる')}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { matchLength: 2, entries: [] });
  assert.equal(lookups.at(-1), '食べる');
  assert.equal((await fetch(`${base}/api/lookup`)).status, 400);
  assert.equal((await fetch(`${base}/api/lookup?text=${'あ'.repeat(65)}`)).status, 400);
});

test('reports failures as 500 json', async () => {
  const res = await fetch(`${base}/api/lookup?text=boom`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal error' });
});

test('unknown api paths and methods', async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/lookup?text=a`, { method: 'POST' })).status, 405);
});

test('media is served whole and by range', async () => {
  const url = `${base}/media/show/${encodeURIComponent('ep 1.mp4')}`;
  const whole = await fetch(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), video);

  const probe = await fetch(url, { headers: { Range: 'bytes=0-1' } });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('content-range'), 'bytes 0-1/1000');
  assert.deepEqual(Buffer.from(await probe.arrayBuffer()), video.subarray(0, 2));

  const tail = await fetch(url, { headers: { Range: 'bytes=900-' } });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(900));

  const beyond = await fetch(url, { headers: { Range: 'bytes=1000-' } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), 'bytes */1000');
});

test('paths cannot escape their directory', async () => {
  assert.equal((await fetch(`${base}/media/..%2Fsecret.txt`)).status, 404);
  assert.equal((await fetch(`${base}/..%2F..%2Fsecret.txt`)).status, 404);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/media/show`)).status, 404);
});
