import { test } from 'node:test';
import assert from 'node:assert/strict';
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
