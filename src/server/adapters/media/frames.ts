import { rename, rm } from 'node:fs/promises';
import type { SubtitleFormat } from '../../../core/subtitle-options.ts';
import { run, tail } from './exec.ts';

export interface ScreenshotRequest {
  ffmpeg: string;
  source: string;
  time: number;
  output: string;
}

export interface AudioClipRequest {
  ffmpeg: string;
  source: string;
  /** Absolute index of the audio stream to encode. */
  audio: number;
  start: number;
  end: number;
  output: string;
}

/**
 * Writes one JPEG frame, at most 1280 px wide and never upscaled, into
 * `output`. The frame is written next to `output` and renamed, so a failed run
 * never leaves a partial file under the name Anki will store.
 */
export async function captureFrame(request: ScreenshotRequest): Promise<void> {
  const temporary = `${request.output}.tmp`;
  try {
    const result = await run(request.ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-ss',
      String(request.time),
      '-i',
      request.source,
      '-frames:v',
      '1',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      "scale='min(1280,iw)':-2",
      '-q:v',
      '3',
      '-f',
      'image2',
      temporary,
    ]);
    if (result.code !== 0) {
      throw new Error(`ffmpeg failed for ${request.source}: ${tail(result.stderr)}`);
    }
    await rename(temporary, request.output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface ThumbnailRequest {
  ffmpeg: string;
  source: string;
  time: number;
  output: string;
}

/**
 * A representative JPEG frame from near `time`, at most 1280 px wide. The
 * `thumbnail` filter scores a batch of frames and keeps the one closest to
 * their average, so a black transition frame is not chosen.
 */
export async function captureThumbnail(request: ThumbnailRequest): Promise<void> {
  const temporary = `${request.output}.tmp`;
  try {
    const result = await run(request.ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-ss',
      String(request.time),
      '-i',
      request.source,
      '-frames:v',
      '1',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      "thumbnail=60,scale='min(1280,iw)':-2",
      '-q:v',
      '4',
      '-f',
      'image2',
      temporary,
    ]);
    if (result.code !== 0) {
      throw new Error(`ffmpeg failed for ${request.source}: ${tail(result.stderr)}`);
    }
    await rename(temporary, request.output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface SubtitleExtractionRequest {
  ffmpeg: string;
  source: string;
  /** Absolute stream index in the source. */
  index: number;
  format: SubtitleFormat;
  output: string;
}

/**
 * Extracts one embedded text subtitle stream. ASS and SSA are copied as they
 * are; SubRip goes through the srt muxer so the output is plain SRT. The
 * result is renamed into place only after a successful run.
 */
export async function extractSubtitle(request: SubtitleExtractionRequest): Promise<void> {
  const temporary = `${request.output}.tmp`;
  try {
    const result = await run(request.ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      request.source,
      '-map',
      `0:${request.index}`,
      ...(request.format === 'ass' ? ['-c:s', 'copy'] : ['-c:s', 'srt']),
      '-f',
      request.format,
      temporary,
    ]);
    if (result.code !== 0) {
      throw new Error(`ffmpeg failed for ${request.source}: ${tail(result.stderr)}`);
    }
    await rename(temporary, request.output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Encodes [start, end) of one audio stream to MP3. `-ss` before the input is
 * accurate here because the clip is re-encoded; ffmpeg decodes from the
 * nearest seek point and discards up to the requested time. The result is
 * renamed into place only after a successful run.
 */
export async function encodeAudioClip(request: AudioClipRequest): Promise<void> {
  if (!(request.end > request.start)) {
    throw new Error(`audio clip range is empty: ${request.start}..${request.end}`);
  }
  const temporary = `${request.output}.tmp`;
  try {
    const result = await run(request.ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-ss',
      String(request.start),
      '-i',
      request.source,
      '-t',
      String(request.end - request.start),
      '-map',
      `0:${request.audio}`,
      '-vn',
      '-sn',
      '-dn',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '4',
      '-f',
      'mp3',
      temporary,
    ]);
    if (result.code !== 0) {
      throw new Error(`ffmpeg failed for ${request.source}: ${tail(result.stderr)}`);
    }
    await rename(temporary, request.output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
