// Carries out Effects: network, video element commands, fullscreen and
// timers. Results come back only as dispatched Actions.
import { parseSubtitles } from '../core/subtitles.ts';
import type { DictionaryInfo, LookupResponse } from '../shared/api.ts';
import type { Action, Effect, Timer } from './state.ts';

export type Dispatch = (action: Action) => void;

export interface EffectTargets {
  video: HTMLVideoElement;
  /** The element taken fullscreen; never the video itself, or the overlays disappear. */
  stage: HTMLElement;
}

/** Only the Default style of Chinese subtitles is dialogue; other styles are signs and credits. */
const ASS_STYLES = { zh: ['Default'] } as const;

export function createEffectRunner({ video, stage }: EffectTargets, dispatch: Dispatch): (effect: Effect) => void {
  const timers = new Map<Timer, ReturnType<typeof setTimeout>>();

  return (effect) => {
    switch (effect.type) {
      case 'loadVideo':
        video.src = effect.url;
        video.load();
        return;

      case 'fetchSubtitles':
        fetch(effect.url)
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
          })
          .then((text) => {
            const styles = effect.track === 'zh' ? { styles: ASS_STYLES.zh } : undefined;
            dispatch({ type: 'subtitlesLoaded', track: effect.track, cues: parseSubtitles(effect.url, text, styles) });
          })
          .catch((error: unknown) => {
            dispatch({ type: 'subtitlesFailed', track: effect.track, message: String(error) });
          });
        return;

      case 'fetchDictionaries':
        getJson<DictionaryInfo[]>('/api/dictionaries')
          .then((dictionaries) => dispatch({ type: 'dictionariesLoaded', dictionaries }))
          .catch((error: unknown) => dispatch({ type: 'dictionariesFailed', message: String(error) }));
        return;

      case 'lookup':
        getJson<LookupResponse>(`/api/lookup?text=${encodeURIComponent(effect.text)}`)
          .then((response) => dispatch({ type: 'lookupSucceeded', seq: effect.seq, text: effect.text, response }))
          .catch((error: unknown) => dispatch({ type: 'lookupFailed', seq: effect.seq, message: String(error) }));
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
