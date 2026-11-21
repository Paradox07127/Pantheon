import { expect, it } from 'vitest';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

async function setup() {
  const f = await workbenchFixture();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const first = await f.create('Let users download exports');
  await settle(f, first);
  const second = await f.create('Serve exports');
  await settle(f, second);
  const compact = (key: string, sessionId: string, trigger: 'auto' | 'manual' = 'auto') =>
    agentEvent(ctx, sessionId, {
      kind: 'context.compacted',
      key,
      provider_sequence: 1,
      turn_id: f.turns(sessionId).at(-1)!.id,
      trigger,
    });
  return { f, first, second, compact };
}

it('projects durable compaction counts per session and ignores replayed events', async () => {
  const { f, first, second, compact } = await setup();
  compact('first', second.id);
  compact('first', second.id);
  compact('second', second.id);
  compact('other-first', first.id);
  expect(f.list().find((session) => session.id === second.id)).toHaveProperty(
    'compaction_count',
    2,
  );
  expect(f.list().find((session) => session.id === first.id)).toHaveProperty('compaction_count', 1);
  const other = await f.create('Another conversation');
  expect(f.list().find((session) => session.id === other.id)).toHaveProperty('compaction_count', 0);
  await settle(f, other);
  await f.control.shutdown();
  await f.restart();
  expect(f.list().find((session) => session.id === second.id)).toHaveProperty(
    'compaction_count',
    2,
  );
});

it('counts manual and automatic compactions alike', async () => {
  const { f, second, compact } = await setup();
  compact('manual-first', second.id, 'manual');
  compact('automatic-first', second.id);
  compact('manual-second', second.id, 'manual');
  compact('automatic-second', second.id);
  expect(f.list().find((session) => session.id === second.id)?.compaction_count).toBe(4);
});
