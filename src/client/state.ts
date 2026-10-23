// The client's only mutable value is a State; `reduce` is the only way to get
// the next one. Anything that touches the outside world is returned as an
// Effect for effects.ts to carry out, and comes back as an Action.
//
// The <video> element owns currentTime, paused and buffering; State keeps only
// user intent and discrete values derived from the element's events.
import { HOLD_RATE, cueStepTarget } from '../core/playback.ts';
import type { Cue } from '../core/subtitles.ts';
import { highlightRange, scanText } from '../core/scan.ts';
import {
  MAX_DUPLICATE_TERMS,
  MAX_LOOKUP_LENGTH,
  type CardRequest,
  type CardResponse,
  type DictionaryInfo,
  type DuplicatesResponse,
  type EpisodeResponse,
  type LibraryResponse,
  type LookupResponse,
  type SubtitleOption,
  type SubtitleSlot,
  type WordAudio,
} from '../shared/api.ts';

export type Track = SubtitleSlot;

/** The library list replaces the player until an episode is chosen. */
export type Screen = 'library' | 'player';

export interface Episode {
  video: string;
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
  /** Unique within a lookup state; duplicate-check results are matched by this. */
  id: number;
  text: string;
  response: LookupResponse;
  /** Card creation status by entry index; survives going back to this page. */
  mined: Record<number, EntryMining>;
  /** Deck counts by term; 'unavailable' when Anki could not be reached; undefined while checking. */
  duplicates?: Record<string, number> | 'unavailable';
  /** Pronunciation recordings by entry key; a missing key has not been fetched yet. */
  audio: Record<string, EntryAudio>;
}

/** Where the pronunciation lookup for one entry stands. */
export type EntryAudio =
  | { status: 'loading' }
  | { status: 'list'; sources: WordAudio[]; selected: number }
  | { status: 'unavailable' };

/** Audio state is shared by entries with the same expression and reading. */
export function entryAudioKey(term: string, reading: string): string {
  return `${term}\u0000${reading}`;
}

/** Where creating a card for one entry stands. */
export type EntryMining =
  | { status: 'mining' }
  | { status: 'done'; noteId: number; duplicates: number }
  | { status: 'error'; message: string };

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
  /** Playback time of the character tap that opened this lookup; the card screenshot time. */
  originTime: number | null;
  /** Id for the next lookup page; ids stay unique for stale duplicate-check results. */
  nextPageId: number;
}

export interface State {
  screen: Screen;
  /** The library listing; null until the first successful load. */
  library: LibraryResponse | null;
  /** Detail of the episode being played, including the next one's id. */
  currentEpisode: EpisodeResponse | null;
  /** Episode whose detail request is in flight; other responses are stale. */
  choosingEpisodeId: string | null;
  /** Saved position to seek to after the next metadata load; null once applied. */
  pendingStartPosition: number | null;
  episode: Episode | null;
  /** Every subtitle candidate of the current episode, sidecar and embedded. */
  subtitleOptions: SubtitleOption[];
  /** Selected option per slot; null means off. */
  subtitleSelection: Record<SubtitleSlot, string | null>;
  /** Identity of the newest fetch per slot; responses with older ids are stale. */
  subtitleRequest: Record<SubtitleSlot, number>;
  /** Option id currently downloading per slot; null when nothing loads. */
  subtitleLoading: Record<SubtitleSlot, string | null>;
  /** Next identity handed to a subtitle fetch. */
  nextSubtitleRequest: number;
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
  /** True while the stage is held to play faster. */
  fastForward: boolean;
  /** Short status line, e.g. a media error; null hides it. */
  notice: string | null;
  lookup: LookupState;
}

export type Action =
  | { type: 'started' }
  | { type: 'libraryLoaded'; library: LibraryResponse }
  | { type: 'libraryFailed'; message: string }
  | { type: 'episodeChosen'; episodeId: string }
  | { type: 'episodeLoaded'; episode: EpisodeResponse }
  | { type: 'episodeFailed'; message: string }
  | { type: 'backToLibrary' }
  | { type: 'nextEpisodeRequested' }
  | { type: 'videoEnded' }
  | { type: 'episodeOpened'; episode: Episode }
  | { type: 'dictionariesLoaded'; dictionaries: DictionaryInfo[] }
  | { type: 'dictionariesFailed'; message: string }
  | { type: 'subtitlesLoaded'; slot: SubtitleSlot; optionId: string; requestId: number; cues: Cue[] }
  | { type: 'subtitlesFailed'; slot: SubtitleSlot; optionId: string; requestId: number; message: string }
  | { type: 'subtitleChosen'; slot: SubtitleSlot; option: string | null }
  | { type: 'subtitleChoiceFailed' }
  | { type: 'cuesOnScreen'; track: Track; ids: number[] }
  | { type: 'characterTapped'; cueId: number; offset: number; time: number }
  | { type: 'definitionTapped'; text: string }
  | { type: 'lookupSucceeded'; seq: number; text: string; response: LookupResponse }
  | { type: 'lookupFailed'; seq: number; message: string }
  | { type: 'duplicatesChecked'; pageId: number; counts: DuplicatesResponse }
  | { type: 'duplicatesFailed'; pageId: number }
  | { type: 'mineRequested'; entryIndex: number; definitions: { dictionary: string; html: string }[] }
  | { type: 'mineSucceeded'; entryIndex: number; response: CardResponse; pageText?: string }
  | { type: 'mineFailed'; entryIndex: number; message: string }
  | { type: 'wordAudioRequested'; pageId: number; entryIndex: number }
  | { type: 'wordAudioLoaded'; pageId: number; key: string; sources: WordAudio[] }
  | { type: 'wordAudioFailed'; pageId: number; key: string }
  | { type: 'wordAudioChosen'; pageId: number; entryIndex: number; index: number }
  | { type: 'panelBack' }
  | { type: 'panelClosed' }
  | { type: 'stageTapped' }
  | { type: 'playToggled' }
  | { type: 'seekRequested'; time: number }
  /** Jump to the previous or next Japanese line from playback time `time`. */
  | { type: 'cueStepRequested'; direction: -1 | 1; time: number }
  | { type: 'holdStarted' }
  | { type: 'holdEnded' }
  | { type: 'fullscreenToggled' }
  | { type: 'videoPlayed' }
  | { type: 'videoPaused' }
  | { type: 'videoWaiting' }
  | { type: 'videoProgressing' }
  | { type: 'videoErrored'; code: number | null }
  | { type: 'videoMetadataLoaded' }
  | { type: 'stallChecked'; readyState: number }
  | { type: 'timerFired'; timer: Timer };

export type Timer = 'hideControls' | 'stall' | 'clearNotice' | 'saveProgress';

export type Effect =
  | { type: 'loadVideo'; url: string }
  | { type: 'fetchSubtitles'; slot: SubtitleSlot; option: SubtitleOption; requestId: number }
  | { type: 'saveSubtitleChoice'; seriesId: string; episodeId: string; slot: SubtitleSlot; option: string | null }
  | { type: 'fetchDictionaries' }
  | { type: 'fetchLibrary' }
  | { type: 'fetchEpisode'; id: string }
  | { type: 'saveProgress'; episodeId: string }
  | { type: 'lookup'; seq: number; text: string }
  | { type: 'checkDuplicates'; pageId: number; terms: string[] }
  | { type: 'fetchWordAudio'; pageId: number; key: string; term: string; reading: string }
  | { type: 'playAudio'; url: string }
  | { type: 'createCard'; request: CardRequest; entryIndex: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'setPlaybackRate'; rate: number }
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
/** How often the playback position is saved while playing. */
export const SAVE_PROGRESS_MS = 10_000;
/** A `waiting` longer than this without enough data reloads the source. */
export const STALL_MS = 8000;
/** readyState HAVE_FUTURE_DATA: below it the element cannot play on. */
const HAVE_FUTURE_DATA = 3;
const NOTICE_MS = 4000;
const PREPARING_NOTICE = '准备中…';
const ENDED_NOTICE = '本集结束，可播放下一集';
const SUBTITLE_SLOTS: readonly SubtitleSlot[] = ['ja', 'zh'];

export const initialState: State = {
  screen: 'library',
  library: null,
  currentEpisode: null,
  choosingEpisodeId: null,
  pendingStartPosition: null,
  episode: null,
  subtitleOptions: [],
  subtitleSelection: { ja: null, zh: null },
  subtitleRequest: { ja: 0, zh: 0 },
  subtitleLoading: { ja: null, zh: null },
  nextSubtitleRequest: 1,
  dictionaries: [],
  cues: { ja: [], zh: [] },
  onScreen: { ja: [], zh: [] },
  wantsPlay: false,
  reloading: false,
  controlsShown: true,
  fastForward: false,
  notice: null,
  lookup: {
    seq: 0,
    pending: null,
    history: [],
    highlight: null,
    panelOpen: false,
    pausedByLookup: false,
    pinnedJa: null,
    originTime: null,
    nextPageId: 1,
  },
};

export function reduce(state: State, action: Action): Step {
  switch (action.type) {
    case 'started': {
      const effects: Effect[] = [];
      if (state.dictionaries.length === 0) effects.push({ type: 'fetchDictionaries' });
      effects.push({ type: 'fetchLibrary' });
      return { state, effects };
    }

    case 'libraryLoaded':
      return only({ ...state, library: action.library });

    case 'libraryFailed':
      return notify(state, `library failed: ${action.message}`);

    case 'episodeChosen':
      return {
        state: { ...state, choosingEpisodeId: action.episodeId },
        effects: [{ type: 'fetchEpisode', id: action.episodeId }],
      };

    case 'episodeLoaded': {
      if (action.episode.id !== state.choosingEpisodeId) return only(state);
      const episode: Episode = { video: action.episode.video };
      const fallback = subtitleFallbackNotice(action.episode);
      const base: State = {
        ...initialState,
        screen: 'player',
        library: state.library,
        dictionaries: state.dictionaries,
        currentEpisode: action.episode,
        episode,
        subtitleOptions: action.episode.subtitleOptions,
        nextSubtitleRequest: state.nextSubtitleRequest,
        pendingStartPosition: action.episode.position,
        notice: fallback ?? PREPARING_NOTICE,
      };
      const initial = startInitialSubtitles(base, action.episode);
      const effects: Effect[] = [
        { type: 'cancelTimer', timer: 'clearNotice' },
        { type: 'cancelTimer', timer: 'saveProgress' },
        { type: 'loadVideo', url: episode.video },
        ...initial.effects,
      ];
      if (fallback !== null) effects.push({ type: 'startTimer', timer: 'clearNotice', ms: NOTICE_MS });
      return { state: initial.state, effects };
    }

    case 'episodeFailed':
      return notify({ ...state, choosingEpisodeId: null }, `episode failed: ${action.message}`);

    case 'backToLibrary': {
      if (state.screen !== 'player') return only(state);
      const effects: Effect[] = [{ type: 'pause' }];
      if (state.currentEpisode !== null) effects.push({ type: 'saveProgress', episodeId: state.currentEpisode.id });
      effects.push({ type: 'cancelTimer', timer: 'saveProgress' }, { type: 'fetchLibrary' });
      return {
        state: {
          ...state,
          screen: 'library',
          choosingEpisodeId: null,
          wantsPlay: false,
          notice: null,
          lookup: closedLookup(state.lookup),
        },
        effects,
      };
    }

    case 'nextEpisodeRequested': {
      const next = state.currentEpisode?.nextEpisodeId;
      if (next === null || next === undefined) return only(state);
      const effects: Effect[] = [];
      if (state.currentEpisode !== null) effects.push({ type: 'saveProgress', episodeId: state.currentEpisode.id });
      effects.push({ type: 'fetchEpisode', id: next });
      return { state: { ...state, choosingEpisodeId: next }, effects };
    }

    case 'videoEnded': {
      if (state.screen !== 'player') return only(state);
      const effects: Effect[] = [
        { type: 'cancelTimer', timer: 'saveProgress' },
        { type: 'cancelTimer', timer: 'hideControls' },
      ];
      if (state.currentEpisode !== null) effects.push({ type: 'saveProgress', episodeId: state.currentEpisode.id });
      const stopped: State = { ...state, wantsPlay: false, controlsShown: true };
      if (state.currentEpisode?.nextEpisodeId) {
        const notified = notify(stopped, ENDED_NOTICE);
        return { state: notified.state, effects: [...effects, ...notified.effects] };
      }
      return { state: stopped, effects };
    }

    case 'episodeOpened': {
      const { episode } = action;
      return {
        state: {
          ...initialState,
          episode,
          screen: 'player',
          dictionaries: state.dictionaries,
          library: state.library,
        },
        effects: openEpisodeEffects(episode),
      };
    }

    case 'dictionariesLoaded':
      return only({ ...state, dictionaries: action.dictionaries });

    case 'dictionariesFailed':
      return notify(state, `dictionaries failed: ${action.message}`);

    case 'subtitlesLoaded':
      if (action.requestId !== state.subtitleRequest[action.slot]) return only(state);
      return only({
        ...state,
        cues: { ...state.cues, [action.slot]: action.cues },
        subtitleLoading: { ...state.subtitleLoading, [action.slot]: null },
      });

    case 'subtitlesFailed':
      if (action.requestId !== state.subtitleRequest[action.slot]) return only(state);
      return notify(
        { ...state, subtitleLoading: { ...state.subtitleLoading, [action.slot]: null } },
        `字幕加载失败: ${action.message}`,
      );

    case 'subtitleChosen':
      return chooseSubtitle(state, action.slot, action.option);

    case 'subtitleChoiceFailed':
      return notify(state, '字幕选择未能保存');

    case 'cuesOnScreen':
      if (sameIds(state.onScreen[action.track], action.ids)) return only(state);
      return only({ ...state, onScreen: { ...state.onScreen, [action.track]: action.ids } });

    case 'characterTapped':
      return tapCharacter(state, action.cueId, action.offset, action.time);

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

    case 'duplicatesChecked': {
      const page = findPage(state, action.pageId);
      if (page === undefined) return only(state);
      return only(updatePage(state, page, { ...page, duplicates: action.counts }));
    }

    case 'duplicatesFailed': {
      const page = findPage(state, action.pageId);
      if (page === undefined) return only(state);
      return only(updatePage(state, page, { ...page, duplicates: 'unavailable' }));
    }

    case 'mineRequested':
      return mineEntry(state, action.entryIndex, action.definitions);

    case 'mineSucceeded': {
      const page = miningPage(state, action.entryIndex, action.pageText);
      if (page === undefined) return only(state);
      const term = page.response.entries[action.entryIndex]?.headwords[0]?.term;
      return only(
        updatePage(state, page, {
          ...page,
          mined: {
            ...page.mined,
            [action.entryIndex]: {
              status: 'done',
              noteId: action.response.noteId,
              duplicates: action.response.duplicates,
            },
          },
          duplicates: bumpDuplicateCount(page.duplicates, term),
        }),
      );
    }

    case 'mineFailed': {
      const page = miningPage(state, action.entryIndex);
      if (page === undefined) return only(state);
      return only(
        updatePage(state, page, {
          ...page,
          mined: { ...page.mined, [action.entryIndex]: { status: 'error', message: action.message } },
        }),
      );
    }

    case 'wordAudioRequested':
      return requestWordAudio(state, action.pageId, action.entryIndex);

    case 'wordAudioLoaded': {
      const page = findPage(state, action.pageId);
      if (page === undefined || page.audio[action.key]?.status !== 'loading') return only(state);
      const sources = action.sources;
      const updated = updatePage(state, page, {
        ...page,
        audio: { ...page.audio, [action.key]: { status: 'list', sources, selected: 0 } },
      });
      const first = sources[0];
      return first === undefined ? only(updated) : { state: updated, effects: [{ type: 'playAudio', url: first.url }] };
    }

    case 'wordAudioFailed': {
      const page = findPage(state, action.pageId);
      if (page === undefined || page.audio[action.key]?.status !== 'loading') return only(state);
      return only(
        updatePage(state, page, {
          ...page,
          audio: { ...page.audio, [action.key]: { status: 'unavailable' } },
        }),
      );
    }

    case 'wordAudioChosen':
      return chooseWordAudio(state, action.pageId, action.entryIndex, action.index);

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

    case 'cueStepRequested': {
      const target = cueStepTarget(state.cues.ja, action.time, action.direction);
      const shown = showControls(state);
      if (target === null) return shown;
      return { state: shown.state, effects: [{ type: 'seek', time: target }, ...shown.effects] };
    }

    case 'holdStarted':
      // Holding a paused picture or behind the open panel does nothing.
      if (!state.wantsPlay || state.lookup.panelOpen || state.fastForward) return only(state);
      return { state: { ...state, fastForward: true }, effects: [{ type: 'setPlaybackRate', rate: HOLD_RATE }] };

    case 'holdEnded':
      if (!state.fastForward) return only(state);
      return { state: { ...state, fastForward: false }, effects: [{ type: 'setPlaybackRate', rate: 1 }] };

    case 'fullscreenToggled':
      return { state, effects: [{ type: 'toggleFullscreen' }] };

    case 'videoPlayed': {
      // Playing means the user took over; closing the panel must not pause again.
      const shown = showControls({ ...state, wantsPlay: true, lookup: { ...state.lookup, pausedByLookup: false } });
      return {
        state: shown.state,
        effects: [...shown.effects, { type: 'startTimer', timer: 'saveProgress', ms: SAVE_PROGRESS_MS }],
      };
    }

    case 'videoPaused': {
      // Reloading pauses the element; that is not the user's intent.
      if (state.reloading) return only(state);
      const effects: Effect[] = [
        { type: 'cancelTimer', timer: 'hideControls' },
        { type: 'cancelTimer', timer: 'saveProgress' },
      ];
      if (state.currentEpisode !== null) effects.push({ type: 'saveProgress', episodeId: state.currentEpisode.id });
      return { state: { ...state, wantsPlay: false, controlsShown: true }, effects };
    }

    case 'videoWaiting':
      return { state, effects: [{ type: 'startTimer', timer: 'stall', ms: STALL_MS }] };

    case 'videoProgressing':
      return { state, effects: [{ type: 'cancelTimer', timer: 'stall' }] };

    case 'videoErrored':
      if (state.reloading) return only(state);
      return reload(state, `media error ${action.code ?? '?'}, reloading`);

    case 'videoMetadataLoaded': {
      const effects: Effect[] = [];
      let next = state;
      if (next.pendingStartPosition !== null) {
        // Seek before resuming so the first frames come from the saved position.
        effects.push({ type: 'seek', time: next.pendingStartPosition });
        next = { ...next, pendingStartPosition: null };
      }
      if (next.reloading) {
        next = { ...next, reloading: false };
        if (next.wantsPlay) effects.push({ type: 'play' });
      }
      if (next.notice === PREPARING_NOTICE) next = { ...next, notice: null };
      return { state: next, effects };
    }

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
        case 'saveProgress': {
          if (!state.wantsPlay) return only(state);
          const effects: Effect[] = [];
          if (state.currentEpisode !== null) {
            effects.push({ type: 'saveProgress', episodeId: state.currentEpisode.id });
          }
          effects.push({ type: 'startTimer', timer: 'saveProgress', ms: SAVE_PROGRESS_MS });
          return { state, effects };
        }
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

/** Loading an episode replaces the source; subtitle fetches are started separately. */
function openEpisodeEffects(episode: Episode): Effect[] {
  return [{ type: 'loadVideo', url: episode.video }];
}

/**
 * Starts the fetches for the episode's selected options. The selection is the
 * server's saved choice when it exists, otherwise the default it chose.
 */
function startInitialSubtitles(
  state: State,
  episode: EpisodeResponse,
): { state: State; effects: Effect[] } {
  const selection: Record<SubtitleSlot, string | null> = {
    ja: episode.subtitles.ja,
    zh: episode.subtitles.zh,
  };
  const request: Record<SubtitleSlot, number> = { ja: 0, zh: 0 };
  const loading: Record<SubtitleSlot, string | null> = { ja: null, zh: null };
  const effects: Effect[] = [];
  let nextRequest = state.nextSubtitleRequest;

  for (const slot of SUBTITLE_SLOTS) {
    const optionId = selection[slot];
    if (optionId === null) continue;
    const option = episode.subtitleOptions.find(
      (candidate) => candidate.id === optionId && candidate.slot === slot,
    );
    if (option === undefined) continue;
    request[slot] = nextRequest;
    loading[slot] = option.id;
    effects.push({ type: 'fetchSubtitles', slot, option, requestId: nextRequest });
    nextRequest += 1;
  }

  return {
    state: {
      ...state,
      subtitleSelection: selection,
      subtitleRequest: request,
      subtitleLoading: loading,
      nextSubtitleRequest: nextRequest,
    },
    effects,
  };
}

/** Tells the viewer why the saved choice could not be restored. */
function subtitleFallbackNotice(episode: EpisodeResponse): string | null {
  if (episode.subtitleFallback.length === 0) return null;
  const labels = episode.subtitleFallback.map((slot) => {
    const selected = episode.subtitles[slot];
    if (selected === null) return '关闭';
    return episode.subtitleOptions.find((option) => option.id === selected)?.label ?? '关闭';
  });
  return `未找到上次选择的字幕，已改用 ${labels.join('、')}`;
}

/**
 * Switches one slot: old cues disappear at once, a new fetch gets a fresh
 * identity so earlier responses are ignored, and the choice is stored.
 */
function chooseSubtitle(state: State, slot: SubtitleSlot, optionId: string | null): Step {
  const episode = state.currentEpisode;
  if (episode === null) return only(state);

  const requestId = state.nextSubtitleRequest;
  const save: Effect = {
    type: 'saveSubtitleChoice',
    seriesId: episode.seriesId,
    episodeId: episode.id,
    slot,
    option: optionId,
  };
  const cleared: State = {
    ...state,
    cues: { ...state.cues, [slot]: [] },
    onScreen: { ...state.onScreen, [slot]: [] },
    subtitleSelection: { ...state.subtitleSelection, [slot]: optionId },
    subtitleRequest: { ...state.subtitleRequest, [slot]: requestId },
    nextSubtitleRequest: requestId + 1,
  };

  if (optionId === null) {
    return {
      state: { ...cleared, subtitleLoading: { ...state.subtitleLoading, [slot]: null } },
      effects: [save],
    };
  }

  const option = state.subtitleOptions.find(
    (candidate) => candidate.id === optionId && candidate.slot === slot,
  );
  if (option === undefined) return only(state);

  return {
    state: { ...cleared, subtitleLoading: { ...state.subtitleLoading, [slot]: optionId } },
    effects: [{ type: 'fetchSubtitles', slot, option, requestId }, save],
  };
}

function closedLookup(lookup: LookupState): LookupState {
  return {
    ...lookup,
    pending: null,
    history: [],
    highlight: null,
    panelOpen: false,
    pausedByLookup: false,
    pinnedJa: null,
    originTime: null,
  };
}

/** A tap on a Japanese character: the scan text decides whether there is a lookup at all. */
function tapCharacter(state: State, cueId: number, offset: number, time: number): Step {
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
        originTime: time,
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

  const pageId = lookup.nextPageId;
  const terms = duplicateTerms(response);
  const page: LookupPage = {
    id: pageId,
    text,
    response,
    mined: {},
    duplicates: terms.length === 0 ? {} : undefined,
    audio: {},
  };
  const effects: Effect[] = terms.length === 0 ? [] : [{ type: 'checkDuplicates', pageId, terms }];
  const base: LookupState = { ...lookup, nextPageId: pageId + 1, pending: null };

  if (lookup.pending.origin === null) {
    return { state: { ...state, lookup: { ...base, history: [...lookup.history, page] } }, effects };
  }

  const { cueId, offset } = lookup.pending.origin;
  const cue = state.cues.ja.find((candidate) => candidate.id === cueId);
  const range = cue === undefined ? null : highlightRange(cue.text, offset, response.matchLength);
  return {
    state: {
      ...state,
      lookup: {
        ...base,
        history: [page],
        highlight: range === null ? null : { cueId, ...range },
        panelOpen: true,
        pinnedJa: [...state.onScreen.ja],
      },
    },
    effects,
  };
}

/**
 * Closing drops pending work too: a response that arrives afterwards must not
 * reopen the panel the user just dismissed.
 */
function closePanel(state: State): Step {
  const { lookup } = state;
  if (!lookup.panelOpen) return only(state);
  return {
    state: { ...state, lookup: closedLookup(lookup) },
    effects: lookup.pausedByLookup ? [{ type: 'play' }] : [],
  };
}

/**
 * Builds a card request from the lookup that is on screen: the origin cue and
 * its highlighted range, not the nested page, describe the sentence to keep.
 */
function mineEntry(
  state: State,
  entryIndex: number,
  definitions: { dictionary: string; html: string }[],
): Step {
  const { lookup } = state;
  const page = lookup.history.at(-1);
  const { highlight, originTime } = lookup;
  const episode = state.currentEpisode;
  if (page === undefined || highlight === null || originTime === null || episode === null) return only(state);
  if (page.mined[entryIndex]?.status === 'mining') return only(state);

  const entry = page.response.entries[entryIndex];
  if (entry === undefined) return only(state);
  const headword = entry.headwords[0];
  if (headword === undefined) return only(state);

  const cue = state.cues.ja.find((candidate) => candidate.id === highlight.cueId);
  if (cue === undefined) return only(state);

  const request: CardRequest = {
    episodeId: episode.id,
    term: headword.term,
    reading: headword.reading,
    definitions: definitions.map((definition) => ({ ...definition })),
    frequencies: entry.frequencies.map((frequency) => ({ ...frequency })),
    pitches: [...entry.pitches],
    cue: { start: cue.start, end: cue.end, text: cue.text },
    highlight: { start: highlight.start, end: highlight.end },
    time: originTime,
    wordAudio: wordAudioForEntry(page, entryIndex),
  };
  return {
    state: updatePage(state, page, {
      ...page,
      mined: { ...page.mined, [entryIndex]: { status: 'mining' } },
    }),
    effects: [{ type: 'createCard', request, entryIndex }],
  };
}

/** Plays the selected recording, or starts the lazy audio lookup for this entry. */
function requestWordAudio(state: State, pageId: number, entryIndex: number): Step {
  const page = findPage(state, pageId);
  if (page === undefined) return only(state);
  const headword = page.response.entries[entryIndex]?.headwords[0];
  if (headword === undefined) return only(state);

  const key = entryAudioKey(headword.term, headword.reading);
  const audio = page.audio[key];
  if (audio?.status === 'list') {
    const source = audio.sources[audio.selected];
    return source === undefined ? only(state) : { state, effects: [{ type: 'playAudio', url: source.url }] };
  }
  if (audio !== undefined) return only(state);

  return {
    state: updatePage(state, page, { ...page, audio: { ...page.audio, [key]: { status: 'loading' } } }),
    effects: [{ type: 'fetchWordAudio', pageId, key, term: headword.term, reading: headword.reading }],
  };
}

/** Picks a recording source and plays it straight away. */
function chooseWordAudio(state: State, pageId: number, entryIndex: number, index: number): Step {
  const page = findPage(state, pageId);
  if (page === undefined) return only(state);
  const headword = page.response.entries[entryIndex]?.headwords[0];
  if (headword === undefined) return only(state);

  const key = entryAudioKey(headword.term, headword.reading);
  const audio = page.audio[key];
  if (audio?.status !== 'list') return only(state);
  const source = audio.sources[index];
  if (source === undefined) return only(state);

  return {
    state: updatePage(state, page, {
      ...page,
      audio: { ...page.audio, [key]: { ...audio, selected: index } },
    }),
    effects: [{ type: 'playAudio', url: source.url }],
  };
}

/** The chosen recording for a card, or null when audio was never loaded. */
function wordAudioForEntry(page: LookupPage, entryIndex: number): string | null {
  const headword = page.response.entries[entryIndex]?.headwords[0];
  if (headword === undefined) return null;
  const audio = page.audio[entryAudioKey(headword.term, headword.reading)];
  if (audio?.status !== 'list') return null;
  return audio.sources[audio.selected]?.url ?? null;
}

/** Finds the page still waiting for this entry's card, newest first. */
function miningPage(state: State, entryIndex: number, pageText?: string): LookupPage | undefined {
  const history = state.lookup.history;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const page = history[index];
    if (page === undefined) continue;
    if (pageText !== undefined && page.text !== pageText) continue;
    if (page.mined[entryIndex]?.status === 'mining') return page;
  }
  return undefined;
}

/** Replaces one page in place; page copies keep results matched to the same position. */
function updatePage(state: State, page: LookupPage, next: LookupPage): State {
  const position = state.lookup.history.lastIndexOf(page);
  if (position < 0) return state;
  const history = [...state.lookup.history];
  history[position] = next;
  return { ...state, lookup: { ...state.lookup, history } };
}

function findPage(state: State, pageId: number): LookupPage | undefined {
  return state.lookup.history.find((page) => page.id === pageId);
}

/** One card was just created, so the deck now holds one more note with that term. */
function bumpDuplicateCount(
  duplicates: LookupPage['duplicates'],
  term: string | undefined,
): LookupPage['duplicates'] {
  if (duplicates === undefined || duplicates === 'unavailable' || term === undefined) return duplicates;
  return { ...duplicates, [term]: (duplicates[term] ?? 0) + 1 };
}

/** Unique headword terms of a page, in entry order and within the API's limit. */
function duplicateTerms(response: LookupResponse): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const entry of response.entries) {
    const term = entry.headwords[0]?.term;
    if (term === undefined || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_DUPLICATE_TERMS) break;
  }
  return terms;
}

