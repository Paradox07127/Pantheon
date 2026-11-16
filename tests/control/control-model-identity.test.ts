import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session, SessionHandle, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent, saveSessionHandle } from '../../packages/control/dist/agent.js';
import { awaitWorkspaceReady, eventually, fixture } from '../helpers.js';
import { git } from './workbench-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
});

/** Worktree sessions branch from a commit of the project root. */
function commitProjectRoot(root: string) {
  git(root, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Initial files');
}

function setup() {
  const f = fixture({ managedWorkspaces: true });
  cleanups.push(() => f.close());
  commitProjectRoot(f.projectRoot);
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const start = vi.spyOn(f.adapter, 'start');
  const resume = vi.spyOn(f.adapter, 'resume');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  return { ...f, startSpy: start, resumeSpy: resume, ctx };
}

function open(f: ReturnType<typeof setup>) {
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    model: 'requested-model',
    input: 'Continue',
  });
  // The first turn waits for the worktree; no session command sets a profile version.
  return f.store.update('sessions', { ...session, profile_version: 3 }, session.revision);
}

it.each(['start', 'resume'] as const)(
  'persists session configuration and passes it on %s',
  async (method) => {
    const f = setup();
    let session = open(f);
    expect(session).toMatchObject({
      requested_model: 'requested-model',
      profile_version: 3,
      device_id: 'local',
    });
    expect(session).not.toHaveProperty('model');
    if (method === 'resume')
      session = f.store.update(
        'sessions',
        { ...session, native_id: 'previous-native', reported_model: 'old-report' },
        session.revision,
      );
    const calls = method === 'start' ? f.startSpy.mock.calls : f.resumeSpy.mock.calls;
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () => calls.length > 0,
      () => f.control.tick(),
    );
    expect(calls[0]![0]).toMatchObject({
      model: 'requested-model',
      profile_version: 3,
      device_id: 'local',
    });
    if (method === 'resume') expect(calls[0]![1]).toBe('previous-native');
    const saved = f.store.must<Session>('sessions', session.id);
    expect(saved.requested_model).toBe('requested-model');
    expect(saved.reported_model).toBeUndefined();
  },
);

it('persists vendor reports from handles and startup events and clears stale reports', () => {
  const f = setup();
  const session = open(f);
  const handle: SessionHandle = {
    platform_session_id: session.id,
    native_session_id: 'native-model-session',
    adapter_version: '1',
    device_id: 'local',
    requested_model: 'requested-model',
    reported_model: 'resolved-model',
  };
  saveSessionHandle(f.ctx, handle);
  expect(f.store.must<Session>('sessions', session.id).reported_model).toBe('resolved-model');
  const revision = f.store.must<Session>('sessions', session.id).revision;
  saveSessionHandle(f.ctx, handle);
  expect(f.store.must<Session>('sessions', session.id).revision).toBe(revision);
  handle.reported_model = undefined;
  saveSessionHandle(f.ctx, handle);
  expect(f.store.must<Session>('sessions', session.id).reported_model).toBeUndefined();
  for (const [index, report] of ['later-model', undefined].entries()) {
    agentEvent(f.ctx, session.id, {
      key: `init-${index}`,
      provider_sequence: index + 1,
      kind: 'session.started',
      native_session_id: handle.native_session_id,
      ...(report ? { reported_model: report } : {}),
    });
    expect(f.store.must<Session>('sessions', session.id)).toMatchObject({
      requested_model: 'requested-model',
      profile_version: 3,
    });
    expect(f.store.must<Session>('sessions', session.id).reported_model).toBe(report);
  }
});

function firstTurn(f: ReturnType<typeof setup>, session: Session) {
  return f.store.list<SessionTurn>('session_turns').find((turn) => turn.session_id === session.id)!;
}

it('records the model the runtime reported on the turn its startup event belongs to', () => {
  const f = setup();
  const session = open(f);
  const turn = firstTurn(f, session);
  agentEvent(f.ctx, session.id, {
    key: 'init-turn',
    provider_sequence: 1,
    turn_id: turn.id,
    kind: 'session.started',
    native_session_id: 'native-model-session',
    reported_model: 'resolved-model-2026-01-01',
  });
  expect(f.store.must<SessionTurn>('session_turns', turn.id).reported_model).toBe(
    'resolved-model-2026-01-01',
  );
});

it('records a context compaction of a turn as a session event', () => {
  const f = setup();
  const session = open(f);
  const turn = firstTurn(f, session);
  agentEvent(f.ctx, session.id, {
    key: 'compaction',
    provider_sequence: 1,
    turn_id: turn.id,
    kind: 'context.compacted',
    trigger: 'auto',
    pre_tokens: 180000,
  });
  expect(
    f.store.events(0, undefined, 1000).filter((event) => event.kind === 'agent.context.compacted'),
  ).toEqual([
    expect.objectContaining({
      aggregate_id: session.id,
      payload: expect.objectContaining({ turn_id: turn.id, trigger: 'auto', pre_tokens: 180000 }),
    }),
  ]);
});
