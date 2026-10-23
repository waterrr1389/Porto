// The library screen: a resume hero and horizontally scrolling episode shelves.
// Choosing an episode asks for its detail; the player takes over once it arrives.
import type { EpisodeSummary, LibraryResponse, SeriesSummary } from '../../shared/api.ts';
import type { Dispatch } from '../effects.ts';
import type { State } from '../state.ts';
import { THEME_LABELS, nextPreference, type Theme } from '../theme.ts';

export interface LibraryElements {
  root: HTMLElement;
}

/** Matches the server's resume rule: an episode is finished with less than this left. */
const FINISHED_REMAINING_S = 90;

const PLAY_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';

interface Shelf {
  element: HTMLElement;
  cards: HTMLElement[];
  episodes: readonly EpisodeSummary[];
}

export function createLibraryView(els: LibraryElements, dispatch: Dispatch, theme: Theme) {
  let shown: LibraryResponse | null | undefined;

  const themeButton = el('button', 'theme-toggle');
  themeButton.type = 'button';
  const refreshThemeLabel = (): void => {
    const label = THEME_LABELS[theme.preference()];
    themeButton.textContent = label;
    themeButton.setAttribute('aria-label', `主题：${label}`);
  };
  themeButton.addEventListener('click', () => {
    theme.setPreference(nextPreference(theme.preference()));
    refreshThemeLabel();
  });
  theme.onChange(refreshThemeLabel);
  refreshThemeLabel();

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

    if (state.library === null) {
      els.root.replaceChildren(el('div', 'lib-empty', '加载中…'));
      return;
    }
    const { nodes, shelves } = renderLibrary(state.library, themeButton);
    els.root.replaceChildren(...nodes);
    revealNextEpisodes(shelves, state.library);
  };
}

function renderLibrary(library: LibraryResponse, themeButton: HTMLElement): { nodes: HTMLElement[]; shelves: Shelf[] } {
  const nodes: HTMLElement[] = [];
  const shelves: Shelf[] = [];

  if (library.resume === null) {
    const band = el('header', 'lib-band');
    band.append(el('h1', 'lib-heading', '资料库'), themeButton);
    nodes.push(band);
  } else {
    const hero = renderHero(library);
    hero.append(themeButton);
    nodes.push(hero);
  }

  const content = el('div', 'lib-content');
  for (const series of library.series) {
    const rendered = renderSeries(series);
    content.append(rendered.node);
    shelves.push(rendered.shelf);
  }
  nodes.push(content);
  return { nodes, shelves };
}

function renderHero(library: LibraryResponse): HTMLElement {
  const resume = library.resume;
  const hero = el('section', 'lib-hero');
  if (resume === null) return hero;

  const episode = findEpisode(library, resume.episodeId);
  if (episode !== undefined && episode.thumbnail !== '') {
    hero.style.backgroundImage = `url("${episode.thumbnail}")`;
  }

  const content = el('div', 'hero-content');
  content.append(el('p', 'hero-eyebrow', '继续观看'));
  content.append(el('h1', 'hero-title', resume.seriesTitle));
  content.append(el('p', 'hero-detail', heroDetail(resume.episodeTitle, episode)));

  const play = el('button', 'hero-play');
  play.type = 'button';
  play.dataset.episodeId = resume.episodeId;
  play.innerHTML = `${PLAY_ICON}<span>继续播放</span>`;
  content.append(play);

  if (episode !== undefined && episode.duration > 0) {
    const progress = el('div', 'hero-progress');
    const fill = el('div', 'hero-progress-fill');
    fill.style.width = `${percent(episode)}%`;
    progress.append(fill);
    content.append(progress);
  }

  hero.append(content);
  return hero;
}

function renderSeries(series: SeriesSummary): { node: HTMLElement; shelf: Shelf } {
  const section = el('section', 'lib-series');
  const head = el('div', 'shelf-head');
  head.append(el('h2', 'shelf-title', series.title), el('span', 'shelf-count', `${series.episodes.length} 话`));

  const shelf = el('div', 'shelf');
  const cards: HTMLElement[] = [];
  series.episodes.forEach((episode, index) => {
    const card = renderEpisode(episode, index);
    cards.push(card);
    shelf.append(card);
  });

  section.append(head, shelf);
  return { node: section, shelf: { element: shelf, cards, episodes: series.episodes } };
}

function renderEpisode(episode: EpisodeSummary, index: number): HTMLButtonElement {
  const hasJapanese = episode.languages.includes('ja');
  const card = el('button', hasJapanese ? 'ep-card' : 'ep-card no-ja');
  card.type = 'button';
  card.dataset.episodeId = episode.id;

  const thumb = el('span', 'ep-thumb');
  thumb.append(el('span', 'ep-placeholder', episodeNumber(episode, index)));
  if (episode.thumbnail !== '') {
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.alt = '';
    image.src = episode.thumbnail;
    image.addEventListener('load', () => image.classList.add('loaded'));
    image.addEventListener('error', () => image.classList.add('failed'));
    thumb.append(image);
  }
  if (hasJapanese) thumb.append(el('span', 'ep-badge', '日'));
  if (episode.position > 0) {
    const bar = el('span', 'ep-bar');
    const fill = el('span', 'ep-bar-fill');
    fill.style.width = `${isFinished(episode) ? 100 : percent(episode)}%`;
    bar.append(fill);
    thumb.append(bar);
  }

  card.append(
    thumb,
    el('span', 'ep-title', episode.title),
    el('span', 'ep-meta', episodeMeta(episode, hasJapanese)),
  );
  return card;
}

/** Centers the next episode of each series on its shelf, once per library load. */
function revealNextEpisodes(shelves: readonly Shelf[], library: LibraryResponse): void {
  for (const shelf of shelves) {
    const nextId = nextEpisodeId(shelf.episodes, library.resume?.episodeId);
    if (nextId === undefined) continue;
    const index = shelf.episodes.findIndex((episode) => episode.id === nextId);
    const card = shelf.cards[index];
    if (card === undefined) continue;

    const shelfRect = shelf.element.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const left = cardRect.left - shelfRect.left + shelf.element.scrollLeft;
    shelf.element.scrollLeft = Math.max(0, left - (shelf.element.clientWidth - cardRect.width) / 2);
  }
}

/** The resume episode, or the first unfinished episode after the last watched one. */
function nextEpisodeId(episodes: readonly EpisodeSummary[], resumeId: string | undefined): string | undefined {
  if (resumeId !== undefined && episodes.some((episode) => episode.id === resumeId)) return resumeId;

  let lastWatched = -1;
  episodes.forEach((episode, index) => {
    if (episode.position > 0) lastWatched = index;
  });
  for (let index = lastWatched + 1; index < episodes.length; index += 1) {
    const episode = episodes[index];
    if (episode !== undefined && !isFinished(episode)) return episode.id;
  }
  return undefined;
}

function findEpisode(library: LibraryResponse, id: string): EpisodeSummary | undefined {
  for (const series of library.series) {
    const episode = series.episodes.find((candidate) => candidate.id === id);
    if (episode !== undefined) return episode;
  }
  return undefined;
}

function heroDetail(title: string, episode: EpisodeSummary | undefined): string {
  if (episode === undefined || episode.duration <= 0) return title;
  const remaining = episode.duration - episode.position;
  if (remaining < FINISHED_REMAINING_S) return title;
  return `${title} · 剩余 ${minutes(remaining)} 分钟`;
}

function episodeMeta(episode: EpisodeSummary, hasJapanese: boolean): string {
  if (!hasJapanese) return '无日文字幕';
  if (isFinished(episode)) return '已看完';
  if (episode.duration <= 0) return '';
  if (episode.position > 0) return `剩余 ${minutes(episode.duration - episode.position)} 分钟`;
  return `${Math.max(1, Math.round(episode.duration / 60))} 分钟`;
}

function isFinished(episode: EpisodeSummary): boolean {
  return episode.duration > 0 && episode.duration - episode.position < FINISHED_REMAINING_S;
}

function percent(episode: EpisodeSummary): number {
  if (episode.duration <= 0) return 0;
  return Math.min(100, Math.max(0, (episode.position / episode.duration) * 100));
}

/** Whole minutes, rounded away from zero so a started episode never says 0. */
function minutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

/** The episode number shown on a missing thumbnail: the digits in its title, else its position. */
function episodeNumber(episode: EpisodeSummary, index: number): string {
  const match = /\d+/.exec(episode.title);
  return match === null ? String(index + 1) : match[0];
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
