import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DomainError,
  id,
  type Entity,
  type Event,
  type Visual,
  type ProjectIntro,
} from '@pantheon/domain';

export const tables = [
  'device_observations',
  'projects',
  'sessions',
  'session_turns',
  'session_comments',
  'workspaces',
  'reviews',
  'approvals',
  'timers',
  'project_briefs',
  'milestones',
  'project_fact_versions',
  'project_boards',
  'project_baselines',
  'baseline_facts',
  'change_stories',
  'board_plans',
  'retrospectives',
  'workflow_policies',
  'workflow_step_runs',
  'visuals',
  'memory_records',
  'memory_states',
  'memory_jobs',
  'external_events',
  'themes',
  'user_styles',
  'agents',
  'agent_messages',
  'signal_issues',
  'seen_cursors',
  'personal_keys',
  'milestone_verifications',
  'project_goals',
  'environment_checks',
  'landings',
  'setting_change_proposals',
  'project_plans',
] as const;
export type Table = (typeof tables)[number];
export interface Outbox {
  id: string;
  kind: string;
  payload: string;
  state: 'pending' | 'sent' | 'done';
}
function readRow<T extends Entity>(data: string): T {
  return JSON.parse(data) as T;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

export interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}
export const migrations: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      for (const table of [
        'device_observations',
        'projects',
        'sessions',
        'session_turns',
        'session_comments',
        'workspaces',
        'reviews',
        'approvals',
        'timers',
        'project_briefs',
        'milestones',
        'project_fact_versions',
        'project_boards',
        'project_baselines',
        'baseline_facts',
        'change_stories',
        'range_stories',
        'board_plans',
        'retrospectives',
        'workflow_policies',
        'workflow_definitions',
        'workflow_step_runs',
        'improvements',
        'visuals',
        'memory_records',
        'memory_states',
        'memory_jobs',
        'external_events',
        'themes',
      ])
        db.exec(
          `CREATE TABLE ${table} (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;`,
        );
      db.exec(`
        CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_revision INTEGER NOT NULL, project_id TEXT NOT NULL, causation_id TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
        CREATE INDEX events_project ON events(project_id,sequence);
        CREATE INDEX events_aggregate ON events(aggregate_id, sequence);
        CREATE INDEX events_project_kind ON events(project_id, kind, sequence);
        CREATE INDEX events_diagnostic_window ON events(project_id, kind, created_at, sequence);
        CREATE TABLE event_retention (id INTEGER PRIMARY KEY CHECK(id=1), horizon INTEGER NOT NULL) STRICT;
        CREATE TABLE inbox (source_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, receipt TEXT NOT NULL) STRICT;
        CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending') STRICT;
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
        CREATE TABLE project_intros (project_id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
        CREATE VIRTUAL TABLE memory_search USING fts5(id UNINDEXED, body, tokenize='unicode61');
        CREATE UNIQUE INDEX workspace_path ON workspaces(json_extract(data,'$.path'));
        CREATE INDEX session_runtime_reflection ON session_turns(data ->> '$.session_id')
          WHERE data ->> '$.origin'='reflection' AND data ->> '$.state'='running';
        CREATE INDEX reviews_project ON reviews(json_extract(data,'$.project_id'));
        CREATE INDEX retrospectives_project ON retrospectives(json_extract(data,'$.project_id'));
        CREATE UNIQUE INDEX workflow_definition_name ON workflow_definitions(json_extract(data,'$.project_id'), json_extract(data,'$.name'));
        CREATE UNIQUE INDEX workflow_definition_default ON workflow_definitions(json_extract(data,'$.project_id')) WHERE json_extract(data,'$.is_default')=1;
        CREATE INDEX workflow_step_project ON workflow_step_runs(json_extract(data,'$.project_id'));
        CREATE UNIQUE INDEX workflow_step_task ON workflow_step_runs(json_extract(data,'$.lead_session_id'), json_extract(data,'$.task_id'), json_extract(data,'$.generation'), json_extract(data,'$.slot'), CASE WHEN json_extract(data,'$.slot')='before_merge' THEN coalesce(json_extract(data,'$.session_id'), '') ELSE '' END, coalesce(json_extract(data,'$.parent_run_id'), ''), coalesce(json_extract(data,'$.iteration'), 0), json_extract(data,'$.step.id'));
        CREATE INDEX memory_project ON memory_records(json_extract(data,'$.project_id'));
        CREATE INDEX memory_jobs_project ON memory_jobs(json_extract(data,'$.project_id'));
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec("CREATE INDEX outbox_pending ON outbox(state) WHERE state='pending';");
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(
        'CREATE TABLE user_styles (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;',
      );
    },
  },
  {
    version: 4,
    up(db) {
      for (const table of ['agents', 'agent_messages'])
        db.exec(
          `CREATE TABLE ${table} (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;`,
        );
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(
        'CREATE TABLE agent_proposals (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;',
      );
    },
  },
  {
    // A template's role prompt lives in code; instructions now hold only the user's own, which only
    // a custom agent had. No profile chooses the app_debug group any more.
    version: 6,
    up(db) {
      type Fields = { template?: string; instructions?: string; tools?: string[] };
      const strip = (fields: Fields | undefined, template: string | undefined) => {
        if (!fields) return;
        if (template !== 'custom') delete fields.instructions;
        if (fields.tools) fields.tools = fields.tools.filter((group) => group !== 'app_debug');
      };
      const rows = (table: string) =>
        db.prepare(`SELECT id, data FROM ${table}`).all() as { id: string; data: string }[];
      const templates = new Map<string, string | undefined>();
      for (const row of rows('agents')) {
        const agent = JSON.parse(row.data) as Fields;
        templates.set(row.id, agent.template);
        strip(agent, agent.template);
        db.prepare('UPDATE agents SET data=? WHERE id=?').run(JSON.stringify(agent), row.id);
      }
      for (const row of rows('agent_proposals')) {
        const proposal = JSON.parse(row.data) as {
          state: string;
          agent_id?: string;
          fields: Fields;
          edited_fields?: Fields;
        };
        if (proposal.state !== 'pending') continue;
        const template = proposal.agent_id
          ? templates.get(proposal.agent_id)
          : proposal.fields.template;
        strip(proposal.fields, template);
        strip(proposal.edited_fields, template);
        db.prepare('UPDATE agent_proposals SET data=? WHERE id=?').run(
          JSON.stringify(proposal),
          row.id,
        );
      }
    },
  },
  {
    version: 7,
    up(db) {
      db.exec(`
        CREATE TABLE signal_issues (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
        CREATE UNIQUE INDEX signal_issue_fingerprint ON signal_issues(json_extract(data,'$.project_id'), json_extract(data,'$.source'), json_extract(data,'$.fingerprint'));
      `);
    },
  },
  {
    version: 8,
    up(db) {
      db.exec(
        'CREATE TABLE seen_cursors (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;',
      );
    },
  },
  {
    version: 9,
    up(db) {
      db.exec(
        'CREATE TABLE personal_keys (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;',
      );
    },
  },
  {
    version: 10,
    up(db) {
      db.exec(`
        CREATE TABLE milestone_verifications (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
        CREATE INDEX milestone_verification_milestone ON milestone_verifications(json_extract(data,'$.milestone_id'));
        CREATE INDEX milestone_verification_project ON milestone_verifications(json_extract(data,'$.project_id'));
        CREATE TABLE project_goals (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
        CREATE INDEX project_goal_project ON project_goals(json_extract(data,'$.project_id'));
      `);
    },
  },
  {
    // A query uses an expression index only when it writes the expression the same way.
    version: 11,
    up(db) {
      db.exec(`
        CREATE INDEX board_plans_project ON board_plans(json_extract(data,'$.project_id'));
        CREATE INDEX improvements_project ON improvements(json_extract(data,'$.project_id'));
        CREATE INDEX session_turns_active ON session_turns(json_extract(data,'$.state')) WHERE json_extract(data,'$.state') IN ('queued','running');
      `);
    },
  },
  {
    version: 12,
    up(db) {
      db.exec("CREATE INDEX session_turns_project ON session_turns(data->>'$.project_id');");
    },
  },
  {
    version: 13,
    up(db) {
      db.exec(`
        CREATE TABLE environment_checks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
        CREATE INDEX environment_check_project ON environment_checks(json_extract(data,'$.project_id'));
        CREATE INDEX environment_check_baseline ON environment_checks(json_extract(data,'$.cause.baseline_id'));
      `);
    },
  },
  {
    version: 14,
    up(db) {
      db.exec(`
        CREATE TABLE playbooks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
        CREATE UNIQUE INDEX playbook_runtime ON playbooks(json_extract(data,'$.project_id'), coalesce(json_extract(data,'$.runtime'), ''));
      `);
    },
  },
  {
    version: 15,
    up(db) {
      db.exec(
        'CREATE TABLE setting_proposals (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;',
      );
    },
  },
  {
    version: 16,
    up(db) {
      db.exec(`
        CREATE TABLE landings (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
        CREATE INDEX landing_project ON landings(json_extract(data,'$.project_id'));
      `);
    },
  },
  {
    // A finding's outcome splits into fixed, intentional, not_worth_it and wrong.
    version: 17,
    up(db) {
      const outcomes: Record<string, string> = { adopted: 'fixed', dismissed: 'wrong' };
      const rows = db.prepare('SELECT id, data FROM reviews').all() as {
        id: string;
        data: string;
      }[];
      for (const row of rows) {
        const review = JSON.parse(row.data) as {
          findings?: { resolution?: { outcome: string } }[];
        };
        let changed = false;
        for (const finding of review.findings ?? []) {
          const outcome = finding.resolution && outcomes[finding.resolution.outcome];
          if (!outcome) continue;
          finding.resolution!.outcome = outcome;
          changed = true;
        }
        if (changed)
          db.prepare('UPDATE reviews SET data=? WHERE id=?').run(JSON.stringify(review), row.id);
      }
    },
  },
  {
    // setting_proposals keeps the rows of an earlier proposal shape.
    version: 18,
    up(db) {
      db.exec(`
        CREATE TABLE setting_change_proposals (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
        CREATE INDEX setting_change_proposal_project ON setting_change_proposals(json_extract(data,'$.project_id'));
      `);
    },
  },
  {
    // The id is the project id, so the table needs no project index.
    version: 19,
    up(db) {
      db.exec(
        'CREATE TABLE project_plans (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;',
      );
    },
  },
  {
    version: 20,
    up(db) {
      db.exec(`
        CREATE INDEX sessions_project ON sessions(data->>'$.project_id');
        CREATE INDEX events_agent_turn ON events(project_id, payload->>'$.turn_id', kind, sequence)
          WHERE kind GLOB 'agent.*' AND payload->>'$.turn_id' IS NOT NULL;
        CREATE INDEX events_session_role ON events(aggregate_id, kind)
          WHERE kind='session.opened' OR kind='session.main_agent_decided' OR kind='session.spawner_notified';
      `);
    },
  },
];
function fsyncPath(name: string): void {
  const fd = openSync(name, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version);
}
function schemaTables(db: DatabaseSync): string {
  return JSON.stringify(
    db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
  );
}
function integrityCheck(db: DatabaseSync): void {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok')
      throw new Error(JSON.stringify(rows));
  } catch (cause) {
    throw Object.assign(new DomainError('schema_corrupt', 'Database integrity check failed'), {
      cause,
    });
  }
}

export class Store {
  readonly db: DatabaseSync;
  // Parsed rows of each listed table, shared by every list() caller and so frozen. A write through
  // this Store drops its table; a rollback, another connection's commit or a write made on db
  // directly (total_changes differs from the count after the last write here) drops them all.
  private readonly lists = new Map<Table, readonly Entity[]>();
  private listed = { version: -1, changes: -1 };
  private readonly statements = new Map<string, StatementSync>();
  constructor(
    readonly file: string,
    readonly now: () => number = Date.now,
    options: { migrations: readonly Migration[] } = { migrations },
  ) {
    const known = options.migrations;
    const existing = file !== ':memory:' && existsSync(file);
    const absentSidecars = ['-wal', '-shm'].filter((suffix) => !existsSync(file + suffix));
    let writable = !existing;
    if (file !== ':memory:' && !existing) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      closeSync(openSync(file, 'wx', 0o600));
    }
    try {
      this.db = new DatabaseSync(file, { readOnly: existing });
    } catch (cause) {
      throw Object.assign(new DomainError('schema_corrupt', 'Database could not be opened'), {
        cause,
      });
    }
    try {
      let version: number;
      let before: string;
      try {
        version = schemaVersion(this.db);
        if (version > (known.at(-1)?.version ?? 0))
          throw new DomainError('schema_incompatible', 'Database was written by a newer Pantheon');
        before = schemaTables(this.db);
      } catch (cause) {
        if (cause instanceof DomainError) throw cause;
        throw Object.assign(
          new DomainError('schema_corrupt', 'Database schema could not be read'),
          {
            cause,
          },
        );
      }
      const pending = known.filter((migration) => migration.version > version);
      let saved: string | undefined;
      const directory = path.join(path.dirname(file), 'migration-backups');
      const backingUp = pending.length > 0 && (version !== 0 || before !== '[]');
      if (backingUp) integrityCheck(this.db);
      if (existing) {
        this.db.close();
        this.statements.clear();
        this.db = new DatabaseSync(file);
        writable = true;
      }
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      if (pending.length) {
        let migrating = pending[0]!.version;
        try {
          this.db.exec('BEGIN IMMEDIATE');
        } catch (cause) {
          throw Object.assign(
            new DomainError('migration_failed', `Schema migration ${migrating} could not start`),
            { cause, details: { version: migrating, recovery: 'none' } },
          );
        }
        if (backingUp && file !== ':memory:') {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          chmodSync(directory, 0o700);
          let timestamp = this.now();
          do {
            saved = path.join(directory, `control-v${version}-${timestamp++}.sqlite`);
          } while (existsSync(saved));
          closeSync(openSync(saved, 'wx', 0o600));
          // VACUUM INTO cannot run inside this connection's transaction; the write lock it holds
          // keeps a second connection's online snapshot, including committed WAL pages, current.
          const reader = new DatabaseSync(file, { readOnly: true });
          try {
            reader.prepare('VACUUM INTO ?').run(saved);
          } finally {
            reader.close();
          }
          const backup = new DatabaseSync(saved);
          try {
            backup.exec('PRAGMA journal_mode=DELETE');
            integrityCheck(backup);
          } finally {
            backup.close();
          }
          for (const name of [saved, directory]) fsyncPath(name);
        }
        try {
          for (const migration of pending) {
            migrating = migration.version;
            migration.up(this.db);
            this.db
              .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
              .run(migration.version, this.now());
            this.db.exec(`PRAGMA user_version=${migration.version}`);
          }
          this.db.exec('COMMIT');
        } catch (cause) {
          let recovery = 'rollback';
          let recoveryError: unknown;
          try {
            let rolledBack = false;
            try {
              this.db.exec('ROLLBACK');
              rolledBack = true;
            } catch {}
            const unchanged =
              schemaVersion(this.db) === version && schemaTables(this.db) === before;
            integrityCheck(this.db);
            if (!rolledBack || !unchanged) throw new Error('Migration rollback was incomplete');
          } catch {
            recovery = 'backup';
            try {
              if (!saved) throw new Error('No migration backup is available');
              const restoring = `${file}.restoring`;
              copyFileSync(saved, restoring);
              chmodSync(restoring, 0o600);
              fsyncPath(restoring);
              this.db.close();
              this.statements.clear();
              for (const suffix of ['-wal', '-shm'])
                if (existsSync(file + suffix)) unlinkSync(file + suffix);
              renameSync(restoring, file);
              fsyncPath(path.dirname(file));
              this.db = new DatabaseSync(file);
              integrityCheck(this.db);
              if (schemaVersion(this.db) !== version || schemaTables(this.db) !== before)
                throw new Error('Restored database schema does not match the backup');
            } catch (error) {
              recoveryError = error;
            }
          }
          throw Object.assign(
            new DomainError('migration_failed', `Schema migration ${migrating} failed`),
            { cause, details: { version: migrating, recovery, backup: saved, recoveryError } },
          );
        }
        if (saved) {
          const backups = readdirSync(directory)
            .map((name) => ({ name, timestamp: /^control-v\d+-(\d+)\.sqlite$/.exec(name)?.[1] }))
            .filter((entry) => entry.timestamp !== undefined)
            .sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
          for (const backup of backups.slice(3)) unlinkSync(path.join(directory, backup.name));
        }
      }
      if (file !== ':memory:') chmodSync(file, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL;');
    } catch (error) {
      try {
        this.db.close();
      } catch {}
      // A read-only WAL connection can create empty sidecars while inspecting the schema.
      if (!writable)
        for (const suffix of absentSidecars)
          if (existsSync(file + suffix)) unlinkSync(file + suffix);
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Transaction callbacks must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.lists.clear();
      throw error;
    }
  }
  /** sql prepared once on this connection; shared, so not for a read iterated while it runs again. */
  statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private changes(): number {
    return Number(this.statement('SELECT total_changes() AS n').get()!.n);
  }
  /** Runs a write of this Store, which changes only table among the listed tables. */
  private write<R>(table: Table | undefined, run: () => R): R {
    const synced = this.changes() === this.listed.changes;
    const result = run();
    if (table) this.lists.delete(table);
    if (synced) this.listed.changes = this.changes();
    return result;
  }
  get<T extends Entity>(table: Table, key: string): T | undefined {
    const row = this.statement(`SELECT data FROM ${table} WHERE id=?`).get(key) as
      { data: string } | undefined;
    return row ? readRow<T>(row.data) : undefined;
  }
  must<T extends Entity>(table: Table, key: string): T {
    const value = this.get<T>(table, key);
    if (!value) throw new DomainError('not_found', `${table}/${key}`);
    return value;
  }
  /** Every row of the table in insertion order; the rows are frozen, the array is the caller's. */
  list<T extends Entity>(table: Table): T[] {
    const version = Number(this.statement('PRAGMA data_version').get()!.data_version);
    const changes = this.changes();
    if (version !== this.listed.version || changes !== this.listed.changes) {
      this.lists.clear();
      this.listed = { version, changes };
    }
    let rows = this.lists.get(table);
    if (!rows) {
      rows = (
        this.statement(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]
      ).map((r) => frozen(readRow(r.data)));
      this.lists.set(table, rows);
    }
    return [...rows] as T[];
  }
  insert<T extends Entity>(table: Table, value: T): T {
    this.write(table, () =>
      this.statement(`INSERT INTO ${table} VALUES(?,?,?)`).run(
        value.id,
        value.revision,
        JSON.stringify(value),
      ),
    );
    return value;
  }
  update<T extends Entity>(table: Table, value: T, expected: number): T {
    const next = { ...value, revision: expected + 1 };
    const result = this.write(table, () =>
      this.statement(`UPDATE ${table} SET revision=?,data=? WHERE id=? AND revision=?`).run(
        next.revision,
        JSON.stringify(next),
        value.id,
        expected,
      ),
    );
    if (Number(result.changes) !== 1)
      throw new DomainError('revision_conflict', `Stale ${table}/${value.id}`);
    return next;
  }
  remove(table: Table, key: string, expected: number): void {
    const result = this.write(table, () =>
      this.statement(`DELETE FROM ${table} WHERE id=? AND revision=?`).run(key, expected),
    );
    if (Number(result.changes) !== 1)
      throw new DomainError('revision_conflict', `Stale ${table}/${key}`);
  }
  // Visual revisions count redraws; board metadata and session detachment keep that revision.
  saveVisual(value: Visual): Visual {
    this.write('visuals', () =>
      this.statement('UPDATE visuals SET revision=?,data=? WHERE id=?').run(
        value.revision,
        JSON.stringify(value),
        value.id,
      ),
    );
    return value;
  }
  projectIntro(projectId: string): ProjectIntro | undefined {
    const row = this.statement('SELECT data FROM project_intros WHERE project_id=?').get(
      projectId,
    ) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ProjectIntro) : undefined;
  }
  detachProjectIntroSession(sessionId: string): void {
    this.write(undefined, () =>
      this.statement(
        "UPDATE project_intros SET data=json_set(data,'$.session_id',NULL) WHERE json_extract(data,'$.session_id')=?",
      ).run(sessionId),
    );
  }
  saveProjectIntro(intro: ProjectIntro): void {
    this.write(undefined, () =>
      this.statement(
        'INSERT INTO project_intros VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data',
      ).run(intro.project_id, JSON.stringify(intro)),
    );
  }
  event(
    kind: string,
    entity: Entity,
    project_id: string,
    payload: unknown,
    causation_id = '',
  ): Event {
    const event = {
      event_id: id(),
      kind,
      aggregate_id: entity.id,
      aggregate_revision: entity.revision,
      project_id,
      causation_id,
      created_at: this.now(),
      payload,
    };
    const result = this.write(undefined, () =>
      this.statement(
        'INSERT INTO events(event_id,kind,aggregate_id,aggregate_revision,project_id,causation_id,created_at,payload) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        event.event_id,
        kind,
        entity.id,
        entity.revision,
        project_id,
        causation_id,
        event.created_at,
        JSON.stringify(payload),
      ),
    );
    return { ...event, sequence: Number(result.lastInsertRowid) };
  }
  /** session_id keeps the session's own events, its turns' events and its approval events. */
  events(
    after = 0,
    project_id?: string,
    limit = 256,
    kinds?: readonly string[],
    session_id?: string,
  ): Event[] {
    const rows = this.statement(
      `SELECT * FROM events WHERE sequence>?${project_id ? ' AND project_id=?' : ''}${
        kinds ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''
      }${
        session_id
          ? ` AND (aggregate_id=? OR aggregate_id IN (SELECT id FROM session_turns WHERE data->>'$.session_id'=?) OR (kind LIKE 'approval.%' AND payload->>'$.session_id'=?))`
          : ''
      } ORDER BY sequence LIMIT ?`,
    ).all(
      after,
      ...(project_id ? [project_id] : []),
      ...(kinds ?? []),
      ...(session_id ? [session_id, session_id, session_id] : []),
      limit,
    ) as unknown as (Omit<Event, 'payload'> & { payload: string })[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  /** The project's events of these kinds in order, read through the project and kind index. */
  kindEvents(project_id: string, kinds: string[]): Event[] {
    const rows = this.statement(
      `SELECT * FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY sequence`,
    ).all(project_id, ...kinds) as unknown as (Omit<Event, 'payload'> & { payload: string })[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  /** kindEvents from `since` on, read through the project, kind and time index. */
  kindEventsSince(project_id: string, kinds: string[], since: number): Event[] {
    const rows = this.statement(
      `SELECT * FROM events INDEXED BY events_diagnostic_window WHERE project_id=? AND kind IN (${kinds.map(() => '?').join(',')}) AND created_at>=? ORDER BY sequence`,
    ).all(project_id, ...kinds, since) as unknown as (Omit<Event, 'payload'> & {
      payload: string;
    })[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  /** Bounded diagnostic reads, indexed by project, event kind and time. */
  windowEvents(
    projectId: string,
    kinds: readonly string[],
    from: number,
    to: number,
    limit: number,
    laneKey?: string,
  ): Event[] {
    const query = this.statement(
      `SELECT sequence, event_id, kind, aggregate_id, aggregate_revision, project_id,
         causation_id, created_at, json_object(
           'turn_id', payload ->> '$.turn_id', 'tool_call_id', payload ->> '$.tool_call_id',
           'parent_tool_use_id', payload ->> '$.parent_tool_use_id',
           'duration_ms', payload ->> '$.duration_ms', 'ok', payload -> '$.ok',
           'name', CASE WHEN kind='agent.tool.started' THEN payload ->> '$.name' END,
           'decided_by', CASE WHEN kind IN ('approval.approved', 'approval.rejected') THEN payload ->> '$.decided_by' END,
           'session_id', payload ->> '$.session_id', 'commit', payload ->> '$.commit',
           'run_id', payload ->> '$.run_id', 'task_id', payload ->> '$.task_id',
           'task_ids', payload -> '$.task_ids', 'requested_at', payload ->> '$.requested_at',
           'wait', payload ->> '$.wait', 'state', payload ->> '$.state',
           'error', CASE WHEN kind='turn.failed' THEN payload ->> '$.error' END
         ) AS payload FROM events WHERE project_id=? AND kind=? AND created_at BETWEEN ? AND ?
         ${
           laneKey === undefined
             ? ''
             : `AND (aggregate_id=? OR payload ->> '$.session_id'=?
           OR (kind LIKE 'turn.%' AND aggregate_id IN
             (SELECT id FROM session_turns WHERE data ->> '$.session_id'=?))
           OR (kind LIKE 'approval.%' AND aggregate_id IN
             (SELECT aggregate_id FROM events WHERE project_id=? AND kind='approval.requested'
               AND payload ->> '$.session_id'=? AND created_at BETWEEN ? AND ?)))`
         }
         ORDER BY created_at DESC, sequence DESC LIMIT ?`,
    );
    type Row = Omit<Event, 'payload'> & { payload: string };
    return kinds
      .flatMap(
        (kind) =>
          query.all(
            projectId,
            kind,
            from,
            to,
            ...(laneKey === undefined
              ? []
              : [laneKey, laneKey, laneKey, projectId, laneKey, from, to]),
            limit,
          ) as unknown as Row[],
      )
      .sort((a, b) => b.created_at - a.created_at || b.sequence - a.sequence)
      .slice(0, limit)
      .reverse()
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  /** Times of the aggregate's first and last event, read through the aggregate index; null without events. */
  eventSpan(aggregate_id: string): { first: number; last: number } | null {
    const row = this.statement(
      'SELECT min(created_at) AS first, max(created_at) AS last FROM events WHERE aggregate_id=?',
    ).get(aggregate_id) as { first: number | null; last: number | null };
    return row.first === null ? null : { first: row.first, last: row.last! };
  }
  cursor(): number {
    const row = this.statement("SELECT seq FROM sqlite_sequence WHERE name='events'").get();
    return Number(row?.seq ?? 0);
  }
  pruneEvents(beforeSequence: number): void {
    this.write(undefined, () =>
      this.transaction(() => {
        this.statement('DELETE FROM events WHERE sequence<?').run(beforeSequence);
        const row = this.statement('SELECT min(sequence) AS n FROM events').get() as {
          n: number | null;
        };
        this.statement(
          'INSERT INTO event_retention VALUES(1,?) ON CONFLICT(id) DO UPDATE SET horizon=excluded.horizon',
        ).run(row.n ?? this.cursor() + 1);
      }),
    );
  }
  eventHorizon(): number {
    const row = this.statement('SELECT horizon FROM event_retention WHERE id=1').get() as
      { horizon: number } | undefined;
    return row?.horizon ?? 1;
  }
  receipt(key: string): { input_hash: string; receipt: unknown } | undefined {
    const row = this.statement('SELECT * FROM inbox WHERE source_key=?').get(key) as
      { input_hash: string; receipt: string } | undefined;
    return row && { input_hash: row.input_hash, receipt: JSON.parse(row.receipt) };
  }
  remember(key: string, inputHash: string, receipt: unknown): void {
    this.write(undefined, () =>
      this.statement('INSERT INTO inbox VALUES(?,?,?)').run(
        key,
        inputHash,
        JSON.stringify(receipt),
      ),
    );
  }
  enqueue(kind: string, payload: unknown): string {
    const key = id();
    this.write(undefined, () =>
      this.statement('INSERT INTO outbox(id,kind,payload) VALUES(?,?,?)').run(
        key,
        kind,
        JSON.stringify(payload),
      ),
    );
    return key;
  }
  pending(): Outbox[] {
    return this.statement(
      "SELECT * FROM outbox WHERE state='pending' ORDER BY rowid",
    ).all() as unknown as Outbox[];
  }
  mark(key: string, state: Outbox['state']): void {
    this.write(undefined, () =>
      this.statement('UPDATE outbox SET state=? WHERE id=?').run(state, key),
    );
  }
  close(): void {
    this.db.close();
    this.statements.clear();
  }
}

export class ArtifactFiles {
  failpoint: (name: string) => void = () => {};
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  put(bytes: Uint8Array): { hash: string; uri: string } {
    const hash = createHash('sha256').update(bytes).digest('hex'),
      uri = path.join(this.directory, hash);
    if (!existsSync(uri)) {
      const temp = path.join(this.directory, `.${id()}.tmp`),
        fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.failpoint('before_artifact_rename');
      renameSync(temp, uri);
      const dirfd = openSync(this.directory, 'r');
      try {
        fsyncSync(dirfd);
      } finally {
        closeSync(dirfd);
      }
      this.failpoint('after_artifact_rename_before_db');
    }
    return { hash, uri };
  }
  valid(hash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(hash)) return false;
    try {
      return (
        createHash('sha256')
          .update(readFileSync(path.join(this.directory, hash)))
          .digest('hex') === hash
      );
    } catch {
      return false;
    }
  }
  collect(referenced: Set<string>, removed: string[] = []): number {
    let count = 0;
    for (const file of readdirSync(this.directory))
      if (
        (/^[a-f0-9]{64}$/.test(file) || /^\.[a-f0-9-]+\.tmp$/.test(file)) &&
        !referenced.has(file)
      ) {
        unlinkSync(path.join(this.directory, file));
        removed.push(file);
        count++;
      }
    return count;
  }
}
