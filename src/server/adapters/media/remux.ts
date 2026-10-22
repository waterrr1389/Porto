import { run, tail } from './exec.ts';
import type { SelectedStreams } from './probe.ts';

export interface RemuxRequest {
  ffmpeg: string;
  source: string;
  /** Destination of the finished MP4; callers pass a `.tmp` path and rename it. */
  output: string;
  streams: SelectedStreams;
}

/**
 * Stream-copies the selected streams into a faststart MP4. Nothing is
 * re-encoded: the video is already HEVC, and Safari plays FLAC in MP4, so
 * AAC sources stay AAC and FLAC sources stay lossless.
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
  if (streams.videoCodec === 'hevc') args.push('-tag:v', 'hvc1');
  args.push('-movflags', '+faststart', '-f', 'mp4', output);

  const result = await run(ffmpeg, args);
  if (result.code !== 0) {
    throw new Error(`ffmpeg failed for ${source}: ${tail(result.stderr)}`);
  }
}
