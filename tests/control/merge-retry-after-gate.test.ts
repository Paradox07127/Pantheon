import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as validation from '../../packages/control/dist/validation-executor.js';
import type { Project, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

afterEach(() => {
  vi.restoreAllMocks();
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

const payloads = (f: Fixture, sessionId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(sessionId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

function commit(repository: string, name: string, contents: string) {
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

function gateResult(exitCode: number): validation.ValidationResult {
  return {
    exit_code: exitCode,
    signal: null,
    duration_ms: 5,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: exitCode === 0 ? 'passed' : 'failed',
    timedOut: false,
    stdout_sha256: '',
    stderr_sha256: '',
    output_truncated: false,
    boundary: {
      kind: 'macos-seatbelt',
      network: 'loopback',
      supported: true,
      stop_scope: 'process-group',
    },
  };
}

/**
 * An idle session with one commit whose merge a failed gate blocked; later gate runs pass unless
 * queued otherwise.
 */
async function blockedByGate(f: Fixture) {
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'completed' && current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  await f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands: [{ name: 'Tests', argv: ['check'] }] },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const head = commit(workspace.path, 'answer.txt', 'checked\n');
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(gateResult(0))
    .mockResolvedValueOnce(gateResult(1));
  await f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
  return { session, workspace, head, execute };
}

/** Runs the session's gates and waits until the run and the work it started have ended. */
async function runGatesToEnd(f: Fixture, sessionId: string) {
  const { completions } = f.control['ctx'] as { completions: Set<Promise<unknown>> },
    before = new Set(completions);
  await f.call('session.gates.run', { session_id: sessionId }, current(f, sessionId).revision);
  await eventually(
    () => !f.control.sessionGates(user, sessionId).running,
    () => f.control.tick(),
    10000,
  );
  for (;;) {
    const started = [...completions].filter((work) => !before.has(work));
    if (!started.length) break;
    await Promise.allSettled(started);
    for (const work of started) before.add(work);
  }
  await f.control.tick();
}

it('merges a gate-blocked session once a later gate run passes on the same commit', async () => {
  const f = await workbenchFixture();
  const { session, head } = await blockedByGate(f);
  await f.call('session.gates.run', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(head);
  expect(payloads(f, session.id, 'session.merge_started')).toEqual([
    {},
    { reason: 'gates_passed' },
  ]);
});

it('keeps the merge blocked when the gates pass on a newer commit', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await blockedByGate(f);
  commit(workspace.path, 'later.txt', 'later\n');
  await runGatesToEnd(f, session.id);
  expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
  expect(payloads(f, session.id, 'session.merge_started')).toHaveLength(1);
});

it('keeps a cancelled merge blocked when the gates pass on the commit they failed on', async () => {
  const f = await workbenchFixture();
  const { session, execute } = await blockedByGate(f);
  let release!: (result: validation.ValidationResult) => void;
  execute.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
  await f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => execute.mock.calls.length === 2,
    () => f.control.tick(),
    10000,
  );
  f.call('session.merge.cancel', { session_id: session.id }, current(f, session.id).revision);
  release(gateResult(0));
  await eventually(
    () => current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  expect(current(f, session.id).merge).toMatchObject({ reason: 'cancelled' });
  await runGatesToEnd(f, session.id);
  expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'cancelled' });
  expect(payloads(f, session.id, 'session.merge_started')).toHaveLength(2);
});

it('keeps the merge of an archived session blocked when the gates pass', async () => {
  const f = await workbenchFixture();
  const { session } = await blockedByGate(f);
  f.call('session.archive', { session_id: session.id }, current(f, session.id).revision);
  await runGatesToEnd(f, session.id);
  expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
  expect(payloads(f, session.id, 'session.merge_started')).toHaveLength(1);
});

it('retries only once when the retried merge fails its gate again', async () => {
  const f = await workbenchFixture();
  const { session, execute } = await blockedByGate(f);
  execute.mockResolvedValueOnce(gateResult(0)).mockResolvedValueOnce(gateResult(1));
  await runGatesToEnd(f, session.id);
  await eventually(
    () =>
      payloads(f, session.id, 'session.merge_started').length === 2 &&
      current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  expect(current(f, session.id).merge).toMatchObject({ reason: 'gate_failed' });
  await runGatesToEnd(f, session.id);
  expect(execute).toHaveBeenCalledTimes(4);
  expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
  expect(payloads(f, session.id, 'session.merge_started')).toHaveLength(2);
});
