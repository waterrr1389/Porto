/** How to answer a request for a file of `size` bytes, from its Range header. */
export type RangeDecision =
  | { status: 200 }
  | { status: 206; start: number; end: number }
  | { status: 416 };

/**
 * Interprets a single-range `bytes=` header; `end` is inclusive. A missing,
 * malformed or multi-range header is answered with the whole file, as RFC 9110
 * allows. Safari probes with `bytes=0-1` before playing, so small ranges must
 * be honoured exactly.
 */
export function decideRange(header: string | undefined, size: number): RangeDecision {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match) return { status: 200 };
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return { status: 200 };
  let start: number;
  let end: number;
  if (first === '') {
    // Suffix range: the last N bytes.
    const length = Number(last);
    if (length === 0) return { status: 416 };
    start = Math.max(size - length, 0);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  }
  if (start >= size || start > end) return { status: 416 };
  return { status: 206, start, end };
}
