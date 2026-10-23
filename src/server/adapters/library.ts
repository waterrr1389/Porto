// Scans the media roots and keeps the episode index built by core/library.
// Embedded subtitle streams are probed once per scan, because the library
// summary lists their languages too; a file that cannot be probed simply has
// none instead of hiding the rest of the library.
import { glob } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { buildLibrary, type LibraryEpisode, type LibrarySeries } from '../../core/library.ts';
import type { EmbeddedSubtitle } from '../../core/subtitle-options.ts';

export interface IndexedEpisode extends LibraryEpisode {
  /** Embedded text subtitle streams, in stream order; empty when probing failed. */
  embedded: EmbeddedSubtitle[];
}

export interface IndexedSeries extends Omit<LibrarySeries, 'episodes'> {
  episodes: IndexedEpisode[];
}

export interface LibraryOptions {
  /** Embedded text subtitle streams of a source; failures count as no streams. */
  embeddedSubtitles?(source: string): Promise<EmbeddedSubtitle[]>;
  /** How long a scan stays fresh, in milliseconds. */
  maxAgeMs?: number;
}

export interface LocatedEpisode {
  series: IndexedSeries;
  episode: IndexedEpisode;
  /** The episode after this one in its series, if any. */
  next: IndexedEpisode | null;
  /** Absolute path of the source video. */
  videoPath: string;
  /** Absolute path of a sidecar subtitle, given its path relative to the media root. */
  sidecarPath(relative: string): string;
}

export interface Library {
  /** All series of all roots; rescans when the index is older than `maxAgeMs`. */
  series(): Promise<IndexedSeries[]>;
  /** Finds an episode by id, rescanning once if it is not in the current index. */
  episode(id: string): Promise<LocatedEpisode | null>;
}

const PATTERN = '**/*.{mkv,mp4,ass,ssa,srt,MKV,MP4,ASS,SSA,SRT}';
/** ffprobe is cheap but not free; a handful at a time is enough to fill a disk queue. */
const PROBE_CONCURRENCY = 4;

interface Index {
  series: IndexedSeries[];
  /** Series id -> media root it was found in. */
  rootOf: Map<string, string>;
  at: number;
}

export function createLibrary(roots: readonly string[], options: LibraryOptions = {}): Library {
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  let index: Index | null = null;
  let scanning: Promise<Index> | null = null;

  async function scan(): Promise<Index> {
    const series: IndexedSeries[] = [];
    const rootOf = new Map<string, string>();
    for (const root of roots) {
      const files: string[] = [];
      try {
        for await (const file of glob(PATTERN, { cwd: root })) files.push(file.split('\\').join('/'));
      } catch (error) {
        console.warn(`cannot scan ${root}:`, error);
        continue;
      }

      const built = buildLibrary(basename(root), files);
      const embedded = new Map<string, EmbeddedSubtitle[]>();
      const sources = built.flatMap((s) => s.episodes.map((e) => ({ id: e.id, path: join(root, e.video) })));
      await forEachLimit(sources, PROBE_CONCURRENCY, async (source) => {
        const streams = options.embeddedSubtitles
          ? await options.embeddedSubtitles(source.path).catch(() => [])
          : [];
        embedded.set(source.id, streams);
      });

      for (const s of built) {
        series.push({
          ...s,
          episodes: s.episodes.map((e) => ({ ...e, embedded: embedded.get(e.id) ?? [] })),
        });
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
      const episode = series.episodes[position] as IndexedEpisode;
      const root = snapshot.rootOf.get(series.id) as string;
      return {
        series,
        episode,
        next: series.episodes[position + 1] ?? null,
        videoPath: join(root, episode.video),
        sidecarPath: (relative) => join(root, relative),
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

async function forEachLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await run(items[index] as T);
    }
  });
  await Promise.all(workers);
}
