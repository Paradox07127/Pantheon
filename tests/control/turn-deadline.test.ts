import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session, SessionTurn, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const open: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of open.splice(0)) await f.close();
});

const script = (steps: unknown[]) => `fixture-script\n${JSON.stringify(steps)}`;

/** A daemon whose turns end after half a second. */
async function deadlineBench() {
  const f = await fixture({ managedWorkspaces: true, controlOptions: { turnWallTimeMs: 500 } });
  open.push(f);
  git(f.projectRoot, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(f.projectRoot, 'README.md'), 'fixture\n');
  git(f.projectRoot, 'add', '.');
  git(f.projectRoot, 'commit', '--quiet', '-m', 'Initial files');
  const create = (input: string) =>
    f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input,
    });
  return { f, startSession: create };
}

const turnsOf = (f: Fixture, sessionId: string) =>
  f.store.list<SessionTurn>('session_turns').filter((turn) => turn.session_id === sessionId);

async function settle(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.store.must<Session>('sessions', session.id).state === 'open' &&
      turnsOf(f, session.id).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );
}

const completions = (f: Fixture, turn: SessionTurn) =>
  f.store
    .events(0, undefined, 10000)
    .filter(
      (event) =>
        event.kind === 'agent.turn.completed' &&
        (event.payload as { turn_id?: string }).turn_id === turn.id,
    )
    .map((event) => event.payload);

it('records the deadline reason on a turn that hit the wall clock', async () => {
  const { f, startSession } = await deadlineBench();
  const worker = await startSession(script([{ hang: true }]));
  await settle(f, worker);
  const [turn] = turnsOf(f, worker.id);
  expect(turn).toMatchObject({ state: 'failed' });
  expect(completions(f, turn!)).toMatchObject([
    { status: 'failed', error: 'Fixture turn deadline exceeded', error_code: 'turn_deadline' },
  ]);
  const listed = f.control.sessionList(user, f.project.id).find((row) => row.id === worker.id);
  expect(listed?.last_turn).toMatchObject({ id: turn!.id, error_code: 'turn_deadline' });
});

it('keeps uncommitted worktree changes after a deadline-killed turn and resumes on the next message', async () => {
  const { f, startSession } = await deadlineBench();
  const worker = await startSession(
    script([{ write: { path: 'draft.txt', text: 'half done\n' } }, { hang: true }]),
  );
  await settle(f, worker);
  const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
  const draft = path.join(workspace.path, 'draft.txt');
  expect(readFileSync(draft, 'utf8')).toBe('half done\n');
  const nativeId = f.store.must<Session>('sessions', worker.id).native_id;
  expect(nativeId).toBeDefined();
  const resume = vi.spyOn(f.adapter, 'resume'),
    start = vi.spyOn(f.adapter, 'start');
  const next = f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: script([{ say: 'Picked up the draft' }]) },
    f.store.must<Session>('sessions', worker.id).revision,
  );
  await settle(f, worker);
  expect(f.store.must<SessionTurn>('session_turns', next.id).state).toBe('completed');
  expect(start).not.toHaveBeenCalled();
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0]![1]).toBe(nativeId);
  expect(existsSync(draft)).toBe(true);
  expect(readFileSync(draft, 'utf8')).toBe('half done\n');
});
