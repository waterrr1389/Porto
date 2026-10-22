// The client's only mutable value is a State; `reduce` is the only way to get
// the next one. Anything that touches the outside world is returned as an
// Effect for effects.ts to carry out, and comes back as an Action.
//
// The <video> element owns currentTime, paused and buffering; State keeps only
// user intent and discrete values derived from the element's events.
import type { Cue } from '../core/subtitles.ts';
import { highlightRange, scanText } from '../core/scan.ts';
import { MAX_LOOKUP_LENGTH, type DictionaryInfo, type LookupResponse } from '../shared/api.ts';

export type Track = 'ja' | 'zh';

export interface Episode {
  video: string;
  subtitles: Partial<Record<Track, string>>;
}

/** Where the currently pending lookup started: a tap on this cue, or in the panel. */
export interface LookupOrigin {
  cueId: number;
  offset: number;
}

export interface LookupPending {
  seq: number;
  /** Null for a lookup started from text inside the panel. */
  origin: LookupOrigin | null;
}

export interface LookupPage {
  text: string;
  response: LookupResponse;
}

export interface LookupHighlight {
  cueId: number;
  start: number;
  end: number;
}

export interface LookupState {
  /** Sequence number of the newest request; responses with another number are stale. */
  seq: number;
  pending: LookupPending | null;
  /** Previous pages of this panel session; the last entry is on top. */
  history: LookupPage[];
  highlight: LookupHighlight | null;
  panelOpen: boolean;
  /** True when the panel paused playback and therefore resumes it on close. */
  pausedByLookup: boolean;
  /** Cue ids to keep on screen while the panel is open; null while closed. */
  pinnedJa: number[] | null;
}

export interface State {
  episode: Episode | null;
  /** Available dictionaries; kept across episodes. */
  dictionaries: DictionaryInfo[];
  cues: Record<Track, Cue[]>;
  /** Ids of the cues on screen per track, as last reported by the frame loop. */
  onScreen: Record<Track, number[]>;
  /** Whether the user wants playback running; survives source reloads. */
  wantsPlay: boolean;
  /** True from a reload until the element has metadata again. */
  reloading: boolean;
  controlsShown: boolean;
  /** Short status line, e.g. a media error; null hides it. */
  notice: string | null;
  lookup: LookupState;
}

export type Action =
  | { type: 'started' }
  | { type: 'episodeOpened'; episode: Episode }
  | { type: 'dictionariesLoaded'; dictionaries: DictionaryInfo[] }
  | { type: 'dictionariesFailed'; message: string }
  | { type: 'subtitlesLoaded'; track: Track; cues: Cue[] }
  | { type: 'subtitlesFailed'; track: Track; message: string }
  | { type: 'cuesOnScreen'; track: Track; ids: number[] }
  | { type: 'characterTapped'; cueId: number; offset: number }
  | { type: 'definitionTapped'; text: string }
  | { type: 'lookupSucceeded'; seq: number; text: string; response: LookupResponse }
  | { type: 'lookupFailed'; seq: number; message: string }
  | { type: 'panelBack' }
  | { type: 'panelClosed' }
  | { type: 'stageTapped' }
  | { type: 'playToggled' }
  | { type: 'seekRequested'; time: number }
  | { type: 'fullscreenToggled' }
  | { type: 'videoPlayed' }
  | { type: 'videoPaused' }
  | { type: 'videoWaiting' }
  | { type: 'videoProgressing' }
  | { type: 'videoErrored'; code: number | null }
  | { type: 'videoMetadataLoaded' }
  | { type: 'stallChecked'; readyState: number }
  | { type: 'timerFired'; timer: Timer };

export type Timer = 'hideControls' | 'stall' | 'clearNotice';

export type Effect =
  | { type: 'loadVideo'; url: string }
  | { type: 'fetchSubtitles'; track: Track; url: string }
  | { type: 'fetchDictionaries' }
  | { type: 'lookup'; seq: number; text: string }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  /** Reload the source keeping the element's current position. */
  | { type: 'reloadVideo' }
  /** Report the element's readyState as `stallChecked`. */
  | { type: 'checkStall' }
  | { type: 'toggleFullscreen' }
  | { type: 'startTimer'; timer: Timer; ms: number }
  | { type: 'cancelTimer'; timer: Timer };

export interface Step {
  state: State;
  effects: Effect[];
}

/** How long controls stay up after the last interaction while playing. */
export const CONTROLS_HIDE_MS = 3000;
/** A `waiting` longer than this without enough data reloads the source. */
export const STALL_MS = 8000;
/** readyState HAVE_FUTURE_DATA: below it the element cannot play on. */
const HAVE_FUTURE_DATA = 3;
const NOTICE_MS = 4000;

export const initialState: State = {
  episode: null,
  dictionaries: [],
  cues: { ja: [], zh: [] },
  onScreen: { ja: [], zh: [] },
  wantsPlay: false,
  reloading: false,
  controlsShown: true,
  notice: null,
  lookup: {
    seq: 0,
    pending: null,
    history: [],
    highlight: null,
    panelOpen: false,
    pausedByLookup: false,
    pinnedJa: null,
  },
};

export function reduce(state: State, action: Action): Step {
  switch (action.type) {
    case 'started':
      return { state, effects: state.dictionaries.length === 0 ? [{ type: 'fetchDictionaries' }] : [] };

    case 'episodeOpened': {
      const { episode } = action;
      const effects: Effect[] = [{ type: 'loadVideo', url: episode.video }];
      for (const track of ['ja', 'zh'] as const) {
        const url = episode.subtitles[track];
        if (url) effects.push({ type: 'fetchSubtitles', track, url });
      }
      const lookup = initialState.lookup;
      return {
        state: { ...initialState, episode, dictionaries: state.dictionaries, lookup },
        effects,
      };
    }

    case 'dictionariesLoaded':
      return only({ ...state, dictionaries: action.dictionaries });

    case 'dictionariesFailed':
      return notify(state, `dictionaries failed: ${action.message}`);

    case 'subtitlesLoaded':
      return only({ ...state, cues: { ...state.cues, [action.track]: action.cues } });

    case 'subtitlesFailed':
      return notify(state, `${action.track} subtitles failed: ${action.message}`);

    case 'cuesOnScreen':
      if (sameIds(state.onScreen[action.track], action.ids)) return only(state);
      return only({ ...state, onScreen: { ...state.onScreen, [action.track]: action.ids } });

    case 'characterTapped':
      return tapCharacter(state, action.cueId, action.offset);

    case 'definitionTapped': {
      const text = action.text.slice(0, MAX_LOOKUP_LENGTH);
      if (text === '') return only(state);
      const seq = state.lookup.seq + 1;
      return {
        state: { ...state, lookup: { ...state.lookup, seq, pending: { seq, origin: null } } },
        effects: [{ type: 'lookup', seq, text }],
      };
    }

    case 'lookupSucceeded':
      return acceptLookup(state, action.seq, action.text, action.response);

    case 'lookupFailed': {
      const { lookup } = state;
      if (lookup.pending === null || action.seq !== lookup.seq) return only(state);
      return notify({ ...state, lookup: { ...lookup, pending: null } }, `lookup failed: ${action.message}`);
    }

    case 'panelBack': {
      const { lookup } = state;
      if (lookup.history.length < 2) return only(state);
      return only({ ...state, lookup: { ...lookup, history: lookup.history.slice(0, -1) } });
    }

    case 'panelClosed':
      return closePanel(state);

    case 'stageTapped':
      if (state.lookup.panelOpen) return closePanel(state);
      if (state.controlsShown) {
        return { state: { ...state, controlsShown: false }, effects: [{ type: 'cancelTimer', timer: 'hideControls' }] };
      }
      return showControls(state);

    case 'playToggled':
      return { state, effects: [{ type: state.wantsPlay ? 'pause' : 'play' }] };

    case 'seekRequested': {
      const shown = showControls(state);
      return { state: shown.state, effects: [{ type: 'seek', time: action.time }, ...shown.effects] };
    }

    case 'fullscreenToggled':
      return { state, effects: [{ type: 'toggleFullscreen' }] };

    case 'videoPlayed':
      // Playing means the user took over; closing the panel must not pause again.
      return showControls({ ...state, wantsPlay: true, lookup: { ...state.lookup, pausedByLookup: false } });

    case 'videoPaused':
      // Reloading pauses the element; that is not the user's intent.
      if (state.reloading) return only(state);
      return {
        state: { ...state, wantsPlay: false, controlsShown: true },
        effects: [{ type: 'cancelTimer', timer: 'hideControls' }],
      };

    case 'videoWaiting':
      return { state, effects: [{ type: 'startTimer', timer: 'stall', ms: STALL_MS }] };

    case 'videoProgressing':
      return { state, effects: [{ type: 'cancelTimer', timer: 'stall' }] };

    case 'videoErrored':
      if (state.reloading) return only(state);
      return reload(state, `media error ${action.code ?? '?'}, reloading`);

    case 'videoMetadataLoaded':
      if (!state.reloading) return only(state);
      return { state: { ...state, reloading: false }, effects: state.wantsPlay ? [{ type: 'play' }] : [] };

    case 'stallChecked':
      if (state.reloading || action.readyState >= HAVE_FUTURE_DATA) return only(state);
      return reload(state, 'playback stalled, reloading');

    case 'timerFired':
      switch (action.timer) {
        case 'hideControls':
          return only(state.wantsPlay ? { ...state, controlsShown: false } : state);
        case 'stall':
          return { state, effects: [{ type: 'checkStall' }] };
        case 'clearNotice':
          return only({ ...state, notice: null });
      }
  }
}

const only = (state: State): Step => ({ state, effects: [] });

function showControls(state: State): Step {
  return {
    state: state.controlsShown ? state : { ...state, controlsShown: true },
    effects: state.wantsPlay ? [{ type: 'startTimer', timer: 'hideControls', ms: CONTROLS_HIDE_MS }] : [],
  };
}

function notify(state: State, notice: string): Step {
  return { state: { ...state, notice }, effects: [{ type: 'startTimer', timer: 'clearNotice', ms: NOTICE_MS }] };
}

function reload(state: State, notice: string): Step {
  const notified = notify({ ...state, reloading: true }, notice);
  return {
    state: notified.state,
    effects: [{ type: 'cancelTimer', timer: 'stall' }, { type: 'reloadVideo' }, ...notified.effects],
  };
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** A tap on a Japanese character: the scan text decides whether there is a lookup at all. */
function tapCharacter(state: State, cueId: number, offset: number): Step {
  const cue = state.cues.ja.find((candidate) => candidate.id === cueId);
  if (cue === undefined) return only(state);
  const text = scanText(cue.text, offset);
  if (text === null) return only(state);

  const seq = state.lookup.seq + 1;
  const effects: Effect[] = [{ type: 'lookup', seq, text }];
  if (state.wantsPlay) effects.push({ type: 'pause' });
  return {
    state: {
      ...state,
      lookup: {
        ...state.lookup,
        seq,
        pending: { seq, origin: { cueId, offset } },
        pausedByLookup: state.lookup.pausedByLookup || state.wantsPlay,
      },
    },
    effects,
  };
}

/**
 * Keeps a response only when it answers the newest pending request and the
 * panel still wants it; taps and closes can leave older responses in flight.
 */
function acceptLookup(state: State, seq: number, text: string, response: LookupResponse): Step {
  const { lookup } = state;
  if (lookup.pending === null || seq !== lookup.seq) return only(state);

  const page: LookupPage = { text, response };
  if (lookup.pending.origin === null) {
    return only({ ...state, lookup: { ...lookup, pending: null, history: [...lookup.history, page] } });
  }

  const { cueId, offset } = lookup.pending.origin;
  const cue = state.cues.ja.find((candidate) => candidate.id === cueId);
  const range = cue === undefined ? null : highlightRange(cue.text, offset, response.matchLength);
  return only({
    ...state,
    lookup: {
      ...lookup,
      pending: null,
      history: [page],
      highlight: range === null ? null : { cueId, ...range },
      panelOpen: true,
      pinnedJa: [...state.onScreen.ja],
    },
  });
}

/**
 * Closing drops pending work too: a response that arrives afterwards must not
 * reopen the panel the user just dismissed.
 */
function closePanel(state: State): Step {
  const { lookup } = state;
  if (!lookup.panelOpen) return only(state);
  return {
    state: {
      ...state,
      lookup: {
        ...lookup,
        pending: null,
        history: [],
        highlight: null,
        panelOpen: false,
        pausedByLookup: false,
        pinnedJa: null,
      },
    },
    effects: lookup.pausedByLookup ? [{ type: 'play' }] : [],
  };
}

