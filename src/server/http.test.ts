// HTTP-level tests of routing, the library adapter and the store, with a stub
// dictionary and a media service that serves sources as they are.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibrary } from './adapters/library.ts';
import { openStore } from './adapters/store.ts';
import { createHandler, type DictionaryService } from './http.ts';
import type { EpisodeResponse, LibraryResponse, LookupResponse } from '../shared/api.ts';

const dir = mkdtempSync(join(tmpdir(), 'sla-http-'));
const publicDir = join(dir, 'public');
const root = join(dir, 'Anime');
const stateDir = join(dir, 'state');
const show = join(root, '[Group] Show [1080p]');
const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const prewarmed: string[] = [];
let server: Server;
let base: string;

const dictionary: DictionaryService = {
  dictionaries: () => [{ title: 'Fixture', styles: '.x{}' }],
  async lookup(text): Promise<LookupResponse> {
    if (text === 'boom') throw new Error('broken');
    return { matchLength: 2, entries: [] };
  },
};

before(async () => {
  mkdirSync(publicDir);
  mkdirSync(show, { recursive: true });
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, 'secret.txt'), 'secret');
  writeFileSync(join(show, '[Group] Show - 01 [1080p].mp4'), video);
  writeFileSync(join(show, '[Group] Show - 01 [1080p].ja.ass'), '[Events]\n');
  writeFileSync(join(show, '[Group] Show - 01 [1080p].tc.ass'), 'tc');
  writeFileSync(join(show, '[Group] Show - 02 [1080p].mp4'), video);
  const store = openStore(stateDir);
  const media = {
    prepare: async (_key: string, source: string) => source,
    prewarm: (key: string) => void prewarmed.push(key),
  };
  const library = createLibrary([root]);
  server = createServer(createHandler({ dictionary, library, progress: store, media, publicDir }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, path);
  return (await res.json()) as T;
};

test('serves index.html at the root', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(await res.text(), '<!doctype html>');
});

test('lists dictionaries', async () => {
  assert.deepEqual(await getJson('/api/dictionaries'), [{ title: 'Fixture', styles: '.x{}' }]);
});

test('looks up text and validates its length', async () => {
  assert.deepEqual(await getJson(`/api/lookup?text=${encodeURIComponent('食べる')}`), { matchLength: 2, entries: [] });
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
  assert.equal((await fetch(`${base}/api/episodes/00ff`)).status, 404);
});

test('lists the library with subtitle languages', async () => {
  const library = await getJson<LibraryResponse>('/api/library');
  assert.equal(library.resume, null);
  assert.equal(library.series.length, 1);
  const [series] = library.series;
  assert.equal(series?.title, 'Show');
  assert.deepEqual(
    series?.episodes.map((e) => [e.title, e.languages.sort(), e.position]),
    [
      ['01', ['ja', 'zh-Hant'], 0],
      ['02', [], 0],
    ],
  );
});

test('describes an episode, prewarming it and the next one', async () => {
  const library = await getJson<LibraryResponse>('/api/library');
  const [first, second] = library.series[0]?.episodes ?? [];
  assert.ok(first && second);
  prewarmed.length = 0;
  const episode = await getJson<EpisodeResponse>(`/api/episodes/${first.id}`);
  assert.deepEqual(episode, {
    id: first.id,
    title: '01',
    seriesTitle: 'Show',
    video: `/api/episodes/${first.id}/video`,
    subtitles: { ja: `/api/episodes/${first.id}/subtitles/ja`, zh: `/api/episodes/${first.id}/subtitles/zh-Hant` },
    position: 0,
    nextEpisodeId: second.id,
  });
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(prewarmed.sort(), [first.id, second.id].sort());

  const subtitles = await fetch(`${base}${episode.subtitles.zh}`);
  assert.equal(await subtitles.text(), 'tc');
  assert.equal((await fetch(`${base}/api/episodes/${first.id}/subtitles/en`)).status, 404);
});

test('episode video is served whole and by range', async () => {
  const library = await getJson<LibraryResponse>('/api/library');
  const url = `${base}/api/episodes/${library.series[0]?.episodes[0]?.id}/video`;
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
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(900));

  const beyond = await fetch(url, { headers: { Range: 'bytes=1000-' } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), 'bytes */1000');
});

test('progress is saved durably and offered for resume', async () => {
  const library = await getJson<LibraryResponse>('/api/library');
  const id = library.series[0]?.episodes[0]?.id ?? '';
  const put = (body: string) =>
    fetch(`${base}/api/episodes/${id}/progress`, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await put('{"position":-1,"duration":10}')).status, 400);
  assert.equal((await put('nope')).status, 400);
  assert.equal((await put('{"position":120.5,"duration":1400}')).status, 204);
  assert.equal((await fetch(`${base}/api/episodes/00ff/progress`, { method: 'PUT', body: '{"position":1,"duration":2}' })).status, 404);

  const after = await getJson<LibraryResponse>('/api/library');
  assert.equal(after.series[0]?.episodes[0]?.position, 120.5);
  assert.deepEqual(after.resume, { episodeId: id, seriesTitle: 'Show', episodeTitle: '01', position: 120.5 });
  assert.equal((await getJson<EpisodeResponse>(`/api/episodes/${id}`)).position, 120.5);

  const saved = JSON.parse(readFileSync(join(stateDir, 'progress.json'), 'utf8')) as Record<string, { position: number }>;
  assert.equal(saved[id]?.position, 120.5);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')).cacheLimitGB, 50);
});

test('paths cannot escape their directory', async () => {
  assert.equal((await fetch(`${base}/..%2F..%2Fsecret.txt`)).status, 404);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
});
