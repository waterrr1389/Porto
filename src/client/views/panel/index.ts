// The lookup panel: history of looked-up pages, entries rendered with
// Yomitan's structured-content generator, and nested lookups inside
// definitions. This is the only client module that imports Yomitan.
import { scopeCss } from '../../../core/css.ts';
import { scanText } from '../../../core/scan.ts';
import type { DictionaryInfo, LookupResponse, TermEntry, WordAudio } from '../../../shared/api.ts';
import type { Dispatch } from '../../effects.ts';
import { furiganaParts, hasKanji } from '../../ruby.ts';
import { entryAudioKey, type EntryAudio, type LookupPage, type State } from '../../state.ts';
import { AnkiTemplateRendererContentManager } from 'yomitan/anki-template-renderer-content-manager';
import { StructuredContentGenerator } from 'yomitan/structured-content-generator';
import 'yomitan/structured-content.css';

export interface PanelElements {
  stage: HTMLElement;
  back: HTMLButtonElement;
  query: HTMLElement;
  close: HTMLButtonElement;
  results: HTMLElement;
}

/**
 * Images in definitions, such as a dictionary's 注意 icon, come from the server.
 * Yomitan's renderer only loads media through its own content manager classes,
 * so the panel uses the one it ships for Anki templates.
 */
const CONTENT_MANAGER = new AnkiTemplateRendererContentManager(
  {
    getMedia: (_data, [, path], { dictionary }) =>
      `/api/dictionaries/media?dictionary=${encodeURIComponent(dictionary)}&path=${encodeURIComponent(path)}`,
  },
  {},
);

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
    // Links inside definitions only exist to be looked up; following them would leave the page.
    if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('button, summary, a, .inflection')) return;
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

  const headwordBlock = el('div', 'headword-block');
  if (headword !== undefined) {
    headwordBlock.append(termElement(headword.term, headword.reading));
    for (const other of entry.headwords.slice(1, 4)) {
      headwordBlock.append(el('span', 'reading', `· ${other.term}`));
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

  const badge = el('span', 'dup-badge');
  badge.hidden = true;
  const mine = el('button', 'mine', '制卡');
  mine.type = 'button';
  mine.addEventListener('click', () => {
    dispatch({ type: 'mineRequested', entryIndex, definitions: collectDefinitions(box) });
  });
  const hint = el('span', 'mine-hint');
  hint.hidden = true;
  const actions = el('div', 'headword-actions');
  actions.append(badge, audioControl, mine, hint);
  head.append(headwordBlock, actions);
  box.append(head);

  const audioMenu = el('div', 'audio-menu');
  audioMenu.hidden = true;
  box.append(audioMenu);

  const tags = el('div', 'entry-tags');
  const note = inflectionNote();
  if (entry.inflections.length > 0) tags.append(inflectionChain(entry.inflections, note));
  for (const frequency of entry.frequencies) tags.append(frequencyTag(frequency));
  if (tags.childElementCount > 0) box.append(tags);
  if (entry.inflections.some((rule) => rule.description !== undefined)) box.append(note.node);

  for (const accent of entry.pitchAccents) box.append(pitchRow(accent));

  if (entry.definitions.length > 0) {
    const definitions = el('div', 'definitions');
    entry.definitions.forEach((definition, index) => definitions.append(definitionRow(definition, index, generator)));
    box.append(definitions);
  }

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

interface InflectionNote {
  node: HTMLElement;
  /** Index of the rule whose explanation is open, or null. */
  open: number | null;
}

function inflectionNote(): InflectionNote {
  const node = el('div', 'inflection-note');
  node.hidden = true;
  return { node, open: null };
}

/**
 * Deinflection steps, in Yomitan's chain order. Yomitan keeps each rule's
 * explanation on its tag and shows it when tapped, so a rule name is only a
 * button when there is an explanation to show.
 */
function inflectionChain(rules: TermEntry['inflections'], note: InflectionNote): HTMLElement {
  const chain = el('span', 'inflection');
  for (const [index, rule] of rules.entries()) {
    chain.append(document.createTextNode('«'));
    const { description } = rule;
    if (description === undefined) {
      chain.append(el('span', 'chip', rule.name));
      continue;
    }
    const name = el('button', 'chip inflection-name', rule.name);
    name.type = 'button';
    name.title = description;
    name.addEventListener('click', () => {
      const open = note.open !== index;
      note.open = open ? index : null;
      note.node.hidden = !open;
      if (open) note.node.textContent = description;
    });
    chain.append(name);
  }
  return chain;
}

/** The headword with furigana over its kanji, or one ruby over the whole term. */
function termElement(term: string, reading: string): HTMLElement {
  const node = el('span', 'term');
  const parts = furiganaParts(term, reading);
  if (parts !== null) {
    for (const part of parts) {
      if (part.ruby !== undefined && part.ruby !== '') node.append(rubyElement(part.text, part.ruby));
      else node.append(document.createTextNode(part.text));
    }
    return node;
  }
  if (reading !== '' && reading !== term && hasKanji(term)) {
    node.append(rubyElement(term, reading));
    return node;
  }
  node.append(document.createTextNode(term));
  return node;
}

function rubyElement(text: string, reading: string): HTMLElement {
  const ruby = document.createElement('ruby');
  const rt = document.createElement('rt');
  rt.textContent = reading;
  ruby.append(document.createTextNode(text), rt);
  return ruby;
}

/** A two-part frequency pill: dictionary on green, value on neutral. */
function frequencyTag(frequency: TermEntry['frequencies'][number]): HTMLElement {
  const tag = el('span', 'freq-tag');
  tag.append(el('span', 'freq-dict', frequency.dictionary), el('span', 'freq-value', frequency.value));
  return tag;
}

function pitchRow(accent: TermEntry['pitchAccents'][number]): HTMLElement {
  const row = el('div', 'pitch-row');
  row.append(el('span', 'tag-purple pitch-dict', accent.dictionary));
  row.append(el('span', 'pitch-reading', accent.reading));
  for (const position of accent.positions) row.append(el('span', 'pitch-position', `[${position}]`));
  return row;
}

/** One numbered definition: purple dictionary tag, then its rendered senses. */
function definitionRow(
  definition: TermEntry['definitions'][number],
  index: number,
  generator: StructuredContentGenerator,
): HTMLElement {
  const row = el('div', 'definition');
  row.append(el('span', 'def-number', `${index + 1}.`));
  const body = el('div', 'def-body');
  body.append(el('span', 'tag-purple def-dict', definition.dictionary));
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
  body.append(list);
  row.append(body);
  return row;
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
