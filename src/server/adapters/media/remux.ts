import { run, tail } from './exec.ts';
import type { SelectedStreams } from './probe.ts';

export interface RemuxRequest {
  ffmpeg: string;
  source: string;
  /** Destination of the finished MP4; callers pass a `.tmp` path and rename it. */
  output: string;
  streams: SelectedStreams;
}

/** Bit rate for audio that has to be downmixed. */
const DOWNMIX_BITRATE = '256k';

/**
 * Copies the selected streams into a faststart MP4. Video is never
 * re-encoded, and stereo or mono audio is copied as well: Safari plays FLAC
 * in MP4, so AAC stays AAC and FLAC stays lossless. Audio with more than two
 * channels is downmixed to stereo AAC, because Safari on iPad plays 5.1 Opus
 * as if it were mono.
 */
export async function remuxToMp4(request: RemuxRequest): Promise<void> {
  const { ffmpeg, source, output, streams } = request;
  const args = [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-i',
    source,
    '-map',
    `0:${streams.video}`,
    '-map',
    `0:${streams.audio}`,
    // Subtitles come from sidecar files; chapters, attachments and extra
    // audio tracks must not reach the player.
    '-dn',
    '-sn',
    '-map_chapters',
    '-1',
    '-c',
    'copy',
  ];
  if (streams.audioChannels > 2) args.push('-c:a', 'aac', '-b:a', DOWNMIX_BITRATE, '-ac', '2');
  if (streams.videoCodec === 'hevc') args.push('-tag:v', 'hvc1');
  args.push('-movflags', '+faststart', '-f', 'mp4', output);

  const result = await run(ffmpeg, args);
  if (result.code !== 0) {
    throw new Error(`ffmpeg failed for ${source}: ${tail(result.stderr)}`);
  }
}
