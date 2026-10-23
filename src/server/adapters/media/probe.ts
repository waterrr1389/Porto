import { run, tail } from './exec.ts';
import type { EmbeddedSubtitle } from '../../../core/subtitle-options.ts';

/** Streams to copy, by their absolute index in the source file. */
export interface SelectedStreams {
  video: number;
  audio: number;
  /** ffprobe's codec name; HEVC must be tagged `hvc1` for Safari to decode it. */
  videoCodec: string;
}

interface ProbeStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
  disposition?: { attached_pic?: number };
  tags?: { language?: string; title?: string };
}

/**
 * Picks the first real video stream and the first Japanese audio stream,
 * falling back to the first audio stream. Absolute indexes are required
 * because the ffmpeg command maps `0:<index>` without any stream-type
 * filter that could renumber them.
 */
export async function probeStreams(ffprobe: string, source: string): Promise<SelectedStreams> {
  const result = await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', source]);
  if (result.code !== 0) {
    throw new Error(`ffprobe failed for ${source}: ${tail(result.stderr)}`);
  }

  let streams: ProbeStream[];
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: ProbeStream[] };
    streams = parsed.streams ?? [];
  } catch {
    throw new Error(`ffprobe returned no stream list for ${source}`);
  }

  // Attached pictures are cover art, not something the player can show.
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  if (!video) throw new Error(`no video stream in ${source}`);

  const audio =
    streams.find((stream) => stream.codec_type === 'audio' && isJapanese(stream)) ??
    streams.find((stream) => stream.codec_type === 'audio');
  if (!audio) throw new Error(`no audio stream in ${source}`);

  return { video: video.index, audio: audio.index, videoCodec: video.codec_name ?? '' };
}

function isJapanese(stream: ProbeStream): boolean {
  const language = stream.tags?.language?.toLowerCase();
  return language === 'jpn' || language === 'ja';
}

const TEXT_SUBTITLE_CODECS = new Set(['ass', 'ssa', 'subrip']);

/**
 * Text subtitle streams of the source in stream order. Bitmap subtitles such
 * as pgs or dvdsub cannot be rendered by the player as sidecars, so they are
 * left out.
 */
export async function probeEmbeddedSubtitles(ffprobe: string, source: string): Promise<EmbeddedSubtitle[]> {
  const result = await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', source]);
  if (result.code !== 0) {
    throw new Error(`ffprobe failed for ${source}: ${tail(result.stderr)}`);
  }

  let streams: ProbeStream[];
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: ProbeStream[] };
    streams = parsed.streams ?? [];
  } catch {
    throw new Error(`ffprobe returned no stream list for ${source}`);
  }

  return streams
    .filter(
      (stream) =>
        stream.codec_type === 'subtitle' &&
        stream.codec_name !== undefined &&
        TEXT_SUBTITLE_CODECS.has(stream.codec_name),
    )
    .map((stream) => ({
      index: stream.index,
      codec: stream.codec_name ?? '',
      language: stream.tags?.language ?? '',
      title: stream.tags?.title ?? '',
    }))
    .sort((a, b) => a.index - b.index);
}

/** Container duration in seconds, or null when the source does not report one. */
export async function probeDuration(ffprobe: string, source: string): Promise<number | null> {
  const result = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', source]);
  if (result.code !== 0) {
    throw new Error(`ffprobe failed for ${source}: ${tail(result.stderr)}`);
  }
  try {
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: unknown } };
    const duration = Number(parsed.format?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}
