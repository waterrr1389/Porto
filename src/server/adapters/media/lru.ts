import { readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Last-use order and size limit for the completed files in one directory.
 * The order lives in memory and is seeded from the files' own timestamps, so
 * a restart keeps roughly the previous order instead of starting empty.
 */
export interface FileLru {
  /** Resolves once existing files have been seeded. */
  ready: Promise<void>;
  /** Marks `key` as just used and updates the file's access time. */
  touch(key: string, path: string): Promise<void>;
  /** Deletes least recently used files until their total is within the limit, sparing `keep`. */
  trim(limitBytes: number, keep: ReadonlySet<string>): Promise<void>;
}

interface FileEntry {
  key: string;
  path: string;
  size: number;
  used: number;
}

export function createFileLru(dir: string): FileLru {
  const lastUsed = new Map<string, number>();

  const ready = (async () => {
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.mp4')) continue;
      const path = join(dir, name);
      const stats = await stat(path).catch(() => null);
      if (!stats) continue;
      lastUsed.set(keyOf(name), Math.max(stats.atimeMs, stats.mtimeMs));
    }
  })();

  return {
    ready,
    async touch(key, path) {
      lastUsed.set(key, Date.now());
      const stats = await stat(path).catch(() => null);
      if (!stats) return;
      // Only access time moves: mtime records when the file was produced and
      // decides whether it is still newer than its source.
      await utimes(path, new Date(), stats.mtime).catch(() => {});
    },
    async trim(limitBytes, keep) {
      await ready;
      const files: FileEntry[] = [];
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.mp4')) continue;
        const path = join(dir, name);
        const stats = await stat(path).catch(() => null);
        if (!stats) continue;
        const key = keyOf(name);
        files.push({
          key,
          path,
          size: stats.size,
          used: lastUsed.get(key) ?? Math.max(stats.atimeMs, stats.mtimeMs),
        });
      }

      let total = files.reduce((sum, file) => sum + file.size, 0);
      if (total <= limitBytes) return;

      files.sort((a, b) => a.used - b.used);
      for (const file of files) {
        if (total <= limitBytes) break;
        if (keep.has(file.key)) continue;
        // A file that cannot be removed leaves the cache over its limit;
        // that must not fail the remux the caller is waiting for.
        await rm(file.path, { force: true }).catch(() => {});
        lastUsed.delete(file.key);
        total -= file.size;
      }
    },
  };
}

function keyOf(name: string): string {
  return name.slice(0, -'.mp4'.length);
}
