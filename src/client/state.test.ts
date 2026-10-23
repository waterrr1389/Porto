import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cue } from '../core/subtitles.ts';
import {
  MAX_DUPLICATE_TERMS,
  MAX_LOOKUP_LENGTH,
  type EpisodeResponse,
  type LibraryResponse,
  type LookupResponse,
  type SubtitleOption,
  type TermEntry,
} from '../shared/api.ts';
import {
  CONTROLS_HIDE_MS,
  SAVE_PROGRESS_MS,
  STALL_MS,
  initialState,
  reduce,
  type Action,
  type Effect,
  type State,
} from './state.ts';

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

const episode = { video: '/v.mp4' };
const opened = run(initialState, { type: 'episodeOpened', episode }).state;
const playing = run(opened, { type: 'videoPlayed' }).state;

/** Simulates a subtitle fetch response from the state's current request. */
function loadCues(state: State, slot: 'ja' | 'zh', cues: Cue[]): State {
  return reduce(state, {
    type: 'subtitlesLoaded',
    slot,
    optionId: `test-${slot}`,
    requestId: state.subtitleRequest[slot],
    cues,
  }).state;
}

test('opening an episode loads its video', () => {
  const { state, effects } = run(initialState, { type: 'episodeOpened', episode });
  assert.equal(state.episode, episode);
  assert.deepEqual(effects, [{ type: 'loadVideo', url: '/v.mp4' }]);
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

test('stepping between lines seeks to the line start', () => {
  const withCues = loadCues(playing, 'ja', [
    { id: 0, start: 10, end: 12, text: 'a' },
    { id: 1, start: 20, end: 22, text: 'b' },
  ]);
  const next = reduce(withCues, { type: 'cueStepRequested', direction: 1, time: 11 });
  assert.deepEqual(next.effects[0], { type: 'seek', time: 20 });
  const past = reduce(withCues, { type: 'cueStepRequested', direction: 1, time: 25 });
  assert.equal(past.effects.some((e) => e.type === 'seek'), false);
});

test('holding speeds up playback only while playing', () => {
  const held = reduce(playing, { type: 'holdStarted' });
  assert.equal(held.state.fastForward, true);
  assert.deepEqual(held.effects, [{ type: 'setPlaybackRate', rate: 2 }]);
  const released = reduce(held.state, { type: 'holdEnded' });
  assert.equal(released.state.fastForward, false);
  assert.deepEqual(released.effects, [{ type: 'setPlaybackRate', rate: 1 }]);

  const paused = run(playing, { type: 'playToggled' }, { type: 'videoPaused' }).state;
  assert.equal(reduce(paused, { type: 'holdStarted' }).state.fastForward, false);
  assert.deepEqual(reduce(paused, { type: 'holdEnded' }).effects, []);
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
  const failed = reduce(opened, {
    type: 'subtitlesFailed',
    slot: 'ja',
    optionId: 'test-ja',
    requestId: opened.subtitleRequest.ja,
    message: 'HTTP 404',
  });
  assert.match(failed.state.notice ?? '', /字幕加载失败: HTTP 404/);
  assert.equal(reduce(failed.state, { type: 'timerFired', timer: 'clearNotice' }).state.notice, null);
});

// ---------------------------------------------------------------- lookups

const jaCues: Cue[] = [
  { id: 0, start: 0, end: 10, text: '日本語です' },
  { id: 1, start: 0, end: 10, text: 'あ\nい' },
  { id: 2, start: 0, end: 10, text: 'あい。' },
];
const withCues = run(
  loadCues(playing, 'ja', jaCues),
  { type: 'cuesOnScreen', track: 'ja', ids: [0] },
).state;
const responses = {
  first: { matchLength: 2, entries: [] },
  second: { matchLength: 1, entries: [] },
};

test('started fetches dictionaries once and the library, and dictionaries survive opening an episode', () => {
  assert.deepEqual(reduce(initialState, { type: 'started' }).effects, [
    { type: 'fetchDictionaries' },
    { type: 'fetchLibrary' },
  ]);

  const dictionaries = [{ title: 'A', styles: '' }];
  const loaded = run(initialState, { type: 'started' }, { type: 'dictionariesLoaded', dictionaries });
  assert.equal(loaded.state.dictionaries, dictionaries);
  assert.deepEqual(reduce(loaded.state, { type: 'started' }).effects, [{ type: 'fetchLibrary' }]);

  const reopened = run(loaded.state, { type: 'episodeOpened', episode }).state;
  assert.equal(reopened.dictionaries, dictionaries);
});

test('dictionary failures surface as a notice', () => {
  const failed = reduce(initialState, { type: 'dictionariesFailed', message: 'HTTP 500' });
  assert.match(failed.state.notice ?? '', /dictionaries failed: HTTP 500/);
});

test('tapping a character starts a lookup from that offset and pauses playback', () => {
  const step = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 1, time: 0 });
  assert.equal(step.state.lookup.seq, 1);
  assert.deepEqual(step.state.lookup.pending, { seq: 1, origin: { cueId: 0, offset: 1 } });
  assert.equal(step.state.lookup.pausedByLookup, true);
  assert.deepEqual(step.effects, [
    { type: 'lookup', seq: 1, text: '本語です' },
    { type: 'pause' },
  ]);
});

test('tapping while already paused does not pause again', () => {
  const base = run(initialState, { type: 'episodeOpened', episode }).state;
  const paused = run(loadCues(base, 'ja', jaCues), { type: 'cuesOnScreen', track: 'ja', ids: [0] }).state;
  const step = reduce(paused, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 });
  assert.deepEqual(step.effects, [{ type: 'lookup', seq: 1, text: '日本語です' }]);
  assert.equal(step.state.lookup.pausedByLookup, false);
});

test('a tap that cannot start a lookup changes nothing', () => {
  const punctuation = reduce(withCues, { type: 'characterTapped', cueId: 2, offset: 2, time: 0 });
  assert.equal(punctuation.state, withCues);
  assert.deepEqual(punctuation.effects, []);

  const unknownCue = reduce(withCues, { type: 'characterTapped', cueId: 99, offset: 0, time: 0 });
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
  const tapped = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 1, time: 0 }).state;
  const done = reduce(tapped, { type: 'lookupSucceeded', seq: 1, text: '本語です', response: responses.first });

  assert.equal(done.state.lookup.pending, null);
  assert.equal(done.state.lookup.panelOpen, true);
  assert.deepEqual(done.state.lookup.history, [{ id: 1, text: '本語です', response: responses.first, mined: {}, duplicates: {} }]);
  assert.deepEqual(done.state.lookup.highlight, { cueId: 0, start: 1, end: 3 });
  assert.deepEqual(done.state.lookup.pinnedJa, [0]);
  assert.deepEqual(done.effects, []);
});

test('a stale response is dropped while a newer lookup is pending', () => {
  const first = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 }).state;
  const second = reduce(first, { type: 'characterTapped', cueId: 0, offset: 1, time: 0 }).state;
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
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 1, time: 0 }).state,
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
  const pending = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 }).state;
  const stale = reduce(pending, { type: 'lookupFailed', seq: 0, message: 'HTTP 500' });
  assert.equal(stale.state, pending);
  assert.equal(stale.state.notice, null);

  const failed = reduce(pending, { type: 'lookupFailed', seq: 1, message: 'HTTP 500' });
  assert.equal(failed.state.lookup.pending, null);
  assert.match(failed.state.notice ?? '', /lookup failed: HTTP 500/);
});

test('panelBack pops only when there is a page to go back to', () => {
  const opened = reduce(
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 }).state,
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
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 }).state,
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
  const pending = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 }).state;
  // The panel is only open once the lookup succeeds; closing mid-flight must cancel it.
  const closed = run(pending, { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first });
  const dismissed = run(closed.state, { type: 'panelClosed' }).state;
  const late = reduce(dismissed, { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first });
  assert.equal(late.state, dismissed);
});

test('tapping the stage while the panel is open closes it instead of toggling controls', () => {
  const opened = reduce(
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 }).state,
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
    reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 }).state,
    { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first },
  ).state;
  const played = reduce(opened, { type: 'videoPlayed' }).state;
  assert.equal(played.lookup.pausedByLookup, false);
  assert.equal(played.lookup.panelOpen, true);
  assert.deepEqual(reduce(played, { type: 'panelClosed' }).effects, []);
});

// ---------------------------------------------------------------- library

const jaSidecar: SubtitleOption = {
  id: 'ja-side',
  slot: 'ja',
  label: '.ja.ass',
  source: 'sidecar',
  url: '/api/episodes/e1/subtitles/ja-side',
  format: 'ass',
};
const jaEmbedded: SubtitleOption = {
  id: 'ja-emb',
  slot: 'ja',
  label: 'Japanese (Netflix)',
  source: 'embedded',
  url: '/api/episodes/e1/subtitles/ja-emb',
  format: 'ass',
};
const zhSidecar: SubtitleOption = {
  id: 'zh-side',
  slot: 'zh',
  label: '.sc.ass',
  source: 'sidecar',
  url: '/api/episodes/e1/subtitles/zh-side',
  format: 'ass',
};
const zhEmbedded: SubtitleOption = {
  id: 'zh-emb',
  slot: 'zh',
  label: 'Chinese (Simplified)',
  source: 'embedded',
  url: '/api/episodes/e1/subtitles/zh-emb',
  format: 'ass',
};

const firstEpisode: EpisodeResponse = {
  id: 'e1',
  title: '第1话',
  seriesId: 's1',
  seriesTitle: 'Show',
  video: '/api/episodes/e1/video',
  subtitleOptions: [jaSidecar, zhSidecar, jaEmbedded, zhEmbedded],
  subtitles: { ja: jaSidecar.id, zh: zhSidecar.id },
  subtitleFallback: [],
  position: 42,
  nextEpisodeId: 'e2',
};
const secondEpisode: EpisodeResponse = {
  ...firstEpisode,
  id: 'e2',
  title: '第2话',
  position: 0,
  nextEpisodeId: null,
};
const library: LibraryResponse = {
  series: [
    {
      id: 's1',
      title: 'Show',
      episodes: [
        {
          id: 'e1',
          title: '第1话',
          languages: ['ja'],
          position: 42,
          duration: 1400,
          thumbnail: '/api/episodes/e1/thumbnail',
        },
      ],
    },
  ],
  resume: { episodeId: 'e1', seriesTitle: 'Show', episodeTitle: '第1话', position: 42 },
};

const choose = (response: EpisodeResponse, state: State = initialState): State =>
  run(
    state,
    { type: 'episodeChosen', episodeId: response.id },
    { type: 'episodeLoaded', episode: response },
  ).state;

test('the library is stored, and loading it can fail with a notice', () => {
  const loaded = run(initialState, { type: 'started' }, { type: 'libraryLoaded', library });
  assert.equal(loaded.state.library, library);

  const failed = reduce(initialState, { type: 'libraryFailed', message: 'HTTP 500' });
  assert.match(failed.state.notice ?? '', /library failed: HTTP 500/);
});

test('choosing an episode requests its detail and stays in the library meanwhile', () => {
  const step = reduce(initialState, { type: 'episodeChosen', episodeId: 'e1' });
  assert.deepEqual(step.effects, [{ type: 'fetchEpisode', id: 'e1' }]);
  assert.equal(step.state.choosingEpisodeId, 'e1');
  assert.equal(step.state.screen, 'library');
});

test('episodeLoaded builds the player state and fetches the selected subtitles', () => {
  const chosen = run(initialState, { type: 'episodeChosen', episodeId: 'e1' }).state;
  const { state, effects } = reduce(chosen, { type: 'episodeLoaded', episode: firstEpisode });

  assert.equal(state.screen, 'player');
  assert.equal(state.currentEpisode, firstEpisode);
  assert.deepEqual(state.episode, { video: '/api/episodes/e1/video' });
  assert.equal(state.pendingStartPosition, 42);
  assert.equal(state.notice, '准备中…');
  assert.equal(state.choosingEpisodeId, null);
  assert.deepEqual(state.subtitleSelection, { ja: 'ja-side', zh: 'zh-side' });
  assert.deepEqual(state.subtitleLoading, { ja: 'ja-side', zh: 'zh-side' });
  assert.deepEqual(effects, [
    { type: 'cancelTimer', timer: 'clearNotice' },
    { type: 'cancelTimer', timer: 'saveProgress' },
    { type: 'loadVideo', url: '/api/episodes/e1/video' },
    { type: 'fetchSubtitles', slot: 'ja', option: jaSidecar, requestId: 1 },
    { type: 'fetchSubtitles', slot: 'zh', option: zhSidecar, requestId: 2 },
  ]);
});

test('an episodeLoaded response for a no-longer-chosen episode is ignored', () => {
  const chosen = run(
    initialState,
    { type: 'episodeChosen', episodeId: 'e1' },
    { type: 'episodeChosen', episodeId: 'e2' },
  ).state;
  const stale = reduce(chosen, { type: 'episodeLoaded', episode: firstEpisode });
  assert.equal(stale.state, chosen);
  assert.deepEqual(stale.effects, []);

  const fresh = reduce(chosen, { type: 'episodeLoaded', episode: secondEpisode });
  assert.equal(fresh.state.currentEpisode?.id, 'e2');
});

test('episode failures clear the choice and notify', () => {
  const chosen = run(initialState, { type: 'episodeChosen', episodeId: 'e1' }).state;
  const failed = reduce(chosen, { type: 'episodeFailed', message: 'HTTP 404' });
  assert.equal(failed.state.choosingEpisodeId, null);
  assert.match(failed.state.notice ?? '', /episode failed: HTTP 404/);
});

test('the saved position is applied once on the first metadata load', () => {
  const loaded = choose(firstEpisode);
  const first = reduce(loaded, { type: 'videoMetadataLoaded' });
  assert.deepEqual(first.effects, [{ type: 'seek', time: 42 }]);
  assert.equal(first.state.pendingStartPosition, null);
  assert.equal(first.state.notice, null);

  const second = reduce(first.state, { type: 'videoMetadataLoaded' });
  assert.deepEqual(second.effects, []);
  assert.equal(second.state, first.state);
});

test('playback starts the periodic progress timer, which keeps running while playing', () => {
  const playingEpisode = reduce(choose(firstEpisode), { type: 'videoPlayed' });
  assert.ok(
    playingEpisode.effects.some(
      (effect) => effect.type === 'startTimer' && effect.timer === 'saveProgress' && effect.ms === SAVE_PROGRESS_MS,
    ),
  );

  const tick = reduce(playingEpisode.state, { type: 'timerFired', timer: 'saveProgress' });
  assert.deepEqual(tick.effects, [
    { type: 'saveProgress', episodeId: 'e1' },
    { type: 'startTimer', timer: 'saveProgress', ms: SAVE_PROGRESS_MS },
  ]);

  const paused = run(playingEpisode.state, { type: 'videoPaused' }).state;
  assert.deepEqual(reduce(paused, { type: 'timerFired', timer: 'saveProgress' }).effects, []);
});

test('pausing saves progress only when an episode is loaded from the library', () => {
  const playingEpisode = run(choose(firstEpisode), { type: 'videoPlayed' }).state;
  const paused = reduce(playingEpisode, { type: 'videoPaused' });
  assert.ok(paused.effects.some((effect) => effect.type === 'saveProgress' && effect.episodeId === 'e1'));
  assert.ok(paused.effects.some((effect) => effect.type === 'cancelTimer' && effect.timer === 'saveProgress'));

  const oldFlow = run(opened, { type: 'videoPlayed' }).state;
  assert.ok(!reduce(oldFlow, { type: 'videoPaused' }).effects.some((effect) => effect.type === 'saveProgress'));
});

test('going back saves progress, pauses and reloads the library', () => {
  const playingEpisode = run(
    loadCues(choose(firstEpisode), 'ja', jaCues),
    { type: 'cuesOnScreen', track: 'ja', ids: [0] },
    { type: 'videoPlayed' },
    { type: 'characterTapped', cueId: 0, offset: 0, time: 0 },
    { type: 'lookupSucceeded', seq: 1, text: '日本語です', response: responses.first },
  ).state;
  assert.equal(playingEpisode.lookup.panelOpen, true);

  const step = reduce(playingEpisode, { type: 'backToLibrary' });
  assert.equal(step.state.screen, 'library');
  assert.equal(step.state.wantsPlay, false);
  assert.equal(step.state.lookup.panelOpen, false);
  assert.deepEqual(step.effects, [
    { type: 'pause' },
    { type: 'saveProgress', episodeId: 'e1' },
    { type: 'cancelTimer', timer: 'saveProgress' },
    { type: 'fetchLibrary' },
  ]);

  assert.equal(reduce(initialState, { type: 'backToLibrary' }).state, initialState);
});

test('the next episode saves progress and requests that episode', () => {
  const playingEpisode = choose(firstEpisode);
  const next = reduce(playingEpisode, { type: 'nextEpisodeRequested' });
  assert.deepEqual(next.effects, [
    { type: 'saveProgress', episodeId: 'e1' },
    { type: 'fetchEpisode', id: 'e2' },
  ]);
  assert.equal(next.state.choosingEpisodeId, 'e2');

  const loadedNext = reduce(next.state, { type: 'episodeLoaded', episode: secondEpisode });
  assert.equal(loadedNext.state.currentEpisode?.id, 'e2');
  assert.equal(loadedNext.state.pendingStartPosition, 0);

  const last = choose(secondEpisode);
  assert.deepEqual(reduce(last, { type: 'nextEpisodeRequested' }).effects, []);
});

test('a late next-episode response after going back is ignored', () => {
  const next = reduce(choose(firstEpisode), { type: 'nextEpisodeRequested' }).state;
  assert.equal(next.choosingEpisodeId, 'e2');
  const back = reduce(next, { type: 'backToLibrary' }).state;
  assert.equal(back.choosingEpisodeId, null);
  const late = reduce(back, { type: 'episodeLoaded', episode: secondEpisode });
  assert.equal(late.state, back);
  assert.deepEqual(late.effects, []);
});

test('the end of an episode saves progress and hints at the next one without autoplay', () => {
  const playingEpisode = run(choose(firstEpisode), { type: 'videoPlayed' }).state;
  const ended = reduce(playingEpisode, { type: 'videoEnded' });
  assert.equal(ended.state.wantsPlay, false);
  assert.deepEqual(ended.state.onScreen, playingEpisode.onScreen);
  assert.match(ended.state.notice ?? '', /本集结束/);
  assert.ok(ended.effects.some((effect) => effect.type === 'saveProgress' && effect.episodeId === 'e1'));
  assert.ok(!ended.effects.some((effect) => effect.type === 'play'));

  const last = run(choose(secondEpisode), { type: 'videoMetadataLoaded' }, { type: 'videoPlayed' }).state;
  const lastEnded = reduce(last, { type: 'videoEnded' });
  assert.equal(lastEnded.state.notice, null);
  assert.ok(lastEnded.effects.some((effect) => effect.type === 'saveProgress' && effect.episodeId === 'e2'));
});

// ---------------------------------------------------------------- mining

const termEntry: TermEntry = {
  headwords: [{ term: '日本語', reading: 'にほんご' }],
  inflections: ['-た'],
  frequencies: [{ dictionary: 'JPDB', value: '900' }],
  pitches: [1],
  definitions: [{ dictionary: '大辞泉', glossary: [{ type: 'text', text: 'Japanese language' }] }],
};
const secondTermEntry: TermEntry = {
  ...termEntry,
  headwords: [{ term: '国語', reading: 'こくご' }],
};
const mineResponse: LookupResponse = {
  matchLength: 2,
  entries: [termEntry, secondTermEntry],
};
const definitions = [{ dictionary: '大辞泉', html: '<li>Japanese language</li>' }];

const miningReady = (() => {
  const loaded = choose(firstEpisode);
  return run(
    loadCues(loaded, 'ja', jaCues),
    { type: 'cuesOnScreen', track: 'ja', ids: [0] },
    { type: 'characterTapped', cueId: 0, offset: 1, time: 12.5 },
    { type: 'lookupSucceeded', seq: 1, text: '本語です', response: mineResponse },
  ).state;
})();

function createCardEffect(step: { effects: Effect[] }): Extract<Effect, { type: 'createCard' }> {
  const effect = step.effects.find((candidate): candidate is Extract<Effect, { type: 'createCard' }> =>
    candidate.type === 'createCard',
  );
  assert.ok(effect, 'expected a createCard effect');
  return effect;
}

test('mining builds a card request from the origin cue, highlight and time', () => {
  const step = reduce(miningReady, { type: 'mineRequested', entryIndex: 0, definitions });

  assert.deepEqual(step.effects, [
    {
      type: 'createCard',
      entryIndex: 0,
      request: {
        episodeId: 'e1',
        term: '日本語',
        reading: 'にほんご',
        definitions,
        frequencies: [{ dictionary: 'JPDB', value: '900' }],
        pitches: [1],
        cue: { start: 0, end: 10, text: '日本語です' },
        highlight: { start: 1, end: 3 },
        time: 12.5,
      },
    },
  ]);
  assert.deepEqual(step.state.lookup.history[0]?.mined, { 0: { status: 'mining' } });
});

test('a nested lookup mines into the same origin cue and time', () => {
  const nested = run(
    miningReady,
    { type: 'definitionTapped', text: '語' },
    { type: 'lookupSucceeded', seq: 2, text: '語', response: mineResponse },
  ).state;
  assert.equal(nested.lookup.history.length, 2);

  const effect = createCardEffect(reduce(nested, { type: 'mineRequested', entryIndex: 1, definitions }));
  assert.equal(effect.request.term, '国語');
  assert.equal(effect.request.reading, 'こくご');
  assert.deepEqual(effect.request.cue, { start: 0, end: 10, text: '日本語です' });
  assert.deepEqual(effect.request.highlight, { start: 1, end: 3 });
  assert.equal(effect.request.time, 12.5);
});

test('mining is ignored without a lookup origin', () => {
  const noOrigin = run(
    initialState,
    { type: 'definitionTapped', text: '語' },
    { type: 'lookupSucceeded', seq: 1, text: '語', response: mineResponse },
  ).state;
  const step = reduce(noOrigin, { type: 'mineRequested', entryIndex: 0, definitions });
  assert.equal(step.state, noOrigin);
  assert.deepEqual(step.effects, []);

  const outOfRange = reduce(miningReady, { type: 'mineRequested', entryIndex: 9, definitions });
  assert.equal(outOfRange.state, miningReady);
  assert.deepEqual(outOfRange.effects, []);
});

test('a second tap while an entry is mining is ignored', () => {
  const first = reduce(miningReady, { type: 'mineRequested', entryIndex: 0, definitions });
  const second = reduce(first.state, { type: 'mineRequested', entryIndex: 0, definitions });
  assert.equal(second.state, first.state);
  assert.deepEqual(second.effects, []);
});

test('mining results are recorded on the entry that was mined', () => {
  const miningBoth = reduce(
    reduce(miningReady, { type: 'mineRequested', entryIndex: 0, definitions }).state,
    { type: 'mineRequested', entryIndex: 1, definitions },
  ).state;

  const minedFirst = reduce(miningBoth, {
    type: 'mineSucceeded',
    entryIndex: 0,
    response: { noteId: 7, duplicates: 2 },
  }).state;
  assert.deepEqual(minedFirst.lookup.history[0]?.mined[0], { status: 'done', noteId: 7, duplicates: 2 });
  assert.deepEqual(minedFirst.lookup.history[0]?.mined[1], { status: 'mining' });

  const failedSecond = reduce(minedFirst, { type: 'mineFailed', entryIndex: 1, message: 'Anki refused' });
  assert.deepEqual(failedSecond.state.lookup.history[0]?.mined[1], { status: 'error', message: 'Anki refused' });
});

test('results for an entry that is not mining are ignored', () => {
  const success = reduce(miningReady, { type: 'mineSucceeded', entryIndex: 0, response: { noteId: 1, duplicates: 0 } });
  assert.equal(success.state, miningReady);
  assert.deepEqual(success.effects, []);

  const failure = reduce(miningReady, { type: 'mineFailed', entryIndex: 0, message: 'no pending card' });
  assert.equal(failure.state, miningReady);
  assert.deepEqual(failure.effects, []);
});

// ---------------------------------------------------------- deck duplicates

function checkDuplicatesEffect(step: { effects: Effect[] }): Extract<Effect, { type: 'checkDuplicates' }> {
  const effect = step.effects.find((candidate): candidate is Extract<Effect, { type: 'checkDuplicates' }> =>
    candidate.type === 'checkDuplicates',
  );
  assert.ok(effect, 'expected a checkDuplicates effect');
  return effect;
}

const manyEntries: TermEntry[] = Array.from({ length: 25 }, (_, index) => ({
  ...termEntry,
  headwords: [{ term: `語${index}`, reading: '' }],
}));
const duplicateHeavyResponse: LookupResponse = {
  matchLength: 1,
  entries: [termEntry, termEntry, ...manyEntries],
};

test('a successful lookup checks the unique headword terms, capped at the API limit', () => {
  const tapped = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 }).state;
  const step = reduce(tapped, {
    type: 'lookupSucceeded',
    seq: 1,
    text: '日本語です',
    response: duplicateHeavyResponse,
  });

  const effect = checkDuplicatesEffect(step);
  assert.equal(effect.pageId, 1);
  assert.equal(effect.terms.length, MAX_DUPLICATE_TERMS);
  assert.deepEqual(effect.terms.slice(0, 3), ['日本語', '語0', '語1']);
  assert.equal(new Set(effect.terms).size, effect.terms.length);
  assert.equal(step.state.lookup.history[0]?.duplicates, undefined);
});

test('duplicate counts are stored on the page they belong to', () => {
  const tapped = reduce(withCues, { type: 'characterTapped', cueId: 0, offset: 0, time: 0 }).state;
  const firstPage = reduce(tapped, {
    type: 'lookupSucceeded',
    seq: 1,
    text: '日本語です',
    response: mineResponse,
  }).state;
  const nested = run(
    firstPage,
    { type: 'definitionTapped', text: '語' },
    { type: 'lookupSucceeded', seq: 2, text: '語', response: mineResponse },
  ).state;
  const [first, second] = nested.lookup.history;
  assert.ok(first !== undefined && second !== undefined);
  assert.notEqual(first.id, second.id);

  const secondChecked = reduce(nested, {
    type: 'duplicatesChecked',
    pageId: second.id,
    counts: { 日本語: 3, 国語: 1 },
  }).state;
  assert.equal(secondChecked.lookup.history[0]?.duplicates, undefined);
  assert.deepEqual(secondChecked.lookup.history[1]?.duplicates, { 日本語: 3, 国語: 1 });

  const firstChecked = reduce(secondChecked, {
    type: 'duplicatesChecked',
    pageId: first.id,
    counts: { 日本語: 1 },
  }).state;
  assert.deepEqual(firstChecked.lookup.history[0]?.duplicates, { 日本語: 1 });
  assert.deepEqual(firstChecked.lookup.history[1]?.duplicates, { 日本語: 3, 国語: 1 });
});

test('duplicate results for a page no longer in history are ignored', () => {
  const pageId = miningReady.lookup.history[0]?.id as number;
  const stale = reduce(miningReady, { type: 'duplicatesChecked', pageId: 999, counts: { 日本語: 2 } });
  assert.equal(stale.state, miningReady);
  assert.deepEqual(stale.effects, []);

  const closed = run(miningReady, { type: 'panelClosed' }).state;
  assert.deepEqual(closed.lookup.history, []);
  const late = reduce(closed, { type: 'duplicatesChecked', pageId, counts: { 日本語: 2 } });
  assert.equal(late.state, closed);
});

test('a failed duplicate check marks the page unavailable', () => {
  const pageId = miningReady.lookup.history[0]?.id as number;
  const failed = reduce(miningReady, { type: 'duplicatesFailed', pageId }).state;
  assert.equal(failed.lookup.history[0]?.duplicates, 'unavailable');

  const stale = reduce(miningReady, { type: 'duplicatesFailed', pageId: 999 });
  assert.equal(stale.state, miningReady);
});

test('creating a card bumps that term count so the badge stays consistent', () => {
  const pageId = miningReady.lookup.history[0]?.id as number;
  const checked = reduce(miningReady, {
    type: 'duplicatesChecked',
    pageId,
    counts: { 日本語: 2, 国語: 0 },
  }).state;
  const mined = reduce(
    reduce(checked, { type: 'mineRequested', entryIndex: 0, definitions }).state,
    { type: 'mineSucceeded', entryIndex: 0, response: { noteId: 5, duplicates: 2 } },
  ).state;

  assert.deepEqual(mined.lookup.history[0]?.duplicates, { 日本語: 3, 国語: 0 });
  assert.deepEqual(mined.lookup.history[0]?.mined[0], { status: 'done', noteId: 5, duplicates: 2 });
});

// ------------------------------------------------------------- subtitles

test('the initial slot selections are fetched and recorded', () => {
  const chosen = run(initialState, { type: 'episodeChosen', episodeId: 'e1' }).state;
  const { state, effects } = reduce(chosen, { type: 'episodeLoaded', episode: firstEpisode });

  const fetches = effects.filter((effect) => effect.type === 'fetchSubtitles');
  assert.deepEqual(
    fetches.map((effect) => (effect.type === 'fetchSubtitles' ? effect.slot : '')),
    ['ja', 'zh'],
  );
  assert.deepEqual(state.subtitleSelection, { ja: 'ja-side', zh: 'zh-side' });

  const jaLoaded = reduce(state, {
    type: 'subtitlesLoaded',
    slot: 'ja',
    optionId: 'ja-side',
    requestId: state.subtitleRequest.ja,
    cues: jaCues,
  }).state;
  assert.equal(jaLoaded.cues.ja.length, jaCues.length);
  assert.equal(jaLoaded.subtitleLoading.ja, null);
});

test('a slot with no selected option is not fetched', () => {
  const chosen = run(initialState, { type: 'episodeChosen', episodeId: 'e1' }).state;
  const step = reduce(chosen, {
    type: 'episodeLoaded',
    episode: { ...firstEpisode, subtitles: { ja: 'ja-side', zh: null } },
  });
  assert.deepEqual(step.state.subtitleSelection, { ja: 'ja-side', zh: null });
  assert.equal(step.effects.filter((effect) => effect.type === 'fetchSubtitles').length, 1);
});

test('a fallback subtitle selection is announced', () => {
  const chosen = run(initialState, { type: 'episodeChosen', episodeId: 'e1' }).state;

  const withOption = reduce(chosen, {
    type: 'episodeLoaded',
    episode: { ...firstEpisode, subtitleFallback: ['zh'] },
  });
  assert.match(withOption.state.notice ?? '', /未找到上次选择的字幕，已改用 \.sc\.ass/);
  assert.ok(withOption.effects.some((effect) => effect.type === 'startTimer' && effect.timer === 'clearNotice'));

  const turnedOff = reduce(chosen, {
    type: 'episodeLoaded',
    episode: {
      ...firstEpisode,
      subtitles: { ja: 'ja-side', zh: null },
      subtitleFallback: ['zh'],
    },
  });
  assert.match(turnedOff.state.notice ?? '', /已改用 关闭/);
});

test('choosing a subtitle option fetches it and remembers the choice', () => {
  const withZhCues = loadCues(choose(firstEpisode), 'zh', [{ id: 0, start: 0, end: 2, text: '中文' }]);
  const step = reduce(withZhCues, { type: 'subtitleChosen', slot: 'zh', option: 'zh-emb' });

  assert.deepEqual(step.state.cues.zh, []);
  assert.deepEqual(step.state.onScreen.zh, []);
  assert.equal(step.state.subtitleSelection.zh, 'zh-emb');
  assert.equal(step.state.subtitleLoading.zh, 'zh-emb');
  assert.deepEqual(step.effects, [
    { type: 'fetchSubtitles', slot: 'zh', option: zhEmbedded, requestId: 3 },
    { type: 'saveSubtitleChoice', seriesId: 's1', episodeId: 'e1', slot: 'zh', option: 'zh-emb' },
  ]);
});

test('a response for a superseded option is ignored', () => {
  const first = reduce(choose(firstEpisode), {
    type: 'subtitleChosen',
    slot: 'zh',
    option: 'zh-emb',
  }).state;
  const second = reduce(first, { type: 'subtitleChosen', slot: 'zh', option: 'zh-side' }).state;

  const stale = reduce(second, {
    type: 'subtitlesLoaded',
    slot: 'zh',
    optionId: 'zh-emb',
    requestId: 3,
    cues: [{ id: 0, start: 0, end: 1, text: 'stale' }],
  });
  assert.equal(stale.state, second);

  const fresh = reduce(second, {
    type: 'subtitlesLoaded',
    slot: 'zh',
    optionId: 'zh-side',
    requestId: 4,
    cues: [{ id: 0, start: 0, end: 1, text: 'fresh' }],
  }).state;
  assert.deepEqual(fresh.cues.zh.map((cue) => cue.text), ['fresh']);
  assert.equal(fresh.subtitleLoading.zh, null);
});

test('choosing off clears the slot and saves the choice', () => {
  const withZhCues = loadCues(choose(firstEpisode), 'zh', [{ id: 0, start: 0, end: 2, text: '中文' }]);
  const off = reduce(withZhCues, { type: 'subtitleChosen', slot: 'zh', option: null });

  assert.deepEqual(off.state.cues.zh, []);
  assert.deepEqual(off.state.onScreen.zh, []);
  assert.equal(off.state.subtitleSelection.zh, null);
  assert.equal(off.state.subtitleLoading.zh, null);
  assert.deepEqual(off.effects, [
    { type: 'saveSubtitleChoice', seriesId: 's1', episodeId: 'e1', slot: 'zh', option: null },
  ]);
});

test('changing the Japanese subtitle keeps lookups on the new cues', () => {
  const chosen = reduce(choose(firstEpisode), { type: 'subtitleChosen', slot: 'ja', option: 'ja-emb' });
  const loaded = reduce(chosen.state, {
    type: 'subtitlesLoaded',
    slot: 'ja',
    optionId: 'ja-emb',
    requestId: chosen.state.subtitleRequest.ja,
    cues: [{ id: 0, start: 0, end: 9, text: '新しい字幕' }],
  }).state;

  const tap = reduce(loaded, { type: 'characterTapped', cueId: 0, offset: 0, time: 1 });
  assert.deepEqual(tap.effects, [{ type: 'lookup', seq: 1, text: '新しい字幕' }]);
});

test('a subtitle choice that cannot be saved shows a notice', () => {
  const failed = reduce(choose(firstEpisode), { type: 'subtitleChoiceFailed' });
  assert.equal(failed.state.notice, '字幕选择未能保存');
});

test('a subtitle response from the previous episode is ignored', () => {
  const first = choose(firstEpisode);
  const withChoice = reduce(first, { type: 'subtitleChosen', slot: 'ja', option: 'ja-emb' }).state;
  const next = run(
    reduce(withChoice, { type: 'nextEpisodeRequested' }).state,
    { type: 'episodeLoaded', episode: secondEpisode },
  ).state;
  assert.equal(next.currentEpisode?.id, 'e2');
  assert.ok(next.subtitleRequest.ja > withChoice.subtitleRequest.ja);

  const stale = reduce(next, {
    type: 'subtitlesLoaded',
    slot: 'ja',
    optionId: 'ja-emb',
    requestId: withChoice.subtitleRequest.ja,
    cues: [{ id: 0, start: 0, end: 1, text: '旧的' }],
  });
  assert.equal(stale.state, next);
});
