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
  expect(rest).toEqual({ frames: whole.slice(3), next_after: null });
});
