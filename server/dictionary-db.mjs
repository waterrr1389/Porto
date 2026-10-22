// SQLite-backed stand-in for Yomitan's DictionaryDatabase. Implements only the
// methods its DictionaryImporter and Translator call; rows keep Yomitan's
// object shape as JSON, with the looked-up fields copied into indexed columns.
import { DatabaseSync } from 'node:sqlite';

// Store name -> indexed fields (column names match Yomitan's index names).
const STORES = {
  dictionaries: ['title'],
  terms: ['dictionary', 'expression', 'reading', 'sequence'],
  termMeta: ['dictionary', 'expression'],
  kanji: ['dictionary', 'character'],
  kanjiMeta: ['dictionary', 'character'],
  tagMeta: ['dictionary', 'name'],
  media: ['dictionary', 'path'],
};

const splitField = (f) => (typeof f === 'string' && f.length > 0 ? f.split(' ') : []);

export class SqliteDictionaryDatabase {
  constructor(path) {
    this._db = new DatabaseSync(path);
    this._db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    for (const [store, cols] of Object.entries(STORES)) {
      this._db.exec(`CREATE TABLE IF NOT EXISTS ${store} (
        id INTEGER PRIMARY KEY, ${cols.map((c) => `${c}`).join(', ')}, json TEXT NOT NULL)`);
      for (const c of cols) {
        this._db.exec(`CREATE INDEX IF NOT EXISTS ${store}_${c} ON ${store}(${c})`);
      }
    }
    this._insert = {};
    for (const [store, cols] of Object.entries(STORES)) {
      this._insert[store] = this._db.prepare(
        `INSERT INTO ${store} (${cols.join(', ')}, json) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
      );
    }
    this._stmts = new Map();
  }

  _stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this._db.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }

  _rows(sql, ...params) {
    return this._stmt(sql).all(...params).map((r) => ({ ...JSON.parse(r.json), id: r.id }));
  }

  close() { this._db.close(); }

  // Importer-facing API

  isPrepared() { return true; }

  async prepare() {}

  async dictionaryExists(title) {
    return this._stmt('SELECT 1 FROM dictionaries WHERE title = ?').get(title) !== undefined;
  }

  async bulkAdd(store, items, start, count) {
    const insert = this._insert[store];
    const cols = STORES[store];
    this._db.exec('BEGIN');
    try {
      for (let i = start; i < start + count; i++) {
        const row = items[i];
        insert.run(...cols.map((c) => row[c] ?? null), JSON.stringify(row));
      }
      this._db.exec('COMMIT');
    } catch (e) {
      this._db.exec('ROLLBACK');
      throw e;
    }
  }

  // Mimics the IDBRequest the importer attaches onsuccess/onerror to.
  async addWithResult(store, row) {
    const cols = STORES[store];
    const { lastInsertRowid } = this._insert[store].run(...cols.map((c) => row[c] ?? null), JSON.stringify(row));
    const request = { result: Number(lastInsertRowid), onsuccess: null, onerror: null };
    setImmediate(() => request.onsuccess?.());
    return request;
  }

  async bulkUpdate(store, items, start, count) {
    const cols = STORES[store];
    const sql = `UPDATE ${store} SET ${cols.map((c) => `${c} = ?`).join(', ')}, json = ? WHERE id = ?`;
    for (let i = start; i < start + count; i++) {
      const { data, primaryKey } = items[i];
      this._stmt(sql).run(...cols.map((c) => data[c] ?? null), JSON.stringify(data), primaryKey);
    }
  }

  // Translator-facing API

  async getDictionaryInfo() {
    return this._stmt('SELECT json FROM dictionaries').all().map((r) => JSON.parse(r.json));
  }

  async findTermsBulk(termList, dictionaries, matchType) {
    if (matchType === 'suffix') throw new Error('suffix match not supported');
    const visited = new Set();
    const results = [];
    termList.forEach((item, itemIndex) => {
      ['expression', 'reading'].forEach((col, indexIndex) => {
        const rows = matchType === 'prefix'
          ? this._rows(`SELECT id, json FROM terms WHERE ${col} >= ? AND ${col} < ?`, item, `${item}￿`)
          : this._rows(`SELECT id, json FROM terms WHERE ${col} = ?`, item);
        for (const row of rows) {
          if (!dictionaries.has(row.dictionary) || visited.has(row.id)) continue;
          visited.add(row.id);
          const source = indexIndex === 0 ? 'term' : 'reading';
          const exact = (indexIndex === 0 ? row.expression : row.reading) === item;
          results.push(createTerm(source, exact ? 'exact' : matchType, row, itemIndex));
        }
      });
    });
    return results;
  }

  async findTermsExactBulk(termList, dictionaries) {
    const results = [];
    termList.forEach((item, itemIndex) => {
      for (const row of this._rows('SELECT id, json FROM terms WHERE expression = ?', item.term)) {
        if (row.reading === item.reading && dictionaries.has(row.dictionary)) {
          results.push(createTerm('term', 'exact', row, itemIndex));
        }
      }
    });
    return results;
  }

  async findTermsBySequenceBulk(items) {
    const results = [];
    items.forEach((item, itemIndex) => {
      for (const row of this._rows('SELECT id, json FROM terms WHERE sequence = ? AND dictionary = ?', item.query, item.dictionary)) {
        results.push(createTerm('sequence', 'exact', row, itemIndex));
      }
    });
    return results;
  }

  async findTermMetaBulk(termList, dictionaries) {
    const results = [];
    termList.forEach((item, index) => {
      for (const { expression: term, mode, data, dictionary } of this._rows('SELECT id, json FROM termMeta WHERE expression = ?', item)) {
        if (dictionaries.has(dictionary)) results.push({ index, term, mode, data, dictionary });
      }
    });
    return results;
  }

  async findKanjiBulk(kanjiList, dictionaries) {
    const results = [];
    kanjiList.forEach((item, index) => {
      for (const row of this._rows('SELECT id, json FROM kanji WHERE character = ?', item)) {
        if (!dictionaries.has(row.dictionary)) continue;
        results.push({
          index,
          character: row.character,
          onyomi: splitField(row.onyomi),
          kunyomi: splitField(row.kunyomi),
          tags: splitField(row.tags),
          definitions: row.meanings,
          stats: typeof row.stats === 'object' && row.stats !== null ? row.stats : {},
          dictionary: row.dictionary,
        });
      }
    });
    return results;
  }

  async findKanjiMetaBulk(kanjiList, dictionaries) {
    const results = [];
    kanjiList.forEach((item, index) => {
      for (const { character, mode, data, dictionary } of this._rows('SELECT id, json FROM kanjiMeta WHERE character = ?', item)) {
        if (dictionaries.has(dictionary)) results.push({ index, character, mode, data, dictionary });
      }
    });
    return results;
  }

  async findTagMetaBulk(items) {
    return items.map((item) => {
      const r = this._stmt('SELECT json FROM tagMeta WHERE name = ? AND dictionary = ? LIMIT 1').get(item.query, item.dictionary);
      return r ? JSON.parse(r.json) : undefined;
    });
  }
}

function createTerm(matchSource, matchType, row, index) {
  return {
    index,
    matchType,
    matchSource,
    term: row.expression,
    reading: row.reading,
    definitionTags: splitField(row.definitionTags || row.tags),
    termTags: splitField(row.termTags),
    rules: splitField(row.rules),
    definitions: row.glossary,
    score: row.score,
    dictionary: row.dictionary,
    id: row.id,
    sequence: typeof row.sequence === 'number' ? row.sequence : -1,
  };
}
