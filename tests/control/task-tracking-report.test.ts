import { expect, it, vi } from 'vitest';
import type { Approval, BoardPlan, Principal, Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { doneReported } from '../../packages/control/dist/task-tracking.js';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
const principal = (f: Fixture, id: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${id}`,
  role,
  session_id: id,
  project_id: f.project.id,
  expires_at: Date.now() + 60000,
});

async function reportTask() {
  const f = await workbenchFixture({ delay: 1 });
  const lead = await f.create('Plan the export');
  await settle(f, lead);
  f.store.insert<BoardPlan>('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Ship export',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'export',
        title: 'Export the report',
        goal: 'Export the report',
        lane: 'core',
        depends_on: [],
        source: ['Plan the export'],
        scope: ['.'],
        acceptance: ['true'],
        path: 'dispatch',
        done_when: 'report',
        kind: { tier: 't2', domain: 'backend-logic' },
      },
    ],
    risks: [],
    assumptions: [],
    plan_version: 1,
    pending_edits: [],
    inbox: [],
    notified: {},
    updated_at: Date.now(),
  });
  return { f, lead };
}

/** Opens the report task in the user's own folder instead of a worktree. */
async function inPlaceReportSession(f: Fixture, leadId: string) {
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    task_id: `${leadId}:export`,
    workspace: 'in_place',
    input: 'Write the report',
  });
  await settle(f, session);
  return session;
}

it('lets a report task session in the user folder file its done report for acceptance', async () => {
  const { f, lead } = await reportTask();
  const session = await inPlaceReportSession(f, lead.id);
  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'The export is ready' },
    null,
    principal(f, session.id, 'worker'),
  );
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  expect(doneReported(f.control as unknown as ControlContext, plan, 'export')).toBe(true);
});

it('tells the lead when a report task session in the user folder waits for a permission', async () => {
  const { f, lead } = await reportTask();
  const session = await inPlaceReportSession(f, lead.id);
  f.store.insert<Approval>('approvals', {
    id: 'folder-request',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: session.id,
    request_id: 'folder-request',
    tool: 'Bash',
    input_hash: 'a'.repeat(64),
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  });
  await f.control.tick();
  expect(f.store.must<BoardPlan>('board_plans', lead.id).notified).toEqual({
    [session.id]: 'waiting',
  });
});

it('reads no reporter of reports for other tasks', async () => {
  const { f, lead } = await reportTask();
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  for (let index = 0; index < 20; index++)
    f.store.event('task.reported', plan, f.project.id, {
      at: Date.now(),
      session_id: lead.id,
      task_id: 'other',
      kind: 'done',
      text: 'Another task is done',
      generation: 1,
    });
  const get = vi.spyOn(f.store, 'get');
  expect(doneReported(f.control as unknown as ControlContext, plan, 'export')).toBe(false);
  expect(get.mock.calls.filter(([table]) => table === 'sessions')).toEqual([]);
});
