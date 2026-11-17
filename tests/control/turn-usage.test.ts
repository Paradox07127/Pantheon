import { expect, it, vi } from 'vitest';
import type { SessionTurn } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { turnInputTokens } from '../../packages/control/dist/turn-usage.js';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

function spend(f: Fixture, sessionId: string, inputTokens: number) {
  const turn = f.turns(sessionId).at(-1)!;
  f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, usage: { input_tokens: inputTokens, output_tokens: 0 } },
    turn.revision,
  );
}

/** Two sessions with one completed turn each: the first spent 100 input tokens, the later one 40. */
async function twoSessions() {
  const f = await workbenchFixture();
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const first = await f.create('Rename the answer file');
  await settle(f, first);
  spend(f, first.id, 100);
  skew += 1000;
  const second = await f.create('Explain the rename');
  await settle(f, second);
  spend(f, second.id, 40);
  return { f, ctx, first, second };
}

const total = (rows: { input_tokens: number }[]) =>
  rows.reduce((sum, row) => sum + row.input_tokens, 0);

it('counts only the named sessions when session_ids is given', async () => {
  const { f, ctx, first, second } = await twoSessions();
  const query = { project_id: f.project.id, since: 0 };
  expect(total(turnInputTokens(ctx, query))).toBe(140);
  expect(total(turnInputTokens(ctx, { ...query, session_ids: [first.id] }))).toBe(100);
  expect(total(turnInputTokens(ctx, { ...query, session_ids: [second.id] }))).toBe(40);
});

it('leaves out a turn that ended at or after until', async () => {
  const { f, ctx } = await twoSessions();
  const query = { project_id: f.project.id, since: 0 };
  const [early, late] = turnInputTokens(ctx, query);
  expect(late!.ended_at).toBeGreaterThan(early!.ended_at);
  expect(total(turnInputTokens(ctx, { ...query, until: late!.ended_at }))).toBe(100);
});
