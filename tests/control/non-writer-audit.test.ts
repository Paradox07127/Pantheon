import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type {
  AgentEventSink,
  BoardPlan,
  Review,
  Session,
  SessionSpec,
  SessionTurn,
} from '@pantheon/domain';
import { eventually, user } from '../helpers.js';
import { gitFolderAsync, type ControlContext } from '../../packages/control/dist/context.js';
import { finishWriteAudit, startWriteAudit } from '../../packages/control/dist/non-writer-audit.js';
import { git, workbenchFixture } from './workbench-fixture.js';

/** Puts a git first on PATH that logs each call's arguments and takes a second for status. */
function slowGit() {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-slow-git-'));
  const log = path.join(directory, 'calls.log');
  writeFileSync(
    path.join(directory, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nfor arg in "$@"; do [ "$arg" = status ] && sleep 1; done\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previous}`;
  onTestFinished(() => {
    process.env.PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
}

async function auditingSession(kind: 'plan' | 'text' | 'review' | 'read-only' = 'plan') {
  const f = await workbenchFixture();
  let parent: Session | undefined;
  if (kind === 'review') {
    parent = await f.create();
    await eventually(
      () => f.turns(parent!.id)[0]?.state === 'completed',
      () => f.control.tick(),
    );
    const cwd = f.start.mock.calls[0]![0].cwd;
    writeFileSync(path.join(cwd, 'answer.txt'), 'a change to review\n');
    git(cwd, 'commit', '--quiet', '-am', 'Update the answer');
  }
  let spec!: SessionSpec,
    emit!: AgentEventSink,
    turnId = '',
    sequence = 0;
  f.start.mockImplementation(async (input, sink) => {
    spec = input;
    emit = sink;
    return {
      platform_session_id: input.platform_session_id,
      native_session_id: `native-${input.platform_session_id}`,
      adapter_version: '1',
      device_id: 'local',
    };
  });
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => {
    turnId = turn.turn_id;
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  const stopped = async (_handle: unknown, deadline: number) => ({
    stopped: true,
    deadline,
    finished_at: new Date().toISOString(),
    evidence: { method: 'none' as const, members: [] },
  });
  vi.spyOn(f.adapter, 'close').mockImplementation(stopped);
  vi.spyOn(f.adapter, 'cancel').mockImplementation(stopped);
  let session: Session;
  if (kind === 'review') {
    f.control.adapters.set('fixture-reviewer', f.adapter);
    const review = await f.call<Review>('review.request', {
      session_id: parent!.id,
      runtimes: ['fixture-reviewer'],
    });
    session = f.store.must<Session>('sessions', review.session_ids[0]!);
  } else if (kind === 'text') {
    session = f.store.insert<Session>('sessions', {
      id: 'conversation',
      revision: 1,
      project_id: f.project.id,
      runtime: 'fixture',
      state: 'running',
      turn_count: 1,
    });
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id: 'conversation-turn',
      revision: 1,
      session_id: session.id,
      project_id: f.project.id,
      model: null,
      input: 'Explain the code',
      kind: 'send',
      delivery: 'pending',
      state: 'queued',
    });
    f.store.enqueue('session.turn', { turn_id: turn.id });
  } else {
    session = await f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: 'fixture',
      input: 'Plan the change',
      permission_mode: kind === 'plan' ? 'plan' : 'ask',
    });
    if (kind === 'read-only')
      f.store.insert<BoardPlan>('board_plans', {
        id: session.id,
        revision: 1,
        project_id: f.project.id,
        plan_version: 1,
        headline: 'A pending task',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [
          {
            id: 'export',
            title: 'Export',
            goal: 'Build export',
            lane: 'core',
            depends_on: [],
            source: ['Export requested'],
            scope: ['answer.txt'],
            acceptance: ['pnpm test'],
          },
        ],
        pending_edits: [],
        risks: [],
        assumptions: [],
        inbox: [],
        notified: {},
        updated_at: f.store.now(),
      });
  }
  await eventually(
    () => turnId !== '',
    () => f.control.tick(),
  );
  const events = () =>
    f.store
      .events()
      .filter(
        (event) => event.aggregate_id === session.id && event.kind === 'session.write_detected',
      );
  const alerts = () =>
    f.control
      .needsYou(user, f.project.id)
      .items.filter(
        (item) =>
          item.source.id === session.id && String(item.reason) === 'non_writer_write_detected',
      );
  const finish = async (status: 'completed' | 'failed' | 'interrupted' = 'completed') => {
    emit({
      key: String(++sequence),
      provider_sequence: sequence,
      turn_id: turnId,
      kind: 'turn.completed',
      status,
    });
    await eventually(
      () =>
        !['queued', 'running'].includes(f.store.must<SessionTurn>('session_turns', turnId).state),
    );
  };
  const send = async (input: string) => {
    const previous = turnId;
    f.call(
      'session.send',
      { session_id: session.id, input },
      f.store.must<Session>('sessions', session.id).revision,
    );
    await eventually(
      () => turnId !== previous,
      () => f.control.tick(),
    );
  };
  return {
    ...f,
    session,
    spec,
    events,
    alerts,
    finish,
    send,
    audits: () =>
      f.store
        .events()
        .filter(
          (event) => event.aggregate_id === session.id && event.kind === 'session.write_audited',
        ),
    tool: (name: string, input?: unknown) =>
      emit({
        key: String(++sequence),
        provider_sequence: sequence,
        turn_id: turnId,
        kind: 'tool.started',
        tool_call_id: `tool-${sequence}`,
        name,
        input,
      }),
  };
}

it.each(['plan', 'text', 'read-only'] as const)(
  'flags a %s session that silently changes a tracked file',
  async (kind) => {
    const f = await auditingSession(kind);
    const file = path.join(f.spec.cwd, 'answer.txt');
    writeFileSync(file, 'changed without a permission request\n');
    await f.finish();
    expect(f.events()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ paths: expect.arrayContaining([file]) }),
      }),
    ]);
    expect(f.alerts()).toEqual([
      expect.objectContaining({ kind: 'session.failed', reason: 'non_writer_write_detected' }),
    ]);
  },
);

// Protected entries are kept out by the runtime sandbox, so the audit only reports tracked project files.
it.each(['completed', 'failed', 'interrupted'] as const)(
  'audits tracked files but not protected files when a session ends with %s',
  async (status) => {
    const f = await auditingSession();
    const tracked = path.join(f.spec.cwd, 'answer.txt');
    const file = path.join(f.protectionPaths.home, '.zshrc');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'unapproved startup command\n');
    writeFileSync(tracked, 'changed without a permission request\n');
    await f.finish(status);
    expect(f.events()).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ paths: [tracked] }) }),
    ]);
    expect(f.alerts()).toHaveLength(1);
  },
);

it('leaves protected entries to the sandbox and never reads them', async () => {
  const f = await auditingSession();
  const directory = path.join(f.protectionPaths.home, '.claude');
  const file = path.join(f.protectionPaths.home, '.zshrc');
  mkdirSync(directory, { recursive: true });
  const unreadable = path.join(directory, 'unreadable.json');
  writeFileSync(unreadable, 'reading this fails');
  chmodSync(unreadable, 0o000);
  writeFileSync(file, 'unapproved startup command\n');
  await f.finish();
  expect(f.audits()).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ paths: [], tools: [] }) }),
  ]);
  expect(f.events()).toEqual([]);
});

it('reports tracked files that were modified or deleted', async () => {
  const f = await auditingSession();
  const modified = path.join(f.spec.cwd, 'answer.txt');
  const deleted = path.join(f.spec.cwd, 'notes.txt');
  await f.finish();
  writeFileSync(deleted, 'tracked notes\n');
  git(f.spec.cwd, 'add', 'notes.txt');
  git(f.spec.cwd, 'commit', '--quiet', '-m', 'Add notes');
  await f.send('Look again');
  writeFileSync(modified, 'changed\n');
  unlinkSync(deleted);
  await f.finish();
  expect(f.events()).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({ paths: [modified, deleted].sort() }),
    }),
  ]);
});

it.each([
  ['reports', true],
  ['ignores', false],
] as const)('%s a file that was already dirty when the turn started', async (_, change) => {
  const f = await auditingSession();
  await f.finish();
  const file = path.join(f.spec.cwd, 'answer.txt');
  writeFileSync(file, 'dirty before the turn\n');
  await f.send('Look again');
  if (change) writeFileSync(file, 'changed during the turn, same status\n');
  await f.finish();
  expect(f.audits().at(-1)).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({ paths: change ? [file] : [] }),
    }),
  );
});

it('checks only tool calls against a snapshot recorded in the old hashed format', async () => {
  const f = await auditingSession();
  const file = path.join(f.spec.cwd, 'answer.txt');
  const session = f.store.must<Session>('sessions', f.session.id);
  f.store.event('session.write_snapshot', session, session.project_id, {
    turn_id: f.turns(session.id)[0]!.id,
    files: [file],
    protected_paths: [path.join(f.protectionPaths.home, '.zshrc')],
    excluded_paths: [],
    hashes: { [file]: 'an outdated hash' },
  });
  f.tool('Write', { path: file });
  await f.finish();
  expect(f.audits()).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ paths: [], tools: ['Write'] }) }),
  ]);
});

// The reviewer artifact folder is a protected entry outside git, so only the write tool is reported.
it('keeps a reviewer write alert after the artifact directory is removed', async () => {
  const f = await auditingSession('review');
  const file = path.join(f.spec.cwd, 'changes.diff');
  f.tool('Write', { path: file });
  writeFileSync(file, 'a reviewer changed its input\n');
  await f.finish();
  await f.control.tick();
  expect(f.events()).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ paths: [], tools: ['Write'] }) }),
  ]);
  expect(f.alerts()).toHaveLength(1);
});

it.each([
  'Write',
  'Edit',
  'apply_patch',
  'fileChange',
  'edit',
  'delete',
  'move',
  'execute',
  'Write /tmp/answer.txt',
  'Edit answer.txt',
  'mcp__filesystem__write_file',
])('finds %s calls in the trace even if file contents were restored', async (name) => {
  const f = await auditingSession();
  const file = path.join(f.spec.cwd, 'answer.txt');
  const original = readFileSync(file);
  f.tool(name, { path: file });
  writeFileSync(file, 'temporary write');
  writeFileSync(file, original);
  await f.finish();
  expect(f.events()).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ tools: [name], paths: [] }) }),
  ]);
  expect(f.alerts()).toHaveLength(1);
});

it('detects deleted tracked files without hashing unrelated untracked files', async () => {
  const f = await auditingSession();
  const file = path.join(f.spec.cwd, 'answer.txt');
  writeFileSync(path.join(f.spec.cwd, 'untracked.txt'), 'outside the cheap snapshot');
  unlinkSync(file);
  await f.finish();
  expect(f.events()).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ paths: [file] }) }),
  ]);
});

it('records a clean audit for reads and ignores untracked files in the cwd', async () => {
  const f = await auditingSession('text');
  f.tool('Read', { path: path.join(f.spec.cwd, 'answer.txt') });
  writeFileSync(path.join(f.spec.cwd, 'untracked.txt'), 'not part of the tracked snapshot');
  await f.finish();
  expect(
    f.store
      .events()
      .filter(
        (event) => event.aggregate_id === f.session.id && event.kind === 'session.write_audited',
      ),
  ).toHaveLength(1);
  expect(f.events()).toEqual([]);
  expect(f.alerts()).toEqual([]);
});

it('snapshots before runtime startup and skips writer turns after plan mode ends', async () => {
  const f = await workbenchFixture();
  f.start.mockImplementationOnce(async (spec, emit) => {
    writeFileSync(path.join(spec.cwd, 'answer.txt'), 'startup write\n');
    return f.adapter.start(spec, emit);
  });
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: 'fixture',
    input: 'Explain',
    permission_mode: 'plan',
  });
  await eventually(
    () => f.turns(session.id)[0]?.state === 'completed',
    () => f.control.tick(),
  );
  expect(
    f.store
      .events()
      .filter(
        (event) => event.aggregate_id === session.id && event.kind === 'session.write_detected',
      ),
  ).toHaveLength(1);
  const current = f.store.must<Session>('sessions', session.id);
  const writable = f.store.update(
    'sessions',
    { ...current, permission_mode: 'ask' as const },
    current.revision,
  );
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Now write' },
    writable.revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', turn.id).state === 'completed',
    () => f.control.tick(),
  );
  const snapshots = f.store
    .events()
    .filter(
      (event) => event.aggregate_id === session.id && event.kind === 'session.write_snapshot',
    );
  expect(snapshots).toHaveLength(1);
  expect(git(f.source, 'status', '--porcelain')).toBe('');
});

it('keeps answering other work while the audit waits on git status', async () => {
  const f = await auditingSession();
  const ctx = { store: f.store } as ControlContext;
  slowGit();
  for (const audit of [
    () => startWriteAudit(ctx, f.spec, 'a later turn', true),
    () => finishWriteAudit(ctx, f.session.id),
  ]) {
    const order: string[] = [];
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => resolve(void order.push('timer')), 50),
    );
    await audit();
    order.push('audit');
    await timer;
    expect(order).toEqual(['timer', 'audit']);
  }
});

it('audits a reconciled session closed by session.resolve while other work goes on', async () => {
  const f = await auditingSession();
  await f.finish();
  const file = path.join(f.spec.cwd, 'answer.txt');
  writeFileSync(file, 'changed while the daemon was down\n');
  const session = f.store.must<Session>('sessions', f.session.id);
  const reconciling = f.store.update(
    'sessions',
    { ...session, state: 'reconciling' as const, process_identity: { pid: 2_000_000_000 } },
    session.revision,
  );
  slowGit();
  let fired = false;
  const timer = setTimeout(() => (fired = true), 50);
  onTestFinished(() => clearTimeout(timer));
  await f.call(
    'session.resolve',
    { session_id: session.id, choice: 'close' },
    reconciling.revision,
  );
  expect(fired).toBe(true);
  expect(f.store.must<Session>('sessions', session.id).state).toBe('closed');
  expect(f.events().at(-1)).toEqual(
    expect.objectContaining({ payload: expect.objectContaining({ paths: [file] }) }),
  );
});

it('asks git once per root until its .git entry changes', async () => {
  const calls = slowGit();
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-git-folder-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const lookups = () => calls().filter((call) => call.endsWith(' rev-parse --show-toplevel'));
  expect([await gitFolderAsync(root), await gitFolderAsync(root)]).toEqual([false, false]);
  expect(lookups()).toHaveLength(1);
  git(root, 'init', '--quiet');
  expect(await gitFolderAsync(root)).toBe(true);
  expect(lookups()).toHaveLength(2);
});
