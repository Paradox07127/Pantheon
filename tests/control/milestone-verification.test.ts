import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import {
  id,
  type AgentEvent,
  type AgentEventSink,
  type BoardPlan,
  type LeadNote,
  type Milestone,
  type MilestoneVerification,
  type Principal,
  type Project,
  type ProjectRead,
  type Review,
  type Session,
  type SessionHandle,
  type SessionSpec,
  type UserTurn,
  type WorkflowPolicy,
  type Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { commitmentHash } from '../../packages/control/dist/project-facts.js';
import { workflowPolicy } from '../../packages/control/dist/workflow-policy.js';
import {
  awaitWorkspaceReady,
  eventually,
  fixture,
  gateFolder,
  insertSession,
  insideSandbox,
  user,
} from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

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
      started_at: 3,
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
    reason_code: 'checks_failed',
    commands: [
      { name: 'build', exit_code: 0, output_tail: 'built', hidden: false },
      {
        name: 'test',
        exit_code: 1,
        output_tail: '1 test failed',
        hidden: false,
        failure_class: 'code',
      },
      { name: 'hidden-check', exit_code: 0, output_tail: 'checked', hidden: true },
    ],
  });
  expect(viewOf(f, milestone).verification).toMatchObject({
    state: 'failed',
    reason: 'A check failed',
    reason_code: 'checks_failed',
    failed: [{ name: 'test', output_tail: '1 test failed' }],
    commands: [
      { name: 'build', exit_code: 0 },
      { name: 'test', exit_code: 1 },
      { name: 'hidden-check', exit_code: 0 },
    ],
  });
  expect(viewOf(f, milestone).verification!.commands[0]).not.toHaveProperty('output_tail');
  expect(viewOf(f, milestone).verification!.commands[2]).toEqual({
    name: 'hidden-check',
    exit_code: 0,
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

const leadAccept = (f: Fixture, extra: Record<string, unknown> = {}) =>
  f.call<Milestone>(
    'milestone.accept',
    { milestone_id: 'release', evidence_refs: ['task:api'], ...extra },
    null,
    leadOf(f),
  );

it.each(['failed', 'inconclusive', 'running'] as const)(
  'refuses a lead acceptance over a %s verification that gives no override reason',
  async (state) => {
    const f = await opened();
    const milestone = readyLeadMilestone(f);
    verification(f, milestone, { state });
    expect(() => leadAccept(f)).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        message: expect.stringMatching(new RegExp(`verification .*is ${state}.*override_reason`)),
      }),
    );
    expect(f.store.must<Milestone>('milestones', milestone.id)).not.toHaveProperty('acceptance');
  },
);

it.each<[string, MilestoneVerification['state'] | undefined, 'lead' | 'user', string | undefined]>([
  ['a lead with a reason over a failed verification', 'failed', 'lead', 'The clone has no network'],
  ['a lead over a passed verification', 'passed', 'lead', undefined],
  ['a lead while verification is off', undefined, 'lead', undefined],
  ['the user over a failed verification', 'failed', 'user', undefined],
])('accepts for %s', async (_, state, by, reason) => {
  const f = await opened();
  const milestone = readyLeadMilestone(f);
  const row = state && verification(f, milestone, { state });
  const accepted =
    by === 'lead'
      ? leadAccept(f, reason ? { override_reason: reason } : {})
      : f.call<Milestone>(
          'milestone.accept',
          { milestone_id: milestone.id, evidence_refs: ['task:api'] },
          f.store.must<Milestone>('milestones', milestone.id).revision,
        );
  const { acceptance } = f.store.must<Milestone>('milestones', accepted.id);
  if (reason)
    expect(acceptance?.override).toEqual({ reason, verification_id: row!.id, state: 'failed' });
  else expect(acceptance).not.toHaveProperty('override');
  expect(viewOf(f, milestone).status).toBe('completed');
});

it('lists a lead acceptance over a failed verification with its reason among the decisions made for the user', async () => {
  const f = await opened();
  const milestone = readyLeadMilestone(f);
  const row = verification(f, milestone, { state: 'failed' });
  leadAccept(f, { override_reason: 'The failing check needs a network the clone lacks' });
  expect(f.control.decisionsForUser(user, f.project.id).items).toContainEqual(
    expect.objectContaining({
      kind: 'power_used',
      power: 'accept_milestone',
      subject: milestone.id,
      reason: 'The failing check needs a network the clone lacks',
      verification: { id: row.id, state: 'failed' },
    }),
  );
});

it('asks the user nothing more than the acceptance of a milestone whose verification failed', async () => {
  const f = await opened();
  const milestone = readyLeadMilestone(f);
  verification(f, milestone, { state: 'failed' });
  expect(
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.source?.id === milestone.id)
      .map((item) => item.reason),
  ).toEqual(['milestone_ready_for_acceptance']);
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

/** A reviewer whose turn stays open until the test ends it. */
class HeldReviewer extends FixtureAdapter {
  starts: { emit: AgentEventSink; handle: SessionHandle; turn?: UserTurn }[] = [];
  sequence = 1;
  constructor() {
    super();
    this.name = 'cross-reviewer';
  }
  override async start(spec: SessionSpec, emit: AgentEventSink) {
    const handle = await super.start(spec, emit);
    this.starts.push({ emit, handle });
    return handle;
  }
  override async send(handle: SessionHandle, turn: UserTurn) {
    this.starts.find((entry) => entry.handle === handle)!.turn = turn;
    return { turn_id: turn.turn_id, status: 'delivered' as const };
  }
  emit(event: Record<string, unknown>) {
    const entry = this.starts[0]!;
    entry.emit({
      key: String(++this.sequence),
      provider_sequence: this.sequence,
      turn_id: entry.turn!.turn_id,
      ...event,
    } as AgentEvent);
  }
}

type Workbench = Awaited<ReturnType<typeof workbenchFixture>>;

/**
 * A lead milestone whose one task merged a commit on main, with a project gate and a task
 * acceptance that print the directory they run in, and a reviewer runtime besides the writer's.
 */
async function mergedMilestone(
  options: {
    acceptance?: string[];
    gate?: (dir: string) => string;
    gateTimeoutMs?: number;
    policy?: 'off' | 'auto';
  } = {},
) {
  const f = await workbenchFixture();
  const reviewer = new HeldReviewer();
  f.control.adapters.set(reviewer.name, reviewer);
  const gate = gateFolder(f.root);
  await f.call(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [
        {
          name: 'Gate',
          argv: gate.argv(options.gate?.(gate.dir) ?? 'console.log(process.cwd())'),
          ...(options.gateTimeoutMs ? { timeout_ms: options.gateTimeoutMs } : {}),
        },
      ],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const lead = await f.create('Ship the export API this week.');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () =>
      f.turns(lead.id)[0]?.state === 'completed' &&
      f.store.must<Session>('sessions', lead.id).state === 'open',
    () => f.control.tick(),
  );
  const principal: Principal = {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60_000,
  };
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
          scope: ['export.txt'],
          acceptance: options.acceptance ?? ['pwd'],
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
    principal,
  );
  const base = git(f.source, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.source, 'export.txt'), 'exported rows\n');
  git(f.source, 'add', 'export.txt');
  git(f.source, 'commit', '--quiet', '-m', 'Serve exports');
  const head = git(f.source, 'rev-parse', 'HEAD');
  const workspace = f.store.insert<Workspace>('workspaces', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    kind: 'linked_worktree',
    path: path.join(f.root, 'managed', 'merged-api'),
    source: f.source,
    source_branch: 'main',
    base_sha: base,
    owner: 'none',
    ownership_epoch: 0,
    removed_at: f.store.now(),
  });
  f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'closed',
    outcome: 'merged',
    turn_count: 1,
    task: { lead_session_id: lead.id, id: 'api', generation: 1 },
  });
  if (options.policy !== 'off')
    f.call('workflow.policy.set', { project_id: f.project.id, milestone_verify: 'auto' }, null);
  const milestone = f.store.list<Milestone>('milestones').find((row) => row.key === 'release')!;
  return { f, reviewer, gate, lead, milestone, head };
}
type Merged = Awaited<ReturnType<typeof mergedMilestone>>;

const rowsOf = (f: Workbench) => f.store.list<MilestoneVerification>('milestone_verifications');

async function ended(f: Workbench) {
  await eventually(
    () => rowsOf(f).some((row) => row.state !== 'running'),
    () => f.control.tick(),
    20000,
  );
  return rowsOf(f)[0]!;
}

/** Ticks until the checks passed and the verifier's turn reached the reviewer. */
async function reviewing({ f, reviewer }: Merged) {
  await eventually(
    () => reviewer.starts[0]?.turn !== undefined,
    () => f.control.tick(),
    20000,
  );
  const row = rowsOf(f)[0]!;
  return { row, review: f.store.must<Review>('reviews', row.review_id!) };
}

function endReview(
  { f, reviewer }: Merged,
  review: Review,
  verdict?: { verdict: 'pass' | 'fail'; summary: string },
) {
  reviewer.emit({ kind: 'message.delta', text: 'Checked the export against the criteria.' });
  if (verdict)
    f.call('review.verdict', verdict, null, {
      id: `session:${review.session_ids[0]}`,
      role: 'reviewer',
      session_id: review.session_ids[0],
      project_id: f.project.id,
      expires_at: f.store.now() + 60_000,
    });
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
}

const reviewNotes = (f: Workbench) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => (event.payload as { kind: string }).kind.startsWith('review_'));

const verifiedNotes = (f: Workbench) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === 'milestone_verified');

const FIX_LINE = 'Propose fix tasks under this milestone with propose_board, citing this evidence.';

it('starts no verification of a ready lead milestone while verification is off', async () => {
  const { f, milestone } = await mergedMilestone({ policy: 'off' });
  for (let tick = 0; tick < 3; tick++) await f.control.tick();
  expect(
    f
      .call<ProjectRead>('project.read', { project_id: f.project.id })
      .milestones.find((view) => view.milestone.id === milestone.id)?.status,
  ).toBe('ready_for_acceptance');
  expect(rowsOf(f)).toEqual([]);
});

it.skipIf(insideSandbox)(
  'reruns the gate and the acceptance in a fresh clone of the merged head, then passes on the pass verdict of another runtime',
  async () => {
    const setup = await mergedMilestone();
    const { f, lead, milestone, head } = setup;
    const { row, review } = await reviewing(setup);
    expect(row).toMatchObject({
      milestone_id: milestone.id,
      state: 'running',
      runtime: 'cross-reviewer',
      independence: 'other_runtime',
      commits: [{ source: f.source, commit: head }],
      commands: [
        { name: 'Gate', exit_code: 0, hidden: false },
        { name: 'pwd', exit_code: 0, hidden: false },
      ],
    });
    for (const command of row.commands) {
      expect(command.output_tail).toContain(`${path.sep}.gates${path.sep}pantheon-gate-`);
      expect(command.output_tail).not.toContain(f.source);
    }
    expect(review).toMatchObject({
      runtimes: ['cross-reviewer'],
      requester: { lead_session_id: lead.id, milestone_id: milestone.id },
    });
    const input = setup.reviewer.starts[0]!.turn!.input;
    expect(input).toContain('Exports download');
    expect(input).toContain('Goal: Serve exports');
    expect(input).toContain('+exported rows');

    endReview(setup, review, { verdict: 'pass', summary: 'Exports download in the clone' });
    const settled = await ended(f);
    expect(settled).toMatchObject({
      state: 'passed',
      independence: 'other_runtime',
      verdict: { verdict: 'pass', summary: 'Exports download in the clone' },
    });
    expect(settled).not.toHaveProperty('reason_code');
    expect(settled.finished_at).toBeTypeOf('number');
    expect(
      f.store.kindEvents(f.project.id, ['milestone.verified']).map((event) => event.payload),
    ).toEqual([settled]);
    expect(reviewNotes(f)).toEqual([]);
    const notes = verifiedNotes(f);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain('passed');
    expect(notes[0]!.text).toContain('Exports download in the clone');
    expect(notes[0]!.text).not.toContain(FIX_LINE);
  },
);

it.skipIf(insideSandbox)(
  'tells the lead of a failed verification with the failed command and its output, and wakes it',
  async () => {
    const command = "printf 'rows %s\\n' missing; exit 3";
    const { f, lead } = await mergedMilestone({ acceptance: [command] });
    await ended(f);
    const notes = verifiedNotes(f);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain('failed');
    expect(notes[0]!.text).toContain(command);
    expect(notes[0]!.text).toContain('rows missing');
    expect(notes[0]!.text).toContain(FIX_LINE);
    await eventually(
      () => f.turns(lead.id).some((turn) => turn.input.includes('<note kind="milestone_verified"')),
      () => f.control.tick(),
    );
  },
);

it.skipIf(insideSandbox)(
  "runs the user's hidden checks after the acceptance and tells the lead only their names, results and last lines",
  async () => {
    const command = 'echo private-check-marker >/dev/null; seq 1 9; exit 4';
    const { f } = await mergedMilestone();
    f.call('milestone.checks.set', {
      project_id: f.project.id,
      checks: [
        { name: 'Restart keeps exports', command: 'echo restarted' },
        { name: 'Export survives a crash', command },
      ],
    });
    const row = await ended(f);
    expect(row).toMatchObject({
      state: 'failed',
      reason_code: 'checks_failed',
      commands: [
        { name: 'Gate', exit_code: 0, hidden: false },
        { name: 'pwd', exit_code: 0, hidden: false },
        { name: 'Restart keeps exports', exit_code: 0, hidden: true },
        { name: 'Export survives a crash', exit_code: 4, hidden: true },
      ],
    });
    expect(row.commands[3]!.output_tail.trim().split('\n')).toEqual(['5', '6', '7', '8', '9']);
    const text = verifiedNotes(f)[0]!.text;
    expect(text).toContain('Failed: Export survives a crash (exit 4)');
    expect(text).toContain('9');
    expect(text).not.toContain('private-check-marker');
    expect(text).not.toContain('seq 1 9');
    expect(text).not.toMatch(/^1$/m);
  },
);

it.skipIf(insideSandbox)(
  'fails the verification on a failing acceptance command and starts no review',
  async () => {
    const { f, reviewer } = await mergedMilestone({ acceptance: ['echo broken export; exit 3'] });
    const row = await ended(f);
    expect(row).toMatchObject({
      state: 'failed',
      commands: [
        { name: 'Gate', exit_code: 0 },
        {
          name: 'echo broken export; exit 3',
          exit_code: 3,
          failure_class: 'code',
          output_tail: expect.stringContaining('broken export'),
        },
      ],
    });
    expect(row).not.toHaveProperty('review_id');
    expect(f.store.list<Review>('reviews')).toEqual([]);
    expect(reviewer.starts).toEqual([]);
  },
);

it.skipIf(insideSandbox)('starts no second verification of the same commitment', async () => {
  const { f } = await mergedMilestone({ acceptance: ['exit 3'] });
  await ended(f);
  for (let tick = 0; tick < 3; tick++) await f.control.tick();
  expect(rowsOf(f)).toHaveLength(1);
});

it
  .skipIf(insideSandbox)
  .each<
    [
      string,
      Parameters<typeof mergedMilestone>[0],
      ((setup: Merged) => Promise<void>) | undefined,
      Pick<MilestoneVerification, 'state' | 'reason_code'>,
    ]
  >([
    [
      'a failing check',
      { acceptance: ['exit 3'] },
      undefined,
      { state: 'failed', reason_code: 'checks_failed' },
    ],
    [
      'a check that timed out',
      { gate: () => 'setTimeout(() => {}, 10000)', gateTimeoutMs: 200 },
      undefined,
      { state: 'inconclusive', reason_code: 'checks_environment' },
    ],
    [
      'no runtime that can verify',
      {},
      async ({ f }) => {
        f.control.adapters.clear();
      },
      { state: 'inconclusive', reason_code: 'no_verifier_runtime' },
    ],
    [
      'a fail verdict',
      {},
      async (setup) => {
        const { review } = await reviewing(setup);
        endReview(setup, review, { verdict: 'fail', summary: 'Exports return no rows' });
      },
      { state: 'failed', reason_code: 'verifier_failed' },
    ],
    [
      'a verifier that ended with no finding and no reply',
      {},
      async (setup) => {
        await reviewing(setup);
        setup.reviewer.emit({ kind: 'turn.completed', status: 'completed' });
      },
      { state: 'inconclusive', reason_code: 'review_incomplete' },
    ],
    [
      'a verifier that handed in no verdict',
      {},
      async (setup) => {
        const { review } = await reviewing(setup);
        endReview(setup, review);
      },
      { state: 'inconclusive', reason_code: 'no_verdict' },
    ],
  ])('records why the verification ended on %s', async (_, options, drive, expected) => {
  const setup = await mergedMilestone(options);
  await drive?.(setup);
  expect(await ended(setup.f)).toMatchObject(expected);
  expect(
    setup.f
      .call<ProjectRead>('project.read', { project_id: setup.f.project.id })
      .milestones.find((view) => view.milestone.id === setup.milestone.id)?.verification,
  ).toMatchObject({ reason_code: expected.reason_code });
});

it.skipIf(insideSandbox)(
  'ends the verification inconclusive when the verifier hands in no verdict',
  async () => {
    const setup = await mergedMilestone();
    const { review } = await reviewing(setup);
    endReview(setup, review);
    const row = await ended(setup.f);
    expect(row).toMatchObject({ state: 'inconclusive', review_id: review.id });
    expect(row).not.toHaveProperty('verdict');
    expect(reviewNotes(setup.f)).toEqual([]);
  },
);

it.skipIf(insideSandbox)(
  'ends a verification whose checks were running at a restart inconclusive',
  async () => {
    // The gate waits for the release file, and ends on its own after 8 s.
    const setup = await mergedMilestone({
      gate: (dir) =>
        `const fs=require('node:fs');const end=Date.now()+8000;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(dir, 'release'))})||Date.now()>end)clearInterval(t)},20)`,
    });
    const { f } = setup;
    // The restart leaves the old control's check running; it must end before the store closes.
    const { completions } = (f.control as unknown as { ctx: ControlContext }).ctx;
    const earlier = new Set(completions);
    await eventually(
      () => rowsOf(f).length === 1,
      () => f.control.tick(),
    );
    const checking = [...completions].filter((completion) => !earlier.has(completion));
    await f.restart();
    expect(rowsOf(f)).toMatchObject([
      { state: 'inconclusive', reason: 'daemon_restart', reason_code: 'daemon_restart' },
    ]);
    writeFileSync(path.join(setup.gate.dir, 'release'), '');
    await Promise.allSettled(checking);
  },
);
