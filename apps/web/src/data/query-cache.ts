import type { BridgeResult } from '@pantheon/protocol';

/** The last accepted answer of one query and the read of it still out, if any. */
export interface CachedQuery {
  data: unknown;
  readAt: number | null;
  inflight?: Promise<BridgeResult<unknown>>;
  /** What the read still out was sent for; undefined when its caller gave none. */
  trigger?: string;
  /** Number of the read whose answer `data` holds. */
  answered?: number;
  /** When the last read sent answered. */
  settledAt?: number;
  /** The one read sent once the read out answers, for every ask made while it was out. */
  queued?: {
    read: () => Promise<BridgeResult<unknown>>;
    trigger?: string;
    answer: Promise<BridgeResult<unknown>>;
    resolve: (result: BridgeResult<unknown>) => void;
  };
}

const LIMIT = 64;
const entries = new Map<string, CachedQuery>();
const id = (method: string, key: string) => `${method}\0${key}`;
// Reads readCached started, numbered in the order they were sent.
const numbers = new WeakMap<Promise<BridgeResult<unknown>>, number>();
let started = 0;
// The number of the last read sent before the cache was last emptied.
let cleared = 0;

// Answers kept across restarts, so a new window shows them while it reads again.
const STORAGE_KEY = 'pantheon.queryCache.v1';
const STORED_METHODS = new Set(['projects.summary', 'session.list']);
const STORAGE_LIMIT = 1024 * 1024;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Stored as [method, key, data, readAt] rows, least recently used first. */
type StoredRow = [string, string, unknown, number];

function restore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    let rows: StoredRow[];
    try {
      rows = JSON.parse(raw);
      const valid = (row: StoredRow) =>
        Array.isArray(row) &&
        STORED_METHODS.has(row[0]) &&
        typeof row[1] === 'string' &&
        typeof row[3] === 'number';
      if (!rows.every(valid)) throw new Error('Unknown rows');
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    for (const [method, key, data, readAt] of rows) entries.set(id(method, key), { data, readAt });
  } catch {
    // Without storage the cache lives in memory only.
  }
}
restore();

function save(): void {
  saveTimer = undefined;
  const rows: string[] = [];
  for (const [name, entry] of entries) {
    const [method, key] = name.split('\0') as [string, string];
    if (STORED_METHODS.has(method) && entry.readAt !== null)
      rows.push(JSON.stringify([method, key, entry.data, entry.readAt] satisfies StoredRow));
  }
  // The brackets and commas join the rows.
  let size = rows.reduce((sum, row) => sum + row.length + 1, 1);
  while (rows.length && size > STORAGE_LIMIT) size -= rows.shift()!.length + 1;
  try {
    localStorage.setItem(STORAGE_KEY, `[${rows.join(',')}]`);
  } catch {
    // A full or missing storage keeps the last stored rows.
  }
}

function scheduleSave(): void {
  saveTimer ??= setTimeout(save, 1000);
}

export const cachedQuery = (method: string, key: string): CachedQuery | undefined =>
  entries.get(id(method, key));

// Map order is insertion order, so the first entry is the least recently used one.
function touch(name: string, entry: CachedQuery): void {
  entries.delete(name);
  entries.set(name, entry);
  if (entries.size > LIMIT) entries.delete(entries.keys().next().value!);
}

/**
 * Starts read(), or with `share` joins the read of the same query still out; given a `trigger`,
 * only a read sent for the same trigger. Any other ask while a read is out waits for the one read
 * sent after it answers.
 */
export function readCached(
  method: string,
  key: string,
  read: () => Promise<BridgeResult<unknown>>,
  share: boolean,
  trigger?: string,
): Promise<BridgeResult<unknown>> {
  return request(id(method, key), read, share, trigger);
}

function request(
  name: string,
  read: () => Promise<BridgeResult<unknown>>,
  share: boolean,
  trigger?: string,
): Promise<BridgeResult<unknown>> {
  const entry = entries.get(name) ?? { data: null, readAt: null };
  if (entry.inflight) {
    if (share && (trigger === undefined || entry.trigger === trigger)) return entry.inflight;
    if (!entry.queued) {
      let resolve!: (result: BridgeResult<unknown>) => void;
      const answer = new Promise<BridgeResult<unknown>>((done) => (resolve = done));
      entry.queued = { read, trigger, answer, resolve };
    } else Object.assign(entry.queued, { read, trigger });
    return entry.queued.answer;
  }
  const inflight = read();
  numbers.set(inflight, ++started);
  entry.inflight = inflight;
  entry.trigger = trigger;
  touch(name, entry);
  void inflight.finally(() => {
    delete entry.inflight;
    delete entry.trigger;
    entry.settledAt = Date.now();
    const queued = entry.queued;
    if (!queued) return;
    delete entry.queued;
    // Sent on the entry the cache holds now, which an emptied cache replaced.
    const next = request(name, queued.read, false, queued.trigger);
    void next.then((result) => {
      numbers.set(queued.answer, numbers.get(next)!);
      queued.resolve(result);
    });
  });
  return inflight;
}

/**
 * Stores `data` as the query's answer; given the read readCached returned for it, not when a newer
 * read's answer is stored already or the cache was emptied since that read was sent.
 */
export function storeQuery(
  method: string,
  key: string,
  data: unknown,
  readAt: number,
  from?: Promise<BridgeResult<unknown>>,
): void {
  const name = id(method, key);
  const entry = entries.get(name) ?? { data: null, readAt: null };
  const read = from && numbers.get(from);
  if (read !== undefined) {
    if (read <= cleared || read < (entry.answered ?? 0)) return;
    entry.answered = read;
  }
  entry.data = data;
  entry.readAt = readAt;
  touch(name, entry);
  if (STORED_METHODS.has(method)) scheduleSave();
}

export function forgetQuery(method: string, key: string): void {
  entries.delete(id(method, key));
  if (STORED_METHODS.has(method)) scheduleSave();
}

let resynced: number | undefined;

/** Empties the cache when the board's resync count moved: events were missed since its reads. */
export function noteResync(resync: number): void {
  if (resynced !== undefined && resynced !== resync) {
    entries.clear();
    cleared = started;
    scheduleSave();
  }
  resynced = resync;
}
