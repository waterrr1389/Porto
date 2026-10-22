// Turns a tap on a subtitle character into a dictionary lookup, and turns the
// dictionary's match length back into the range to highlight.
//
// Offsets are UTF-16 code-unit indexes into the cue text, which is what the
// views get from iterating the text and what `String#slice` expects. A tapped
// character may be a surrogate pair, so ranges never cut one in half.

/**
 * True if the character can start a Japanese lookup (hiragana, katakana incl.
 * halfwidth and prolonged sound mark, CJK ideographs incl. extension A and
 * compatibility, iteration marks 々〆〇).
 */
export function isLookupStart(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return false;
  for (const [from, to] of LOOKUP_START_RANGES) {
    if (codePoint >= from && codePoint <= to) return true;
  }
  return false;
}

/**
 * Text to look up when the user taps the character at `offset` of `text`:
 * from offset up to `maxLength` code units (default 32), stopping before the
 * first '\n'. Never splits a surrogate pair at the end. Returns null when
 * offset is out of range or the tapped character is not a lookup start.
 */
export function scanText(text: string, offset: number, maxLength = 32): string | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= text.length) return null;
  const first = text.codePointAt(offset);
  if (first === undefined || !isLookupStart(String.fromCodePoint(first))) return null;

  const limit = offset + maxLength;
  let end = offset;
  while (end < text.length && end < limit) {
    if (text[end] === '\n') break;
    const codePoint = text.codePointAt(end) as number;
    const width = codePoint > 0xffff ? 2 : 1;
    // Stop rather than return half of a surrogate pair.
    if (end + width > limit) break;
    end += width;
  }
  return text.slice(offset, end);
}

/**
 * Range to highlight after the dictionary matched `matchLength` code units
 * starting at `offset`: [start, end), clipped to the end of the tapped line;
 * at least one character when matchLength <= 0.
 */
export function highlightRange(
  text: string,
  offset: number,
  matchLength: number,
): { start: number; end: number } {
  const start = Math.min(Math.max(offset, 0), text.length);
  const newline = text.indexOf('\n', start);
  const lineEnd = newline < 0 ? text.length : newline;

  const minimum = start < text.length && (text.codePointAt(start) as number) > 0xffff ? 2 : 1;
  const wanted = matchLength > 0 ? matchLength : minimum;
  const end = Math.min(start + wanted, lineEnd);
  return { start, end };
}

const LOOKUP_START_RANGES: readonly (readonly [number, number])[] = [
  // 々 〆 〇
  [0x3005, 0x3007],
  // Hiragana.
  [0x3040, 0x309f],
  // Katakana, including the prolonged sound mark.
  [0x30a0, 0x30ff],
  // CJK Unified Ideographs Extension A.
  [0x3400, 0x4dbf],
  // CJK Unified Ideographs.
  [0x4e00, 0x9fff],
  // CJK Compatibility Ideographs.
  [0xf900, 0xfaff],
  // Halfwidth katakana, including the halfwidth prolonged sound mark.
  [0xff66, 0xff9d],
];
