import { expect, it } from 'vitest';
import type {
  BoardPlan,
  Principal,
  Project,
  ProjectRead,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { autoMergeAfterTurn } from '../../packages/control/dist/workbench-session.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { eventually, settle, user } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const planOf = (f: Fixture, id: string) => f.store.must<BoardPlan>('board_plans', id);
const principal = (f: Fixture, session: Session, role: 'lead' | 'worker'): Principal => ({
  id: `session:${session.id}`,
  role,
  session_id: session.id,
  project_id: f.project.id,
  expires_at: f.store.now() + 60_000,
});
async function planned(f: Fixture, direct = false) {
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  const owner = principal(f, lead, 'lead');
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export files',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: ['format', 'button'].map((id) => ({
        id,
        title: id,
        goal: 'Export files',
        lane: 'core',
        depends_on: [],
        source: ['Plan the export feature'],
        scope: [`src/${id}`],
        acceptance: ['pnpm test'],
        path: direct ? 'direct' : 'dispatch',
        ...(direct ? { flow_reason: 'The lead can implement this task directly.' } : {}),
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    owner,
  );
  return { lead, owner };
}
const question = {
  question: 'Which export format?',
  options: ['CSV', 'JSON'],
  recommended: 'CSV',
  assumption: 'Build the download button while the format is undecided.',
  blocks: ['format'],
};
const ask = (f: Fixture, owner: Principal) =>
  f.call<{ id: string }>('lead.ask', { project_id: f.project.id, ...question }, null, owner);

it('posts a question without ending the lead turn, waits only on named tasks, and delivers its answer', async () => {
  const f = workbenchFixture();
  const { lead, owner } = await planned(f);
  const running = f.call<SessionTurn>(
    'session.send',
    {
      session_id: lead.id,
      input: `fixture-script\n${JSON.stringify([{ hang: true }])}`,
    },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', running.id).state === 'running',
    () => f.control.tick(),
  );
  const before = f.turns(lead.id);
  const card = ask(f, owner);
  expect(f.turns(lead.id)).toEqual(before);
  expect(f.store.must<SessionTurn>('session_turns', running.id).state).toBe('running');
  const plan = planOf(f, lead.id);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      headline: 'Export files safely',
      lanes: plan.lanes,
      tasks: plan.tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    owner,
  );
  expect(f.control.needsYou(user, f.project.id).items).toContainEqual(
    expect.objectContaining({
      kind: 'lead.question',
      reason: 'lead_question',
      session_id: lead.id,
      question: expect.objectContaining({ id: card.id, ...question }),
      actions: [{ command: 'lead.question.answer', allowed: true }],
    }),
  );
  f.call('task.start', { project_id: f.project.id, task_ids: ['format', 'button'] }, null, owner);
  await f.control.tick();
  const view = (f.control.projectRead(owner, f.project.id) as ProjectRead).plans[0]!;
  expect(view.tasks.find((task) => task.id === 'format')).toMatchObject({
    dispatch_wait: 'answer',
    session_ids: [],
  });
  expect(view.tasks.find((task) => task.id === 'button')!.session_ids).toHaveLength(1);
  expect(() =>
    f.call(
      'lead.question.answer',
      {
        project_id: f.project.id,
        lead_session_id: lead.id,
        question_id: card.id,
        answer: 'JSON',
      },
      null,
      owner,
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  f.call('lead.question.answer', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    question_id: card.id,
    answer: 'JSON',
  });
  expect(
    f.control
      .needsYou(user, f.project.id)
      .items.some((item) => String(item.kind) === 'lead.question'),
  ).toBe(false);
  const wake = f.turns(lead.id).find((turn) => turn.origin === 'tracker')!;
  expect(wake.input).toContain('Which export format?');
  expect(wake.input).toContain('JSON');
  expect(wake.input).toContain('- answer: Question: Which export format?');
  expect(f.store.kindEvents(f.project.id, ['lead.note_added']).at(-1)!.payload).toMatchObject({
    kind: 'answer',
    question_id: card.id,
    answer: 'JSON',
  });
  await f.control.tick();
  expect(f.store.list<Session>('sessions').some((s) => s.task?.id === 'format')).toBe(true);
  const directFixture = workbenchFixture();
  const { owner: directOwner } = await planned(directFixture, true);
  const schema = inputSchemas['lead.ask'];
  for (const options of [['CSV'], ['a', 'b', 'c', 'd', 'e']])
    expect(
      schema.safeParse({ project_id: directFixture.project.id, ...question, options }).success,
    ).toBe(false);
  expect(() =>
    directFixture.call(
      'lead.ask',
      { project_id: directFixture.project.id, ...question, recommended: 'XML' },
      null,
      directOwner,
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  ask(directFixture, directOwner);
  expect(() =>
    directFixture.call(
      'task.start',
      { project_id: directFixture.project.id, task_ids: ['format'] },
      null,
      directOwner,
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(
    directFixture.call(
      'task.start',
      { project_id: directFixture.project.id, task_ids: ['button'] },
      null,
      directOwner,
    ),
  ).toMatchObject({ claimed: 'button' });
});

it.each([
  'missing_context',
  'missing_permission',
  'environment_problem',
  'conflicting_requirements',
])(
  'delivers a blocked report for %s and waits without automatic merge or handbacks',
  async (reason) => {
    const f = workbenchFixture();
    const { lead } = await planned(f);
    const worker = boundTaskSession(f, lead.id, 'format');
    await settle(f, worker);
    const turns = f.turns(worker.id).length;
    f.call(
      'task.report',
      {
        project_id: f.project.id,
        kind: 'blocked',
        reason,
        text: 'Need a decision before proceeding.',
      },
      null,
      principal(f, worker, 'worker'),
    );
    expect(f.turns(lead.id).find((turn) => turn.origin === 'tracker')!.input).toContain(reason);
    const note = f.store.kindEvents(f.project.id, ['task.reported']).at(-1)!.payload;
    expect(note).toMatchObject({
      kind: 'blocked',
      reason,
      text: 'Need a decision before proceeding.',
    });
    const project = f.store.must<Project>('projects', f.project.id);
    f.store.update(
      'projects',
      {
        ...project,
        auto_merge: true,
        gates: {
          [f.source]: [{ name: 'Check', argv: [process.execPath, '-e', 'process.exit(0)'] }],
        },
      },
      project.revision,
    );
    autoMergeAfterTurn(
      f.control as unknown as ControlContext,
      worker.id,
      f.turns(worker.id).at(-1)!.id,
    );
    expect(
      f.store.kindEvents(f.project.id, [
        'session.merge_skipped',
        'session.merge_started',
        'session.gate_checked',
      ]),
    ).toEqual([]);
    const idle = current(f, worker.id);
    f.store.event('session.merge_started', idle, f.project.id, { auto: true });
    f.store.update(
      'sessions',
      { ...idle, merge: { state: 'blocked' as const, reason: 'gate_failed' } },
      idle.revision,
    );
    await f.control.tick();
    await f.control.tick();
    expect(f.turns(worker.id)).toHaveLength(turns);
    expect(planOf(f, lead.id).handed_back ?? {}).toEqual({});
    f.call(
      'task.message',
      {
        project_id: f.project.id,
        task_id: 'format',
        text: 'The missing decision is available; continue.',
      },
      null,
      principal(f, lead, 'lead'),
    );
    expect(f.turns(worker.id)).toHaveLength(turns + 1);
  },
);

it('keeps a blocked report in needs-you when its lead has closed', async () => {
  const f = workbenchFixture();
  const { lead } = await planned(f);
  const worker = boundTaskSession(f, lead.id, 'format');
  await settle(f, worker);
  const idle = current(f, lead.id);
  f.store.update('sessions', { ...idle, state: 'closed' as const }, idle.revision);
  f.call(
    'task.report',
    {
      project_id: f.project.id,
      kind: 'blocked',
      reason: 'missing_permission',
      text: 'Need repository access.',
    },
    null,
    principal(f, worker, 'worker'),
  );
  expect(f.control.needsYou(user, f.project.id).items).toContainEqual(
    expect.objectContaining({
      reason: 'task_blocked',
      task_id: `${lead.id}:format`,
      blocked: expect.objectContaining({
        reason: 'missing_permission',
        text: 'Need repository access.',
      }),
    }),
  );
  expect(planOf(f, lead.id).inbox).toContainEqual(
    expect.objectContaining({ kind: 'blocked', reason: 'missing_permission' }),
  );
});

it.each(['done', 'done_with_concerns'])(
  'preserves the done report status %s in the lead note and event',
  async (status) => {
    const f = workbenchFixture();
    const { lead } = await planned(f);
    const worker = boundTaskSession(f, lead.id, 'format');
    await settle(f, worker);
    f.call(
      'task.report',
      {
        project_id: f.project.id,
        kind: 'done',
        status,
        text: 'Implementation finished; review the format.',
      },
      null,
      principal(f, worker, 'worker'),
    );
    expect(
      f.store.kindEvents(f.project.id, ['lead.note_added']).map((event) => event.payload),
    ).toContainEqual(expect.objectContaining({ kind: 'done', status }));
    expect(f.store.kindEvents(f.project.id, ['task.reported']).at(-1)!.payload).toMatchObject({
      kind: 'done',
      status,
    });
  },
);
