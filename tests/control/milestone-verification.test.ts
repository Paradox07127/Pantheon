import { afterEach, expect, it } from 'vitest';
import {
  id,
  type BoardPlan,
  type Milestone,
  type MilestoneVerification,
  type Principal,
  type ProjectRead,
  type WorkflowPolicy,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { commitmentHash } from '../../packages/control/dist/project-facts.js';
import { workflowPolicy } from '../../packages/control/dist/workflow-policy.js';
import { fixture, insertSession } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function opened() {
  const f = await fixture({ managedWorkspaces: true });
  fixtures.push(f);
  return f;
}

const leadOf = (f: Fixture): Principal => ({
  id: 'session:lead',
  role: 'lead',
  project_id: f.project.id,
  session_id: 'lead',
  expires_at: f.store.now() + 60_000,
});

/** A lead whose plan has the accepted report task api under milestone release. */
function readyLeadMilestone(f: Fixture): Milestone {
  insertSession(f, { id: 'lead', turn_count: 1 });
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: 'lead',
    input: 'Ship the export API this week.',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'api',
          title: 'API',
          goal: 'Serve exports',
          lane: 'core',
          depends_on: [],
          source: ['Ship the export API'],
          scope: [],
          acceptance: [],
          done_when: 'report',
          milestone: 'release',
        },
      ],
      milestones: [
        { id: 'release', title: 'Release', criteria: ['Exports download'], tasks: ['api'] },
      ],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f),
  );
  const plan = f.store.must<BoardPlan>('board_plans', 'lead');
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      accepted: { api: { at: f.store.now(), evidence: 'The report answers it', generation: 1 } },
    },
    plan.revision,
  );
  return f.store.list<Milestone>('milestones').find((row) => row.key === 'release')!;
}

function verification(
  f: Fixture,
  milestone: Milestone,
  fields: Partial<MilestoneVerification>,
): MilestoneVerification {
  return f.store.insert<MilestoneVerification>('milestone_verifications', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    milestone_id: milestone.id,
    commitment_hash: commitmentHash(
      milestone,
      [],
      f.store.get<BoardPlan>('board_plans', milestone.owner_session_id ?? ''),
    ),
    state: 'passed',
    commands: [],
    started_at: 1,
    ...fields,
  });
}

const viewOf = (f: Fixture, milestone: Milestone) =>
  f
    .call<ProjectRead>('project.read', { project_id: f.project.id })
    .milestones.find((view) => view.milestone.id === milestone.id)!;

it('shows the newest verification of the current commitment on a ready lead milestone', async () => {
  const f = await opened();
  const milestone = readyLeadMilestone(f);
  verification(f, milestone, { state: 'failed', started_at: 1, finished_at: 2 });
  const passed = verification(f, milestone, {
    state: 'passed',
    independence: 'other_vendor',
    runtime: 'codex',
    started_at: 3,
    finished_at: 4,
  });
  expect(viewOf(f, milestone)).toMatchObject({
    status: 'ready_for_acceptance',
    verification: {
      id: passed.id,
      state: 'passed',
      independence: 'other_vendor',
      runtime: 'codex',
      finished_at: 4,
      failed: [],
    },
  });
});

it('drops the verification once the task contract changes the commitment', async () => {
  const f = await opened();
  const milestone = readyLeadMilestone(f);
  verification(f, milestone, { state: 'passed' });
  const plan = f.store.must<BoardPlan>('board_plans', 'lead');
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      generations: { api: { generation: 2, contract: 'Serve exports and imports' } },
      accepted: { api: { at: f.store.now(), evidence: 'The report answers it', generation: 2 } },
    },
    plan.revision,
  );
  const view = viewOf(f, milestone);
  expect(view.status).toBe('ready_for_acceptance');
  expect(view).not.toHaveProperty('verification');
});

it('lists the failed commands of a failed verification with their output tails', async () => {
  const f = await opened();
  const milestone = readyLeadMilestone(f);
  verification(f, milestone, {
    state: 'failed',
    reason: 'A check failed',
    commands: [
      { name: 'build', exit_code: 0, output_tail: 'built', hidden: false },
      {
        name: 'test',
        exit_code: 1,
        output_tail: '1 test failed',
        hidden: false,
        failure_class: 'code',
      },
    ],
  });
  expect(viewOf(f, milestone).verification).toMatchObject({
    state: 'failed',
    reason: 'A check failed',
    failed: [{ name: 'test', output_tail: '1 test failed' }],
  });
});

it('never shows a verification on a milestone the user created', async () => {
  const f = await opened();
  const session = insertSession(f, { state: 'closed', outcome: 'merged' });
  const milestone = f.call<Milestone>('milestone.create', {
    project_id: f.project.id,
    title: 'Ship export',
    required_sessions: [session.id],
    criteria: ['Export works'],
  });
  f.store.insert<MilestoneVerification>('milestone_verifications', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    milestone_id: milestone.id,
    commitment_hash: commitmentHash(milestone, milestone.required_sessions),
    state: 'passed',
    commands: [],
    started_at: 1,
  });
  const view = viewOf(f, milestone);
  expect(view.status).toBe('ready_for_acceptance');
  expect(view).not.toHaveProperty('verification');
});

it('reads milestone verification off by default and stores the user turning it on', async () => {
  const f = await opened();
  const policy = () =>
    workflowPolicy((f.control as unknown as { ctx: ControlContext }).ctx, f.project.id)
      .milestone_verify;
  expect(policy()).toBe('off');
  f.call('workflow.policy.set', { project_id: f.project.id, milestone_verify: 'auto' }, null);
  expect(policy()).toBe('auto');
  expect(f.store.must<WorkflowPolicy>('workflow_policies', f.project.id).milestone_verify).toBe(
    'auto',
  );
});
