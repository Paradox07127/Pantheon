import { expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  BoardPlan,
  LeadNote,
  LeadQuestion,
  Milestone,
  Principal,
  Project,
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
      'lead_message',
      'report',
      'question',
      'answer',
      'gate',
    ]);
    expect(entries.map((entry) => entry.event_id)).toEqual([
      f.store
        .kindEvents(f.project.id, ['turn.queued'])
        .find((event) => (event.payload as { origin?: string }).origin === 'lead')!.event_id,
      ...eventIds(f, 'task.reported'),
      ...eventIds(f, 'lead.question_asked'),
      ...eventIds(f, 'lead.question_answered'),
      ...eventIds(f, 'session.gate_checked'),
    ]);
    expect(entries[0]!.text).toContain('Keep the rows in file order');
    expect(entries[1]).toMatchObject({
      session_id: worker.id,
      note_kind: 'blocked',
      text: 'The export format is undecided',
    });
    expect(entries[2]).toMatchObject({ question_id: question.id, text: formatQuestion });
    expect(entries[3]).toMatchObject({ question_id: question.id, text: 'CSV' });
    expect(entries[4]).toMatchObject({ session_id: worker.id, passed: true });
  },
);

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
