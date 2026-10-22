// The HTTP contract between client and server. Each endpoint lists its path,
// query or body, and response type; errors are `ApiError` with a 4xx/5xx status.

export interface ApiError {
  error: string;
}

/** GET /api/library — every series, and the episode to offer for resuming. */
export interface LibraryResponse {
  series: SeriesSummary[];
  /** Most recently watched episode that is not finished, if any. */
  resume: { episodeId: string; seriesTitle: string; episodeTitle: string; position: number } | null;
}

export interface SeriesSummary {
  id: string;
  title: string;
  episodes: EpisodeSummary[];
}

export interface EpisodeSummary {
  id: string;
  title: string;
  /** Subtitle languages available as sidecar files, e.g. ["ja", "zh"]. */
  languages: string[];
  /** Saved position in seconds, 0 when never played. */
  position: number;
  /** Duration in seconds as last reported by the player, 0 when unknown. */
  duration: number;
}

/**
 * GET /api/episodes/<id> — everything the player needs. Requesting it starts
 * preparing this episode's video and the next one's.
 */
export interface EpisodeResponse {
  id: string;
  title: string;
  seriesTitle: string;
  /** URL of the playable MP4 (GET with byte ranges). */
  video: string;
  /** The Japanese and Chinese subtitle files, when present. */
  subtitles: { ja?: SubtitleTrack; zh?: SubtitleTrack };
  /** Saved position in seconds. */
  position: number;
  nextEpisodeId: string | null;
}

/** A subtitle file; its URL carries no extension, so the format is explicit. */
export interface SubtitleTrack {
  url: string;
  format: 'ass' | 'srt';
}

/** PUT /api/episodes/<id>/progress — answered with 204. */
export interface ProgressRequest {
  position: number;
  duration: number;
}

/**
 * POST /api/cards — creates an Anki note for a looked-up word in the cue it
 * was found in. Definition HTML is rendered by the client.
 */
export interface CardRequest {
  episodeId: string;
  term: string;
  reading: string;
  definitions: { dictionary: string; html: string }[];
  frequencies: { dictionary: string; value: string }[];
  pitches: number[];
  cue: { start: number; end: number; text: string };
  /** Code-unit range of the looked-up text inside `cue.text`. */
  highlight: { start: number; end: number };
  /** Playback time of the lookup, in seconds; the screenshot is taken there. */
  time: number;
}

export interface CardResponse {
  noteId: number;
  /** Notes with the same expression that already existed in the deck. */
  duplicates: number;
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
