import { afterEach, expect, it } from 'vitest';
import type { BoardPlan, Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { deviceLoads, dispatchQueue } from '../../packages/control/dist/task-dispatch.js';
import { fixture } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const count = 200;

/** A lead plan of `count` tasks, each with one open task session, and a counter of reads of the sessions' task field. */
async function history() {
  const f = await fixture();
  cleanups.push(() => f.close());
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const plan = {
    id: 'lead',
    revision: 1,
    project_id: f.project.id,
    tasks: Array.from({ length: count }, (_, index) => ({ id: `task-${index}` })),
  } as unknown as BoardPlan;
  const sessions = Array.from({ length: count }, (_, index): Session => ({
    id: `session-${index}`,
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: `workspace-${index}`,
    state: 'open',
    turn_count: 0,
    task: { lead_session_id: plan.id, id: `task-${index}` },
  }));
  let reads = 0;
  const counted = (session: Session) =>
    new Proxy(session, {
      get(target, key, receiver) {
        if (key === 'task') reads++;
        return Reflect.get(target, key, receiver);
      },
    });
  return { f, ctx, plan, sessions, counted, reads: () => reads };
}

it('reads each session a bounded number of times for device loads however many tasks the plans have', async () => {
  const { ctx, plan, sessions, counted, reads } = await history();
  const loads = deviceLoads(ctx, {
    plans: [plan],
    busy: new Set(),
    sessions: sessions.map(counted),
  });
  expect(loads.get('local')?.sessions).toBe(count);
  expect(reads()).toBeLessThan(count * 20);
});

it('reads no session for the dispatch queue of a project with no requested task', async () => {
  const { f, ctx, plan, sessions, counted, reads } = await history();
  f.store.insert<BoardPlan>('board_plans', plan);
  for (const session of sessions) f.store.insert<Session>('sessions', session);
  const list = ctx.store.list.bind(ctx.store);
  ctx.store.list = ((table: Parameters<typeof list>[0]) => {
    const rows = list(table);
    return table === 'sessions' ? (rows as Session[]).map(counted) : rows;
  }) as typeof ctx.store.list;
  expect(dispatchQueue(ctx, f.project.id)).toEqual([]);
  expect(reads()).toBe(0);
});
