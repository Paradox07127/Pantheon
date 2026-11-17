import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Project, Session, Workspace } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import {
  requireMergeReady,
  workbenchSessionSpec,
} from '../../packages/control/dist/workbench-session.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const contextOf = (f: ReturnType<typeof workbenchFixture>) =>
  (f.control as unknown as { ctx: ControlContext }).ctx;

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('Expected a refusal');
};

const removals = (f: ReturnType<typeof workbenchFixture>) =>
  f.store.pending().filter((job) => job.kind === 'workspace.remove');

it('lists an adopted session as idle with its kind and the uncommitted changes of its folder, never as ready', async () => {
  const f = workbenchFixture({ adoptable: true });
  const session = await f.adopt();
  // The list reuses a folder read for two seconds; an edit outside a turn shows after that.
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => void vi.useRealTimers());
  const listed = async () => {
    vi.setSystemTime(Date.now() + 2000);
    await f.prefetch();
    return f.list().find((each) => each.id === session.id)!;
  };
  expect(await listed()).toMatchObject({
    state: 'idle',
    workspace_kind: 'in_place',
    changes: { files: 0, additions: 0, deletions: 0 },
  });
  expect(await listed()).not.toHaveProperty('gate');

  writeFileSync(path.join(f.source, 'answer.txt'), 'base\nmore\n');
  writeFileSync(path.join(f.source, 'notes.txt'), 'one\ntwo\n');
  expect(await listed()).toMatchObject({
    state: 'idle',
    changes: { files: 2, additions: 3, deletions: 0 },
  });

  git(f.source, 'add', '.');
  git(f.source, 'commit', '--quiet', '-m', 'Terminal work');
  expect(await listed()).toMatchObject({
    state: 'idle',
    changes: { files: 0, additions: 0, deletions: 0 },
  });

  writeFileSync(path.join(f.source, '.git/HEAD'), 'ref: refs/heads/missing\n');
  expect(await listed()).toMatchObject({ state: 'idle', changes: null });
});

it('reads the uncommitted changes of the folder as the diff of an adopted session', async () => {
  const f = workbenchFixture({ adoptable: true });
  const session = await f.adopt();
  writeFileSync(path.join(f.source, 'answer.txt'), 'base\nmore\n');
  writeFileSync(path.join(f.source, 'notes.txt'), 'one\ntwo\n');
  const diff = await f.control.sessionDiff(user, session.id);
  const head = git(f.source, 'rev-parse', 'HEAD');
  expect(diff).toMatchObject({
    session_id: session.id,
    base_sha: head,
    head_sha: head,
    truncated: false,
    files: [
      { path: 'answer.txt', additions: 1, deletions: 0, untracked: false },
      { path: 'notes.txt', additions: 2, deletions: 0, untracked: true },
    ],
  });
  expect(diff.patch).toContain('+more');
  expect(diff.patch).toContain('+two');
});

it('refuses merge, gate runs, merge admission, preflight and a backend change for an adopted session', async () => {
  const f = workbenchFixture({ adoptable: true });
  const session = await f.adopt();
  const current = () => f.store.must<Session>('sessions', session.id);
  const noGate = /no merge gate/;
  const merge = refusal(() =>
    f.call('session.merge', { session_id: session.id }, current().revision),
  );
  expect(merge).toMatchObject({ code: 'invalid_state', message: expect.stringMatching(noGate) });
  const gates = refusal(() =>
    f.call('session.gates.run', { session_id: session.id }, current().revision),
  );
  expect(gates).toMatchObject({ code: 'invalid_state', message: expect.stringMatching(noGate) });
  expect(refusal(() => requireMergeReady(contextOf(f), current()))).toMatchObject({
    code: 'invalid_state',
    message: expect.stringMatching(noGate),
  });
  await expect(f.control.sessionPreflight(user, session.id)).rejects.toMatchObject({
    code: 'invalid_state',
    message: expect.stringMatching(noGate),
  });
  const backend = refusal(() =>
    f.call('session.setBackend', { session_id: session.id, backend: null }, current().revision),
  );
  expect(backend).toMatchObject({
    code: 'invalid_state',
    message: expect.stringMatching(/cannot change its backend/),
  });
  expect(current()).toEqual(session);
  expect(f.store.pending().filter((job) => job.kind === 'session.merge')).toEqual([]);
});

it('refuses to discard an adopted session and queues no removal of its folder', async () => {
  const f = workbenchFixture({ adoptable: true });
  const session = await f.adopt();
  expect(
    refusal(() => f.call('session.discard', { session_id: session.id }, session.revision)),
  ).toMatchObject({ code: 'invalid_state' });
  expect(f.store.must<Session>('sessions', session.id)).toEqual(session);
  expect(removals(f)).toEqual([]);
});

it('deletes an adopted session without touching its folder or native record and returns its trace to the external lane', async () => {
  const f = workbenchFixture({ adoptable: true });
  const nativeId = randomUUID();
  const session = await f.adopt({ native_id: nativeId });
  const trace = contextOf(f).trace!;
  await f.control.traceScan(5000);
  const lane = () =>
    trace.lanes(f.project.id).find((each) => each.lane.native_id === nativeId)?.lane;
  expect(lane()).toMatchObject({ source: 'pantheon', session_id: session.id });
  const folder = readdirSync(f.source, { recursive: true }).map(String).sort();
  const record = path.join(
    f.protectionPaths.home,
    '.claude/projects',
    f.source.replace(/[^a-zA-Z0-9]/g, '-'),
    `${nativeId}.jsonl`,
  );

  f.call('session.delete', { session_id: session.id }, session.revision);
  expect(f.store.get<Session>('sessions', session.id)).toBeUndefined();
  expect(f.store.get<Workspace>('workspaces', session.workspace_id!)).toBeDefined();
  expect(removals(f)).toEqual([]);
  await eventually(() => lane()?.source === 'external');
  expect(lane()).toMatchObject({ key: `native:claude:${nativeId}`, source: 'external' });
  expect(readdirSync(f.source, { recursive: true }).map(String).sort()).toEqual(folder);
  expect(existsSync(record)).toBe(true);
});

it('builds the spec of a worktree session in a project that holds an adopted session', async () => {
  const f = workbenchFixture({ adoptable: true });
  await f.adopt();
  const created = f.create();
  const workspace = await awaitWorkspaceReady(f.control, created.workspace_id!);
  const spec = workbenchSessionSpec(contextOf(f), f.store.must<Session>('sessions', created.id));
  expect(spec.cwd).toBe(workspace.path);
});

it('starts a session opened without a model on the project default model and effort of its runtime', () => {
  const f = workbenchFixture();
  // A default model must belong to the default runtime, so the fixture models get a family.
  writeFileSync(
    path.join(f.root, 'config.json'),
    JSON.stringify({ version: 1, model_families: { 'fixture-': f.adapter.name } }),
  );
  Object.assign(contextOf(f), { userConfigDir: f.root });
  const project = f.store.must<Project>('projects', f.project.id);
  f.call(
    'project.sessionDefaults.set',
    {
      project_id: project.id,
      runtime: f.adapter.name,
      permission_mode: 'ask',
      model: 'fixture-large',
      effort: 'high',
    },
    project.revision,
  );
  const open = (input: Record<string, unknown>) =>
    f.call<Session>('session.create', { project_id: project.id, input: 'Go on', ...input });
  for (const opened of [open({}), open({ runtime: f.adapter.name })])
    expect(opened).toMatchObject({
      runtime: f.adapter.name,
      requested_model: 'fixture-large',
      requested_effort: 'high',
    });
  const chosen = open({ runtime: f.adapter.name, model: 'fixture-small' });
  expect(chosen.requested_model).toBe('fixture-small');
  expect(chosen.requested_effort).toBeUndefined();
});
