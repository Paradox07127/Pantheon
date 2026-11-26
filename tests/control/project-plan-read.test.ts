import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  id,
  type Approval,
  type Principal,
  type Project,
  type ProjectPlan,
  type Review,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import type { PlanItemView, ProjectPlanView } from '@pantheon/protocol';
import { awaitWorkspaceReady, eventually, settle, user, waitOutStatusReuse } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Harness = Awaited<ReturnType<typeof planFixture>>;

const principalOf = (f: Fixture, sessionId: string, role: Principal['role']): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const passed = { name: 'test', argv: ['node', '-e', '0'], exit_code: 0 };
const failedStep = { name: 'test', argv: ['node', '-e', '1'], exit_code: 1 };
const skippedStep = { ...passed, state: 'skipped' };

async function planFixture() {
  const f = await workbenchFixture();
  const conductor = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the export',
    purpose: 'conductor',
  });
  await settle(f, conductor);
  const row = (sessionId: string) => f.store.must<Session>('sessions', sessionId);
  const patch = (sessionId: string, change: Partial<Session>) =>
    f.store.update('sessions', { ...row(sessionId), ...change }, row(sessionId).revision);
  const commit = (sessionId: string, file: string) => {
    const workspace = f.store.must<Workspace>('workspaces', row(sessionId).workspace_id!);
    writeFileSync(path.join(workspace.path, file), `${file}\n`);
    git(workspace.path, 'add', file);
    git(workspace.path, 'commit', '--quiet', '-m', file);
  };
  /** A worktree session the main agent spawned, or the user opened, settled and idle. */
  const worker = async (title: string, options: { commit?: boolean; own?: boolean } = {}) => {
    const session = await f.create(title);
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () =>
        f.turns(session.id).every((turn) => turn.state === 'completed') &&
        row(session.id).state === 'open',
      () => f.control.tick(),
    );
    if (!options.own) patch(session.id, { spawned_by: { session_id: conductor.id } });
    if (options.commit) commit(session.id, `${title.replaceAll(' ', '-')}.txt`);
    return row(session.id);
  };
  const write = (items: Record<string, unknown>[]) =>
    f.call(
      'conductor.plan_set',
      { milestones: [], items },
      null,
      principalOf(f, conductor.id, 'conductor'),
    );
  const event = (kind: string, sessionId: string, payload: Record<string, unknown>) =>
    f.store.event(kind, row(sessionId), f.project.id, payload);
  const turnFailed = (sessionId: string, error: string) =>
    f.store.event(
      'turn.failed',
      f.store.must<SessionTurn>('session_turns', f.turns(sessionId).at(-1)!.id),
      f.project.id,
      { error },
    );
  const merged = (sessionId: string, headSha?: string) =>
    event('session.merged', sessionId, {
      branch: 'pantheon/work',
      source: f.source,
      from_sha: 'base-sha',
      to_sha: 'landed-sha',
      ...(headSha ? { head_sha: headSha } : {}),
      files: 3,
      additions: 12,
      deletions: 4,
    });
  const gateChecked = (sessionId: string, results: Record<string, unknown>[], spec = 'spec') =>
    event('session.gate_checked', sessionId, {
      workspace_id: row(sessionId).workspace_id,
      commit: 'checked-sha',
      check_spec_hash: spec,
      results: results.map((result) => ({
        duration_ms: 1,
        timed_out: false,
        output: '',
        ...result,
      })),
    });
  const gateCommands = async () => {
    const project = f.store.must<Project>('projects', f.project.id);
    await f.call(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: project.roots[0]!,
        commands: [{ name: 'test', argv: ['node', '-e', '0'] }],
      },
      project.revision,
    );
  };
  const review = (sessionId: string, state: Review['state'], blocking = false) =>
    f.store.insert<Review>('reviews', {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      session_id: sessionId,
      round: 1,
      runtimes: ['reviewer'],
      state,
      findings: blocking
        ? [
            {
              id: id(),
              review_id: 'review',
              runtime: 'reviewer',
              round: 1,
              location: 'notes.txt:1',
              quote: 'notes',
              evidence: 'The header is gone',
              impact: 'The notes lose their header',
              status: 'open',
              blocking: true,
            },
          ]
        : [],
      session_ids: [],
    });
  /** Moves the time a session was named on the item. */
  const nameAt = (itemId: string, sessionId: string, at: string) => {
    const plan = f.store.must<ProjectPlan>('project_plans', f.project.id);
    f.store.update(
      'project_plans',
      {
        ...plan,
        items: plan.items.map((item) =>
          item.id === itemId ? { ...item, named_at: { ...item.named_at, [sessionId]: at } } : item,
        ),
      },
      plan.revision,
    );
  };
  const view = async (principal: Principal = user): Promise<ProjectPlanView> => {
    waitOutStatusReuse();
    await f.prefetch();
    return f.control.projectPlan(principal, f.project.id);
  };
  const itemOf = async (itemId = 'parser'): Promise<PlanItemView> =>
    (await view()).plan!.items.find((item) => item.id === itemId)!;
  return {
    f,
    conductor,
    row,
    patch,
    commit,
    worker,
    write,
    event,
    turnFailed,
    merged,
    gateChecked,
    gateCommands,
    review,
    nameAt,
    view,
    itemOf,
  };
}

const item = (sessionIds: string[], extra: Record<string, unknown> = {}) => ({
  id: 'parser',
  title: 'Parse the export format',
  ...(sessionIds.length ? { session_ids: sessionIds } : {}),
  ...extra,
});

it.each<[string, (h: Harness) => Promise<() => unknown>, Pick<PlanItemView, 'stage' | 'status'>]>([
  [
    'an item without a session',
    async (h) => {
      await h.write([item([])]);
      return () => {};
    },
    { stage: 'plan', status: 'not_started' },
  ],
  [
    'a dropped item, its session ready',
    async (h) => {
      const session = await h.worker('Write the parser', { commit: true });
      await h.write([item([session.id], { dropped: true })]);
      return () => {};
    },
    { stage: 'dropped', status: 'ready' },
  ],
  [
    'a session that landed after it was named',
    async (h) => {
      const session = await h.worker('Write the parser', { commit: true });
      await h.write([item([session.id])]);
      return () => h.merged(session.id);
    },
    { stage: 'landed', status: 'merged' },
  ],
  [
    'the main agent that landed and then committed again',
    async (h) => {
      await awaitWorkspaceReady(h.f.control, h.conductor.workspace_id!);
      h.commit(h.conductor.id, 'landed.txt');
      await h.write([item([h.conductor.id])]);
      return () => {
        h.merged(h.conductor.id);
        h.commit(h.conductor.id, 'after-landing.txt');
      };
    },
    { stage: 'landed', status: 'merged' },
  ],
  [
    'a session that landed before it was named, ready again',
    async (h) => {
      const session = await h.worker('Write the parser', { commit: true });
      h.merged(session.id);
      await h.write([item([session.id])]);
      return () => h.nameAt('parser', session.id, new Date(h.f.store.now() + 60_000).toISOString());
    },
    { stage: 'merge', status: 'ready' },
  ],
  [
    'sessions all discarded or closed without landing',
    async (h) => {
      const discarded = await h.worker('Write the parser', { commit: true });
      const closed = await h.worker('Write the parser again');
      await h.write([item([discarded.id, closed.id])]);
      return () => {
        h.patch(discarded.id, { state: 'closed', outcome: 'discarded' });
        h.patch(closed.id, { state: 'closed' });
      };
    },
    { stage: 'abandoned', status: 'abandoned' },
  ],
  [
    'a landing that runs',
    async (h) => {
      const session = await h.worker('Write the parser', { commit: true });
      await h.write([item([session.id])]);
      return () => h.patch(session.id, { merge: { state: 'running' } });
    },
    { stage: 'merge', status: 'ready' },
  ],
  [
    'a ready session',
    async (h) => {
      const session = await h.worker('Write the parser', { commit: true });
      await h.write([item([session.id])]);
      return () => {};
    },
    { stage: 'merge', status: 'ready' },
  ],
  [
    'a review that runs',
    async (h) => {
      const session = await h.worker('Write the parser');
      await h.write([item([session.id])]);
      return () => {
        h.patch(session.id, { state: 'running' });
        h.review(session.id, 'running');
      };
    },
    { stage: 'review', status: 'running' },
  ],
  [
    'a blocking review finding not resolved',
    async (h) => {
      const session = await h.worker('Write the parser');
      await h.write([item([session.id])]);
      return () => {
        h.patch(session.id, { state: 'running' });
        h.review(session.id, 'completed', true);
      };
    },
    { stage: 'review', status: 'running' },
  ],
  [
    'a gate that runs',
    async (h) => {
      await h.gateCommands();
      const session = await h.worker('Write the parser');
      await h.write([item([session.id])]);
      return () =>
        h.patch(session.id, {
          state: 'running',
          gate_run: { id: 'gate-running', state: 'running', started_at: h.f.store.now() },
        });
    },
    { stage: 'checks', status: 'running' },
  ],
  [
    'a gate that failed',
    async (h) => {
      await h.gateCommands();
      const session = await h.worker('Write the parser');
      await h.write([item([session.id])]);
      return () => {
        h.gateChecked(session.id, [failedStep]);
        h.patch(session.id, {
          state: 'running',
          gate_run: {
            id: 'gate-failed',
            state: 'failed',
            started_at: h.f.store.now(),
            finished_at: h.f.store.now(),
          },
        });
      };
    },
    { stage: 'checks', status: 'running' },
  ],
  [
    'a committed session under review',
    async (h) => {
      const session = await h.worker('Write the parser', { commit: true });
      await h.write([item([session.id])]);
      return () => h.review(session.id, 'running');
    },
    { stage: 'review', status: 'ready' },
  ],
  [
    'a committed session whose gate failed',
    async (h) => {
      await h.gateCommands();
      const session = await h.worker('Write the parser', { commit: true });
      await h.write([item([session.id])]);
      return () => {
        h.gateChecked(session.id, [failedStep]);
        h.patch(session.id, {
          gate_run: {
            id: 'gate-failed',
            state: 'failed',
            started_at: h.f.store.now(),
            finished_at: h.f.store.now(),
          },
        });
      };
    },
    { stage: 'checks', status: 'needs_you' },
  ],
  [
    'a session that runs',
    async (h) => {
      const session = await h.worker('Write the parser');
      await h.write([item([session.id])]);
      return () => h.patch(session.id, { state: 'running' });
    },
    { stage: 'write', status: 'running' },
  ],
  [
    'a session that waits for you',
    async (h) => {
      const session = await h.worker('Write the parser');
      await h.write([item([session.id])]);
      return () =>
        h.f.store.insert<Approval>('approvals', {
          id: 'unanswered-request',
          revision: 1,
          project_id: h.f.project.id,
          kind: 'permission',
          session_id: session.id,
          request_id: 'unanswered-request',
          tool: 'Bash',
          input_hash: 'a'.repeat(64),
          decider: 'user',
          state: 'pending',
          created_at: h.f.store.now(),
        });
    },
    { stage: 'write', status: 'needs_you' },
  ],
  [
    'a gate that is stale',
    async (h) => {
      await h.gateCommands();
      const session = await h.worker('Write the parser');
      await h.write([item([session.id])]);
      return () => {
        h.gateChecked(session.id, [passed], 'an-older-gate');
        h.patch(session.id, { state: 'running' });
      };
    },
    { stage: 'write', status: 'running' },
  ],
])('reads the stage of %s', async (_case, setup, expected) => {
  const h = await planFixture();
  const after = await setup(h);
  await after();

  const read = await h.itemOf();

  expect({ stage: read.stage, status: read.status }).toEqual(expected);
  if (_case === 'a gate that is stale') expect(read.gate_runs).toEqual([]);
});

it.each<
  [string, (h: Harness, sessionId: string) => Promise<void> | void, PlanItemView['evidence']]
>([
  ['an item that did not land', () => {}, undefined],
  [
    'an item the user accepted before it landed',
    async (h) => {
      await h.f.call(
        'project.plan.accept',
        { project_id: h.f.project.id, item_id: 'parser', accepted: true },
        h.f.store.must<ProjectPlan>('project_plans', h.f.project.id).revision,
      );
    },
    { level: 'accepted' },
  ],
  [
    'a landed item with no gate or review',
    (h, id) => void h.merged(id, 'head-sha'),
    { level: 'report' },
  ],
  [
    'a landed item whose gate passed before it landed',
    (h, id) => {
      h.gateChecked(id, [passed]);
      h.merged(id, 'head-sha');
    },
    { level: 'gate' },
  ],
  [
    'a landed item another runtime passed at the commit that landed',
    (h, id) => {
      reviewedAt(h, id, 'head-sha');
      h.merged(id, 'head-sha');
    },
    { level: 'reviewed', reviewer: 'other_runtime' },
  ],
  [
    'a landed item reviewed at a commit before the one that landed',
    (h, id) => {
      reviewedAt(h, id, 'older-sha');
      h.merged(id, 'head-sha');
    },
    { level: 'report' },
  ],
])('grades the evidence of %s', async (_case, setup, expected) => {
  const h = await planFixture();
  const session = await h.worker('Write the parser', { commit: true });
  await h.write([item([session.id])]);
  await setup(h, session.id);

  expect((await h.itemOf()).evidence).toEqual(expected);
});

it('grades an accepted item no session worked on as accepted', async () => {
  const h = await planFixture();
  await h.write([item([])]);
  await h.f.call(
    'project.plan.accept',
    { project_id: h.f.project.id, item_id: 'parser', accepted: true },
    h.f.store.must<ProjectPlan>('project_plans', h.f.project.id).revision,
  );

  expect((await h.itemOf()).evidence).toEqual({ level: 'accepted' });
});

function reviewedAt(h: Harness, sessionId: string, toSha: string) {
  const review = h.review(sessionId, 'completed');
  h.f.store.update<Review>(
    'reviews',
    {
      ...review,
      range: { source: h.f.source, from_sha: 'base-sha', to_sha: toSha },
      verdicts: [{ runtime: 'codex', verdict: 'pass', summary: 'Checked', at: h.f.store.now() }],
    },
    review.revision,
  );
}

it('reads a landed item through its newest merge, though its row reads ready again', async () => {
  const h = await planFixture();
  await awaitWorkspaceReady(h.f.control, h.conductor.workspace_id!);
  h.commit(h.conductor.id, 'landed.txt');
  await h.write([item([h.conductor.id])]);
  h.merged(h.conductor.id);
  h.commit(h.conductor.id, 'after-landing.txt');

  const read = await h.view();
  const parser = read.plan!.items[0]!;

  expect(parser.change?.status).toBe('ready');
  expect(parser.diff).toEqual({ files: 3, additions: 12, deletions: 4 });
  expect(parser).not.toHaveProperty('failure');
  expect(read.latest_landing).toEqual({
    sha: 'landed-sha',
    title: h.row(h.conductor.id).title ?? '',
    at: expect.any(String),
  });
  expect(read.plan!.conductor_open).toBe(true);
});

it('takes the session furthest along of an item that names three', async () => {
  const h = await planFixture();
  const discarded = await h.worker('Write the parser first');
  const running = await h.worker('Write the parser second');
  const ready = await h.worker('Write the parser third', { commit: true });
  await h.write([item([discarded.id, running.id, ready.id])]);
  h.patch(discarded.id, { state: 'closed', outcome: 'discarded' });
  h.patch(running.id, { state: 'running' });

  const read = await h.itemOf();

  expect(read).toMatchObject({ stage: 'merge', status: 'ready' });
  expect(read.change?.id).toBe(`session:${ready.id}`);
  expect(read.session_id).toBe(ready.id);
  expect(read.diff).toEqual(read.change?.changes);
  expect(read.diff?.files).toBe(1);
});

it('keeps the newest five gate runs of the session, oldest first', async () => {
  const h = await planFixture();
  const session = await h.worker('Write the parser', { commit: true });
  await h.write([item([session.id])]);
  for (const results of [[passed], [failedStep], [passed], [skippedStep], [passed], [failedStep]])
    h.gateChecked(session.id, results);

  expect((await h.itemOf()).gate_runs).toEqual(['failed', 'passed', 'skipped', 'passed', 'failed']);
});

it.each<[string, (h: Harness, sessionId: string) => void | Promise<void>, string]>([
  [
    'the last turn error once the failed gate is stale',
    async (h, sessionId) => {
      await h.gateCommands();
      h.gateChecked(sessionId, [failedStep], 'an-older-gate');
      h.turnFailed(sessionId, 'The model stopped');
    },
    'The model stopped',
  ],
  [
    'a failed gate step',
    (h, sessionId) => {
      h.gateChecked(sessionId, [failedStep]);
      h.turnFailed(sessionId, 'The model stopped');
      h.patch(sessionId, { merge: { state: 'blocked', reason: 'conflict' } });
      h.review(sessionId, 'completed', true);
    },
    'test',
  ],
  [
    'the last turn error',
    (h, sessionId) => {
      h.turnFailed(sessionId, 'The model stopped');
      h.patch(sessionId, { merge: { state: 'blocked', reason: 'conflict' } });
      h.review(sessionId, 'completed', true);
    },
    'The model stopped',
  ],
  [
    'a blocked merge',
    (h, sessionId) => {
      h.patch(sessionId, { merge: { state: 'blocked', reason: 'conflict' } });
      h.review(sessionId, 'completed', true);
    },
    'merge_blocked',
  ],
  [
    'a blocking review finding',
    (h, sessionId) => {
      h.review(sessionId, 'completed', true);
    },
    'The notes lose their header',
  ],
])('names %s first as the failure', async (_case, fail, reason) => {
  const h = await planFixture();
  const session = await h.worker('Write the parser', { commit: true });
  await h.write([item([session.id])]);
  await fail(h, session.id);

  expect((await h.itemOf()).failure).toEqual({
    reason,
    at: expect.any(String),
    handled_by: 'you',
  });
});

it.each([
  ['the main agent was told after the failure', 1, 'main_agent'],
  ['the main agent was told before it', -60_000, 'you'],
] as const)('hands a failure to whoever is on it: %s', async (_case, offset, handledBy) => {
  const h = await planFixture();
  const session = await h.worker('Write the parser', { commit: true });
  await h.write([item([session.id])]);
  const failedAt = h.f.store.now();
  const clock = vi.spyOn(h.f.store, 'now').mockReturnValue(failedAt);
  h.gateChecked(session.id, [failedStep]);
  clock.mockReturnValue(failedAt + offset);
  h.event('session.spawner_notified', session.id, { session_id: h.conductor.id, kind: 'failed' });
  clock.mockRestore();

  expect((await h.itemOf()).failure).toEqual({
    reason: 'test',
    at: new Date(failedAt).toISOString(),
    handled_by: handledBy,
  });
});

it('lists the change rows no item names, the sessions the user opened among them', async () => {
  const h = await planFixture();
  const planned = await h.worker('Write the parser', { commit: true });
  const own = await h.worker('Fix the readme', { commit: true, own: true });
  await h.write([item([planned.id])]);

  const ids = (await h.view()).unplanned.map((row) => row.id);

  expect(ids).toContain(`session:${own.id}`);
  expect(ids).not.toContain(`session:${planned.id}`);
});

it('reads no plan before a main agent writes one, with every change row unplanned', async () => {
  const h = await planFixture();
  const own = await h.worker('Fix the readme', { commit: true, own: true });

  const read = await h.view();

  expect(read.plan).toBeNull();
  expect(read.unplanned.map((row) => row.id)).toContain(`session:${own.id}`);
});

it('refuses a principal of another project', async () => {
  const h = await planFixture();
  await h.write([item([])]);
  const otherRoot = path.join(h.f.root, 'other');
  mkdirSync(otherRoot);
  const other = await h.f.call<Promise<Project>>('project.open', {
    name: 'Other',
    roots: [otherRoot],
  });

  expect(() =>
    h.f.control.projectPlan(principalOf(h.f, h.conductor.id, 'conductor'), other.id),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});
