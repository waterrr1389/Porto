// SQLite stand-in for Yomitan's IndexedDB DictionaryDatabase. Implements only
// the methods its DictionaryImporter and Translator call. Rows keep Yomitan's
// object shape as JSON; the fields Yomitan queries by are copied into indexed
// columns named after its IndexedDB indexes.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

type Row = Record<string, unknown>;

const STORES: Record<string, readonly string[]> = {
  dictionaries: ['title'],
  terms: ['dictionary', 'expression', 'reading', 'sequence'],
  termMeta: ['dictionary', 'expression'],
  kanji: ['dictionary', 'character'],
  kanjiMeta: ['dictionary', 'character'],
  tagMeta: ['dictionary', 'name'],
  media: ['dictionary', 'path'],
};

const splitField = (value: unknown): string[] =>
  typeof value === 'string' && value.length > 0 ? value.split(' ') : [];

const columnValue = (value: unknown): string | number | null =>
  typeof value === 'string' || typeof value === 'number' ? value : null;

function columnsOf(store: string): readonly string[] {
  const columns = STORES[store];
  if (!columns) throw new Error(`unknown store ${store}`);
  return columns;
}

export class SqliteDictionaryDatabase {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    for (const [store, columns] of Object.entries(STORES)) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${store} (id INTEGER PRIMARY KEY, ${columns.join(', ')}, json TEXT NOT NULL)`);
      for (const column of columns) {
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${store}_${column} ON ${store}(${column})`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private rows(sql: string, ...params: (string | number)[]): Row[] {
    return this.statement(sql)
      .all(...params)
      .map((r) => ({ ...(JSON.parse(String(r.json)) as Row), id: Number(r.id) }));
  }

  private insert(store: string, row: Row): number {
    const columns = columnsOf(store);
    const sql = `INSERT INTO ${store} (${columns.join(', ')}, json) VALUES (${columns.map(() => '?').join(', ')}, ?)`;
    const { lastInsertRowid } = this.statement(sql).run(...columns.map((c) => columnValue(row[c])), JSON.stringify(row));
    return Number(lastInsertRowid);
  }

  // Importer-facing API

  isPrepared(): boolean {
    return true;
  }

  async prepare(): Promise<void> {}

  async dictionaryExists(title: string): Promise<boolean> {
    return this.statement('SELECT 1 FROM dictionaries WHERE title = ?').get(title) !== undefined;
  }

  async bulkAdd(store: string, items: Row[], start: number, count: number): Promise<void> {
    this.db.exec('BEGIN');
    try {
      for (const row of items.slice(start, start + count)) this.insert(store, row);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Mimics the IDBRequest the importer attaches onsuccess/onerror to. */
  async addWithResult(store: string, row: Row): Promise<{ result: number; onsuccess: (() => void) | null; onerror: null }> {
    const request = { result: this.insert(store, row), onsuccess: null as (() => void) | null, onerror: null };
    setImmediate(() => request.onsuccess?.());
    return request;
  }

  async bulkUpdate(store: string, items: { data: Row; primaryKey: number }[], start: number, count: number): Promise<void> {
    const columns = columnsOf(store);
    const sql = `UPDATE ${store} SET ${columns.map((c) => `${c} = ?`).join(', ')}, json = ? WHERE id = ?`;
    for (const { data, primaryKey } of items.slice(start, start + count)) {
      this.statement(sql).run(...columns.map((c) => columnValue(data[c])), JSON.stringify(data), primaryKey);
    }
  }

  // Translator-facing API

  async getDictionaryInfo(): Promise<Row[]> {
    return this.statement('SELECT json FROM dictionaries ORDER BY id')
      .all()
      .map((r) => JSON.parse(String(r.json)) as Row);
  }

  async findTermsBulk(termList: string[], dictionaries: Map<string, unknown>, matchType: string): Promise<Row[]> {
    if (matchType === 'suffix') throw new Error('suffix match not supported');
    const visited = new Set<number>();
    const results: Row[] = [];
    termList.forEach((item, itemIndex) => {
      for (const column of ['expression', 'reading'] as const) {
        const rows =
          matchType === 'prefix'
            ? this.rows(`SELECT id, json FROM terms WHERE ${column} >= ? AND ${column} < ?`, item, `${item}￿`)
            : this.rows(`SELECT id, json FROM terms WHERE ${column} = ?`, item);
        for (const row of rows) {
          const id = row.id as number;
          if (!dictionaries.has(row.dictionary as string) || visited.has(id)) continue;
          visited.add(id);
          const source = column === 'expression' ? 'term' : 'reading';
          const exact = row[column] === item;
          results.push(createTerm(source, exact ? 'exact' : matchType, row, itemIndex));
        }
      }
    });
    return results;
  }

  async findTermsExactBulk(termList: { term: string; reading: string }[], dictionaries: Map<string, unknown>): Promise<Row[]> {
    const results: Row[] = [];
    termList.forEach((item, itemIndex) => {
      for (const row of this.rows('SELECT id, json FROM terms WHERE expression = ?', item.term)) {
        if (row.reading === item.reading && dictionaries.has(row.dictionary as string)) {
          results.push(createTerm('term', 'exact', row, itemIndex));
        }
      }
    });
    return results;
  }

  async findTermsBySequenceBulk(items: { query: number; dictionary: string }[]): Promise<Row[]> {
    const results: Row[] = [];
    items.forEach((item, itemIndex) => {
      const rows = this.rows('SELECT id, json FROM terms WHERE sequence = ? AND dictionary = ?', item.query, item.dictionary);
      for (const row of rows) results.push(createTerm('sequence', 'exact', row, itemIndex));
    });
    return results;
  }

  async findTermMetaBulk(termList: string[], dictionaries: Map<string, unknown>): Promise<Row[]> {
    const results: Row[] = [];
    termList.forEach((item, index) => {
      for (const row of this.rows('SELECT id, json FROM termMeta WHERE expression = ?', item)) {
        if (!dictionaries.has(row.dictionary as string)) continue;
        results.push({ index, term: row.expression, mode: row.mode, data: row.data, dictionary: row.dictionary });
      }
    });
    return results;
  }

  async findKanjiBulk(kanjiList: string[], dictionaries: Map<string, unknown>): Promise<Row[]> {
    const results: Row[] = [];
    kanjiList.forEach((item, index) => {
      for (const row of this.rows('SELECT id, json FROM kanji WHERE character = ?', item)) {
        if (!dictionaries.has(row.dictionary as string)) continue;
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

  async findKanjiMetaBulk(kanjiList: string[], dictionaries: Map<string, unknown>): Promise<Row[]> {
    const results: Row[] = [];
    kanjiList.forEach((item, index) => {
      for (const row of this.rows('SELECT id, json FROM kanjiMeta WHERE character = ?', item)) {
        if (!dictionaries.has(row.dictionary as string)) continue;
        results.push({ index, character: row.character, mode: row.mode, data: row.data, dictionary: row.dictionary });
      }
    });
    return results;
  }

  async findTagMetaBulk(items: { query: string; dictionary: string }[]): Promise<(Row | undefined)[]> {
    return items.map((item) => {
      const row = this.statement('SELECT json FROM tagMeta WHERE name = ? AND dictionary = ? LIMIT 1').get(item.query, item.dictionary);
      return row ? (JSON.parse(String(row.json)) as Row) : undefined;
    });
  }
}

function createTerm(matchSource: string, matchType: string, row: Row, index: number): Row {
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
