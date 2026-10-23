// The lookup panel: history of looked-up pages, entries rendered with
// Yomitan's structured-content generator, and nested lookups inside
// definitions. This is the only client module that imports Yomitan.
import { scopeCss } from '../../../core/css.ts';
import { scanText } from '../../../core/scan.ts';
import type { DictionaryInfo, LookupResponse, TermEntry, WordAudio } from '../../../shared/api.ts';
import type { Dispatch } from '../../effects.ts';
import { entryAudioKey, type EntryAudio, type LookupPage, type State } from '../../state.ts';
import { StructuredContentGenerator } from 'yomitan/structured-content-generator';
import 'yomitan/structured-content.css';

export interface PanelElements {
  stage: HTMLElement;
  back: HTMLButtonElement;
  query: HTMLElement;
  close: HTMLButtonElement;
  results: HTMLElement;
}

/** Yomitan's renderer asks for media and links that definitions in this panel never contain. */
const CONTENT_MANAGER = {
  loadMedia() {},
  unloadAll() {},
  prepareLink() {},
  openMediaInTab() {},
};

const SPEAKER_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18 7a7 7 0 0 1 0 10"/></svg>';
const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/** A press held this long opens the audio source list instead of playing. */
const AUDIO_LONG_PRESS_MS = 450;

export function createPanelView(els: PanelElements, dispatch: Dispatch) {
  const generator = new StructuredContentGenerator(CONTENT_MANAGER, document, window);
  let styled: readonly DictionaryInfo[] | null = null;
  let shownResponse: LookupResponse | undefined;
  let shownText: string | undefined;
  let entryControls: EntryControls[] = [];
  let latestPage: LookupPage | undefined;
  let openAudioMenu: { pageId: number; entryIndex: number } | null = null;

  const isAudioMenuOpen = (pageId: number, entryIndex: number): boolean =>
    openAudioMenu?.pageId === pageId && openAudioMenu.entryIndex === entryIndex;

  const toggleAudioMenu = (pageId: number, entryIndex: number): void => {
    const page = latestPage;
    if (page === undefined || audioSources(page, entryIndex).length === 0) return;
    openAudioMenu = isAudioMenuOpen(pageId, entryIndex) ? null : { pageId, entryIndex };
    updateEntryControls(page, entryControls, dispatch, isAudioMenuOpen);
  };

  els.back.addEventListener('click', () => dispatch({ type: 'panelBack' }));
  els.close.addEventListener('click', () => dispatch({ type: 'panelClosed' }));
  els.results.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('button, summary, a')) return;
    const caret = document.caretRangeFromPoint;
    const range = typeof caret === 'function' ? caret.call(document, event.clientX, event.clientY) : null;
    if (range === null) return;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = scanText((node as Text).data, range.startOffset);
    if (text === null) return;
    dispatch({ type: 'definitionTapped', text });
  });

  return function render(state: State): void {
    els.stage.classList.toggle('panel-open', state.lookup.panelOpen);

    if (state.dictionaries !== styled) {
      styled = state.dictionaries;
      applyDictionaryStyles(state.dictionaries);
    }

    els.back.disabled = state.lookup.history.length < 2;

    const page = state.lookup.history.at(-1);
    latestPage = page;
    // Rebuilding on the response keeps the results DOM and its scroll position
    // while mining or audio updates and on-screen cues change; the controls
    // follow in place.
    if (page?.response !== shownResponse || page?.text !== shownText) {
      shownResponse = page?.response;
      shownText = page?.text;
      entryControls = showPage(page);
    }
    updateEntryControls(page, entryControls, dispatch, isAudioMenuOpen);
  };

  function showPage(page: LookupPage | undefined): EntryControls[] {
    openAudioMenu = null;
    els.query.textContent = page?.text ?? '';
    els.results.scrollTop = 0;
    if (page === undefined) {
      els.results.replaceChildren();
      return [];
    }
    const entries = page.response.entries;
    if (entries.length === 0) {
      els.results.replaceChildren(el('div', 'empty', '没有找到词条'));
      return [];
    }
    const rendered = entries.map((entry, index) =>
      renderEntry(entry, generator, index, dispatch, page.id, toggleAudioMenu),
    );
    els.results.replaceChildren(...rendered.map(({ box }) => box));
    return rendered.map(({ controls }) => controls);
  }
}

/** The parts of one entry that duplicate checks, mining and audio update in place. */
interface EntryControls {
  mine: HTMLButtonElement;
  badge: HTMLElement;
  hint: HTMLElement;
  pageId: number;
  entryIndex: number;
  audioButton: HTMLButtonElement;
  audioMore: HTMLButtonElement;
  audioMenu: HTMLElement;
  audioMenuKey: string;
}

/** Scopes each dictionary's bundled CSS to the definitions it produced. */
function applyDictionaryStyles(dictionaries: readonly DictionaryInfo[]): void {
  let style = document.getElementById('dict-styles');
  if (style === null) {
    style = document.createElement('style');
    style.id = 'dict-styles';
    document.head.append(style);
  }
  style.textContent = dictionaries
    .map((dictionary) => scopeCss(dictionary.styles, `[data-dictionary="${CSS.escape(dictionary.title)}"]`))
    .join('\n');
}

function renderEntry(
  entry: TermEntry,
  generator: StructuredContentGenerator,
  entryIndex: number,
  dispatch: Dispatch,
  pageId: number,
  toggleAudioMenu: (pageId: number, entryIndex: number) => void,
): { box: HTMLElement; controls: EntryControls } {
  const box = el('div', 'entry');
  const head = el('div', 'entry-head');
  const headword = entry.headwords[0];
  if (headword !== undefined) {
    head.append(el('span', 'term', headword.term));
    if (headword.reading !== '' && headword.reading !== headword.term) {
      head.append(el('span', 'reading', headword.reading));
    }
  }

  const audioButton = el('button', 'audio-button');
  audioButton.type = 'button';
  audioButton.innerHTML = SPEAKER_ICON;
  audioButton.setAttribute('aria-label', '播放发音');
  const audioMore = el('button', 'audio-more');
  audioMore.type = 'button';
  audioMore.innerHTML = CHEVRON_ICON;
  audioMore.setAttribute('aria-label', '选择发音来源');
  audioMore.hidden = true;

  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let longPressed = false;
  audioButton.addEventListener('pointerdown', () => {
    longPressed = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      longPressed = true;
      toggleAudioMenu(pageId, entryIndex);
    }, AUDIO_LONG_PRESS_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    audioButton.addEventListener(type, () => clearTimeout(pressTimer));
  }
  audioButton.addEventListener('click', () => {
    clearTimeout(pressTimer);
    if (longPressed) {
      longPressed = false;
      return;
    }
    dispatch({ type: 'wordAudioRequested', pageId, entryIndex });
  });
  audioMore.addEventListener('click', () => toggleAudioMenu(pageId, entryIndex));

  const audioControl = el('span', 'audio-control');
  audioControl.append(audioButton, audioMore);
  head.append(audioControl);

  for (const other of entry.headwords.slice(1, 4)) {
    head.append(el('span', 'reading', `· ${other.term}`));
  }
  const badge = el('span', 'dup-badge');
  badge.hidden = true;
  head.append(badge);
  const mine = el('button', 'mine', '制卡');
  mine.type = 'button';
  mine.addEventListener('click', () => {
    dispatch({ type: 'mineRequested', entryIndex, definitions: collectDefinitions(box) });
  });
  const hint = el('span', 'mine-hint');
  hint.hidden = true;
  head.append(mine, hint);
  box.append(head);

  const audioMenu = el('div', 'audio-menu');
  audioMenu.hidden = true;
  box.append(audioMenu);

  const chips = el('div', 'chips');
  if (entry.inflections.length > 0) {
    chips.append(el('span', 'chip', `« ${entry.inflections.join(' « ')}`));
  }
  for (const frequency of entry.frequencies) {
    chips.append(el('span', 'chip freq', `${frequency.dictionary} ${frequency.value}`));
  }
  for (const pitch of entry.pitches) {
    chips.append(el('span', 'chip', `[${pitch}]`));
  }
  if (chips.childElementCount > 0) box.append(chips);

  entry.definitions.forEach((definition, index) => {
    const details = el('details', 'dict');
    details.open = index < 2;
    details.append(el('summary', null, definition.dictionary));
    const list = el('ul', 'gloss');
    list.dataset.dictionary = definition.dictionary;
    for (const glossary of definition.glossary) {
      const item = el('li', null);
      if (glossary.type === 'text') {
        item.append(document.createTextNode(glossary.text));
      } else {
        const content = generator.createStructuredContent(glossary.content, definition.dictionary);
        if (content !== null) item.append(content);
      }
      list.append(item);
    }
    details.append(list);
    box.append(details);
  });

  return {
    box,
    controls: {
      mine,
      badge,
      hint,
      pageId,
      entryIndex,
      audioButton,
      audioMore,
      audioMenu,
      audioMenuKey: '',
    },
  };
}

function audioStateForEntry(page: LookupPage, entryIndex: number): EntryAudio | undefined {
  const headword = page.response.entries[entryIndex]?.headwords[0];
  if (headword === undefined) return undefined;
  return page.audio[entryAudioKey(headword.term, headword.reading)];
}

function audioSources(page: LookupPage, entryIndex: number): readonly WordAudio[] {
  const audio = audioStateForEntry(page, entryIndex);
  return audio?.status === 'list' ? audio.sources : [];
}

/** Definition HTML is rendered here and sent along; the server never renders it. */
function collectDefinitions(box: HTMLElement): { dictionary: string; html: string }[] {
  return [...box.querySelectorAll<HTMLElement>('ul.gloss[data-dictionary]')].map((list) => ({
    dictionary: list.dataset.dictionary ?? '',
    html: list.innerHTML,
  }));
}

function updateEntryControls(
  page: LookupPage | undefined,
  controls: readonly EntryControls[],
  dispatch: Dispatch,
  isAudioMenuOpen: (pageId: number, entryIndex: number) => boolean,
): void {
  controls.forEach((control) => {
    const { mine, badge, hint } = control;
    const entryIndex = control.entryIndex;
    const term = page?.response.entries[entryIndex]?.headwords[0]?.term;
    const duplicates = page?.duplicates;
    const count = term !== undefined && typeof duplicates === 'object' ? duplicates[term] ?? 0 : 0;
    const status = page?.mined[entryIndex];

    badge.hidden = count <= 0;
    if (count > 0) badge.textContent = `已有 ${count} 张`;

    hint.hidden = true;
    hint.textContent = '';
    mine.title = '';
    mine.disabled = false;
    mine.classList.toggle('secondary', status === undefined && count > 0);

    if (status === undefined) {
      if (duplicates === 'unavailable') {
        hint.textContent = 'Anki 未连接';
        hint.hidden = false;
      } else if (duplicates === undefined) {
        hint.textContent = '查重中…';
        hint.hidden = false;
      }
      // The badge already says how many exist; the grey button only signals it.
      mine.textContent = '制卡';
    } else {
      mine.classList.remove('secondary');
      switch (status.status) {
        case 'mining':
          mine.textContent = '制卡中…';
          mine.disabled = true;
          break;
        case 'done':
          mine.textContent = status.duplicates > 0 ? `已制卡（已有 ${status.duplicates} 张）` : '已制卡';
          mine.disabled = true;
          break;
        case 'error':
          mine.textContent = '重试';
          mine.title = status.message;
          break;
      }
    }

    updateAudioControls(page, control, dispatch, isAudioMenuOpen);
  });
}

function updateAudioControls(
  page: LookupPage | undefined,
  control: EntryControls,
  dispatch: Dispatch,
  isAudioMenuOpen: (pageId: number, entryIndex: number) => boolean,
): void {
  const audio = page === undefined ? undefined : audioStateForEntry(page, control.entryIndex);
  const sources = audio?.status === 'list' ? audio.sources : [];
  const selected = audio?.status === 'list' ? audio.selected : 0;
  const loading = audio?.status === 'loading';
  const unavailable = audio?.status === 'unavailable';
  const empty = audio?.status === 'list' && sources.length === 0;

  control.audioButton.classList.toggle('loading', loading);
  control.audioButton.disabled = loading || unavailable || empty;
  control.audioButton.title = empty ? '无发音' : unavailable ? 'Anki 未连接' : '';
  control.audioMore.hidden = sources.length === 0;

  const open = sources.length > 0 && isAudioMenuOpen(control.pageId, control.entryIndex);
  control.audioMenu.hidden = !open;
  if (!open) {
    if (control.audioMenuKey !== '') {
      control.audioMenuKey = '';
      control.audioMenu.replaceChildren();
    }
    return;
  }

  const key = `${selected}:${sources.map((source) => source.name).join('\u0000')}`;
  if (key === control.audioMenuKey) return;
  control.audioMenuKey = key;
  control.audioMenu.replaceChildren(
    ...sources.map((source, index) => {
      const row = el('button', 'audio-source');
      row.type = 'button';
      row.append(el('span', 'audio-source-name', source.name));
      if (index === selected) row.append(el('span', 'audio-source-check', '✓'));
      row.addEventListener('click', () => {
        dispatch({
          type: 'wordAudioChosen',
          pageId: control.pageId,
          entryIndex: control.entryIndex,
          index,
        });
      });
      return row;
    }),
  );
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== null) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
