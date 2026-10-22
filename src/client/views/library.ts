// The library screen: resume card, series and episodes. Choosing an episode
// asks for its detail; the player takes over once it arrives.
import type { EpisodeSummary, LibraryResponse, SeriesSummary } from '../../shared/api.ts';
import type { Dispatch } from '../effects.ts';
import type { State } from '../state.ts';

export interface LibraryElements {
  root: HTMLElement;
}

export function createLibraryView(els: LibraryElements, dispatch: Dispatch) {
  let shown: LibraryResponse | null | undefined;

  els.root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>('[data-episode-id]');
    const episodeId = button?.dataset.episodeId;
    if (episodeId === undefined) return;
    dispatch({ type: 'episodeChosen', episodeId });
  });

  return function render(state: State): void {
    els.root.hidden = state.screen !== 'library';
    if (els.root.hidden || state.library === shown) return;
    shown = state.library;
    els.root.replaceChildren(...renderLibrary(state.library));
  };
}

function renderLibrary(library: LibraryResponse | null): HTMLElement[] {
  if (library === null) return [el('div', 'lib-empty', '加载中…')];

  const nodes: HTMLElement[] = [el('h1', 'library-title', '列表')];
  if (library.resume !== null) {
    const { episodeId, seriesTitle, episodeTitle, position } = library.resume;
    const card = el('button', 'resume');
    card.type = 'button';
    card.dataset.episodeId = episodeId;
    card.append(
      el('span', 'resume-label', '继续观看'),
      el('span', 'resume-title', `${seriesTitle} · ${episodeTitle}`),
      el('span', 'resume-time', clock(position)),
    );
    nodes.push(card);
  }
  for (const series of library.series) nodes.push(renderSeries(series));
  return nodes;
}

function renderSeries(series: SeriesSummary): HTMLElement {
  const details = el('details', 'series');
  details.open = true;
  const summary = el('summary');
  summary.append(
    el('span', 'series-title', series.title),
    el('span', 'series-count', `${series.episodes.length} 集`),
  );
  details.append(summary);

  const episodes = el('div', 'episodes');
  for (const episode of series.episodes) episodes.append(renderEpisode(episode));
  details.append(episodes);
  return details;
}

function renderEpisode(episode: EpisodeSummary): HTMLButtonElement {
  const hasJapanese = episode.languages.includes('ja');
  const button = el('button', hasJapanese ? 'episode' : 'episode no-ja');
  button.type = 'button';
  button.dataset.episodeId = episode.id;

  const main = el('span', 'episode-main');
  main.append(el('span', 'episode-title', episode.title));
  if (hasJapanese) main.append(el('span', 'badge', '日'));
  button.append(main);

  if (episode.duration > 0) {
    const progress = el('span', 'progress');
    const fill = el('span', 'progress-fill');
    fill.style.width = `${Math.min(100, Math.max(0, (episode.position / episode.duration) * 100))}%`;
    progress.append(fill);
    button.append(progress);
  }

  return button;
}

function clock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | null = null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== null) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
