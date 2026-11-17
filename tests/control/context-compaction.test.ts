import { expect, it, vi } from 'vitest';
import type { BoardPlan, Session, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { settle } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
/** The contract lines a compacted task session is sent again. */
const CONTRACT = [
  'Goal: Exports download as CSV',
  'Scope (the paths you may change):',
  '- src/export.ts',
  'Acceptance commands:',
  '- pnpm test',
  'Done when: this worktree merges.',
].join('\n');
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);

async function setup() {
  const f = await workbenchFixture();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  Object.assign(ctx, {
    issueSessionCredential: () => ({ daemon_url: 'http://fixture', token_file: 'fixture-token' }),
  });
  const lead = await f.create('Let users download exports');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export downloads',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'export',
          title: 'Serve exports',
          goal: 'Exports download as CSV',
          lane: 'core',
          depends_on: [],
          source: ['Let users download exports'],
          scope: ['src/export.ts'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60_000,
    },
  );
  const worker = await boundTaskSession(f, lead.id, 'export');
  await settle(f, worker);
  const initial = f.start.mock.calls
    .find(([spec]) => spec.platform_session_id === worker.id)![0]
    .control_instructions!.split('\n\n')
    .at(-1)!;
  const send = vi.spyOn(f.adapter, 'send');
  const compact = (key: string, sessionId = worker.id, trigger: 'auto' | 'manual' = 'auto') =>
    agentEvent(ctx, sessionId, {
      kind: 'context.compacted',
      key,
      provider_sequence: 1,
      turn_id: f.turns(sessionId).at(-1)!.id,
      trigger,
    });
  const next = async (input = 'Continue') => {
    f.call<SessionTurn>(
      'session.send',
      { session_id: worker.id, input },
      current(f, worker.id).revision,
    );
    await settle(f, worker);
    return send.mock.calls.filter(([handle]) => handle.platform_session_id === worker.id).at(-1)![1]
      .input;
  };
  return { f, lead, worker, initial, send, compact, next };
}

it('resends only the task contract on the next turn once per compaction', async () => {
  const { initial, send, compact, next } = await setup();
  expect(initial).toContain('Acceptance commands:\n- pnpm test');
  compact('first');
  expect(send).not.toHaveBeenCalled();
  const resent = await next();
  expect(resent).toContain(CONTRACT);
  expect(resent).not.toContain('You are a task session');
  expect(await next('Again')).toBe('Again');
  compact('second');
  expect(await next()).toContain(CONTRACT);
  expect(await next('Finish')).toBe('Finish');
});

it('projects durable compaction counts per session and ignores replayed events', async () => {
  const { f, lead, worker, compact } = await setup();
  compact('first');
  compact('first');
  compact('second');
  compact('lead-first', lead.id);
  expect(f.list().find((session) => session.id === worker.id)).toHaveProperty(
    'compaction_count',
    2,
  );
  expect(f.list().find((session) => session.id === lead.id)).toHaveProperty('compaction_count', 1);
  const other = await f.create('Another conversation');
  expect(f.list().find((session) => session.id === other.id)).toHaveProperty('compaction_count', 0);
  await settle(f, other);
  await f.control.shutdown();
  await f.restart();
  expect(f.list().find((session) => session.id === worker.id)).toHaveProperty(
    'compaction_count',
    2,
  );
});

it('leaves a thrash signal with the session and cumulative count in the lead inbox without stopping work', async () => {
  const { f, lead, worker, compact } = await setup();
  let now = f.store.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const notes = () => f.store.must<BoardPlan>('board_plans', lead.id).inbox;
  compact('first');
  expect(notes()).toEqual([]);
  now += 60_000;
  compact('second');
  expect(notes()).toMatchObject([
    {
      kind: 'risk',
      session_id: worker.id,
      task_id: 'export',
      text: expect.stringContaining('Compaction thrash'),
    },
  ]);
  expect(notes()[0]!.text).toContain(worker.id);
  expect(notes()[0]!.text).toContain('2 compactions');
  compact('second');
  expect(notes()).toHaveLength(1);
  now += 5 * 60_000 + 1;
  compact('third');
  expect(notes()).toHaveLength(1);
  now += 60_000;
  compact('fourth');
  expect(notes()).toHaveLength(2);
  expect(notes()[1]!.text).toContain('4 compactions');
  expect(current(f, worker.id)).toMatchObject({ state: 'open' });
  expect(current(f, worker.id).stop_requested).toBeUndefined();
  f.call(
    'session.send',
    { session_id: lead.id, input: 'Check progress' },
    current(f, lead.id).revision,
  );
  await settle(f, lead);
  expect(f.turns(lead.id).at(-1)!.input).toContain('Compaction thrash');
  expect(f.turns(lead.id).at(-1)!.input).toContain(
    'What happened: Pantheon notes a risk on task export',
  );
  expect(f.turns(lead.id).at(-1)!.input).not.toContain('reports a risk');
});

it('keeps the contract pending when its input delivery is refused', async () => {
  const { send, compact, next } = await setup();
  compact('first');
  send.mockImplementationOnce(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'unsupported',
  }));
  expect(await next()).toContain(CONTRACT);
  expect(await next('Retry')).toContain(CONTRACT);
  expect(await next('Again')).toBe('Again');
});

it('restores the contract for each compaction received before the next turn', async () => {
  const { compact, next } = await setup();
  compact('first');
  compact('second');
  expect((await next()).split(CONTRACT)).toHaveLength(3);
  expect(await next('Again')).toBe('Again');
});

it('excludes manual compactions from both the thrash trigger and its history', async () => {
  const { f, lead, worker, compact } = await setup();
  const notes = () => f.store.must<BoardPlan>('board_plans', lead.id).inbox;
  compact('manual-first', worker.id, 'manual');
  compact('automatic-first');
  expect(notes()).toEqual([]);
  compact('manual-second', worker.id, 'manual');
  expect(notes()).toEqual([]);
  compact('automatic-second');
  expect(notes()).toHaveLength(1);
  expect(notes()[0]!.text).toContain('2 compactions');
  expect(f.list().find((session) => session.id === worker.id)?.compaction_count).toBe(4);
});

it('keeps post-compaction instructions for the next ordinary turn when the user compacts again', async () => {
  const { f, worker, compact, send, next } = await setup();
  compact('automatic-first');
  f.call(
    'session.compact',
    { session_id: worker.id, instructions: 'Keep the plan' },
    current(f, worker.id).revision,
  );
  await settle(f, worker);
  expect(send.mock.calls.at(-1)![1]).toMatchObject({ compact: true, input: 'Keep the plan' });
  expect((await next()).split(CONTRACT)).toHaveLength(3);
  expect(await next('Again')).toBe('Again');
});
