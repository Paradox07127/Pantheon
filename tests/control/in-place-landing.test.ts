import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  credentialRole,
  type Project,
  type Session,
  type SessionSpec,
  type Workspace,
} from '@pantheon/domain';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const passed = (): validation.ValidationResult => ({
  exit_code: 0,
  timedOut: false,
  signal: null,
  duration_ms: 1,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  log: Buffer.alloc(0),
  tail: '',
  stdout_sha256: '',
  stderr_sha256: '',
  output_truncated: false,
  boundary: {
    kind: 'macos-seatbelt',
    network: 'loopback',
    supported: true,
    stop_scope: 'process-group',
  },
});

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;
const writeAndCommit = script(
  { write: { path: 'notes.txt', text: 'notes\n' } },
  { commit: 'Add notes' },
);

const refusal = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('Expected a refusal');
};

const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const head = (f: Fixture) => git(f.source, 'rev-parse', 'HEAD').trim();

async function folderSession(f: Fixture, input = writeAndCommit, workspace = 'auto') {
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input,
    workspace,
  });
  await eventually(
    () => f.turns(session.id).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );
  return current(f, session.id);
}

async function withGate(f: Fixture) {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(passed());
  await f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands: [{ name: 'check', argv: ['check'] }] },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

async function runGates(f: Fixture, id: string) {
  await f.call('session.gates.run', { session_id: id }, current(f, id).revision);
  await eventually(
    () => !f.control.sessionGates(user, id).running,
    () => f.control.tick(),
  );
}

const land = (f: Fixture, id: string) =>
  f.call<Promise<Session>>('session.merge', { session_id: id }, current(f, id).revision);

it('records the folder HEAD a new folder session opens on and keeps its commit in the diff', async () => {
  const f = await workbenchFixture();
  const before = head(f);
  const session = await folderSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  expect(workspace).toMatchObject({ kind: 'in_place', path: realpathSync(f.source) });
  expect(session.in_place).toEqual({ base_sha: before });
  expect(head(f)).not.toBe(before);
  const diff = await f.control.sessionDiff(user, session.id);
  expect(diff.base_sha).toBe(before);
  expect(diff.files.map((file) => file.path)).toEqual(['notes.txt']);
  await f.prefetch();
  expect(f.list().find((row) => row.id === session.id)).toMatchObject({
    lands: true,
    holds_folder: true,
    state: 'ready',
    changes: { files: 1 },
  });
});

it('runs a new folder session the user opened without Pantheon tools, text or memory', async () => {
  const f = await workbenchFixture();
  Object.assign(f.adapter, { questionTool: 'ask_human' });
  Object.assign(f.control['ctx'], {
    issueSessionCredential: () => ({
      token_file: path.join(f.root, 'token'),
      daemon_url: 'http://127.0.0.1:1',
    }),
  });
  const draft = f.call<{ id: string; revision: number }>('memory.propose', {
    project_id: f.project.id,
    key: 'language',
    kind: 'decision',
    text: 'Use precise terminology',
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  const send = vi.spyOn(f.adapter, 'send');
  const session = await folderSession(f, 'Look around');
  const spec = f.start.mock.calls.at(-1)![0] as SessionSpec;
  expect(spec.pantheon_mcp).toBeUndefined();
  expect(spec.control_instructions ?? '').toBe('');
  expect(send.mock.calls[0]![1].input).not.toContain('[Pantheon current project memory]');
});

it('runs the gates of a new folder session and lands it on the current branch once they pass', async () => {
  const f = await workbenchFixture();
  await withGate(f);
  const session = await folderSession(f);
  expect(f.list().find((row) => row.id === session.id)?.gate).toBeUndefined();
  expect((await refusal(() => land(f, session.id))).code).toBe('gate_required');
  await runGates(f, session.id);
  expect(f.control.sessionGates(user, session.id).last?.commit).toBe(head(f));
  const preflight = await f.control.sessionPreflight(user, session.id);
  expect(preflight).toMatchObject({
    target_branch: 'main',
    commit_count: 1,
    files_changed: 1,
    gate: { last: 'passed' },
    can_merge: true,
  });
  const landed = head(f);
  await land(f, session.id);
  expect(current(f, session.id)).toMatchObject({ outcome: 'merged', state: 'closed' });
  expect(head(f)).toBe(landed);
  expect(git(f.source, 'branch', '--show-current').trim()).toBe('main');
});

it('commits the uncommitted files of a folder session under its title before it lands', async () => {
  const f = await workbenchFixture();
  await withGate(f);
  const session = await folderSession(f, script({ write: { path: 'draft.txt', text: 'draft\n' } }));
  const before = head(f);
  await land(f, session.id);
  expect(git(f.source, 'status', '--porcelain').trim()).toBe('');
  expect(git(f.source, 'log', '-1', '--format=%s').trim()).toBe(session.title);
  expect(head(f)).not.toBe(before);
  // The commit moved HEAD off what the gates checked, so they run again before it lands.
  expect(current(f, session.id)).toMatchObject({
    merge: { state: 'blocked', reason: 'gate_required' },
  });
  expect(current(f, session.id).outcome).toBeUndefined();
  await runGates(f, session.id);
  await land(f, session.id);
  expect(current(f, session.id).outcome).toBe('merged');
});

it('discards a new folder session without touching its files', async () => {
  const f = await workbenchFixture();
  const session = await folderSession(f, script({ write: { path: 'kept.txt', text: 'kept\n' } }));
  await f.call('session.discard', { session_id: session.id }, session.revision);
  await eventually(
    () => current(f, session.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(existsSync(path.join(f.source, 'kept.txt'))).toBe(true);
  expect(f.store.must<Workspace>('workspaces', session.workspace_id!).removed_at).toBeUndefined();
  expect(f.store.pending().filter((job) => job.kind === 'workspace.remove')).toEqual([]);
});

it('opens a worktree for the next session while one writes in the folder, and frees the folder once it lands', async () => {
  const f = await workbenchFixture();
  await withGate(f);
  const writer = await folderSession(f);
  const second = await folderSession(f, 'Another change');
  expect(f.store.must<Workspace>('workspaces', second.workspace_id!).kind).toBe('linked_worktree');
  expect(second.worktree_reason).toEqual({ holder_session_id: writer.id });
  expect(f.list().find((row) => row.id === second.id)?.worktree_reason).toEqual({
    holder_session_id: writer.id,
    holder_title: writer.title,
  });
  const busy = await refusal(() => folderSession(f, 'Here', 'in_place'));
  expect(busy.code).toBe('resource_busy');
  expect(busy.message).toContain(writer.id);
  await runGates(f, writer.id);
  await land(f, writer.id);
  const third = await folderSession(f, 'After the land');
  expect(f.store.must<Workspace>('workspaces', third.workspace_id!).kind).toBe('in_place');
  expect(third.worktree_reason).toBeUndefined();
});

it('keeps an adopted session out of gates and landing while it holds the folder', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const adopted = await f.adopt();
  expect(credentialRole(adopted)).toBeUndefined();
  expect(
    (await refusal(() => f.call('session.gates.run', { session_id: adopted.id }, adopted.revision)))
      .message,
  ).toBe('A session in the user folder has no merge gate');
  const next = await folderSession(f, 'Beside it');
  expect(next.worktree_reason).toEqual({ holder_session_id: adopted.id });
});
