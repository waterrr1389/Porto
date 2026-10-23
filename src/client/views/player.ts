// The video element and its controls. Element events become actions; the
// progress bar, times, play icon and gesture previews follow the element and
// the finger directly, outside reduce, because they change every frame.
//
// Stage gestures: a tap toggles the controls, a hold plays faster, a
// horizontal swipe seeks on release. Subtitle characters sit above the stage,
// so a press on them never starts a gesture.
import { HOLD_MS, classifyMove, swipeOffset, type MoveKind } from '../../core/playback.ts';
import { VOLUME_GAINS, levelAt } from '../../core/volume.ts';
import type { SubtitleSlot } from '../../shared/api.ts';
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
  subtitlesButton: HTMLButtonElement;
  subtitlesPopover: HTMLElement;
  subtitlesMenu: HTMLElement;
  notice: HTMLElement;
}

/** The line-step menu and the volume steps fold back after this long without use. */
const CUE_NAV_FOLD_MS = 4000;
/** The subtitle menu closes after this long without a tap. */
const SUBTITLE_MENU_IDLE_MS = 6000;

const SUBTITLE_SECTIONS: readonly { slot: SubtitleSlot; title: string }[] = [
  { slot: 'ja', title: '日文 · 查词' },
  { slot: 'zh', title: '中文 · 翻译' },
];

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

  // Subtitles: a glass menu under the button, kept open by taps and closed on idle.
  let latestState: State | null = null;
  let subtitleMenuTimer: ReturnType<typeof setTimeout> | undefined;
  let subtitleMenuKey: string | null = null;

  const closeSubtitleMenu = () => {
    els.subtitlesPopover.hidden = true;
    clearTimeout(subtitleMenuTimer);
    subtitleMenuTimer = undefined;
  };
  const keepSubtitleMenuOpen = () => {
    clearTimeout(subtitleMenuTimer);
    subtitleMenuTimer = setTimeout(closeSubtitleMenu, SUBTITLE_MENU_IDLE_MS);
  };
  const positionSubtitleMenu = () => {
    const button = els.subtitlesButton.getBoundingClientRect();
    const view = els.view.getBoundingClientRect();
    const width = els.subtitlesPopover.offsetWidth;
    const centered = button.left + button.width / 2 - view.left - width / 2;
    const max = Math.max(8, view.width - width - 8);
    els.subtitlesPopover.style.left = `${Math.min(Math.max(8, centered), max)}px`;
  };
  const syncSubtitleMenu = () => {
    if (latestState === null) return;
    const key = subtitleMenuKeyOf(latestState);
    if (key === subtitleMenuKey) return;
    subtitleMenuKey = key;
    buildSubtitleMenu(els.subtitlesMenu, latestState);
  };

  els.subtitlesButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!els.subtitlesPopover.hidden) {
      closeSubtitleMenu();
      return;
    }
    syncSubtitleMenu();
    els.subtitlesPopover.hidden = false;
    positionSubtitleMenu();
    keepSubtitleMenuOpen();
  });
  els.subtitlesPopover.addEventListener('click', (event) => {
    event.stopPropagation();
    keepSubtitleMenuOpen();
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>('[data-subtitle-slot]');
    if (row === null) return;
    const slot: SubtitleSlot = row.dataset.subtitleSlot === 'zh' ? 'zh' : 'ja';
    const option = row.dataset.subtitleOption ?? null;
    dispatch({ type: 'subtitleChosen', slot, option });
  });
  document.addEventListener('click', (event) => {
    if (els.subtitlesPopover.hidden) return;
    if (!(event.target instanceof Node)) return;
    if (els.subtitlesPopover.contains(event.target) || els.subtitlesButton.contains(event.target)) return;
    closeSubtitleMenu();
  });

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
    latestState = state;
    els.view.hidden = state.screen !== 'player';
    els.view.classList.toggle('bar-shown', state.controlsShown);
    els.nextEpisode.hidden = state.currentEpisode?.nextEpisodeId == null;
    els.cueNav.hidden = state.cues.ja.length === 0;
    els.speed.classList.toggle('shown', state.fastForward);
    els.subtitlesButton.hidden = state.subtitleOptions.length === 0;
    if (els.subtitlesButton.hidden) closeSubtitleMenu();
    syncSubtitleMenu();
    els.notice.textContent = state.notice ?? '';
    const title =
      state.currentEpisode === null ? '' : `${state.currentEpisode.seriesTitle} ${state.currentEpisode.title}`;
    els.title.textContent = title;
    document.title = state.screen === 'player' && title !== '' ? title : 'SLA';
  };
}

function subtitleMenuKeyOf(state: State): string {
  return [
    state.subtitleOptions.map((option) => `${option.slot}:${option.id}:${option.source}`).join(','),
    state.subtitleSelection.ja ?? 'off',
    state.subtitleSelection.zh ?? 'off',
    state.subtitleLoading.ja ?? '',
    state.subtitleLoading.zh ?? '',
  ].join('|');
}

function buildSubtitleMenu(menu: HTMLElement, state: State): void {
  const nodes: Node[] = [];
  for (const section of SUBTITLE_SECTIONS) {
    const options = state.subtitleOptions.filter((option) => option.slot === section.slot);
    if (options.length === 0) continue;
    const title = document.createElement('div');
    title.className = 'subtitle-section-title';
    title.textContent = section.title;
    nodes.push(title, subtitleRow(state, section.slot, null, '关闭', false));
    for (const option of options) {
      nodes.push(subtitleRow(state, section.slot, option.id, option.label, option.source === 'embedded'));
    }
  }
  menu.replaceChildren(...nodes);
}

function subtitleRow(
  state: State,
  slot: SubtitleSlot,
  optionId: string | null,
  label: string,
  embedded: boolean,
): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'subtitle-row';
  row.dataset.subtitleSlot = slot;
  if (optionId !== null) row.dataset.subtitleOption = optionId;
  row.setAttribute('role', 'menuitemradio');
  const selected = state.subtitleSelection[slot] === optionId;
  row.setAttribute('aria-checked', String(selected));

  const text = document.createElement('span');
  text.className = 'subtitle-label';
  text.textContent = label;
  row.append(text);

  if (embedded) {
    const tag = document.createElement('span');
    tag.className = 'subtitle-tag';
    tag.textContent = '内封';
    row.append(tag);
  }
  if (optionId !== null && state.subtitleLoading[slot] === optionId) {
    const loading = document.createElement('span');
    loading.className = 'subtitle-tag loading';
    loading.textContent = '加载中…';
    row.append(loading);
  }
  const check = document.createElement('span');
  check.className = 'subtitle-check';
  check.textContent = selected ? '✓' : '';
  row.append(check);
  return row;
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
