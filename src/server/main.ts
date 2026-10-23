// Wiring only: reads config, constructs the adapters and starts HTTP.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createAnki } from './adapters/anki.ts';
import { openDictionary } from './adapters/dictionary/index.ts';
import { createLibrary } from './adapters/library.ts';
import { createMediaCache } from './adapters/media/index.ts';
import { openStore } from './adapters/store.ts';
import { createHandler } from './http.ts';
import { createMiner } from './mining.ts';
import { paths } from './paths.ts';

const port = Number(process.env.PORT ?? 8090);

const store = openStore(paths.state);
const dictionary = await openDictionary(paths.dictionaryDatabase);
const titles = dictionary.dictionaries().map((d) => d.title);
console.log(titles.length > 0 ? `dictionaries: ${titles.join(', ')}` : 'no dictionaries; run `npm run import-dicts`');

const media = createMediaCache({
  dir: join(paths.cache, 'media'),
  thumbsDir: join(paths.cache, 'thumbs'),
  subsDir: join(paths.cache, 'subs'),
  limitBytes: store.config.cacheLimitGB * 1e9,
});
if (store.config.mediaRoots.length === 0) {
  console.warn(`no media roots configured; add directories to mediaRoots in ${join(paths.state, 'config.json')}`);
}
const library = createLibrary(store.config.mediaRoots, {
  embeddedSubtitles: (source) => media.embeddedSubtitles(source),
});
const anki = createAnki(store.config.anki);
const cards = createMiner({ library, media, anki, store, workDir: join(paths.cache, 'cards') });

const handler = createHandler({
  dictionary,
  library,
  progress: store,
  media,
  subtitles: store,
  cards,
  publicDir: paths.public,
});
createServer(handler).listen(port, '0.0.0.0', () => console.log(`listening on http://0.0.0.0:${port}`));
