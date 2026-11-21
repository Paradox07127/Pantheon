import { expect, it, vi } from 'vitest';
import type { BoardPlan, Principal, Session, SessionTurn } from '@pantheon/domain';
import { eventually, settle } from '../helpers.js';
import { boundTaskSession, dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const principal = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000,
});

const part = (name: string, scope: string) => ({
  title: `Part ${name}`,
  goal: `Write part ${name}`,
  scope: [scope],
  acceptance: [`test -d ${scope}`],
});

const BRIEF =
  'Users export reports weekly. toCsv() in src/export.ts reads rows before the filter applies; keep the CSV header as it is.';

const exportTask = (fields: Partial<PlanTask> = {}): PlanTask => ({
  id: 'export',
  title: 'Filtered export',
  goal: 'Exports keep the table filter',
  lane: 'core',
  milestone: 'ship',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: ['src'],
  acceptance: ['true'],
  path: 'parallel',
  flow_reason: 'Two independent parts',
  parallel: [part('reader', 'src/reader'), part('writer', 'src/writer')],
  ...fields,
});

function writePlan(f: Fixture, leadId: string, task: PlanTask, baseVersion = 0) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: baseVersion,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        task,
        {
          id: 'docs',
          title: 'Export docs',
          goal: 'Document the export',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['docs/export.md'],
          acceptance: ['true'],
        },
      ],
      milestones: [
        {
          id: 'ship',
          title: 'Export ships',
          criteria: ['A filtered table exports only its rows'],
          tasks: ['export'],
        },
      ],
      risks: [],
      assumptions: [],
    },
    null,
    principal(f, leadId, 'lead'),
  );
}

/** A lead whose parallel task runs in two settled part sessions, part 1 first. */
async function startedParts(task = exportTask()) {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, task);
  const docs = await boundTaskSession(f, lead.id, 'docs');
  await settle(f, docs);
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['export'] },
    null,
    principal(f, lead.id, 'lead'),
  );
  await f.control.tick();
  const parts = f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === lead.id && session.task.id === 'export')
    .sort((a, b) => a.task!.parallel_index! - b.task!.parallel_index!);
  expect(parts).toHaveLength(2);
  for (const session of parts) await settle(f, session);
  return { f, lead, parts };
}

const firstInput = (f: Fixture, sessionId: string) =>
  f.store.list<SessionTurn>('session_turns').find((turn) => turn.session_id === sessionId)!.input;

it('starts each part session with the whole brief of its part from the plan', async () => {
  const { f, parts } = await startedParts(exportTask({ brief: BRIEF }));
  const input = firstInput(f, parts[1]!.id);
  for (const text of [
    'Part writer\n\nTask export of the plan "Export ships this week", lane "Core".',
    "This is part 2 of 2 of task export. The other parts run in their own sessions at the same time: Part reader. Stay inside your part's scope.",
    'Goal:\nWrite part writer',
    BRIEF,
    'The user\'s words (verbatim):\n- "Plan the export feature"',
    'Scope (the paths you may change):\n- src/writer',
    '- test -d src/writer',
    'Done when: this worktree merges after its gates pass. Commit your work and end your turn.',
    'Running beside you, in other worktrees:\n- docs "Export docs": docs/export.md',
    'Read the code and tests the goal names before you change anything.',
  ])
    expect(input).toContain(text);
  expect(input).not.toContain('- src/reader');
});

it.each([
  { selector: {}, target: 1 },
  { selector: { part: 1 }, target: 0 },
  { selector: { part: 2 }, target: 1 },
  { selector: 'first session', target: 0 },
] as const)(
  'sends a lead message with $selector to the chosen part',
  async ({ selector, target }) => {
    const { f, lead, parts } = await startedParts();
    const before = parts.map((session) => f.turns(session.id).length);
    f.call(
      'task.message',
      {
        project_id: f.project.id,
        task_id: 'export',
        text: 'Keep the header row',
        ...(selector === 'first session' ? { part: parts[0]!.id } : selector),
      },
      null,
      principal(f, lead.id, 'lead'),
    );
    expect(parts.map((session) => f.turns(session.id).length)).toEqual(
      before.map((count, index) => count + (index === target ? 1 : 0)),
    );
  },
);

it.each([
  { selector: {}, target: 0 },
  { selector: { part: 2 }, target: 1 },
  { selector: 'second session', target: 1 },
] as const)(
  'interrupts the running turn of the part $selector names',
  async ({ selector, target }) => {
    const { f, lead, parts } = await startedParts();
    for (const session of parts)
      f.call<SessionTurn>(
        'session.send',
        { session_id: session.id, input: `fixture-script\n${JSON.stringify([{ hang: true }])}` },
        f.store.must<Session>('sessions', session.id).revision,
      );
    await eventually(
      () =>
        parts.every((session) => f.store.must<Session>('sessions', session.id).state === 'running'),
      () => f.control.tick(),
    );
    const interrupted = f.call<{ session_id: string }>(
      'task.interrupt',
      {
        project_id: f.project.id,
        task_id: 'export',
        ...(selector === 'second session' ? { part: parts[1]!.id } : selector),
      },
      null,
      principal(f, lead.id, 'lead'),
    );
    expect(interrupted.session_id).toBe(parts[target]!.id);
  },
);

it('refuses a part the task does not have', async () => {
  const { f, lead } = await startedParts();
  expect(() =>
    f.call(
      'task.message',
      { project_id: f.project.id, task_id: 'export', text: 'Go on', part: 3 },
      null,
      principal(f, lead.id, 'lead'),
    ),
  ).toThrow(expect.objectContaining({ code: 'not_found' }));
});

it('sends each part its own changed contract', async () => {
  const { f, lead, parts } = await startedParts();
  const send = vi.spyOn(f.adapter, 'send');
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  writePlan(
    f,
    lead.id,
    exportTask({ parallel: [part('reader', 'src/reader'), part('csv writer', 'src/csv')] }),
    plan.plan_version,
  );
  f.call(
    'task.message',
    { project_id: f.project.id, task_id: 'export', text: 'Go on' },
    null,
    principal(f, lead.id, 'lead'),
  );
  await settle(f, parts[1]!);
  const input = send.mock.calls.find(([handle]) => handle.platform_session_id === parts[1]!.id)![1]
    .input;
  expect(input).toContain(
    '[Pantheon] The lead changed this task. It now reads:\nTitle: Part csv writer',
  );
  expect(input).toContain('Goal: Write part csv writer');
  expect(input).toContain('Scope (the paths you may change):\n- src/csv');
  expect(input).not.toContain('Goal: Exports keep the table filter');
});

it('takes a long done report only for a report task', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(
    f,
    lead.id,
    exportTask({
      path: undefined,
      flow_reason: undefined,
      parallel: undefined,
      brief: BRIEF,
      done_when: 'report',
      scope: [],
      acceptance: [],
    }),
  );
  const research = await boundTaskSession(f, lead.id, 'export'),
    docs = await boundTaskSession(f, lead.id, 'docs');
  for (const session of [research, docs]) await settle(f, session);
  // A done report reads the worktree first, so it settles after the call returns.
  const report = async (sessionId: string, kind = 'done') =>
    f.call(
      'task.report',
      { project_id: f.project.id, kind, text: 'm'.repeat(4000) },
      null,
      principal(f, sessionId, 'worker'),
    );
  await report(research.id);
  expect(
    f.store.kindEvents(f.project.id, ['task.reported']).map((event) => event.payload),
  ).toContainEqual(expect.objectContaining({ kind: 'done', text: 'm'.repeat(4000) }));
  for (const [sessionId, kind] of [
    [docs.id, 'done'],
    [research.id, 'risk'],
  ])
    await expect(report(sessionId!, kind)).rejects.toMatchObject({ code: 'invalid_input' });
});
