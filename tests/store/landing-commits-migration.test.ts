import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Store, migrations } from '@pantheon/store';

const roots: string[] = [];
const stores: InstanceType<typeof Store>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databaseFile() {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'landing-commits-migration-'));
  roots.push(root);
  return path.join(root, 'control.sqlite');
}

const record = (id: string, fields: object) => ({
  id,
  revision: 1,
  project_id: 'project',
  reason: null,
  ended_at: 300,
  gate_runs: 0,
  first_gate_passed: null,
  review_rounds: 0,
  turns: 0,
  input_tokens: 0,
  output_tokens: 0,
  wall_ms: null,
  ...fields,
});

it('records the tip each earlier merge and landing took as its landed commit', () => {
  const file = databaseFile();
  const before = new Store(file, () => 100, {
    migrations: migrations.filter((migration) => migration.version <= 21),
  });
  const session = { id: 'merged-session', revision: 1 };
  before.event('session.merged', session, 'project', { from_sha: 'base', to_sha: 'session-tip' });
  before.event('session.merged', session, 'project', { from_sha: 'same', to_sha: 'same' });
  before.insert('landings', {
    id: 'branch-landing',
    revision: 1,
    project_id: 'project',
    state: 'landed',
    from_sha: 'base',
    to_sha: 'branch-tip',
    finished_at: 200,
  });
  before.insert('landings', {
    id: 'blocked-landing',
    revision: 1,
    project_id: 'project',
    state: 'blocked',
    from_sha: 'base',
    finished_at: 200,
  });
  before.insert(
    'landing_records',
    record('branch-record', { branch: 'feature', state: 'landed', landed_sha: 'record-tip' }),
  );
  before.insert(
    'landing_records',
    record('session-record', {
      session_id: 'recorded-session',
      state: 'landed',
      landed_sha: 'recorded-tip',
    }),
  );
  before.insert(
    'landing_records',
    record('blocked-record', {
      session_id: 'recorded-session',
      state: 'blocked',
      landed_sha: null,
    }),
  );
  before.close();

  const store = new Store(file, () => 100);
  stores.push(store);
  expect(
    store
      .statement(
        'SELECT project_id, sha, session_id, landing_id, ended_at FROM landing_commits ORDER BY sha',
      )
      .all(),
  ).toEqual([
    {
      project_id: 'project',
      sha: 'branch-tip',
      session_id: null,
      landing_id: 'branch-landing',
      ended_at: 200,
    },
    {
      project_id: 'project',
      sha: 'record-tip',
      session_id: null,
      landing_id: 'branch-record',
      ended_at: 300,
    },
    {
      project_id: 'project',
      sha: 'recorded-tip',
      session_id: 'recorded-session',
      landing_id: null,
      ended_at: 300,
    },
    {
      project_id: 'project',
      sha: 'session-tip',
      session_id: 'merged-session',
      landing_id: null,
      ended_at: 100,
    },
  ]);
});
