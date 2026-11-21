import { expect, it, vi } from 'vitest';
import type { Approval } from '@pantheon/domain';
import { settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const MINUTE = 60_000;

function permissionRequest(f: Fixture, id: string, sessionId: string): Approval {
  return {
    id,
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: sessionId,
    request_id: id,
    tool: 'mcp__docs__search',
    input_hash: 'a'.repeat(64),
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  };
}

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

const requestItem = (f: Fixture, id: string) =>
  f.control
    .needsYou(user, f.project.id)
    .items.find((item) => item.source.table === 'approvals' && item.source.id === id)!;

const escalations = (f: Fixture) =>
  f.store.events().filter((event) => event.kind === 'approval.escalated');

it('marks a permission request escalated once when it stays unanswered past the escalation window', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const session = await f.create('Build it');
  await settle(f, session);

  f.store.insert('approvals', permissionRequest(f, 'unanswered-request', session.id));
  advance(9 * MINUTE);
  await f.control.tick();
  expect(requestItem(f, 'unanswered-request')).not.toHaveProperty('escalated');
  expect(escalations(f)).toEqual([]);

  advance(2 * MINUTE);
  await f.control.tick();
  const item = requestItem(f, 'unanswered-request');
  expect(item).toMatchObject({ reason: 'permission_requested', escalated: true });
  expect(item.waited_ms).toBeGreaterThanOrEqual(11 * MINUTE);

  advance(20 * MINUTE);
  await f.control.tick();
  expect(escalations(f)).toHaveLength(1);
});
