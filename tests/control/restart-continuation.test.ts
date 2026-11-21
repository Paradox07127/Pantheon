import { expect, it, vi } from 'vitest';
import type { Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const oldIdentity = { pid: 4000001, start_time_us: 1700000000123456 };

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** Delivers the next turn without a fixture process, so it stays running with a recorded identity. */
function holdNextTurn(f: Fixture) {
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    handle.process_identity = oldIdentity;
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
}

/** Waits until the session's held turn runs under a recorded process identity. */
async function heldRunning(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => current(f, session.id).process_identity !== undefined,
    () => f.control.tick(),
  );
}

it('leaves an interrupted session a person drives failed and waiting for the next message', async () => {
  const f = await workbenchFixture();
  holdNextTurn(f);
  const session = await f.create();
  await heldRunning(f, session);
  await f.restart(() => undefined);
  expect(current(f, session.id).state).toBe('open');
  expect(f.turns(session.id)).toMatchObject([
    { state: 'failed', delivery_reason: 'Interrupted by a daemon restart' },
  ]);
});

it('delivers a message queued behind an exited process after a restart instead of reconciling', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await settle(f, session);
  // The adapter dropped the identity of its process once the process group was empty.
  const exited = current(f, session.id);
  f.store.update('sessions', { ...exited, process_identity: undefined }, exited.revision);
  expect(current(f, session.id).native_id).toBeDefined();
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Go on' },
    current(f, session.id).revision,
  );
  await f.restart(() => undefined);
  expect(current(f, session.id).state).toBe('running');
  await settle(f, session);
  expect(f.store.must<SessionTurn>('session_turns', turn.id)).toMatchObject({
    state: 'completed',
    delivery: 'delivered',
  });
});
