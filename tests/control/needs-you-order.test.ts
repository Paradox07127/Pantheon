import { expect, it } from 'vitest';
import { hash, type BoardPlan, type Principal, type Project, type Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const patch = (f: Fixture, sessionId: string, fields: Partial<Session>) => {
  const session = current(f, sessionId);
  return f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
};
const patchPlan = (f: Fixture, leadId: string, fields: Partial<BoardPlan>) => {
  const plan = f.store.must<BoardPlan>('board_plans', leadId);
  return f.store.update<BoardPlan>('board_plans', { ...plan, ...fields }, plan.revision);
};

async function idleSession(f: Fixture, input?: string) {
  const session = await f.create(input);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return current(f, session.id);
}

/** Gives the idle lead a plan of the tasks, each in one lane with its own directory. */
function planTasks(f: Fixture, leadId: string, tasks: { id: string; depends_on: string[] }[]) {
  const lead: Principal = {
    id: `session:${leadId}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: leadId,
    expires_at: f.store.now() + 60000,
  };
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: tasks.map((task) => ({
        ...task,
        title: `Export part ${task.id}`,
        goal: `Export part ${task.id}`,
        lane: 'core',
        source: ['Plan the export feature'],
        scope: [`src/${task.id}`],
        acceptance: ['pnpm test'],
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    lead,
  );
}

it.each([
  [1, 'other'],
  [2, 'repeated_failure'],
] as const)('types a failed gate after %i handbacks as %s', async (handbacks, decision) => {
  const f = await workbenchFixture();
  const lead = await idleSession(f, 'Plan the export feature'),
    worker = await idleSession(f);
  planTasks(f, lead.id, [{ id: 'a', depends_on: [] }]);
  patch(f, worker.id, { task: { lead_session_id: lead.id, id: 'a', generation: 1 } });
  patchPlan(f, lead.id, { handed_back: { [worker.id]: Array(handbacks).fill('gate_failed') } });
  // A closed lead hands the failed gate to the user.
  patch(f, lead.id, { state: 'closed' });
  await f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Check', argv: [process.execPath, '-e', 'process.exit(1)'] }],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const session = current(f, worker.id);
  f.store.event('session.gate_checked', session, session.project_id, {
    workspace_id: session.workspace_id,
    commit: 'a'.repeat(40),
    check_spec_hash: hash([
      ...(Object.values(f.store.must<Project>('projects', f.project.id).gates ?? {})[0] ?? []),
      { name: 'pnpm test', argv: ['/bin/sh', '-c', 'pnpm test'] },
    ]),
    results: [
      { name: 'Check', argv: ['node'], exit_code: 1, duration_ms: 5, timed_out: false, output: '' },
    ],
  });

  expect(
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.source.id === worker.id)
      .map((item) => [item.kind, item.decision]),
  ).toEqual([['session.gate_failed', decision]]);
});
