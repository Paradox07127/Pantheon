import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentProfile,
  BoardPlan,
  MemoryRecord,
  Principal,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { ensureAgents } from '../../packages/control/dist/agents.js';
import { memoryContext } from '../../packages/control/dist/memory.js';
import { eventually, user } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const as = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000,
});
const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const assistantProfile = (f: Fixture) => {
  const ctx = f.control['ctx'] as ControlContext;
  ctx.store.transaction(() => ensureAgents(ctx, f.project.id));
  return f.control.agentList(user, f.project.id).find((agent) => agent.template === 'assistant')!;
};
const open = (f: Fixture) =>
  f.call<Session>('resident.open', { project_id: f.project.id, kind: 'assistant' });
const residents = (f: Fixture, profile: AgentProfile) =>
  f.store.list<Session>('sessions').filter((session) => session.resident?.agent_id === profile.id);
const successorOf = (f: Fixture, profile: AgentProfile, old: Session) =>
  residents(f, profile).find((session) => session.id !== old.id && session.state !== 'closed');
const flushTurns = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');
const idle = (f: Fixture, sessionId: string) =>
  current(f, sessionId).state !== 'running' &&
  f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state));

/** A user turn whose fixture run reports this context usage at its end. */
const usage = (numbers: {
  context_tokens: number;
  context_window: number;
  auto_compact_at_tokens?: number;
}) => `fixture-script\n${JSON.stringify([{ say: 'Noted' }, { usage: numbers }])}`;

function send(f: Fixture, sessionId: string, input: string) {
  f.call('session.send', { session_id: sessionId, input }, current(f, sessionId).revision);
}

/** Waits until the old resident is closed and its successor has finished its turns. */
async function rotated(f: Fixture, profile: AgentProfile, old: Session) {
  await eventually(
    () => {
      const next = successorOf(f, profile, old);
      return current(f, old.id).state === 'closed' && !!next && idle(f, next.id);
    },
    () => f.control.tick(),
    10_000,
  );
  return successorOf(f, profile, old)!;
}

/** Asks the lead for the plan, then writes it as the lead, so the task quotes the user. */
async function planFor(f: Fixture, leadId: string) {
  send(f, leadId, 'Plan the export feature');
  await eventually(
    () => idle(f, leadId),
    () => f.control.tick(),
  );
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Task a',
          goal: 'Finish task a',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/a.ts'],
          acceptance: ['pnpm test'],
          kind: { domain: 'backend-logic', tier: 't1' },
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    as(f, leadId, 'lead'),
  );
}

it('queues one quiet handoff turn when a resident turn ends at 80% of the auto-compaction point, and none at 79%', async () => {
  const f = await workbenchFixture();
  const profile = assistantProfile(f);
  const below = open(f);
  send(
    f,
    below.id,
    usage({ context_tokens: 79_000, context_window: 200_000, auto_compact_at_tokens: 100_000 }),
  );
  await eventually(
    () => idle(f, below.id) && f.turns(below.id).length === 1,
    () => f.control.tick(),
  );
  expect(current(f, below.id).usage).toMatchObject({
    context_tokens: 79_000,
    context_window: 200_000,
  });
  expect(current(f, below.id).auto_compact_at_tokens).toBe(100_000);
  await f.control.tick();
  expect(flushTurns(f, below.id)).toEqual([]);
  expect(current(f, below.id).state).toBe('open');
  expect(residents(f, profile)).toHaveLength(1);

  send(
    f,
    below.id,
    usage({ context_tokens: 80_000, context_window: 200_000, auto_compact_at_tokens: 100_000 }),
  );
  await eventually(
    () => flushTurns(f, below.id).length > 0,
    () => f.control.tick(),
  );
  const [flush] = flushTurns(f, below.id);
  expect(flush!.input).toContain('Call guide with name "handoff"');
  expect(flush!.input).toContain('memory_propose');
  expect(flush!.input).toContain(`handoff/${profile.id}`);
  expect(flush!.input).toContain(`Handoff from ${below.title}`);
  await rotated(f, profile, below);
  expect(flushTurns(f, below.id)).toHaveLength(1);
  expect(f.store.kindEvents(f.project.id, ['agent_message.created'])).toEqual([]);
});

it('gives a resident the handoff guide by name, and the list of guides for a name it does not know', async () => {
  const f = await workbenchFixture();
  const resident = open(f);
  const guide = await f.call<Promise<{ name: string; text: string }>>(
    'agent.guide',
    { name: 'handoff' },
    null,
    as(f, resident.id, 'lead'),
  );
  expect(guide.name).toBe('handoff');
  expect(guide.text).toContain('Open requests and promises');
  expect(guide.text).toContain('memory_propose');
  const index = await f.call<Promise<{ guides: { name: string; when: string }[] }>>(
    'agent.guide',
    { name: 'merging' },
    null,
    as(f, resident.id, 'lead'),
  );
  expect(index.guides.map((each) => each.name)).toEqual([
    'handoff',
    'merge_and_gate',
    'gate_failure_triage',
    'milestone_review',
    'worker_brief',
  ]);
});

it('measures a runtime without an auto-compaction point against its context window', async () => {
  const f = await workbenchFixture();
  const profile = assistantProfile(f);
  const assistant = open(f);
  send(f, assistant.id, usage({ context_tokens: 80_000, context_window: 100_000 }));
  await eventually(
    () => flushTurns(f, assistant.id).length > 0,
    () => f.control.tick(),
  );
  expect(flushTurns(f, assistant.id)[0]!.input).toContain(`handoff/${profile.id}`);
  await rotated(f, profile, assistant);
});

it('hands the plan to a new session of the agent after the handoff turn, naming the old session and the handoff note', async () => {
  const f = await workbenchFixture();
  const profile = assistantProfile(f);
  const old = open(f);
  await planFor(f, old.id);
  send(f, old.id, usage({ context_tokens: 90_000, context_window: 100_000 }));
  const next = await rotated(f, profile, old);
  expect(current(f, old.id).state).toBe('closed');
  expect(next).toMatchObject({
    state: 'open',
    resident: { kind: 'assistant', agent_id: profile.id },
  });
  expect(f.store.get<BoardPlan>('board_plans', old.id)).toBeUndefined();
  expect(f.store.must<BoardPlan>('board_plans', next.id).tasks.map((task) => task.id)).toEqual([
    'a',
  ]);
  const [takeover] = f.turns(next.id);
  expect(takeover!.input).toContain(old.id);
  expect(takeover!.input).toContain(`handoff/${profile.id}`);
});

it("puts the note the old session wrote during the handoff turn in the new session's memory packet", async () => {
  const f = await workbenchFixture({ delay: 600 });
  const profile = assistantProfile(f);
  const old = open(f);
  send(f, old.id, usage({ context_tokens: 90_000, context_window: 100_000 }));
  await eventually(
    () => flushTurns(f, old.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  const lead = as(f, old.id, 'lead');
  const note = f.call<MemoryRecord>(
    'memory.propose',
    {
      project_id: f.project.id,
      key: `handoff/${profile.id}`,
      kind: 'note',
      title: `Handoff from ${old.title}`,
      tags: ['handoff'],
      text: 'The user asked for a weekly export summary and prefers short answers.',
      based_on: f.call<{ signature: string }>(
        'memory.context',
        { project_id: f.project.id },
        null,
        lead,
      ).signature,
    },
    null,
    lead,
  );
  const next = await rotated(f, profile, old);
  const ctx = f.control['ctx'] as ControlContext;
  expect(
    memoryContext(ctx, f.project.id, current(f, next.id)).items.map((item) => item.id),
  ).toContain(note.id);
});

it('keeps task memory written under the old plan current and visible to the task after the plan moves', async () => {
  const f = await workbenchFixture();
  const other = new FixtureAdapter(0);
  other.name = 'fixture-other';
  f.control.adapters.set(other.name, other);
  const profile = assistantProfile(f);
  const old = open(f);
  await planFor(f, old.id);
  const worker = await boundTaskSession(f, old.id, 'a');
  const w = as(f, worker.id, 'worker');
  const propose = (text: string) =>
    f.call<MemoryRecord>(
      'memory.propose',
      {
        project_id: f.project.id,
        key: 'export-format',
        kind: 'note',
        text,
        based_on: f.call<{ signature: string }>(
          'memory.context',
          { project_id: f.project.id },
          null,
          w,
        ).signature,
      },
      null,
      w,
    );
  const first = propose('Rows export as CSV with a header line.');
  expect(first.task).toEqual({ lead_session_id: old.id, id: 'a', generation: 1 });

  f.call('agent.update', { agent_id: profile.id, revision: profile.revision, runtime: other.name });
  const next = successorOf(f, profile, old)!;
  expect(current(f, worker.id).task?.lead_session_id).toBe(next.id);
  expect(f.call<{ text: string }>('memory.get', { memory_id: first.id }, null, w).text).toBe(
    'Rows export as CSV with a header line.',
  );
  expect(
    f
      .call<{ items: { id: string }[] }>('memory.context', { project_id: f.project.id }, null, w)
      .items.map((item) => item.id),
  ).toContain(first.id);

  const second = propose('Rows export as CSV with a header line and a total row.');
  expect(f.store.must<MemoryRecord>('memory_records', first.id)).toMatchObject({
    state: 'archived',
    reason: 'superseded',
    superseded_by: second.id,
  });
});

/** Proposes the agent's handoff note as the session's lead. */
function writeHandoff(f: Fixture, profile: AgentProfile, sessionId: string, text: string) {
  const lead = as(f, sessionId, 'lead');
  return f.call<MemoryRecord>(
    'memory.propose',
    {
      project_id: f.project.id,
      key: `handoff/${profile.id}`,
      kind: 'note',
      title: `Handoff from ${current(f, sessionId).title}`,
      tags: ['handoff'],
      text,
      based_on: f.call<{ signature: string }>(
        'memory.context',
        { project_id: f.project.id },
        null,
        lead,
      ).signature,
    },
    null,
    lead,
  );
}

it('rolls an idle resident opened eight days ago when its next turn ends, for the reason weekly', async () => {
  const f = await workbenchFixture();
  const profile = assistantProfile(f);
  const old = open(f);
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + 8 * 24 * 60 * 60 * 1000);
  send(f, old.id, 'What changed today?');
  await eventually(
    () => flushTurns(f, old.id).length > 0,
    () => f.control.tick(),
  );
  expect(flushTurns(f, old.id)[0]!.input).toContain('This session has run for a week');
  expect(flushTurns(f, old.id)[0]!.input).toContain(`handoff/${profile.id}`);
  const next = await rotated(f, profile, old);
  expect(current(f, old.id).rotation?.reason).toBe('weekly');
  expect(
    f.store
      .kindEvents(f.project.id, ['session.closed'])
      .find((event) => event.aggregate_id === old.id)!.payload,
  ).toEqual({ reason: 'weekly' });
  expect(f.turns(next.id)[0]!.input).toContain('ended after a week');
});

it('rolls after the running turn when the instructions change, and the new chapter names the handoff note and the one before it', async () => {
  const f = await workbenchFixture({ delay: 600 });
  const profile = assistantProfile(f);
  const old = open(f);
  const earlier = writeHandoff(f, profile, old.id, 'The user wants a weekly export summary.');
  send(f, old.id, 'Summarise the board');
  await eventually(
    () => f.turns(old.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  f.call('agent.update', {
    agent_id: profile.id,
    revision: profile.revision,
    instructions: 'Answer in one line.',
  });
  await eventually(
    () => flushTurns(f, old.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  expect(f.turns(old.id)[0]!.state).toBe('completed');
  expect(flushTurns(f, old.id)[0]!.input).toContain('Your instructions changed');
  const note = writeHandoff(f, profile, old.id, 'The user wants the weekly export in one line.');
  const next = await rotated(f, profile, old);
  expect(current(f, old.id).rotation?.reason).toBe('instructions_changed');
  expect(f.turns(next.id)[0]!.input).toContain('instructions changed');
  const chapters = f.store.kindEvents(f.project.id, ['agent.chapter_started']);
  expect(chapters).toHaveLength(1);
  expect(chapters[0]).toMatchObject({
    aggregate_id: next.id,
    payload: { chapter: 2, handoff_memory_id: note.id, previous_memory_id: earlier.id },
  });
  // The new session started on the new instructions, so its turns end without another roll.
  send(f, next.id, 'Anything new?');
  await eventually(
    () => idle(f, next.id) && f.turns(next.id).length === 2,
    () => f.control.tick(),
  );
  expect(flushTurns(f, next.id)).toEqual([]);
});

it("names the handoff key on each chapter, so an older chapter's note and the one before it stay readable", async () => {
  const f = await workbenchFixture({ delay: 600 });
  const profile = assistantProfile(f);
  const first = open(f);
  const earlier = writeHandoff(f, profile, first.id, 'The user wants a weekly export summary.');
  const rotate = async (old: Session, instructions: string, text: string) => {
    f.call('agent.update', {
      agent_id: profile.id,
      revision: f.store.must<AgentProfile>('agents', profile.id).revision,
      instructions,
    });
    await eventually(
      () => flushTurns(f, old.id)[0]?.state === 'running',
      () => f.control.tick(),
    );
    const note = writeHandoff(f, profile, old.id, text);
    return { note, next: await rotated(f, profile, old) };
  };
  const one = await rotate(first, 'Answer in one line.', 'The user wants the export in one line.');
  const two = await rotate(one.next, 'Answer in two lines.', 'The user wants two lines.');
  const chapters = f.store.kindEvents(f.project.id, ['agent.chapter_started']);
  expect(chapters.map((event) => event.payload)).toEqual([
    {
      chapter: 2,
      handoff_key: `handoff/${profile.id}`,
      handoff_memory_id: one.note.id,
      previous_memory_id: earlier.id,
    },
    {
      chapter: 3,
      handoff_key: `handoff/${profile.id}`,
      handoff_memory_id: two.note.id,
      previous_memory_id: one.note.id,
    },
  ]);
  const { items } = f.call<{ items: { id: string; text: string }[] }>(
    'memory.history',
    {
      project_id: f.project.id,
      key: (chapters[0]!.payload as { handoff_key: string }).handoff_key,
    },
    null,
  );
  expect(items.find((item) => item.id === one.note.id)?.text).toBe(
    'The user wants the export in one line.',
  );
  expect(items.find((item) => item.id === earlier.id)?.text).toBe(
    'The user wants a weekly export summary.',
  );
});

it('starts the handoff at once when the instructions change while the resident is idle', async () => {
  const f = await workbenchFixture();
  const profile = assistantProfile(f);
  const old = open(f);
  f.call('agent.update', {
    agent_id: profile.id,
    revision: profile.revision,
    instructions: 'Answer in one line.',
  });
  await eventually(
    () => flushTurns(f, old.id).length > 0,
    () => f.control.tick(),
  );
  await rotated(f, profile, old);
  expect(current(f, old.id).rotation?.reason).toBe('instructions_changed');
});

it('rotates only after a user message queued during the handoff turn is done', async () => {
  const f = await workbenchFixture({ delay: 600 });
  const profile = assistantProfile(f);
  const old = open(f);
  send(f, old.id, usage({ context_tokens: 90_000, context_window: 100_000 }));
  await eventually(
    () => flushTurns(f, old.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  // A message the user sends while a turn runs waits behind it on a runtime that cannot steer.
  f.call(
    'session.steer',
    { session_id: old.id, input: 'One more thing: keep the export weekly' },
    current(f, old.id).revision,
  );
  const queued = f.turns(old.id).at(-1)!;
  expect(queued).toMatchObject({
    state: 'queued',
    input: 'One more thing: keep the export weekly',
  });
  expect(queued.origin).toBeUndefined();
  await rotated(f, profile, old);
  expect(f.store.must<SessionTurn>('session_turns', queued.id).state).toBe('completed');
  const ended = f.store
    .kindEvents(f.project.id, ['turn.completed'])
    .find((event) => event.aggregate_id === queued.id)!;
  const closed = f.store
    .kindEvents(f.project.id, ['session.closed'])
    .find((event) => event.aggregate_id === old.id)!;
  expect(closed.sequence).toBeGreaterThan(ended.sequence);
  expect(flushTurns(f, old.id)).toHaveLength(1);
});
