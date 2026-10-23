// Furigana alignment for a headword: kanji runs get the part of the reading
// that precedes the next kana run, so a term like 食べる can show た over 食.
// When the kana anchors do not line up, the caller falls back to one ruby over
// the whole term.

export interface RubyPart {
  text: string;
  ruby?: string;
}

const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u3006\u3007]/;
const KANA = /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/;

export function hasKanji(text: string): boolean {
  for (const char of text) {
    if (KANJI.test(char)) return true;
  }
  return false;
}

export function furiganaParts(term: string, reading: string): RubyPart[] | null {
  if (reading === '' || reading === term || !hasKanji(term)) return null;

  const parts: RubyPart[] = [];
  let at = 0;
  let readAt = 0;

  while (at < term.length) {
    const char = term[at] as string;
    if (isKana(char)) {
      const run = takeRun(term, at, isKana);
      if (!reading.startsWith(run, readAt)) return null;
      parts.push({ text: run });
      at += run.length;
      readAt += run.length;
      continue;
    }
    if (!isKanji(char)) {
      // Latin letters and punctuation separate kanji runs but still have to
      // match the reading exactly.
      const run = takeRun(term, at, (candidate) => !isKana(candidate) && !isKanji(candidate));
      if (!reading.startsWith(run, readAt)) return null;
      parts.push({ text: run });
      at += run.length;
      readAt += run.length;
      continue;
    }

    const run = takeRun(term, at, isKanji);
    at += run.length;
    const anchor = at < term.length && isKana(term[at] as string) ? takeRun(term, at, isKana) : '';
    if (anchor === '') {
      parts.push({ text: run, ruby: reading.slice(readAt) });
      readAt = reading.length;
      continue;
    }
    const boundary = reading.indexOf(anchor, readAt);
    if (boundary < 0) return null;
    parts.push({ text: run, ruby: reading.slice(readAt, boundary) });
    readAt = boundary;
  }

  return readAt === reading.length ? parts : null;
}

function isKanji(char: string): boolean {
  return KANJI.test(char);
}

function isKana(char: string): boolean {
  return KANA.test(char);
}

function takeRun(text: string, start: number, predicate: (char: string) => boolean): string {
  let end = start;
  while (end < text.length && predicate(text[end] as string)) end += 1;
  return text.slice(start, end);
}
