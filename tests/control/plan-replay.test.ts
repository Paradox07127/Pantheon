import { expect, it } from 'vitest';
import type { BoardPlan, Session } from '@pantheon/domain';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

function writePlan(f: Fixture, leadId: string, taskIds: string[]) {
  const version = f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0;
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: version,
      headline: `Export plan ${version + 1}`,
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: taskIds.map((id) => ({
        id,
        title: id,
        depends_on: [],
        goal: id,
        lane: 'core',
        source: ['Plan the export feature'],
        scope: [`src/${id}`],
        acceptance: ['pnpm test'],
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    {
      id: `session:${leadId}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: leadId,
      expires_at: f.store.now() + 60000,
    },
  );
}

function dispatch(f: Fixture, leadId: string, taskId: string, ids: string[]) {
  const lead = f.store.must<Session>('sessions', leadId);
  const workers = ids.map((id) =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      workspace_id: lead.workspace_id,
      state: 'open',
      turn_count: 0,
      task: { lead_session_id: leadId, id: taskId, generation: 1 },
    }),
  );
  f.store.event('task.dispatched', lead, f.project.id, {
    task_id: taskId,
    session_id: ids[0],
    ...(ids.length > 1 ? { session_ids: ids } : {}),
  });
  return workers;
}

const merge = (f: Fixture, worker: Session) =>
  f.store.event('session.merged', worker, f.project.id, { to_sha: 'abc' });

async function replayedPlan() {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  const other = await f.create('Plan the import feature');
  writePlan(f, lead.id, ['exports']);
  writePlan(f, other.id, ['imports']);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.event('lead.question_asked', plan, f.project.id, {
    id: 'format',
    at: f.store.now(),
    question: 'Which file format?',
    options: ['CSV', 'JSON'],
    recommended: 'CSV',
    assumption: 'CSV',
    blocks: [],
  });
  const [one, two] = dispatch(f, lead.id, 'exports', ['exports-part-one', 'exports-part-two']);
  dispatch(f, other.id, 'imports', ['imports-worker']);
  merge(f, one!);
  writePlan(f, lead.id, ['exports', 'docs']);
  merge(f, two!);
  f.store.event('milestone.accepted', { id: 'ship', revision: 1 }, f.project.id, {
    id: 'ship',
    title: 'Export ships',
    owner_session_id: lead.id,
  });
  return { f, lead };
}

it('replays the lead plan in sequence with the task statuses each event left', async () => {
  const { f, lead } = await replayedPlan();
  const replay = f.control.planReplay(user, lead.id, 0, 100);
  const sequences = replay.frames.map((frame) => frame.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(replay.next_after).toBeNull();
  expect(
    replay.frames.map((frame) => [
      frame.kind,
      frame.text ?? frame.task_id,
      frame.tasks.map((task) => `${task.id}:${task.status}`),
    ]),
  ).toEqual([
    ['board.plan_updated', 'Export plan 1', ['exports:planned']],
    ['lead.question_asked', 'Which file format?', ['exports:planned']],
    ['task.dispatched', 'exports', ['exports:dispatched']],
    ['session.merged', 'exports', ['exports:dispatched']],
    ['board.plan_updated', 'Export plan 2', ['exports:dispatched', 'docs:planned']],
    ['session.merged', 'exports', ['exports:merged', 'docs:planned']],
    ['milestone.accepted', 'Export ships', ['exports:merged', 'docs:planned']],
  ]);
});

it('gives each frame the task set of the plan update it follows', async () => {
  const { f, lead } = await replayedPlan();
  const updates = f.store
    .kindEvents(f.project.id, ['board.plan_updated'])
    .filter((event) => event.aggregate_id === lead.id);
  for (const frame of f.control.planReplay(user, lead.id, 0, 100).frames) {
    const plan = updates.findLast((event) => event.sequence <= frame.sequence)!
      .payload as BoardPlan;
    expect(frame.tasks.map((task) => task.id)).toEqual(plan.tasks.map((task) => task.id));
  }
});

it('pages the replay by sequence', async () => {
  const { f, lead } = await replayedPlan();
  const whole = f.control.planReplay(user, lead.id, 0, 100).frames;
  const first = f.control.planReplay(user, lead.id, 0, 3);
  expect(first.frames).toEqual(whole.slice(0, 3));
  expect(first.next_after).toBe(whole[2]!.sequence);
  const rest = f.control.planReplay(user, lead.id, first.next_after!, 100);
  expect(rest).toEqual({
    frames: whole.slice(3),
    next_after: null,
    total: whole.length,
    last_at: whole.at(-1)!.at,
  });
});

it('pages back from a sequence and counts every frame of the plan on each page', async () => {
  const { f, lead } = await replayedPlan();
  const whole = f.control.planReplay(user, lead.id, 0, 100).frames;
  const page = f.control.planReplay(user, lead.id, 0, 2, whole[5]!.sequence);
  expect(page).toEqual({
    frames: whole.slice(3, 5),
    next_after: whole[4]!.sequence,
    total: 7,
    last_at: whole[6]!.at,
  });
  expect(f.control.planReplay(user, lead.id, 0, 2, whole[1]!.sequence)).toMatchObject({
    frames: whole.slice(0, 1),
  });
});

it('marks a re-plan, the decision on a proposal and the session of a dispatch and a merge', async () => {
  const { f, lead } = await replayedPlan();
  let plan = f.store.must<BoardPlan>('board_plans', lead.id);
  const fired = f.store.event('board.replan_triggered', plan, f.project.id, {
    milestone_id: 'milestone-row',
    trigger: { type: 'handbacks', count: 2 },
    task_id: 'exports',
    generation: 1,
    value: 2,
  });
  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      trigger_event: fired.event_id,
      ops: [{ type: 'set_task', task_id: 'docs', patch: { title: 'Docs v2' } }],
    },
    null,
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60000,
    },
  );
  plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.event('board.plan_proposal_resolved', plan, f.project.id, {
    proposal_id: 'split',
    ops: [],
    reason: 'Split the exports',
    base_version: plan.plan_version,
    created_at: f.store.now(),
    status: 'rejected',
  });
  const frames = f.control.planReplay(user, lead.id, 0, 100).frames;
  expect(
    frames.map(({ kind, text, task_id, session_id, replan, decision }) => ({
      kind,
      text,
      task_id,
      session_id,
      replan,
      decision,
    })),
  ).toEqual([
    expect.objectContaining({ kind: 'board.plan_updated', replan: undefined }),
    expect.objectContaining({ kind: 'lead.question_asked' }),
    expect.objectContaining({ kind: 'task.dispatched', session_id: 'exports-part-one' }),
    expect.objectContaining({ kind: 'session.merged', session_id: 'exports-part-one' }),
    expect.objectContaining({ kind: 'board.plan_updated', replan: undefined }),
    expect.objectContaining({ kind: 'session.merged', session_id: 'exports-part-two' }),
    expect.objectContaining({ kind: 'milestone.accepted' }),
    expect.objectContaining({
      kind: 'board.replan_triggered',
      text: 'task exports was handed back 2 times',
    }),
    expect.objectContaining({ kind: 'board.plan_updated', replan: true }),
    expect.objectContaining({
      kind: 'board.plan_proposal_resolved',
      text: 'Split the exports',
      decision: 'rejected',
    }),
  ]);
});
