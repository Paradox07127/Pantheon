import { afterEach, expect, it, vi } from 'vitest';
import type { MemoryContext, Principal, Session, SessionTurn } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});

/** A range story session row as an older version stored it, with one queued first turn. */
async function legacySession(state: Session['state']) {
  const f = await fixture();
  cleanups.push(() => f.close());
  const session = f.store.insert<Session>('sessions', {
    id: 'legacy-story',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state,
    turn_count: 1,
    range_story: { story_id: 'old-story' },
  });
  const turn = f.store.insert<SessionTurn>('session_turns', {
    id: 'legacy-story-turn',
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    input: 'Explain the last month of commits',
    kind: 'send',
    delivery: 'pending',
    state: 'queued',
  });
  return { f, session, turn };
}

it('gives a stored range story session no tools', async () => {
  const { f, session } = await legacySession('open');
  const principal: Principal = {
    id: `session:${session.id}`,
    role: 'planner',
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60000,
  };
  const read = f.call<MemoryContext>('memory.context', { project_id: f.project.id }, null, user);
  expect(() =>
    f.call(
      'memory.propose',
      {
        project_id: f.project.id,
        key: 'export-format',
        kind: 'note',
        title: 'Export format',
        text: 'Finance reads exports as CSV.',
        based_on: read.signature,
      },
      null,
      principal,
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it('closes a stored range story session that never started on restart without starting its turn', async () => {
  const { f, session, turn } = await legacySession('running');
  f.store.enqueue('session.turn', { turn_id: turn.id });
  const start = vi.spyOn(f.adapter, 'start');
  const resume = vi.spyOn(f.adapter, 'resume');
  await f.control.recover();
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(f.store.must<Session>('sessions', session.id).state).toBe('closed');
  expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('failed');
  expect(start).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});

it('closes a stored range story session that had started on restart without resuming it', async () => {
  const { f, session, turn } = await legacySession('running');
  f.store.update<Session>('sessions', { ...session, native_id: 'native-story' }, session.revision);
  f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, delivery: 'delivered', state: 'running' },
    turn.revision,
  );
  const start = vi.spyOn(f.adapter, 'start');
  const resume = vi.spyOn(f.adapter, 'resume');
  await f.control.recover();
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(f.store.must<Session>('sessions', session.id).state).toBe('closed');
  expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('failed');
  expect(start).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});

it('fails queued turns an older version queued from a lead or to continue a session on restart', async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const session = f.store.insert<Session>('sessions', {
    id: 'older-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 2,
  });
  const queued = (['lead', 'continuation'] as const).map((origin) =>
    f.store.insert<SessionTurn>('session_turns', {
      id: `${origin}-turn`,
      revision: 1,
      project_id: f.project.id,
      session_id: session.id,
      input: 'Carry on with the plan',
      kind: 'send',
      delivery: 'pending',
      state: 'queued',
      origin,
    }),
  );
  await f.control.recover();
  for (const turn of queued)
    expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('failed');
});
