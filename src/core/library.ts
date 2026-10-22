// Turns a media root's file listing into series and episodes with their
// sidecar subtitles. Ids depend only on the root's name and relative paths, so
// they survive restarts and rescans; renaming a file changes its id.

export interface LibraryEpisode {
  id: string;
  /** Episode number parsed from the file name, if any. */
  number: number | null;
  /** Display title: "05" style number when known, otherwise the file stem. */
  title: string;
  /** Path of the video relative to the media root. */
  video: string;
  /** Subtitle paths relative to the media root, by language (see `subtitleLanguage`). */
  subtitles: Record<string, string>;
}

export interface LibrarySeries {
  id: string;
  title: string;
  /** Directory relative to the media root; '' for files directly in the root. */
  directory: string;
  episodes: LibraryEpisode[];
}

const VIDEO = /\.(mkv|mp4)$/i;
const SUBTITLE = /\.(ass|ssa|srt)$/i;

/**
 * Groups the videos of one media root by directory into series, sorted by
 * title; episodes are sorted by number, then by name. `files` are paths
 * relative to the root using '/' separators. Hidden paths are ignored.
 */
export function buildLibrary(rootName: string, files: readonly string[]): LibrarySeries[] {
  const visible = files.filter((file) => !file.split('/').some((part) => part.startsWith('.')));
  const subtitlesByDirectory = new Map<string, string[]>();
  for (const file of visible) {
    if (!SUBTITLE.test(file)) continue;
    const dir = directoryOf(file);
    subtitlesByDirectory.set(dir, [...(subtitlesByDirectory.get(dir) ?? []), file]);
  }

  const seriesByDirectory = new Map<string, LibrarySeries>();
  for (const file of visible) {
    if (!VIDEO.test(file)) continue;
    const dir = directoryOf(file);
    // A video directly in the root is a series of its own (usually a film).
    const seriesKey = dir === '' ? file : `${dir}/`;
    let series = seriesByDirectory.get(seriesKey);
    if (!series) {
      series = { id: stableId(`${rootName}\0${seriesKey}`), title: seriesTitle(dir, file), directory: dir, episodes: [] };
      seriesByDirectory.set(seriesKey, series);
    }
    const videoStem = stem(baseName(file));
    const number = episodeNumber(videoStem);
    const subtitles: Record<string, string> = {};
    for (const subtitle of subtitlesByDirectory.get(dir) ?? []) {
      const name = baseName(subtitle);
      if (!name.startsWith(videoStem)) continue;
      const tag = name.slice(videoStem.length).replace(SUBTITLE, '');
      if (tag !== '' && !tag.startsWith('.')) continue;
      const language = subtitleLanguage(tag.slice(1));
      subtitles[language] ??= subtitle;
    }
    series.episodes.push({
      id: stableId(`${rootName}\0${file}`),
      number,
      title: number === null ? videoStem : String(number).padStart(2, '0'),
      video: file,
      subtitles,
    });
  }

  const series = [...seriesByDirectory.values()];
  for (const s of series) {
    s.episodes.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || naturalCompare(a.video, b.video));
  }
  return series.sort((a, b) => naturalCompare(a.title, b.title) || naturalCompare(a.directory, b.directory));
}

/** The subtitle shown for each player track: Japanese, and Simplified Chinese before Traditional. */
export function playerTracks(subtitles: Readonly<Record<string, string>>): { ja?: string; zh?: string } {
  const tracks: { ja?: string; zh?: string } = {};
  const ja = subtitles.ja;
  const zh = subtitles.zh ?? subtitles['zh-Hant'];
  if (ja !== undefined) tracks.ja = ja;
  if (zh !== undefined) tracks.zh = zh;
  return tracks;
}

/** An episode counts as finished once fewer than this many seconds remain. */
const FINISHED_REMAINING_S = 90;

/**
 * The episode to offer for resuming: the most recently updated one that is
 * not finished, or else the episode after the most recently finished one.
 * `progress` maps episode ids to positions; ids not in `series` are ignored.
 */
export function resumeEpisode(
  series: readonly LibrarySeries[],
  progress: ReadonlyMap<string, { position: number; duration: number; updatedAt: number }>,
): { series: LibrarySeries; episode: LibraryEpisode; position: number } | null {
  type Candidate = { series: LibrarySeries; index: number; updatedAt: number; finished: boolean; position: number };
  let latest: Candidate | null = null;
  for (const s of series) {
    for (const [index, episode] of s.episodes.entries()) {
      const p = progress.get(episode.id);
      if (!p || (latest !== null && latest.updatedAt >= p.updatedAt)) continue;
      const finished = p.duration > 0 && p.duration - p.position < FINISHED_REMAINING_S;
      latest = { series: s, index, updatedAt: p.updatedAt, finished, position: p.position };
    }
  }
  if (latest === null) return null;
  const { series: s, index, finished, position } = latest;
  if (!finished) return { series: s, episode: s.episodes[index] as LibraryEpisode, position };
  const next = s.episodes[index + 1];
  return next ? { series: s, episode: next, position: 0 } : null;
}

/**
 * Normalises a sidecar language tag: 'ja' (ja, jp, jpn, jap), 'zh' for
 * Simplified Chinese (sc, chs, zh, zh-Hans, zh-CN, gb, 简…), 'zh-Hant' for
 * Traditional (tc, cht, zh-Hant, zh-TW, big5, 繁…), 'en' (en, eng); other tags
 * are returned lower-cased, and a missing tag is 'und'.
 */
export function subtitleLanguage(tag: string): string {
  const t = tag.trim().toLowerCase();
  if (t === '') return 'und';
  if (/^(ja|jp|jpn|jap|japanese)$/.test(t)) return 'ja';
  if (/^(tc|cht|big5|zh-hant|zh-tw|zh-hk|tw)$/.test(t) || t.startsWith('繁')) return 'zh-Hant';
  if (/^(sc|chs|gb|zh|zh-hans|zh-cn|chi|cn)$/.test(t) || t.startsWith('简')) return 'zh';
  if (/^(en|eng|english)$/.test(t)) return 'en';
  return t;
}

/**
 * Episode number from a file stem: "[05]", " - 05", "S01E05", "1x05", "E05", or a
 * leading "05." / "05 ". Returns null when none is found.
 */
export function episodeNumber(fileStem: string): number | null {
  const patterns = [/\[(\d{1,3}(?:\.\d)?)(?:v\d)?\]/, / - (\d{1,3}(?:\.\d)?)(?:v\d)?(?:\s|$)/, /S\d{1,2}E(\d{1,3})/i, /\b\d{1,2}x(\d{2})\b/, /\bE[Pp]?(\d{1,3})\b/, /^(\d{1,3})[.\s]/];
  for (const pattern of patterns) {
    const match = pattern.exec(fileStem);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
}

/** Strips bracketed release tags from a directory or file name: "[Group] Title [1080p]" -> "Title". */
export function cleanTitle(name: string): string {
  const cleaned = name
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? name : cleaned;
}

/** FNV-1a 64-bit as 16 hex digits: short, URL-safe and stable across runs. */
export function stableId(key: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Folder names that hold extras of the series in the parent folder. */
const EXTRAS_FOLDER = /^(sps?|nc|ncop|nced|extras?|bonus|specials?|menus?|pv|cm|ova|oad|oads|ovas|s\d+|season ?\d+)$/i;

function seriesTitle(dir: string, file: string): string {
  if (dir === '') return cleanTitle(stem(baseName(file)));
  const title = cleanTitle(baseName(dir));
  const parent = directoryOf(dir);
  if (parent !== '' && EXTRAS_FOLDER.test(title)) return `${cleanTitle(baseName(parent))} · ${title}`;
  return title;
}

function directoryOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '' : file.slice(0, slash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const naturalCompare = (a: string, b: string): number => collator.compare(a, b);
