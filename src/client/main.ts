// The loop: events become actions, reduce yields the next state and effects,
// views render the state, then the effects run.
import { activeCues } from '../core/subtitles.ts';
import { canFullscreen, createEffectRunner } from './effects.ts';
import { initialState, reduce, type Action, type State } from './state.ts';
import { createLibraryView } from './views/library.ts';
import { createPlayerView } from './views/player.ts';
import { createSubtitlesView } from './views/subtitles.ts';
import { createPanelView } from './views/panel/index.ts';
import { createVolume } from './volume.ts';
import './style.css';

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const bySelector = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
};

const stage = byId('stage');
const video = byId<HTMLVideoElement>('video');
const volume = createVolume(video);
// Any tap may be the one that starts playback; the audio graph needs a gesture too.
for (const type of ['touchend', 'click'] as const) stage.addEventListener(type, () => volume.unlock(), { capture: true });

let state: State = initialState;
let running = false;
const queue: Action[] = [];

function dispatch(action: Action): void {
  queue.push(action);
  // Effects may dispatch synchronously; those actions run after the current one.
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const step = reduce(state, queue.shift() as Action);
      const changed = step.state !== state;
      state = step.state;
      if (changed) for (const render of views) render(state);
      for (const effect of step.effects) runEffect(effect);
    }
  } finally {
    running = false;
  }
}

const runEffect = createEffectRunner({ video, stage }, dispatch);
const views = [
  createPlayerView(
    {
      view: byId('view'),
      video,
      tapLayer: byId('tap'),
      bar: byId('bar'),
      play: byId<HTMLButtonElement>('play'),
      track: byId('track'),
      buffered: byId('buffered'),
      played: byId('played'),
      scrubTip: byId('scrub-tip'),
      elapsed: byId('elapsed'),
      remaining: byId('remaining'),
      title: byId('title'),
      fullscreen: byId<HTMLButtonElement>('fullscreen'),
      library: byId<HTMLButtonElement>('library'),
      nextEpisode: byId<HTMLButtonElement>('next'),
      cueNav: byId('cue-nav'),
      cueToggle: byId<HTMLButtonElement>('cue-toggle'),
      cuePrev: byId<HTMLButtonElement>('cue-prev'),
      cueNext: byId<HTMLButtonElement>('cue-next'),
      swipePreview: byId('swipe-preview'),
      speed: byId('speed'),
      volumeButton: byId<HTMLButtonElement>('volume-button'),
      volumePopover: byId('volume'),
      volumeSteps: byId('volume-steps'),
      subtitlesButton: byId<HTMLButtonElement>('subtitles-button'),
      subtitlesPopover: byId('subtitles'),
      subtitlesMenu: byId('subtitle-menu'),
      notice: byId('notice'),
    },
    dispatch,
    canFullscreen(stage),
    volume,
  ),
  createLibraryView({ root: byId('library-screen') }, dispatch),
  createSubtitlesView({ ja: byId('ja'), zh: byId('zh') }, dispatch, () => video.currentTime),
  createPanelView(
    {
      stage,
      back: byId<HTMLButtonElement>('back'),
      query: bySelector('#panel-head .query'),
      close: byId<HTMLButtonElement>('close'),
      results: byId('results'),
    },
    dispatch,
  ),
];

// Dispatches only when the set of cues on screen changes, not every frame.
function frame(): void {
  if (state.screen === 'player') {
    for (const track of ['ja', 'zh'] as const) {
      const ids = activeCues(state.cues[track], video.currentTime).map((cue) => cue.id);
      const current = state.onScreen[track];
      if (ids.length !== current.length || ids.some((id, i) => id !== current[i])) {
        dispatch({ type: 'cuesOnScreen', track, ids });
      }
    }
  }
  requestAnimationFrame(frame);
}

// Layout follows the stage's shape; it is presentation only, not State.
new ResizeObserver(() => {
  const landscape = stage.clientWidth >= stage.clientHeight;
  stage.classList.toggle('landscape', landscape);
  stage.classList.toggle('portrait', !landscape);
}).observe(stage);

for (const render of views) render(state);
dispatch({ type: 'started' });
requestAnimationFrame(frame);
