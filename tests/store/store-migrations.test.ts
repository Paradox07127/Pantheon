import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Store, migrations, tables, type Migration } from '@pantheon/store';

const latestVersion = migrations.at(-1)!.version;
// A later build's schema: the current migrations and one that adds a table.
const upgraded: Migration[] = [
  ...migrations,
  {
    version: latestVersion + 1,
    up: (db) => db.exec('CREATE TABLE project_notes (value TEXT) STRICT;'),
  },
];
const roots: string[] = [];
const openStores: InstanceType<typeof Store>[] = [];
const row = { id: 'saved-project', revision: 1, name: 'Saved project' };
function databaseFile() {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'store-migrations-'));
  roots.push(root);
  return path.join(root, 'control.sqlite');
}
function open(file: string, known = migrations, now = () => 1700000000000) {
  const store = new Store(file, now, { migrations: known });
  openStores.push(store);
  return store;
}
function close(store: InstanceType<typeof Store>) {
  store.close();
  openStores.splice(openStores.indexOf(store), 1);
}
function seed(file: string) {
  const store = open(file);
  store.insert('projects', row);
  store.event('project.saved', row, row.id, { name: row.name });
  return store;
}
function tableList(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
}
function backups(file: string) {
  const directory = path.join(path.dirname(file), 'migration-backups');
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => /^control-v\d+-.*\.sqlite$/.test(name))
        .sort()
        .map((name) => path.join(directory, name))
    : [];
}
function bytes(file: string) {
  return [file, file + '-wal'].map((name) => (existsSync(name) ? readFileSync(name) : null));
}
afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('migrates a populated database and verifies a private online backup including WAL rows', () => {
  const file = databaseFile();
  const previous = seed(file);
  const events = previous.events();
  expect(statSync(file + '-wal').size).toBeGreaterThan(0);
  const store = open(file, upgraded);
  expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(latestVersion + 1);
  expect(store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(
    upgraded.map(({ version }) => ({ version })),
  );
  expect(store.list('projects')).toEqual([row]);
  expect(store.events()).toEqual(events);
  expect(store.cursor()).toBe(1);
  expect(store.eventHorizon()).toBe(1);
  const saved = backups(file);
  expect(saved).toHaveLength(1);
  expect(path.basename(saved[0]!)).toMatch(new RegExp(`^control-v${latestVersion}-\\d+\\.sqlite$`));
  expect(statSync(path.dirname(saved[0]!)).mode & 0o777).toBe(0o700);
  expect(statSync(saved[0]!).mode & 0o777).toBe(0o600);
  const backup = open(saved[0]!);
  expect(backup.db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
  expect(backup.db.prepare('PRAGMA user_version').get()?.user_version).toBe(latestVersion);
  expect(backup.list('projects')).toEqual([row]);
  expect(backup.events()).toEqual(events);
  expect(tableList(backup.db)).not.toContainEqual({ name: 'project_notes' });
  close(previous);
});

it.each(['rollback', 'backup'] as const)(
  'recovers a failed migration through %s and permits a later normal open',
  (recovery) => {
    const file = databaseFile();
    const previous = seed(file);
    const tables = tableList(previous.db);
    const events = previous.events();
    close(previous);
    const cause = new Error('Migration interrupted after SQL');
    const failing = [
      ...migrations,
      {
        version: latestVersion + 1,
        up(db: DatabaseSync) {
          db.exec('CREATE TABLE migration_probe (value TEXT) STRICT;');
          if (recovery === 'backup') db.exec(`COMMIT; PRAGMA user_version=${latestVersion + 1};`);
          throw cause;
        },
      },
    ];
    expect(() => open(file, failing)).toThrowError(
      expect.objectContaining({
        code: 'migration_failed',
        cause,
        details: expect.objectContaining({ version: latestVersion + 1, recovery }),
      }),
    );
    const restored = open(file);
    expect(restored.db.prepare('PRAGMA user_version').get()?.user_version).toBe(latestVersion);
    expect(restored.db.prepare('PRAGMA integrity_check').all()).toEqual([
      { integrity_check: 'ok' },
    ]);
    expect(tableList(restored.db)).toEqual(tables);
    expect(restored.list('projects')).toEqual([row]);
    expect(restored.events()).toEqual(events);
    expect(backups(file)).toHaveLength(1);
    close(restored);
    const retried = open(file, upgraded);
    expect(retried.db.prepare('PRAGMA user_version').get()?.user_version).toBe(latestVersion + 1);
    expect(retried.list('projects')).toEqual([row]);
    expect(retried.events()).toEqual(events);
  },
);

it('leaves the database, its WAL and the backups alone when another connection holds the write lock', () => {
  const file = databaseFile();
  close(seed(file));
  const competitor = new DatabaseSync(file);
  try {
    competitor.exec('BEGIN IMMEDIATE');
    const other = { ...row, id: 'competing-project', name: 'Competing project' };
    competitor
      .prepare('INSERT INTO projects VALUES(?,?,?)')
      .run(other.id, other.revision, JSON.stringify(other));
    expect(() => open(file, upgraded)).toThrowError(
      expect.objectContaining({
        code: 'migration_failed',
        details: expect.objectContaining({ recovery: 'none' }),
      }),
    );
    expect(existsSync(file + '-wal')).toBe(true);
    expect(backups(file)).toEqual([]);
    competitor.exec('COMMIT');
    const reopened = open(file);
    expect(reopened.list('projects')).toEqual([row, other]);
    close(reopened);
  } finally {
    competitor.close();
  }
});

it('restores the backup by renaming a private copy over the database', () => {
  const file = databaseFile();
  close(seed(file));
  const inode = statSync(file).ino;
  expect(() =>
    open(file, [
      ...migrations,
      {
        version: latestVersion + 1,
        up(db: DatabaseSync) {
          db.exec(`COMMIT; PRAGMA user_version=${latestVersion + 1};`);
          throw new Error('Migration interrupted after commit');
        },
      },
    ]),
  ).toThrowError(
    expect.objectContaining({ details: expect.objectContaining({ recovery: 'backup' }) }),
  );
  expect(statSync(file).ino).not.toBe(inode);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(path.dirname(file)).sort()).toEqual(['control.sqlite', 'migration-backups']);
});

it.each([
  [latestVersion + 2, latestVersion + 1],
  [latestVersion + 1, latestVersion],
])(
  'refuses version %i with a build knowing version %i without writing DB or WAL bytes',
  (version, known) => {
    const file = databaseFile();
    const future = [
      ...upgraded,
      {
        version: latestVersion + 2,
        up: (db: DatabaseSync) => db.exec('CREATE TABLE future_data (value TEXT) STRICT;'),
      },
    ];
    const writer = open(file, future.slice(0, version));
    writer.insert('projects', row);
    const before = bytes(file);
    expect(() => open(file, future.slice(0, known))).toThrowError(
      expect.objectContaining({ code: 'schema_incompatible' }),
    );
    expect(bytes(file)).toEqual(before);
    expect(backups(file)).toEqual([]);
    close(writer);
    const closedBytes = bytes(file);
    expect(() => open(file, future.slice(0, known))).toThrowError(
      expect.objectContaining({ code: 'schema_incompatible' }),
    );
    expect(bytes(file)).toEqual(closedBytes);
  },
);

it('refuses a corrupt page before changing the database or making a migration backup', () => {
  const source = databaseFile();
  const previous = seed(source);
  const pageSize = Number(previous.db.prepare('PRAGMA page_size').get()?.page_size);
  const rootpage = Number(
    previous.db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='projects'").get()?.rootpage,
  );
  close(previous);
  const file = databaseFile();
  copyFileSync(source, file);
  const damaged = readFileSync(file);
  damaged.fill(0xff, (rootpage - 1) * pageSize, rootpage * pageSize);
  writeFileSync(file, damaged);
  expect(() => open(file, upgraded)).toThrowError(
    expect.objectContaining({ code: 'schema_corrupt' }),
  );
  expect(readFileSync(file)).toEqual(damaged);
  expect(existsSync(file + '-wal')).toBe(false);
  expect(backups(file)).toEqual([]);
});

it('keeps only the newest three migration backups after success and preserves unrelated files', () => {
  const file = databaseFile();
  close(seed(file));
  const directory = path.join(path.dirname(file), 'migration-backups');
  mkdirSync(directory, { mode: 0o700 });
  const historical = [100, 200, 300, 400].map((timestamp) =>
    path.join(directory, `control-v1-${timestamp}.sqlite`),
  );
  for (const name of historical) copyFileSync(file, name);
  const unrelated = path.join(directory, 'notes.txt');
  writeFileSync(unrelated, 'Keep this file');
  open(file, upgraded);
  expect(backups(file)).toHaveLength(3);
  expect(backups(file)).toContain(historical[2]);
  expect(backups(file)).toContain(historical[3]);
  expect(readFileSync(unrelated, 'utf8')).toBe('Keep this file');
});

it('does not prune previous migration backups when a migration fails', () => {
  const file = databaseFile();
  close(seed(file));
  const directory = path.join(path.dirname(file), 'migration-backups');
  mkdirSync(directory, { mode: 0o700 });
  for (const timestamp of [100, 200, 300])
    copyFileSync(file, path.join(directory, `control-v1-${timestamp}.sqlite`));
  expect(() =>
    open(file, [
      ...migrations,
      {
        version: latestVersion + 1,
        up: () => {
          throw new Error('Migration interrupted');
        },
      },
    ]),
  ).toThrowError(expect.objectContaining({ code: 'migration_failed' }));
  expect(backups(file)).toHaveLength(4);
});

it('initializes all known migrations on an empty database without making a backup', () => {
  const file = databaseFile();
  writeFileSync(file, '');
  const store = open(file);
  expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(latestVersion);
  expect(backups(file)).toEqual([]);
  expect(store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(
    migrations.map(({ version }) => ({ version })),
  );
});

it('creates the whole schema through known migrations in a memory and a file database', () => {
  const schema = [
    ...tables,
    'event_retention',
    'events',
    'inbox',
    'memory_search',
    'memory_search_config',
    'memory_search_content',
    'memory_search_data',
    'memory_search_docsize',
    'memory_search_idx',
    'outbox',
    'project_intros',
    'schema_migrations',
    'sqlite_sequence',
  ]
    .sort()
    .map((name) => ({ name }));
  const file = databaseFile();
  for (const store of [new Store(':memory:'), new Store(file)]) {
    openStores.push(store);
    expect(store.db.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual(
      { version: latestVersion },
    );
    expect(tableList(store.db)).toEqual(schema);
  }
});

it('keeps workflow names unique per project, allows one default and lets child step runs repeat by iteration', () => {
  const store = new Store(':memory:');
  openStores.push(store);
  const definition = { revision: 1, project_id: 'project', is_default: false };
  store.insert('workflow_definitions', {
    ...definition,
    id: 'default',
    name: 'Default',
    is_default: true,
  });
  store.insert('workflow_definitions', { ...definition, id: 'release', name: 'Release' });
  expect(() =>
    store.insert('workflow_definitions', { ...definition, id: 'duplicate', name: 'Release' }),
  ).toThrow();
  expect(() =>
    store.insert('workflow_definitions', {
      ...definition,
      id: 'default-again',
      name: 'Other',
      is_default: true,
    }),
  ).toThrow();
  const child = {
    revision: 1,
    lead_session_id: 'lead',
    task_id: 'export',
    generation: 1,
    slot: 'before_merge',
    step: { id: 'check' },
    parent_run_id: 'group',
    iteration: 1,
  };
  store.insert('workflow_step_runs', { ...child, id: 'first' });
  expect(() =>
    store.insert('workflow_step_runs', { ...child, id: 'second', iteration: 2 }),
  ).not.toThrow();
});

it('drops the stored role prompts of template agents and the app_debug group, keeping a custom agent its instructions', () => {
  const file = databaseFile();
  const previous = open(
    file,
    migrations.filter((migration) => migration.version <= 5),
  );
  const agent = { revision: 1, project_id: 'project', routines: [] };
  previous.insert('agents', {
    ...agent,
    id: 'assistant',
    template: 'assistant',
    instructions: 'The role prompt the template had when the agent was made.',
    tools: ['board', 'dispatch', 'app_debug', 'memory'],
  });
  previous.insert('agents', {
    ...agent,
    id: 'custom',
    template: 'custom',
    instructions: 'You keep the changelog current.',
  });
  const proposal = { revision: 1, project_id: 'project', session_id: 'assistant-session', at: 1 };
  previous.insert('agent_proposals', {
    ...proposal,
    id: 'new-ideas',
    state: 'pending',
    fields: { template: 'ideas', name: 'Ideas', instructions: 'Copied role prompt' },
  });
  previous.insert('agent_proposals', {
    ...proposal,
    id: 'change-assistant',
    agent_id: 'assistant',
    state: 'pending',
    fields: { instructions: 'Copied role prompt', tools: ['board', 'app_debug'] },
  });
  previous.insert('agent_proposals', {
    ...proposal,
    id: 'change-custom',
    agent_id: 'custom',
    state: 'pending',
    fields: { instructions: 'You keep the release notes current.' },
  });
  close(previous);

  const store = open(file);
  expect(store.must('agents', 'assistant')).toEqual({
    ...agent,
    id: 'assistant',
    template: 'assistant',
    tools: ['board', 'dispatch', 'memory'],
  });
  expect(store.must('agents', 'custom')).toMatchObject({
    instructions: 'You keep the changelog current.',
  });
  expect(store.must('agent_proposals', 'new-ideas')).toMatchObject({
    fields: { template: 'ideas', name: 'Ideas' },
  });
  expect(store.must('agent_proposals', 'new-ideas')).not.toHaveProperty('fields.instructions');
  expect(store.must('agent_proposals', 'change-assistant')).toMatchObject({
    fields: { tools: ['board'] },
  });
  expect(store.must('agent_proposals', 'change-assistant')).not.toHaveProperty(
    'fields.instructions',
  );
  expect(store.must('agent_proposals', 'change-custom')).toMatchObject({
    fields: { instructions: 'You keep the release notes current.' },
  });
});
