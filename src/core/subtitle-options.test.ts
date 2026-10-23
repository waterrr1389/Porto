import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSubtitleOptions,
  embeddedSubtitleLanguage,
  selectSubtitles,
  type EmbeddedSubtitle,
  type SubtitleOption,
} from './subtitle-options.ts';
import type { SidecarSubtitle } from './library.ts';

const sidecar = (suffix: string, language: string): SidecarSubtitle => ({
  path: `a/Show - 01${suffix}`,
  suffix,
  language,
});

const stream = (index: number, codec: string, language: string, title: string): EmbeddedSubtitle => ({
  index,
  codec,
  language,
  title,
});

const SIDECARS: SidecarSubtitle[] = [
  sidecar('.ja.ass', 'ja'),
  sidecar('.sc.ass', 'zh'),
  sidecar('.tc.ass', 'zh-Hant'),
  sidecar('.en.srt', 'en'),
];

const STREAMS: EmbeddedSubtitle[] = [
  stream(13, 'ass', 'chi', 'Chinese (Simplified)'),
  stream(14, 'ass', 'chi', 'Chinese (Traditional)'),
  stream(16, 'subrip', 'jpn', 'Japanese [SDH]'),
  stream(20, 'subrip', 'jpn', ''),
  stream(21, 'ass', 'eng', 'English'),
];

const ids = (options: readonly SubtitleOption[]): string[] => options.map((option) => option.id);

test('embedded language tags select slots and chinese variants', () => {
  assert.equal(embeddedSubtitleLanguage(stream(1, 'ass', 'jpn', '')), 'ja');
  assert.equal(embeddedSubtitleLanguage(stream(1, 'ass', 'ja', '')), 'ja');
  assert.equal(embeddedSubtitleLanguage(stream(1, 'subrip', 'chi', 'Chinese (Simplified)')), 'zh');
  assert.equal(embeddedSubtitleLanguage(stream(1, 'subrip', 'chi', 'Chinese (Traditional)')), 'zh-Hant');
  assert.equal(embeddedSubtitleLanguage(stream(1, 'ass', 'zho', '繁中')), 'zh-Hant');
  assert.equal(embeddedSubtitleLanguage(stream(1, 'ass', 'zh-Hant', '')), 'zh-Hant');
  assert.equal(embeddedSubtitleLanguage(stream(1, 'ass', 'zh-TW', '')), 'zh-Hant');
  assert.equal(embeddedSubtitleLanguage(stream(1, 'ass', 'chi', 'Cantonese HK')), 'zh-Hant');
  assert.equal(embeddedSubtitleLanguage(stream(1, 'ass', 'eng', 'English')), null);
  assert.equal(embeddedSubtitleLanguage(stream(1, 'ass', '', '')), null);
});

test('builds sidecar options first, then embedded streams, with stable ids and keys', () => {
  const options = buildSubtitleOptions(SIDECARS, STREAMS);
  assert.deepEqual(ids(options), ['f0', 'f1', 'f2', 's13', 's14', 's16', 's20']);

  const [ja, sc, tc, simplified, traditional, sdh, untitled] = options;
  assert.ok(ja && sc && tc && simplified && traditional && sdh && untitled);

  assert.deepEqual(
    [ja.slot, ja.label, ja.format, ja.source, ja.path, ja.streamIndex],
    ['ja', '.ja.ass', 'ass', 'sidecar', 'a/Show - 01.ja.ass', null],
  );
  assert.deepEqual(ja.key, { source: 'sidecar', suffix: '.ja.ass' });
  assert.deepEqual([sc.chinese, tc.chinese], ['simplified', 'traditional']);

  assert.deepEqual(
    [simplified.slot, simplified.label, simplified.format, simplified.source, simplified.path, simplified.streamIndex],
    ['zh', 'Chinese (Simplified)', 'ass', 'embedded', null, 13],
  );
  assert.deepEqual(simplified.key, {
    source: 'embedded',
    title: 'Chinese (Simplified)',
    language: 'chi',
    codec: 'ass',
  });
  assert.deepEqual([simplified.chinese, traditional.chinese], ['simplified', 'traditional']);

  assert.deepEqual([sdh.slot, sdh.format, sdh.label], ['ja', 'srt', 'Japanese [SDH]']);
  assert.equal(untitled.label, 'jpn subrip');
});

test('skips non-japanese and non-chinese candidates', () => {
  const options = buildSubtitleOptions([sidecar('.en.srt', 'en')], [stream(3, 'ass', 'eng', 'English')]);
  assert.deepEqual(options, []);
});

test('defaults to the first japanese option and the preferred chinese one', () => {
  assert.deepEqual(selectSubtitles(buildSubtitleOptions(SIDECARS, STREAMS)), {
    selected: { ja: 'f0', zh: 'f1' },
    fallback: [],
  });

  const noSimplified = buildSubtitleOptions([sidecar('.tc.ass', 'zh-Hant')], [stream(13, 'ass', 'chi', 'Simplified')]);
  assert.equal(selectSubtitles(noSimplified).selected.zh, 'f0', 'a simplified sidecar outranks a traditional one');

  const embeddedOnly = buildSubtitleOptions([], [
    stream(14, 'ass', 'chi', 'Chinese (Traditional)'),
    stream(13, 'ass', 'chi', 'Chinese (Simplified)'),
  ]);
  assert.equal(selectSubtitles(embeddedOnly).selected.zh, 's13', 'simplified embedded before traditional embedded');

  const traditionalSidecar = buildSubtitleOptions([sidecar('.tc.ass', 'zh-Hant')], [stream(13, 'ass', 'chi', 'Simplified')]);
  assert.equal(selectSubtitles(traditionalSidecar).selected.zh, 'f0', 'sidecar before embedded');

  const nothing = selectSubtitles([]);
  assert.deepEqual(nothing, { selected: { ja: null, zh: null }, fallback: [] });
});

test('a saved key selects the matching option and follows it across episodes', () => {
  const options = buildSubtitleOptions(SIDECARS, STREAMS);
  const saved = {
    ja: { source: 'sidecar', suffix: '.ja.ass' },
    zh: { source: 'embedded', title: 'Chinese (Traditional)', language: 'chi', codec: 'ass' },
  } as const;
  assert.deepEqual(selectSubtitles(options, saved), {
    selected: { ja: 'f0', zh: 's14' },
    fallback: [],
  });

  const nextEpisode = buildSubtitleOptions([], [stream(5, 'ass', 'chi', 'Chinese (Traditional)')]);
  assert.equal(selectSubtitles(nextEpisode, saved).selected.zh, 's5');
});

test('off clears a slot, a missing match falls back to the default', () => {
  const options = buildSubtitleOptions(SIDECARS, STREAMS);
  assert.deepEqual(selectSubtitles(options, { zh: 'off', ja: 'off' }), {
    selected: { ja: null, zh: null },
    fallback: [],
  });

  const missing = selectSubtitles(options, { ja: { source: 'sidecar', suffix: '.ja.srt' } });
  assert.deepEqual(missing, { selected: { ja: 'f0', zh: 'f1' }, fallback: ['ja'] });

  const noOptions = selectSubtitles([], { zh: { source: 'embedded', title: 'x', language: 'chi', codec: 'ass' } });
  assert.deepEqual(noOptions, { selected: { ja: null, zh: null }, fallback: ['zh'] });
});

test('a saved key only matches options of its own slot', () => {
  const options = buildSubtitleOptions(SIDECARS, STREAMS);
  const asJapanese = { source: 'sidecar', suffix: '.sc.ass' } as const;
  const selection = selectSubtitles(options, { ja: asJapanese });
  assert.equal(selection.selected.ja, 'f0');
  assert.deepEqual(selection.fallback, ['ja']);
});
