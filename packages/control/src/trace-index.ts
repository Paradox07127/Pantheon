import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  createClaudeReducer,
  createCodexReducer,
  probeMeta,
  toolCommand,
  type TraceReducer,
} from '@pantheon/adapters';
import type { TraceLane, TraceMeta, TraceSpan } from '@pantheon/domain';
import { inside, resolvedPath } from './context.js';
import { runGit } from './git.js';

const PARSER_VERSION = 7;
const HEAD_BYTES = 4096;
const CHUNK_BYTES = 4 * 1024 * 1024;
const UNASSIGNED = 'unassigned';
// Files handled between yields to the event loop.
const YIELD_FILES = 200;

export interface TraceIndexOptions {
  /** Cache file, for example <data directory>/trace-cache.sqlite. */
  file: string;
  /** Claude configuration directories, each holding projects/. */
  claudeHomes: string[];
  /** Codex homes, each holding sessions/. */
  codexHomes: string[];
  /** Managed native history: <dir>/<project>/claude is a Claude home, <dir>/<project>/codex a Codex home. */
  nativeSessionsDir?: string;
}
export interface TraceProject {
  id: string;
  roots: string[];
  /** Paths of registered workspaces. */
  workspaces: string[];
  /** Pantheon sessions. */
  sessions: { session_id: string; runtime: string; native_id: string }[];
}

interface FileRow {
  path: string;
  dev: string | null;
  ino: string | null;
  size: number | null;
  mtime: number | null;
  head_hash: string | null;
  offset: number;
  runtime: string | null;
  native_id: string | null;
  meta: string | null;
  lane_key: string | null;
  project_id: string | null;
  state: string | null;
  title: string | null;
}
/** The columns a scan reads for every file; the reducer state is read only for a file that changed. */
type KnownRow = Pick<
  FileRow,
  'path' | 'dev' | 'ino' | 'size' | 'mtime' | 'offset' | 'meta' | 'lane_key'
>;
interface Lane {
  lane_key: string;
  project_id: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, dev TEXT, ino TEXT, size INTEGER, mtime REAL, head_hash TEXT, offset INTEGER NOT NULL DEFAULT 0, runtime TEXT, native_id TEXT, meta TEXT, lane_key TEXT, project_id TEXT, state TEXT, title TEXT) STRICT;
  CREATE TABLE IF NOT EXISTS spans (file TEXT NOT NULL, id TEXT NOT NULL, lane_key TEXT NOT NULL, start INTEGER, json TEXT NOT NULL, PRIMARY KEY (file, id)) STRICT;
  CREATE INDEX IF NOT EXISTS files_project_trace ON files(project_id);
  CREATE INDEX IF NOT EXISTS files_native ON files(runtime, native_id);
  CREATE INDEX IF NOT EXISTS spans_runtime_tools ON spans(file, start)
    WHERE json ->> '$.kind' IN ('tool', 'subagent');
  CREATE INDEX IF NOT EXISTS spans_runtime_compaction ON spans(file, start)
    WHERE json ->> '$.kind' = 'compact';
  CREATE INDEX IF NOT EXISTS spans_subagents ON spans(file)
    WHERE json ->> '$.kind' = 'subagent';
  CREATE INDEX IF NOT EXISTS spans_lane ON spans(lane_key, start);
`;

function openCache(file: string): { db: DatabaseSync; epoch: string } {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(SCHEMA);
      const read = (key: string) =>
        (
          db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
            { value: string } | undefined
        )?.value;
      const version = read('parser_version');
      let epoch = read('epoch');
      if (version === undefined) {
        epoch = randomUUID();
        const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
        insert.run('parser_version', String(PARSER_VERSION));
        insert.run('epoch', epoch);
      } else if (version !== String(PARSER_VERSION) || epoch === undefined)
        throw new Error('Trace cache was written by another parser version');
      db.exec('COMMIT');
      return { db, epoch };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
  }
}

const sha1 = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

// The runtimes whose native transcripts are read; a lane of any other runtime has no native spans.
const REDUCERS = new Map<string, (meta: TraceMeta) => TraceReducer>([
  [
    'claude',
    (meta) =>
      createClaudeReducer({
        native_id: meta.native_id,
        ...(meta.parent_tool_use_id === undefined
          ? {}
          : { parent_tool_use_id: meta.parent_tool_use_id }),
      }),
  ],
  ['codex', (meta) => createCodexReducer({ native_id: meta.native_id })],
]);

function reducerOf(meta: TraceMeta): TraceReducer | undefined {
  return REDUCERS.get(meta.runtime)?.(meta);
}

/** A disposable cache of spans read from native Claude and Codex transcripts. */
export class TraceIndex {
  readonly epoch: string;
  private readonly db: DatabaseSync;
  private readonly commonDirs = new Map<string, Promise<string | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  private changes = 0;
  private finished:
    { at: number; progress: { done_files: number; total_files: number } } | undefined;
  /** The projects the unassigned files were last placed against. */
  private placedFor: string | undefined;
  /** Size and mtime of each file whose last probe found no metadata row. */
  private readonly pendingProbes = new Map<string, string>();

  constructor(private readonly options: TraceIndexOptions) {
    let opened: { db: DatabaseSync; epoch: string };
    try {
      opened = openCache(options.file);
    } catch {
      for (const suffix of ['', '-wal', '-shm']) rmSync(options.file + suffix, { force: true });
      opened = openCache(options.file);
    }
    this.db = opened.db;
    this.epoch = opened.epoch;
  }

  /** Counts the changes indexed since this index was opened. */
  get revision(): number {
    return this.changes;
  }

  /** When the last scan finished, and its progress. */
  get lastScan():
    { at: number; progress: { done_files: number; total_files: number } } | undefined {
    return this.finished;
  }

  /** Discovers files and ingests them for at most budgetMs, stopping before the next chunk. */
  scan(
    projects: TraceProject[],
    budgetMs: number,
  ): Promise<{ done_files: number; total_files: number }> {
    const run = this.queue.then(() => this.run(projects, budgetMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The lanes of a project with their spans, ordered by the earliest span start; from and to keep the spans starting between them, laneKey keeps that lane. */
  lanes(
    projectId: string,
    from?: number,
    to?: number,
    laneKey?: string,
  ): { lane: TraceLane; spans: TraceSpan[] }[] {
    return this.readLanes(projectId, from, to, { laneKey }).lanes;
  }

  timeLanes(projectId: string, from: number, to: number, limit: number, laneKey?: string) {
    return this.readLanes(projectId, from, to, { limit, laneKey });
  }

  /** Subagent calls per indexed lane, including zero for a transcript with no calls. */
  subagentCounts(projectId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT f.lane_key, COUNT(s.id) AS count FROM files f LEFT JOIN spans s
        ON s.file=f.path AND s.json ->> '$.kind' = 'subagent'
        WHERE f.project_id=? GROUP BY f.lane_key`,
      )
      .all(projectId) as { lane_key: string; count: number }[];
    return new Map(rows.map((row) => [row.lane_key, row.count]));
  }

  /** Matches complete command lines from the cached reducer inputs, before their summaries were cut. */
  matchingCommands(projectId: string, command: string): Map<string, Set<string>> {
    const rows = this.db
      .prepare('SELECT lane_key, state FROM files WHERE project_id = ? AND state IS NOT NULL')
      .all(projectId) as { lane_key: string; state: string }[];
    const matches = new Map<string, Set<string>>();
    for (const row of rows) {
      const state = JSON.parse(row.state) as { tool_inputs: Record<string, string> };
      const ids = matches.get(row.lane_key) ?? new Set<string>();
      for (const [id, signature] of Object.entries(state.tool_inputs)) {
        const [, , input] = JSON.parse(signature) as [string, string, unknown];
        if (toolCommand(input)?.includes(command)) ids.add(id);
      }
      matches.set(row.lane_key, ids);
    }
    return matches;
  }

  private readLanes(
    projectId: string,
    from?: number,
    to?: number,
    { limit, laneKey }: { limit?: number; laneKey?: string } = {},
  ) {
    const bounded = limit === undefined ? undefined : { limit };
    const files = this.db
      .prepare(
        `SELECT lane_key, meta, title FROM files WHERE project_id = ?
        ${laneKey === undefined ? '' : 'AND lane_key = ?'} ORDER BY path`,
      )
      .all(projectId, ...(laneKey === undefined ? [] : [laneKey])) as {
      lane_key: string;
      meta: string;
      title: string | null;
    }[];
    const byLane = new Map<string, { meta: TraceMeta; title: string | null }[]>();
    for (const file of files)
      byLane.set(file.lane_key, [
        ...(byLane.get(file.lane_key) ?? []),
        { meta: JSON.parse(file.meta), title: file.title },
      ]);
    const windowed = from !== undefined || to !== undefined;
    const spansOf = this.db.prepare(
      bounded
        ? `SELECT json FROM spans WHERE lane_key=? AND (start IS NULL OR start BETWEEN ? AND ?)
          ORDER BY start DESC, id LIMIT ?`
        : windowed
          ? 'SELECT json FROM spans WHERE lane_key = ? AND (start IS NULL OR start BETWEEN ? AND ?) ORDER BY start, id'
          : 'SELECT json FROM spans WHERE lane_key = ? ORDER BY start, id',
    );
    let remaining = bounded?.limit ?? 0;
    let partial = false;
    const lanes = [...byLane].map(([key, metas]) => {
      const mainFile = metas.find(({ meta }) => meta.parent_native_id === undefined) ?? metas[0]!;
      const main = mainFile.meta;
      const pantheon = !key.startsWith('native:');
      const lane: TraceLane = {
        key,
        source: pantheon ? 'pantheon' : 'external',
        runtime: main.runtime,
        ...(pantheon ? { session_id: key } : {}),
        native_id: main.native_id,
        title: mainFile.title ?? main.native_id.slice(0, 8),
        cwd: main.cwd,
      };
      let rows = bounded
        ? spansOf.all(key, from!, to!, remaining + 1)
        : windowed
          ? spansOf.all(key, from ?? Number.MIN_SAFE_INTEGER, to ?? Number.MAX_SAFE_INTEGER)
          : spansOf.all(key);
      if (bounded) {
        partial ||= rows.length > remaining;
        rows = rows.slice(0, remaining);
        remaining -= rows.length;
      }
      const spans = (rows as { json: string }[]).map((row) => JSON.parse(row.json) as TraceSpan);
      const starts = spans.flatMap((span) => (span.start === null ? [] : [span.start]));
      return {
        lane,
        spans,
        first: starts.reduce((first, start) => Math.min(first, start), Infinity),
      };
    });
    return {
      partial,
      lanes: lanes.sort((a, b) => a.first - b.first).map(({ lane, spans }) => ({ lane, spans })),
    };
  }

  /** Full tool input retained by the native reducer, scoped to its project and lane. */
  toolInput(projectId: string, laneKey: string, spanId: string): unknown {
    const rows = this.db
      .prepare(
        'SELECT state FROM files WHERE project_id=? AND lane_key=? AND state IS NOT NULL ORDER BY path',
      )
      .all(projectId, laneKey) as { state: string }[];
    for (const row of rows) {
      const state = JSON.parse(row.state) as { tool_inputs: Record<string, string> };
      const signature = state.tool_inputs[spanId];
      if (signature !== undefined) return (JSON.parse(signature) as [string, string, unknown])[2];
    }
  }

  /** Reads only cached tool spans. No discovery, parser work or raw transcript reads. */
  runtimeTools(projectId: string, from: number, to: number, limit = 1024) {
    type Row = { lane_key: string; json: string; start: number };
    const read = (kindFilter: string, at = 's.start') =>
      this.db
        .prepare(
          `SELECT s.lane_key, s.json, ${at} AS start FROM files f JOIN spans s ON s.file=f.path
        WHERE f.project_id=? AND ${at} BETWEEN ? AND ? AND ${kindFilter}
        ORDER BY ${at} DESC LIMIT ?`,
        )
        .all(projectId, from - 24 * 60 * 60 * 1000, to, limit + 1) as Row[];
    // Separate queries retain the partial indexes for tools and compactions on historical caches.
    const rows = [
      ...read("s.json ->> '$.kind' IN ('tool', 'subagent')"),
      ...read("s.json ->> '$.kind' = 'compact'"),
      // Spans the reducer could only time by their end.
      ...read(
        "s.start IS NULL AND s.json ->> '$.kind' IN ('tool', 'subagent', 'compact')",
        "s.json ->> '$.end'",
      ),
    ].sort((a, b) => b.start - a.start);
    const byLane = new Map<string, TraceSpan[]>();
    for (const row of rows.slice(0, limit)) {
      const spans = byLane.get(row.lane_key) ?? [];
      spans.push(JSON.parse(row.json) as TraceSpan);
      byLane.set(row.lane_key, spans);
    }
    return {
      partial: rows.length > limit,
      lanes: [...byLane].map(([key, spans]) => ({ lane: { key }, spans })),
    };
  }

  /** Discovered files outside every project, and line types the reducers skipped. */
  stats(): { unassigned: number; unknown: Record<string, number> } {
    const { count } = this.db
      .prepare('SELECT COUNT(*) AS count FROM files WHERE lane_key = ?')
      .get(UNASSIGNED) as { count: number };
    const unknown: Record<string, number> = {};
    const rows = this.db.prepare('SELECT meta, state FROM files WHERE state IS NOT NULL').all() as {
      meta: string;
      state: string;
    }[];
    for (const row of rows) {
      const reducer = reducerOf(JSON.parse(row.meta));
      if (!reducer) continue;
      reducer.restore(JSON.parse(row.state));
      for (const [type, n] of Object.entries(reducer.unknown()))
        unknown[type] = (unknown[type] ?? 0) + n;
    }
    return { unassigned: count, unknown };
  }

  /** Main transcripts outside every project, with the folder each was recorded in. */
  unassignedRecords(): { runtime: string; native_id: string; path: string; cwd: string }[] {
    return this.db
      .prepare(
        "SELECT runtime, native_id, path, json_extract(meta, '$.cwd') AS cwd FROM files WHERE lane_key = ? AND json_extract(meta, '$.parent_native_id') IS NULL ORDER BY path",
      )
      .all(UNASSIGNED) as { runtime: string; native_id: string; path: string; cwd: string }[];
  }

  /** Main transcripts of a project's external lanes, newest first. */
  importable(projectId: string): {
    native_session_id: string;
    runtime: TraceMeta['runtime'];
    title: string;
    cwd: string;
    updated_at: string | null;
  }[] {
    const rows = this.db
      .prepare(
        "SELECT path, native_id, runtime, title, mtime, json_extract(meta, '$.cwd') AS cwd FROM files WHERE project_id = ? AND lane_key LIKE 'native:%' AND json_extract(meta, '$.parent_native_id') IS NULL ORDER BY path",
      )
      .all(projectId) as {
      path: string;
      native_id: string;
      runtime: TraceMeta['runtime'];
      title: string | null;
      mtime: number | null;
      cwd: string;
    }[];
    const sessions = rows.map((row) => {
      let mtime = row.mtime;
      if (mtime === null)
        try {
          mtime = statSync(row.path).mtimeMs;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      return {
        native_session_id: row.native_id,
        runtime: row.runtime,
        title: row.title ?? row.native_id.slice(0, 8),
        cwd: row.cwd,
        updated_at: mtime === null ? null : new Date(mtime).toISOString(),
      };
    });
    return sessions.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  }

  /** Returns the transcripts of a deleted session to the external lanes they came from. */
  release(sessionId: string): void {
    this.transaction(() => {
      const { changes } = this.db
        .prepare(
          "UPDATE files SET lane_key = 'native:' || runtime || ':' || COALESCE(json_extract(meta, '$.parent_native_id'), native_id) WHERE lane_key = ?",
        )
        .run(sessionId);
      if (changes === 0) return;
      this.db
        .prepare(
          'UPDATE spans SET lane_key = (SELECT lane_key FROM files WHERE files.path = spans.file) WHERE lane_key = ?',
        )
        .run(sessionId);
      this.changes += 1;
    });
  }

  close(): void {
    this.db.close();
  }

  private async run(projects: TraceProject[], budgetMs: number) {
    const started = Date.now();
    const over = () => Date.now() - started >= budgetMs;
    const listed = await this.discover();
    // A session may record its native id after its transcript was placed in an external lane.
    const external = this.db.prepare(
      "SELECT lane_key FROM files WHERE runtime = ? AND native_id = ? AND lane_key LIKE 'native:%'",
    );
    for (const project of projects)
      for (const session of project.sessions) {
        const placed = external.get(session.runtime, session.native_id) as
          { lane_key: string } | undefined;
        if (placed) {
          this.transaction(() => {
            this.db
              .prepare('UPDATE files SET lane_key = ?, project_id = ? WHERE lane_key = ?')
              .run(session.session_id, project.id, placed.lane_key);
            this.db
              .prepare('UPDATE spans SET lane_key = ? WHERE lane_key = ?')
              .run(session.session_id, placed.lane_key);
          });
          this.changes += 1;
        }
      }
    const known = new Map(
      (
        this.db
          .prepare('SELECT path, dev, ino, size, mtime, offset, meta, lane_key FROM files')
          .all() as unknown as KnownRow[]
      ).map((row) => [row.path, row]),
    );
    // An unassigned file is placed again only against changed projects or sessions.
    const fingerprint = JSON.stringify(projects),
      reassign = fingerprint !== this.placedFor;
    const metas: [string, TraceMeta][] = [];
    // Files left unprobed once the budget is spent; they are not done.
    const deferred = new Set<string>();
    let probed = 0;
    // A subagent file waits on its parent's lane, so parents are probed first.
    const sub = (file: string) => Number(path.basename(path.dirname(file)) === 'subagents');
    for (const [index, file] of [...listed].sort((a, b) => sub(a) - sub(b)).entries()) {
      if (index > 0 && index % YIELD_FILES === 0)
        await new Promise((resolve) => setImmediate(resolve));
      const row = known.get(file);
      if (row?.lane_key === UNASSIGNED) {
        if (reassign) metas.push([file, JSON.parse(row.meta!)]);
      } else if (!row?.lane_key) {
        let meta: TraceMeta | 'pending', stamp: string;
        try {
          const seen = await stat(file);
          stamp = `${seen.size}:${seen.mtimeMs}`;
          if (this.pendingProbes.get(file) === stamp) continue;
          if (probed > 0 && over()) {
            deferred.add(file);
            continue;
          }
          probed += 1;
          meta = await probeMeta(file);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        if (meta !== 'pending') {
          this.pendingProbes.delete(file);
          metas.push([file, meta]);
        }
        // A subagent also waits on its .meta.json, which changes neither size nor mtime.
        else if (!sub(file)) this.pendingProbes.set(file, stamp);
      }
    }
    // A subagent file follows its parent, so parents are placed first.
    metas.sort(([, a], [, b]) => Number(!!a.parent_native_id) - Number(!!b.parent_native_id));
    const upsert = this.db.prepare(
      `INSERT INTO files (path, runtime, native_id, meta, lane_key, project_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET runtime = excluded.runtime, native_id = excluded.native_id, meta = excluded.meta, lane_key = excluded.lane_key, project_id = excluded.project_id`,
    );
    const lanes: (Lane | null)[] = [];
    // Lanes placed by this scan, by runtime and native id, for subagents placed after their parents.
    const placed = new Map<string, Lane>();
    for (const [, meta] of metas) {
      const lane = await this.assign(meta, projects, placed);
      if (lane) placed.set(`${meta.runtime}\0${meta.native_id}`, lane);
      lanes.push(lane);
    }
    if (metas.length > 0)
      this.transaction(() => {
        for (const [index, [file, meta]] of metas.entries()) {
          const lane = lanes[index]!;
          upsert.run(
            file,
            meta.runtime,
            meta.native_id,
            JSON.stringify(meta),
            lane?.lane_key ?? null,
            lane?.project_id ?? null,
          );
          known.set(file, {
            ...(known.get(file) ?? {
              path: file,
              dev: null,
              ino: null,
              size: null,
              mtime: null,
              offset: 0,
            }),
            meta: JSON.stringify(meta),
            lane_key: lane?.lane_key ?? null,
          });
        }
      });
    this.placedFor = fingerprint;
    let done = 0;
    for (const [index, file] of listed.entries()) {
      if (index > 0 && index % YIELD_FILES === 0)
        await new Promise((resolve) => setImmediate(resolve));
      const row = known.get(file);
      if (deferred.has(file)) continue;
      if (!row?.lane_key || row.lane_key === UNASSIGNED) {
        done += 1;
        continue;
      }
      let result: { finished: boolean; stopped: boolean };
      try {
        result = await this.ingest(row, over);
      } catch (error) {
        if (!missing(error)) throw error;
        result = { finished: true, stopped: false };
      }
      if (result.finished) done += 1;
      if (result.stopped) break;
    }
    const progress = { done_files: done, total_files: listed.length };
    this.finished = { at: Date.now(), progress };
    return progress;
  }

  private async discover(): Promise<string[]> {
    const files: string[] = [];
    const managed =
      this.options.nativeSessionsDir === undefined
        ? []
        : (await entries(this.options.nativeSessionsDir))
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(this.options.nativeSessionsDir!, entry.name));
    for (const home of [
      ...this.options.claudeHomes,
      ...managed.map((dir) => path.join(dir, 'claude')),
    ]) {
      const projects = path.join(home, 'projects');
      for (const project of await entries(projects)) {
        if (!project.isDirectory()) continue;
        const dir = path.join(projects, project.name);
        for (const entry of await entries(dir)) {
          if (entry.isFile() && entry.name.endsWith('.jsonl'))
            files.push(path.join(dir, entry.name));
          else if (entry.isDirectory()) {
            const subagents = path.join(dir, entry.name, 'subagents');
            for (const agent of await entries(subagents))
              if (agent.isFile() && /^agent-.*\.jsonl$/.test(agent.name))
                files.push(path.join(subagents, agent.name));
          }
        }
      }
    }
    for (const home of [
      ...this.options.codexHomes,
      ...managed.map((dir) => path.join(dir, 'codex')),
    ]) {
      const sessions = path.join(home, 'sessions');
      let names: string[];
      try {
        names = await readdir(sessions, { recursive: true });
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      for (const name of names.sort())
        if (/^rollout-.*\.jsonl$/.test(path.basename(name))) files.push(path.join(sessions, name));
    }
    return files;
  }

  private row(file: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(file) as FileRow | undefined;
  }

  private async assign(
    meta: TraceMeta,
    projects: TraceProject[],
    placed: Map<string, Lane>,
  ): Promise<Lane | null> {
    for (const project of projects) {
      const session = project.sessions.find(
        (session) => session.runtime === meta.runtime && session.native_id === meta.native_id,
      );
      if (session) return { lane_key: session.session_id, project_id: project.id };
    }
    if (meta.parent_native_id !== undefined) {
      const parent =
        placed.get(`${meta.runtime}\0${meta.parent_native_id}`) ??
        (this.db
          .prepare(
            'SELECT lane_key, project_id FROM files WHERE runtime = ? AND native_id = ? AND lane_key IS NOT NULL',
          )
          .get(meta.runtime, meta.parent_native_id) as Lane | undefined);
      return parent ? { lane_key: parent.lane_key, project_id: parent.project_id } : null;
    }
    const cwd = resolvedPath(meta.cwd);
    const external = (project: TraceProject): Lane => ({
      lane_key: `native:${meta.runtime}:${meta.native_id}`,
      project_id: project.id,
    });
    const containing = projects.find((project) =>
      [...project.roots, ...project.workspaces].some((root) => inside(resolvedPath(root), cwd)),
    );
    if (containing) return external(containing);
    if (existsSync(cwd)) {
      const common = await this.commonDir(cwd);
      if (common !== null)
        for (const project of projects)
          for (const root of project.roots)
            if ((await this.commonDir(resolvedPath(root))) === common) return external(project);
    }
    return { lane_key: UNASSIGNED, project_id: UNASSIGNED };
  }

  private commonDir(dir: string): Promise<string | null> {
    let common = this.commonDirs.get(dir);
    if (!common) {
      common = runGit(
        dir,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        undefined,
        true,
      ).then((result) => (result.exit_code === 0 ? result.stdout.toString().trim() || null : null));
      this.commonDirs.set(dir, common);
    }
    return common;
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private async ingest(
    known: KnownRow,
    over: () => boolean,
  ): Promise<{ finished: boolean; stopped: boolean }> {
    const reducer = reducerOf(JSON.parse(known.meta!));
    if (!reducer) return { finished: true, stopped: false };
    const seen = await stat(known.path, { bigint: true });
    if (
      known.dev === String(seen.dev) &&
      known.ino === String(seen.ino) &&
      known.size === Number(seen.size) &&
      known.mtime === Number(seen.mtimeMs) &&
      known.offset === known.size
    )
      return { finished: true, stopped: false };
    const row = this.row(known.path)!;
    const handle = await open(row.path, 'r');
    try {
      const stats = await handle.stat({ bigint: true });
      const size = Number(stats.size);
      const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const identity = [
        String(stats.dev),
        String(stats.ino),
        size,
        Number(stats.mtimeMs),
        sha1(head.subarray(0, bytesRead)),
      ] as const;
      let offset = row.offset,
        state = row.state;
      if (
        row.size !== null &&
        (row.dev !== identity[0] ||
          row.ino !== identity[1] ||
          size < row.offset ||
          sha1(head.subarray(0, Math.min(bytesRead, row.size))) !== row.head_hash)
      ) {
        this.transaction(() => {
          this.db.prepare('DELETE FROM spans WHERE file = ?').run(row.path);
          this.db
            .prepare(
              'UPDATE files SET offset = 0, state = NULL, title = NULL, dev = ?, ino = ?, size = ?, mtime = ?, head_hash = ? WHERE path = ?',
            )
            .run(...identity, row.path);
        });
        this.changes += 1;
        offset = 0;
        state = null;
      }
      if (offset >= size) return { finished: true, stopped: false };
      // The stored json of each span by id, so a chunk writes only the spans it added or changed;
      // null when the file's rows are rewritten.
      let stored: Map<string, string> | null = null;
      if (state !== null) {
        reducer.restore(JSON.parse(state));
        stored = new Map(reducer.spans().map((span) => [span.id, JSON.stringify(span)]));
      }
      let length = CHUNK_BYTES;
      while (offset < size) {
        const chunk = Buffer.alloc(Math.min(length, size - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        const end = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
        // A line longer than the chunk needs a longer read to reach its newline.
        if (end === -1 && offset + bytesRead < size) {
          length *= 2;
          continue;
        }
        length = CHUNK_BYTES;
        // The text after the last newline is an unfinished line; it waits for the next scan.
        if (end === -1) break;
        for (const line of chunk.subarray(0, end).toString('utf8').split('\n'))
          if (line !== '') reducer.push(line);
        offset += end + 1;
        // The last span of an id is the one kept.
        const spans = new Map(
          reducer
            .spans()
            .map((span) => [span.id, { start: span.start, json: JSON.stringify(span) }]),
        );
        const saved = JSON.stringify(reducer.state());
        const title = reducer.title() ?? null;
        const before = stored;
        this.transaction(() => {
          if (before === null) this.db.prepare('DELETE FROM spans WHERE file = ?').run(row.path);
          else {
            const remove = this.db.prepare('DELETE FROM spans WHERE file = ? AND id = ?');
            for (const id of before.keys()) if (!spans.has(id)) remove.run(row.path, id);
          }
          const insert = this.db.prepare(
            'INSERT OR REPLACE INTO spans (file, id, lane_key, start, json) VALUES (?, ?, ?, ?, ?)',
          );
          for (const [id, { start, json }] of spans)
            if (before?.get(id) !== json) insert.run(row.path, id, row.lane_key, start, json);
          this.db
            .prepare(
              'UPDATE files SET offset = ?, state = ?, title = ?, dev = ?, ino = ?, size = ?, mtime = ?, head_hash = ? WHERE path = ?',
            )
            .run(offset, saved, title, ...identity, row.path);
        });
        stored = new Map([...spans].map(([id, { json }]) => [id, json]));
        this.changes += 1;
        if (over()) return { finished: offset >= size, stopped: true };
        await new Promise((resolve) => setImmediate(resolve));
      }
      return { finished: true, stopped: false };
    } finally {
      await handle.close();
    }
  }
}
