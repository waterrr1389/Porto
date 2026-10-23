import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLibrary, cleanTitle, episodeNumber, resumeEpisode, stableId, subtitleLanguage } from './library.ts';

const bocchi = '[DMG&VCB-Studio] BOCCHI THE ROCK! [Ma10p_1080p]';
const ep = (n: string) => `${bocchi}/[DMG&VCB-Studio] BOCCHI THE ROCK! [${n}][Ma10p_1080p][x265_flac]`;

test('groups videos by directory and pairs sidecar subtitles by language', () => {
  const files = [
    `${ep('06')}.mkv`,
    `${ep('06')}.ja.ass`,
    `${ep('06')}.sc.ass`,
    `${ep('06')}.tc.ass`,
    `${ep('05')}.mkv`,
    `${ep('05')}.sc.ass`,
    `${bocchi}/CDs/booklet.jpg`,
  ];
  const [series, ...rest] = buildLibrary('PT', files);
  assert.equal(rest.length, 0);
  assert.equal(series?.title, 'BOCCHI THE ROCK!');
  assert.equal(series?.directory, bocchi);
  assert.deepEqual(
    series?.episodes.map((e) => [e.title, e.number, [...new Set(e.subtitles.map((s) => s.language))].sort()]),
    [
      ['05', 5, ['zh']],
      ['06', 6, ['ja', 'zh', 'zh-Hant']],
    ],
  );
  assert.equal(
    series?.episodes[1]?.subtitles.find((s) => s.language === 'ja')?.path,
    `${ep('06')}.ja.ass`,
  );
});

test('a subtitle must extend the video stem with a dot', () => {
  const [series] = buildLibrary('PT', ['a/Show - 01.mkv', 'a/Show - 01.ass', 'a/Show - 011.ja.ass', 'a/Show - 01.ja.srt']);
  assert.deepEqual(series?.episodes[0]?.subtitles, [
    { path: 'a/Show - 01.ass', suffix: '.ass', language: 'und' },
    { path: 'a/Show - 01.ja.srt', suffix: '.ja.srt', language: 'ja' },
  ]);
});

test('keeps every sidecar subtitle, not only the first per language', () => {
  const [series] = buildLibrary('PT', [
    'a/Show - 01.mkv',
    'a/Show - 01.sc.ass',
    'a/Show - 01.sc.srt',
    'a/Show - 01.tc.ass',
  ]);
  assert.deepEqual(
    series?.episodes[0]?.subtitles.map((s) => [s.suffix, s.language]),
    [
      ['.sc.ass', 'zh'],
      ['.sc.srt', 'zh'],
      ['.tc.ass', 'zh-Hant'],
    ],
  );
});

test('files in the root form one series each', () => {
  const series = buildLibrary('PT', ['[Feibanyama] Movie [NF WebRip].mkv', 'Other.mp4']);
  assert.deepEqual(
    series.map((s) => [s.title, s.directory, s.episodes.length]),
    [
      ['Movie', '', 1],
      ['Other', '', 1],
    ],
  );
  assert.notEqual(series[0]?.id, series[1]?.id);
});

test('extras folders are titled after their parent series', () => {
  const series = buildLibrary('PT', ['[VCB-Studio] Takagi-san/SPs/[VCB-Studio] Takagi-san [Menu01].mkv', '[VCB-Studio] Takagi-san/Ep - 01.mkv']);
  assert.deepEqual(series.map((s) => s.title), ['Takagi-san', 'Takagi-san · SPs']);
});

test('ignores hidden files and non-media', () => {
  assert.deepEqual(buildLibrary('PT', ['.trash/a.mkv', 'x/.a.mkv', 'notes.txt']), []);
});

test('episodes sort by number then naturally; unnumbered last', () => {
  const [series] = buildLibrary('PT', ['s/Show - 10.mkv', 's/Show - 2.mkv', 's/Extra.mkv', 's/Show - 1.mkv']);
  assert.deepEqual(series?.episodes.map((e) => e.title), ['01', '02', '10', 'Extra']);
});

test('ids are stable and depend on root name and path', () => {
  const a = buildLibrary('PT', ['s/a - 01.mkv'])[0]?.episodes[0]?.id;
  assert.equal(a, buildLibrary('PT', ['s/a - 01.mkv', 's/b.mkv'])[0]?.episodes[0]?.id);
  assert.notEqual(a, buildLibrary('Other', ['s/a - 01.mkv'])[0]?.episodes[0]?.id);
  assert.match(stableId('x'), /^[0-9a-f]{16}$/);
});

test('episode numbers from common naming styles', () => {
  assert.equal(episodeNumber('[DMG&VCB-Studio] BOCCHI THE ROCK! [05][Ma10p_1080p][x265_flac]'), 5);
  assert.equal(episodeNumber('[LoliHouse] Yuusha Kei - 12 [WebRip 1080p]'), 12);
  assert.equal(episodeNumber('Modern.Family.S01E03.1080p'), 3);
  assert.equal(episodeNumber('01. Angel Beats! (2010) [BD 1080p]'), 1);
  assert.equal(episodeNumber('[Group] Show [07v2][1080p]'), 7);
  assert.equal(episodeNumber('Sherlock 2x03 The Reichenbach Fall'), 3);
  assert.equal(episodeNumber('Inception.2010.2160p'), null);
});

test('language tags', () => {
  assert.equal(subtitleLanguage('ja'), 'ja');
  assert.equal(subtitleLanguage('sc'), 'zh');
  assert.equal(subtitleLanguage('zh'), 'zh');
  assert.equal(subtitleLanguage('简英'), 'zh');
  assert.equal(subtitleLanguage('tc'), 'zh-Hant');
  assert.equal(subtitleLanguage('zh-Hant'), 'zh-Hant');
  assert.equal(subtitleLanguage('en'), 'en');
  assert.equal(subtitleLanguage(''), 'und');
  assert.equal(subtitleLanguage('FR'), 'fr');
});

test('titles lose release tags', () => {
  assert.equal(cleanTitle('[SweetSub&VCB-Studio] Oniichan ha Oshimai! [Ma10p_1080p]'), 'Oniichan ha Oshimai!');
  assert.equal(cleanTitle('[VCB-Studio] Karakai Jouzu no Takagi-san'), 'Karakai Jouzu no Takagi-san');
  assert.equal(cleanTitle('[only tags]'), '[only tags]');
});

test('resume offers the latest unfinished episode, or the one after a finished one', () => {
  const series = buildLibrary('PT', ['s/Show - 01.mkv', 's/Show - 02.mkv', 't/Other - 01.mkv']);
  const [show, other] = [series[0]!, series[1]!];
  const [one, two] = [show.episodes[0]!, show.episodes[1]!];
  const at = (position: number, duration: number, updatedAt: number) => ({ position, duration, updatedAt });

  assert.equal(resumeEpisode(series, new Map()), null);
  const unfinished = resumeEpisode(series, new Map([[one.id, at(300, 1400, 2)], [other.episodes[0]!.id, at(10, 1400, 1)]]));
  assert.equal(unfinished?.episode.id, one.id);
  assert.equal(unfinished?.position, 300);

  const finished = resumeEpisode(series, new Map([[one.id, at(1380, 1400, 5)]]));
  assert.equal(finished?.episode.id, two.id);
  assert.equal(finished?.position, 0);

  assert.equal(resumeEpisode(series, new Map([[two.id, at(1399, 1400, 5)]])), null);
  assert.equal(resumeEpisode(series, new Map([['gone', at(1, 2, 9)]])), null);
});
