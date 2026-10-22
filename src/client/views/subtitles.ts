// The Japanese and Chinese subtitle overlays. Japanese text is split into one
// element per character, carrying its cue id and code-unit offset, so a tap
// can be turned into a lookup by core/scan.
import type { Cue } from '../../core/subtitles.ts';
import type { Dispatch } from '../effects.ts';
import type { LookupHighlight, State, Track } from '../state.ts';

export interface SubtitleElements {
  ja: HTMLElement;
  zh: HTMLElement;
}

export function createSubtitlesView(
  els: SubtitleElements,
  dispatch: Dispatch,
  currentTime: () => number,
) {
  const shown: Record<Track, string | null> = { ja: null, zh: null };

  els.ja.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const span = event.target.closest<HTMLElement>('.ch');
    const line = span?.closest<HTMLElement>('.line');
    if (!span || !line || !els.ja.contains(span)) return;
    const cueId = Number(line.dataset.cue);
    const offset = Number(span.dataset.offset);
    if (!Number.isInteger(cueId) || !Number.isInteger(offset)) return;
    // The stage tap layer sits behind the subtitles; a character tap must not toggle the controls too.
    event.stopPropagation();
    dispatch({ type: 'characterTapped', cueId, offset, time: currentTime() });
  });

  return function render(state: State): void {
    for (const track of ['ja', 'zh'] as const) {
      // Keep the looked-up line on screen while the panel is open.
      const ids = track === 'ja' ? state.lookup.pinnedJa ?? state.onScreen.ja : state.onScreen[track];
      const cues = ids.map((id) => state.cues[track][id]).filter((cue): cue is Cue => cue !== undefined);
      const highlight = track === 'ja' ? state.lookup.highlight : null;
      const key = [
        cues.map((cue) => cue.id).join(),
        highlight === null ? '' : `${highlight.cueId}:${highlight.start}:${highlight.end}`,
      ].join('|');
      if (key === shown[track]) continue;
      shown[track] = key;
      els[track].replaceChildren(...cues.map(track === 'ja' ? tappableLine(highlight) : plainLine));
    }
  };
}

function plainLine(cue: Cue): HTMLElement {
  const line = document.createElement('div');
  line.className = 'line';
  line.textContent = cue.text;
  return line;
}

function tappableLine(highlight: LookupHighlight | null) {
  return (cue: Cue): HTMLElement => {
    const line = document.createElement('div');
    line.className = 'line';
    line.dataset.cue = String(cue.id);
    let offset = 0;
    for (const char of cue.text) {
      if (char === '\n') {
        line.append(document.createElement('br'));
      } else {
        const span = document.createElement('span');
        span.className = 'ch';
        span.dataset.offset = String(offset);
        span.textContent = char;
        if (highlight !== null && highlight.cueId === cue.id && offset >= highlight.start && offset < highlight.end) {
          span.classList.add('hit');
        }
        line.append(span);
      }
      offset += char.length;
    }
    return line;
  };
}
