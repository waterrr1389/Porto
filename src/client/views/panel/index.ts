// The lookup panel: history of looked-up pages, entries rendered with
// Yomitan's structured-content generator, and nested lookups inside
// definitions. This is the only client module that imports Yomitan.
import { scopeCss } from '../../../core/css.ts';
import { scanText } from '../../../core/scan.ts';
import type { DictionaryInfo, LookupResponse, TermEntry } from '../../../shared/api.ts';
import type { Dispatch } from '../../effects.ts';
import type { LookupPage, State } from '../../state.ts';
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

export function createPanelView(els: PanelElements, dispatch: Dispatch) {
  const generator = new StructuredContentGenerator(CONTENT_MANAGER, document, window);
  let styled: readonly DictionaryInfo[] | null = null;
  let shownResponse: LookupResponse | undefined;
  let shownText: string | undefined;
  let entryControls: EntryControls[] = [];

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
    // Rebuilding on the response keeps the results DOM and its scroll position
    // while mining updates or on-screen cues change; the button states follow
    // in place.
    if (page?.response !== shownResponse || page?.text !== shownText) {
      shownResponse = page?.response;
      shownText = page?.text;
      entryControls = showPage(page);
    }
    updateEntryControls(page, entryControls);
  };

  function showPage(page: LookupPage | undefined): EntryControls[] {
    els.query.textContent = page?.text ?? '';
    els.results.scrollTop = 0;
    const entries = page?.response.entries ?? [];
    if (entries.length === 0) {
      els.results.replaceChildren(...(page === undefined ? [] : [el('div', 'empty', '没有找到词条')]));
      return [];
    }
    const rendered = entries.map((entry, index) => renderEntry(entry, generator, index, dispatch));
    els.results.replaceChildren(...rendered.map(({ box }) => box));
    return rendered.map(({ controls }) => controls);
  }
}

/** The parts of one entry that duplicate checks and mining update in place. */
interface EntryControls {
  mine: HTMLButtonElement;
  badge: HTMLElement;
  hint: HTMLElement;
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

  return { box, controls: { mine, badge, hint } };
}

/** Definition HTML is rendered here and sent along; the server never renders it. */
function collectDefinitions(box: HTMLElement): { dictionary: string; html: string }[] {
  return [...box.querySelectorAll<HTMLElement>('ul.gloss[data-dictionary]')].map((list) => ({
    dictionary: list.dataset.dictionary ?? '',
    html: list.innerHTML,
  }));
}

function updateEntryControls(page: LookupPage | undefined, controls: readonly EntryControls[]): void {
  controls.forEach(({ mine, badge, hint }, entryIndex) => {
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
      mine.textContent = count > 0 ? '再制一张' : '制卡';
      return;
    }

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
  });
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
