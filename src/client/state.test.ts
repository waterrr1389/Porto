import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cue } from '../core/subtitles.ts';
import { MAX_LOOKUP_LENGTH } from '../shared/api.ts';
import { CONTROLS_HIDE_MS, STALL_MS, initialState, reduce, type Action, type Effect, type State } from './state.ts';

/** Applies actions in order, collecting every effect. */
function run(state: State, ...actions: Action[]): { state: State; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const action of actions) {
    const step = reduce(state, action);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const episode = { video: '/v.mp4', subtitles: { ja: '/v.ja.ass', zh: '/v.sc.ass' } };
const opened = run(initialState, { type: 'episodeOpened', episode }).state;
const playing = run(opened, { type: 'videoPlayed' }).state;

test('opening an episode loads the video and both subtitle tracks', () => {
  const { state, effects } = run(initialState, { type: 'episodeOpened', episode });
  assert.equal(state.episode, episode);
  assert.deepEqual(effects, [
    { type: 'loadVideo', url: '/v.mp4' },
    { type: 'fetchSubtitles', track: 'ja', url: '/v.ja.ass' },
    { type: 'fetchSubtitles', track: 'zh', url: '/v.sc.ass' },
  ]);
});

test('on-screen cue changes update state only when the ids differ', () => {
  const changed = reduce(opened, { type: 'cuesOnScreen', track: 'ja', ids: [3] });
  assert.deepEqual(changed.state.onScreen.ja, [3]);
  const same = reduce(changed.state, { type: 'cuesOnScreen', track: 'ja', ids: [3] });
  assert.equal(same.state, changed.state);
});

test('play toggling follows intent, not a stored paused flag', () => {
  assert.deepEqual(reduce(opened, { type: 'playToggled' }).effects, [{ type: 'play' }]);
  assert.deepEqual(reduce(playing, { type: 'playToggled' }).effects, [{ type: 'pause' }]);
});

test('controls hide after a delay only while playing', () => {
  assert.ok(
    reduce(opened, { type: 'videoPlayed' }).effects.some(
      (e) => e.type === 'startTimer' && e.timer === 'hideControls' && e.ms === CONTROLS_HIDE_MS,
    ),
  );
  assert.equal(reduce(playing, { type: 'timerFired', timer: 'hideControls' }).state.controlsShown, false);
  const paused = run(playing, { type: 'videoPaused' }).state;
  assert.equal(reduce(paused, { type: 'timerFired', timer: 'hideControls' }).state.controlsShown, true);
});

test('tapping the stage toggles the controls', () => {
  const hidden = reduce(playing, { type: 'stageTapped' }).state;
  assert.equal(hidden.controlsShown, false);
  assert.equal(reduce(hidden, { type: 'stageTapped' }).state.controlsShown, true);
});

test('seeking is an effect and shows the controls', () => {
  const hidden = reduce(playing, { type: 'stageTapped' }).state;
  const step = reduce(hidden, { type: 'seekRequested', time: 600 });
  assert.equal(step.effects[0]?.type, 'seek');
  assert.equal(step.state.controlsShown, true);
});

test('a media error reloads and resumes only if playing before', () => {
  const failed = run(playing, { type: 'videoErrored', code: 2 });
  assert.ok(failed.effects.some((e) => e.type === 'reloadVideo'));
  assert.equal(failed.state.reloading, true);
  // The reload pauses the element; that must not cancel the intent to play.
  const resumed = run(failed.state, { type: 'videoPaused' }, { type: 'videoMetadataLoaded' });
  assert.deepEqual(resumed.effects, [{ type: 'play' }]);
  assert.equal(resumed.state.reloading, false);

  const pausedFailed = run(opened, { type: 'videoErrored', code: 2 }, { type: 'videoMetadataLoaded' });
  assert.ok(!pausedFailed.effects.some((e) => e.type === 'play'));
});

test('waiting reloads only after the stall timeout with too little data', () => {
  const waiting = reduce(playing, { type: 'videoWaiting' });
  assert.deepEqual(waiting.effects, [{ type: 'startTimer', timer: 'stall', ms: STALL_MS }]);
  assert.deepEqual(reduce(playing, { type: 'videoProgressing' }).effects, [{ type: 'cancelTimer', timer: 'stall' }]);
  assert.deepEqual(reduce(playing, { type: 'timerFired', timer: 'stall' }).effects, [{ type: 'checkStall' }]);
  assert.equal(reduce(playing, { type: 'stallChecked', readyState: 3 }).effects.length, 0);
  assert.ok(reduce(playing, { type: 'stallChecked', readyState: 2 }).effects.some((e) => e.type === 'reloadVideo'));
});

test('a second error during a reload does not stack reloads', () => {
  const failed = run(playing, { type: 'videoErrored', code: 2 }).state;
  assert.equal(reduce(failed, { type: 'videoErrored', code: 2 }).effects.length, 0);
});

test('notices clear after a timer', () => {
  const failed = run(opened, { type: 'subtitlesFailed', track: 'ja', message: 'HTTP 404' });
  assert.match(failed.state.notice ?? '', /ja subtitles failed/);
  assert.equal(reduce(failed.state, { type: 'timerFired', timer: 'clearNotice' }).state.notice, null);
});

// ---------------------------------------------------------------- lookups

const jaCues: Cue[] = [
  { id: 0, start: 0, end: 10, text: '日本語です' },
  { id: 1, start: 0, end: 10, text: 'あ\nい' },
  { id: 2, start: 0, end: 10, text: 'あい。' },
];
const withCues = run(
  playing,
  { type: 'subtitlesLoaded', track: 'ja', cues: jaCues },
  { type: 'cuesOnScreen', track: 'ja', ids: [0] },
).state;
const responses = {
  first: { matchLength: 2, entries: [] },
  second: { matchLength: 1, entries: [] },
};

test('started fetches dictionaries once, and they survive opening an episode', () => {
  assert.deepEqual(reduce(initialState, { type: 'started' }).effects, [{ type: 'fetchDictionaries' }]);

  const dictionaries = [{ title: 'A', styles: '' }];
  const loaded = run(initialState, { type: 'started' }, { type: 'dictionariesLoaded', dictionaries });
  assert.equal(loaded.state.dictionaries, dictionaries);
  assert.deepEqual(reduce(loaded.state, { type: 'started' }).effects, []);

  const reopened = run(loaded.state, { type: 'episodeOpened', episode }).state;
  assert.equal(reopened.dictionaries, dictionaries);
});

test('dictionary failures surface as a notice', () => {
  const failed = reduce(initialState, { type: 'dictionariesFailed', message: 'HTTP 500' });
  assert.match(failed.state.notice ?? '', /dictionaries failed: HTTP 500/);
});

test('tapping a character starts a lookup from that offset and pauses playback', () => {
  const step = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 1 });
  assert.equal(step.state.lookup.seq, 1);
  assert.deepEqual(step.state.lookup.pending, { seq: 1, origin: { cueId: 0, offset: 1 } });
  assert.equal(step.state.lookup.pausedByLookup, true);
  assert.deepEqual(step.effects, [
    { type: 'lookup', seq: 1, text: '本語です' },
    { type: 'pause' },
  ]);
});

test('tapping while already paused does not pause again', () => {
  const paused = run(
    initialState,
    { type: 'episodeOpened', episode },
    { type: 'subtitlesLoaded', track: 'ja', cues: jaCues },
    { type: 'cuesOnScreen', track: 'ja', ids: [0] },
  ).state;
  const step = reduce(paused, { type: 'characterTapped', cueId: 0, offset: 0 });
  assert.deepEqual(step.effects, [{ type: 'lookup', seq: 1, text: '日本語です' }]);
  assert.equal(step.state.lookup.pausedByLookup, false);
});

test('a tap that cannot start a lookup changes nothing', () => {
  const punctuation = reduce(withCues, { type: 'characterTapped', cueId: 2, offset: 2 });
  assert.equal(punctuation.state, withCues);
  assert.deepEqual(punctuation.effects, []);

  const unknownCue = reduce(withCues, { type: 'characterTapped', cueId: 99, offset: 0 });
  assert.equal(unknownCue.state, withCues);
  assert.deepEqual(unknownCue.effects, []);
});

test('a definition tap starts a nested lookup with the text capped at the API limit', () => {
  const text = 'あ'.repeat(MAX_LOOKUP_LENGTH + 10);
  const step = reduce(withCues, { type: 'definitionTapped', text });
  assert.deepEqual(step.effects, [{ type: 'lookup', seq: 1, text: 'あ'.repeat(MAX_LOOKUP_LENGTH) }]);
  assert.deepEqual(step.state.lookup.pending, { seq: 1, origin: null });
  assert.equal(step.state.lookup.pausedByLookup, false);
});

test('a successful character lookup opens the panel, pins the line and highlights the match', () => {
  const tapped = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 1 }).state;
  const done = reduce(tapped, { type: 'lookupSucceeded', seq: 1, text: '本語です', response: responses.first });

  assert.equal(done.state.lookup.pending, null);
  assert.equal(done.state.lookup.panelOpen, true);
  assert.deepEqual(done.state.lookup.history, [{ text: '本語です', response: responses.first }]);
  assert.deepEqual(done.state.lookup.highlight, { cueId: 0, start: 1, end: 3 });
  assert.deepEqual(done.state.lookup.pinnedJa, [0]);
  assert.deepEqual(done.effects, []);
});

test('a stale response is dropped while a newer lookup is pending', () => {
  const first = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0 }).state;
  const second = reduce(first, { type: 'characterTapped', cueId: 0, offset: 1 }).state;
  const stale = reduce(second, { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first });
  assert.equal(stale.state, second);
  assert.deepEqual(stale.effects, []);

  const fresh = reduce(second, { type: 'lookupSucceeded', seq: 2, text: '本語です', response: responses.second }).state;
  assert.equal(fresh.lookup.panelOpen, true);
  assert.deepEqual(fresh.lookup.history[0]?.text, '本語です');
});

test('a response with no pending lookup is dropped', () => {
  const step = reduce(withCues, { type: 'lookupSucceeded', seq: 1, text: '日本語', response: responses.first });
  assert.equal(step.state, withCues);
  assert.deepEqual(step.effects, []);
});

test('nested lookups push pages and keep the highlight and pinned line', () => {
  const opened = reduce(
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 1 }).state,
    { type: 'lookupSucceeded', seq: 1, text: '本語です', response: responses.first },
  ).state;
  const nestedPending = reduce(opened, { type: 'definitionTapped', text: '語' }).state;
  const nested = reduce(nestedPending, {
    type: 'lookupSucceeded',
    seq: 2,
    text: '語',
    response: responses.second,
  }).state;

  assert.equal(nested.lookup.history.length, 2);
  assert.deepEqual(nested.lookup.history.map((page) => page.text), ['本語です', '語']);
  assert.deepEqual(nested.lookup.highlight, { cueId: 0, start: 1, end: 3 });
  assert.deepEqual(nested.lookup.pinnedJa, [0]);
  assert.equal(nested.lookup.panelOpen, true);
});

test('lookup failures notify only for the newest request', () => {
  const pending = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0 }).state;
  const stale = reduce(pending, { type: 'lookupFailed', seq: 0, message: 'HTTP 500' });
  assert.equal(stale.state, pending);
  assert.equal(stale.state.notice, null);

  const failed = reduce(pending, { type: 'lookupFailed', seq: 1, message: 'HTTP 500' });
  assert.equal(failed.state.lookup.pending, null);
  assert.match(failed.state.notice ?? '', /lookup failed: HTTP 500/);
});

test('panelBack pops only when there is a page to go back to', () => {
  const opened = reduce(
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0 }).state,
    { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first },
  ).state;
  assert.equal(reduce(opened, { type: 'panelBack' }).state, opened);

  const nested = reduce(
    reduce(reduce(opened, { type: 'definitionTapped', text: '語' }).state, {
      type: 'lookupSucceeded',
      seq: 2,
      text: '語',
      response: responses.second,
    }).state,
    { type: 'panelBack' },
  ).state;
  assert.deepEqual(nested.lookup.history.map((page) => page.text), ['日本語です']);
});

test('closing the panel resets it and resumes only when the lookup paused playback', () => {
  const opened = reduce(
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0 }).state,
    { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first },
  ).state;

  const closed = reduce(opened, { type: 'panelClosed' });
  assert.equal(closed.state.lookup.panelOpen, false);
  assert.deepEqual(closed.state.lookup.history, []);
  assert.equal(closed.state.lookup.highlight, null);
  assert.equal(closed.state.lookup.pinnedJa, null);
  assert.equal(closed.state.lookup.pausedByLookup, false);
  assert.deepEqual(closed.effects, [{ type: 'play' }]);
  assert.deepEqual(reduce(closed.state, { type: 'panelClosed' }).effects, []);

  const manuallyPlaying = run(opened, { type: 'videoPlayed' }).state;
  assert.deepEqual(reduce(manuallyPlaying, { type: 'panelClosed' }).effects, []);
});

test('a late response after closing does not reopen the panel', () => {
  const pending = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0 }).state;
  // The panel is only open once the lookup succeeds; closing mid-flight must cancel it.
  const closed = run(pending, { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first });
  const dismissed = run(closed.state, { type: 'panelClosed' }).state;
  const late = reduce(dismissed, { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first });
  assert.equal(late.state, dismissed);
});

test('tapping the stage while the panel is open closes it instead of toggling controls', () => {
  const opened = reduce(
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0 }).state,
    { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first },
  ).state;
  assert.equal(opened.controlsShown, true);

  const step = reduce(opened, { type: 'stageTapped' });
  assert.equal(step.state.lookup.panelOpen, false);
  assert.equal(step.state.controlsShown, true);
  assert.deepEqual(step.effects, [{ type: 'play' }]);
});

test('manual playback while the panel is open clears pausedByLookup but keeps the panel', () => {
  const opened = reduce(
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0 }).state,
    { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first },
  ).state;
  const played = reduce(opened, { type: 'videoPlayed' }).state;
  assert.equal(played.lookup.pausedByLookup, false);
  assert.equal(played.lookup.panelOpen, true);
  assert.deepEqual(reduce(played, { type: 'panelClosed' }).effects, []);
});
