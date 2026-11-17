import { expect, it, vi } from 'vitest';
import type { Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const oldIdentity = { pid: 4000001, start_time_us: 1700000000123456 };

const eventKinds = (f: Awaited<ReturnType<typeof workbenchFixture>>, sessionId: string) =>
  (
    f.store.db.prepare('SELECT kind FROM events WHERE aggregate_id=?').all(sessionId) as {
      kind: string;
    }[]
  ).map((row) => row.kind);

/** Delivers the next turn without a fixture process, so it stays running with a recorded identity. */
function holdNextTurn(f: Awaited<ReturnType<typeof workbenchFixture>>) {
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    handle.process_identity = oldIdentity;
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
}

it('starts the first turn after a restart that happened before the worktree was ready', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await f.restart();
  expect(f.store.must<Session>('sessions', session.id).state).toBe('running');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'completed',
    () => f.control.tick(),
  );
  expect(f.start).toHaveBeenCalledOnce();
  expect(eventKinds(f, session.id)).not.toContain('session.reconciling');
});

it('fails the interrupted turn and resumes the native session on the next message', async () => {
  const f = await workbenchFixture();
  holdNextTurn(f);
  const resume = vi.spyOn(f.adapter, 'resume');
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).process_identity !== undefined,
    () => f.control.tick(),
  );
  const nativeId = f.store.must<Session>('sessions', session.id).native_id;
  expect(nativeId).toBeDefined();
  await f.restart(() => undefined);
  const recovered = f.store.must<Session>('sessions', session.id);
  expect(recovered.state).toBe('open');
  expect(recovered.process_identity).toBeUndefined();
  expect(f.turns(session.id)).toMatchObject([
    { state: 'failed', delivery_reason: 'Interrupted by a daemon restart' },
  ]);
  expect(eventKinds(f, session.id)).toContain('session.recovered');
  const next = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Carry on' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', next.id).state === 'completed',
    () => f.control.tick(),
  );
  expect(f.start).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenLastCalledWith(expect.anything(), nativeId, expect.any(Function));
});

it('keeps an interrupted worktree session reconciling while the old process may still run', async () => {
  const f = await workbenchFixture();
  holdNextTurn(f);
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).process_identity !== undefined,
    () => f.control.tick(),
  );
  await f.restart(() => oldIdentity);
  expect(f.store.must<Session>('sessions', session.id).state).toBe('reconciling');
  expect(eventKinds(f, session.id)).not.toContain('session.recovered');
});
