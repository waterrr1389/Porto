import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaCache } from './index.ts';

const work = await mkdtemp(join(tmpdir(), 'sla-media-'));
after(() => rm(work, { recursive: true, force: true }));

const subtitles = `[Script Info]
ScriptType: v4.00+
PlayResX: 160
PlayResY: 90

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,test subtitle
`;

const subtitleFile = join(work, 'fixture.ass');
await writeFile(subtitleFile, subtitles);

const subtitleSrt = `1
00:00:00,000 --> 00:00:01,500
test subtitle

`;
const subtitleSrtFile = join(work, 'fixture.srt');
await writeFile(subtitleSrtFile, subtitleSrt);

const hasHevc = /libx265/.test(ffmpeg(['-hide_banner', '-encoders']));
const videoCodec = hasHevc
  ? ['-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p']
  : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];

// Two seconds of generated picture and two audio tracks: English first, so the
// japanese one is only chosen by language, plus an ASS and a SubRip subtitle
// stream for probing and extraction.
const source = join(work, 'fixture.mkv');
ffmpeg([
  '-nostdin',
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x90:rate=10:duration=2',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=2:sample_rate=48000',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880:duration=2:sample_rate=48000',
  '-i',
  subtitleFile,
  '-i',
  subtitleSrtFile,
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:a',
  '-map',
  '3:s',
  '-map',
  '4:s',
  ...videoCodec,
  '-c:a:0',
  'aac',
  '-c:a:1',
  'flac',
  '-c:s:0',
  'ass',
  '-c:s:1',
  'srt',
  '-metadata:s:a:0',
  'language=eng',
  '-metadata:s:a:1',
  'language=jpn',
  '-metadata:s:s:0',
  'language=chi',
  '-metadata:s:s:0',
  'title=Chinese (Simplified)',
  '-metadata:s:s:1',
  'language=jpn',
  '-metadata:s:s:1',
  'title=Japanese [SDH]',
  '-t',
  '2',
  source,
]);

// A wide source proves screenshots are downscaled to 1280 px instead of only
// never being upscaled.
const wideSource = join(work, 'wide.mp4');
ffmpeg([
  '-nostdin',
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=1920x1080:rate=10:duration=1',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-pix_fmt',
  'yuv420p',
  '-t',
  '1',
  wideSource,
]);

test('remuxes into a faststart mp4 with the japanese audio track', async (t) => {
  const cache = createMediaCache({ dir: join(work, 'cache-main'), limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });
  const output = await cache.prepare('a1', source);
  assert.equal(output, join(work, 'cache-main', 'a1.mp4'));
  assert.equal(cache.isReady('a1'), true);

  const { streams } = probeStreams(output);
  assert.deepEqual(
    streams.map((stream) => stream.codec_type),
    ['video', 'audio'],
  );
  const video = streams[0];
  const audio = streams[1];
  assert.ok(video && audio);
  if (hasHevc) {
    assert.equal(video.codec_tag_string, 'hvc1');
  } else {
    t.diagnostic('libx265 unavailable; the hvc1 tag is not checked');
  }
  assert.equal(audio.codec_name, 'flac');
  assert.equal(audio.tags?.language, 'jpn');

  const boxes = boxTypes(await readFile(output));
  assert.ok(boxes.includes('moov') && boxes.includes('mdat'), boxes.join(','));
  assert.ok(boxes.indexOf('moov') < boxes.indexOf('mdat'), `moov must precede mdat: ${boxes.join(',')}`);

  const sourceSeconds = duration(source);
  const outputSeconds = duration(output);
  assert.ok(Math.abs(outputSeconds - sourceSeconds) <= 0.1, `${outputSeconds} vs ${sourceSeconds}`);
});

test('downmixes audio with more than two channels to stereo aac', async () => {
  const surround = join(work, 'surround.mkv');
  ffmpeg([
    '-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'flac', '-ac', '6',
    '-t', '1', surround,
  ]);
  const cache = createMediaCache({ dir: join(work, 'cache-surround'), limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });
  const { streams } = probeStreams(await cache.prepare('c1', surround));
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(audio?.codec_name, 'aac');
  assert.equal(audio?.channels, 2);
});

test('concurrent prepares for one key share a single remux', async () => {
  const dir = join(work, 'cache-concurrent');
  const log = join(work, 'concurrent.log');
  await writeFile(log, '');
  const wrapper = await writeFfmpegWrapper('concurrent', log);
  const cache = createMediaCache({ dir, limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs'), ffmpeg: wrapper });

  const [first, second] = await Promise.all([cache.prepare('b1', source), cache.prepare('b1', source)]);
  assert.equal(first, second);
  assert.equal(await calls(log), 1);
  assert.equal(cache.isReady('b1'), true);
  assert.deepEqual(await readdir(dir), ['b1.mp4']);
});

test('reuses a completed file and rebuilds after the source is touched', async () => {
  const dir = join(work, 'cache-reuse');
  const log = join(work, 'reuse.log');
  const reusedSource = join(work, 'reuse.mkv');
  await copyFile(source, reusedSource);
  await writeFile(log, '');
  const wrapper = await writeFfmpegWrapper('reuse', log);
  const cache = createMediaCache({ dir, limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs'), ffmpeg: wrapper });

  const first = await cache.prepare('c1', reusedSource);
  const firstStats = await stat(first);
  await sleep(20);
  const second = await cache.prepare('c1', reusedSource);
  const secondStats = await stat(second);
  assert.equal(second, first);
  assert.equal(secondStats.mtimeMs, firstStats.mtimeMs);
  assert.equal(await calls(log), 1);

  await sleep(20);
  const now = new Date();
  await utimes(reusedSource, now, now);
  const third = await cache.prepare('c1', reusedSource);
  assert.equal(third, first);
  assert.ok((await stat(third)).mtimeMs > firstStats.mtimeMs);
  assert.equal(await calls(log), 2);
});

test('rejects a source that is not media and leaves nothing behind', async () => {
  const dir = join(work, 'cache-failure');
  const bad = join(work, 'not-media.mkv');
  await writeFile(bad, 'this is not a video\n');
  const cache = createMediaCache({ dir, limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });

  await assert.rejects(cache.prepare('d1', bad), /ffprobe failed|ffmpeg failed/);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(cache.isReady('d1'), false);
});

test('prewarm logs failures instead of throwing them', async () => {
  const dir = join(work, 'cache-prewarm');
  const bad = join(work, 'prewarm-bad.mkv');
  await writeFile(bad, 'not a video either\n');
  const cache = createMediaCache({ dir, limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });

  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    assert.doesNotThrow(() => cache.prewarm('g1', bad));
    for (let attempt = 0; attempt < 100 && logged.length === 0; attempt++) await sleep(20);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]?.[0]), /prewarm of g1 failed/);
});

test('evicts the least recently used file when over the limit', async () => {
  const dir = join(work, 'cache-lru');
  const roomy = createMediaCache({ dir, limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });
  const one = await roomy.prepare('e1', source);
  await roomy.prepare('e2', source);
  const size = (await stat(one)).size;

  // Room for two of the three files: the oldest must go, not the newest.
  const limited = createMediaCache({ dir, limitBytes: Math.floor(size * 2.5), thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });
  await limited.prepare('e3', source);
  assert.equal(limited.isReady('e1'), false);
  assert.equal(limited.isReady('e2'), true);
  assert.equal(limited.isReady('e3'), true);
});

test('never evicts the file it just produced', async () => {
  const dir = join(work, 'cache-tiny');
  const cache = createMediaCache({ dir, limitBytes: 1, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });
  const output = await cache.prepare('f1', source);
  assert.equal(cache.isReady('f1'), true);
  assert.deepEqual(await readdir(dir), ['f1.mp4']);
  assert.ok((await stat(output)).size > 0);
});

test('removes temporary files left by a crash on startup', async () => {
  const dir = join(work, 'cache-stale');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'dead.mp4.tmp'), 'incomplete');
  createMediaCache({ dir, limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });
  assert.deepEqual(await readdir(dir), []);
});

test('rejects keys that are not episode ids', async () => {
  const dir = join(work, 'cache-key');
  const cache = createMediaCache({ dir, limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });
  for (const key of ['', 'A1', 'a/b', '../a1', 'a1.mp4']) {
    await assert.rejects(cache.prepare(key, source), /invalid media key/);
    assert.equal(cache.isReady(key), false);
  }
  assert.deepEqual(await readdir(dir), []);
});

test('extracts a screenshot as a scaled JPEG', async () => {
  const cache = createMediaCache({ dir: join(work, 'cache-screenshot'), limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });

  const small = join(work, 'small.jpg');
  await cache.screenshot(source, 1, small);
  const smallFrame = probeStreams(small).streams[0];
  assert.equal(smallFrame?.codec_name, 'mjpeg');
  assert.equal(smallFrame?.width, 160);

  const wide = join(work, 'wide.jpg');
  await cache.screenshot(wideSource, 0.5, wide);
  const wideFrame = probeStreams(wide).streams[0];
  assert.equal(wideFrame?.codec_name, 'mjpeg');
  assert.equal(wideFrame?.width, 1280);
  assert.equal(wideFrame?.height, 720);
  assert.deepEqual(
    (await readdir(work)).filter((name) => name.endsWith('.jpg.tmp')),
    [],
  );
});

test('extracts an mp3 clip of the selected audio track', async () => {
  const cache = createMediaCache({ dir: join(work, 'cache-audio'), limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });
  const output = join(work, 'clip.mp3');
  await cache.audioClip(source, 0.5, 1.5, output);

  const streams = probeStreams(output).streams;
  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.codec_name, 'mp3');
  const seconds = duration(output);
  assert.ok(Math.abs(seconds - 1) <= 0.1, String(seconds));
  assert.ok(!(await readdir(work)).includes('clip.mp3.tmp'));
});

test('leaves no file when a screenshot or clip fails', async () => {
  const cache = createMediaCache({ dir: join(work, 'cache-media-failure'), limitBytes: 1_000_000_000, thumbsDir: join(work, 'thumbs'), subsDir: join(work, 'subs') });
  const bad = join(work, 'broken-source.mkv');
  await writeFile(bad, 'no media here\n');

  await assert.rejects(cache.screenshot(bad, 0, join(work, 'failed.jpg')), /ffmpeg failed/);
  await assert.rejects(cache.audioClip(bad, 0, 1, join(work, 'failed.mp3')), /ffprobe failed/);
  assert.deepEqual(
    (await readdir(work)).filter((name) => name.startsWith('failed')),
    [],
  );
});

test('extracts a thumbnail JPEG and reuses it while it is fresh', async () => {
  const thumbs = join(work, 'thumbs-reuse');
  const cache = createMediaCache({
    dir: join(work, 'cache-thumbs'),
    thumbsDir: thumbs,
    subsDir: join(work, 'subs'),
    limitBytes: 1_000_000_000,
  });

  const output = await cache.thumbnail('a1', source);
  assert.equal(output, join(thumbs, 'a1.jpg'));
  const bytes = await readFile(output);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], 'JPEG SOI');
  const frame = probeStreams(output).streams[0];
  assert.equal(frame?.codec_name, 'mjpeg');
  assert.ok((frame?.width ?? 0) <= 1280);

  const first = await stat(output);
  await sleep(20);
  assert.equal(await cache.thumbnail('a1', source), output);
  assert.equal((await stat(output)).mtimeMs, first.mtimeMs);
});

test('concurrent thumbnails for one key share a single run', async () => {
  const thumbs = join(work, 'thumbs-concurrent');
  const log = join(work, 'thumbs.log');
  await writeFile(log, '');
  const wrapper = await writeFfmpegWrapper('thumbs', log);
  const cache = createMediaCache({
    dir: join(work, 'cache-thumbs-concurrent'),
    thumbsDir: thumbs,
    subsDir: join(work, 'subs'),
    limitBytes: 1_000_000_000,
    ffmpeg: wrapper,
  });

  const [first, second] = await Promise.all([cache.thumbnail('a2', source), cache.thumbnail('a2', source)]);
  assert.equal(first, second);
  assert.equal(await calls(log), 1);
  assert.deepEqual(await readdir(thumbs), ['a2.jpg']);
});

test('rejects a thumbnail for a bad source and leaves nothing', async () => {
  const thumbs = join(work, 'thumbs-failure');
  await mkdir(thumbs, { recursive: true });
  await writeFile(join(thumbs, 'dead.jpg.tmp'), 'partial');
  const bad = join(work, 'thumbs-bad.mkv');
  await writeFile(bad, 'no media here\n');

  const cache = createMediaCache({
    dir: join(work, 'cache-thumbs-failure'),
    thumbsDir: thumbs,
    subsDir: join(work, 'subs'),
    limitBytes: 1_000_000_000,
  });
  assert.deepEqual(await readdir(thumbs), [], 'stale .tmp files are removed on startup');

  await assert.rejects(cache.thumbnail('a3', bad), /ffprobe failed/);
  await assert.rejects(cache.thumbnail('../a3', source), /invalid media key/);
  assert.deepEqual(await readdir(thumbs), []);
});

test('lists embedded text subtitle streams', async () => {
  const cache = createMediaCache({
    dir: join(work, 'cache-probe'),
    thumbsDir: join(work, 'thumbs'),
    subsDir: join(work, 'subs'),
    limitBytes: 1_000_000_000,
  });
  const streams = await cache.embeddedSubtitles(source);
  assert.deepEqual(
    streams.map((stream) => [stream.codec, stream.language, stream.title]),
    [
      ['ass', 'chi', 'Chinese (Simplified)'],
      ['subrip', 'jpn', 'Japanese [SDH]'],
    ],
  );
});

test('extracts embedded ass and srt subtitles and reuses them', async () => {
  const subs = join(work, 'subs-extract');
  const cache = createMediaCache({
    dir: join(work, 'cache-subs'),
    thumbsDir: join(work, 'thumbs'),
    subsDir: subs,
    limitBytes: 1_000_000_000,
  });
  const streams = await cache.embeddedSubtitles(source);
  const ass = streams.find((stream) => stream.codec === 'ass');
  const srt = streams.find((stream) => stream.codec === 'subrip');
  assert.ok(ass && srt);

  const assPath = await cache.subtitle('a4', source, ass.index, 'ass');
  assert.equal(assPath, join(subs, `a4-${ass.index}.ass`));
  assert.match(await readFile(assPath, 'utf8'), /\[Script Info\]/);
  const assStats = await stat(assPath);
  await sleep(20);
  assert.equal(await cache.subtitle('a4', source, ass.index, 'ass'), assPath);
  assert.equal((await stat(assPath)).mtimeMs, assStats.mtimeMs, 'reused while newer than the source');

  const srtPath = await cache.subtitle('a4', source, srt.index, 'srt');
  assert.equal(srtPath, join(subs, `a4-${srt.index}.srt`));
  assert.match(await readFile(srtPath, 'utf8'), /-->/);
  assert.deepEqual((await readdir(subs)).sort(), [`a4-${ass.index}.ass`, `a4-${srt.index}.srt`].sort());
});

test('concurrent extractions of one stream share a single run', async () => {
  const subs = join(work, 'subs-concurrent');
  const log = join(work, 'subs.log');
  await writeFile(log, '');
  const wrapper = await writeFfmpegWrapper('subs', log);
  const cache = createMediaCache({
    dir: join(work, 'cache-subs-concurrent'),
    thumbsDir: join(work, 'thumbs'),
    subsDir: subs,
    limitBytes: 1_000_000_000,
    ffmpeg: wrapper,
  });
  const [stream] = await cache.embeddedSubtitles(source);
  assert.ok(stream);

  const [first, second] = await Promise.all([
    cache.subtitle('a6', source, stream.index, 'ass'),
    cache.subtitle('a6', source, stream.index, 'ass'),
  ]);
  assert.equal(first, second);
  assert.equal(await calls(log), 1);
});

test('extraction failures leave no subtitle file', async () => {
  const subs = join(work, 'subs-failure');
  await mkdir(subs, { recursive: true });
  await writeFile(join(subs, 'dead.ass.tmp'), 'partial');
  const bad = join(work, 'subtitle-bad.mkv');
  await writeFile(bad, 'no media here\n');

  const cache = createMediaCache({
    dir: join(work, 'cache-subs-failure'),
    thumbsDir: join(work, 'thumbs'),
    subsDir: subs,
    limitBytes: 1_000_000_000,
  });
  assert.deepEqual(await readdir(subs), [], 'stale .tmp files are removed on startup');

  await assert.rejects(cache.subtitle('a5', bad, 3, 'ass'), /ffmpeg failed/);
  assert.deepEqual(await readdir(subs), []);
  await assert.rejects(cache.subtitle('../a5', source, 3, 'ass'), /invalid media key/);
});

interface StreamInfo {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  channels?: number;
  width?: number;
  height?: number;
  tags?: { language?: string };
}

function probeStreams(file: string): { streams: StreamInfo[] } {
  return JSON.parse(ffmpegProbe(['-v', 'error', '-show_streams', '-of', 'json', file])) as { streams: StreamInfo[] };
}

function duration(file: string): number {
  const parsed = JSON.parse(
    ffmpegProbe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file]),
  ) as { format: { duration: string } };
  return Number(parsed.format.duration);
}

function ffmpeg(args: string[]): string {
  return execFileSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function ffmpegProbe(args: string[]): string {
  return execFileSync('ffprobe', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/** Counts invocations by appending one line per call before running the real ffmpeg. */
async function writeFfmpegWrapper(name: string, log: string): Promise<string> {
  const path = join(work, `${name}-ffmpeg.sh`);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec ffmpeg "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

async function calls(log: string): Promise<number> {
  return (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '').length;
}

/** Top-level box types in file order; `moov` first proves faststart. */
function boxTypes(data: Buffer): string[] {
  const types: string[] = [];
  let offset = 0;
  while (offset + 8 <= data.length) {
    let size = data.readUInt32BE(offset);
    types.push(data.subarray(offset + 4, offset + 8).toString('latin1'));
    if (size === 1) {
      if (offset + 16 > data.length) break;
      size = Number(data.readBigUInt64BE(offset + 8));
    } else if (size === 0) {
      break;
    }
    if (size < 8) break;
    offset += size;
  }
  return types;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
