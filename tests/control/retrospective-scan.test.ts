import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import type { BoardPlan, Retrospective, Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { recordRetrospectives } from '../../packages/control/dist/retrospective.js';
import { fixture } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

/** A lead plan of one task with one open task session. */
async function oneTask() {
  const f = await fixture();
  fixtures.push(f);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const session = (id: string, extra: Partial<Session> = {}) =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      workspace_id: `workspace-${id}`,
      state: 'open',
      turn_count: 0,
      ...extra,
    });
  session('lead');
  const worker = session('worker', { task: { lead_session_id: 'lead', id: 'a', generation: 1 } });
  f.store.insert<BoardPlan>('board_plans', {
    id: 'lead',
    revision: 1,
    project_id: f.project.id,
    headline: 'One task',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'a',
        title: 'Task a',
        goal: 'Finish a',
        lane: 'core',
        depends_on: [],
        source: ['Do a'],
        scope: ['src/a'],
        acceptance: ['true'],
      },
    ],
    plan_version: 1,
    pending_edits: [],
    risks: [],
    assumptions: [],
    inbox: [],
    notified: {},
    updated_at: f.store.now(),
  });
  const scan = () => ctx.store.transaction(() => recordRetrospectives(ctx));
  const recorded = () => f.store.list<Retrospective>('retrospectives').map((row) => row.outcome);
  return { f, ctx, worker, scan, recorded };
}

const mergedData = (session: Session) =>
  JSON.stringify({
    ...session,
    revision: session.revision + 1,
    state: 'closed',
    outcome: 'merged',
  });

it('records a task that this connection finished after a scan found nothing to record', async () => {
  const { f, worker, scan, recorded } = await oneTask();
  scan();
  scan();
  expect(recorded()).toEqual([]);
  f.store.update<Session>('sessions', { ...worker, state: 'closed', outcome: 'merged' }, 1);
  scan();
  expect(recorded()).toEqual(['merged']);
});

it('records a task that another connection finished after a scan found nothing to record', async () => {
  const { f, worker, scan, recorded } = await oneTask();
  scan();
  expect(recorded()).toEqual([]);
  const other = new DatabaseSync(path.join(f.root, 'state/control.sqlite'));
  other
    .prepare('UPDATE sessions SET revision=revision+1, data=? WHERE id=?')
    .run(mergedData(worker), worker.id);
  other.close();
  scan();
  expect(recorded()).toEqual(['merged']);
});

it('scans again after the tick that scanned rolled back a change made before the scan', async () => {
  const { f, ctx, worker, recorded } = await oneTask();
  f.store.update<Session>('sessions', { ...worker, state: 'closed', outcome: 'merged' }, 1);
  const { db } = ctx.store,
    prepare = db.prepare.bind(db),
    list = ctx.store.list.bind(ctx.store);
  let armed = false;
  // In the tick, the task is reopened just before the scan and the transaction then fails.
  db.prepare = (sql: string) => {
    if (sql.includes('total_changes()') && !armed) {
      armed = true;
      prepare('UPDATE sessions SET revision=revision+1, data=? WHERE id=?').run(
        JSON.stringify({ ...f.store.must<Session>('sessions', worker.id), state: 'open' }),
        worker.id,
      );
    }
    return prepare(sql);
  };
  ctx.store.list = ((table) => {
    if (table === 'improvements' && armed) throw new Error('tick failed after the scan');
    return list(table);
  }) as typeof ctx.store.list;
  await expect(f.control.tick()).rejects.toThrow('tick failed after the scan');
  db.prepare = prepare;
  ctx.store.list = list;
  expect(f.store.must<Session>('sessions', worker.id).outcome).toBe('merged');
  ctx.store.transaction(() => recordRetrospectives(ctx));
  expect(recorded()).toEqual(['merged']);
});
