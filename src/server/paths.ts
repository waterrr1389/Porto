// Where the server keeps its files, relative to the repository root.
// cache/ is derived and may be deleted at any time; state/ is never deleted by
// the program (see Invariants in ARCHITECTURE.md).
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export const paths = {
  root,
  cache: join(root, 'cache'),
  state: join(root, 'state'),
  /** Yomitan dictionary zips, the input of `npm run import-dicts`. */
  dicts: join(root, 'dicts'),
  dictionaryDatabase: join(root, 'cache', 'dictionaries.sqlite'),
  /** The bundled client. */
  public: join(root, 'dist'),
  /** Prototype media until the library adapter serves episodes. */
  media: join(root, 'media'),
};
