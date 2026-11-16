import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { AgentEventSink, Session, SessionHandle, SessionTurn } from '@pantheon/domain';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { awaitWorkspaceReady, eventually, fixture } from '../helpers.js';
import { git } from './workbench-fixture.js';

it('restores the cursor of a reconciling session from its newest keyed agent event', async () => {
  const f = fixture();
  try {
    const session = f.store.insert<Session>('sessions', {
      id: 'reconciling-conversation',
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      device_id: 'local',
      state: 'reconciling',
      turn_count: 1,
    });
    f.store.event('agent.turn.started', session, f.project.id, {
      key: 'native:7',
      kind: 'turn.started',
      turn_id: 'turn-1',
    });
    f.store.event('agent.native_id_rejected', session, f.project.id, {
      native_session_id: 'native-other',
      reason: 'Native id belongs to another session',
    });
    f.control.recover();
    expect(f.store.must<Session>('sessions', session.id)).toMatchObject({
      last_cursor: '7',
      event_namespace: 'native',
    });
  } finally {
    await f.close();
  }
});

it('records a refused native session id once per id however often the handle reports it', async () => {
  const adapter = new FixtureAdapter(),
    sinks = new Map<SessionHandle, AgentEventSink>(),
    resume = adapter.resume.bind(adapter);
  vi.spyOn(adapter, 'resume').mockImplementation(async (spec, nativeId, sink) => {
    const handle = await resume(spec, nativeId, sink);
    sinks.set(handle, sink);
    return handle;
  });
  vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const f = fixture({ adapter, managedWorkspaces: true });
  try {
    git(f.projectRoot, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(path.join(f.projectRoot, 'README.md'), 'fixture\n');
    git(f.projectRoot, 'add', '.');
    git(f.projectRoot, 'commit', '--quiet', '-m', 'Initial files');
    for (const id of ['native-forged-first', 'native-forged-second'])
      f.store.insert<Session>('sessions', {
        id: `owner-of-${id}`,
        revision: 1,
        project_id: f.project.id,
        runtime: adapter.name,
        device_id: 'local',
        state: 'closed',
        turn_count: 0,
        native_id: id,
      });
    const session = f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: adapter.name,
      input: 'Report a borrowed native id',
    });
    const turn = f.store
      .list<SessionTurn>('session_turns')
      .find((t) => t.session_id === session.id)!;
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () => f.control.handles.has(turn.id),
      () => f.control.tick(),
    );
    const handle = f.control.handles.get(turn.id)!;
    let sequence = 10;
    const report = (nativeId: string) => {
      handle.native_session_id = nativeId;
      sinks.get(handle)!({
        key: String(++sequence),
        provider_sequence: sequence,
        turn_id: turn.id,
        kind: 'message.delta',
        text: 'working',
      });
    };
    const rejected = () =>
      f.store
        .kindEvents(f.project.id, ['agent.native_id_rejected'])
        .filter((event) => event.aggregate_id === session.id);
    for (let i = 0; i < 3; i++) report('native-forged-first');
    expect(rejected()).toHaveLength(1);
    report('native-forged-second');
    expect(
      rejected().map((event) => (event.payload as { native_session_id: string }).native_session_id),
    ).toEqual(['native-forged-first', 'native-forged-second']);
  } finally {
    await f.close();
  }
});
