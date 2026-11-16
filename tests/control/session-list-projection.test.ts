import { expect, it } from 'vitest';
import {
  hash,
  type Approval,
  type Project,
  type ProjectBaseline,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const listed = (f: Fixture, sessionId: string) => f.list().find((row) => row.id === sessionId)!;
const patch = (f: Fixture, sessionId: string, fields: Partial<Session>) => {
  const session = current(f, sessionId);
  return f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
};

async function idleSession(f: Fixture) {
  const session = f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return session;
}

function pendingRequest(
  f: Fixture,
  sessionId: string,
  id: string,
  tool: string,
  fields: Partial<Approval> = {},
) {
  f.store.insert<Approval>('approvals', {
    id,
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: sessionId,
    request_id: `request-${id}`,
    tool,
    input_hash: id,
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
    ...(tool === 'AskUserQuestion'
      ? {
          questions: [
            {
              question: 'Which format?',
              header: 'Format',
              options: [
                { label: 'CSV', description: 'Comma separated' },
                { label: 'JSON', description: 'Structured' },
              ],
              multiSelect: false,
            },
          ],
        }
      : {}),
    ...fields,
  });
}

function setGate(f: Fixture) {
  f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [
        { name: 'Prints ok', argv: [process.execPath, '-e', "process.stdout.write('ok')"] },
      ],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

/** Records a gate run of the worktree's current HEAD. */
function gateChecked(f: Fixture, sessionId: string, exitCode: number) {
  const session = current(f, sessionId);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  return f.store.event('session.gate_checked', session, session.project_id, {
    workspace_id: session.workspace_id,
    commit: git(workspace.path, 'rev-parse', 'HEAD'),
    check_spec_hash: hash(
      Object.values(f.store.must<Project>('projects', f.project.id).gates ?? {})[0],
    ),
    results: [
      {
        name: 'Prints ok',
        argv: ['node'],
        exit_code: exitCode,
        duration_ms: 5,
        timed_out: false,
        output: '',
      },
    ],
  });
}

async function sendTurn(f: Fixture, sessionId: string) {
  f.call(
    'session.send',
    { session_id: sessionId, input: 'Continue' },
    current(f, sessionId).revision,
  );
  await eventually(
    () =>
      f.turns(sessionId).length === 2 &&
      f.turns(sessionId).every((turn) => turn.state === 'completed') &&
      current(f, sessionId).state === 'open',
    () => f.control.tick(),
  );
}

it('tells a permission request from a question while the session waits', async () => {
  const f = workbenchFixture();
  const asking = await idleSession(f),
    permitting = await idleSession(f);
  expect(listed(f, asking.id)).not.toHaveProperty('waiting_kind');
  pendingRequest(f, asking.id, 'question-request', 'AskUserQuestion');
  pendingRequest(f, permitting.id, 'bash-request', 'Bash');
  expect(listed(f, asking.id)).toMatchObject({ state: 'waiting', waiting_kind: 'question' });
  expect(listed(f, permitting.id)).toMatchObject({ state: 'waiting', waiting_kind: 'approval' });
  pendingRequest(f, asking.id, 'edit-request', 'Edit');
  expect(listed(f, asking.id)).toMatchObject({ waiting: 2, waiting_kind: 'approval' });
});

it('shows the oldest unanswered request with the same detail as needs-you', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  pendingRequest(f, session.id, 'newer-request', 'Edit');
  pendingRequest(f, session.id, 'oldest-request', 'Bash', {
    created_at: f.store.now() - 1000,
    input_summary: 'command=run the migration on staging',
  });
  pendingRequest(f, session.id, 'answered-request', 'Read', {
    created_at: f.store.now() - 2000,
    state: 'approved',
  });
  expect(listed(f, session.id)).toMatchObject({
    waiting: 2,
    waiting_request: { tool: 'Bash', detail: 'command=run the migration on staging' },
  });
  const item = f.control
    .needsYou(user, f.project.id)
    .items.find((item) => item.source.id === 'oldest-request')!;
  expect(listed(f, session.id).waiting_request?.detail).toBe(item.binding?.input_summary);
  const oldest = f.store.must<Approval>('approvals', 'oldest-request');
  f.store.update('approvals', { ...oldest, state: 'approved' }, oldest.revision);
  expect(listed(f, session.id).waiting_request).toEqual({ tool: 'Edit' });
  const newer = f.store.must<Approval>('approvals', 'newer-request');
  f.store.update('approvals', { ...newer, state: 'approved' }, newer.revision);
  expect(listed(f, session.id)).not.toHaveProperty('waiting_request');
});

it('uses the newest turn with context tokens and omits context without its window', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  expect(listed(f, session.id)).not.toHaveProperty('context');
  const turn = f.turns(session.id)[0]!;
  f.store.update<SessionTurn>(
    'session_turns',
    {
      ...turn,
      usage: { input_tokens: 10, output_tokens: 5, context_tokens: 700, context_window: 200000 },
    },
    turn.revision,
  );
  f.store.insert<SessionTurn>('session_turns', { ...turn, id: 'turn-without-usage', revision: 1 });
  expect(listed(f, session.id).context).toEqual({ used_tokens: 700, window_tokens: 200000 });
  f.store.insert<SessionTurn>('session_turns', {
    ...turn,
    id: 'turn-without-window',
    revision: 1,
    usage: { input_tokens: 10, output_tokens: 5, context_tokens: 900 },
  });
  expect(listed(f, session.id)).not.toHaveProperty('context');
  f.store.insert<SessionTurn>('session_turns', {
    ...turn,
    id: 'latest-context-turn',
    revision: 1,
    usage: { input_tokens: 10, output_tokens: 5, context_tokens: 0, context_window: 100000 },
  });
  expect(listed(f, session.id).context).toEqual({ used_tokens: 0, window_tokens: 100000 });
});

it('marks a baseline session awaiting review of its submitted baseline', () => {
  const f = workbenchFixture();
  f.store.insert<ProjectBaseline>('project_baselines', {
    id: 'submitted-baseline',
    revision: 1,
    project_id: f.project.id,
    state: 'submitted',
    session_id: 'baseline-session',
    runtime: f.adapter.name,
    facts_id: 'facts',
    dropped: 0,
    created_at: f.store.now(),
  });
  const session = f.store.insert<Session>('sessions', {
    id: 'baseline-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 1,
    baseline: { baseline_id: 'submitted-baseline' },
  });
  f.store.event('session.opened', session, f.project.id, { purpose: 'baseline' });
  expect(listed(f, session.id)).toMatchObject({
    created_at: new Date(
      f.store.kindEvents(f.project.id, ['session.opened'])[0]!.created_at,
    ).toISOString(),
    state: 'waiting',
    waiting: 0,
    waiting_kind: 'baseline_review',
    reconciling: false,
    stopping: false,
  });
  expect(listed(f, session.id)).not.toHaveProperty('gate');
  expect(listed(f, session.id)).not.toHaveProperty('waiting_request');
});

it('flags a reconciling session and a session whose stop is pending', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  expect(listed(f, session.id)).toMatchObject({ reconciling: false, stopping: false });
  patch(f, session.id, { state: 'reconciling' });
  expect(listed(f, session.id)).toMatchObject({
    state: 'idle',
    reconciling: true,
    stopping: false,
  });
  patch(f, session.id, { state: 'open', stop_pending: true });
  expect(listed(f, session.id)).toMatchObject({ reconciling: false, stopping: true });
});

it('flags a session whose discard waits for its native process to close', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  f.call('session.discard', { session_id: session.id }, current(f, session.id).revision);
  expect(current(f, session.id)).toMatchObject({ stop_requested: { by: 'user' } });
  expect(current(f, session.id).outcome).toBeUndefined();
  expect(listed(f, session.id).stopping).toBe(true);
  await eventually(
    () => current(f, session.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(listed(f, session.id).stopping).toBe(false);
});

it('lists a clean worktree whose commits change no file as ready', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  git(workspace.path, 'commit', '--quiet', '--allow-empty', '-m', 'Empty commit');
  expect(listed(f, session.id)).toMatchObject({
    state: 'ready',
    changes: { files: 0, additions: 0, deletions: 0 },
  });
});

it('leaves the gate out without gate commands or without a run', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  gateChecked(f, session.id, 0);
  expect(listed(f, session.id)).not.toHaveProperty('gate');
  const unchecked = await idleSession(f);
  setGate(f);
  expect(listed(f, unchecked.id)).not.toHaveProperty('gate');
  expect(listed(f, session.id)).toHaveProperty('gate');
});

it('summarizes the latest gate run as passed or failed with its end time', async () => {
  const f = workbenchFixture();
  const passing = await idleSession(f),
    failing = await idleSession(f);
  setGate(f);
  const passed = gateChecked(f, passing.id, 0);
  gateChecked(f, failing.id, 0);
  const failed = gateChecked(f, failing.id, 3);
  expect(listed(f, passing.id).gate).toEqual({
    state: 'passed',
    passed: 1,
    failed: 0,
    skipped: 0,
    running: 0,
    finished_at: new Date(passed.created_at).toISOString(),
  });
  expect(listed(f, failing.id).gate).toEqual({
    state: 'failed',
    passed: 0,
    skipped: 0,
    failed: 1,
    running: 0,
    finished_at: new Date(failed.created_at).toISOString(),
  });
});

it('shows a gate run that is still checking as running', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f);
  f.call('session.gates.run', { session_id: session.id }, current(f, session.id).revision);
  expect(listed(f, session.id).gate).toEqual({
    state: 'running',
    passed: 0,
    skipped: 0,
    failed: 0,
    running: 1,
  });
  await eventually(
    () => !f.control.sessionGates(user, session.id).running,
    () => f.control.tick(),
    10000,
  );
});

it('shows a running session with the failed gate of its previous turn', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f);
  gateChecked(f, session.id, 1);
  patch(f, session.id, { state: 'running' });
  expect(listed(f, session.id)).toMatchObject({ state: 'running', gate: { state: 'failed' } });
});

it('marks the gate stale once a turn ends after the run', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f);
  const checked = gateChecked(f, session.id, 0);
  await sendTurn(f, session.id);
  expect(listed(f, session.id).gate).toEqual({
    state: 'stale',
    passed: 1,
    skipped: 0,
    failed: 0,
    running: 0,
    finished_at: new Date(checked.created_at).toISOString(),
  });
});

it('marks the gate stale once the worktree head left the commit the run checked', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f);
  const checked = gateChecked(f, session.id, 0);
  expect(listed(f, session.id).gate).toMatchObject({ state: 'passed' });
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  git(workspace.path, 'commit', '--quiet', '--allow-empty', '-m', 'Commit outside a turn');
  expect(listed(f, session.id).gate).toEqual({
    state: 'stale',
    passed: 1,
    skipped: 0,
    failed: 0,
    running: 0,
    finished_at: new Date(checked.created_at).toISOString(),
  });
});

it('moves the last activity time when a turn ends', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const opened = f.store
    .kindEvents(f.project.id, ['session.opened'])
    .find((event) => event.aggregate_id === session.id)!;
  expect(listed(f, session.id).created_at).toBe(new Date(opened.created_at).toISOString());
  const before = listed(f, session.id).last_activity_at;
  expect(before).toBe(new Date(Date.parse(before)).toISOString());
  await sendTurn(f, session.id);
  const after = listed(f, session.id).last_activity_at;
  expect(listed(f, session.id).created_at).toBe(new Date(opened.created_at).toISOString());
  expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  const turnEnd = f.store
    .events(0, f.project.id, 100000)
    .filter(
      (event) =>
        event.kind === 'turn.completed' &&
        f.turns(session.id).some((turn) => turn.id === event.aggregate_id),
    )
    .at(-1)!;
  expect(after).toBe(new Date(turnEnd.created_at).toISOString());
});

it('projects a recoverable failed turn without closing its idle session', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const turn = f.turns(session.id)[0]!;
  const failed = f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, state: 'failed' },
    turn.revision,
  );
  f.store.event('turn.failed', failed, session.project_id, { error: 'The build command failed' });
  expect(listed(f, session.id)).toMatchObject({
    state: 'idle',
    last_turn: { id: turn.id, state: 'failed', error: 'The build command failed' },
  });
  expect(current(f, session.id).state).toBe('open');
  f.call(
    'session.send',
    { session_id: session.id, input: 'Fix the build' },
    current(f, session.id).revision,
  );
  expect(listed(f, session.id).last_turn).toMatchObject({ state: 'queued' });
  expect(listed(f, session.id).last_turn).not.toHaveProperty('error');
});

it('does not replace the main turn result with a steer or a rolled-back turn', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const turn = f.turns(session.id)[0]!;
  const failed = f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, state: 'failed' },
    turn.revision,
  );
  f.store.event('turn.failed', failed, session.project_id, { error: 'Previous failure' });
  const steer = f.store.insert<SessionTurn>('session_turns', {
    ...turn,
    id: 'completed-steer',
    revision: 1,
    kind: 'steer',
    state: 'completed',
  });
  const rolled = f.store.insert<SessionTurn>('session_turns', {
    ...turn,
    id: 'rolled-turn',
    revision: 1,
    state: 'cancelled',
    rolled_back: true,
  });
  f.store.event('turn.completed', steer, session.project_id, {});
  f.store.event('turn.cancelled', rolled, session.project_id, { error: 'Rolled back' });
  expect(listed(f, session.id).last_turn).toEqual({
    id: turn.id,
    state: 'failed',
    error: 'Previous failure',
  });
  const cancelled = f.store.insert<SessionTurn>('session_turns', {
    ...turn,
    id: 'cancelled-turn',
    revision: 1,
    state: 'cancelled',
  });
  f.store.event('turn.cancelled', cancelled, session.project_id, {});
  expect(listed(f, session.id).last_turn).toMatchObject({ id: cancelled.id, state: 'cancelled' });
});

it('shows the gate of a merge as running until it is checked, and stops counting once the merge is cancelled', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f);
  const passed = gateChecked(f, session.id, 0);
  const merging = patch(f, session.id, { merge: { state: 'running' } });
  f.store.event('session.gate_started', merging, f.project.id, {
    workspace_id: session.workspace_id,
    commands: [{ name: 'Prints ok', argv: ['node'] }],
  });
  expect(listed(f, session.id).gate).toEqual({
    state: 'running',
    passed: 0,
    failed: 0,
    skipped: 0,
    running: 1,
  });
  const cancelled = patch(f, session.id, { merge: undefined });
  f.store.event('session.merge_cancelled', cancelled, f.project.id, { reason: 'cancelled' });
  expect(listed(f, session.id).gate).toMatchObject({
    state: 'passed',
    running: 0,
    finished_at: new Date(passed.created_at).toISOString(),
  });
});
