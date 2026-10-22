// The loop: events become actions, reduce yields the next state and effects,
// views render the state, then the effects run.
import { activeCues } from '../core/subtitles.ts';
import { canFullscreen, createEffectRunner } from './effects.ts';
import { initialState, reduce, type Action, type Episode, type State } from './state.ts';
import { createPlayerView } from './views/player.ts';
import { createSubtitlesView } from './views/subtitles.ts';
import './style.css';

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const stage = byId('stage');
const video = byId<HTMLVideoElement>('video');

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
      seek: byId<HTMLInputElement>('seek'),
      time: byId('time'),
      fullscreen: byId<HTMLButtonElement>('fullscreen'),
      notice: byId('notice'),
    },
    dispatch,
    canFullscreen(stage),
  ),
  createSubtitlesView({ ja: byId('ja'), zh: byId('zh') }),
];

// Dispatches only when the set of cues on screen changes, not every frame.
function frame(): void {
  for (const track of ['ja', 'zh'] as const) {
    const ids = activeCues(state.cues[track], video.currentTime).map((cue) => cue.id);
    const current = state.onScreen[track];
    if (ids.length !== current.length || ids.some((id, i) => id !== current[i])) {
      dispatch({ type: 'cuesOnScreen', track, ids });
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

/** The prototype episode, until the library lists real ones. */
const demoEpisode: Episode = {
  video: '/media/ep06.mp4',
  subtitles: { ja: '/media/ep06.ja.ass', zh: '/media/ep06.sc.ass' },
};

for (const render of views) render(state);
dispatch({ type: 'episodeOpened', episode: demoEpisode });
requestAnimationFrame(frame);
