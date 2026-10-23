// Helpers for Yomitan's "Export Dictionary Collection" format: a Dexie export
// whose values are encoded by Typeson. Only the encodings Yomitan produces are
// revived; unknown type markers leave the value untouched.

export type BackupRow = Record<string, unknown>;

export interface TitleFilter {
  /** Import only these dictionary titles, when set. */
  include?: readonly string[];
  /** Always skip these dictionary titles. */
  exclude?: readonly string[];
}

export interface TitleSelection {
  selected: string[];
  excluded: string[];
}

/**
 * Splits dictionary titles into the ones to import and the ones filtered out.
 * Matching is exact after trimming, because the titles come from the
 * dictionaries table itself. Include is a whitelist; exclude wins over it.
 */
export function selectTitles(titles: readonly string[], filter: TitleFilter = {}): TitleSelection {
  const wanted = filter.include === undefined ? null : new Set(filter.include.map(trimmed).filter(nonEmpty));
  const unwanted = new Set((filter.exclude ?? []).map(trimmed).filter(nonEmpty));
  const selected: string[] = [];
  const excluded: string[] = [];
  for (const title of titles) {
    const name = trimmed(title);
    if (wanted !== null && !wanted.has(name)) excluded.push(title);
    else if (unwanted.has(name)) excluded.push(title);
    else selected.push(title);
  }
  return { selected, excluded };
}

/**
 * Revives one exported row. Dexie writes rows with an out-of-line primary key
 * as `{"$":[key, value]}` and Typeson adds `$types` next to the value; both are
 * removed, as is the inline `id`, so SQLite assigns its own.
 */
export function reviveBackupRow(raw: unknown): BackupRow | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as BackupRow;

  let value: unknown = record;
  const unwrapped = Array.isArray(record.$);
  if (unwrapped) {
    value = (record.$ as unknown[])[1];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  }
  if (typeof value !== 'object' || value === null) return null;

  const row = value as BackupRow;
  applyTypes(row, record.$types, unwrapped);
  delete row.$types;
  delete row.id;
  return row;
}

function applyTypes(row: BackupRow, types: unknown, unwrapped: boolean): void {
  if (typeof types !== 'object' || types === null) return;
  for (const [path, marker] of Object.entries(types as Record<string, unknown>)) {
    const type = typeName(marker);
    const parts = pathParts(path, unwrapped);
    if (type === null || parts === null || parts.length === 0) continue;
    reviveAt(row, parts, type);
  }
}

/** `$types` values are a name or, for a wrapped value, `{"": name}`. */
function typeName(marker: unknown): string | null {
  if (typeof marker === 'string') return marker;
  if (typeof marker === 'object' && marker !== null) {
    const inner = (marker as Record<string, unknown>)[''];
    return typeof inner === 'string' ? inner : null;
  }
  return null;
}

/**
 * Paths are dot-separated. Inside an out-of-line row they start at `$`; the
 * `$` itself and the key slot (`1`) are not part of the row, so they are
 * dropped. A path that names only the wrapper has no row target.
 */
function pathParts(path: string, unwrapped: boolean): string[] | null {
  const parts = path.split('.');
  if (parts[0] !== '$') return parts;
  if (!unwrapped) return null;
  const rest = parts.slice(1);
  if (rest[0] !== '1') return null;
  rest.shift();
  return rest;
}

function reviveAt(row: BackupRow, parts: readonly string[], type: string): void {
  let parent: unknown = row;
  for (const part of parts.slice(0, -1)) {
    if (typeof parent !== 'object' || parent === null) return;
    parent = (parent as Record<string, unknown>)[part];
  }
  if (typeof parent !== 'object' || parent === null) return;
  const holder = parent as Record<string, unknown>;
  const key = parts[parts.length - 1] as string;
  if (!(key in holder)) return;
  holder[key] = reviveValue(holder[key], type);
}

function reviveValue(value: unknown, type: string): unknown {
  switch (type) {
    case 'arrayNonindexKeys':
      return asArray(value);
    case 'arraybuffer':
      return typeof value === 'string' ? base64Bytes(value) : value;
    case 'date':
      return typeof value === 'number' || typeof value === 'string' ? new Date(value) : value;
    case 'undefined':
      return undefined;
    case 'NaN':
      return Number.NaN;
    case 'Infinity':
      return Number.POSITIVE_INFINITY;
    case '-Infinity':
      return Number.NEGATIVE_INFINITY;
    default:
      return value;
  }
}

/** Sparse arrays are encoded as objects keyed by index when JSON cannot hold them. */
function asArray(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [];
  if (!entries.every(([key]) => /^(0|[1-9]\d*)$/.test(key))) return value;
  const length = Math.max(...entries.map(([key]) => Number(key))) + 1;
  const array: unknown[] = new Array(length);
  for (const [key, item] of entries) array[Number(key)] = item;
  return array;
}

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function trimmed(value: string): string {
  return value.trim();
}

function nonEmpty(value: string): boolean {
  return value !== '';
}
