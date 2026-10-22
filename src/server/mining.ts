// Creating a card: captures the screenshot and audio clip from the source
// video, checks the deck for the same expression and adds the note. The
// temporary media lives under cache/ and is deleted once AnkiConnect has
// copied the files into its collection.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { duplicateQuery, lapisCard } from '../core/card.ts';
import type { CardRequest, CardResponse } from '../shared/api.ts';
import type { Anki } from './adapters/anki.ts';
import type { Library } from './adapters/library.ts';
import type { MediaCache } from './adapters/media/index.ts';
import type { Store } from './adapters/store.ts';

export interface MinerOptions {
  library: Library;
  media: MediaCache;
  anki: Anki;
  store: Store;
  /** Parent directory for per-card temporary media, e.g. cache/cards. */
  workDir: string;
}

export interface Miner {
  mine(request: CardRequest): Promise<CardResponse>;
  /** Counts, per distinct term, the notes in the deck with that expression. */
  duplicates(terms: string[]): Promise<Record<string, number>>;
}

/** The episode id in the request does not exist in the library. */
export class EpisodeNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpisodeNotFound';
  }
}

/** Anki was unreachable or refused the note; the message is safe to show. */
export class AnkiFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnkiFailure';
  }
}

export function createMiner(options: MinerOptions): Miner {
  return {
    async mine(request) {
      const located = await options.library.episode(request.episodeId);
      if (!located) throw new EpisodeNotFound(`unknown episode: ${request.episodeId}`);

      const plan = lapisCard({
        term: request.term,
        reading: request.reading,
        definitions: request.definitions,
        frequencies: request.frequencies,
        pitches: request.pitches,
        cue: request.cue,
        highlight: request.highlight,
        time: request.time,
        seriesTitle: located.series.title,
        episodeNumber: located.episode.number,
        episodeTitle: located.episode.title,
      });

      await mkdir(options.workDir, { recursive: true });
      const cardDir = await mkdtemp(join(options.workDir, 'card-'));
      try {
        const screenshotPath = join(cardDir, plan.media.screenshot.fileName);
        const audioPath = join(cardDir, plan.media.audio.fileName);
        const media = [
          { path: screenshotPath, fileName: plan.media.screenshot.fileName },
          { path: audioPath, fileName: plan.media.audio.fileName },
        ];

        await Promise.all([
          options.media.screenshot(located.videoPath, plan.media.screenshot.time, screenshotPath),
          options.media.audioClip(located.videoPath, plan.media.audio.start, plan.media.audio.end, audioPath),
        ]);

        let duplicateCount: number;
        let noteId: number;
        try {
          duplicateCount = (await options.anki.findNotes(plan.duplicateQuery)).length;
          noteId = await options.anki.addNote(plan.fields, media, ['sla']);
        } catch (error) {
          throw new AnkiFailure(error instanceof Error ? error.message : String(error));
        }

        options.store.recordCard({
          noteId,
          term: request.term,
          episodeId: located.episode.id,
          time: request.time,
        });
        return { noteId, duplicates: duplicateCount };
      } finally {
        await rm(cardDir, { recursive: true, force: true });
      }
    },

    async duplicates(terms) {
      const distinct = [...new Set(terms)];
      let counts: number[][];
      try {
        counts = await options.anki.findNotesBatch(distinct.map((term) => duplicateQuery(term)));
      } catch (error) {
        throw new AnkiFailure(error instanceof Error ? error.message : String(error));
      }
      // fromEntries keeps unusual expressions such as "__proto__" as own keys.
      return Object.fromEntries(distinct.map((term, index) => [term, (counts[index] ?? []).length]));
    },
  };
}
