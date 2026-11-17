import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type { BoardPlan, BoardPlanView, Principal, Project, Session } from '@pantheon/domain';
import { fixture, registerWorkspace, user } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

function failure(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

async function setup() {
  const f = await fixture({ adapter: new FixtureAdapter(100), managedWorkspaces: true });
  cleanups.push(() => f.close());
  return f;
}

function leadOf(f: Fixture): Principal {
  const workspace = registerWorkspace(f.control, {
    project_id: f.project.id,
    kind: 'linked_worktree',
    source: f.store.must<Project>('projects', f.project.id).roots[0]!,
    base_ref: 'HEAD',
  });
  const lead = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
  });
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    input: 'Ship the export API and a download button this week.',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  return {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60000,
  };
}

function plan(headline = 'Export ships this week') {
  return {
    headline,
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'api',
        title: 'API',
        goal: 'Serve exports',
        lane: 'core',
        milestone: 'm1',
        depends_on: [],
        source: ['Ship the export API'],
        scope: ['packages/export'],
        acceptance: ['pnpm test'],
      },
    ],
    milestones: [{ id: 'm1', title: 'Export', criteria: ['Exports download'], tasks: ['api'] }],
    risks: [],
    assumptions: [],
  };
}

const update = (f: Fixture, lead: Principal, baseVersion: number, value = plan()) =>
  f.call<BoardPlanView & { plan_version: number }>(
    'board.plan.update',
    { project_id: f.project.id, base_version: baseVersion, ...value },
    null,
    lead,
  );

const edit = (f: Fixture, principal: Principal, lead: Principal, baseVersion: number) =>
  f.call<{ plan_version: number }>(
    'board.plan.edit',
    {
      project_id: f.project.id,
      ...(principal.role === 'user' ? { lead_session_id: lead.session_id } : {}),
      base_version: baseVersion,
      ops: [{ type: 'set_task', task_id: 'api', patch: { model: 'claude-opus-4-5' } }],
    },
    null,
    principal,
  );

const planOf = (f: Fixture, lead: Principal) =>
  f.store.must<BoardPlan>('board_plans', lead.session_id!);

it('refuses a plan write based on an older version and names the current one', async () => {
  const f = await setup();
  const lead = leadOf(f);
  update(f, lead, 0);
  update(f, lead, 1, plan('Export ships next week'));
  expect(planOf(f, lead).plan_version).toBe(2);
  for (const write of [
    () => update(f, lead, 1),
    () => edit(f, lead, lead, 1),
    () => edit(f, user, lead, 0),
  ]) {
    const error = failure(write);
    expect(error.code).toBe('revision_conflict');
    expect(error.message).toContain('version 2');
  }
  expect(planOf(f, lead).headline).toBe('Export ships next week');
});

it('raises the plan version only when the plan content changes', async () => {
  const f = await setup();
  const lead = leadOf(f);
  expect(update(f, lead, 0).plan_version).toBe(1);
  expect(update(f, lead, 1).plan_version).toBe(1);
  expect(edit(f, lead, lead, 1).plan_version).toBe(2);
  expect(edit(f, lead, lead, 2).plan_version).toBe(2);
  const tasks = [{ ...plan().tasks[0]!, model: 'claude-opus-4-5' }];
  expect(update(f, lead, 2, { ...plan(), tasks }).plan_version).toBe(2);
  const milestones = [{ ...plan().milestones[0]!, criteria: ['Exports download as CSV'] }];
  expect(update(f, lead, 2, { ...plan(), tasks, milestones }).plan_version).toBe(3);
  const read = f.call<{ plans: { lead_session_id: string; plan_version: number }[] }>(
    'project.read',
    { project_id: f.project.id },
    null,
    lead,
  );
  expect(read.plans.find((view) => view.lead_session_id === lead.session_id)?.plan_version).toBe(3);
});

it('refuses a user edit based on the plan before the lead rewrote it', async () => {
  const f = await setup();
  const lead = leadOf(f);
  update(f, lead, 0);
  const seen = planOf(f, lead).plan_version;
  update(f, lead, seen, plan('Export ships next week'));
  expect(failure(() => edit(f, user, lead, seen)).code).toBe('revision_conflict');
  const after = planOf(f, lead);
  expect(after.headline).toBe('Export ships next week');
  expect(after.tasks[0]!.model).toBeUndefined();
  expect(after.inbox).toEqual([]);
});
