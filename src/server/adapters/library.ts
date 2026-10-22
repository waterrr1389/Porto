// Scans the media roots and keeps the episode index built by core/library.
import { glob } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { buildLibrary, type LibraryEpisode, type LibrarySeries } from '../../core/library.ts';

export interface LocatedEpisode {
  series: LibrarySeries;
  episode: LibraryEpisode;
  /** The episode after this one in its series, if any. */
  next: LibraryEpisode | null;
  /** Absolute path of the source video. */
  videoPath: string;
  /** Absolute subtitle paths by language. */
  subtitlePaths: Record<string, string>;
}

export interface Library {
  /** All series of all roots; rescans when the index is older than `maxAgeMs`. */
  series(): Promise<LibrarySeries[]>;
  /** Finds an episode by id, rescanning once if it is not in the current index. */
  episode(id: string): Promise<LocatedEpisode | null>;
}

const PATTERN = '**/*.{mkv,mp4,ass,ssa,srt,MKV,MP4,ASS,SSA,SRT}';

interface Index {
  series: LibrarySeries[];
  /** Series id -> media root it was found in. */
  rootOf: Map<string, string>;
  at: number;
}

export function createLibrary(roots: readonly string[], maxAgeMs = 30_000): Library {
  let index: Index | null = null;
  let scanning: Promise<Index> | null = null;

  async function scan(): Promise<Index> {
    const series: LibrarySeries[] = [];
    const rootOf = new Map<string, string>();
    for (const root of roots) {
      const files: string[] = [];
      try {
        for await (const file of glob(PATTERN, { cwd: root })) files.push(file.split('\\').join('/'));
      } catch (error) {
        console.warn(`cannot scan ${root}:`, error);
        continue;
      }
      for (const s of buildLibrary(basename(root), files)) {
        series.push(s);
        rootOf.set(s.id, root);
      }
    }
    return { series, rootOf, at: Date.now() };
  }

  async function current(force: boolean): Promise<Index> {
    if (!force && index && Date.now() - index.at < maxAgeMs) return index;
    scanning ??= scan().finally(() => {
      scanning = null;
    });
    const fresh = await scanning;
    index = fresh;
    return fresh;
  }

  function locate(snapshot: Index, id: string): LocatedEpisode | null {
    for (const series of snapshot.series) {
      const position = series.episodes.findIndex((e) => e.id === id);
      if (position < 0) continue;
      const episode = series.episodes[position] as LibraryEpisode;
      const root = snapshot.rootOf.get(series.id) as string;
      return {
        series,
        episode,
        next: series.episodes[position + 1] ?? null,
        videoPath: join(root, episode.video),
        subtitlePaths: Object.fromEntries(Object.entries(episode.subtitles).map(([lang, path]) => [lang, join(root, path)])),
      };
    }
    return null;
  }

  return {
    series: async () => (await current(false)).series,
    async episode(id) {
      return locate(await current(false), id) ?? locate(await current(true), id);
    },
  };
}
