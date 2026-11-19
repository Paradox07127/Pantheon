import { expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  BoardPlan,
  LeadNote,
  LeadQuestion,
  Milestone,
  Principal,
  Project,
  Review,
  Session,
  TaskThreadEntry,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { awaitWorkspaceReady, eventually, insideSandbox, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const formatQuestion = 'Which format should the export use?';

/** A lead with a one-task plan and the task's worker running its first turn. */
async function runningWorker(f: Fixture) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Task a',
          goal: 'Finish task a',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/a'],
          acceptance: ['true'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['a'] },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  await f.control.tick();
  const worker = f.store.list<Session>('sessions').find((session) => session.task?.id === 'a')!;
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  const turn = f.turns(worker.id)[0]!;
  await eventually(
    () =>
      f.control.handles.has(turn.id) &&
      f.store.must<Session>('sessions', worker.id).state === 'running',
    () => f.control.tick(),
  );
  return { lead, worker, turn };
}

const eventIds = (f: Fixture, kind: string) =>
  f.store.kindEvents(f.project.id, [kind]).map((event) => event.event_id);

it.skipIf(insideSandbox)(
  'lists a lead message, a blocked report, a relayed question, its answer and a gate run of a task in order',
  async () => {
    const f = await workbenchFixture({ userConfig: true });
    const { lead, worker, turn } = await runningWorker(f);
    f.call(
      'task.message',
      { project_id: f.project.id, task_id: 'a', text: 'Keep the rows in file order' },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
    f.call(
      'task.report',
      {
        project_id: f.project.id,
        kind: 'blocked',
        reason: 'missing_context',
        text: 'The export format is undecided',
      },
      null,
      sessionOf(f, worker.id, 'worker'),
    );
    agentEvent(ctxOf(f), worker.id, {
      key: 'prompt-1',
      provider_sequence: 100,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: 'request-1',
      tool: 'AskUserQuestion',
      detail: {
        questions: [
          {
            question: formatQuestion,
            header: 'Format',
            options: [
              { label: 'CSV', description: 'Plain rows' },
              { label: 'JSON', description: 'Nested records' },
            ],
            multiSelect: false,
          },
        ],
      },
    } as AgentEvent);
    const question = f.store
      .must<BoardPlan>('board_plans', lead.id)
      .questions!.find((entry: LeadQuestion) => entry.source?.session_id === worker.id)!;
    f.call('lead.question.answer', {
      project_id: f.project.id,
      lead_session_id: lead.id,
      question_id: question.id,
      answer: 'CSV',
    });
    await f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
      },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    await f.call(
      'session.gates.run',
      { session_id: worker.id },
      f.store.must<Session>('sessions', worker.id).revision,
    );
    await eventually(
      () => eventIds(f, 'session.gate_checked').length > 0,
      () => f.control.tick(),
      10000,
    );

    const entries = f.control.taskThread(user, f.project.id, lead.id, 'a') as TaskThreadEntry[];
    expect(entries.map((entry) => entry.kind)).toEqual([
      'dispatched',
      'lead_message',
      'report',
      'question',
      'answer',
      'gate',
    ]);
    expect(entries.map((entry) => entry.event_id)).toEqual([
      ...eventIds(f, 'task.dispatched'),
      f.store
        .kindEvents(f.project.id, ['turn.queued'])
        .find((event) => (event.payload as { origin?: string }).origin === 'lead')!.event_id,
      ...eventIds(f, 'task.reported'),
      ...eventIds(f, 'lead.question_asked'),
      ...eventIds(f, 'lead.question_answered'),
      ...eventIds(f, 'session.gate_checked'),
    ]);
    expect(entries[0]).toMatchObject({ session_id: worker.id });
    expect(entries[1]!.text).toContain('Keep the rows in file order');
    expect(entries[2]).toMatchObject({
      session_id: worker.id,
      note_kind: 'blocked',
      text: 'The export format is undecided',
    });
    expect(entries[3]).toMatchObject({ question_id: question.id, text: formatQuestion });
    expect(entries[4]).toMatchObject({ question_id: question.id, text: 'CSV' });
    expect(entries[5]).toMatchObject({ session_id: worker.id, passed: true });
  },
);

it("lists a task's dispatch, gate commands, finding parts, answers, hand-back and merge", async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Task a',
          goal: 'Finish task a',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/a'],
          acceptance: ['true'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  const session = (id: string, fields: Partial<Session>) =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      state: 'open',
      turn_count: 0,
      ...fields,
    });
  const worker = session('a-worker', {
    workspace_id: f.store.must<Session>('sessions', lead.id).workspace_id,
    task: { lead_session_id: lead.id, id: 'a', generation: 1 },
  });
  session('a-reviewer', { review_id: 'a-review' });
  const review = f.store.insert<Review>('reviews', {
    id: 'a-review',
    revision: 1,
    project_id: f.project.id,
    session_id: worker.id,
    round: 1,
    runtimes: [f.adapter.name],
    state: 'running',
    findings: [],
    session_ids: ['a-reviewer'],
  });
  const plan = () => f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.event('task.dispatched', plan(), f.project.id, { task_id: 'a', session_id: worker.id });
  f.store.event('session.gate_checked', worker, f.project.id, {
    results: [
      { name: 'Tests', exit_code: 0 },
      { name: 'Lint', exit_code: 1 },
      { name: 'Docs', exit_code: null, state: 'skipped' },
    ],
  });
  f.store.event('review.finding_recorded', review, f.project.id, {
    id: 'finding',
    review_id: review.id,
    runtime: f.adapter.name,
    round: 1,
    location: 'src/a.ts:3',
    quote: 'rows.sort()',
    evidence: 'The rows are sorted',
    impact: 'Rows lose their file order',
    status: 'open',
    blocking: true,
  });
  const question: LeadQuestion = {
    id: 'format',
    at: f.store.now(),
    question: formatQuestion,
    options: ['CSV', 'JSON'],
    recommended: 'CSV',
    assumption: 'CSV',
    blocks: ['a'],
  };
  const leadAnswer = { text: 'JSON', at: f.store.now() };
  f.store.event('lead.question_asked', plan(), f.project.id, question);
  f.store.event('lead.question_answered', plan(), f.project.id, {
    ...question,
    answer: leadAnswer,
    answered_by: 'lead',
  });
  f.store.event('lead.question_overruled', plan(), f.project.id, {
    ...question,
    answer: { text: 'CSV', at: f.store.now(), overruled: leadAnswer },
    answered_by: 'user',
  });
  f.store.event('task.handed_back', plan(), f.project.id, {
    session_id: worker.id,
    task_id: 'a',
    reason: 'The rows lose their order',
  });
  f.store.event('session.merged', worker, f.project.id, { to_sha: 'abc' });

  const entries = f.control.taskThread(user, f.project.id, lead.id, 'a') as TaskThreadEntry[];
  expect(entries.map(({ event_id, at, note_kind, question_id, ...entry }) => entry)).toEqual([
    { kind: 'dispatched', session_id: worker.id, text: '' },
    {
      kind: 'gate',
      session_id: worker.id,
      text: 'Lint',
      passed: false,
      commands: [
        { name: 'Tests', passed: true },
        { name: 'Lint', passed: false },
      ],
    },
    {
      kind: 'finding',
      session_id: worker.id,
      text: 'src/a.ts:3: Rows lose their file order',
      location: 'src/a.ts:3',
      impact: 'Rows lose their file order',
      reviewer_session_id: 'a-reviewer',
      blocking: true,
    },
    { kind: 'question', text: formatQuestion },
    { kind: 'answer', text: 'JSON', answered_by: 'lead', overruled: false },
    { kind: 'answer', text: 'CSV', answered_by: 'user', overruled: true },
    { kind: 'handed_back', session_id: worker.id, text: 'The rows lose their order' },
    { kind: 'merged', session_id: worker.id, text: '' },
  ]);
});

it("lists a task session's blocked merge with its reason and the tracker's message to fix it", async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  const session = (id: string, fields: Partial<Session>) =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      state: 'open',
      turn_count: 0,
      ...fields,
    });
  const worker = session('a-worker', {
    task: { lead_session_id: lead.id, id: 'a', generation: 1 },
  });
  const other = session('b-worker', {
    task: { lead_session_id: lead.id, id: 'b', generation: 1 },
  });
  const turn = (id: string, session_id: string, input: string) => {
    const queued = { id, revision: 1, session_id, origin: 'tracker', input };
    f.store.event('turn.queued', queued, f.project.id, queued);
  };
  f.store.event('session.merge_blocked', worker, f.project.id, {
    state: 'blocked',
    reason: 'out_of_scope',
  });
  turn('fix-a', worker.id, 'Move the change back into src/a');
  f.store.event('session.merge_blocked', other, f.project.id, {
    state: 'blocked',
    reason: 'gate_failed',
  });
  turn('fix-b', other.id, 'Fix the failing gate');
  turn('lead-digest', lead.id, 'Task a is blocked');

  const entries = f.control.taskThread(user, f.project.id, lead.id, 'a') as TaskThreadEntry[];
  expect(entries.map(({ event_id, at, ...entry }) => entry)).toEqual([
    { kind: 'merge_blocked', session_id: worker.id, text: 'out_of_scope' },
    { kind: 'tracker_message', session_id: worker.id, text: 'Move the change back into src/a' },
  ]);
});

it("leaves the open Assistant one note of a milestone's new status without waking it", async () => {
  const f = await workbenchFixture();
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  const merged = f.store.insert<Session>('sessions', {
    id: 'merged-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: 'merged-workspace',
    state: 'closed',
    outcome: 'merged',
    turn_count: 0,
  });
  const milestone = f.call<Milestone>('milestone.create', {
    project_id: f.project.id,
    title: 'Ship export',
    required_sessions: [merged.id],
    criteria: ['Export works'],
  });
  f.call(
    'milestone.accept',
    { milestone_id: milestone.id, evidence_refs: [`session:${merged.id}`] },
    f.store.must<Milestone>('milestones', milestone.id).revision,
  );

  const notes = (f.store.get<BoardPlan>('board_plans', assistant.id)?.inbox ?? []).filter(
    (note: LeadNote) => note.kind === 'milestone',
  );
  expect(notes).toHaveLength(1);
  expect(notes[0]!.text).toBe('Milestone "Ship export" is now completed.');
  expect(f.turns(assistant.id)).toEqual([]);
});
