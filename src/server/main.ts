// Wiring only: reads config, constructs the adapters and starts HTTP.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { openDictionary } from './adapters/dictionary/index.ts';
import { createLibrary } from './adapters/library.ts';
import { createMediaCache } from './adapters/media/index.ts';
import { openStore } from './adapters/store.ts';
import { createHandler } from './http.ts';
import { paths } from './paths.ts';

const port = Number(process.env.PORT ?? 8090);

const store = openStore(paths.state);
const dictionary = await openDictionary(paths.dictionaryDatabase);
const titles = dictionary.dictionaries().map((d) => d.title);
console.log(titles.length > 0 ? `dictionaries: ${titles.join(', ')}` : 'no dictionaries; run `npm run import-dicts`');

const library = createLibrary(store.config.mediaRoots);
const media = createMediaCache({ dir: join(paths.cache, 'media'), limitBytes: store.config.cacheLimitGB * 1e9 });

const handler = createHandler({ dictionary, library, progress: store, media, publicDir: paths.public });
createServer(handler).listen(port, '0.0.0.0', () => console.log(`listening on http://0.0.0.0:${port}`));
