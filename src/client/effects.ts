// Carries out Effects: network, video element commands, fullscreen and
// timers. Results come back only as dispatched Actions.
import { parseSubtitles, type Cue, type SubtitleFormat } from '../core/subtitles.ts';
import type {
  ApiError,
  CardRequest,
  CardResponse,
  DictionaryInfo,
  DuplicatesResponse,
  EpisodeResponse,
  LibraryResponse,
  LookupResponse,
  ProgressRequest,
  SubtitleChoiceRequest,
  SubtitleSlot,
} from '../shared/api.ts';
import type { Action, Effect, Timer } from './state.ts';

export type Dispatch = (action: Action) => void;

export interface EffectTargets {
  video: HTMLVideoElement;
  /** The element taken fullscreen; never the video itself, or the overlays disappear. */
  stage: HTMLElement;
}

/** Only the Default style of Chinese subtitles is dialogue; other styles are signs and credits. */
const ASS_DIALOGUE_STYLES = ['Default'] as const;

/**
 * Embedded Chinese tracks often use non-Default style names, so the style
 * filter is only kept when it leaves at least one cue.
 */
function parseSubtitleText(slot: SubtitleSlot, format: SubtitleFormat, text: string): Cue[] {
  if (slot !== 'zh') return parseSubtitles(format, text);
  const dialogue = parseSubtitles(format, text, { styles: ASS_DIALOGUE_STYLES });
  return dialogue.length > 0 ? dialogue : parseSubtitles(format, text);
}

export function createEffectRunner({ video, stage }: EffectTargets, dispatch: Dispatch): (effect: Effect) => void {
  const timers = new Map<Timer, ReturnType<typeof setTimeout>>();

  return (effect) => {
    switch (effect.type) {
      case 'loadVideo':
        video.src = effect.url;
        video.load();
        return;

      case 'fetchSubtitles':
        fetch(effect.option.url)
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
          })
          .then((text) => {
            dispatch({
              type: 'subtitlesLoaded',
              slot: effect.slot,
              optionId: effect.option.id,
              requestId: effect.requestId,
              cues: parseSubtitleText(effect.slot, effect.option.format, text),
            });
          })
          .catch((error: unknown) => {
            dispatch({
              type: 'subtitlesFailed',
              slot: effect.slot,
              optionId: effect.option.id,
              requestId: effect.requestId,
              message: String(error),
            });
          });
        return;

      case 'saveSubtitleChoice': {
        const body: SubtitleChoiceRequest = {
          episodeId: effect.episodeId,
          slot: effect.slot,
          option: effect.option,
        };
        // Remembering the choice is best effort; playback does not wait for it.
        void fetch(`/api/series/${encodeURIComponent(effect.seriesId)}/subtitles`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((response) => {
            if (!response.ok) dispatch({ type: 'subtitleChoiceFailed' });
          })
          .catch(() => dispatch({ type: 'subtitleChoiceFailed' }));
        return;
      }

      case 'fetchDictionaries':
        getJson<DictionaryInfo[]>('/api/dictionaries')
          .then((dictionaries) => dispatch({ type: 'dictionariesLoaded', dictionaries }))
          .catch((error: unknown) => dispatch({ type: 'dictionariesFailed', message: String(error) }));
        return;

      case 'fetchLibrary':
        getJson<LibraryResponse>('/api/library')
          .then((library) => dispatch({ type: 'libraryLoaded', library }))
          .catch((error: unknown) => dispatch({ type: 'libraryFailed', message: String(error) }));
        return;

      case 'fetchEpisode':
        getJson<EpisodeResponse>(`/api/episodes/${encodeURIComponent(effect.id)}`)
          .then((episode) => dispatch({ type: 'episodeLoaded', episode }))
          .catch((error: unknown) => dispatch({ type: 'episodeFailed', message: String(error) }));
        return;

      case 'saveProgress': {
        // The element is the source of truth; a reload can leave duration unknown.
        const duration = video.duration;
        const position = video.currentTime;
        if (!Number.isFinite(position) || !Number.isFinite(duration) || position < 1) return;
        const body: ProgressRequest = { position, duration };
        // Progress is best effort: a failed save must not interrupt playback.
        void fetch(`/api/episodes/${encodeURIComponent(effect.episodeId)}/progress`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => {});
        return;
      }

      case 'lookup':
        getJson<LookupResponse>(`/api/lookup?text=${encodeURIComponent(effect.text)}`)
          .then((response) => dispatch({ type: 'lookupSucceeded', seq: effect.seq, text: effect.text, response }))
          .catch((error: unknown) => dispatch({ type: 'lookupFailed', seq: effect.seq, message: String(error) }));
        return;

      case 'checkDuplicates': {
        const params = new URLSearchParams();
        for (const term of effect.terms) params.append('term', term);
        getJson<DuplicatesResponse>(`/api/cards/duplicates?${params.toString()}`)
          .then((counts) => dispatch({ type: 'duplicatesChecked', pageId: effect.pageId, counts }))
          .catch(() => dispatch({ type: 'duplicatesFailed', pageId: effect.pageId }));
        return;
      }

      case 'createCard':
        postCard(effect.request)
          .then((response) => {
            dispatch({ type: 'mineSucceeded', entryIndex: effect.entryIndex, response });
          })
          .catch((error: unknown) => {
            dispatch({ type: 'mineFailed', entryIndex: effect.entryIndex, message: String(error) });
          });
        return;

      case 'play':
        // A rejected play() (e.g. no user gesture yet) surfaces as no 'play' event.
        video.play().catch(() => {});
        return;

      case 'pause':
        video.pause();
        return;

      case 'seek':
        video.currentTime = effect.time;
        return;

      case 'setPlaybackRate':
        video.playbackRate = effect.rate;
        return;

      case 'reloadVideo': {
        const position = video.currentTime;
        video.addEventListener('loadedmetadata', () => (video.currentTime = position), { once: true });
        video.load();
        return;
      }

      case 'checkStall':
        dispatch({ type: 'stallChecked', readyState: video.readyState });
        return;

      case 'toggleFullscreen':
        toggleFullscreen(stage);
        return;

      case 'startTimer':
        clearTimeout(timers.get(effect.timer));
        timers.set(
          effect.timer,
          setTimeout(() => {
            timers.delete(effect.timer);
            dispatch({ type: 'timerFired', timer: effect.timer });
          }, effect.ms),
        );
        return;

      case 'cancelTimer':
        clearTimeout(timers.get(effect.timer));
        timers.delete(effect.timer);
        return;
    }
  };
}

interface WebkitFullscreen {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
  webkitRequestFullscreen?: () => void;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Posts a card and surfaces the server's ApiError message when it refuses. */
async function postCard(request: CardRequest): Promise<CardResponse> {
  const response = await fetch('/api/cards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as ApiError;
      if (typeof body.error === 'string' && body.error !== '') message = body.error;
    } catch {
      // Keep the status text when the body is not the contract's JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as CardResponse;
}

/** iPad Safari only has the prefixed API; iPhone has none for elements. */
export function canFullscreen(stage: HTMLElement): boolean {
  return typeof stage.requestFullscreen === 'function' || typeof (stage as WebkitFullscreen).webkitRequestFullscreen === 'function';
}

function toggleFullscreen(stage: HTMLElement): void {
  const doc = document as Document & WebkitFullscreen;
  const el = stage as HTMLElement & WebkitFullscreen;
  if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
    if (doc.exitFullscreen) void doc.exitFullscreen();
    else doc.webkitExitFullscreen?.();
  } else if (el.requestFullscreen) {
    void el.requestFullscreen();
  } else {
    el.webkitRequestFullscreen?.();
  }
}
