// Routing only: maps requests to the services passed in, validates input and
// chooses status codes. Domain decisions live in core/ and the adapters.
import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { playerTracks, resumeEpisode, type LibraryEpisode, type LibrarySeries } from '../core/library.ts';
import { decideRange } from '../core/range.ts';
import {
  MAX_LOOKUP_LENGTH,
  type ApiError,
  type DictionariesResponse,
  type EpisodeResponse,
  type LibraryResponse,
  type LookupResponse,
  type ProgressRequest,
} from '../shared/api.ts';

export interface DictionaryService {
  dictionaries(): DictionariesResponse;
  lookup(text: string): Promise<LookupResponse>;
}

export interface LibraryService {
  series(): Promise<LibrarySeries[]>;
  episode(id: string): Promise<{
    series: LibrarySeries;
    episode: LibraryEpisode;
    next: LibraryEpisode | null;
    videoPath: string;
    subtitlePaths: Record<string, string>;
  } | null>;
}

export interface ProgressService {
  progress(episodeId: string): { position: number; duration: number } | null;
  allProgress(): ReadonlyMap<string, { position: number; duration: number; updatedAt: number }>;
  saveProgress(episodeId: string, position: number, duration: number): void;
}

export interface MediaService {
  /** Path of a playable MP4 for the source video, prepared on first request. */
  prepare(key: string, source: string): Promise<string>;
  /** Starts preparing without waiting. */
  prewarm(key: string, source: string): void;
}

export interface HttpServices {
  dictionary: DictionaryService;
  library: LibraryService;
  progress: ProgressService;
  media: MediaService;
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
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const MAX_BODY_BYTES = 4096;

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

  const episodeRoute = /^\/api\/episodes\/([0-9a-f]+)(?:\/(video|progress|subtitles\/([\w-]+)))?$/.exec(path);
  if (episodeRoute) {
    const [, id = '', action, language] = episodeRoute;
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
    if (language !== undefined) {
      const file = located.subtitlePaths[language];
      if (file === undefined) throw new HttpError(404, 'no subtitles in that language');
      return sendPath(req, res, file);
    }
    return sendJson<EpisodeResponse>(res, 200, describeEpisode(services, located));
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
        languages: Object.keys(e.subtitles),
        position: progress.get(e.id)?.position ?? 0,
        duration: progress.get(e.id)?.duration ?? 0,
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

function describeEpisode(
  services: HttpServices,
  { series, episode, next, videoPath }: NonNullable<Awaited<ReturnType<LibraryService['episode']>>>,
): EpisodeResponse {
  services.media.prewarm(episode.id, videoPath);
  if (next) {
    void services.library.episode(next.id).then((n) => n && services.media.prewarm(next.id, n.videoPath));
  }
  // playerTracks picks languages; map each picked language to its URL.
  const languageOf = Object.fromEntries(Object.keys(episode.subtitles).map((language) => [language, language]));
  const tracks = playerTracks(languageOf);
  const subtitleUrl = (language: string) => `/api/episodes/${episode.id}/subtitles/${language}`;
  return {
    id: episode.id,
    title: episode.title,
    seriesTitle: series.title,
    video: `/api/episodes/${episode.id}/video`,
    subtitles: {
      ...(tracks.ja !== undefined ? { ja: subtitleUrl(tracks.ja) } : {}),
      ...(tracks.zh !== undefined ? { zh: subtitleUrl(tracks.zh) } : {}),
    },
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
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
async function sendPath(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
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
    'Cache-Control': 'no-cache',
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
