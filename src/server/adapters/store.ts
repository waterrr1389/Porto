// Durable user state under state/: config and playback positions. These
// cannot be rebuilt, so writes go to a temporary file that is renamed over the
// old one, and the program never deletes them.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  /** Directories scanned for episodes; each root's name is part of episode ids. */
  mediaRoots: string[];
  /** Upper bound for remuxed episodes in cache/, in gigabytes. */
  cacheLimitGB: number;
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
}

export const DEFAULT_CONFIG: Config = {
  mediaRoots: ['/srv/anime'],
  cacheLimitGB: 50,
};

/**
 * Opens the store in `dir`, writing the default config on first use. Missing
 * config keys take their defaults; unknown keys are kept in the file.
 */
export function openStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  const progressPath = join(dir, 'progress.json');

  const storedConfig = readJson<Partial<Config>>(configPath);
  if (storedConfig === null) writeJsonAtomic(configPath, DEFAULT_CONFIG);
  const config: Config = { ...DEFAULT_CONFIG, ...storedConfig };

  const positions = new Map(Object.entries(readJson<Record<string, Progress>>(progressPath) ?? {}));

  return {
    config,
    progress: (episodeId) => positions.get(episodeId) ?? null,
    allProgress: () => positions,
    saveProgress(episodeId, position, duration) {
      positions.set(episodeId, { position, duration, updatedAt: Date.now() });
      writeJsonAtomic(progressPath, Object.fromEntries(positions));
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
