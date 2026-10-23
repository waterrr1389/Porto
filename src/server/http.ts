// Routing only: maps requests to the services passed in, validates input and
// chooses status codes. Domain decisions live in core/ and the adapters.
import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { resumeEpisode, type LibraryEpisode, type LibrarySeries } from '../core/library.ts';
import { audioProxyUrl, localAudioPath, wordAudioPath, type AudioSource } from '../core/local-audio.ts';
import { decideRange } from '../core/range.ts';
import {
  buildSubtitleOptions,
  embeddedSubtitleLanguage,
  selectSubtitles,
  type EmbeddedSubtitle,
  type SavedSubtitleChoices,
  type SubtitleFormat,
  type SubtitleKey,
  type SubtitleSlot,
} from '../core/subtitle-options.ts';
import {
  MAX_DUPLICATE_TERMS,
  MAX_LOOKUP_LENGTH,
  type ApiError,
  type CardRequest,
  type CardResponse,
  type DictionariesResponse,
  type DuplicatesResponse,
  type EpisodeResponse,
  type LibraryResponse,
  type LookupResponse,
  type ProgressRequest,
  type SubtitleOption as ApiSubtitleOption,
  type WordAudio,
  type WordAudioResponse,
} from '../shared/api.ts';
import { AnkiFailure, EpisodeNotFound } from './mining.ts';

export interface DictionaryService {
  dictionaries(): DictionariesResponse;
  lookup(text: string): Promise<LookupResponse>;
  /** A file bundled with a dictionary, served to Yomitan's renderer for images in definitions. */
  media(dictionary: string, path: string): { mediaType: string; content: Uint8Array } | null;
}

export interface EpisodeSource extends LibraryEpisode {
  /** Embedded text subtitle streams, probed when the library was scanned. */
  embedded: EmbeddedSubtitle[];
}

export interface SeriesSource extends Omit<LibrarySeries, 'episodes'> {
  episodes: EpisodeSource[];
}

export interface LibraryService {
  series(): Promise<SeriesSource[]>;
  episode(id: string): Promise<{
    series: SeriesSource;
    episode: EpisodeSource;
    next: EpisodeSource | null;
    videoPath: string;
    /** Absolute path of a sidecar subtitle relative to the media root. */
    sidecarPath(relative: string): string;
  } | null>;
}

export interface ProgressService {
  progress(episodeId: string): { position: number; duration: number } | null;
  allProgress(): ReadonlyMap<string, { position: number; duration: number; updatedAt: number }>;
  saveProgress(episodeId: string, position: number, duration: number): void;
}

export interface SubtitleChoicesService {
  subtitleChoices(seriesId: string): SavedSubtitleChoices;
  saveSubtitleChoice(seriesId: string, slot: SubtitleSlot, choice: SubtitleKey | 'off'): void;
  clearSubtitleChoice(seriesId: string, slot: SubtitleSlot): void;
}

export interface MediaService {
  /** Path of a playable MP4 for the source video, prepared on first request. */
  prepare(key: string, source: string): Promise<string>;
  /** Starts preparing without waiting. */
  prewarm(key: string, source: string): void;
  /** Path of a cached JPEG still for the episode, extracted on first request. */
  thumbnail(key: string, source: string): Promise<string>;
  /** Path of an extracted embedded subtitle, extracted on first request. */
  subtitle(key: string, source: string, index: number, format: SubtitleFormat): Promise<string>;
  /** Starts extracting an embedded subtitle without waiting. */
  prewarmSubtitle(key: string, source: string, index: number, format: SubtitleFormat): void;
}

export interface CardService {
  mine(request: CardRequest): Promise<CardResponse>;
  /** Counts, per expression, the notes in the deck that already use it. */
  duplicates(terms: string[]): Promise<DuplicatesResponse>;
}

/** The local audio server, or null when word audio is disabled in the config. */
export interface LocalAudioService {
  readonly baseUrl: string;
  list(term: string, reading: string): Promise<AudioSource[]>;
  fetch(path: string): Promise<{ body: Buffer; contentType: string } | null>;
}

export interface HttpServices {
  dictionary: DictionaryService;
  library: LibraryService;
  progress: ProgressService;
  media: MediaService;
  subtitles: SubtitleChoicesService;
  audio: LocalAudioService | null;
  cards: CardService;
  /** Client files: index.html and the bundle. */
  publicDir: string;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ssa': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const MAX_BODY_BYTES = 4096;
/** Card bodies carry the rendered definition HTML, so they are much larger. */
const MAX_CARD_BODY_BYTES = 2 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createHandler(services: HttpServices): Handler {
  return (req, res) => {
    route(services, req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendJson<ApiError>(res, error.status, { error: error.message });
        return;
      }
      console.error(`${req.method} ${req.url} failed`, error);
      if (!res.headersSent) sendJson<ApiError>(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  };
}

async function route(services: HttpServices, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'malformed path');
  }
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  const episodeRoute = /^\/api\/episodes\/([0-9a-f]+)(?:\/(video|progress|thumbnail|subtitles\/([\w-]+)))?$/.exec(path);
  if (episodeRoute) {
    const [, id = '', action, optionId] = episodeRoute;
    if (action === 'progress') {
      expectMethod(method, 'PUT');
      return saveProgress(services, req, res, id);
    }
    expectMethod(method, 'GET');
    const located = await services.library.episode(id);
    if (!located) throw new HttpError(404, 'unknown episode');
    if (action === 'video') {
      return sendPath(req, res, await services.media.prepare(id, located.videoPath));
    }
    if (action === 'thumbnail') {
      let file: string;
      try {
        file = await services.media.thumbnail(id, located.videoPath);
      } catch {
        throw new HttpError(502, 'cannot extract thumbnail');
      }
      return sendPath(req, res, file, 'max-age=86400');
    }
    if (optionId !== undefined) {
      const options = buildSubtitleOptions(located.episode.subtitles, located.episode.embedded);
      const option = options.find((candidate) => candidate.id === optionId);
      if (!option) throw new HttpError(404, 'no such subtitle');
      if (option.source === 'sidecar') {
        if (option.path === null) throw new HttpError(404, 'no such subtitle');
        return sendPath(req, res, located.sidecarPath(option.path));
      }
      if (option.streamIndex === null) throw new HttpError(404, 'no such subtitle');
      let file: string;
      try {
        file = await services.media.subtitle(id, located.videoPath, option.streamIndex, option.format);
      } catch {
        throw new HttpError(502, 'cannot extract subtitle');
      }
      return sendPath(req, res, file);
    }
    return sendJson<EpisodeResponse>(res, 200, describeEpisode(services, located));
  }

  const seriesRoute = /^\/api\/series\/([0-9a-f]+)\/subtitles$/.exec(path);
  if (seriesRoute) {
    expectMethod(method, 'PUT');
    return saveSubtitleChoice(services, req, res, seriesRoute[1] ?? '');
  }

  if (path === '/api/audio') {
    expectMethod(method, 'GET');
    return listWordAudio(services, url, res);
  }

  if (path === '/api/audio/file') {
    expectMethod(method, 'GET');
    return sendWordAudio(services, url, req, res);
  }

  if (path === '/api/cards') {
    expectMethod(method, 'POST');
    return createCard(services, req, res);
  }

  if (path === '/api/cards/duplicates') {
    expectMethod(method, 'GET');
    return findDuplicates(services, url, res);
  }

  if (!path.startsWith('/api/')) {
    expectMethod(method, 'GET');
    return sendFile(req, res, services.publicDir, path === '/' ? 'index.html' : path.slice(1));
  }
  expectMethod(method, 'GET');
  switch (path) {
    case '/api/library':
      return sendJson<LibraryResponse>(res, 200, await describeLibrary(services));
    case '/api/dictionaries':
      return sendJson<DictionariesResponse>(res, 200, services.dictionary.dictionaries());
    case '/api/dictionaries/media': {
      const dictionary = url.searchParams.get('dictionary') ?? '';
      const mediaPath = url.searchParams.get('path') ?? '';
      if (dictionary === '' || mediaPath === '') throw new HttpError(400, 'dictionary and path are required');
      const media = services.dictionary.media(dictionary, mediaPath);
      if (media === null) throw new HttpError(404, 'no such media');
      res.writeHead(200, {
        'Content-Type': media.mediaType,
        'Content-Length': media.content.byteLength,
        'Cache-Control': 'max-age=86400',
      });
      return void res.end(media.content);
    }
    case '/api/lookup': {
      const text = url.searchParams.get('text') ?? '';
      if (text === '' || text.length > MAX_LOOKUP_LENGTH) {
        throw new HttpError(400, `text must be 1-${MAX_LOOKUP_LENGTH} characters`);
      }
      return sendJson<LookupResponse>(res, 200, await services.dictionary.lookup(text));
    }
  }
  throw new HttpError(404, 'unknown endpoint');
}

function expectMethod(actual: string | undefined, expected: string): void {
  if (actual !== expected) throw new HttpError(405, 'method not allowed');
}

async function describeLibrary(services: HttpServices): Promise<LibraryResponse> {
  const series = await services.library.series();
  const progress = services.progress.allProgress();
  const resume = resumeEpisode(series, progress);
  if (resume) {
    // Offering an episode for resume is when its remux should start.
    const located = await services.library.episode(resume.episode.id);
    if (located) services.media.prewarm(resume.episode.id, located.videoPath);
  }
  return {
    series: series.map((s) => ({
      id: s.id,
      title: s.title,
      episodes: s.episodes.map((e) => ({
        id: e.id,
        title: e.title,
        languages: episodeLanguages(e),
        position: progress.get(e.id)?.position ?? 0,
        duration: progress.get(e.id)?.duration ?? 0,
        thumbnail: `/api/episodes/${e.id}/thumbnail`,
      })),
    })),
    resume: resume && {
      episodeId: resume.episode.id,
      seriesTitle: resume.series.title,
      episodeTitle: resume.episode.title,
      position: resume.position,
    },
  };
}

/** Sidecar languages plus the ones only embedded streams provide. */
function episodeLanguages(episode: EpisodeSource): string[] {
  const languages = new Set(episode.subtitles.map((subtitle) => subtitle.language));
  for (const stream of episode.embedded) {
    const language = embeddedSubtitleLanguage(stream);
    if (language !== null) languages.add(language);
  }
  return [...languages].sort();
}

function describeEpisode(
  services: HttpServices,
  { series, episode, next, videoPath }: NonNullable<Awaited<ReturnType<LibraryService['episode']>>>,
): EpisodeResponse {
  services.media.prewarm(episode.id, videoPath);
  if (next) {
    void services.library.episode(next.id).then((n) => n && services.media.prewarm(next.id, n.videoPath));
  }

  const options = buildSubtitleOptions(episode.subtitles, episode.embedded);
  for (const option of options) {
    // Reading a multi-gigabyte source is slow, so extraction starts while the
    // response is on its way to the player.
    if (option.source === 'embedded' && option.streamIndex !== null) {
      services.media.prewarmSubtitle(episode.id, videoPath, option.streamIndex, option.format);
    }
  }
  const selection = selectSubtitles(options, services.subtitles.subtitleChoices(series.id));
  const subtitleOptions: ApiSubtitleOption[] = options.map((option) => ({
    id: option.id,
    slot: option.slot,
    label: option.label,
    format: option.format,
    source: option.source,
    url: `/api/episodes/${episode.id}/subtitles/${option.id}`,
  }));

  return {
    id: episode.id,
    title: episode.title,
    seriesId: series.id,
    seriesTitle: series.title,
    video: `/api/episodes/${episode.id}/video`,
    subtitleOptions,
    subtitles: selection.selected,
    subtitleFallback: selection.fallback,
    position: services.progress.progress(episode.id)?.position ?? 0,
    nextEpisodeId: next?.id ?? null,
  };
}

async function saveProgress(services: HttpServices, req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const body = await readJson(req);
  const { position, duration } = (body ?? {}) as Partial<ProgressRequest>;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!valid(position) || !valid(duration)) throw new HttpError(400, 'position and duration must be non-negative numbers');
  if (!(await services.library.episode(id))) throw new HttpError(404, 'unknown episode');
  services.progress.saveProgress(id, position, duration);
  res.writeHead(204).end();
}

async function saveSubtitleChoice(
  services: HttpServices,
  req: IncomingMessage,
  res: ServerResponse,
  seriesId: string,
): Promise<void> {
  const body = await readJson(req);
  if (!isRecord(body)) throw new HttpError(400, 'subtitle choice must be a json object');
  const episodeId = requireString(body.episodeId, 'episodeId');
  const slot = body.slot;
  if (slot !== 'ja' && slot !== 'zh') throw new HttpError(400, 'slot must be ja or zh');
  const option = body.option;
  if (option !== null && option !== 'default' && typeof option !== 'string') {
    throw new HttpError(400, 'option must be an id, null or "default"');
  }

  const located = await services.library.episode(episodeId);
  if (!located || located.series.id !== seriesId) throw new HttpError(404, 'unknown episode in that series');

  if (option === 'default') {
    services.subtitles.clearSubtitleChoice(seriesId, slot);
    res.writeHead(204).end();
    return;
  }
  if (option === null) {
    services.subtitles.saveSubtitleChoice(seriesId, slot, 'off');
    res.writeHead(204).end();
    return;
  }

  const options = buildSubtitleOptions(located.episode.subtitles, located.episode.embedded);
  const chosen = options.find((candidate) => candidate.id === option);
  if (!chosen || chosen.slot !== slot) throw new HttpError(400, 'unknown subtitle option');
  services.subtitles.saveSubtitleChoice(seriesId, slot, chosen.key);
  res.writeHead(204).end();
}

async function createCard(services: HttpServices, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = parseCardRequest(await readJson(req, MAX_CARD_BODY_BYTES), services.audio);
  let response: CardResponse;
  try {
    response = await services.cards.mine(request);
  } catch (error) {
    if (error instanceof EpisodeNotFound) throw new HttpError(404, 'unknown episode');
    // The miner only uses this error type for failures AnkiConnect reported,
    // so its message is the useful one to show the user.
    if (error instanceof AnkiFailure) throw new HttpError(502, error.message);
    throw error;
  }
  return sendJson<CardResponse>(res, 200, response);
}

async function findDuplicates(services: HttpServices, url: URL, res: ServerResponse): Promise<void> {
  const terms = url.searchParams.getAll('term');
  if (terms.length === 0) throw new HttpError(400, 'term is required');
  if (terms.length > MAX_DUPLICATE_TERMS) throw new HttpError(400, `at most ${MAX_DUPLICATE_TERMS} terms`);
  if (terms.some((term) => term === '')) throw new HttpError(400, 'term must not be empty');
  if (terms.some((term) => term.length > MAX_LOOKUP_LENGTH)) {
    throw new HttpError(400, `term must be at most ${MAX_LOOKUP_LENGTH} characters`);
  }

  let response: DuplicatesResponse;
  try {
    response = await services.cards.duplicates(terms);
  } catch (error) {
    if (error instanceof AnkiFailure) throw new HttpError(502, error.message);
    throw error;
  }
  return sendJson<DuplicatesResponse>(res, 200, response);
}

async function listWordAudio(services: HttpServices, url: URL, res: ServerResponse): Promise<void> {
  const term = url.searchParams.get('term') ?? '';
  if (term === '' || term.length > MAX_LOOKUP_LENGTH) {
    throw new HttpError(400, `term must be 1-${MAX_LOOKUP_LENGTH} characters`);
  }
  const reading = url.searchParams.get('reading') ?? '';
  const audio = services.audio;
  if (audio === null) return sendJson<WordAudioResponse>(res, 200, { audio: [] });

  let sources: AudioSource[];
  try {
    sources = await audio.list(term, reading);
  } catch (error) {
    throw new HttpError(502, messageOf(error));
  }

  const entries: WordAudio[] = [];
  for (const source of sources) {
    const proxy = audioProxyUrl(audio.baseUrl, source.url);
    // Files hosted elsewhere are not ours to fetch.
    if (proxy !== null) entries.push({ name: source.name, url: proxy });
  }
  return sendJson<WordAudioResponse>(res, 200, { audio: entries });
}

async function sendWordAudio(
  services: HttpServices,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const audio = services.audio;
  if (audio === null) throw new HttpError(404, 'word audio is disabled');
  const path = localAudioPath(audio.baseUrl, url.searchParams.get('path') ?? '');
  if (path === null) throw new HttpError(400, 'invalid audio path');

  let file: { body: Buffer; contentType: string } | null;
  try {
    file = await audio.fetch(path);
  } catch (error) {
    throw new HttpError(502, messageOf(error));
  }
  if (file === null) throw new HttpError(404, 'audio not found');

  res.writeHead(200, {
    'Content-Type': file.contentType,
    'Content-Length': file.body.length,
    'Cache-Control': 'max-age=86400',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(file.body);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCardRequest(body: unknown, audio: LocalAudioService | null): CardRequest {
  if (!isRecord(body)) throw new HttpError(400, 'card must be a json object');

  const episodeId = requireString(body.episodeId, 'episodeId');
  if (episodeId === '') throw new HttpError(400, 'episodeId must not be empty');
  const term = requireString(body.term, 'term');
  if (term === '') throw new HttpError(400, 'term must not be empty');

  const definitions = requireArray(body.definitions, 'definitions').map((entry) => {
    if (!isRecord(entry)) throw new HttpError(400, 'definitions must contain objects');
    return {
      dictionary: requireString(entry.dictionary, 'definitions[].dictionary'),
      html: requireString(entry.html, 'definitions[].html'),
    };
  });
  const frequencies = requireArray(body.frequencies, 'frequencies').map((entry) => {
    if (!isRecord(entry)) throw new HttpError(400, 'frequencies must contain objects');
    return {
      dictionary: requireString(entry.dictionary, 'frequencies[].dictionary'),
      value: requireString(entry.value, 'frequencies[].value'),
    };
  });
  const pitches = requireArray(body.pitches, 'pitches').map((pitch, index) =>
    requireNumber(pitch, `pitches[${index}]`),
  );

  if (!isRecord(body.cue)) throw new HttpError(400, 'cue must be an object');
  const cue = {
    start: requireNumber(body.cue.start, 'cue.start'),
    end: requireNumber(body.cue.end, 'cue.end'),
    text: requireString(body.cue.text, 'cue.text'),
  };
  if (cue.start < 0 || cue.end < cue.start) throw new HttpError(400, 'cue must be a non-negative time span');

  if (!isRecord(body.highlight)) throw new HttpError(400, 'highlight must be an object');
  const highlight = {
    start: requireNumber(body.highlight.start, 'highlight.start'),
    end: requireNumber(body.highlight.end, 'highlight.end'),
  };
  const inCue =
    Number.isInteger(highlight.start) &&
    Number.isInteger(highlight.end) &&
    highlight.start >= 0 &&
    highlight.start <= highlight.end &&
    highlight.end <= cue.text.length;
  if (!inCue) throw new HttpError(400, 'highlight must be a range inside cue.text');

  const time = requireNumber(body.time, 'time');
  if (time < 0) throw new HttpError(400, 'time must not be negative');

  return {
    episodeId,
    term,
    reading: requireString(body.reading, 'reading'),
    definitions,
    frequencies,
    pitches,
    cue,
    highlight,
    time,
    wordAudio: parseWordAudio(body.wordAudio, audio),
  };
}

/**
 * A word recording must be one of our own proxy URLs pointing at a file on the
 * configured audio server; anything else would make the miner fetch elsewhere.
 */
function parseWordAudio(value: unknown, audio: LocalAudioService | null): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || audio === null) {
    throw new HttpError(400, 'wordAudio must be an audio URL from this server');
  }
  const path = wordAudioPath(value);
  if (path === null || localAudioPath(audio.baseUrl, path) === null) {
    throw new HttpError(400, 'wordAudio must be an audio URL from this server');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${name} must be a number`);
  return value;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${name} must be an array`);
  return value;
}

async function readJson(req: IncomingMessage, limitBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body must be json');
  }
}

function sendJson<T>(res: ServerResponse, status: number, body: T): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/** Serves `relative` inside `dir`; paths escaping `dir` are not found. */
async function sendFile(req: IncomingMessage, res: ServerResponse, dir: string, relative: string): Promise<void> {
  const base = resolve(dir);
  const file = resolve(base, relative);
  if (!file.startsWith(base + sep)) throw new HttpError(404, 'not found');
  return sendPath(req, res, file);
}

/** Serves an absolute file path, honouring a single byte range. */
async function sendPath(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  cacheControl = 'no-cache',
): Promise<void> {
  let info: Stats;
  try {
    info = await stat(file);
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (!info.isFile()) throw new HttpError(404, 'not found');

  const headers = {
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'Last-Modified': info.mtime.toUTCString(),
  };
  const decision = decideRange(req.headers.range, info.size);
  if (decision.status === 416) {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
    res.end();
    return;
  }
  const [start, end] = decision.status === 206 ? [decision.start, decision.end] : [0, info.size - 1];
  res.writeHead(decision.status, {
    ...headers,
    'Content-Length': end - start + 1,
    ...(decision.status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
  });
  if (req.method === 'HEAD' || info.size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  // A client that seeks away aborts the response; the read must stop with it.
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
