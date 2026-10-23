// Picks which subtitle to show per language slot. Sidecar files and embedded
// text streams are both candidates; ids are per episode, while a key built from
// what identifies the file or stream lets a series remember a choice across
// episodes whose ids differ.
import type { SidecarSubtitle } from './library.ts';

export type SubtitleSlot = 'ja' | 'zh';
export type SubtitleFormat = 'ass' | 'srt';
export type SubtitleSource = 'sidecar' | 'embedded';
export type ChineseVariant = 'simplified' | 'traditional';

/** A text subtitle stream inside the source video. */
export interface EmbeddedSubtitle {
  /** Absolute stream index in the source. */
  index: number;
  /** ffprobe codec name; only ass, ssa and subrip reach this list. */
  codec: string;
  /** Raw container language tag, e.g. 'jpn', 'chi', or '' when untagged. */
  language: string;
  /** Stream title, '' when untitled. */
  title: string;
}

export interface SubtitleOption {
  /** Unique within the episode: 'f<n>' for a sidecar, 's<index>' for a stream. */
  id: string;
  slot: SubtitleSlot;
  /** What the picker shows; never empty. */
  label: string;
  format: SubtitleFormat;
  source: SubtitleSource;
  /** Sidecar path relative to the media root; null for embedded streams. */
  path: string | null;
  /** Absolute stream index in the source; null for sidecars. */
  streamIndex: number | null;
  /** Recognised Chinese variant; null for Japanese and unknown variants. */
  chinese: ChineseVariant | null;
  /** Stable identity across the episodes of a series. */
  key: SubtitleKey;
}

export type SubtitleKey =
  | { source: 'sidecar'; suffix: string }
  | { source: 'embedded'; title: string; language: string; codec: string };

export type SubtitleChoice = SubtitleKey | 'off';
export type SavedSubtitleChoices = Partial<Record<SubtitleSlot, SubtitleChoice>>;

export interface SubtitleSelection {
  /** Selected option id per slot, null when the slot is off or has no option. */
  selected: Record<SubtitleSlot, string | null>;
  /** Slots whose saved choice did not match this episode, so the default was used. */
  fallback: SubtitleSlot[];
}

const SLOTS: readonly SubtitleSlot[] = ['ja', 'zh'];

/**
 * Candidates in display order: sidecars in file order, then embedded streams in
 * stream order. Only Japanese and Chinese candidates are included.
 */
export function buildSubtitleOptions(
  sidecars: readonly SidecarSubtitle[],
  embedded: readonly EmbeddedSubtitle[],
): SubtitleOption[] {
  const options: SubtitleOption[] = [];
  let sidecarNumber = 0;
  for (const sidecar of sidecars) {
    const slot = sidecarSlot(sidecar.language);
    if (slot === null) continue;
    options.push({
      id: `f${sidecarNumber}`,
      slot,
      label: sidecar.suffix,
      format: sidecarFormat(sidecar.suffix),
      source: 'sidecar',
      path: sidecar.path,
      streamIndex: null,
      chinese: slot === 'zh' ? sidecarChinese(sidecar.language) : null,
      key: { source: 'sidecar', suffix: sidecar.suffix },
    });
    sidecarNumber += 1;
  }

  for (const stream of embedded) {
    const slot = embeddedSlot(stream);
    if (slot === null) continue;
    const codec = stream.codec.toLowerCase();
    options.push({
      id: `s${stream.index}`,
      slot,
      label: stream.title !== '' ? stream.title : `${stream.language || 'und'} ${codec}`,
      format: codec === 'subrip' ? 'srt' : 'ass',
      source: 'embedded',
      path: null,
      streamIndex: stream.index,
      chinese: slot === 'zh' ? (traditionalChinese(stream) ? 'traditional' : 'simplified') : null,
      key: { source: 'embedded', title: stream.title, language: stream.language.toLowerCase(), codec },
    });
  }

  return options;
}

/**
 * Applies saved choices and fills the rest with defaults. A saved key that
 * matches no option of this episode falls back to the default and marks its
 * slot, so the caller can tell the user the choice did not carry over.
 */
export function selectSubtitles(
  options: readonly SubtitleOption[],
  saved: SavedSubtitleChoices = {},
): SubtitleSelection {
  const selected: Record<SubtitleSlot, string | null> = { ja: null, zh: null };
  const fallback: SubtitleSlot[] = [];

  for (const slot of SLOTS) {
    const choice = saved[slot];
    if (choice === 'off') continue;
    if (choice !== undefined) {
      const match = options.find((option) => option.slot === slot && sameKey(option.key, choice));
      if (match) {
        selected[slot] = match.id;
        continue;
      }
      fallback.push(slot);
    }
    selected[slot] = slot === 'ja' ? firstJapanese(options) : defaultChinese(options);
  }

  return { selected, fallback };
}

/** 'ja', 'zh' or 'zh-Hant' for an embedded stream, null when it is neither Japanese nor Chinese. */
export function embeddedSubtitleLanguage(stream: EmbeddedSubtitle): string | null {
  const slot = embeddedSlot(stream);
  if (slot === 'ja') return 'ja';
  if (slot === 'zh') return traditionalChinese(stream) ? 'zh-Hant' : 'zh';
  return null;
}

function firstJapanese(options: readonly SubtitleOption[]): string | null {
  return options.find((option) => option.slot === 'ja')?.id ?? null;
}

/** Simplified sidecar, traditional sidecar, simplified stream, traditional stream. */
function defaultChinese(options: readonly SubtitleOption[]): string | null {
  const chinese = options.filter((option) => option.slot === 'zh');
  for (const [source, variant] of [
    ['sidecar', 'simplified'],
    ['sidecar', 'traditional'],
    ['embedded', 'simplified'],
    ['embedded', 'traditional'],
  ] as const) {
    const match = chinese.find((option) => option.source === source && option.chinese === variant);
    if (match) return match.id;
  }
  return null;
}

function sameKey(a: SubtitleKey, b: SubtitleKey): boolean {
  if (a.source === 'sidecar' && b.source === 'sidecar') return a.suffix === b.suffix;
  if (a.source === 'embedded' && b.source === 'embedded') {
    return a.title === b.title && a.language === b.language && a.codec === b.codec;
  }
  return false;
}

function sidecarSlot(language: string): SubtitleSlot | null {
  if (language === 'ja') return 'ja';
  if (language === 'zh' || language === 'zh-Hant') return 'zh';
  return null;
}

function sidecarFormat(suffix: string): SubtitleFormat {
  return suffix.toLowerCase().endsWith('.srt') ? 'srt' : 'ass';
}

function sidecarChinese(language: string): ChineseVariant {
  return language === 'zh-Hant' ? 'traditional' : 'simplified';
}

function embeddedSlot(stream: EmbeddedSubtitle): SubtitleSlot | null {
  const language = stream.language.trim();
  if (/^(jpn|ja)([-_]|$)/i.test(language)) return 'ja';
  if (/^(chi|zho|zh)([-_]|$)/i.test(language)) return 'zh';
  return null;
}

/** Traditional is signalled by the tag or title, since Chinese tags alone do not say. */
function traditionalChinese(stream: EmbeddedSubtitle): boolean {
  return /traditional|hant|cht|繁|(^|[^a-z])(tw|hk)([^a-z]|$)/i.test(`${stream.language} ${stream.title}`);
}
