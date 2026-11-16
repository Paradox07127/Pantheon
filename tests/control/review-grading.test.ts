import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { Principal, Review, Session } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { agentEvent } from '../../packages/control/src/agent.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { recordFinding } from '../../packages/control/src/review.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const finding = {
  location: 'answer.txt:1',
  quote: '-base',
  evidence: 'The original answer was removed',
  impact: 'Readers lose the original answer',
};

async function reviewFixture() {
  const f = workbenchFixture({ delay: 0 });
  const reviewer = new FixtureAdapter(0);
  reviewer.name = 'independent-reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const session = f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const change = (round: number) => {
    writeFileSync(path.join(workspace.path, 'answer.txt'), `updated answer ${round}\n`);
    git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');
  };
  change(1);
  const request = () =>
    f.call<Review>('review.request', { session_id: session.id, runtimes: [reviewer.name] });
  const complete = (review: Review) =>
    eventually(
      () => f.store.must<Review>('reviews', review.id).state === 'completed',
      () => f.control.tick(),
    );
  return { ...f, session, change, request, complete };
}

it('requires a boolean finding grade and reproduction for blocking findings in the protocol', () => {
  const schema = inputSchemas['review.finding'];
  expect(() => schema.parse(finding)).toThrow();
  expect(() => schema.parse({ ...finding, blocking: 'true' })).toThrow();
  expect(() => schema.parse({ ...finding, blocking: true })).toThrow();
  expect(schema.parse({ ...finding, blocking: false })).toMatchObject({ blocking: false });
  expect(
    schema.parse({ ...finding, blocking: true, reproduction: 'Read the answer: base is absent' }),
  ).toMatchObject({ blocking: true });
});

it('preserves blocking grades on deleted code and shows major and report-only minor findings', async () => {
  const f = await reviewFixture();
  const review = f.request();
  const session = f.store.must<Session>('sessions', review.session_ids[0]!);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const blocking = recordFinding(ctx, session, {
    ...finding,
    blocking: true,
    reproduction: 'Read the answer: base is absent',
  });
  expect(f.control.boardView(user, f.project.id, 1).findings).toMatchObject([
    { id: blocking!.id, severity: 'blocker' },
  ]);
  expect(blocking).toMatchObject({ quote: '-base', status: 'open', blocking: true, round: 1 });
  const principal: Principal = {
    id: `session:${session.id}`,
    role: 'reviewer',
    session_id: session.id,
    project_id: f.project.id,
    expires_at: f.store.now() + 60000,
  };
  f.call('review.finding', { ...finding, blocking: false }, null, principal);
  expect(f.control.boardView(user, f.project.id, 1).findings.map((row) => row.severity)).toEqual([
    'blocker',
    'minor',
  ]);
  agentEvent(ctx, session.id, {
    key: 'invalid-grade',
    provider_sequence: 1,
    kind: 'tool.started',
    name: 'review.finding',
    tool_call_id: 'invalid-grade',
    input: { ...finding, blocking: 'true' },
  });
  expect(f.store.must<Review>('reviews', review.id).findings.at(-1)).toMatchObject({
    status: 'rejected',
    reason: 'incomplete_finding',
  });
});

it('increments review and finding rounds after committed fixes and retains them across restart', async () => {
  const f = await reviewFixture();
  const first = f.request();
  expect(first.round).toBe(1);
  await f.complete(first);
  f.change(2);
  const second = f.request();
  expect(second.round).toBe(2);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  expect(
    recordFinding(ctx, f.store.must<Session>('sessions', second.session_ids[0]!), {
      ...finding,
      blocking: false,
    })?.round,
  ).toBe(2);
  await f.complete(second);
  await f.restart();
  f.change(3);
  expect(f.request().round).toBe(3);
});

it('refuses a fourth code review with a readable reason and creates no reviewer sessions', async () => {
  const f = await reviewFixture();
  for (let round = 1; round <= 3; round++) {
    if (round > 1) f.change(round);
    await f.complete(f.request());
  }
  f.change(4);
  const sessions = f.store.list<Session>('sessions');
  expect(f.request).toThrow(/Code review.*3.*round/i);
  expect(f.store.list<Review>('reviews')).toHaveLength(3);
  expect(f.store.list<Session>('sessions')).toEqual(sessions);
});
