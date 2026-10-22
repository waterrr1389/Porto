// Prototype player: overlay subtitles, tap-to-lookup with a Yomitan-backed
// dictionary panel, and container fullscreen.
import { StructuredContentGenerator } from '/yomitan/js/display/structured-content-generator.js';

const $ = (id) => document.getElementById(id);
const v = $('v'), stage = $('stage'), jaBox = $('ja'), zhBox = $('zh');
const bar = $('bar'), seek = $('seek'), results = $('results');

// ---------------------------------------------------------------- subtitles

function parseTime(t) {
  const [h, m, s] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// Parses ASS Dialogue lines of the given style; cues sharing a time span merge.
function parseAss(text, style) {
  const byKey = new Map();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith('Dialogue:')) continue;
    const parts = raw.slice(9).split(',');
    if (parts.length < 10 || parts[3].trim() !== style) continue;
    const body = parts.slice(9).join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    if (!body) continue;
    const start = parseTime(parts[1].trim()), end = parseTime(parts[2].trim());
    const key = `${start}-${end}`;
    const cue = byKey.get(key);
    if (cue) cue.text += '\n' + body;
    else byKey.set(key, { start, end, text: body });
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start);
}

let jaCues = [], zhCues = [];
let shownJa = null, shownZh = null;
const active = (cues, t) => cues.filter((c) => c.start <= t && t < c.end);

function renderJa(cues) {
  jaBox.textContent = '';
  for (const cue of cues) {
    const line = document.createElement('div');
    line.className = 'line';
    for (const ch of cue.text) {
      if (ch === '\n') { line.append(document.createElement('br')); continue; }
      const span = document.createElement('span');
      span.className = 'ch';
      span.textContent = ch;
      line.append(span);
    }
    jaBox.append(line);
  }
}

function renderZh(cues) {
  zhBox.textContent = '';
  for (const cue of cues) {
    const line = document.createElement('div');
    line.className = 'line';
    line.textContent = cue.text;
    zhBox.append(line);
  }
}

const panelOpen = () => stage.classList.contains('panel-open');

function tick() {
  const t = v.currentTime;
  const ja = active(jaCues, t), zh = active(zhCues, t);
  const jaKey = ja.map((c) => c.start).join(), zhKey = zh.map((c) => c.start).join();
  // Keep the looked-up line on screen while the panel is open.
  if (jaKey !== shownJa && !panelOpen()) { shownJa = jaKey; renderJa(ja); }
  if (zhKey !== shownZh) { shownZh = zhKey; renderZh(zh); }
  if (!seeking && v.duration) seek.value = String((t / v.duration) * 1000);
  $('time').textContent = `${fmt(t)} / ${fmt(v.duration || 0)}`;
  requestAnimationFrame(tick);
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ------------------------------------------------------------------- lookup

const generator = new StructuredContentGenerator({
  loadMedia() {}, unloadAll() {}, prepareLink() {}, openMediaInTab() {},
}, document, window);

const JAPANESE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
let history = [];
let lookupSeq = 0;
let pausedByLookup = false;
let hitSpans = [];

async function lookup(text, { reset }) {
  const seq = ++lookupSeq;
  const res = await fetch(`/api/lookup?text=${encodeURIComponent(text)}`);
  const data = await res.json();
  if (seq !== lookupSeq) return null;
  if (reset) history = [];
  history.push({ text, data });
  showResults();
  return data;
}

jaBox.addEventListener('click', async (e) => {
  const span = e.target.closest('.ch');
  if (!span) return;
  e.stopPropagation();
  const spans = [...jaBox.querySelectorAll('.ch')];
  const from = spans.indexOf(span);
  const text = spans.slice(from, from + 32).map((s) => s.textContent).join('');
  if (!JAPANESE.test(text[0])) return;
  if (!v.paused) { v.pause(); pausedByLookup = true; }
  const data = await lookup(text, { reset: true });
  if (!data) return;
  setHit(spans.slice(from, from + Math.max(data.originalTextLength, 1)));
  openPanel();
});

// Nested lookup: tapping text inside a definition searches from that character.
results.addEventListener('click', (e) => {
  if (e.target.closest('button, summary, a')) return;
  const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  const node = range?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const text = node.data.slice(range.startOffset, range.startOffset + 32);
  if (!text || !JAPANESE.test(text[0])) return;
  lookup(text, { reset: false });
});

$('back').onclick = () => {
  if (history.length < 2) return;
  history.pop();
  showResults();
};
$('close').onclick = () => closePanel();

function setHit(spans) {
  hitSpans.forEach((s) => s.classList.remove('hit'));
  hitSpans = spans;
  hitSpans.forEach((s) => s.classList.add('hit'));
}

function openPanel() {
  stage.classList.add('panel-open');
}

function closePanel() {
  if (!panelOpen()) return false;
  stage.classList.remove('panel-open');
  setHit([]);
  shownJa = null;
  if (pausedByLookup) { pausedByLookup = false; v.play(); }
  return true;
}

function showResults() {
  const { text, data } = history[history.length - 1];
  $('back').disabled = history.length < 2;
  document.querySelector('#panel-head .query').textContent = text;
  results.textContent = '';
  results.scrollTop = 0;
  if (!data.entries.length) {
    results.append(el('div', 'empty', '没有找到词条'));
    return;
  }
  for (const entry of data.entries) results.append(renderEntry(entry));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEntry(entry) {
  const box = el('div', 'entry');
  const head = el('div', 'entry-head');
  const hw = entry.headwords[0];
  head.append(el('span', 'term', hw.term));
  if (hw.reading && hw.reading !== hw.term) head.append(el('span', 'reading', hw.reading));
  for (const other of entry.headwords.slice(1, 4)) {
    head.append(el('span', 'reading', `· ${other.term}`));
  }
  const mine = el('button', 'mine', '制卡');
  mine.onclick = () => { mine.textContent = '已记录（原型）'; };
  head.append(mine);
  box.append(head);

  const chips = el('div', 'chips');
  const chain = entry.inflectionRuleChainCandidates?.[0]?.inflectionRules ?? [];
  if (chain.length) chips.append(el('span', 'chip', `« ${chain.map((r) => r.name).join(' « ')}`));
  for (const f of entry.frequencies ?? []) {
    chips.append(el('span', 'chip freq', `${f.dictionaryAlias ?? f.dictionary} ${f.displayValue ?? f.frequency}`));
  }
  for (const p of entry.pronunciations ?? []) {
    for (const pr of p.pronunciations ?? []) {
      if (pr.type === 'pitch-accent') chips.append(el('span', 'chip', `[${pr.positions}]`));
    }
  }
  if (chips.childElementCount) box.append(chips);

  // Definitions grouped by dictionary, in dictionary priority order.
  const byDict = new Map();
  for (const def of entry.definitions) {
    if (!byDict.has(def.dictionary)) byDict.set(def.dictionary, []);
    byDict.get(def.dictionary).push(def);
  }
  let shown = 0;
  for (const [dictionary, defs] of byDict) {
    const details = el('details', 'dict');
    details.open = shown++ < 2;
    details.append(el('summary', null, dictionary));
    const list = el('ul', 'gloss');
    list.dataset.dictionary = dictionary;
    for (const def of defs) {
      for (const g of def.entries) {
        const li = el('li');
        li.append(renderGlossary(g, dictionary));
        list.append(li);
      }
    }
    details.append(list);
    box.append(details);
  }
  return box;
}

function renderGlossary(g, dictionary) {
  if (typeof g === 'string') return document.createTextNode(g);
  if (g.type === 'text') return document.createTextNode(g.text);
  if (g.type === 'structured-content') return generator.createStructuredContent(g.content, dictionary);
  return document.createTextNode('');
}

// Scopes each dictionary's bundled CSS to its own definitions.
function scopeCss(css, scope) {
  return css.replace(/(^|})\s*([^{}@]+)\{/g, (_, close, selectors) => {
    const scoped = selectors.split(',').map((s) => `${scope} ${s.trim()}`).join(', ');
    return `${close}\n${scoped} {`;
  });
}

// ------------------------------------------------------------------ chrome

let hideTimer;
const view = $('view');
function setBar(shown) {
  bar.classList.toggle('hidden', !shown);
  view.classList.toggle('bar-shown', shown);
}
function showBar() {
  setBar(true);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!v.paused) setBar(false); }, 3000);
}
$('tap').addEventListener('click', () => {
  if (closePanel()) return;
  if (bar.classList.contains('hidden')) showBar();
  else setBar(false);
});

$('play').onclick = () => (v.paused ? v.play() : v.pause());
v.addEventListener('play', () => { $('play').textContent = '❚❚'; showBar(); });
v.addEventListener('pause', () => { $('play').textContent = '▶'; setBar(true); });

let seeking = false;
seek.addEventListener('input', () => { seeking = true; showBar(); });
seek.addEventListener('change', () => {
  v.currentTime = (Number(seek.value) / 1000) * v.duration;
  seeking = false;
});

// Fullscreen the whole stage so overlays stay visible; never the <video> itself.
// iPhone Safari has no element fullscreen; there the home-screen web app is
// the fullscreen path, so the button is hidden.
if (!(stage.requestFullscreen || stage.webkitRequestFullscreen)) $('fs').hidden = true;
$('fs').onclick = () => {
  const inFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (inFs) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage);
};

function updateOrientation() {
  const landscape = stage.clientWidth >= stage.clientHeight;
  stage.classList.toggle('landscape', landscape);
  stage.classList.toggle('portrait', !landscape);
}
new ResizeObserver(updateOrientation).observe(stage);

// Stalls and network errors: resume from the current position.
v.addEventListener('error', () => {
  const t = v.currentTime;
  $('log').textContent = `media error ${v.error?.code}, reloading at ${fmt(t)}`;
  setTimeout(() => { v.load(); v.currentTime = t; v.play(); }, 1000);
});

(async () => {
  const [ja, zh, dicts] = await Promise.all([
    fetch('media/ep06.ja.ass').then((r) => r.text()),
    fetch('media/ep06.sc.ass').then((r) => r.text()),
    fetch('/api/dictionaries').then((r) => r.json()),
  ]);
  jaCues = parseAss(ja, 'Default');
  zhCues = parseAss(zh, 'Default');
  $('dict-styles').textContent = dicts
    .map((d) => scopeCss(d.styles, `[data-dictionary="${CSS.escape(d.title)}"]`))
    .join('\n');
  $('log').textContent = `ja ${jaCues.length} / zh ${zhCues.length} cues · ${dicts.length} dict`;
  setTimeout(() => ($('log').textContent = ''), 3000);
  requestAnimationFrame(tick);
})();
