// The video element and its controls. Element events become actions; the
// progress bar, times, play icon and gesture previews follow the element and
// the finger directly, outside reduce, because they change every frame.
//
// Stage gestures: a tap toggles the controls, a hold plays faster, a
// horizontal swipe seeks on release. Subtitle characters sit above the stage,
// so a press on them never starts a gesture.
import { HOLD_MS, classifyMove, swipeOffset, type MoveKind } from '../../core/playback.ts';
import { VOLUME_GAINS, levelAt } from '../../core/volume.ts';
import type { Dispatch } from '../effects.ts';
import type { State } from '../state.ts';
import type { Volume } from '../volume.ts';

export interface PlayerElements {
  view: HTMLElement;
  video: HTMLVideoElement;
  tapLayer: HTMLElement;
  bar: HTMLElement;
  play: HTMLButtonElement;
  track: HTMLElement;
  buffered: HTMLElement;
  played: HTMLElement;
  scrubTip: HTMLElement;
  elapsed: HTMLElement;
  remaining: HTMLElement;
  title: HTMLElement;
  fullscreen: HTMLButtonElement;
  library: HTMLButtonElement;
  nextEpisode: HTMLButtonElement;
  cueNav: HTMLElement;
  cueToggle: HTMLButtonElement;
  cuePrev: HTMLButtonElement;
  cueNext: HTMLButtonElement;
  swipePreview: HTMLElement;
  speed: HTMLElement;
  volumeButton: HTMLButtonElement;
  volumePopover: HTMLElement;
  volumeSteps: HTMLElement;
  notice: HTMLElement;
}

/** The line-step menu and the volume steps fold back after this long without use. */
const CUE_NAV_FOLD_MS = 4000;

const PLAY_ICON =
  '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';

interface Press {
  pointerId: number;
  x: number;
  y: number;
  kind: MoveKind | 'hold';
  holdTimer: ReturnType<typeof setTimeout>;
  /** Playback time when the swipe began, and where it would seek to. */
  from: number;
  target: number;
}

export function createPlayerView(
  els: PlayerElements,
  dispatch: Dispatch,
  fullscreenSupported: boolean,
  volume: Volume,
) {
  const { video } = els;
  els.fullscreen.hidden = !fullscreenSupported;

  video.addEventListener('play', () => dispatch({ type: 'videoPlayed' }));
  video.addEventListener('pause', () => dispatch({ type: 'videoPaused' }));
  video.addEventListener('waiting', () => dispatch({ type: 'videoWaiting' }));
  video.addEventListener('playing', () => dispatch({ type: 'videoProgressing' }));
  video.addEventListener('canplay', () => dispatch({ type: 'videoProgressing' }));
  video.addEventListener('error', () => dispatch({ type: 'videoErrored', code: video.error?.code ?? null }));
  video.addEventListener('loadedmetadata', () => dispatch({ type: 'videoMetadataLoaded' }));
  video.addEventListener('ended', () => dispatch({ type: 'videoEnded' }));

  els.play.addEventListener('click', () => dispatch({ type: 'playToggled' }));
  els.fullscreen.addEventListener('click', () => dispatch({ type: 'fullscreenToggled' }));
  els.library.addEventListener('click', () => dispatch({ type: 'backToLibrary' }));
  els.nextEpisode.addEventListener('click', () => dispatch({ type: 'nextEpisodeRequested' }));

  const duration = () => (Number.isFinite(video.duration) ? video.duration : 0);
  const clamp = (time: number) => Math.min(Math.max(time, 0), duration());

  // Stage gestures.
  let press: Press | null = null;

  els.tapLayer.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || press !== null) return;
    els.tapLayer.setPointerCapture(event.pointerId);
    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      kind: 'pending',
      holdTimer: setTimeout(() => {
        if (press?.kind !== 'pending') return;
        press.kind = 'hold';
        dispatch({ type: 'holdStarted' });
      }, HOLD_MS),
      from: 0,
      target: 0,
    };
  });

  els.tapLayer.addEventListener('pointermove', (event) => {
    if (press === null || event.pointerId !== press.pointerId) return;
    const dx = event.clientX - press.x;
    if (press.kind === 'pending') {
      const kind = classifyMove(dx, event.clientY - press.y);
      if (kind === 'pending') return;
      clearTimeout(press.holdTimer);
      press.kind = kind;
      if (kind !== 'swipe' || duration() === 0) {
        press.kind = 'cancel';
        return;
      }
      press.from = video.currentTime;
      els.view.classList.add('swiping');
    }
    if (press.kind !== 'swipe') return;
    const offset = swipeOffset(dx, els.tapLayer.clientWidth);
    press.target = clamp(press.from + offset);
    const shown = press.target - press.from;
    els.swipePreview.innerHTML = `${clock(press.target)}<small>${shown < 0 ? '−' : '+'}${clock(Math.abs(shown))}</small>`;
  });

  const endPress = (event: PointerEvent, completed: boolean) => {
    if (press === null || event.pointerId !== press.pointerId) return;
    const ended = press;
    press = null;
    clearTimeout(ended.holdTimer);
    els.view.classList.remove('swiping');
    if (ended.kind === 'hold') dispatch({ type: 'holdEnded' });
    else if (!completed) return;
    else if (ended.kind === 'pending') dispatch({ type: 'stageTapped' });
    else if (ended.kind === 'swipe' && ended.target !== ended.from) dispatch({ type: 'seekRequested', time: ended.target });
  };
  els.tapLayer.addEventListener('pointerup', (event) => endPress(event, true));
  els.tapLayer.addEventListener('pointercancel', (event) => endPress(event, false));

  // Progress bar: the position follows the finger and seeks on release.
  let scrubFraction: number | null = null;
  const fractionAt = (clientX: number) => {
    const rect = els.track.getBoundingClientRect();
    return rect.width > 0 ? Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) : 0;
  };
  els.track.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || duration() === 0) return;
    els.track.setPointerCapture(event.pointerId);
    scrubFraction = fractionAt(event.clientX);
    els.bar.classList.add('scrubbing');
  });
  els.track.addEventListener('pointermove', (event) => {
    if (scrubFraction !== null) scrubFraction = fractionAt(event.clientX);
  });
  const endScrub = (completed: boolean) => {
    if (scrubFraction === null) return;
    const fraction = scrubFraction;
    scrubFraction = null;
    els.bar.classList.remove('scrubbing');
    if (completed) dispatch({ type: 'seekRequested', time: fraction * duration() });
  };
  els.track.addEventListener('pointerup', () => endScrub(true));
  els.track.addEventListener('pointercancel', () => endScrub(false));

  // Line steps: a folded menu that opens on tap and folds itself back.
  let foldTimer: ReturnType<typeof setTimeout> | undefined;
  const keepCueNavOpen = () => {
    clearTimeout(foldTimer);
    foldTimer = setTimeout(() => els.cueNav.classList.remove('open'), CUE_NAV_FOLD_MS);
  };
  els.cueToggle.addEventListener('click', () => {
    const open = els.cueNav.classList.toggle('open');
    if (open) keepCueNavOpen();
    else clearTimeout(foldTimer);
  });
  for (const [button, direction] of [
    [els.cuePrev, -1],
    [els.cueNext, 1],
  ] as const) {
    button.addEventListener('click', () => {
      keepCueNavOpen();
      dispatch({ type: 'cueStepRequested', direction, time: video.currentTime });
    });
  }

  // Volume: one segment per level, set by tapping or dragging along them.
  const segments = VOLUME_GAINS.map(() => els.volumeSteps.appendChild(document.createElement('span')));
  const showLevel = () => {
    const level = volume.level();
    segments.forEach((segment, index) => segment.classList.toggle('on', index <= level));
    els.volumeButton.dataset.level = level === 0 ? 'low' : level < VOLUME_GAINS.length / 2 ? 'mid' : 'high';
  };
  showLevel();
  let volumeTimer: ReturnType<typeof setTimeout> | undefined;
  const keepVolumeOpen = () => {
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => (els.volumePopover.hidden = true), CUE_NAV_FOLD_MS);
  };
  els.volumeButton.addEventListener('click', () => {
    els.volumePopover.hidden = !els.volumePopover.hidden;
    if (els.volumePopover.hidden) return;
    // Centre the steps under the button, wherever the layout put it.
    const button = els.volumeButton.getBoundingClientRect();
    const view = els.view.getBoundingClientRect();
    els.volumePopover.style.left = `${button.left + button.width / 2 - view.left - els.volumePopover.offsetWidth / 2}px`;
    keepVolumeOpen();
  });
  let adjusting = false;
  const setFrom = (clientY: number) => {
    const rect = els.volumeSteps.getBoundingClientRect();
    const level = levelAt(rect.height > 0 ? (rect.bottom - clientY) / rect.height : 0);
    if (level !== volume.level()) {
      volume.setLevel(level);
      showLevel();
    }
    keepVolumeOpen();
  };
  els.volumeSteps.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return;
    adjusting = true;
    els.volumeSteps.setPointerCapture(event.pointerId);
    setFrom(event.clientY);
  });
  els.volumeSteps.addEventListener('pointermove', (event) => adjusting && setFrom(event.clientY));
  els.volumeSteps.addEventListener('pointerup', () => (adjusting = false));
  els.volumeSteps.addEventListener('pointercancel', () => (adjusting = false));

  let shownPaused: boolean | null = null;
  const frame = () => {
    const total = duration();
    const time = scrubFraction === null ? video.currentTime : scrubFraction * total;
    const percent = total > 0 ? (time / total) * 100 : 0;
    els.played.style.width = `${percent}%`;
    els.buffered.style.width = `${total > 0 ? (bufferedEnd(video) / total) * 100 : 0}%`;
    if (scrubFraction !== null) {
      els.scrubTip.style.left = `${percent}%`;
      els.scrubTip.textContent = clock(time);
    }
    els.elapsed.textContent = clock(time);
    els.remaining.textContent = `-${clock(Math.max(total - time, 0))}`;
    if (shownPaused !== video.paused) {
      shownPaused = video.paused;
      els.play.innerHTML = video.paused ? PLAY_ICON : PAUSE_ICON;
      els.play.setAttribute('aria-label', video.paused ? '播放' : '暂停');
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return function render(state: State): void {
    els.view.hidden = state.screen !== 'player';
    els.view.classList.toggle('bar-shown', state.controlsShown);
    els.nextEpisode.hidden = state.currentEpisode?.nextEpisodeId == null;
    els.cueNav.hidden = state.cues.ja.length === 0;
    els.speed.classList.toggle('shown', state.fastForward);
    els.notice.textContent = state.notice ?? '';
    const title =
      state.currentEpisode === null ? '' : `${state.currentEpisode.seriesTitle} ${state.currentEpisode.title}`;
    els.title.textContent = title;
    document.title = state.screen === 'player' && title !== '' ? title : 'SLA';
  };
}

/** End of the buffered range that holds the playhead, or the playhead itself. */
function bufferedEnd(video: HTMLVideoElement): number {
  const { buffered, currentTime } = video;
  for (let index = 0; index < buffered.length; index += 1) {
    if (buffered.start(index) <= currentTime && currentTime <= buffered.end(index)) return buffered.end(index);
  }
  return currentTime;
}

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
