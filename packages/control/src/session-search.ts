import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Store } from '@pantheon/store';
import type { AgentEvent, Session, SessionTurn, Workspace } from '@pantheon/domain';
import type { querySchemas, SessionSearchHit, SessionSearchResult } from '@pantheon/protocol';

type SearchInput = ReturnType<(typeof querySchemas)['session.search']['parse']>;
type Document = {
  kind: SessionSearchHit['kind'];
  turn_id: string | null;
  speaker: 'user' | 'agent' | null;
  body: string;
  at: number;
  /** Message order within a session at equal `at`: the turn's rowid for user input, the
   * sequence of the reply's first delta for an agent reply; 0 for titles and branches. */
  position: number;
};
type IndexedEvent = {
  kind: string;
  aggregate_id: string;
  created_at: number;
  sequence: number;
  payload: string;
};
/** What a session's documents were built from, so the next update reads only newer events. */
type IndexState = {
  /** Largest event sequence when the session was indexed. */
  sequence: number;
  /** Event retention horizon then; pruning changes it and forces a rebuild. */
  horizon: number;
  /** Latest event time over the session and its turns. */
  activity: number;
  /** Number of turns then and a hash of their rowids and ids in rowid order. */
  turns: number;
  fingerprint: string;
  /** JSON array of turn ids that deltas named without the turn belonging to the session. */
  orphans: string;
};

/** Match count up to which a search sorts its matches instead of walking display order. */
const sortedMatches = 1000;

/** A derived index; source changes and the pending queue commit in the same SQLite transaction. */
export class SessionSearch {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> = Promise.resolve();
  private closed = false;
  private failure: unknown;
  private initialized = false;
  /** Session id to the ms time it was last indexed; entries older than the gap are dropped. */
  private readonly indexedAt = new Map<string, number>();

  /**
   * @param reindexGapMs ms a session waits after indexing before it is indexed again. Indexing
   * reads all of the session's turns, and a streaming reply queues its session on every delta.
   */
  constructor(
    private readonly store: Pick<Store, 'db' | 'transaction'>,
    private readonly reindexGapMs = 2000,
  ) {
    const { db } = store;
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_search_documents (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
        turn_id TEXT, speaker TEXT, body TEXT NOT NULL, folded TEXT NOT NULL,
        pairs TEXT NOT NULL, at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
    // An index written before positions existed keeps serving until each session is rebuilt.
    if (
      !(db.prepare('PRAGMA table_info(session_search_documents)').all() as { name: string }[]).some(
        (column) => column.name === 'position',
      )
    )
      db.exec(`ALTER TABLE session_search_documents ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
        DROP INDEX IF EXISTS session_search_order;`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS session_search_session ON session_search_documents(session_id);
      CREATE INDEX IF NOT EXISTS session_search_display ON session_search_documents(
        (kind='message'), at DESC, session_id, kind DESC, (speaker='agent') DESC, position DESC, id DESC
      );
      CREATE TABLE IF NOT EXISTS session_search_state (
        session_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, horizon INTEGER NOT NULL,
        activity INTEGER NOT NULL, turns INTEGER NOT NULL, fingerprint TEXT NOT NULL,
        orphans TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
        folded, pairs, content='session_search_documents', content_rowid='id', tokenize='trigram case_sensitive 1'
      );
      CREATE TABLE IF NOT EXISTS session_search_pending (session_id TEXT PRIMARY KEY) STRICT;
      CREATE TRIGGER IF NOT EXISTS session_search_document_insert AFTER INSERT ON session_search_documents BEGIN
        INSERT INTO session_search_fts(rowid, folded, pairs) VALUES(new.id, new.folded, new.pairs);
      END;
      CREATE TRIGGER IF NOT EXISTS session_search_document_delete AFTER DELETE ON session_search_documents BEGIN
        INSERT INTO session_search_fts(session_search_fts, rowid, folded, pairs)
          VALUES('delete', old.id, old.folded, old.pairs);
      END;
      CREATE TRIGGER IF NOT EXISTS session_search_session_delete AFTER DELETE ON sessions BEGIN
        DELETE FROM session_search_documents WHERE session_id=old.id;
        DELETE FROM session_search_pending WHERE session_id=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS session_search_state_delete AFTER DELETE ON sessions BEGIN
        DELETE FROM session_search_state WHERE session_id=old.id;
      END;
    `);
    for (const operation of ['INSERT', 'UPDATE'])
      db.exec(`CREATE TRIGGER IF NOT EXISTS session_search_session_${operation.toLowerCase()}
        AFTER ${operation} ON sessions BEGIN
          INSERT OR IGNORE INTO session_search_pending VALUES(new.id);
        END;`);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'old' : 'new';
      db.exec(`CREATE TRIGGER IF NOT EXISTS session_search_turn_${operation.toLowerCase()}
        AFTER ${operation} ON session_turns BEGIN
          INSERT OR IGNORE INTO session_search_pending SELECT ${row}.data ->> '$.session_id'
            WHERE EXISTS(SELECT 1 FROM sessions WHERE id=${row}.data ->> '$.session_id');
        END;`);
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_search_event_insert AFTER INSERT ON events BEGIN
        INSERT OR IGNORE INTO session_search_pending
          SELECT id FROM sessions WHERE id=new.aggregate_id
          UNION SELECT data ->> '$.session_id' FROM session_turns WHERE id=new.aggregate_id;
      END;
      CREATE TRIGGER IF NOT EXISTS session_search_workspace_update AFTER UPDATE ON workspaces BEGIN
        INSERT OR IGNORE INTO session_search_pending
          SELECT id FROM sessions WHERE data ->> '$.workspace_id'=new.id;
      END;
      INSERT OR IGNORE INTO session_search_pending SELECT id FROM sessions;
    `);
    this.schedule();
  }

  private schedule(delay = 10): void {
    this.timer = setTimeout(() => {
      this.running = this.update().catch((error: unknown) => {
        // Startup continues; a query reports the indexing failure to the caller.
        this.failure = error;
      });
    }, delay);
    this.timer.unref();
  }

  private async update(): Promise<void> {
    const { db } = this.store;
    if (!this.initialized) {
      db.exec(
        "CREATE INDEX IF NOT EXISTS session_search_turns ON session_turns(data ->> '$.session_id')",
      );
      this.initialized = true;
    }
    const now = Date.now();
    for (const [id, at] of this.indexedAt)
      if (now - at >= this.reindexGapMs) this.indexedAt.delete(id);
    const recent = [...this.indexedAt.keys()];
    const pending = db
      .prepare(
        `SELECT session_id FROM session_search_pending
        WHERE session_id NOT IN (${recent.map(() => '?').join(',')}) LIMIT 1`,
      )
      .get(...recent) as { session_id: string } | undefined;
    if (pending) {
      const row = db.prepare('SELECT data FROM sessions WHERE id=?').get(pending.session_id) as
        { data: string } | undefined;
      if (row) {
        const session = JSON.parse(row.data) as Session;
        const workspaceRow = session.workspace_id
          ? (db.prepare('SELECT data FROM workspaces WHERE id=?').get(session.workspace_id) as
              { data: string } | undefined)
          : undefined;
        const workspace = workspaceRow ? (JSON.parse(workspaceRow.data) as Workspace) : undefined;
        let branch = '';
        if (
          workspace &&
          !workspace.removed_at &&
          (!workspace.provisioning || workspace.provisioning.state === 'ready')
        )
          branch = await new Promise<string>((resolve) => {
            execFile(
              'git',
              ['symbolic-ref', '--quiet', '--short', 'HEAD'],
              { cwd: workspace.path },
              (error, stdout) => {
                // Detached HEAD and removed worktrees have no searchable branch.
                resolve(error ? '' : stdout.trim());
              },
            );
          });
        if (this.closed) return;
        this.store.transaction(() => {
          const current = db.prepare('SELECT data FROM sessions WHERE id=?').get(session.id) as
            { data: string } | undefined;
          if (!current) return;
          const latest = JSON.parse(current.data) as Session;
          const turns = (
            db
              .prepare(
                "SELECT rowid, data FROM session_turns WHERE data ->> '$.session_id'=? ORDER BY rowid",
              )
              .all(session.id) as { rowid: number; data: string }[]
          ).map((row) => ({ position: row.rowid, turn: JSON.parse(row.data) as SessionTurn }));
          const fingerprint = (count: number) => {
            const hash = createHash('sha256');
            for (const { position, turn } of turns.slice(0, count))
              hash.update(JSON.stringify([position, turn.id]));
            return hash.digest('hex');
          };
          const { horizon } = db
            .prepare(
              'SELECT coalesce((SELECT horizon FROM event_retention WHERE id=1), 1) AS horizon',
            )
            .get() as { horizon: number };
          const { sequence } = db
            .prepare('SELECT coalesce(max(sequence), 0) AS sequence FROM events')
            .get() as { sequence: number };
          const saved = db
            .prepare('SELECT * FROM session_search_state WHERE session_id=?')
            .get(session.id) as IndexState | undefined;
          const orphans = new Set(saved ? (JSON.parse(saved.orphans) as string[]) : []);
          const earlier = db.prepare('SELECT 1 FROM events WHERE aggregate_id=? AND sequence<=?');
          // Appending new events and turns is exact only while every event the saved documents
          // were built from still exists and no new turn already has older events.
          const incremental =
            saved !== undefined &&
            saved.horizon === horizon &&
            saved.turns <= turns.length &&
            fingerprint(saved.turns) === saved.fingerprint &&
            turns
              .slice(saved.turns)
              .every(({ turn }) => !orphans.has(turn.id) && !earlier.get(turn.id, saved.sequence));
          const base = incremental ? saved : { sequence: 0, activity: 0, turns: 0 };
          if (!incremental) {
            db.prepare('DELETE FROM session_search_documents WHERE session_id=?').run(session.id);
            orphans.clear();
          }
          const key = (document: Pick<Document, 'kind' | 'speaker' | 'turn_id'>) =>
            `${document.kind}:${document.speaker}:${document.turn_id}`;
          const previous = new Map(
            (incremental
              ? (db
                  .prepare(
                    'SELECT id, kind, turn_id, speaker, body, at, position FROM session_search_documents WHERE session_id=?',
                  )
                  .all(session.id) as (Document & { id: number })[])
              : []
            ).map((document) => [key(document), document]),
          );
          const events = db
            .prepare(
              `SELECT kind, aggregate_id, created_at, sequence,
                CASE WHEN kind='agent.message.delta' THEN payload ELSE '{}' END AS payload
              FROM events WHERE sequence>? AND (aggregate_id=? OR aggregate_id IN
                (SELECT id FROM session_turns WHERE data ->> '$.session_id'=?)) ORDER BY sequence`,
            )
            .all(base.sequence, session.id, session.id) as IndexedEvent[];
          const activity = events.reduce(
            (at, event) => Math.max(at, event.created_at),
            base.activity,
          );
          const times = new Map<string, number>();
          const answers = new Map<string, Document>();
          const turnIds = new Set(turns.map(({ turn }) => turn.id));
          for (const event of events) {
            if (event.kind === 'turn.queued') times.set(event.aggregate_id, event.created_at);
            if (event.kind !== 'agent.message.delta') continue;
            const payload = JSON.parse(event.payload) as Extract<
              AgentEvent,
              { kind: 'message.delta' }
            >;
            if (!payload.turn_id) continue;
            if (!turnIds.has(payload.turn_id)) {
              orphans.add(payload.turn_id);
              continue;
            }
            const indexed = previous.get(`message:agent:${payload.turn_id}`);
            const answer: Document = answers.get(payload.turn_id) ?? {
              kind: 'message',
              turn_id: payload.turn_id,
              speaker: 'agent',
              body: indexed?.body ?? '',
              at: 0,
              position: indexed?.position ?? event.sequence,
            };
            answer.body += payload.text;
            answer.at = event.created_at;
            answers.set(payload.turn_id, answer);
          }
          const queued = db.prepare(
            "SELECT created_at FROM events WHERE aggregate_id=? AND kind='turn.queued' ORDER BY sequence DESC LIMIT 1",
          );
          const documents: Document[] = [
            {
              kind: 'title',
              turn_id: null,
              speaker: null,
              body: latest.title ?? '',
              at: activity,
              position: 0,
            },
            {
              kind: 'branch',
              turn_id: null,
              speaker: null,
              body: branch,
              at: activity,
              position: 0,
            },
            ...turns.map(({ position, turn }, index): Document => {
              const indexed = previous.get(`message:user:${turn.id}`);
              // A known turn without a document has its queue time only in older events.
              const at =
                times.get(turn.id) ??
                indexed?.at ??
                (index < base.turns
                  ? ((queued.get(turn.id) as { created_at: number } | undefined)?.created_at ?? 0)
                  : 0);
              return {
                kind: 'message',
                turn_id: turn.id,
                speaker: 'user',
                body: turn.origin ? '' : turn.input,
                at,
                position,
              };
            }),
            ...answers.values(),
          ];
          const remove = db.prepare('DELETE FROM session_search_documents WHERE id=?');
          const insert = db.prepare(`INSERT INTO session_search_documents
            (session_id, kind, turn_id, speaker, body, folded, pairs, at, position)
            VALUES(?,?,?,?,?,?,?,?,?)`);
          for (const document of documents) {
            const indexed = previous.get(key(document));
            if (
              indexed &&
              indexed.body === document.body &&
              indexed.at === document.at &&
              indexed.position === document.position
            )
              continue;
            if (indexed) remove.run(indexed.id);
            if (!document.body) continue;
            const folded = document.body.toLowerCase();
            const characters = [...folded];
            // Padding lets the trigram tokenizer index a two-character substring.
            const pairs = [...new Set(characters.slice(1).map((c, i) => `^${characters[i]}${c}$`))];
            insert.run(
              session.id,
              document.kind,
              document.turn_id,
              document.speaker,
              document.body,
              folded,
              pairs.join(' '),
              document.at,
              document.position,
            );
          }
          db.prepare('INSERT OR REPLACE INTO session_search_state VALUES(?,?,?,?,?,?,?)').run(
            session.id,
            sequence,
            horizon,
            activity,
            turns.length,
            fingerprint(turns.length),
            JSON.stringify([...orphans]),
          );
          db.prepare('DELETE FROM session_search_pending WHERE session_id=?').run(session.id);
        });
        this.indexedAt.set(session.id, Date.now());
      } else
        db.prepare('DELETE FROM session_search_pending WHERE session_id=?').run(pending.session_id);
    }
    if (!this.closed) this.schedule(pending ? 10 : 250);
  }

  search(input: SearchInput): SessionSearchResult {
    if (this.failure) throw this.failure;
    const { db } = this.store;
    const indexing_complete =
      db.prepare('SELECT 1 FROM session_search_pending LIMIT 1').get() === undefined;
    if ([...input.text].length < 2) return { hits: [], indexing_complete };
    const needle = input.text.toLowerCase();
    const column = [...needle].length >= 3 ? 'folded' : 'pairs';
    const phrase = column === 'pairs' ? `^${needle}$` : needle;
    const match = `${column} : "${phrase.replaceAll('"', '""')}"`;
    const project = input.project_id === undefined ? [] : [input.project_id];
    const filter =
      input.project_id === undefined
        ? ''
        : "AND d.session_id IN (SELECT id FROM sessions WHERE data ->> '$.project_id'=?)";
    const order = `ORDER BY d.kind='message', d.at DESC, d.session_id, d.kind DESC,
      d.speaker='agent' DESC, d.position DESC, d.id DESC`;
    const matches = (
      db
        .prepare('SELECT rowid FROM session_search_fts WHERE session_search_fts MATCH ? LIMIT ?')
        .all(match, sortedMatches + 1) as { rowid: number }[]
    ).map((row) => row.rowid);
    // Few matches are sorted directly; for more, walk display order and stop before loading
    // text beyond the result limit, since the walk visits every document until hits fill it.
    const candidates = (
      matches.length <= sortedMatches
        ? db
            .prepare(
              `SELECT d.id, d.session_id, d.kind FROM session_search_documents d
              WHERE d.id IN (SELECT value FROM json_each(?)) ${filter} ${order}`,
            )
            .iterate(JSON.stringify(matches), ...project)
        : db
            .prepare(
              `SELECT d.id, d.session_id, d.kind FROM session_search_documents d
              INDEXED BY session_search_display
              WHERE d.id IN (SELECT rowid FROM session_search_fts WHERE session_search_fts MATCH ?)
                ${filter} ${order}`,
            )
            .iterate(match, ...project)
    ) as Iterable<{ id: number; session_id: string; kind: Document['kind'] }>;
    const read = db.prepare(`SELECT d.*, s.data ->> '$.project_id' AS project_id,
      coalesce(s.data ->> '$.title', '') AS title,
      s.data ->> '$.archived_at' IS NOT NULL AS archived
      FROM session_search_documents d JOIN sessions s ON s.id=d.session_id WHERE d.id=?`);
    const counts = new Map<string, number>();
    const hits: SessionSearchHit[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.session_id}:${candidate.kind}`;
      const count = counts.get(key) ?? 0;
      if (count >= (candidate.kind === 'message' ? 3 : 1)) continue;
      counts.set(key, count + 1);
      const row = read.get(candidate.id) as Document & {
        session_id: string;
        project_id: string;
        title: string;
        archived: number;
      };
      const found = row.body.toLowerCase().indexOf(needle);
      let start = 0,
        end = 0,
        folded = 0;
      for (const character of row.body) {
        if (folded <= found) start = end;
        folded += character.toLowerCase().length;
        end += character.length;
        if (folded >= found + needle.length) break;
      }
      const length = end - start;
      const width = Math.max(120, length);
      const from = Math.max(
        0,
        Math.min(start - Math.floor((width - length) / 2), row.body.length - width),
      );
      const hit = {
        session_id: row.session_id,
        project_id: row.project_id,
        title: row.title,
        archived: !!row.archived,
        at: new Date(row.at).toISOString(),
        excerpt: row.body.slice(from, from + width),
        match: { start: start - from, length },
      };
      hits.push(
        row.kind === 'message'
          ? { ...hit, kind: 'message', turn_id: row.turn_id!, speaker: row.speaker! }
          : { ...hit, kind: row.kind },
      );
      if (hits.length === input.limit) break;
    }
    return { hits, indexing_complete };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
