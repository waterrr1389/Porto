// Builds the fields of a "Lapis" Anki note for a mined sentence, plus the
// screenshot and audio clip that have to be captured for it. Definition HTML
// is rendered by the browser (it owns Yomitan's renderer); this module only
// embeds it and formats the remaining plain-text fields.

export interface CardInput {
  term: string;
  reading: string;
  /** Definition HTML rendered by the client, per dictionary in priority order. */
  definitions: { dictionary: string; html: string }[];
  frequencies: { dictionary: string; value: string }[];
  pitches: number[];
  /** The subtitle cue the word was looked up in. */
  cue: { start: number; end: number; text: string };
  /** Code-unit range of the looked-up word inside cue.text, to bold. */
  highlight: { start: number; end: number };
  /** Playback time when the lookup happened (the paused frame). */
  time: number;
  seriesTitle: string;
  episodeNumber: number | null;
  episodeTitle: string;
}

export interface MediaPlan {
  screenshot: { time: number; fileName: string };
  audio: { start: number; end: number; fileName: string };
}

export interface CardPlan {
  fields: Record<string, string>;
  media: MediaPlan;
  /** Anki search that finds the same expression; the caller scopes it to its deck. */
  duplicateQuery: string;
}

/** Builds the note fields and media plan for one sentence. */
export function lapisCard(input: CardInput, options: { audioPaddingS?: number } = {}): CardPlan {
  const padding = options.audioPaddingS ?? 0.25;
  const prefix = seriesPrefix(input.seriesTitle);
  const screenshotFile = `${prefix}_${formatTime(input.time)}.jpg`;
  const audioStart = Math.max(0, input.cue.start - padding);
  const audioEnd = input.cue.end + padding;
  const audioFile = `${prefix}_${formatTime(audioStart)}_${formatTime(audioEnd)}.mp3`;

  const fields: Record<string, string> = {
    Expression: input.term,
    ExpressionFurigana: furigana(input.term, input.reading),
    ExpressionReading: input.reading || input.term,
    ExpressionAudio: '',
    SelectionText: '',
    MainDefinition: definitionList(input.definitions.slice(0, 1)),
    DefinitionPicture: '',
    Sentence: sentenceWithHighlight(input.cue.text, input.highlight),
    SentenceFurigana: '',
    SentenceAudio: `[sound:${audioFile}]`,
    Picture: `<img alt="snapshot" src="${screenshotFile}">`,
    Glossary: definitionList(input.definitions),
    Hint: '',
    IsWordAndSentenceCard: 'X',
    IsClickCard: '',
    IsSentenceCard: '',
    IsAudioCard: '',
    PitchPosition: pitchPositions(input.pitches),
    PitchCategories: pitchCategory(input.pitches[0], input.reading),
    Frequency: frequencyList(input.frequencies),
    FreqSort: frequencySort(input.frequencies),
    MiscInfo: miscInfo(input, formatTime(input.time)),
  };

  return {
    fields,
    media: {
      screenshot: { time: input.time, fileName: screenshotFile },
      audio: { start: audioStart, end: audioEnd, fileName: audioFile },
    },
    duplicateQuery: `Expression:${quotedTerm(input.term)}`,
  };
}

/** File-name stem for an episode: lower-case ASCII letters and digits only. */
function seriesPrefix(seriesTitle: string): string {
  return seriesTitle.toLowerCase().replace(/[^a-z0-9]/g, '') || 'episode';
}

/** `09m59s920ms`; minutes are total minutes, so long videos do not wrap. */
function formatTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(totalMs / 60_000);
  const secondsPart = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${pad(minutes, 2)}m${pad(secondsPart, 2)}s${pad(milliseconds, 3)}ms`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function furigana(term: string, reading: string): string {
  return reading !== '' && reading !== term ? `${term}[${reading}]` : term;
}

/** One `<li>` per dictionary, keeping the HTML the client rendered. */
function definitionList(definitions: CardInput['definitions']): string {
  if (definitions.length === 0) return '';
  const items = definitions
    .map(
      (definition) =>
        `<li data-dictionary="${escapeAttribute(definition.dictionary)}">` +
        `<i>(${escapeText(definition.dictionary)})</i> <span>${definition.html}</span></li>`,
    )
    .join('');
  return `<div style="text-align: left;" class="yomitan-glossary"><ol>${items}</ol></div>`;
}

/**
 * Cue text without line breaks, with the looked-up word in <b>. Newlines are
 * dropped, so the highlight offsets are mapped onto the joined text before
 * the pieces are escaped.
 */
function sentenceWithHighlight(text: string, highlight: { start: number; end: number }): string {
  const start = Math.min(Math.max(highlight.start, 0), text.length);
  const end = Math.min(Math.max(highlight.end, start), text.length);
  const joined = text.replace(/\n/g, '');
  const before = (index: number): number => {
    let count = 0;
    for (let i = 0; i < index; i++) if (text[i] !== '\n') count += 1;
    return count;
  };

  const boldStart = before(start);
  const boldEnd = before(end);
  if (boldEnd <= boldStart) return escapeText(joined);
  return (
    escapeText(joined.slice(0, boldStart)) +
    `<b>${escapeText(joined.slice(boldStart, boldEnd))}</b>` +
    escapeText(joined.slice(boldEnd))
  );
}

/** One pitch accent indicator per accent position; no separator between them. */
function pitchPositions(pitches: number[]): string {
  return pitches
    .map((pitch) => `<span style="display:inline;"><span>[</span><span>${pitch}</span><span>]</span></span>`)
    .join('');
}

/**
 * Accent class of the first pitch, using the reading's mora count: pitch 0 is
 * heiban, 1 is atamadaka, the last mora is odaka and anything else nakadaka.
 */
function pitchCategory(pitch: number | undefined, reading: string): string {
  if (pitch === undefined) return '';
  if (pitch === 0) return 'heiban';
  if (pitch === 1) return 'atamadaka';
  return pitch === moraCount(reading) ? 'odaka' : 'nakadaka';
}

const SMALL_KANA = new Set([
  0x3041, 0x3043, 0x3045, 0x3047, 0x3049, // ぁ ぃ ぅ ぇ ぉ
  0x3083, 0x3085, 0x3087, // ゃ ゅ ょ
  0x30a1, 0x30a3, 0x30a5, 0x30a7, 0x30a9, // ァ ィ ゥ ェ ォ
  0x30e3, 0x30e5, 0x30e7, // ャ ュ ョ
]);

/** Kana letters minus the small ones; the prolonged mark and っ/ッ count. */
function moraCount(reading: string): number {
  let count = 0;
  for (const char of reading) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || SMALL_KANA.has(codePoint)) continue;
    if (isKana(codePoint)) count += 1;
  }
  return count;
}

function isKana(codePoint: number): boolean {
  return (
    (codePoint >= 0x3041 && codePoint <= 0x3096) ||
    (codePoint >= 0x30a1 && codePoint <= 0x30fa) ||
    codePoint === 0x30fc
  );
}

function frequencyList(frequencies: CardInput['frequencies']): string {
  if (frequencies.length === 0) return '';
  const items = frequencies
    .map((frequency) => `<li>${escapeText(frequency.dictionary)}: ${escapeText(frequency.value)}</li>`)
    .join('');
  return `<ul style="text-align: left;">${items}</ul>`;
}

/** Smallest leading integer among the values, used as a sort key; '' if none. */
function frequencySort(frequencies: CardInput['frequencies']): string {
  const values: number[] = [];
  for (const frequency of frequencies) {
    const match = /^\s*(\d+)/.exec(frequency.value);
    if (match?.[1] !== undefined) values.push(Number(match[1]));
  }
  return values.length === 0 ? '' : String(Math.min(...values));
}

function miscInfo(input: CardInput, formattedTime: string): string {
  const series = input.seriesTitle.replace(/ /g, '_');
  const episode =
    input.episodeNumber === null ? input.episodeTitle : `EP${String(input.episodeNumber).padStart(2, '0')}`;
  return [series, episode, `(${formattedTime})`].filter((part) => part !== '').join(' ');
}

/** Anki search terms are wrapped in double quotes; specials are backslash-escaped. */
function quotedTerm(term: string): string {
  return `"${term.replace(/[\\"*_]/g, (char) => `\\${char}`)}"`;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
