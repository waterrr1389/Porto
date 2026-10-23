// Streaming import of a Yomitan "Export Dictionary Collection" file. The
// export is a single multi-gigabyte JSON line, so it is read as a character
// stream: the outer structure is parsed by hand and one row is parsed and
// inserted at a time, keeping memory proportional to a batch of rows.
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { reviveBackupRow, selectTitles, type BackupRow, type TitleFilter } from '../../../core/dictionary-backup.ts';
import { SqliteDictionaryDatabase } from './database.ts';

export interface BackupProgress {
  table: string;
  /** Rows processed in this table so far, including skipped ones. */
  rows: number;
}

export interface YomitanBackupOptions {
  /** Import only these dictionary titles. */
  include?: string[];
  /** Skip these dictionary titles. */
  exclude?: string[];
  /** Called every 100k processed rows of a table. */
  onProgress?: (progress: BackupProgress) => void;
  /** Bytes per read; small values are useful for exercising chunk boundaries. */
  chunkSize?: number;
}

export interface BackupDictionaryResult {
  title: string;
  outcome: 'imported' | 'skipped';
  /** Why a dictionary was skipped, when it was. */
  reason?: 'existing' | 'filtered';
  /** Rows inserted for this dictionary across all stores. */
  rows: number;
}

export interface BackupImportResult {
  dictionaries: BackupDictionaryResult[];
  seconds: number;
}

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const BATCH_ROWS = 1000;
const PROGRESS_ROWS = 100_000;

/** Stops parsing early; carrying it out through the parser keeps the visitor simple. */
class StopBackup extends Error {}

interface BackupVisitor {
  /** Called before a table's rows; throwing StopBackup ends the parse. */
  onTable?(name: string): void;
  onRow(table: string, rawRow: string): Promise<void> | void;
  onTableEnd?(name: string): void;
}

/**
 * Imports the dictionaries of a Yomitan export into `databasePath`, skipping
 * titles already present and rows of dictionaries outside the filter.
 */
export async function importYomitanBackup(
  databasePath: string,
  backupPath: string,
  options: YomitanBackupOptions = {},
): Promise<BackupImportResult> {
  const started = performance.now();
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_BYTES;
  const titles = await readBackupTitles(backupPath, chunkSize);

  const db = new SqliteDictionaryDatabase(databasePath);
  try {
    const existing = new Set((await db.getDictionaryInfo()).map((info) => String(info.title)));
    const selection = selectTitles(titles, { include: options.include, exclude: options.exclude } satisfies TitleFilter);
    const selected = new Set(selection.selected);
    // Rows of titles already in the database must not be inserted again.
    const insertable = new Set(selection.selected.filter((title) => !existing.has(title)));

    const results = new Map<string, BackupDictionaryResult>();
    for (const title of titles) {
      if (existing.has(title)) results.set(title, { title, outcome: 'skipped', reason: 'existing', rows: 0 });
      else if (!selected.has(title)) results.set(title, { title, outcome: 'skipped', reason: 'filtered', rows: 0 });
      else results.set(title, { title, outcome: 'imported', rows: 0 });
    }

    let batch: BackupRow[] = [];
    let batchTable = '';
    let tableRows = 0;

    async function flush(): Promise<void> {
      if (batch.length === 0) return;
      await db.bulkAdd(batchTable, batch, 0, batch.length);
      batch = [];
    }

    async function onRow(table: string, raw: string): Promise<void> {
      tableRows += 1;
      if (options.onProgress !== undefined && tableRows % PROGRESS_ROWS === 0) {
        options.onProgress({ table, rows: tableRows });
      }

      const row = reviveBackupRow(JSON.parse(raw));
      if (row === null) return;

      let dictionary: string | null;
      if (table === 'dictionaries') {
        dictionary = typeof row.title === 'string' ? row.title : null;
      } else {
        dictionary = typeof row.dictionary === 'string' ? row.dictionary : null;
      }
      if (dictionary === null || !insertable.has(dictionary)) return;
      if (table === 'dictionaries' && existing.has(dictionary)) return;

      if (batchTable !== table) {
        await flush();
        batchTable = table;
      }
      batch.push(row);
      const result = results.get(dictionary);
      if (result !== undefined) result.rows += 1;
      if (batch.length >= BATCH_ROWS) await flush();
    }

    await readBackup(
      backupPath,
      {
        onTable(name) {
          tableRows = 0;
        },
        onRow,
        onTableEnd() {},
      },
      chunkSize,
    );
    await flush();

    return {
      dictionaries: [...results.values()],
      seconds: (performance.now() - started) / 1000,
    };
  } finally {
    db.close();
  }
}

/** Titles of the dictionaries table, which the exporter writes first. */
async function readBackupTitles(backupPath: string, chunkSize: number): Promise<string[]> {
  const titles: string[] = [];
  let seenDictionaries = false;
  await readBackup(
    backupPath,
    {
      onTable(name) {
        if (name === 'dictionaries') {
          seenDictionaries = true;
          return;
        }
        if (!seenDictionaries) throw new Error('backup does not start with the dictionaries table');
        throw new StopBackup();
      },
      onRow(table, raw) {
        if (table !== 'dictionaries') return;
        const row = reviveBackupRow(JSON.parse(raw));
        if (row !== null && typeof row.title === 'string') titles.push(row.title);
      },
    },
    chunkSize,
  );
  return titles;
}

async function readBackup(backupPath: string, visitor: BackupVisitor, chunkSize: number): Promise<void> {
  const reader = new JsonReader(createReadStream(backupPath, { highWaterMark: chunkSize }));
  try {
    await parseRoot(reader, visitor);
  } catch (error) {
    if (!(error instanceof StopBackup)) throw error;
  }
}

async function parseRoot(reader: JsonReader, visitor: BackupVisitor): Promise<void> {
  await parseObject(reader, async (key) => {
    if (key === 'data') await parseData(reader, visitor);
    else await reader.skipValue();
  });
}

async function parseData(reader: JsonReader, visitor: BackupVisitor): Promise<void> {
  await parseObject(reader, async (key) => {
    if (key === 'data') await parseTableList(reader, visitor);
    else await reader.skipValue();
  });
}

async function parseTableList(reader: JsonReader, visitor: BackupVisitor): Promise<void> {
  await reader.expect('[');
  while (true) {
    const char = await reader.peek();
    if (char === ']') {
      reader.consume();
      return;
    }
    if (char === ',') {
      reader.consume();
      continue;
    }
    await parseTable(reader, visitor);
  }
}

async function parseTable(reader: JsonReader, visitor: BackupVisitor): Promise<void> {
  await reader.expect('{');
  let name = '';
  let sawRows = false;
  while (true) {
    const char = await reader.peek();
    if (char === '}') {
      reader.consume();
      break;
    }
    if (char === ',') {
      reader.consume();
      continue;
    }
    const key = await reader.readString();
    await reader.expect(':');
    if (key === 'tableName') {
      name = await reader.readString();
      visitor.onTable?.(name);
    } else if (key === 'rows') {
      if (name === '') throw new Error('backup table rows appear before the table name');
      sawRows = true;
      await parseRows(reader, name, visitor);
    } else {
      await reader.skipValue();
    }
  }
  if (sawRows) visitor.onTableEnd?.(name);
}

async function parseRows(reader: JsonReader, table: string, visitor: BackupVisitor): Promise<void> {
  await reader.expect('[');
  while (true) {
    const char = await reader.peek();
    if (char === ']') {
      reader.consume();
      return;
    }
    if (char === ',') {
      reader.consume();
      continue;
    }
    if (char !== '{' && char !== '[') throw new Error(`unexpected row in ${table}`);
    const raw = await reader.readBalancedText();
    await visitor.onRow(table, raw);
  }
}

async function parseObject(reader: JsonReader, handle: (key: string) => Promise<void>): Promise<void> {
  await reader.expect('{');
  while (true) {
    const char = await reader.peek();
    if (char === '}') {
      reader.consume();
      return;
    }
    if (char === ',') {
      reader.consume();
      continue;
    }
    const key = await reader.readString();
    await reader.expect(':');
    await handle(key);
  }
}

/**
 * UTF-8 character stream over the backup. Buffers one read at a time; the
 * decoder keeps partial multi-byte characters between reads, so rows can be
 * split at any byte boundary.
 */
class JsonReader {
  private readonly decoder = new StringDecoder('utf8');
  private readonly iterator: AsyncIterator<Buffer>;
  private text = '';
  private pos = 0;
  private ended = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    while (true) {
      const { value, done } = await this.iterator.next();
      if (done) {
        if (this.ended) return false;
        this.ended = true;
        const rest = this.decoder.end();
        if (rest === '') return false;
        this.text = rest;
        this.pos = 0;
        return true;
      }
      const decoded = this.decoder.write(value);
      if (decoded === '') continue;
      this.text = decoded;
      this.pos = 0;
      return true;
    }
  }

  private async ensure(): Promise<void> {
    if (this.pos < this.text.length) return;
    if (!(await this.fill())) throw new Error('unexpected end of backup');
  }

  /** Next non-whitespace character, consuming the whitespace before it. */
  async peek(): Promise<string> {
    while (true) {
      await this.ensure();
      const char = this.text[this.pos] as string;
      if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
        this.pos += 1;
        continue;
      }
      return char;
    }
  }

  consume(): void {
    this.pos += 1;
  }

  async expect(char: string): Promise<void> {
    const actual = await this.peek();
    if (actual !== char) throw new Error(`expected '${char}' but found '${actual}'`);
    this.pos += 1;
  }

  /** Reads a JSON string, including escapes, and decodes it. */
  async readString(): Promise<string> {
    await this.expect('"');
    let raw = '';
    let escaped = false;
    while (true) {
      await this.ensure();
      const chunk = this.text;
      let index = this.pos;
      const start = index;
      for (; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index);
        if (escaped) {
          escaped = false;
          continue;
        }
        if (code === 0x5c) {
          escaped = true;
          continue;
        }
        if (code === 0x22) {
          raw += chunk.slice(start, index);
          this.pos = index + 1;
          return JSON.parse(`"${raw}"`) as string;
        }
      }
      raw += chunk.slice(start, index);
      this.pos = index;
    }
  }

  /** Next character without skipping whitespace. */
  private async peekRaw(): Promise<string> {
    await this.ensure();
    return this.text[this.pos] as string;
  }

  /** Skips one complete JSON value. */
  async skipValue(): Promise<void> {
    const char = await this.peek();
    if (char === '{' || char === '[') {
      await this.readBalancedText();
      return;
    }
    if (char === '"') {
      await this.readString();
      return;
    }
    while (true) {
      const current = await this.peekRaw();
      if (current === ',' || current === '}' || current === ']' || /\s/.test(current)) return;
      this.pos += 1;
    }
  }

  /** Consumes one object or array and returns its raw JSON text. */
  async readBalancedText(): Promise<string> {
    const parts: string[] = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    while (true) {
      await this.ensure();
      const chunk = this.text;
      const start = this.pos;
      let index = start;
      for (; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index);
        if (inString) {
          if (escaped) escaped = false;
          else if (code === 0x5c) escaped = true;
          else if (code === 0x22) inString = false;
          continue;
        }
        if (code === 0x22) {
          inString = true;
          continue;
        }
        if (code === 0x7b || code === 0x5b) {
          depth += 1;
          started = true;
          continue;
        }
        if (code === 0x7d || code === 0x5d) {
          depth -= 1;
          if (started && depth === 0) {
            parts.push(chunk.slice(start, index + 1));
            this.pos = index + 1;
            return parts.length === 1 ? (parts[0] as string) : parts.join('');
          }
        }
      }
      parts.push(chunk.slice(start, index));
      this.pos = index;
      if (!(await this.fill())) throw new Error('unexpected end of backup inside a row');
    }
  }
}
