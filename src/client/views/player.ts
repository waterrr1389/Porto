// The video element, the control bar and the status line. Element events
// become actions; the progress bar, time label and play button follow the
// element directly, outside reduce, because they change every frame.
import type { Dispatch } from '../effects.ts';
import type { State } from '../state.ts';

export interface PlayerElements {
  view: HTMLElement;
  video: HTMLVideoElement;
  tapLayer: HTMLElement;
  bar: HTMLElement;
  play: HTMLButtonElement;
  seek: HTMLInputElement;
  time: HTMLElement;
  fullscreen: HTMLButtonElement;
  library: HTMLButtonElement;
  nextEpisode: HTMLButtonElement;
  notice: HTMLElement;
}

const SEEK_STEPS = 1000;

export function createPlayerView(els: PlayerElements, dispatch: Dispatch, fullscreenSupported: boolean) {
  const { video } = els;
  els.fullscreen.hidden = !fullscreenSupported;

  video.addEventListener('play', () => dispatch({ type: 'videoPlayed' }));
  video.addEventListener('pause', () => dispatch({ type: 'videoPaused' }));
  video.addEventListener('waiting', () => dispatch({ type: 'videoWaiting' }));
  video.addEventListener('playing', () => dispatch({ type: 'videoProgressing' }));
  video.addEventListener('canplay', () => dispatch({ type: 'videoProgressing' }));
  video.addEventListener('error', () => dispatch({ type: 'videoErrored', code: video.error?.code ?? null }));
  video.addEventListener('loadedmetadata', () => dispatch({ type: 'videoMetadataLoaded' }));

  els.tapLayer.addEventListener('click', () => dispatch({ type: 'stageTapped' }));
  els.play.addEventListener('click', () => dispatch({ type: 'playToggled' }));
  els.fullscreen.addEventListener('click', () => dispatch({ type: 'fullscreenToggled' }));
  els.library.addEventListener('click', () => dispatch({ type: 'backToLibrary' }));
  els.nextEpisode.addEventListener('click', () => dispatch({ type: 'nextEpisodeRequested' }));
  video.addEventListener('ended', () => dispatch({ type: 'videoEnded' }));

  let scrubbing = false;
  els.seek.max = String(SEEK_STEPS);
  els.seek.addEventListener('input', () => (scrubbing = true));
  els.seek.addEventListener('change', () => {
    scrubbing = false;
    if (video.duration > 0) dispatch({ type: 'seekRequested', time: (Number(els.seek.value) / SEEK_STEPS) * video.duration });
  });

  const frame = () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!scrubbing && duration > 0) els.seek.value = String((video.currentTime / duration) * SEEK_STEPS);
    els.time.textContent = `${clock(video.currentTime)} / ${clock(duration)}`;
    els.play.textContent = video.paused ? '▶' : '❚❚';
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return function render(state: State): void {
    els.view.hidden = state.screen !== 'player';
    els.bar.classList.toggle('hidden', !state.controlsShown);
    els.view.classList.toggle('bar-shown', state.controlsShown);
    els.nextEpisode.hidden = state.currentEpisode?.nextEpisodeId == null;
    els.notice.textContent = state.notice ?? '';
    document.title =
      state.screen === 'player' && state.currentEpisode !== null
        ? `${state.currentEpisode.seriesTitle} ${state.currentEpisode.title}`
        : 'SLA';
  };
}

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
