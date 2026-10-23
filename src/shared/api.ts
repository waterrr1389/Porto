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
  /**
   * GET — a JPEG still from the episode, at most 1280 px wide. Generated on
   * first request (may take a few seconds), then cached; 404 for an unknown
   * episode, 502 when the frame cannot be extracted.
   */
  thumbnail: string;
}

/**
 * GET /api/episodes/<id> — everything the player needs. Requesting it starts
 * preparing this episode's video and the next one's.
 */
export interface EpisodeResponse {
  id: string;
  title: string;
  seriesId: string;
  seriesTitle: string;
  /** URL of the playable MP4 (GET with byte ranges). */
  video: string;
  /** Every Japanese and Chinese subtitle candidate, sidecar files before embedded streams. */
  subtitleOptions: SubtitleOption[];
  /**
   * Option id shown in each slot, null for off: the series' saved choice when
   * it matches an option of this episode, otherwise the default (sidecar before
   * embedded; Simplified before Traditional Chinese).
   */
  subtitles: Record<SubtitleSlot, string | null>;
  /** Slots whose saved choice had no match in this episode, so the default was used. */
  subtitleFallback: SubtitleSlot[];
  /** Saved position in seconds. */
  position: number;
  nextEpisodeId: string | null;
}

/** A subtitle file; its URL carries no extension, so the format is explicit. */
export interface SubtitleTrack {
  url: string;
  format: 'ass' | 'srt';
}

export type SubtitleSlot = 'ja' | 'zh';

/** One subtitle the player can show; `url` serves the file (embedded streams are extracted on first request, which can take a while). */
export interface SubtitleOption extends SubtitleTrack {
  /** Unique within the episode. */
  id: string;
  slot: SubtitleSlot;
  /** What the picker shows, e.g. the stream title "Chinese (Simplified)" or the sidecar suffix ".sc.ass". */
  label: string;
  source: 'sidecar' | 'embedded';
}

/**
 * PUT /api/series/<id>/subtitles — remembers the choice for one slot for every
 * episode of the series; answered with 204. `option` is an option id of
 * `episodeId` (which must belong to the series), null for off, or 'default' to
 * forget the choice. Stored on the server, so all devices share it.
 */
export interface SubtitleChoiceRequest {
  episodeId: string;
  slot: SubtitleSlot;
  option: string | null | 'default';
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

/**
 * GET /api/cards/duplicates?term=<a>&term=<b> — how many notes in the deck
 * already have each expression; at most `MAX_DUPLICATE_TERMS` terms. 502 when
 * Anki is not reachable.
 */
export type DuplicatesResponse = Record<string, number>;

export const MAX_DUPLICATE_TERMS = 20;

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
