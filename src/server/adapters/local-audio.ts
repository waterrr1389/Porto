// Word recordings from the Anki add-on "Local Audio Server for Yomichan",
// which listens on this machine while Anki runs. Listing and file downloads
// are thin wrappers; the response shape is validated in core/local-audio.
import { parseAudioSources, type AudioSource } from '../../core/local-audio.ts';

export interface LocalAudioOptions {
  /** Base URL of the add-on, e.g. http://127.0.0.1:5050. */
  url: string;
  fetch?: typeof fetch;
}

export interface LocalAudioFile {
  body: Buffer;
  contentType: string;
}

export interface LocalAudio {
  /** Configured base, used to recognise URLs that belong to the add-on. */
  readonly baseUrl: string;
  /** Recordings of a word, best first. Rejects when the server fails. */
  list(term: string, reading: string): Promise<AudioSource[]>;
  /** One file under the base, or null when the server has no such file. */
  fetch(path: string): Promise<LocalAudioFile | null>;
}

const LIST_TIMEOUT_MS = 3000;
const FILE_TIMEOUT_MS = 10_000;

export function createLocalAudio(options: LocalAudioOptions): LocalAudio {
  const doFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = new URL(options.url).href;

  async function request(url: string, timeoutMs: number): Promise<Response> {
    try {
      return await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Local audio server is not reachable at ${baseUrl}: ${message}`);
    }
  }

  async function list(term: string, reading: string): Promise<AudioSource[]> {
    const url = new URL(baseUrl);
    url.searchParams.set('term', term);
    if (reading !== '') url.searchParams.set('reading', reading);
    const response = await request(url.href, LIST_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Local audio server returned HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Local audio server returned invalid JSON');
    }
    const sources = parseAudioSources(payload);
    if (sources === null) {
      throw new Error('Local audio server returned an unexpected response');
    }
    return sources;
  }

  async function fetch(path: string): Promise<LocalAudioFile | null> {
    const url = new URL(path, baseUrl);
    if (url.origin !== new URL(baseUrl).origin) {
      throw new Error('Local audio path is outside the configured server');
    }
    const response = await request(url.href, FILE_TIMEOUT_MS);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Local audio server returned HTTP ${response.status}`);
    }
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  return { baseUrl, list, fetch };
}
