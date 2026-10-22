// Routing only: maps requests to the services passed in, validates input and
// chooses status codes. Domain decisions live in core/ and the adapters.
import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { decideRange } from '../core/range.ts';
import {
  MAX_LOOKUP_LENGTH,
  type ApiError,
  type DictionariesResponse,
  type LookupResponse,
} from '../shared/api.ts';

export interface DictionaryService {
  dictionaries(): DictionariesResponse;
  lookup(text: string): Promise<LookupResponse>;
}

export interface HttpServices {
  dictionary: DictionaryService;
  /** Client files: index.html and the bundle. */
  publicDir: string;
  /** Files served under /media/, with byte ranges. */
  mediaDir: string;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function createHandler(services: HttpServices): Handler {
  return (req, res) => {
    route(services, req, res).catch((error: unknown) => {
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
    return sendJson<ApiError>(res, 400, { error: 'malformed path' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson<ApiError>(res, 405, { error: 'method not allowed' });
  }

  if (path === '/api/dictionaries') {
    return sendJson<DictionariesResponse>(res, 200, services.dictionary.dictionaries());
  }
  if (path === '/api/lookup') {
    const text = url.searchParams.get('text') ?? '';
    if (text === '' || text.length > MAX_LOOKUP_LENGTH) {
      return sendJson<ApiError>(res, 400, { error: `text must be 1-${MAX_LOOKUP_LENGTH} characters` });
    }
    return sendJson<LookupResponse>(res, 200, await services.dictionary.lookup(text));
  }
  if (path.startsWith('/api/')) return sendJson<ApiError>(res, 404, { error: 'unknown endpoint' });

  if (path.startsWith('/media/')) {
    return sendFile(req, res, services.mediaDir, path.slice('/media/'.length));
  }
  return sendFile(req, res, services.publicDir, path === '/' ? 'index.html' : path.slice(1));
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

/** Serves `relative` inside `dir`, honouring a single byte range. */
async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  relative: string,
): Promise<void> {
  const base = resolve(dir);
  const file = resolve(base, relative);
  if (!file.startsWith(base + sep)) return sendJson<ApiError>(res, 404, { error: 'not found' });
  let info: Stats;
  try {
    info = await stat(file);
  } catch {
    return sendJson<ApiError>(res, 404, { error: 'not found' });
  }
  if (!info.isFile()) return sendJson<ApiError>(res, 404, { error: 'not found' });

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
