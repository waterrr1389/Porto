// The Japanese and Chinese subtitle overlays. Japanese text is split into one
// element per character, carrying its cue id and code-unit offset, so a tap
// can be turned into a lookup by core/scan.
import type { Cue } from '../../core/subtitles.ts';
import type { State, Track } from '../state.ts';

export interface SubtitleElements {
  ja: HTMLElement;
  zh: HTMLElement;
}

export function createSubtitlesView(els: SubtitleElements) {
  const shown: Record<Track, string | null> = { ja: null, zh: null };

  return function render(state: State): void {
    for (const track of ['ja', 'zh'] as const) {
      const cues = state.onScreen[track].map((id) => state.cues[track][id]).filter((c): c is Cue => c !== undefined);
      const key = cues.map((c) => c.id).join();
      if (key === shown[track]) continue;
      shown[track] = key;
      els[track].replaceChildren(...cues.map(track === 'ja' ? tappableLine : plainLine));
    }
  };
}

function plainLine(cue: Cue): HTMLElement {
  const line = document.createElement('div');
  line.className = 'line';
  line.textContent = cue.text;
  return line;
}

function tappableLine(cue: Cue): HTMLElement {
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
      line.append(span);
    }
    offset += char.length;
  }
  return line;
}
