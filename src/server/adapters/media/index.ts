// Episode preparation: each source is stream-copied once into a faststart MP4
// under cache/, because Safari cannot play the MKV containers the library
// stores. Remuxing is disk-bound, so concurrent requests for the same episode
// share one run and the next episode can be prewarmed ahead of time.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EmbeddedSubtitle, SubtitleFormat } from '../../../core/subtitle-options.ts';
import { captureFrame, captureThumbnail, encodeAudioClip, extractSubtitle } from './frames.ts';
import { createFileLru } from './lru.ts';
import { probeDuration, probeEmbeddedSubtitles, probeStreams } from './probe.ts';
import { remuxToMp4 } from './remux.ts';

export interface MediaCacheOptions {
  /** Directory for remuxed files, e.g. <repo>/cache/media. Created if missing. */
  dir: string;
  /** Directory for episode thumbnails, e.g. <repo>/cache/thumbs. Created if missing. */
  thumbsDir: string;
  /** Directory for extracted embedded subtitles, e.g. <repo>/cache/subs. Created if missing. */
  subsDir: string;
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
  /**
   * Path of a JPEG still for `source` at `<thumbsDir>/<key>.jpg`, extracted on
   * first request. Concurrent calls for the same key share one run; a cached
   * file is reused while it is newer than the source. Thumbnails are not part
   * of the remux LRU.
   */
  thumbnail(key: string, source: string): Promise<string>;
  /** Extracts a JPEG frame at `time` from `source` into `output` (scaled to max 1280 px wide, quality ~ -q:v 3). */
  screenshot(source: string, time: number, output: string): Promise<void>;
  /**
   * Embedded text subtitle streams of `source` (ass, ssa and subrip only), in
   * stream order. Memoised by path and mtime.
   */
  embeddedSubtitles(source: string): Promise<EmbeddedSubtitle[]>;
  /**
   * Path of the extracted subtitle for embedded stream `index`, at
   * `<subsDir>/<key>-<index>.<format>`. Extraction runs on first request;
   * concurrent calls for one stream share it and a cached file is reused while
   * it is newer than the source.
   */
  subtitle(key: string, source: string, index: number, format: SubtitleFormat): Promise<string>;
  /** Starts subtitle() without waiting; errors are logged, not thrown. */
  prewarmSubtitle(key: string, source: string, index: number, format: SubtitleFormat): void;
  /** Extracts [start, end) of the selected audio stream (same selection as remux: first jpn audio) into an MP3 at `output` (libmp3lame, -q:a 4, mono not required). */
  audioClip(source: string, start: number, end: number, output: string): Promise<void>;
}

const episodeKey = /^[0-9a-f]+$/;

export function createMediaCache(options: MediaCacheOptions): MediaCache {
  const { dir, thumbsDir, subsDir, limitBytes } = options;
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const ffprobe = options.ffprobe ?? 'ffprobe';

  prepareDirectory(dir, '.mp4.tmp');
  prepareDirectory(thumbsDir, '.jpg.tmp');
  prepareDirectory(subsDir, '.tmp');
  const lru = createFileLru(dir);
  const running = new Map<string, Promise<string>>();
  const thumbnails = new Map<string, Promise<string>>();
  const embedded = new Map<string, { mtimeMs: number; streams: EmbeddedSubtitle[] }>();
  const embeddedJobs = new Map<string, Promise<EmbeddedSubtitle[]>>();
  const subtitleJobs = new Map<string, Promise<string>>();
  let trimming: Promise<void> = Promise.resolve();

  const fileOf = (key: string) => join(dir, `${key}.mp4`);
  const thumbFileOf = (key: string) => join(thumbsDir, `${key}.jpg`);
  const subtitleFileOf = (key: string, index: number, format: SubtitleFormat) =>
    join(subsDir, `${key}-${index}.${format}`);

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

  async function buildThumbnail(key: string, source: string): Promise<string> {
    const output = thumbFileOf(key);
    const [cached, origin] = await Promise.all([stat(output).catch(() => null), stat(source)]);
    if (cached && cached.mtimeMs > origin.mtimeMs) return output;
    // A third of the way in avoids the opening logo without reaching the end;
    // sources without a duration fall back to a minute.
    const duration = await probeDuration(ffprobe, source);
    const time = duration === null ? 60 : duration / 3;
    await captureThumbnail({ ffmpeg, source, time, output });
    return output;
  }

  async function thumbnail(key: string, source: string): Promise<string> {
    if (!episodeKey.test(key)) throw new Error(`invalid media key: ${JSON.stringify(key)}`);
    const pending = thumbnails.get(key);
    if (pending) return pending;
    const task = buildThumbnail(key, source).finally(() => thumbnails.delete(key));
    thumbnails.set(key, task);
    return task;
  }

  async function embeddedSubtitles(source: string): Promise<EmbeddedSubtitle[]> {
    const info = await stat(source).catch(() => null);
    const cached = embedded.get(source);
    if (info !== null && cached !== undefined && cached.mtimeMs === info.mtimeMs) return cached.streams;

    const pending = embeddedJobs.get(source);
    if (pending) return pending;
    const task = probeEmbeddedSubtitles(ffprobe, source)
      .then((streams) => {
        if (info !== null) embedded.set(source, { mtimeMs: info.mtimeMs, streams });
        return streams;
      })
      .finally(() => embeddedJobs.delete(source));
    embeddedJobs.set(source, task);
    return task;
  }

  async function buildSubtitle(
    key: string,
    source: string,
    index: number,
    format: SubtitleFormat,
  ): Promise<string> {
    const output = subtitleFileOf(key, index, format);
    const [cached, origin] = await Promise.all([stat(output).catch(() => null), stat(source)]);
    if (cached && cached.mtimeMs > origin.mtimeMs) return output;
    await extractSubtitle({ ffmpeg, source, index, format, output });
    return output;
  }

  async function subtitle(key: string, source: string, index: number, format: SubtitleFormat): Promise<string> {
    if (!episodeKey.test(key)) throw new Error(`invalid media key: ${JSON.stringify(key)}`);
    const job = `${key}-${index}`;
    const pending = subtitleJobs.get(job);
    if (pending) return pending;
    const task = buildSubtitle(key, source, index, format).finally(() => subtitleJobs.delete(job));
    subtitleJobs.set(job, task);
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
    thumbnail,
    embeddedSubtitles,
    subtitle,
    prewarmSubtitle(key, source, index, format) {
      void subtitle(key, source, index, format).catch((error: unknown) => {
        console.error(
          `media: prewarm of ${key} subtitle ${index} failed:`,
          error instanceof Error ? error.message : error,
        );
      });
    },
    async screenshot(source, time, output) {
      await captureFrame({ ffmpeg, source, time, output });
    },
    async audioClip(source, start, end, output) {
      const streams = await probeStreams(ffprobe, source);
      await encodeAudioClip({ ffmpeg, source, audio: streams.audio, start, end, output });
    },
  };
}

/**
 * Creates a cache directory and drops the temporary file left by a crash, so
 * remuxes, thumbnails and extracted subtitles do not keep partial files
 * forever. Synchronous because createMediaCache cannot await.
 */
function prepareDirectory(dir: string, temporarySuffix: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name.endsWith(temporarySuffix)) rmSync(join(dir, name), { force: true });
  }
}
