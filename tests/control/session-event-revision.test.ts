import { expect, it, vi } from 'vitest';
import type { AgentEventSink, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

it('records runtime events without revising the running session', async () => {
  const f = workbenchFixture();
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const created = f.create();
  await awaitWorkspaceReady(f.control, created.workspace_id!);
  await eventually(
    () => f.turns(created.id)[0]!.delivery === 'delivered',
    () => f.control.tick(),
  );
  const sink = f.start.mock.calls[0]![1] as AgentEventSink;
  const session = () => f.store.must<Session>('sessions', created.id);
  const before = session().revision;
  for (let i = 0; i < 5; i++)
    sink({ key: `delta-${i}`, provider_sequence: 100 + i, kind: 'message.delta', text: 'x' });
  expect(session().revision).toBe(before);
});
