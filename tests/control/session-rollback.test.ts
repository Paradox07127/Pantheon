import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { DomainError, type Session, type SessionTurn, type Workspace } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { releaseIdleConversation } from '../../packages/control/dist/session.js';
import { queueTurn } from '../../packages/control/dist/session-wake.js';
import { eventually, settle } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const HANDOFF_LINE =
  '[Pantheon] You continue work that a fixture session did in this worktree. Its record follows, cut to fit; entries left out are marked. Check the files and git log for anything it does not show.';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const worktree = (f: Fixture, session: Session) =>
  f.store.must<Workspace>('workspaces', session.workspace_id!).path;
const events = (f: Fixture, kind: string) =>
  f.store.events(0, undefined, 10000).filter((event) => event.kind === kind);

async function send(f: Fixture, session: Session, input: string) {
  f.call('session.send', { session_id: session.id, input }, current(f, session.id).revision);
  await settle(f, session);
  return f.turns(session.id).at(-1)!;
}

const rollback = (f: Fixture, session: Session, turnId: string) =>
  f.call<Session>(
    'session.rollback',
    { session_id: session.id, turn_id: turnId },
    current(f, session.id).revision,
  );

async function refusal(run: () => unknown): Promise<DomainError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('Expected a refusal');
}

/** A rollback of an idle session runs at once and closes the idle process. */
async function rollbackWhenIdle(f: Fixture, session: Session, turnId: string) {
  const result = rollback(f, session, turnId);
  await eventually(
    () => events(f, 'session.process_closed').some((event) => event.aggregate_id === session.id),
    () => f.control.tick(),
  );
  return result;
}

const checkpoints = (f: Fixture, sessionId: string) =>
  git(f.source, 'for-each-ref', '--format=%(refname)', 'refs/pantheon/checkpoints/')
    .split('\n')
    .filter((ref) => ref.includes(`/${sessionId}/`));
const checkpointRef = (session: Session, turnId: string) =>
  `refs/pantheon/checkpoints/${session.workspace_id}/${session.id}/${turnId}`;

it('stores a checkpoint ref before each turn and leaves the real index and HEAD alone', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const work = worktree(f, session);
  writeFileSync(path.join(work, 'staged.txt'), 'staged\n');
  git(work, 'add', 'staged.txt');
  writeFileSync(path.join(work, 'answer.txt'), 'changed\n');
  writeFileSync(path.join(work, 'untracked.txt'), 'untracked\n');
  const head = git(work, 'rev-parse', 'HEAD'),
    staged = git(work, 'diff', '--cached', '--name-status'),
    status = git(work, 'status', '--porcelain');

  const second = await send(f, session, 'Add a header row');

  const [first] = f.turns(session.id);
  expect(checkpoints(f, session.id).sort()).toEqual(
    [first!.id, second.id].map((turn) => checkpointRef(session, turn)).sort(),
  );
  expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(work, 'diff', '--cached', '--name-status')).toBe(staged);
  expect(git(work, 'status', '--porcelain')).toBe(status);
  const ref = checkpointRef(session, second.id);
  expect(git(work, 'rev-parse', `${ref}^`)).toBe(head);
  expect(git(work, 'show', `${ref}:answer.txt`)).toBe('changed');
  expect(git(work, 'show', `${ref}:staged.txt`)).toBe('staged');
  expect(git(work, 'show', `${ref}:untracked.txt`)).toBe('untracked');
});

/** Two turns: the first commits files, the second deletes, writes and commits more. */
async function twoTurns() {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const work = worktree(f, session);
  writeFileSync(path.join(work, '.gitignore'), '*.log\n');
  writeFileSync(path.join(work, 'kept.txt'), 'kept\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'Export started');
  writeFileSync(path.join(work, 'notes.txt'), 'notes\n');
  const head = git(work, 'rev-parse', 'HEAD');

  const second = await send(f, session, 'Add a header row');
  rmSync(path.join(work, 'kept.txt'));
  rmSync(path.join(work, 'notes.txt'));
  writeFileSync(path.join(work, 'answer.txt'), 'header\n');
  mkdirSync(path.join(work, 'build'));
  writeFileSync(path.join(work, 'build/out.txt'), 'out\n');
  writeFileSync(path.join(work, 'later.txt'), 'later\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'Header added');
  writeFileSync(path.join(work, 'loose.txt'), 'loose\n');
  writeFileSync(path.join(work, 'debug.log'), 'ignored\n');
  return { f, session, work, head, second };
}

it('puts the worktree and its detached HEAD back to the state before the turn', async () => {
  const { f, session, work, head, second } = await twoTurns();

  await rollbackWhenIdle(f, session, second.id);

  const read = (name: string) => readFileSync(path.join(work, name), 'utf8');
  expect(read('answer.txt')).toBe('base\n');
  expect(read('kept.txt')).toBe('kept\n');
  expect(read('notes.txt')).toBe('notes\n');
  expect(read('debug.log')).toBe('ignored\n');
  for (const gone of ['later.txt', 'loose.txt', 'build'])
    expect(existsSync(path.join(work, gone))).toBe(false);
  expect(() => git(work, 'symbolic-ref', '-q', 'HEAD')).toThrow();
  expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(work, 'diff', '--cached', '--name-only')).toBe('');
  expect(git(work, 'status', '--porcelain')).toBe('?? notes.txt');
  expect(
    events(f, 'session.rolled_back')
      .filter((event) => event.aggregate_id === session.id)
      .map((event) => event.payload),
  ).toEqual([{ turn_id: second.id, head }]);
});

it('starts the next turn in a fresh native conversation with the record before the rolled back turn', async () => {
  const { f, session, second } = await twoTurns();
  const oldNative = current(f, session.id).native_id;
  expect(oldNative).toBeDefined();

  await rollbackWhenIdle(f, session, second.id);
  expect(current(f, session.id).native_id).toBeUndefined();
  const delivered = vi.spyOn(f.adapter, 'send');

  const next = await send(f, session, 'Add a footer row');
  expect(next.input).toBe('Add a footer row');
  expect(next.handoff!.split('\n')[0]).toBe(HANDOFF_LINE);
  expect(next.handoff).toContain('Start the export');
  expect(next.handoff).not.toContain('Add a header row');
  expect(delivered.mock.calls.map(([, turn]) => turn.input)).toEqual([
    `${next.handoff}\n\nAdd a footer row`,
  ]);
  expect(next.state).toBe('completed');
  const after = current(f, session.id);
  expect(after.handoff_before_turn_id).toBeUndefined();
  expect(after.native_id).toBeDefined();
  expect(after.native_id).not.toBe(oldNative);

  const later = await send(f, session, 'Add a summary row');
  expect(later.input).toBe('Add a summary row');
  expect(later.handoff).toBeUndefined();
  expect(delivered.mock.calls.at(-1)![1].input).toBe('Add a summary row');
});

it('marks the rolled back turn and the turns after it, and leaves them out of a later handoff', async () => {
  const { f, session, second } = await twoTurns();
  const third = await send(f, session, 'Add a footer row');
  const [first] = f.turns(session.id);

  await rollbackWhenIdle(f, session, second.id);

  const marked = (turnId: string) => f.store.must<SessionTurn>('session_turns', turnId).rolled_back;
  expect(marked(first!.id)).toBeUndefined();
  expect(marked(second.id)).toBe(true);
  expect(marked(third.id)).toBe(true);

  const next = await send(f, session, 'Add a summary row');
  expect(next.rolled_back).toBeUndefined();
  expect(next.handoff).toContain('Start the export');
  expect(next.handoff).not.toContain('Add a header row');
  expect(next.handoff).not.toContain('Add a footer row');
});

it('gives the record before the rolled back turn to the next turn the task tracker queues', async () => {
  const { f, session, second } = await twoTurns();
  await rollbackWhenIdle(f, session, second.id);

  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  f.store.transaction(() => {
    queueTurn(
      ctx,
      current(f, session.id),
      'Continue the export',
      'tracker',
      'tracker-continuation',
    );
  });
  await settle(f, session);

  const next = f.turns(session.id).at(-1)!;
  expect(next.origin).toBe('tracker');
  expect(next.input).toBe('Continue the export');
  expect(next.handoff!.split('\n')[0]).toBe(HANDOFF_LINE);
  expect(next.handoff).toContain('Start the export');
  expect(next.handoff).not.toContain('Add a header row');
  expect(next.state).toBe('completed');
  expect(current(f, session.id).handoff_before_turn_id).toBeUndefined();

  const later = await send(f, session, 'Add a summary row');
  expect(later.input).toBe('Add a summary row');
});

/** The state a finished rollback to the second turn leaves, and a next turn in a fresh conversation. */
async function expectRolledBack(
  f: Fixture,
  session: Session,
  work: string,
  head: string,
  second: SessionTurn,
  oldNative: string | undefined,
) {
  const after = current(f, session.id);
  expect(after.rollback_pending).toBeUndefined();
  expect(after.native_id).toBeUndefined();
  expect(after.handoff_before_turn_id).toBe(second.id);
  expect(readFileSync(path.join(work, 'answer.txt'), 'utf8')).toBe('base\n');
  expect(existsSync(path.join(work, 'later.txt'))).toBe(false);
  expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
  expect(f.store.must<SessionTurn>('session_turns', second.id).rolled_back).toBe(true);
  expect(
    events(f, 'session.rolled_back')
      .filter((event) => event.aggregate_id === session.id)
      .map((event) => event.payload),
  ).toEqual([{ turn_id: second.id, head }]);
  const next = await send(f, session, 'Add a footer row');
  expect(next.state).toBe('completed');
  expect(next.handoff).toContain('Start the export');
  expect(next.handoff).not.toContain('Add a header row');
  expect(current(f, session.id).native_id).not.toBe(oldNative);
}

/** Closes the idle native process the way a rollback does before it moves any file. */
async function releaseIdle(f: Fixture, session: Session) {
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  releaseIdleConversation(ctx, current(f, session.id));
  await eventually(
    () => events(f, 'session.process_closed').some((event) => event.aggregate_id === session.id),
    () => f.control.tick(),
  );
}

it('keeps the rollback intent and refuses input when the rollback record fails to commit, then recover finishes it', async () => {
  const { f, session, work, head, second } = await twoTurns();
  const oldNative = current(f, session.id).native_id;
  const checkpoint = git(work, 'rev-parse', checkpointRef(session, second.id));
  const failpoint = vi.spyOn(f.control, 'failpoint').mockImplementation((name) => {
    if (name === 'before_transaction_commit') throw new Error('Store write failed');
  });

  await expect(rollback(f, session, second.id)).rejects.toThrow('Store write failed');
  failpoint.mockRestore();
  await eventually(
    () => events(f, 'session.process_closed').some((event) => event.aggregate_id === session.id),
    () => f.control.tick(),
  );

  const failed = current(f, session.id);
  expect(failed.rollback_pending).toEqual({ checkpoint, turn_id: second.id });
  expect(failed.native_id).toBe(oldNative);
  expect(events(f, 'session.rolled_back')).toEqual([]);
  const refused = await refusal(() =>
    f.call('session.send', { session_id: session.id, input: 'Add a footer row' }, failed.revision),
  );
  expect(refused.code).toBe('rollback_in_progress');

  await f.restart();
  await expectRolledBack(f, session, work, head, second, oldNative);
});

it('finishes on restart a rollback that stopped right after its intent was written', async () => {
  const { f, session, work, head, second } = await twoTurns();
  const oldNative = current(f, session.id).native_id;
  const checkpoint = git(work, 'rev-parse', checkpointRef(session, second.id));
  await releaseIdle(f, session);
  const before = current(f, session.id);
  f.store.update(
    'sessions',
    { ...before, rollback_pending: { checkpoint, turn_id: second.id } },
    before.revision,
  );

  await f.restart();
  await expectRolledBack(f, session, work, head, second, oldNative);
});

it('drops a rollback intent whose checkpoint is gone and reconciles the session', async () => {
  const { f, session, work, second } = await twoTurns();
  const oldNative = current(f, session.id).native_id;
  await releaseIdle(f, session);
  const before = current(f, session.id);
  f.store.update(
    'sessions',
    { ...before, rollback_pending: { checkpoint: '1'.repeat(40), turn_id: second.id } },
    before.revision,
  );

  await f.restart();

  const after = current(f, session.id);
  expect(after.rollback_pending).toBeUndefined();
  expect(after.native_id).toBe(oldNative);
  expect(after.state).toBe('reconciling');
  expect(readFileSync(path.join(work, 'answer.txt'), 'utf8')).toBe('header\n');
  expect(
    events(f, 'session.reconciling').filter((event) => event.aggregate_id === session.id),
  ).toHaveLength(1);
  expect(events(f, 'session.rolled_back')).toEqual([]);
});

it('keeps files that the ignore rules ignore now or ignored at the checkpoint', async () => {
  const { f, session, work, second } = await twoTurns();
  // The checkpoint ignored *.log; now local-secrets/ is ignored instead.
  writeFileSync(path.join(work, '.gitignore'), 'local-secrets/\n');
  mkdirSync(path.join(work, 'local-secrets'));
  writeFileSync(path.join(work, 'local-secrets/token.txt'), 'TOKEN=secret\n');

  await rollbackWhenIdle(f, session, second.id);

  const read = (name: string) => readFileSync(path.join(work, name), 'utf8');
  expect(read('.gitignore')).toBe('*.log\n');
  expect(read('local-secrets/token.txt')).toBe('TOKEN=secret\n');
  expect(read('debug.log')).toBe('ignored\n');
  for (const gone of ['later.txt', 'loose.txt', 'build'])
    expect(existsSync(path.join(work, gone))).toBe(false);
});

it('neither captures nor deletes files that the global git ignore rules ignore', async () => {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const home = mkdtempSync(path.join(os.tmpdir(), 'pantheon-rollback-home-'));
  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    mkdirSync(path.join(home, 'git'));
    writeFileSync(path.join(home, 'git/ignore'), '.env\n');
    const f = await workbenchFixture();
    const session = await f.create('Start the export');
    await settle(f, session);
    const work = worktree(f, session);
    const first = await send(f, session, 'Add a header row');
    writeFileSync(path.join(work, '.env'), 'TOKEN=secret\n');

    const second = await send(f, session, 'Add a footer row');

    const ref = checkpointRef(session, second.id);
    expect(git(work, 'ls-tree', '-r', '--name-only', ref).split('\n')).not.toContain('.env');
    await rollbackWhenIdle(f, session, first.id);
    expect(readFileSync(path.join(work, '.env'), 'utf8')).toBe('TOKEN=secret\n');
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(home, { recursive: true, force: true });
  }
});

it('refuses a rollback while the session runs, after it merged, and for a turn without a checkpoint', async () => {
  const { f, session, second } = await twoTurns();

  f.call(
    'session.send',
    { session_id: session.id, input: 'Add a footer row' },
    current(f, session.id).revision,
  );
  const running = await refusal(() => rollback(f, session, second.id));
  expect(running.code).toBe('invalid_state');
  expect(running.message).toMatch(/running/);
  await settle(f, session);

  const unknown = await refusal(() => rollback(f, session, 'turn-without-checkpoint'));
  expect(unknown.code).toBe('invalid_state');
  expect(unknown.message).toMatch(/checkpoint/);

  const idle = current(f, session.id);
  f.store.update('sessions', { ...idle, outcome: 'merged' as const }, idle.revision);
  const merged = await refusal(() => rollback(f, session, second.id));
  expect(merged.code).toBe('invalid_state');
  expect(merged.message).toMatch(/merged/);
  expect(events(f, 'session.rolled_back')).toEqual([]);
});

it('refuses to roll back a worktree whose HEAD points at the source branch and leaves that branch alone', async () => {
  const { f, session, work, second } = await twoTurns();
  const sourceMain = git(f.source, 'rev-parse', 'refs/heads/main');
  const sessionCommit = git(work, 'rev-parse', 'HEAD');
  git(work, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  const refused = await refusal(() => rollback(f, session, second.id));
  expect(refused.code).toBe('worktree_head_attached');
  expect(git(f.source, 'rev-parse', 'refs/heads/main')).toBe(sourceMain);
  expect(readFileSync(path.join(work, 'answer.txt'), 'utf8')).toBe('header\n');
  expect(existsSync(path.join(work, 'later.txt'))).toBe(true);
  expect(current(f, session.id).rollback_pending).toBeUndefined();
  expect(git(f.source, 'rev-parse', 'refs/heads/main')).not.toBe(sessionCommit);
  expect(events(f, 'session.rolled_back')).toEqual([]);
});

it('records a checkpoint failure instead of a checkpoint when the worktree HEAD is on a branch', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const work = worktree(f, session);
  git(work, 'switch', '--quiet', '-c', 'export-work');

  const second = await send(f, session, 'Add a header row');

  expect(second.state).toBe('completed');
  const failed = events(f, 'session.checkpoint_failed').filter(
    (event) => event.aggregate_id === session.id,
  );
  expect(failed).toHaveLength(1);
  expect(String((failed[0]!.payload as { error: unknown }).error)).toMatch(/HEAD is on a branch/);
  expect(checkpoints(f, session.id)).toEqual([checkpointRef(session, f.turns(session.id)[0]!.id)]);
});

it('runs the turn and records the failure when the checkpoint cannot be stored', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const work = worktree(f, session);
  writeFileSync(
    path.join(git(work, 'rev-parse', '--absolute-git-dir'), 'HEAD'),
    `${'1'.repeat(40)}\n`,
  );

  const second = await send(f, session, 'Add a header row');

  expect(second.state).toBe('completed');
  const failed = events(f, 'session.checkpoint_failed').filter(
    (event) => event.aggregate_id === session.id,
  );
  expect(failed).toHaveLength(1);
  expect(failed[0]!.payload).toMatchObject({ turn_id: second.id });
  expect(String((failed[0]!.payload as { error: unknown }).error)).not.toBe('');
  expect(checkpoints(f, session.id)).toEqual([checkpointRef(session, f.turns(session.id)[0]!.id)]);
});

it('lists the newest turn a rollback restores, past failed checkpoints and never before a merge', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const listed = () => f.list().find((row) => row.id === session.id)!;
  const [first] = f.turns(session.id);
  expect(listed().checkpoint_turn_id).toBe(first!.id);

  const work = worktree(f, session);
  git(work, 'switch', '--quiet', '-c', 'export-work');
  await send(f, session, 'Add a header row');
  expect(listed().checkpoint_turn_id).toBe(first!.id);

  git(work, 'switch', '--quiet', '--detach');
  const idle = current(f, session.id);
  f.store.event('session.merged', idle, idle.project_id, { direct: true });
  expect(listed()).not.toHaveProperty('checkpoint_turn_id');

  const third = await send(f, session, 'Add a footer row');
  expect(listed().checkpoint_turn_id).toBe(third.id);
});

it('lists a steer that ran as its own turn as the turn a rollback restores', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const listed = () => f.list().find((row) => row.id === session.id)!;
  f.call(
    'session.steer',
    { session_id: session.id, input: 'Add a header row' },
    current(f, session.id).revision,
  );
  await settle(f, session);
  const steer = f.turns(session.id).at(-1)!;
  expect(steer.kind).toBe('steer');
  expect(checkpoints(f, session.id)).toContain(checkpointRef(session, steer.id));
  expect(listed().checkpoint_turn_id).toBe(steer.id);
});

it('lists no turn to roll back to for a discarded session', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const listed = () => f.list().find((row) => row.id === session.id)!;
  expect(listed().checkpoint_turn_id).toBe(f.turns(session.id)[0]!.id);

  f.call('session.discard', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(listed()).not.toHaveProperty('checkpoint_turn_id');
});

it.each([
  ['deletes the checkpoint refs of a session when its worktree is removed', 'session.discard'],
  [
    'deletes the checkpoint refs of a deleted session once its worktree is removed',
    'session.delete',
  ],
] as const)('%s', async (_, command) => {
  const f = await workbenchFixture();
  const kept = await f.create('Keep this session');
  await settle(f, kept);
  const session = await f.create('Start the export');
  await settle(f, session);
  await send(f, session, 'Add a header row');
  expect(checkpoints(f, session.id)).toHaveLength(2);

  f.call(command, { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => f.store.must<Workspace>('workspaces', session.workspace_id!).removed_at !== undefined,
    () => f.control.tick(),
  );

  if (command === 'session.delete')
    expect(f.store.get<Session>('sessions', session.id)).toBeUndefined();
  expect(checkpoints(f, session.id)).toEqual([]);
  expect(checkpoints(f, kept.id)).toHaveLength(1);
});
