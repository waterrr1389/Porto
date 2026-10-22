// AnkiConnect client for the local Anki desktop app. Media files are handed
// over by path because Anki and this server run on the same machine; nothing
// is uploaded.
export interface AnkiOptions {
  /** AnkiConnect endpoint, e.g. http://127.0.0.1:8765. */
  url: string;
  /** Sent as `key` when set; AnkiConnect's API key is optional. */
  apiKey: string | null;
  deck: string;
  model: string;
  fetch?: typeof fetch;
}

export interface Anki {
  /** Adds a note with fields and media files (absolute paths on this machine), returns the note id. Rejects with a clear error on AnkiConnect error or when Anki is not running. */
  addNote(fields: Record<string, string>, media: { path: string; fileName: string }[], tags: string[]): Promise<number>;
  /** Ids of notes in the deck matching the query. */
  findNotes(query: string): Promise<number[]>;
  /**
   * Note ids for each query, in order, in the deck. One deck-scoped union
   * query finds the candidates and, only when there are hits, one `multi`
   * request counts each query among them (as Yomitan's findNoteIds does).
   */
  findNotesBatch(queries: string[]): Promise<number[][]>;
}

const ANKI_CONNECT_VERSION = 6;
const TIMEOUT_MS = 5000;

export function createAnki(options: AnkiOptions): Anki {
  const doFetch = options.fetch ?? fetch;

  /** AnkiConnect checks the key on every action, including each one inside `multi`. */
  function request(action: string, params: unknown) {
    return {
      action,
      version: ANKI_CONNECT_VERSION,
      ...(options.apiKey === null ? {} : { key: options.apiKey }),
      params,
    };
  }

  async function invoke(action: string, params: unknown): Promise<unknown> {
    const body = request(action, params);

    let response: Response;
    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Anki is not reachable at ${options.url}: ${messageOf(error)}`);
    }
    if (!response.ok) {
      throw new Error(`Anki at ${options.url} returned HTTP ${response.status}`);
    }

    let reply: unknown;
    try {
      reply = await response.json();
    } catch {
      throw new Error(`Anki at ${options.url} returned invalid JSON`);
    }
    if (typeof reply !== 'object' || reply === null) {
      throw new Error(`Anki at ${options.url} returned an unexpected response`);
    }

    const { result, error } = reply as { result?: unknown; error?: unknown };
    if (error !== undefined && error !== null && error !== '') {
      throw new Error(`AnkiConnect ${action} failed: ${String(error)}`);
    }
    return result;
  }

  async function addNote(
    fields: Record<string, string>,
    media: { path: string; fileName: string }[],
    tags: string[],
  ): Promise<number> {
    for (const file of media) {
      await invoke('storeMediaFile', { filename: file.fileName, path: file.path });
    }

    const result = await invoke('addNote', {
      note: {
        deckName: options.deck,
        modelName: options.model,
        fields,
        tags,
        options: { allowDuplicate: true },
      },
    });
    if (typeof result !== 'number') {
      throw new Error('AnkiConnect addNote returned no note id');
    }
    return result;
  }

  async function findNotes(query: string): Promise<number[]> {
    return noteIds(await invoke('findNotes', { query: `${deckScope()} ${query}` }), 'findNotes');
  }

  async function findNotesBatch(queries: string[]): Promise<number[][]> {
    if (queries.length === 0) return [];

    const union = `${deckScope()} (${queries.join(' or ')})`;
    const candidates = noteIds(await invoke('findNotes', { query: union }), 'findNotes');
    // No candidate anywhere means every count is zero; one request is enough.
    if (candidates.length === 0) return queries.map(() => []);
    // With a single query the candidate list already is that query's answer.
    if (queries.length === 1) return [candidates];

    const filter = `nid:${candidates.join(',')}`;
    const result = await invoke('multi', {
      actions: queries.map((query) => request('findNotes', { query: `${filter} (${query})` })),
    });
    if (!Array.isArray(result) || result.length < queries.length) {
      throw new Error('AnkiConnect multi returned no results');
    }

    const batches: number[][] = [];
    for (let index = 0; index < queries.length; index++) {
      batches.push(noteIds(multiItem(result[index]), 'multi'));
    }
    return batches;
  }

  function deckScope(): string {
    return `"deck:${options.deck}"`;
  }

  return { addNote, findNotes, findNotesBatch };
}

function noteIds(value: unknown, action: string): number[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'number')) {
    throw new Error(`AnkiConnect ${action} returned no note ids`);
  }
  return value as number[];
}

/** AnkiConnect 6 wraps each `multi` result as `{result, error}`; older replies return raw results. */
function multiItem(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const item = value as { result?: unknown; error?: unknown };
  if (item.error !== undefined && item.error !== null && item.error !== '') {
    throw new Error(`AnkiConnect findNotes failed: ${String(item.error)}`);
  }
  return 'result' in item ? item.result : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
