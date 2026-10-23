// HTTP-level tests of routing, the library adapter and the store, with a stub
// dictionary and a media service that serves sources as they are.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnki } from './adapters/anki.ts';
import { createLibrary } from './adapters/library.ts';
import { createMediaCache } from './adapters/media/index.ts';
import { openStore } from './adapters/store.ts';
import { createHandler, type DictionaryService } from './http.ts';
import { createMiner } from './mining.ts';
import type {
  CardRequest,
  CardResponse,
  DuplicatesResponse,
  EpisodeResponse,
  LibraryResponse,
  LookupResponse,
} from '../shared/api.ts';

const dir = mkdtempSync(join(tmpdir(), 'sla-http-'));
const publicDir = join(dir, 'public');
const root = join(dir, 'Anime');
const stateDir = join(dir, 'state');
const show = join(root, '[Group] Show [1080p]');
const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const prewarmed: string[] = [];
let server: Server;
let base: string;

const cardRoot = join(dir, 'Cards');
const cardCache = join(dir, 'card-cache');
const cardStateDir = join(dir, 'card-state');
const cardWorkDir = join(cardCache, 'cards');
let cardBase = '';
let cardEpisodeId = '';
let cardServer: Server;
let ankiServer: Server;
let cardLibrary: ReturnType<typeof createLibrary>;
let cardStore: ReturnType<typeof openStore>;
let existingNotes: number[] = [];
/** When set, answers findNotes per request instead of using `existingNotes`. */
let findNotesFor: ((query: string) => number[]) | null = null;
/** When set, answers each `multi` action's findNotes query. */
let multiFor: ((queries: string[]) => number[][]) | null = null;
const ankiRequests: AnkiRequest[] = [];
const storedMedia: { fileName: string; path: string; existed: boolean }[] = [];

interface AnkiRequest {
  action: string;
  version: number;
  key?: string;
  params: Record<string, unknown>;
}

/** Everything in a card request except the episode id, which the fixture decides. */
const CARD: Omit<CardRequest, 'episodeId'> = {
  term: '自腹',
  reading: 'じばら',
  definitions: [{ dictionary: 'Fixture', html: '<span>self-paid</span>' }],
  frequencies: [{ dictionary: 'JPDB', value: '27394' }],
  pitches: [0],
  cue: { start: 0.2, end: 1.5, text: 'お前は自腹だ' },
  highlight: { start: 3, end: 5 },
  time: 0.8,
};

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
    thumbnail: async (_key: string, source: string) => source,
    subtitle: async () => '',
    prewarmSubtitle: () => {},
  };
  const library = createLibrary([root]);
  const cards = { mine: async () => ({ noteId: 0, duplicates: 0 }), duplicates: async () => ({}) };
  server = createServer(
    createHandler({ dictionary, library, progress: store, media, subtitles: store, cards, publicDir }),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;

  // A real source file so the miner can capture a screenshot and audio clip;
  // it lives in its own media root to keep the library expectations above.
  // Two embedded subtitle streams let the HTTP tests exercise extraction.
  mkdirSync(cardRoot, { recursive: true });
  const cardAss = join(dir, 'card-fixture.ass');
  writeFileSync(
    cardAss,
    '[Script Info]\nScriptType: v4.00+\nPlayResX: 160\nPlayResY: 90\n\n' +
      '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
      'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n' +
      '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      'Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,embedded ass\n',
  );
  const cardSrt = join(dir, 'card-fixture.srt');
  writeFileSync(cardSrt, '1\n00:00:00,000 --> 00:00:01,500\nembedded srt\n\n');
  execFileSync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=10:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2:sample_rate=48000',
      '-i',
      cardAss,
      '-i',
      cardSrt,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:s',
      '-map',
      '3:s',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-c:s:0',
      'ass',
      '-c:s:1',
      'srt',
      '-metadata:s:s:0',
      'language=chi',
      '-metadata:s:s:0',
      'title=Chinese (Simplified)',
      '-metadata:s:s:1',
      'language=jpn',
      '-metadata:s:s:1',
      'title=Japanese [SDH]',
      '-t',
      '2',
      join(cardRoot, '[Group] Card Show - 01 [1080p].mkv'),
    ],
    { encoding: 'utf8' },
  );

  ankiServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AnkiRequest;
      ankiRequests.push(body);
      let result: unknown = null;
      if (body.action === 'findNotes') {
        result = findNotesFor ? findNotesFor(String(body.params.query)) : existingNotes;
      } else if (body.action === 'multi') {
        const actions = (body.params.actions ?? []) as { params: { query: string } }[];
        const queries = actions.map((action) => String(action.params.query));
        const batches = multiFor ? multiFor(queries) : [];
        result = queries.map((_, index) => ({ result: batches[index] ?? [], error: null }));
      } else if (body.action === 'addNote') {
        result = 777;
      } else if (body.action === 'storeMediaFile') {
        const fileName = String(body.params.filename);
        const path = String(body.params.path);
        // Record whether the file was still there when AnkiConnect was asked
        // for it; the card directory is removed only afterwards.
        storedMedia.push({ fileName, path, existed: existsSync(path) });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result, error: null }));
    });
  });
  await new Promise<void>((done) => ankiServer.listen(0, '127.0.0.1', done));
  const ankiAddress = ankiServer.address();
  assert.ok(ankiAddress && typeof ankiAddress === 'object');

  cardStore = openStore(cardStateDir);
  const cardMedia = createMediaCache({
    dir: join(cardCache, 'media'),
    thumbsDir: join(cardCache, 'thumbs'),
    subsDir: join(cardCache, 'subs'),
    limitBytes: 1_000_000_000,
  });
  cardLibrary = createLibrary([cardRoot], {
    embeddedSubtitles: (source) => cardMedia.embeddedSubtitles(source),
  });
  const anki = createAnki({
    url: `http://127.0.0.1:${ankiAddress.port}`,
    apiKey: null,
    deck: cardStore.config.anki.deck,
    model: cardStore.config.anki.model,
  });
  const miner = createMiner({ library: cardLibrary, media: cardMedia, anki, store: cardStore, workDir: cardWorkDir });
  cardServer = createServer(
    createHandler({
      dictionary,
      library: cardLibrary,
      progress: cardStore,
      media: cardMedia,
      subtitles: cardStore,
      cards: miner,
      publicDir,
    }),
  );
  await new Promise<void>((done) => cardServer.listen(0, '127.0.0.1', done));
  const cardAddress = cardServer.address();
  assert.ok(cardAddress && typeof cardAddress === 'object');
  cardBase = `http://127.0.0.1:${cardAddress.port}`;
  const [cardSeries] = await cardLibrary.series();
  cardEpisodeId = cardSeries?.episodes[0]?.id ?? '';
  assert.notEqual(cardEpisodeId, '');
});

after(() => {
  server.close();
  cardServer.close();
  ankiServer.close();
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
  assert.equal((await fetch(`${base}/api/cards`)).status, 405);
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
  for (const episode of series?.episodes ?? []) {
    assert.equal(episode.thumbnail, `/api/episodes/${episode.id}/thumbnail`);
  }
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
    seriesId: library.series[0]?.id,
    seriesTitle: 'Show',
    video: `/api/episodes/${first.id}/video`,
    subtitleOptions: [
      {
        id: 'f0',
        slot: 'ja',
        label: '.ja.ass',
        format: 'ass',
        source: 'sidecar',
        url: `/api/episodes/${first.id}/subtitles/f0`,
      },
      {
        id: 'f1',
        slot: 'zh',
        label: '.tc.ass',
        format: 'ass',
        source: 'sidecar',
        url: `/api/episodes/${first.id}/subtitles/f1`,
      },
    ],
    subtitles: { ja: 'f0', zh: 'f1' },
    subtitleFallback: [],
    position: 0,
    nextEpisodeId: second.id,
  });
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(prewarmed.sort(), [first.id, second.id].sort());

  const zh = episode.subtitleOptions.find((option) => option.slot === 'zh');
  assert.ok(zh);
  const subtitles = await fetch(`${base}${zh.url}`);
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

test('serves a cached episode thumbnail', async () => {
  const res = await fetch(`${cardBase}/api/episodes/${cardEpisodeId}/thumbnail`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control') ?? '', /max-age=86400/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8]);

  assert.equal((await fetch(`${cardBase}/api/episodes/00ff/thumbnail`)).status, 404);
});

test('offers embedded subtitle streams and serves them', async () => {
  const library = (await (await fetch(`${cardBase}/api/library`)).json()) as LibraryResponse;
  const [series] = library.series;
  assert.deepEqual(series?.episodes[0]?.languages, ['ja', 'zh']);

  const episode = (await (await fetch(`${cardBase}/api/episodes/${cardEpisodeId}`)).json()) as EpisodeResponse;
  assert.deepEqual(
    episode.subtitleOptions.map((option) => [option.slot, option.label, option.source, option.format]),
    [
      ['zh', 'Chinese (Simplified)', 'embedded', 'ass'],
      ['ja', 'Japanese [SDH]', 'embedded', 'srt'],
    ],
  );
  assert.equal(episode.subtitles.ja, episode.subtitleOptions.find((option) => option.slot === 'ja')?.id);
  assert.equal(episode.subtitles.zh, episode.subtitleOptions.find((option) => option.slot === 'zh')?.id);
  assert.deepEqual(episode.subtitleFallback, []);

  const ass = episode.subtitleOptions.find((option) => option.format === 'ass');
  const srt = episode.subtitleOptions.find((option) => option.format === 'srt');
  assert.ok(ass && srt);
  assert.match(await (await fetch(`${cardBase}${ass.url}`)).text(), /\[Script Info\]/);
  assert.match(await (await fetch(`${cardBase}${srt.url}`)).text(), /-->/);
});

test('remembers subtitle choices per series and reports fallback', async () => {
  const library = await getJson<LibraryResponse>('/api/library');
  const series = library.series[0];
  assert.ok(series);
  const [first, second] = series.episodes;
  const put = (body: unknown) =>
    fetch(`${base}/api/series/${series.id}/subtitles`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  assert.equal((await put({ episodeId: first?.id, slot: 'zh', option: 'f1' })).status, 204);
  const chosen = await getJson<EpisodeResponse>(`/api/episodes/${first?.id}`);
  assert.equal(chosen.subtitles.zh, 'f1');
  assert.deepEqual(chosen.subtitleFallback, []);

  const saved = JSON.parse(readFileSync(join(stateDir, 'subtitles.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(saved[series.id], { zh: { source: 'sidecar', suffix: '.tc.ass' } });

  // Episode 02 has no subtitle at all, so the saved key cannot match.
  const other = await getJson<EpisodeResponse>(`/api/episodes/${second?.id}`);
  assert.deepEqual(other.subtitles, { ja: null, zh: null });
  assert.deepEqual(other.subtitleFallback, ['zh']);

  assert.equal((await put({ episodeId: first?.id, slot: 'zh', option: null })).status, 204);
  assert.equal((await getJson<EpisodeResponse>(`/api/episodes/${first?.id}`)).subtitles.zh, null);

  assert.equal((await put({ episodeId: first?.id, slot: 'zh', option: 'default' })).status, 204);
  assert.equal((await getJson<EpisodeResponse>(`/api/episodes/${first?.id}`)).subtitles.zh, 'f1');
});

test('validates subtitle choices', async () => {
  const library = await getJson<LibraryResponse>('/api/library');
  const series = library.series[0];
  assert.ok(series);
  const [first] = series.episodes;
  const put = (seriesId: string, body: unknown) =>
    fetch(`${base}/api/series/${seriesId}/subtitles`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  assert.equal((await put(series.id, { episodeId: first?.id, slot: 'ja', option: 'nope' })).status, 400);
  assert.equal((await put(series.id, { episodeId: first?.id, slot: 'zh', option: 'f0' })).status, 400);
  assert.equal((await put(series.id, { episodeId: first?.id, slot: 'en', option: 'f0' })).status, 400);
  assert.equal((await put(series.id, { episodeId: '00ff', slot: 'ja', option: 'f0' })).status, 404);
  assert.equal((await put(series.id, { episodeId: cardEpisodeId, slot: 'ja', option: 'f0' })).status, 404);
  assert.equal(
    (await fetch(`${base}/api/series/${series.id}/subtitles`, { method: 'PUT', body: 'nope' })).status,
    400,
  );
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

function resetAnki(): void {
  ankiRequests.length = 0;
  storedMedia.length = 0;
  existingNotes = [];
  findNotesFor = null;
  multiFor = null;
}

function postCard(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('creates a card, captures its media and records the note', async () => {
  resetAnki();
  const res = await postCard(cardBase, { ...CARD, episodeId: cardEpisodeId });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as CardResponse, { noteId: 777, duplicates: 0 });

  assert.deepEqual(
    ankiRequests.map((request) => request.action),
    ['findNotes', 'storeMediaFile', 'storeMediaFile', 'addNote'],
  );
  assert.equal(
    ankiRequests[0]?.params.query,
    `"deck:${cardStore.config.anki.deck}" Expression:"自腹"`,
  );

  const image = storedMedia.find((file) => file.fileName.endsWith('.jpg'));
  const audio = storedMedia.find((file) => file.fileName.endsWith('.mp3'));
  assert.ok(image && audio);
  assert.equal(image.existed, true, 'the screenshot exists when Anki copies it');
  assert.equal(audio.existed, true, 'the clip exists when Anki copies it');
  assert.ok(image.path.startsWith(cardWorkDir));
  assert.ok(audio.path.startsWith(cardWorkDir));
  assert.match(image.fileName, /_00m00s800ms\.jpg$/);
  assert.match(audio.fileName, /_00m00s000ms_00m01s750ms\.mp3$/);

  const note = ankiRequests[3]?.params.note as {
    deckName: string;
    modelName: string;
    fields: Record<string, string>;
    tags: string[];
    options: unknown;
  };
  assert.equal(note.deckName, cardStore.config.anki.deck);
  assert.equal(note.modelName, cardStore.config.anki.model);
  assert.equal(note.fields.Expression, '自腹');
  assert.equal(note.fields.ExpressionFurigana, '自腹[じばら]');
  assert.equal(note.fields.Sentence, 'お前は<b>自腹</b>だ');
  assert.equal(note.fields.Picture, `<img alt="snapshot" src="${image.fileName}">`);
  assert.equal(note.fields.SentenceAudio, `[sound:${audio.fileName}]`);
  assert.equal(note.fields.PitchCategories, 'heiban');
  assert.equal(note.fields.IsWordAndSentenceCard, 'X');
  assert.deepEqual(note.tags, ['sla']);
  assert.deepEqual(note.options, { allowDuplicate: true });

  const lines = readFileSync(join(cardStateDir, 'cards.jsonl'), 'utf8').trim().split('\n');
  const recorded = JSON.parse(lines.at(-1) ?? '{}') as {
    noteId: number;
    term: string;
    episodeId: string;
    time: number;
    minedAt: string;
  };
  assert.equal(recorded.noteId, 777);
  assert.equal(recorded.term, '自腹');
  assert.equal(recorded.episodeId, cardEpisodeId);
  assert.equal(recorded.time, 0.8);
  assert.equal(typeof recorded.minedAt, 'string');

  assert.deepEqual(readdirSync(cardWorkDir), [], 'the temporary card directory is removed');
});

test('reports how many notes with the expression already exist', async () => {
  resetAnki();
  existingNotes = [11, 12];
  const res = await postCard(cardBase, { ...CARD, episodeId: cardEpisodeId });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as CardResponse, { noteId: 777, duplicates: 2 });
});

test('counts duplicate notes for each distinct term', async () => {
  resetAnki();
  // The union finds both candidate notes; only 自腹 has any.
  findNotesFor = () => [1, 2];
  multiFor = (queries) => queries.map((query) => (query.includes('Expression:"自腹"') ? [1, 2] : []));
  const terms = ['自腹', '腹', '自腹'];
  const query = terms.map((term) => `term=${encodeURIComponent(term)}`).join('&');
  const res = await fetch(`${cardBase}/api/cards/duplicates?${query}`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as DuplicatesResponse, { '自腹': 2, '腹': 0 });

  assert.deepEqual(
    ankiRequests.map((request) => request.action),
    ['findNotes', 'multi'],
  );
  assert.equal(
    ankiRequests[0]?.params.query,
    `"deck:${cardStore.config.anki.deck}" (Expression:"自腹" or Expression:"腹")`,
  );
  const actions = ankiRequests[1]?.params.actions as { action: string; params: { query: string } }[];
  assert.deepEqual(
    actions.map((action) => action.params.query),
    ['nid:1,2 (Expression:"自腹")', 'nid:1,2 (Expression:"腹")'],
  );
});

test('rejects invalid duplicate term lists', async () => {
  const duplicatesUrl = (query: string) => `${cardBase}/api/cards/duplicates${query}`;
  assert.equal((await fetch(duplicatesUrl(''))).status, 400);
  assert.equal((await fetch(duplicatesUrl('?term='))).status, 400);
  assert.equal((await fetch(duplicatesUrl(`?term=${encodeURIComponent('あ'.repeat(65))}`))).status, 400);
  const many = Array.from({ length: 21 }, (_, index) => `term=${index}`).join('&');
  assert.equal((await fetch(duplicatesUrl(`?${many}`))).status, 400);
});

test('accepts card bodies larger than the progress limit', async () => {
  resetAnki();
  const html = `<span>${'x'.repeat(8000)}</span>`;
  const res = await postCard(cardBase, {
    ...CARD,
    episodeId: cardEpisodeId,
    definitions: [{ dictionary: 'Fixture', html }],
  });
  assert.equal(res.status, 200);
});

test('rejects invalid card bodies', async () => {
  const valid = { ...CARD, episodeId: cardEpisodeId };
  const invalid: unknown[] = [
    {},
    { ...valid, term: '' },
    { ...valid, highlight: { start: 4, end: 3 } },
    { ...valid, highlight: { start: 3, end: 999 } },
    { ...valid, highlight: { start: 0, end: 1.5 } },
    { ...valid, time: -1 },
    { ...valid, cue: { start: 2, end: 1, text: 'あ' } },
    { ...valid, pitches: ['0'] },
    'not json',
  ];
  for (const body of invalid) {
    const res = await postCard(cardBase, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
});

test('returns 404 for a card on an unknown episode', async () => {
  resetAnki();
  const res = await postCard(cardBase, { ...CARD, episodeId: '00ff' });
  assert.equal(res.status, 404);
  assert.equal(ankiRequests.length, 0);
});

test('returns 502 when Anki cannot be reached', async () => {
  // Take a port that was open a moment ago and is now closed, so the connection
  // is refused instead of a fake server answering.
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const probeAddress = probe.address();
  assert.ok(probeAddress && typeof probeAddress === 'object');
  const deadUrl = `http://127.0.0.1:${probeAddress.port}`;
  await new Promise<void>((done) => probe.close(() => done()));

  const anki = createAnki({
    url: deadUrl,
    apiKey: null,
    deck: cardStore.config.anki.deck,
    model: cardStore.config.anki.model,
  });
  const library = createLibrary([cardRoot]);
  const media = createMediaCache({
    dir: join(cardCache, 'down-media'),
    thumbsDir: join(cardCache, 'down-thumbs'),
    subsDir: join(cardCache, 'down-subs'),
    limitBytes: 1_000_000_000,
  });
  const cards = createMiner({ library, media, anki, store: cardStore, workDir: join(cardCache, 'down-cards') });
  const downServer = createServer(
    createHandler({ dictionary, library, progress: cardStore, media, subtitles: cardStore, cards, publicDir }),
  );
  await new Promise<void>((done) => downServer.listen(0, '127.0.0.1', done));
  const downAddress = downServer.address();
  assert.ok(downAddress && typeof downAddress === 'object');

  try {
    const baseUrl = `http://127.0.0.1:${downAddress.port}`;
    const res = await postCard(baseUrl, { ...CARD, episodeId: cardEpisodeId });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Anki is not reachable/);

    const duplicates = await fetch(`${baseUrl}/api/cards/duplicates?term=${encodeURIComponent('自腹')}`);
    assert.equal(duplicates.status, 502);
    assert.match(((await duplicates.json()) as { error: string }).error, /Anki is not reachable/);
  } finally {
    await new Promise<void>((done) => downServer.close(() => done()));
  }
});
