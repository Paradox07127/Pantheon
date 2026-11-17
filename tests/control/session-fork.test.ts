import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { Session, SessionTurn, Workspace } from '@pantheon/domain';
import { eventually, settle, user } from '../helpers.js';
import { dispatchEveryTier, git, gitRuns, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
const current = (f: Fixture, session: Session) => f.store.must<Session>('sessions', session.id);
const workspace = (f: Fixture, session: Session) =>
  f.store.must<Workspace>('workspaces', session.workspace_id!);
const checkpoint = (session: Session, turn: SessionTurn) =>
  `refs/pantheon/checkpoints/${session.workspace_id}/${session.id}/${turn.id}`;

async function send(f: Fixture, session: Session, input: string) {
  f.call('session.send', { session_id: session.id, input }, current(f, session).revision);
  await settle(f, session);
  return f.turns(session.id).at(-1)!;
}

const fork = (f: Fixture, session: Session, before_turn_id?: string, extras = {}) =>
  f.call<Session>('session.fork', {
    session_id: session.id,
    before_turn_id,
    input: 'Try another export',
    ...extras,
  });

it('forks checkpoint files, index and HEAD while leaving a running source and its turns unchanged', async () => {
  const f = await workbenchFixture();
  const source = await f.create('Start the export');
  await settle(f, source);
  const work = workspace(f, source).path;
  writeFileSync(path.join(work, 'answer.txt'), 'committed\n');
  git(work, 'commit', '--quiet', '-am', 'Export started');
  const head = git(work, 'rev-parse', 'HEAD');
  writeFileSync(path.join(work, 'answer.txt'), 'checkpoint\n');
  writeFileSync(path.join(work, 'notes.txt'), 'checkpoint notes\n');
  git(work, 'add', 'answer.txt');
  const second = await send(f, source, 'Add a header');
  writeFileSync(path.join(work, 'answer.txt'), 'later\n');
  rmSync(path.join(work, 'notes.txt'));
  git(work, 'commit', '--quiet', '-am', 'Header added');
  f.call(
    'session.send',
    { session_id: source.id, input: 'fixture-script\n[{"hang":true}]' },
    current(f, source).revision,
  );
  await eventually(
    () => f.turns(source.id).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
  const sourceBefore = current(f, source);
  const turnsBefore = f.turns(source.id);
  const status = git(work, 'status', '--porcelain');
  const sourceHead = git(work, 'rev-parse', 'HEAD');
  const branch = await fork(f, source, second.id);
  await settle(f, branch);
  const branched = workspace(f, branch).path;
  expect(readFileSync(path.join(branched, 'answer.txt'), 'utf8')).toBe('checkpoint\n');
  expect(readFileSync(path.join(branched, 'notes.txt'), 'utf8')).toBe('checkpoint notes\n');
  expect(git(branched, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(branched, 'diff', '--cached', '--name-only')).toBe('');
  expect(() => git(branched, 'symbolic-ref', '-q', 'HEAD')).toThrow();
  expect(current(f, source)).toEqual(sourceBefore);
  expect(f.turns(source.id)).toEqual(turnsBefore);
  expect(git(work, 'status', '--porcelain')).toBe(status);
  expect(git(work, 'rev-parse', 'HEAD')).toBe(sourceHead);
});

it('delivers only the record before the chosen turn together with attachments and skills', async () => {
  const f = await workbenchFixture();
  const source = await f.create('Start the export');
  await settle(f, source);
  const second = await send(f, source, 'Add a header');
  await send(f, source, 'Add a footer');
  const attachment = f.control.addAttachment(
    user,
    f.project.id,
    'notes.txt',
    'text/plain',
    new TextEncoder().encode('notes'),
  );
  const skills = [{ name: 'review', path: '/skills/review/SKILL.md' }];
  const sent = vi.spyOn(f.adapter, 'send');
  const branch = await fork(f, source, second.id, { attachments: [attachment.id], skills });
  await settle(f, branch);
  const first = f.turns(branch.id)[0]!;
  expect(first.handoff).toContain('User:\nStart the export');
  expect(first.handoff).not.toContain('Add a header');
  expect(first.handoff).not.toContain('Add a footer');
  expect(sent.mock.calls[0]![1]).toMatchObject({
    input: `${first.handoff}\n\nTry another export`,
    skills,
    attachments: [{ id: attachment.id }],
  });
  expect(current(f, branch).native_id).not.toBe(current(f, source).native_id);
});

it("freezes current uncommitted and untracked files without the source worktree's ignored files, copies the project dependencies and leaves the source index alone", async () => {
  const f = await workbenchFixture();
  const source = await f.create('Start the export');
  await settle(f, source);
  const work = workspace(f, source).path;
  writeFileSync(path.join(work, '.gitignore'), '*.log\nnode_modules/\n');
  writeFileSync(path.join(f.source, '.gitignore'), 'node_modules/\n');
  mkdirSync(path.join(f.source, 'node_modules'));
  writeFileSync(path.join(f.source, 'node_modules', 'ignored.txt'), 'ignored dependency\n');
  writeFileSync(path.join(work, 'answer.txt'), 'staged\n');
  git(work, 'add', '-A');
  writeFileSync(path.join(work, 'answer.txt'), 'unstaged\n');
  writeFileSync(path.join(work, 'notes.txt'), 'untracked\n');
  writeFileSync(path.join(work, 'debug.log'), 'ignored\n');
  await send(f, source, 'Keep the entire record');
  const head = git(work, 'rev-parse', 'HEAD');
  const staged = git(work, 'diff', '--cached');
  const branch = await fork(f, source);
  writeFileSync(path.join(work, 'answer.txt'), 'changed after fork\n');
  await settle(f, branch);
  const branched = workspace(f, branch).path;
  expect(readFileSync(path.join(branched, 'answer.txt'), 'utf8')).toBe('unstaged\n');
  expect(readFileSync(path.join(branched, 'notes.txt'), 'utf8')).toBe('untracked\n');
  expect(existsSync(path.join(branched, 'debug.log'))).toBe(false);
  expect(readFileSync(path.join(branched, 'node_modules', 'ignored.txt'), 'utf8')).toBe(
    'ignored dependency\n',
  );
  expect(git(branched, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(work, 'diff', '--cached')).toBe(staged);
  expect(f.turns(branch.id)[0]!.handoff).toContain('Keep the entire record');
});

it('forks a running source from the end of its last completed turn and leaves the running turn going', async () => {
  const f = await workbenchFixture();
  const source = await f.create('Start the export');
  await settle(f, source);
  const work = workspace(f, source).path;
  await send(f, source, 'Add a header');
  writeFileSync(path.join(work, 'answer.txt'), 'after the header\n');
  f.call(
    'session.send',
    { session_id: source.id, input: 'fixture-script\n[{"hang":true}]' },
    current(f, source).revision,
  );
  await eventually(
    () => f.turns(source.id).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
  const running = f.turns(source.id).at(-1)!;
  writeFileSync(path.join(work, 'answer.txt'), 'while running\n');
  const turnsBefore = f.turns(source.id);
  const branch = await fork(f, source);
  await settle(f, branch);
  expect(readFileSync(path.join(workspace(f, branch).path, 'answer.txt'), 'utf8')).toBe(
    'after the header\n',
  );
  expect(current(f, branch).forked_from).toEqual({
    session_id: source.id,
    before_turn_id: running.id,
  });
  const handoff = f.turns(branch.id)[0]!.handoff;
  expect(handoff).toContain('Add a header');
  expect(handoff).not.toContain('fixture-script');
  expect(current(f, source).state).toBe('running');
  expect(f.turns(source.id)).toEqual(turnsBefore);
});

it('reads the checkpoints of every later turn of a running source with one git run', async () => {
  const f = await workbenchFixture();
  const source = await f.create('Start the export');
  await settle(f, source);
  const work = workspace(f, source).path;
  const second = await send(f, source, 'Add a footer');
  await send(f, source, 'Add a title');
  const rollback = f.call(
    'session.rollback',
    { session_id: source.id, turn_id: second.id },
    current(f, source).revision,
  );
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.process_closed'])
        .some((event) => event.aggregate_id === source.id),
    () => f.control.tick(),
  );
  await rollback;
  f.call(
    'session.send',
    { session_id: source.id, input: 'fixture-script\n[{"hang":true}]' },
    current(f, source).revision,
  );
  await eventually(
    () => f.turns(source.id).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
  // Two rolled back turns and the running one come after the last completed turn, none with a checkpoint.
  const prefix = `refs/pantheon/checkpoints/${source.workspace_id}/${source.id}/`;
  for (const ref of git(f.source, 'for-each-ref', '--format=%(refname)', prefix).split('\n'))
    if (ref) git(f.source, 'update-ref', '-d', ref);
  writeFileSync(path.join(work, 'answer.txt'), 'while running\n');
  let branch!: Session;
  const runs = await gitRuns(async () => (branch = await fork(f, source)));
  expect(runs.filter((run) => run.includes(prefix))).toHaveLength(1);
  await settle(f, branch);
  // No later turn kept a checkpoint, so the fork takes the current files.
  expect(readFileSync(path.join(workspace(f, branch).path, 'answer.txt'), 'utf8')).toBe(
    'while running\n',
  );
});

it('refuses to fork a running source whose running turn took no checkpoint', async () => {
  const f = await workbenchFixture();
  const source = await f.create('Start the export');
  await settle(f, source);
  const work = workspace(f, source).path;
  await send(f, source, 'Add a header');
  git(work, 'switch', '--quiet', '-c', 'agent-branch');
  f.call(
    'session.send',
    { session_id: source.id, input: 'fixture-script\n[{"hang":true}]' },
    current(f, source).revision,
  );
  await eventually(
    () => f.turns(source.id).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
  const running = f.turns(source.id).at(-1)!;
  expect(
    f.store
      .kindEvents(f.project.id, ['session.checkpoint_failed'])
      .some((event) => (event.payload as { turn_id: string }).turn_id === running.id),
  ).toBe(true);
  writeFileSync(path.join(work, 'answer.txt'), 'half done by the running turn\n');
  await expect(fork(f, source)).rejects.toThrow(expect.objectContaining({ code: 'invalid_state' }));
});

it('refuses a current-state fork while the first source turn is running', async () => {
  const f = await workbenchFixture({ delay: 1000 });
  const source = await f.create();
  await eventually(
    () => f.turns(source.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  await expect(fork(f, source)).rejects.toThrow(
    expect.objectContaining({
      code: 'invalid_state',
      message: 'Source session has no completed turn to fork from yet',
    }),
  );
});

it.each(['stop_pending', 'rollback_pending', 'merge'] as const)(
  'refuses a current-state fork with %s',
  async (field) => {
    const f = await workbenchFixture();
    const source = await f.create();
    await settle(f, source);
    const changes = {
      stop_pending: true,
      rollback_pending: { checkpoint: 'pending', turn_id: 'pending' },
      merge: { state: 'running' },
    };
    const before = current(f, source);
    f.store.update('sessions', { ...before, [field]: changes[field] }, before.revision);
    expect(() => fork(f, source)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  },
);

it('refuses sessions without a git worktree, foreign turns, missing checkpoints and non-user callers', async () => {
  const f = await workbenchFixture();
  const source = await f.create();
  const other = await f.create();
  await settle(f, source);
  await settle(f, other);
  await expect(fork(f, source, f.turns(other.id)[0]!.id)).rejects.toThrow(
    expect.objectContaining({ code: 'invalid_state', message: 'Turn has no checkpoint' }),
  );
  const turn = f.turns(source.id)[0]!;
  git(f.source, 'update-ref', '-d', checkpoint(source, turn));
  await expect(fork(f, source, turn.id)).rejects.toThrow(
    expect.objectContaining({ code: 'invalid_state', message: 'Turn has no checkpoint' }),
  );
  expect(() =>
    f.call('session.fork', { session_id: source.id, input: 'Try again' }, null, {
      id: 'writer',
      role: 'writer',
      project_id: f.project.id,
      session_id: source.id,
      expires_at: f.store.now() + 60_000,
    }),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  const before = current(f, source);
  f.store.update('sessions', { ...before, workspace_id: undefined }, before.revision);
  expect(() => fork(f, source)).toThrow(
    expect.objectContaining({
      code: 'invalid_state',
      message: 'Only a git worktree session can be forked',
    }),
  );
  f.store.update(
    'sessions',
    { ...current(f, source), workspace_id: source.workspace_id },
    current(f, source).revision,
  );
  const w = workspace(f, source);
  f.store.update('workspaces', { ...w, kind: 'in_place' }, w.revision);
  expect(() => fork(f, source)).toThrow(
    expect.objectContaining({
      code: 'invalid_state',
      message: 'Only a git worktree session can be forked',
    }),
  );
});

it('inherits session settings and merge destination and projects fork provenance onto the list and board', async () => {
  const f = await workbenchFixture();
  const source = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    model: 'fixture-model',
    effort: 'high',
    permission_mode: 'auto_edit',
    input: 'Start export',
  });
  await settle(f, source);
  const branch = await fork(f, source);
  expect(branch).toMatchObject({
    project_id: source.project_id,
    runtime: source.runtime,
    requested_model: 'fixture-model',
    requested_effort: 'high',
    permission_mode: 'auto_edit',
    forked_from: { session_id: source.id },
  });
  expect(branch.task).toBeUndefined();
  expect(workspace(f, branch)).toMatchObject({
    source: f.source,
    source_branch: workspace(f, source).source_branch,
  });
  await settle(f, branch);
  const provenance = { session_id: source.id };
  expect(f.list().find((s) => s.id === branch.id)).toMatchObject({ forked_from: provenance });
  expect(
    f.control.boardView(user, f.project.id, 7).tasks.find((row) => row.id === branch.id),
  ).toMatchObject({ forked_from: provenance });
  expect(
    f.store
      .events(0, undefined, 10000)
      .filter((e) => e.kind === 'session.forked' && e.aggregate_id === branch.id)
      .map((e) => e.payload),
  ).toEqual([{ source_session_id: source.id }]);
});

it("starts a fork on another runtime on that runtime's defaults and in ask mode when the source mode is not available there", async () => {
  const f = await workbenchFixture();
  for (const name of ['claude', 'codex']) {
    const adapter = new FixtureAdapter();
    adapter.name = name;
    f.control.adapters.set(name, adapter);
  }
  const source = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: 'claude',
    model: 'claude-model',
    effort: 'max',
    permission_mode: 'auto',
    input: 'Start export',
  });
  await settle(f, source);
  expect(
    await fork(f, source, undefined, { runtime: 'codex', model: 'codex-model' }),
  ).toMatchObject({
    runtime: 'codex',
    requested_model: 'codex-model',
    permission_mode: 'ask',
  });
  const defaults = await fork(f, source, undefined, { runtime: 'codex' });
  expect(defaults).toMatchObject({ runtime: 'codex', permission_mode: 'ask' });
  expect(defaults.requested_model).toBeUndefined();
  expect(defaults.requested_effort).toBeUndefined();
});

it('keeps the fork snapshot and handoff independent when the source is deleted before provisioning', async () => {
  const f = await workbenchFixture();
  const source = await f.create('Start export');
  await settle(f, source);
  const second = await send(f, source, 'Add header');
  const branch = await fork(f, source, second.id);
  f.call('session.delete', { session_id: source.id }, current(f, source).revision);
  await eventually(
    () => workspace(f, source).removed_at !== undefined,
    () => f.control.tick(),
  );
  expect(f.store.get<Session>('sessions', source.id)).toBeUndefined();
  await settle(f, branch);
  expect(f.turns(branch.id)[0]!.handoff).toContain('Start export');
  const next = await send(f, branch, 'Continue after deleting source');
  expect(branch).toMatchObject({
    forked_from: { session_id: source.id, before_turn_id: second.id },
  });
  expect(
    f.store
      .events(0, undefined, 10000)
      .find((event) => event.kind === 'session.forked' && event.aggregate_id === branch.id)
      ?.payload,
  ).toEqual({ source_session_id: source.id, before_turn_id: second.id });
  expect(next.state).toBe('completed');
  expect(next.handoff).toBeUndefined();
});

it('leaves rolled back turns out of the whole-record handoff', async () => {
  const f = await workbenchFixture();
  const source = await f.create('Start export');
  await settle(f, source);
  const second = await send(f, source, 'Discard this header');
  await f.call(
    'session.rollback',
    { session_id: source.id, turn_id: second.id },
    current(f, source).revision,
  );
  const branch = await fork(f, source);
  await settle(f, branch);
  const handoff = f.turns(branch.id)[0]!.handoff;
  expect(handoff).toContain('Start export');
  expect(handoff).not.toContain('Discard this header');
});

it('opens a standalone session when forking a task session', async () => {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const lead = await f.create('Plan export');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'export',
          title: 'Build export',
          goal: 'Export data',
          lane: 'core',
          depends_on: [],
          source: ['Plan export'],
          scope: ['src/export.ts'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60_000,
    },
  );
  const source = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    task_id: `${lead.id}:export`,
    input: 'Build export',
  });
  await settle(f, source);
  const branch = await fork(f, source);
  await settle(f, branch);
  expect(current(f, branch).task).toBeUndefined();
  expect(f.list().find((session) => session.id === branch.id)?.lead).toBeUndefined();
  expect(workspace(f, branch).id).not.toBe(source.workspace_id);
});
