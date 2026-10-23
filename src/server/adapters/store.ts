// Durable user state under state/: config, playback positions, subtitle
// choices and the history of mined cards. These
// cannot be rebuilt, so writes go to a temporary file that is renamed over the
// old one, and the program never deletes them.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SavedSubtitleChoices,
  SubtitleChoice,
  SubtitleSlot,
} from '../../core/subtitle-options.ts';

export interface Config {
  /** Directories scanned for episodes; each root's name is part of episode ids. */
  mediaRoots: string[];
  /** Upper bound for remuxed episodes in cache/, in gigabytes. */
  cacheLimitGB: number;
  anki: AnkiConfig;
  /** Word audio server, or null to disable word audio. */
  localAudio: LocalAudioConfig | null;
}

export interface LocalAudioConfig {
  /** Base URL of the Local Audio Server for Yomichan add-on. */
  url: string;
}

export interface AnkiConfig {
  /** AnkiConnect endpoint on this machine. */
  url: string;
  /** AnkiConnect's apiKey setting, or null when it has none. */
  apiKey: string | null;
  deck: string;
  /** A note type with the Lapis fields. */
  model: string;
}

export interface MinedCard {
  noteId: number;
  term: string;
  episodeId: string;
  /** Playback time of the lookup, in seconds. */
  time: number;
}

export interface Progress {
  /** Seconds from the start. */
  position: number;
  /** Seconds; 0 when unknown. */
  duration: number;
  /** Milliseconds since the epoch. */
  updatedAt: number;
}

export interface Store {
  readonly config: Config;
  progress(episodeId: string): Progress | null;
  /** All positions, for finding the most recently watched episode. */
  allProgress(): ReadonlyMap<string, Progress>;
  saveProgress(episodeId: string, position: number, duration: number): void;
  /** Appends to state/cards.jsonl, one JSON object per line with the time it was mined. */
  recordCard(card: MinedCard): void;
  /** Saved subtitle choices of a series, by slot. */
  subtitleChoices(seriesId: string): SavedSubtitleChoices;
  saveSubtitleChoice(seriesId: string, slot: SubtitleSlot, choice: SubtitleChoice): void;
  /** Forgets the choice of one slot. */
  clearSubtitleChoice(seriesId: string, slot: SubtitleSlot): void;
}

/** Written on first start; the user fills in `mediaRoots` and the deck. */
export const DEFAULT_CONFIG: Config = {
  mediaRoots: [],
  cacheLimitGB: 20,
  anki: { url: 'http://127.0.0.1:8765', apiKey: null, deck: 'Mining', model: 'Lapis' },
  localAudio: { url: 'http://127.0.0.1:5050' },
};

/**
 * Opens the store in `dir`, writing the default config on first use. Missing
 * config keys take their defaults; unknown keys are kept in the file.
 */
export function openStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  const progressPath = join(dir, 'progress.json');
  const subtitlesPath = join(dir, 'subtitles.json');

  const storedConfig = readJson<Partial<Config>>(configPath);
  if (storedConfig === null) writeJsonAtomic(configPath, DEFAULT_CONFIG);
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...storedConfig,
    anki: { ...DEFAULT_CONFIG.anki, ...storedConfig?.anki },
    // A stored null disables word audio; a missing key takes the default.
    localAudio:
      storedConfig?.localAudio === undefined ? DEFAULT_CONFIG.localAudio : storedConfig.localAudio,
  };

  const positions = new Map(Object.entries(readJson<Record<string, Progress>>(progressPath) ?? {}));
  const subtitleChoices = new Map(
    Object.entries(readJson<Record<string, SavedSubtitleChoices>>(subtitlesPath) ?? {}),
  );

  function writeSubtitleChoices(): void {
    writeJsonAtomic(subtitlesPath, Object.fromEntries(subtitleChoices));
  }

  return {
    config,
    progress: (episodeId) => positions.get(episodeId) ?? null,
    allProgress: () => positions,
    saveProgress(episodeId, position, duration) {
      positions.set(episodeId, { position, duration, updatedAt: Date.now() });
      writeJsonAtomic(progressPath, Object.fromEntries(positions));
    },
    recordCard(card) {
      appendFileSync(join(dir, 'cards.jsonl'), `${JSON.stringify({ ...card, minedAt: new Date().toISOString() })}\n`);
    },
    subtitleChoices: (seriesId) => ({ ...(subtitleChoices.get(seriesId) ?? {}) }),
    saveSubtitleChoice(seriesId, slot, choice) {
      subtitleChoices.set(seriesId, { ...(subtitleChoices.get(seriesId) ?? {}), [slot]: choice });
      writeSubtitleChoices();
    },
    clearSubtitleChoice(seriesId, slot) {
      const saved = { ...(subtitleChoices.get(seriesId) ?? {}) };
      delete saved[slot];
      if (Object.keys(saved).length === 0) subtitleChoices.delete(seriesId);
      else subtitleChoices.set(seriesId, saved);
      writeSubtitleChoices();
    },
  };
}

function readJson<T>(path: string): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // A corrupt file is an error to fix by hand, never something to overwrite.
  return JSON.parse(text) as T;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
