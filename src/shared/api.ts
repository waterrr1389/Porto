// The HTTP contract between client and server. Each endpoint lists its path,
// query or body, and response type; errors are `ApiError` with a 4xx/5xx status.

export interface ApiError {
  error: string;
}

/** GET /api/dictionaries */
export type DictionariesResponse = DictionaryInfo[];

export interface DictionaryInfo {
  title: string;
  /** The dictionary's bundled CSS, unscoped; the client scopes it per dictionary. */
  styles: string;
}

/** GET /api/lookup?text=<text> — `text` is at most `MAX_LOOKUP_LENGTH` code units. */
export interface LookupResponse {
  /** Code units of `text` that the best entry matched, for highlighting. */
  matchLength: number;
  entries: TermEntry[];
}

export const MAX_LOOKUP_LENGTH = 64;

/** A dictionary entry reduced to what the lookup panel shows. */
export interface TermEntry {
  headwords: { term: string; reading: string }[];
  /** Deinflection steps from the looked-up text to the headword, e.g. ["causative", "-た"]. */
  inflections: string[];
  frequencies: { dictionary: string; value: string }[];
  /** Downstep positions from pitch-accent dictionaries. */
  pitches: number[];
  /** Definitions grouped by dictionary, in dictionary priority order. */
  definitions: { dictionary: string; glossary: Glossary[] }[];
}

/**
 * One definition: plain text, or Yomitan structured content that the client
 * renders with Yomitan's StructuredContentGenerator.
 */
export type Glossary = { type: 'text'; text: string } | { type: 'structured-content'; content: unknown };
