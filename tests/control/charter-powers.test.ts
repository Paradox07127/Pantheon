import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  id,
  type AgentProfile,
  type BoardPlan,
  type CharterMode,
  type CharterPower,
  type ExternalEvent,
  type Milestone,
  type Principal,
  type Project,
  type Session,
  type WorkflowPolicy,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  receiveExternalEvent,
  tickExternalIntake,
} from '../../packages/control/dist/external-events.js';
import { awaitWorkspaceReady, eventually, fixture, insertSession, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Plain = Awaited<ReturnType<typeof fixture>>;
type Caller = Pick<Plain, 'call' | 'store' | 'project' | 'control'>;

const plains: Plain[] = [];
afterEach(async () => {
  for (const f of plains.splice(0)) await f.close();
});

async function plain() {
  const f = await fixture({ managedWorkspaces: true });
  plains.push(f);
  return f;
}

const MINUTE = 60_000,
  REQUEST = 'Ship the export API this week.',
  MERGE_REASON = 'The README names the new module';

/** What came of a lead's use of a power: applied at once, waiting for the user, or refused. */
interface Outcome {
  applied: boolean;
  waiting: boolean;
  recorded: boolean;
  refused?: string;
  reason?: string;
}

const leadOf = (f: Caller, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000_000,
});

function setCharter(f: Caller, power: CharterPower, mode: CharterMode) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, charter: { [power]: mode } },
    row?.revision ?? null,
  );
}

async function attempt(run: () => unknown): Promise<Pick<Outcome, 'refused' | 'reason'>> {
  try {
    await run();
    return {};
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return { refused: code, reason: message };
  }
}

const waiting = (f: Caller, kind: string) =>
  f.control.needsYou(user, f.project.id).items.some((item) => item.kind === kind);

const recorded = (f: Caller, power: CharterPower) =>
  f.store
    .kindEvents(f.project.id, ['charter.power_used'])
    .some((event) => (event.payload as { power: string }).power === power);

/** A lead named lead whose plan has task api under milestone release. */
function leadWithPlan(f: Plain): Principal {
  insertSession(f, { id: 'lead', turn_count: 1 });
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: 'lead',
    input: REQUEST,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  const lead = leadOf(f, 'lead');
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
    lead,
  );
  return lead;
}

function commit(repository: string, name: string, contents: string) {
  mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
}

const scenarios: Record<
  'plan_change' | 'accept_milestone' | 'merge_out_of_scope' | 'create_agent' | 'start_external',
  (mode: CharterMode) => Promise<Outcome>
> = {
  async plan_change(mode) {
    const f = await plain();
    f.call(
      'workflow.policy.set',
      { project_id: f.project.id, plan_changes: mode === 'on' ? 'auto' : 'confirm' },
      null,
    );
    const lead = leadWithPlan(f);
    const plan = () => f.store.must<BoardPlan>('board_plans', 'lead');
    const refusal = await attempt(() =>
      f.call(
        'board.plan.propose',
        {
          project_id: f.project.id,
          base_version: plan().plan_version,
          reason: 'The export needs a narrower contract',
          ops: [{ type: 'set_task', task_id: 'api', patch: { title: 'Export API' } }],
        },
        null,
        lead,
      ),
    );
    return {
      applied: plan().tasks[0]!.title === 'Export API',
      waiting: waiting(f, 'board.plan.proposal'),
      recorded: recorded(f, 'plan_change'),
      ...refusal,
    };
  },
  async accept_milestone(mode) {
    const f = await plain();
    setCharter(f, 'accept_milestone', mode);
    const lead = leadWithPlan(f);
    const plan = f.store.must<BoardPlan>('board_plans', 'lead');
    f.store.update<BoardPlan>(
      'board_plans',
      {
        ...plan,
        accepted: { api: { at: f.store.now(), evidence: 'The report answers it', generation: 1 } },
      },
      plan.revision,
    );
    const refusal = await attempt(() =>
      f.call(
        'milestone.accept',
        { milestone_id: 'release', evidence_refs: ['task:api'] },
        null,
        lead,
      ),
    );
    return {
      applied: !!f.store.list<Milestone>('milestones').find((row) => row.key === 'release')!
        .acceptance,
      waiting: waiting(f, 'milestone.ready_for_acceptance'),
      recorded: recorded(f, 'accept_milestone'),
      ...refusal,
    };
  },
  async merge_out_of_scope(mode) {
    const f = await workbenchFixture();
    git(f.source, 'config', 'user.name', 'Source User');
    git(f.source, 'config', 'user.email', 'source@example.invalid');
    setCharter(f, 'merge_out_of_scope', mode);
    const current = (sessionId: string) => f.store.must<Session>('sessions', sessionId);
    const lead = await f.create('Plan the export feature');
    await awaitWorkspaceReady(f.control, lead.workspace_id!);
    await eventually(
      () => f.turns(lead.id).every((turn) => turn.state === 'completed'),
      () => f.control.tick(),
    );
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: 0,
        headline: 'Export ships this week',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [
          {
            id: 'first',
            title: 'Task first',
            goal: 'Finish first',
            lane: 'core',
            depends_on: [],
            source: ['Plan the export feature'],
            scope: ['src/first'],
            acceptance: ['true'],
          },
        ],
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      leadOf(f, lead.id),
    );
    const session = await f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Build it',
      task_id: `${lead.id}:first`,
    });
    const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () =>
        f.turns(session.id).every((turn) => turn.state === 'completed') &&
        current(session.id).state === 'open',
      () => f.control.tick(),
    );
    commit(workspace.path, 'src/first/x.ts', 'export const x = 1;\n');
    commit(workspace.path, 'README.md', 'Names the first module\n');
    await f.call('session.merge', { session_id: session.id }, current(session.id).revision);
    await eventually(
      () => current(session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      10000,
    );
    const refusal = await attempt(() =>
      f.call(
        'session.merge',
        {
          project_id: f.project.id,
          task_id: 'first',
          allow_out_of_scope: true,
          reason: MERGE_REASON,
        },
        null,
        leadOf(f, lead.id),
      ),
    );
    return {
      applied: f.store
        .kindEvents(f.project.id, ['session.merge_started'])
        .some(
          (event) =>
            event.aggregate_id === session.id &&
            (event.payload as { reason?: string }).reason === MERGE_REASON,
        ),
      waiting: f.control
        .needsYou(user, f.project.id)
        .items.some(
          (item) => item.kind === 'session.merge_blocked' && item.source.id === session.id,
        ),
      recorded: recorded(f, 'merge_out_of_scope'),
      ...refusal,
    };
  },
  async create_agent(mode) {
    const f = await workbenchFixture();
    setCharter(f, 'create_agent', mode);
    const assistant = f.call<Session>('resident.open', {
      project_id: f.project.id,
      kind: 'assistant',
    });
    const refusal = await attempt(() =>
      f.call(
        'agent.propose',
        {
          project_id: f.project.id,
          template: 'ideas',
          name: 'Ideas',
          role: 'Ideas',
          instructions: 'Group the ideas by the screen they change.',
          brief: 'The user keeps dropping loose ideas into the main conversation.',
        },
        null,
        leadOf(f, assistant.id),
      ),
    );
    return {
      applied: f.store.list<AgentProfile>('agents').some((agent) => agent.name === 'Ideas'),
      waiting: waiting(f, 'agent.proposal'),
      recorded: recorded(f, 'create_agent'),
      ...refusal,
    };
  },
  async start_external(mode) {
    const f = await workbenchFixture({
        externalSources: [{ id: 'stub', poll: async () => MINUTE }],
      }),
      ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    if (mode !== 'off')
      f.call(
        'project.externalEvents.set',
        { project_id: f.project.id, mode: mode === 'on' ? 'auto' : 'approve' },
        f.store.must<Project>('projects', f.project.id).revision,
      );
    const event = receiveExternalEvent(ctx, {
      project_id: f.project.id,
      source: 'github',
      subject_key: 'github:acme/reports#12',
      dedup_key: 'github:acme/reports#12:assigned:501',
      kind: 'issue_assigned',
      actor: 'taylor',
      actor_trust: 'self',
      title: 'Totals are wrong',
      url: 'https://github.com/acme/reports/issues/12',
      texts: [{ author: 'taylor', own: true, text: 'The weekly total counts refunds twice.' }],
    });
    f.store.update<ExternalEvent>(
      'external_events',
      { ...event, received_at: event.received_at - 3 * MINUTE },
      event.revision,
    );
    tickExternalIntake(ctx);
    const held = waiting(f, 'external.approval');
    return {
      applied:
        !held &&
        f.store.list<ExternalEvent>('external_events').every((each) => each.state === 'handled'),
      waiting: held,
      recorded: recorded(f, 'start_external'),
    };
  },
};

const MILESTONE_CARD = 'The user accepts milestone release on the milestone card';

type Row = Outcome & { power: keyof typeof scenarios; mode: CharterMode };

it.each<Row>([
  { power: 'plan_change', mode: 'on', applied: true, waiting: false, recorded: true },
  { power: 'plan_change', mode: 'ask', applied: false, waiting: true, recorded: true },
  { power: 'accept_milestone', mode: 'on', applied: true, waiting: false, recorded: true },
  {
    power: 'accept_milestone',
    mode: 'ask',
    applied: false,
    waiting: true,
    recorded: false,
    refused: 'permission_denied',
    reason: MILESTONE_CARD,
  },
  {
    power: 'accept_milestone',
    mode: 'off',
    applied: false,
    waiting: true,
    recorded: false,
    refused: 'permission_denied',
    reason: MILESTONE_CARD,
  },
  { power: 'merge_out_of_scope', mode: 'on', applied: true, waiting: false, recorded: true },
  {
    power: 'merge_out_of_scope',
    mode: 'ask',
    applied: false,
    waiting: true,
    recorded: false,
    refused: 'permission_denied',
    reason: 'The user merges the files outside the scope of task first',
  },
  {
    power: 'merge_out_of_scope',
    mode: 'off',
    applied: false,
    waiting: true,
    recorded: false,
    refused: 'permission_denied',
    reason: "The project's charter does not let a lead merge files outside a task's scope",
  },
  { power: 'create_agent', mode: 'ask', applied: false, waiting: true, recorded: true },
  {
    power: 'create_agent',
    mode: 'off',
    applied: false,
    waiting: false,
    recorded: false,
    refused: 'permission_denied',
    reason: "The project's charter does not let a lead propose agents",
  },
  { power: 'start_external', mode: 'on', applied: true, waiting: false, recorded: false },
  { power: 'start_external', mode: 'ask', applied: false, waiting: true, recorded: false },
  { power: 'start_external', mode: 'off', applied: false, waiting: false, recorded: false },
])(
  "with $power set to $mode, the lead's use is applied: $applied, waits for the user: $waiting, refused: $refused",
  async ({ power, mode, reason, ...expected }) => {
    const { reason: said, ...outcome } = await scenarios[power](mode);
    expect(outcome).toEqual(expected);
    if (reason) expect(said).toContain(reason);
  },
);
