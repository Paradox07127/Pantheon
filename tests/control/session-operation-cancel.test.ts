import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Principal, Project, Session } from '@pantheon/domain';
import { readProcessIdentity } from '@pantheon/adapters';
import type { ControlContext } from '../../packages/control/src/context.js';
import { awaitWorkspaceReady, eventually, insideSandbox, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const events = (f: Fixture, id: string, kind: string) =>
  f.store.kindEvents(f.project.id, [kind]).filter((event) => event.aggregate_id === id);

async function prepared() {
  const f = workbenchFixture();
  const session = f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'the work remains available\n');
  git(workspace.path, 'add', '.');
  git(workspace.path, 'commit', '--quiet', '-m', 'Keep the answer');
  const head = git(workspace.path, 'rev-parse', 'HEAD');
  return { f, session, workspace, head, sourceHead: git(f.source, 'rev-parse', 'HEAD') };
}

function configureGate(f: Fixture) {
  f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [
        { name: 'Long check', argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'] },
      ],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

it('cancels a queued merge without changing the source or discarding its commits', async () => {
  const { f, session, workspace, head, sourceHead } = await prepared();
  f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
  f.call('session.merge.cancel', { session_id: session.id }, current(f, session.id).revision);
  expect(current(f, session.id).merge?.cancel_requested).toBe(true);
  await eventually(
    () => current(f, session.id).merge?.reason === 'cancelled',
    () => f.control.tick(),
  );
  expect(current(f, session.id).outcome).toBeUndefined();
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
  expect(existsSync(workspace.path)).toBe(true);
  expect(events(f, session.id, 'session.merge_cancelled')).toHaveLength(1);
  f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).outcome === 'merged',
    () => f.control.tick(),
  );
});

it('settles a persisted gate cancellation after restart without running the command again', async () => {
  const { f, session } = await prepared();
  f.store.transaction(() => {
    const row = current(f, session.id);
    f.store.update(
      'sessions',
      {
        ...row,
        gate_run: { id: 'saved-check', state: 'cancelling' as const, started_at: f.store.now() },
      },
      row.revision,
    );
  });
  await f.restart();
  expect(current(f, session.id).gate_run?.state).toBe('cancelled');
  expect(events(f, session.id, 'session.gate_run_cancelled')).toHaveLength(1);
  expect(events(f, session.id, 'session.gate_checked')).toHaveLength(0);
});

it('records an already fast-forwarded merge as merged even when cancellation survived a crash', async () => {
  const { f, session, workspace, head, sourceHead } = await prepared();
  f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
  f.store.transaction(() => {
    const row = current(f, session.id);
    f.store.update(
      'sessions',
      {
        ...row,
        merge: {
          ...row.merge!,
          landing: {
            stage: 'gated' as const,
            candidate: head,
            branch: 'main',
            from_sha: sourceHead,
            gate_argv: '[]',
          },
        },
      },
      row.revision,
    );
  });
  git(f.source, 'merge', '--quiet', '--ff-only', head);
  f.call('session.merge.cancel', { session_id: session.id }, current(f, session.id).revision);
  await f.restart();
  await eventually(
    () => current(f, session.id).outcome === 'merged',
    () => f.control.tick(),
  );
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  expect(events(f, session.id, 'session.merged')).toHaveLength(1);
  expect(events(f, session.id, 'session.merge_cancelled')).toHaveLength(0);
  expect(current(f, session.id).workspace_id).toBe(workspace.id);
});

it('requires the user and a current revision to cancel an operation', async () => {
  const { f, session } = await prepared();
  f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
  const worker: Principal = {
    ...user,
    role: 'worker',
    project_id: f.project.id,
    session_id: session.id,
  };
  expect(() =>
    f.call(
      'session.merge.cancel',
      { session_id: session.id },
      current(f, session.id).revision,
      worker,
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(() =>
    f.call('session.merge.cancel', { session_id: session.id }, session.revision),
  ).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
  expect(current(f, session.id).merge?.cancel_requested).toBeUndefined();
});

it.skipIf(process.platform !== 'darwin' || insideSandbox)(
  'stops a registered gate and leaves no successful result after cancellation',
  async () => {
    const { f, session, workspace, head, sourceHead } = await prepared();
    configureGate(f);
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    vi.spyOn(ctx, 'readProcess').mockImplementation(readProcessIdentity);
    f.call('session.gates.run', { session_id: session.id }, current(f, session.id).revision);
    await eventually(
      () =>
        !!f.store.db
          .prepare("SELECT receipt FROM inbox WHERE source_key GLOB 'gate-process:*'")
          .get(),
      () => f.control.tick(),
      10000,
    );
    const recorded = f.store.db
      .prepare("SELECT receipt FROM inbox WHERE source_key GLOB 'gate-process:*'")
      .get() as { receipt: string };
    const identity = JSON.parse(recorded.receipt) as { pid: number; started: number };
    expect(readProcessIdentity(identity.pid)?.start_time_us).toBe(identity.started);
    f.call('session.gates.cancel', { session_id: session.id }, current(f, session.id).revision);
    expect(f.control.sessionGates(user, session.id).operation?.state).toBe('cancelling');
    await eventually(
      () => current(f, session.id).gate_run?.state === 'cancelled',
      () => f.control.tick(),
      10000,
    );
    expect(readProcessIdentity(identity.pid)).toBeUndefined();
    expect(events(f, session.id, 'session.gate_checked')).toHaveLength(0);
    expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
  },
);

it.skipIf(process.platform !== 'darwin' || insideSandbox)(
  'cancels a merge during its gate and never fast-forwards the source',
  async () => {
    const { f, session, workspace, sourceHead } = await prepared();
    configureGate(f);
    vi.spyOn(
      (f.control as unknown as { ctx: ControlContext }).ctx,
      'readProcess',
    ).mockImplementation(readProcessIdentity);
    f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
    await eventually(
      () =>
        !!f.store.db
          .prepare("SELECT receipt FROM inbox WHERE source_key GLOB 'gate-process:*'")
          .get(),
      () => f.control.tick(),
      10000,
    );
    f.call('session.merge.cancel', { session_id: session.id }, current(f, session.id).revision);
    await eventually(
      () => current(f, session.id).merge?.reason === 'cancelled',
      () => f.control.tick(),
      10000,
    );
    expect(events(f, session.id, 'session.gate_checked')).toHaveLength(0);
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
    expect(existsSync(workspace.path)).toBe(true);
    expect(current(f, session.id).outcome).toBeUndefined();
  },
);
