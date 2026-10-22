// Wiring only: constructs the adapters and starts HTTP.
import { createServer } from 'node:http';
import { openDictionary } from './adapters/dictionary/index.ts';
import { createHandler } from './http.ts';
import { paths } from './paths.ts';

const port = Number(process.env.PORT ?? 8090);

const dictionary = await openDictionary(paths.dictionaryDatabase);
const titles = dictionary.dictionaries().map((d) => d.title);
console.log(titles.length > 0 ? `dictionaries: ${titles.join(', ')}` : 'no dictionaries; run `npm run import-dicts`');

createServer(createHandler({ dictionary, publicDir: paths.public, mediaDir: paths.media })).listen(port, '0.0.0.0', () =>
  console.log(`listening on http://0.0.0.0:${port}`),
);
