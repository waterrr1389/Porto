// Word recordings from the Anki add-on "Local Audio Server for Yomichan".
// The add-on answers with Yomitan's custom-json audio source list; this module
// validates that list and keeps the browser on our own origin by turning the
// upstream file URLs into proxy URLs.

export interface AudioSource {
  /** Label the add-on gives the recording, e.g. "NHK16 センパイ [0]". */
  name: string;
  /** Absolute upstream URL. */
  url: string;
}

/**
 * Sources from the add-on's response, best first. Returns null when the
 * payload is not an audio source list, so a broken answer is not mistaken for
 * "this word has no recordings". Entries with a missing name or url are dropped.
 */
export function parseAudioSources(payload: unknown): AudioSource[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const list = payload as { type?: unknown; audioSources?: unknown };
  if (list.type !== 'audioSourceList' || !Array.isArray(list.audioSources)) return null;

  const sources: AudioSource[] = [];
  for (const entry of list.audioSources) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, url } = entry as { name?: unknown; url?: unknown };
    if (typeof name !== 'string' || typeof url !== 'string' || name === '' || url === '') continue;
    sources.push({ name, url });
  }
  return sources;
}

/**
 * Same-origin proxy URL for an upstream file, or null when the file is not on
 * the configured base. The path and query travel in the query string so the
 * URL is unambiguous.
 */
export function audioProxyUrl(base: string, upstream: string): string | null {
  let baseUrl: URL;
  let fileUrl: URL;
  try {
    baseUrl = new URL(base);
    fileUrl = new URL(upstream);
  } catch {
    return null;
  }
  if (fileUrl.origin !== baseUrl.origin) return null;
  const params = new URLSearchParams({ path: `${fileUrl.pathname}${fileUrl.search}` });
  return `/api/audio/file?${params.toString()}`;
}

/**
 * Path on the local audio server named by a proxy URL, or null when `url` is
 * not one of our `/api/audio/file` URLs.
 */
export function wordAudioPath(url: string): string | null {
  if (!url.startsWith('/api/audio/file?')) return null;
  const parsed = new URL(url, 'http://localhost');
  const path = parsed.searchParams.get('path');
  return path === null || path === '' ? null : path;
}

/**
 * Validated path for the file proxy. Only paths on the configured base are
 * accepted: a leading slash is required, and protocol-relative URLs,
 * absolute URLs, backslashes and `..` segments are refused. Returns the path
 * with its query, ready to be resolved against the base.
 */
export function localAudioPath(base: string, requested: string): string | null {
  if (!requested.startsWith('/') || requested.startsWith('//') || requested.includes('\\')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  if (decoded.includes('\\')) return null;
  const pathOnly = decoded.split('?')[0] ?? '';
  if (pathOnly.split('/').includes('..')) return null;

  let baseUrl: URL;
  let fileUrl: URL;
  try {
    baseUrl = new URL(base);
    fileUrl = new URL(requested, baseUrl);
  } catch {
    return null;
  }
  if (fileUrl.origin !== baseUrl.origin) return null;
  return `${fileUrl.pathname}${fileUrl.search}`;
}

const EXTENSIONS = new Set(['mp3', 'ogg', 'opus', 'oga', 'm4a', 'aac', 'wav', 'flac', 'webm']);
const BY_CONTENT_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/** File extension for a recording, preferring the server's content type over the path. */
export function audioFileExtension(contentType: string, path: string): string {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  const byType = BY_CONTENT_TYPE[type];
  if (byType !== undefined) return byType;

  const match = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(path);
  const extension = match?.[1]?.toLowerCase();
  return extension !== undefined && EXTENSIONS.has(extension) ? extension : 'mp3';
}
