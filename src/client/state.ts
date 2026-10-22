// The client's only mutable value is a State; `reduce` is the only way to get
// the next one. Anything that touches the outside world is returned as an
// Effect for effects.ts to carry out, and comes back as an Action.
//
// The <video> element owns currentTime, paused and buffering; State keeps only
// user intent and discrete values derived from the element's events.
import type { Cue } from '../core/subtitles.ts';

export type Track = 'ja' | 'zh';

export interface Episode {
  video: string;
  subtitles: Partial<Record<Track, string>>;
}

export interface State {
  episode: Episode | null;
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
}

export type Action =
  | { type: 'episodeOpened'; episode: Episode }
  | { type: 'subtitlesLoaded'; track: Track; cues: Cue[] }
  | { type: 'subtitlesFailed'; track: Track; message: string }
  | { type: 'cuesOnScreen'; track: Track; ids: number[] }
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
  cues: { ja: [], zh: [] },
  onScreen: { ja: [], zh: [] },
  wantsPlay: false,
  reloading: false,
  controlsShown: true,
  notice: null,
};

export function reduce(state: State, action: Action): Step {
  switch (action.type) {
    case 'episodeOpened': {
      const { episode } = action;
      const effects: Effect[] = [{ type: 'loadVideo', url: episode.video }];
      for (const track of ['ja', 'zh'] as const) {
        const url = episode.subtitles[track];
        if (url) effects.push({ type: 'fetchSubtitles', track, url });
      }
      return {
        state: { ...initialState, episode },
        effects,
      };
    }

    case 'subtitlesLoaded':
      return only({ ...state, cues: { ...state.cues, [action.track]: action.cues } });

    case 'subtitlesFailed':
      return notify(state, `${action.track} subtitles failed: ${action.message}`);

    case 'cuesOnScreen':
      if (sameIds(state.onScreen[action.track], action.ids)) return only(state);
      return only({ ...state, onScreen: { ...state.onScreen, [action.track]: action.ids } });

    case 'stageTapped':
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
      return showControls({ ...state, wantsPlay: true });

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
