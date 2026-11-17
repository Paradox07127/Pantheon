import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type {
  BoardPlan,
  ChangeStory,
  Principal,
  Project,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import { eventually, insideSandbox, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const task = (id: string): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}.ts`],
  acceptance: ['test -d src'],
  kind: { domain: 'backend-logic', tier: 't1' },
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const project = (f: Fixture) => f.store.must<Project>('projects', f.project.id);

const idle = (f: Fixture, sessionId: string) =>
  current(f, sessionId).state === 'open' &&
  current(f, sessionId).merge?.state !== 'running' &&
  f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state));

/** Waits until the session has no turn or merge under way, and stays so over a few ticks. */
async function settle(f: Fixture, sessionId: string) {
  for (let quiet = 0; quiet < 3;) {
    await eventually(
      () => idle(f, sessionId),
      () => f.control.tick(),
      15000,
    );
    await f.control.tick();
    quiet = idle(f, sessionId) ? quiet + 1 : 0;
  }
}

/** The lead claims the task, commits its file, reports it done and ends a turn, so it merges. */
async function landDirect(f: Fixture, leadId: string, taskId: string, worktree: string) {
  f.call('task.start', { project_id: f.project.id, task_ids: [taskId] }, null, leadOf(f, leadId));
  mkdirSync(path.join(worktree, 'src'), { recursive: true });
  writeFileSync(path.join(worktree, 'src', `${taskId}.ts`), `export const ${taskId} = 1;\n`);
  git(worktree, 'add', '--', `src/${taskId}.ts`);
  git(worktree, 'commit', '--quiet', '-m', `Add ${taskId}`);
  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'The task is done' },
    null,
    leadOf(f, leadId),
  );
  f.call('session.send', { session_id: leadId, input: 'Go on' }, current(f, leadId).revision);
  await settle(f, leadId);
}

it.skipIf(insideSandbox)(
  'counts each direct merge of one lead and binds it to its task card',
  async () => {
    const f = workbenchFixture();
    git(f.source, 'config', 'user.name', 'Source User');
    git(f.source, 'config', 'user.email', 'source@example.invalid');
    f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
      },
      project(f).revision,
    );
    f.call<Project>(
      'project.autoMerge.set',
      { project_id: f.project.id, enabled: true },
      project(f).revision,
    );
    const lead = f.create('Plan the export feature');
    await settle(f, lead.id);
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: 0,
        headline: 'Export ships this week',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [task('a'), task('b')],
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      leadOf(f, lead.id),
    );
    const worktree = f.store.must<Workspace>('workspaces', current(f, lead.id).workspace_id!).path;
    await landDirect(f, lead.id, 'a', worktree);
    await landDirect(f, lead.id, 'b', worktree);
    const directMerged = f.store.must<BoardPlan>('board_plans', lead.id).direct_merged!;
    expect(Object.keys(directMerged)).toEqual(['a', 'b']);

    const board = f.control.boardView(user, f.project.id, 1);
    expect(board.merges.map((merge) => [merge.session_id, merge.sha])).toEqual([
      [lead.id, directMerged.b!.to_sha],
      [lead.id, directMerged.a!.to_sha],
    ]);
    expect(board.counts.merged).toBe(2);
    expect(board.burnup.at(-1)!.done).toBe(2);
    expect(board.task_progress.daily.at(-1)!.done).toBe(2);
    const card = board.tasks.find((row) => row.id === `${lead.id}:a`)!;
    expect(card).toMatchObject({ status: 'done', state: 'merged', additions: 1, deletions: 0 });
    expect(card.segments).toHaveLength(1);
    expect(card.segments[0]).toMatchObject({ session_id: lead.id, status: 'done', additions: 1 });
    expect(card.started_at).not.toBeNull();
    expect(card.ended_at).toBeGreaterThanOrEqual(card.started_at!);
  },
  30000,
);

/** A lead with a plan of tasks a and b under a passing gate and auto merge, and its worktree. */
async function planTwoTasks(f: Fixture) {
  f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
    },
    project(f).revision,
  );
  f.call<Project>(
    'project.autoMerge.set',
    { project_id: f.project.id, enabled: true },
    project(f).revision,
  );
  const lead = f.create('Plan the export feature');
  await settle(f, lead.id);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task('a'), task('b')],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );
  return {
    lead,
    worktree: f.store.must<Workspace>('workspaces', current(f, lead.id).workspace_id!).path,
  };
}

it.skipIf(insideSandbox)(
  'fills a landed task card with only what the lead used from its claim to its merge',
  async () => {
    const f = workbenchFixture();
    const { lead, worktree } = await planTwoTasks(f);
    await landDirect(f, lead.id, 'a', worktree);
    const claimedA = current(f, lead.id);
    f.store.update<Session>(
      'sessions',
      { ...claimedA, requested_model: 'fixture-next' },
      claimedA.revision,
    );
    await landDirect(f, lead.id, 'b', worktree);
    const turns = f.turns(lead.id);
    for (const [index, turn] of turns.entries())
      f.store.update<SessionTurn>(
        'session_turns',
        { ...turn, usage: { input_tokens: 10 ** index, output_tokens: 0 } },
        turn.revision,
      );
    expect(turns[1]!.input).toBe('Go on');

    expect(f.list().find((session) => session.id === lead.id)!.model).toBe('fixture-next');
    const board = f.control.boardView(user, f.project.id, 1);
    const card = board.tasks.find((row) => row.id === `${lead.id}:a`)!;
    expect(card.segments[0]).toMatchObject({ tokens: 10, model: turns[1]!.model ?? null });
    expect(card.last_progress_at).toBeLessThanOrEqual(card.ended_at!);
  },
  30000,
);

it('fills a held claim card with only what the lead used since the claim', async () => {
  const f = workbenchFixture();
  const { lead, worktree } = await planTwoTasks(f);
  const [before] = f.turns(lead.id);
  f.store.update<SessionTurn>(
    'session_turns',
    { ...before!, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    before!.revision,
  );
  f.store.db
    .prepare('UPDATE events SET created_at=created_at-3600000 WHERE aggregate_id=?')
    .run(before!.id);
  writeFileSync(path.join(worktree, 'unrelated.txt'), 'Work from before the claim\n');
  f.call('task.start', { project_id: f.project.id, task_ids: ['a'] }, null, leadOf(f, lead.id));
  expect(current(f, lead.id).direct_task?.id).toBe('a');
  const claimedAt = (
    f.store.db
      .prepare("SELECT created_at FROM events WHERE aggregate_id=? AND kind='task.claimed'")
      .get(lead.id) as { created_at: number }
  ).created_at;

  const card = f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((row) => row.id === `${lead.id}:a`)!;
  expect(card.started_at).toBe(claimedAt);
  expect(card.segments).toHaveLength(1);
  expect(card.segments[0]!.started_at).toBe(claimedAt);
  expect(card.segments[0]!.tokens).toBeLessThan(1_000_000);
  expect(card.segments[0]).not.toHaveProperty('additions');
  expect(card.additions).toBeNull();
}, 30000);

it.skipIf(insideSandbox)(
  'links each direct merge to the change story of its own commits',
  async () => {
    const f = workbenchFixture();
    const { lead, worktree } = await planTwoTasks(f);
    await landDirect(f, lead.id, 'a', worktree);
    await landDirect(f, lead.id, 'b', worktree);
    const [mergeB, mergeA] = f.control.boardView(user, f.project.id, 1).merges;
    const story = (id: string, merge: typeof mergeA, created_at: number): ChangeStory => ({
      id,
      revision: 1,
      project_id: f.project.id,
      workbench_session_id: lead.id,
      source: f.source,
      from_sha: merge!.from_sha!,
      to_sha: merge!.sha,
      state: 'ready',
      created_at,
    });
    const now = Date.now();
    f.store.insert('change_stories', story('story-b', mergeB, now - 1));
    f.store.insert('change_stories', story('story-a', mergeA, now));

    expect(
      f.control.boardView(user, f.project.id, 1).merges.map((merge) => merge.story_id),
    ).toEqual(['story-b', 'story-a']);
  },
  30000,
);

it.skipIf(insideSandbox)(
  'links the only merge of a session to its story written before a rebase moved the range',
  async () => {
    const f = workbenchFixture();
    const { lead, worktree } = await planTwoTasks(f);
    await landDirect(f, lead.id, 'a', worktree);
    f.store.insert('change_stories', {
      id: 'story-before-rebase',
      revision: 1,
      project_id: f.project.id,
      workbench_session_id: lead.id,
      source: f.source,
      from_sha: '0'.repeat(40),
      to_sha: '1'.repeat(40),
      state: 'ready',
      created_at: Date.now(),
    } satisfies ChangeStory);

    expect(
      f.control.boardView(user, f.project.id, 1).merges.map((merge) => merge.story_id),
    ).toEqual(['story-before-rebase']);
  },
  30000,
);

it.skipIf(insideSandbox)(
  'counts the burnup scope in tasks, as it counts the done ones',
  async () => {
    const f = workbenchFixture();
    const { lead, worktree } = await planTwoTasks(f);
    await landDirect(f, lead.id, 'a', worktree);
    await landDirect(f, lead.id, 'b', worktree);

    expect(f.control.boardView(user, f.project.id, 1).burnup.at(-1)).toMatchObject({
      scope: 2,
      done: 2,
    });
  },
  30000,
);
