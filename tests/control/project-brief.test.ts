import { expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  Approval,
  Landing,
  Principal,
  Session,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { proseItems } from '../../packages/control/dist/project-brief.js';
import { briefFacts } from '../../packages/control/dist/project-brief-prose.js';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);

/** Two idle sessions of the project. */
async function opened(f: Fixture) {
  const first = await f.create('Plan the export feature');
  await settle(f, first);
  const worker = await f.create();
  await settle(f, worker);
  return { first, worker };
}

const merged = (f: Fixture, sessionId: string) =>
  f.store.event('session.merged', current(f, sessionId), f.project.id, {
    branch: 'pantheon/export',
    to_sha: 'a'.repeat(40),
  });

/** Waits until the clock has moved past at, so the next event falls after it. */
const after = (f: Fixture, at: number) => eventually(() => f.store.now() > at);

it('lists a merge and a new permission request after the cursor with their refs, and neither once seen', async () => {
  const f = await workbenchFixture();
  const { first, worker } = await opened(f);
  const seen = f.call<{ project_id: string; at: number }>('project.seen', {
    project_id: f.project.id,
  });
  await after(f, seen.at);
  merged(f, worker.id);
  f.store.insert<Approval>('approvals', {
    id: 'approval-bash',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: first.id,
    request_id: 'request-bash',
    tool: 'Bash',
    input_hash: 'hash',
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  });

  const brief = f.control.projectBrief(user, f.project.id);
  const needs = f.control.needsYou(user, f.project.id).items;
  expect(brief.since).toBe(seen.at);
  expect(needs.map((item) => item.reason)).toEqual(['permission_requested']);
  expect(brief.items).toEqual([
    {
      kind: 'decisions',
      ref: { kind: 'approval', id: 'approval-bash' },
      count: 1,
      new: 1,
      top: needs[0],
    },
    expect.objectContaining({ kind: 'merge', ref: { kind: 'merge', id: worker.id } }),
  ]);

  f.call('project.seen', { project_id: f.project.id });
  expect(f.control.projectBrief(user, f.project.id).items).toEqual([]);
});

it('counts the prompts a stored rule answered for the user after the cursor, and drops them once seen', async () => {
  const f = await workbenchFixture();
  const seen = f.call<{ project_id: string; at: number }>('project.seen', {
    project_id: f.project.id,
  });
  expect(f.control.projectBrief(user, f.project.id).items).toEqual([]);
  await after(f, seen.at);
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const worker = await f.create('Build the format');
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  const turn = f.turns(worker.id)[0]!;
  await eventually(
    () => f.control.handles.has(turn.id) && current(f, worker.id).state === 'running',
    () => f.control.tick(),
  );
  const worktree = f.store.must<Workspace>('workspaces', worker.workspace_id!).path;
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  f.call('permission.rule.add', { project_id: f.project.id, rule: 'Edit', session_id: worker.id });
  agentEvent(ctx, worker.id, {
    key: 'prompt-101',
    provider_sequence: 101,
    turn_id: turn.id,
    kind: 'permission.requested',
    request_id: 'request-101',
    tool: 'Edit',
    detail: {
      input: { file_path: `${worktree}/src/format.ts`, old_string: 'a', new_string: 'b' },
    },
    project_rule_supported: true,
  } as AgentEvent);
  await f.control.tick();

  expect(f.control.projectBrief(user, f.project.id).items).toContainEqual({
    kind: 'decided',
    ref: { kind: 'decided', id: f.project.id },
    count: 1,
    types: { permission: 1 },
  });
  f.call('project.seen', { project_id: f.project.id });
  expect(
    f.control.projectBrief(user, f.project.id).items.filter((item) => item.kind === 'decided'),
  ).toEqual([]);
});

it('leaves out what happened before since', async () => {
  const f = await workbenchFixture();
  const { first, worker } = await opened(f);
  const earlier = merged(f, first.id);
  await after(f, earlier.created_at);
  const since = f.store.now();
  await after(f, since);
  merged(f, worker.id);

  const brief = f.control.projectBrief(user, f.project.id, since);
  expect(brief.since).toBe(since);
  expect(brief.items).toEqual([
    expect.objectContaining({ kind: 'merge', ref: { kind: 'merge', id: worker.id } }),
  ]);
});

it('lists a branch landed after the cursor as a merge that names its branches', async () => {
  const f = await workbenchFixture();
  const seen = f.call<{ project_id: string; at: number }>('project.seen', {
    project_id: f.project.id,
  });
  const landing = (id: string, state: Landing['state'], finished_at: number) =>
    f.store.insert<Landing>('landings', {
      id,
      revision: 1,
      project_id: f.project.id,
      root: f.project.roots[0]!,
      branch: 'feature',
      target_branch: 'main',
      workspace_id: 'landing-workspace',
      state,
      finished_at,
    });
  landing('landed-before', 'landed', seen.at);
  landing('landed-after', 'landed', seen.at + 1);
  landing('blocked-after', 'blocked', seen.at + 1);
  const { items } = f.control.projectBrief(user, f.project.id);
  expect(items).toEqual([
    { kind: 'merge', ref: { kind: 'landing', id: 'landed-after' }, at: seen.at + 1 },
  ]);
  expect(
    briefFacts(
      (f.control as unknown as { ctx: ControlContext }).ctx,
      f.project.id,
      proseItems(items),
    ),
  ).toEqual([
    {
      key: 'landing:landed-after',
      ref: { kind: 'landing', id: 'landed-after' },
      text: 'Branch "feature" landed on "main".',
    },
  ]);
});

it('refuses a principal without access to the project', async () => {
  const f = await workbenchFixture();
  const stranger: Principal = { id: 'planner', role: 'planner', project_id: 'other-project' };
  expect(() => f.control.projectBrief(stranger, f.project.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() => f.call('project.seen', { project_id: f.project.id }, null, stranger)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});
