import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateQuery, lapisCard, type CardInput } from './card.ts';

const LAPIS_FIELDS = [
  'Expression',
  'ExpressionFurigana',
  'ExpressionReading',
  'ExpressionAudio',
  'SelectionText',
  'MainDefinition',
  'DefinitionPicture',
  'Sentence',
  'SentenceFurigana',
  'SentenceAudio',
  'Picture',
  'Glossary',
  'Hint',
  'IsWordAndSentenceCard',
  'IsClickCard',
  'IsSentenceCard',
  'IsAudioCard',
  'PitchPosition',
  'PitchCategories',
  'Frequency',
  'FreqSort',
  'MiscInfo',
];

const BASE: CardInput = {
  term: '自腹',
  reading: 'じばら',
  definitions: [
    { dictionary: '明鏡日汉双解辞典', html: '<span>自分で金を払うこと。</span>' },
    { dictionary: 'Second', html: '<b>other</b>' },
  ],
  frequencies: [
    { dictionary: 'JPDB', value: '27394' },
    { dictionary: 'Jiten (Anime)', value: '25843' },
  ],
  pitches: [0],
  cue: { start: 600.17, end: 602.18, text: 'お前は自腹だよくっつくな！' },
  highlight: { start: 3, end: 5 },
  time: 601.726,
  seriesTitle: 'BOCCHI THE ROCK!',
  episodeNumber: 8,
  episodeTitle: '',
};

function withInput(overrides: Partial<CardInput>): CardInput {
  return { ...BASE, ...overrides };
}

test('produces exactly the Lapis fields', () => {
  const { fields } = lapisCard(BASE);
  assert.deepEqual(Object.keys(fields).sort(), [...LAPIS_FIELDS].sort());
});

test('formats the expression and its reading', () => {
  assert.equal(lapisCard(BASE).fields.Expression, '自腹');
  assert.equal(lapisCard(BASE).fields.ExpressionFurigana, '自腹[じばら]');
  assert.equal(lapisCard(BASE).fields.ExpressionReading, 'じばら');

  const noReading = lapisCard(withInput({ reading: '' })).fields;
  assert.equal(noReading.ExpressionFurigana, '自腹');
  assert.equal(noReading.ExpressionReading, '自腹');

  const sameReading = lapisCard(withInput({ reading: '自腹' })).fields;
  assert.equal(sameReading.ExpressionFurigana, '自腹');
  assert.equal(sameReading.ExpressionReading, '自腹');
});

test('puts only the first dictionary in MainDefinition and all of them in Glossary', () => {
  const { fields } = lapisCard(BASE);
  assert.equal(
    fields.MainDefinition,
    '<div style="text-align: left;" class="yomitan-glossary"><ol>' +
      '<li data-dictionary="明鏡日汉双解辞典"><i>(明鏡日汉双解辞典)</i> ' +
      '<span><span>自分で金を払うこと。</span></span></li></ol></div>',
  );
  assert.equal(
    fields.Glossary,
    '<div style="text-align: left;" class="yomitan-glossary"><ol>' +
      '<li data-dictionary="明鏡日汉双解辞典"><i>(明鏡日汉双解辞典)</i> ' +
      '<span><span>自分で金を払うこと。</span></span></li>' +
      '<li data-dictionary="Second"><i>(Second)</i> <span><b>other</b></span></li>' +
      '</ol></div>',
  );

  const none = lapisCard(withInput({ definitions: [] })).fields;
  assert.equal(none.MainDefinition, '');
  assert.equal(none.Glossary, '');
});

test('escapes dictionary names in attributes and text but keeps definition html', () => {
  const fields = lapisCard(withInput({ definitions: [{ dictionary: 'A&B "x"', html: '<i>raw</i>' }] })).fields;
  assert.equal(
    fields.MainDefinition,
    '<div style="text-align: left;" class="yomitan-glossary"><ol>' +
      '<li data-dictionary="A&amp;B &quot;x&quot;"><i>(A&amp;B "x")</i> ' +
      '<span><i>raw</i></span></li></ol></div>',
  );
});

test('joins the sentence without newlines and bolds the looked-up word', () => {
  const { fields } = lapisCard(BASE);
  assert.equal(fields.Sentence, 'お前は<b>自腹</b>だよくっつくな！');

  const acrossNewline = lapisCard(
    withInput({
      cue: { start: 0, end: 1, text: 'お前は自\n腹だ' },
      highlight: { start: 3, end: 6 },
    }),
  ).fields;
  assert.equal(acrossNewline.Sentence, 'お前は<b>自腹</b>だ');
});

test('escapes sentence html before inserting the bold tags', () => {
  const { fields } = lapisCard(
    withInput({
      cue: { start: 0, end: 1, text: '<自腹>&\nだ' },
      highlight: { start: 1, end: 3 },
    }),
  );
  assert.equal(fields.Sentence, '&lt;<b>自腹</b>&gt;&amp;だ');

  const none = lapisCard(
    withInput({ cue: { start: 0, end: 1, text: 'a<b>&c' }, highlight: { start: 4, end: 4 } }),
  ).fields;
  assert.equal(none.Sentence, 'a&lt;b&gt;&amp;c');
});

test('names files after the series with a timestamp', () => {
  const { media } = lapisCard(BASE);
  assert.deepEqual(media, {
    screenshot: { time: 601.726, fileName: 'bocchitherock_10m01s726ms.jpg' },
    audio: { start: 599.92, end: 602.43, fileName: 'bocchitherock_09m59s920ms_10m02s430ms.mp3' },
  });
  assert.equal(lapisCard(BASE).fields.Picture, '<img alt="snapshot" src="bocchitherock_10m01s726ms.jpg">');
  assert.equal(
    lapisCard(BASE).fields.SentenceAudio,
    '[sound:bocchitherock_09m59s920ms_10m02s430ms.mp3]',
  );
});

test('uses total minutes and milliseconds with fixed widths', () => {
  const { media } = lapisCard(
    withInput({
      cue: { start: 3660, end: 3661, text: '' },
      time: 3661.05,
      seriesTitle: 'Long',
    }),
  );
  assert.equal(media.screenshot.fileName, 'long_61m01s050ms.jpg');
  assert.equal(media.audio.fileName, 'long_60m59s750ms_61m01s250ms.mp3');
  assert.equal(media.audio.start, 3659.75);
  assert.equal(media.audio.end, 3661.25);

  const rolled = lapisCard(withInput({ time: 59.9996, seriesTitle: 'Roll' }));
  assert.equal(rolled.media.screenshot.fileName, 'roll_01m00s000ms.jpg');
});

test('clamps the audio start at zero and honours the padding option', () => {
  const { media } = lapisCard(withInput({ cue: { start: 0.1, end: 1, text: 'あ' }, time: 0.5 }));
  assert.equal(media.audio.start, 0);
  assert.equal(media.audio.fileName, 'bocchitherock_00m00s000ms_00m01s250ms.mp3');

  const noPadding = lapisCard(withInput({ cue: { start: 2, end: 3, text: 'あ' } }), { audioPaddingS: 0 });
  assert.deepEqual(
    { start: noPadding.media.audio.start, end: noPadding.media.audio.end },
    { start: 2, end: 3 },
  );
});

test('falls back to episode when the series title has no ascii letters', () => {
  assert.equal(
    lapisCard(withInput({ seriesTitle: '日本語', term: 'x' })).media.screenshot.fileName,
    'episode_10m01s726ms.jpg',
  );
  assert.equal(
    lapisCard(withInput({ seriesTitle: 'K-On! 2' })).media.screenshot.fileName,
    'kon2_10m01s726ms.jpg',
  );
});

test('renders pitch positions and classifies the first accent', () => {
  const position = lapisCard(withInput({ pitches: [0] })).fields.PitchPosition;
  assert.equal(
    position,
    '<span style="display:inline;"><span>[</span><span>0</span><span>]</span></span>',
  );
  assert.equal(
    lapisCard(withInput({ pitches: [0, 2] })).fields.PitchPosition,
    '<span style="display:inline;"><span>[</span><span>0</span><span>]</span></span>' +
      '<span style="display:inline;"><span>[</span><span>2</span><span>]</span></span>',
  );
  assert.equal(lapisCard(withInput({ pitches: [] })).fields.PitchPosition, '');
  assert.equal(lapisCard(withInput({ pitches: [] })).fields.PitchCategories, '');

  const category = (pitch: number, reading: string) =>
    lapisCard(withInput({ pitches: [pitch], reading })).fields.PitchCategories;
  assert.equal(category(0, 'じばら'), 'heiban');
  assert.equal(category(1, 'じばら'), 'atamadaka');
  assert.equal(category(3, 'じばら'), 'odaka');
  assert.equal(category(2, 'じばら'), 'nakadaka');
  // Small kana combine with the preceding character: きょう has two morae.
  assert.equal(category(2, 'きょう'), 'odaka');
  // The prolonged mark and っ count as morae.
  assert.equal(category(4, 'コーヒー'), 'odaka');
  assert.equal(category(3, 'きって'), 'odaka');
});

test('lists frequencies and sorts by the smallest leading number', () => {
  const { fields } = lapisCard(BASE);
  assert.equal(
    fields.Frequency,
    '<ul style="text-align: left;"><li>JPDB: 27394</li><li>Jiten (Anime): 25843</li></ul>',
  );
  assert.equal(fields.FreqSort, '25843');

  const padded = lapisCard(
    withInput({
      frequencies: [
        { dictionary: 'A', value: '0012' },
        { dictionary: 'B', value: '7' },
      ],
    }),
  ).fields;
  assert.equal(padded.FreqSort, '7');

  const text = lapisCard(withInput({ frequencies: [{ dictionary: 'A&B', value: '<2>' }] })).fields;
  assert.equal(text.Frequency, '<ul style="text-align: left;"><li>A&amp;B: &lt;2&gt;</li></ul>');
  assert.equal(text.FreqSort, '');

  const none = lapisCard(withInput({ frequencies: [] })).fields;
  assert.equal(none.Frequency, '');
  assert.equal(none.FreqSort, '');
});

test('describes the episode in MiscInfo', () => {
  assert.equal(lapisCard(BASE).fields.MiscInfo, 'BOCCHI_THE_ROCK! EP08 (10m01s726ms)');
  assert.equal(
    lapisCard(withInput({ episodeNumber: null, episodeTitle: 'The Test', seriesTitle: 'A Show' })).fields.MiscInfo,
    'A_Show The Test (10m01s726ms)',
  );
  assert.equal(
    lapisCard(withInput({ episodeNumber: null, episodeTitle: '' })).fields.MiscInfo,
    'BOCCHI_THE_ROCK! (10m01s726ms)',
  );
});

test('quotes and escapes the duplicate query', () => {
  assert.equal(lapisCard(BASE).duplicateQuery, 'Expression:"自腹"');
  assert.equal(
    lapisCard(withInput({ term: 'a"b*c_d\\e' })).duplicateQuery,
    'Expression:"a\\"b\\*c\\_d\\\\e"',
  );
});

test('exports the duplicate query used by the card and the duplicate counts', () => {
  assert.equal(duplicateQuery('自腹'), 'Expression:"自腹"');
  assert.equal(duplicateQuery('a"b*c_d\\e'), 'Expression:"a\\"b\\*c\\_d\\\\e"');
  assert.equal(lapisCard(BASE).duplicateQuery, duplicateQuery(BASE.term));
});

test('leaves unused fields empty', () => {
  const { fields } = lapisCard(BASE);
  for (const name of ['ExpressionAudio', 'SelectionText', 'DefinitionPicture', 'SentenceFurigana', 'Hint']) {
    assert.equal(fields[name], '', name);
  }
  for (const name of ['IsClickCard', 'IsSentenceCard', 'IsAudioCard']) {
    assert.equal(fields[name], '', name);
  }
  assert.equal(fields.IsWordAndSentenceCard, 'X');
});
