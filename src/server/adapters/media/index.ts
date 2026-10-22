// Episode preparation: each source is stream-copied once into a faststart MP4
// under cache/, because Safari cannot play the MKV containers the library
// stores. Remuxing is disk-bound, so concurrent requests for the same episode
// share one run and the next episode can be prewarmed ahead of time.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileLru } from './lru.ts';
import { probeStreams } from './probe.ts';
import { remuxToMp4 } from './remux.ts';

export interface MediaCacheOptions {
  /** Directory for remuxed files, e.g. <repo>/cache/media. Created if missing. */
  dir: string;
  /** LRU size limit in bytes for completed files. */
  limitBytes: number;
  /** Paths to the binaries; default 'ffmpeg' / 'ffprobe'. */
  ffmpeg?: string;
  ffprobe?: string;
}

export interface MediaCache {
  /**
   * Path of a faststart MP4 for `source`, remuxing it on first request. `key` is a stable episode id
   * ([0-9a-f]+), used as the file name `<key>.mp4`. Concurrent calls for the same key share one remux.
   * A cached file is reused only if it is newer than the source (mtime) — otherwise it is rebuilt.
   * Touches the file's access time / LRU order on every call.
   */
  prepare(key: string, source: string): Promise<string>;
  /** Starts prepare() without waiting; errors are logged, not thrown (used for prewarm/prefetch). */
  prewarm(key: string, source: string): void;
  /** Whether a completed file exists for key (no remux). */
  isReady(key: string): boolean;
}

const episodeKey = /^[0-9a-f]+$/;

export function createMediaCache(options: MediaCacheOptions): MediaCache {
  const { dir, limitBytes } = options;
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const ffprobe = options.ffprobe ?? 'ffprobe';

  removeStaleTemporaryFiles(dir);
  const lru = createFileLru(dir);
  const running = new Map<string, Promise<string>>();
  let trimming: Promise<void> = Promise.resolve();

  const fileOf = (key: string) => join(dir, `${key}.mp4`);

  async function build(key: string, source: string): Promise<string> {
    const output = fileOf(key);
    const [cached, origin] = await Promise.all([stat(output).catch(() => null), stat(source)]);
    // A source that was replaced or re-downloaded is newer than its remux.
    if (cached && cached.mtimeMs > origin.mtimeMs) {
      await lru.touch(key, output);
      return output;
    }

    const streams = await probeStreams(ffprobe, source);
    const temporary = `${output}.tmp`;
    try {
      await remuxToMp4({ ffmpeg, source, output: temporary, streams });
      await rename(temporary, output);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await lru.touch(key, output);

    // The new file counts towards the limit, and trimming has to finish before
    // callers open the path so they never race a deletion. Anything with a
    // prepared remux in flight is spared.
    const keep = new Set([...running.keys(), key]);
    trimming = trimming
      .then(() => lru.trim(limitBytes, keep))
      .catch((error: unknown) => {
        console.error('media: trimming the cache failed:', error instanceof Error ? error.message : error);
      });
    await trimming;
    return output;
  }

  async function prepare(key: string, source: string): Promise<string> {
    if (!episodeKey.test(key)) throw new Error(`invalid media key: ${JSON.stringify(key)}`);
    const pending = running.get(key);
    if (pending) return pending;
    const task = build(key, source).finally(() => running.delete(key));
    running.set(key, task);
    return task;
  }

  return {
    prepare,
    prewarm(key, source) {
      void prepare(key, source).catch((error: unknown) => {
        console.error(`media: prewarm of ${key} failed:`, error instanceof Error ? error.message : error);
      });
    },
    isReady(key) {
      return episodeKey.test(key) && existsSync(fileOf(key));
    },
  };
}

/**
 * Leftover `.tmp` files are remuxes that never finished. They are not part of
 * the LRU and are removed before the first request, so the disk does not keep
 * them forever. Synchronous because createMediaCache cannot await.
 */
function removeStaleTemporaryFiles(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.mp4.tmp')) rmSync(join(dir, name), { force: true });
  }
}
