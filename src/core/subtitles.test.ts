import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCues, parseAss, parseSrt, parseSubtitles, subtitleFormat } from './subtitles.ts';

const FORMAT = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
const DIALOGUE = 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,%s';

function ass(...dialogueLines: string[]): string {
  return ['[Script Info]', 'Title: test', '', '[Events]', FORMAT, ...dialogueLines, ''].join('\n');
}

test('parseAss reads the Format line and keeps commas in the text', () => {
  const source = [
    '[Events]',
    'Format: End, Style, Start, Text',
    'Dialogue: 0:00:02.50,Default,0:00:01.00,hello, world, again',
    '',
  ].join('\n');

  assert.deepEqual(parseAss(source), [
    { id: 0, start: 1, end: 2.5, text: 'hello, world, again' },
  ]);
});

test('parseAss falls back to the standard field order without a Format line', () => {
  const source = ['[Events]', DIALOGUE.replace('%s', 'fallback, with comma'), ''].join('\n');

  assert.deepEqual(parseAss(source), [
    { id: 0, start: 1, end: 3, text: 'fallback, with comma' },
  ]);
});

test('parseAss handles a BOM and CRLF line endings', () => {
  const source =
    '\ufeff[Events]\r\n' +
    `${FORMAT}\r\n` +
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,line one\\Nline two\r\n';

  assert.deepEqual(parseAss(source), [
    { id: 0, start: 1, end: 2, text: 'line one\nline two' },
  ]);
});

test('parseAss ignores Comment lines', () => {
  const source = ass(
    'Comment: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,not shown',
    DIALOGUE.replace('%s', 'shown'),
  );

  assert.deepEqual(parseAss(source), [{ id: 0, start: 1, end: 3, text: 'shown' }]);
});

test('parseAss drops ruby styles unless they are requested explicitly', () => {
  const source = ass(
    'Dialogue: 0,0:00:01.00,0:00:01.50,Rubi,,0,0,0,,ふりがな',
    'Dialogue: 0,0:00:01.00,0:00:01.50,Ruby Annotation,,0,0,0,,もう一つ',
    'Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,dialogue',
  );

  assert.deepEqual(parseAss(source), [{ id: 0, start: 2, end: 3, text: 'dialogue' }]);

  assert.deepEqual(parseAss(source, { styles: ['Rubi'] }), [
    { id: 0, start: 1, end: 1.5, text: 'ふりがな' },
  ]);
});

test('parseAss with an explicit style list keeps only exact matches', () => {
  const source = ass(
    DIALOGUE.replace('%s', 'default'),
    'Dialogue: 0,0:00:01.00,0:00:03.00,Sign,,0,0,0,,sign',
    'Dialogue: 0,0:00:01.00,0:00:03.00,default,,0,0,0,,lowercase',
  );

  assert.deepEqual(parseAss(source, { styles: ['Sign'] }), [
    { id: 0, start: 1, end: 3, text: 'sign' },
  ]);
  assert.deepEqual(parseAss(source, { styles: [] }), []);
});

test('parseAss drops drawing events but not position overrides', () => {
  const source = ass(
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p2\\pos(10,20)}m 0 0 l 10 10',
    'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\p0\\pos(10,20)}visible',
  );

  assert.deepEqual(parseAss(source), [{ id: 0, start: 4, end: 5, text: 'visible' }]);
});

test('parseAss cleans override blocks, escapes and blank lines', () => {
  const source = ass(
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}  spaced  {\\i0}\\N\\n\\h\\h  two  ',
    'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\i1}',
  );

  assert.deepEqual(parseAss(source), [{ id: 0, start: 1, end: 3, text: 'spaced\ntwo' }]);
});

test('parseAss stacks merged pieces by position, top to bottom', () => {
  const source = ass(
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(100,1020)}bottom',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(100,900)}top',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,unpositioned',
  );

  assert.deepEqual(parseAss(source), [
    { id: 0, start: 1, end: 3, text: 'top\nbottom\nunpositioned' },
  ]);
});

test('parseAss orders merge pieces by the first y of move and keeps file order on ties', () => {
  const source = ass(
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\move(10,700,20,800)}moving',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(10,600)}upper',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(20,600)}upper second',
  );

  assert.deepEqual(parseAss(source), [
    { id: 0, start: 1, end: 3, text: 'upper\nupper second\nmoving' },
  ]);
});

test('parseAss merges only identical start and end times', () => {
  const source = ass(
    DIALOGUE.replace('%s', 'first'),
    'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,second',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,third',
  );

  assert.deepEqual(parseAss(source), [
    { id: 0, start: 1, end: 3, text: 'first\nthird' },
    { id: 1, start: 1, end: 4, text: 'second' },
  ]);
});

test('parseAss sorts by start with stable ties and assigns ids in order', () => {
  const source = ass(
    'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,late',
    'Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,early',
    'Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,late again',
  );

  assert.deepEqual(parseAss(source), [
    { id: 0, start: 2, end: 3, text: 'early' },
    { id: 1, start: 5, end: 6, text: 'late' },
    { id: 2, start: 5, end: 7, text: 'late again' },
  ]);
});

test('parseAss ignores sections other than Events', () => {
  const source = [
    '[V4+ Styles]',
    'Format: Name, Fontname',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,outside events',
    '',
    '[Events]',
    FORMAT,
    DIALOGUE.replace('%s', 'inside'),
    '',
  ].join('\n');

  assert.deepEqual(parseAss(source), [{ id: 0, start: 1, end: 3, text: 'inside' }]);
});

test('parseSrt reads indexed blocks and strips HTML tags', () => {
  const source = [
    '1',
    '00:00:01,000 --> 00:00:02,500',
    '<i>Hello</i>',
    '',
    '2',
    '00:00:02,500 --> 00:00:04,000',
    '<font color="#ffffff">World</font>',
    'second line',
    '',
  ].join('\n');

  assert.deepEqual(parseSrt(source), [
    { id: 0, start: 1, end: 2.5, text: 'Hello' },
    { id: 1, start: 2.5, end: 4, text: 'World\nsecond line' },
  ]);
});

test('parseSrt accepts blocks without an index line and dot separators', () => {
  const source = ['00:00:01.500 --> 00:00:02.000', 'dot separator', ''].join('\n');

  assert.deepEqual(parseSrt(source), [{ id: 0, start: 1.5, end: 2, text: 'dot separator' }]);
});

test('parseSrt merges blocks that share a time span and skips empty text', () => {
  const source = [
    '1',
    '00:00:01,000 --> 00:00:03,000',
    'one',
    '',
    '2',
    '00:00:01,000 --> 00:00:03,000',
    'two',
    '',
    '3',
    '00:00:04,000 --> 00:00:05,000',
    '<i></i>',
    '',
    '4',
    'not a timing line',
    '',
  ].join('\n');

  assert.deepEqual(parseSrt(source), [{ id: 0, start: 1, end: 3, text: 'one\ntwo' }]);
});

test('parseSrt handles a BOM and CRLF line endings', () => {
  const source = '\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nline\r\n';

  assert.deepEqual(parseSrt(source), [{ id: 0, start: 1, end: 2, text: 'line' }]);
});

test('parseSrt returns an empty list for empty input', () => {
  assert.deepEqual(parseSrt(''), []);
  assert.deepEqual(parseAss(''), []);
});

test('formats come from file names and select the parser', () => {
  const assSource = ass(DIALOGUE.replace('%s', 'ass text'));
  const srtSource = ['00:00:01,000 --> 00:00:02,000', 'srt text', ''].join('\n');

  assert.equal(subtitleFormat('episode.ass'), 'ass');
  assert.equal(subtitleFormat('episode.SSA'), 'ass');
  assert.equal(subtitleFormat('episode.srt'), 'srt');
  assert.equal(subtitleFormat('episode.txt'), null);
  assert.equal(subtitleFormat('/api/episodes/1/subtitles/zh'), null);
  assert.deepEqual(parseSubtitles('ass', assSource), parseAss(assSource));
  assert.deepEqual(parseSubtitles('srt', srtSource), parseSrt(srtSource));
});

test('activeCues includes start and excludes end', () => {
  const cues = [
    { id: 0, start: 1, end: 3, text: 'a' },
    { id: 1, start: 2, end: 4, text: 'b' },
    { id: 2, start: 3, end: 3.5, text: 'c' },
    { id: 3, start: 5, end: 6, text: 'd' },
  ];

  assert.deepEqual(activeCues(cues, 0), []);
  assert.deepEqual(activeCues(cues, 1).map((cue) => cue.id), [0]);
  assert.deepEqual(activeCues(cues, 2).map((cue) => cue.id), [0, 1]);
  assert.deepEqual(activeCues(cues, 3).map((cue) => cue.id), [1, 2]);
  assert.deepEqual(activeCues(cues, 3.5).map((cue) => cue.id), [1]);
  assert.deepEqual(activeCues(cues, 4), []);
  assert.deepEqual(activeCues(cues, 5).map((cue) => cue.id), [3]);
  assert.deepEqual(activeCues(cues, 6), []);
  assert.deepEqual(activeCues([], 2), []);
});
