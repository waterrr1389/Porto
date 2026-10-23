// Parses ASS/SSA and SRT sidecar subtitles into cues the player can show, and
// answers which cues are on screen at a playback time.
//
// Parsers return cues sorted by start with ids 0..n-1. Events that share a
// start and an end time are one cue: their text is stacked top to bottom, so a
// conversation in two screen positions stays one readable block instead of
// two cues that the views would have to align themselves.

/** One subtitle event. Times in seconds. `text` uses '\n' for line breaks. */
export interface Cue {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface AssOptions {
  /** Keep only these styles (exact, case-sensitive). Omitted: keep every style except ruby styles. */
  styles?: readonly string[];
}

interface AssFields {
  count: number;
  start: number;
  end: number;
  style: number;
  text: number;
}

/** Field order ASS defines when the `[Events]` section has no `Format:` line. */
const DEFAULT_ASS_FIELDS: AssFields = { count: 10, start: 1, end: 2, style: 3, text: 9 };

/** Ruby styles hold furigana, not dialogue, so they are not shown on their own. */
const RUBY_STYLE = /rubi|ruby/i;

interface CuePiece {
  text: string;
  /** Vertical position from `\pos`/`\move`; +Infinity when the piece has none. */
  y: number;
  /** Position in the source file, used to break ties. */
  order: number;
}

interface CueGroup {
  start: number;
  end: number;
  pieces: CuePiece[];
}

/**
 * Parses ASS/SSA events. Ruby styles and drawing events are skipped; events
 * that share a start and an end are merged into one cue.
 */
export function parseAss(source: string, options: AssOptions = {}): Cue[] {
  const lines = normalizeSource(source).split('\n');
  const styles = options.styles;
  const groups = new Map<string, CueGroup>();
  let fields = DEFAULT_ASS_FIELDS;
  let inEvents = false;
  let order = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inEvents = trimmed.slice(1, -1).trim().toLowerCase() === 'events';
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(trimmed)) {
      fields = locateAssFields(trimmed);
      continue;
    }
    if (!/^Dialogue:/i.test(trimmed)) continue;

    order += 1;
    const values = splitAssValues(trimmed.slice(trimmed.indexOf(':') + 1), fields.count);
    const start = parseAssTime(values[fields.start] ?? '');
    const end = parseAssTime(values[fields.end] ?? '');
    if (start === null || end === null) continue;

    const style = (values[fields.style] ?? '').trim();
    if (styles === undefined ? RUBY_STYLE.test(style) : !styles.includes(style)) continue;

    const raw = values[fields.text] ?? '';
    if (isDrawing(raw)) continue;
    const text = cleanAssText(raw);
    if (text === '') continue;

    addPiece(groups, start, end, { text, y: positionY(raw), order });
  }

  return toCues(groups);
}

/**
 * Parses SRT blocks. The numeric index line is optional, as are the usual
 * `<i>`/`<font>` tags around the text. ASS override blocks such as `{\an8}`,
 * which some releases put into SRT for positioning, are dropped: the player
 * places every line itself.
 */
export function parseSrt(source: string): Cue[] {
  const lines = normalizeSource(source).split('\n');
  const groups = new Map<string, CueGroup>();
  let block: string[] = [];
  let order = 0;

  const flush = (): void => {
    if (block.length === 0) return;
    const timingIndex = block.findIndex((line) => line.includes('-->'));
    if (timingIndex >= 0) {
      const timing = parseSrtTiming(block[timingIndex] ?? '');
      if (timing !== null) {
        const text = block
          .slice(timingIndex + 1)
          .map((line) => line.replace(/<[^>]*>|\{\\[^}]*\}/g, '').trim())
          .filter((line) => line.length > 0)
          .join('\n');
        if (text !== '') {
          order += 1;
          addPiece(groups, timing.start, timing.end, { text, y: Number.POSITIVE_INFINITY, order });
        }
      }
    }
    block = [];
  };

  for (const line of lines) {
    if (line.trim() === '') flush();
    else block.push(line);
  }
  flush();

  return toCues(groups);
}

export type SubtitleFormat = 'ass' | 'srt';

/** The format of a subtitle file from its name (.ass/.ssa or .srt), or null. */
export function subtitleFormat(fileName: string): SubtitleFormat | null {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'ass' || extension === 'ssa') return 'ass';
  if (extension === 'srt') return 'srt';
  return null;
}

/** Parses subtitles of a known format; `options` applies to ASS only. */
export function parseSubtitles(format: SubtitleFormat, source: string, options?: AssOptions): Cue[] {
  return format === 'ass' ? parseAss(source, options) : parseSrt(source);
}

/** Cues with start <= time < end, in cue order. `cues` must be sorted by start (parsers guarantee this). */
export function activeCues(cues: readonly Cue[], time: number): Cue[] {
  // Cues may overlap, so every cue that started at or before `time` has to be
  // checked; binary search skips the ones that start later.
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((cues[middle] as Cue).start <= time) low = middle + 1;
    else high = middle;
  }

  const active: Cue[] = [];
  for (let index = 0; index < low; index += 1) {
    const cue = cues[index] as Cue;
    if (time < cue.end) active.push(cue);
  }
  return active;
}

function normalizeSource(source: string): string {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return withoutBom.replace(/\r\n?/g, '\n');
}

/**
 * Finds the fields the events use. ASS requires Text to be the last field
 * because it may contain commas; anything after the last separator belongs to
 * the text.
 */
function locateAssFields(formatLine: string): AssFields {
  const names = formatLine
    .slice(formatLine.indexOf(':') + 1)
    .split(',')
    .map((name) => name.trim());
  const start = names.indexOf('Start');
  const end = names.indexOf('End');
  const style = names.indexOf('Style');
  const text = names.indexOf('Text');
  if (start < 0 || end < 0 || style < 0 || text < 0) return DEFAULT_ASS_FIELDS;
  return { count: names.length, start, end, style, text };
}

function splitAssValues(body: string, count: number): string[] {
  const parts = body.split(',');
  if (parts.length <= count) return parts;
  const values = parts.slice(0, count - 1);
  values.push(parts.slice(count - 1).join(','));
  return values;
}

/** H:MM:SS.cc, with a lenient fraction so millisecond ASS files also parse. */
function parseAssTime(value: string): number | null {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (match === null) return null;
  const fraction = match[4] === undefined ? 0 : Number(`0.${match[4]}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction;
}

function parseSrtTiming(value: string): { start: number; end: number } | null {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(
    value.trim(),
  );
  if (match === null) return null;
  const time = (hour: string, minute: string, second: string, fraction: string): number =>
    Number(hour) * 3600 + Number(minute) * 60 + Number(second) + Number(fraction.padEnd(3, '0')) / 1000;
  return {
    start: time(match[1] ?? '0', match[2] ?? '0', match[3] ?? '0', match[4] ?? '0'),
    end: time(match[5] ?? '0', match[6] ?? '0', match[7] ?? '0', match[8] ?? '0'),
  };
}

/** `\p1` enters drawing mode; `\p0` leaves it again. */
function isDrawing(raw: string): boolean {
  for (const block of raw.matchAll(/\{[^}]*\}/g)) {
    for (const draw of block[0].matchAll(/\\p(\d+)/g)) {
      if (Number(draw[1]) !== 0) return true;
    }
  }
  return false;
}

/**
 * Removes override blocks and ASS escapes, then trims each line and drops
 * empty ones, so the views never render blank rows.
 */
function cleanAssText(raw: string): string {
  return raw
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** `\pos(x,y)` and `\move(x1,y1,...)` both carry the dialogue line's y as their second argument. */
function positionY(raw: string): number {
  for (const match of raw.matchAll(/\\(?:pos|move)\(([^)]*)\)/g)) {
    const args = (match[1] ?? '').split(',');
    const y = Number((args[1] ?? '').trim());
    if (Number.isFinite(y)) return y;
  }
  return Number.POSITIVE_INFINITY;
}

function addPiece(groups: Map<string, CueGroup>, start: number, end: number, piece: CuePiece): void {
  const key = `${start}:${end}`;
  const existing = groups.get(key);
  if (existing === undefined) groups.set(key, { start, end, pieces: [piece] });
  else existing.pieces.push(piece);
}

/**
 * Stacks merged pieces from the top of the frame down and assigns ids in
 * playback order. Pieces without a position go last in file order.
 */
function toCues(groups: Map<string, CueGroup>): Cue[] {
  const cues: Cue[] = [];
  for (const group of groups.values()) {
    const pieces = group.pieces.toSorted((a, b) => a.y - b.y || a.order - b.order);
    const text = pieces.map((piece) => piece.text).join('\n');
    if (text === '') continue;
    cues.push({ id: 0, start: group.start, end: group.end, text });
  }
  // Sort is stable, so cues that start together keep the order they were read in.
  cues.sort((a, b) => a.start - b.start);
  return cues.map((cue, id) => ({ ...cue, id }));
}
