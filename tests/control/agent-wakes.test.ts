import { expect, it, vi } from 'vitest';
import {
  id,
  type AgentMessage,
  type AgentProfile,
  type LeadNote,
  type LeadQuestion,
  type Principal,
  type Session,
} from '@pantheon/domain';
import { eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const MINUTE = 60_000;

const lead = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60 * MINUTE,
});

/** A fixture at 09:00 local time tomorrow whose assistant has an enabled and a disabled routine. */
async function routineFixture(delay = 0) {
  const f = await workbenchFixture({ delay });
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  let now = start.getTime();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  const as = <T = unknown>(type: Parameters<Fixture['call']>[0], input: Record<string, unknown>) =>
    f.call<T>(type, { project_id: f.project.id, ...input }, null, lead(f, assistant.id));
  as('agent.routine.set', {
    id: 'stalled',
    prompt: 'Look for stalled tasks',
    at: '18:00',
    enabled: true,
  });
  as('agent.routine.set', {
    id: 'paused',
    prompt: 'Look for stale branches',
    every_minutes: 60,
    enabled: false,
  });
  const profile = () => f.store.must<AgentProfile>('agents', assistant.resident!.agent_id!);
  const trackerTurns = () => f.turns(assistant.id).filter((turn) => turn.origin === 'tracker');
  const ended = () =>
    f.turns(assistant.id).every((turn) => turn.state !== 'queued' && turn.state !== 'running');
  return {
    f,
    assistant,
    as,
    profile,
    trackerTurns,
    ended,
    start: start.getTime(),
    advance: (ms: number) => (now += ms),
    run: (routineId: string) =>
      f.call('agent.routine.run', { agent_id: profile().id, routine_id: routineId }),
  };
}

it('runs an enabled routine now even while the contract holds its wakes, refuses a disabled one, and lists the wake', async () => {
  const { f, assistant, profile, trackerTurns, ended, run } = await routineFixture();
  f.call('agent.update', {
    agent_id: profile().id,
    revision: profile().revision,
    contract: { quiet_hours: { from: '08:00', to: '18:00' } },
  });
  expect(() => run('paused')).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(() =>
    f.call(
      'agent.routine.run',
      { agent_id: profile().id, routine_id: 'stalled' },
      null,
      lead(f, assistant.id),
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));

  run('stalled');
  await eventually(
    () => trackerTurns().length === 1 && ended(),
    () => f.control.tick(),
  );
  const [turn] = trackerTurns();
  expect(turn!.wake).toEqual({ causes: ['routine'], routine_ids: ['stalled'] });
  expect(f.store.events(0, f.project.id, 1000, ['agent.wake_held'])).toEqual([]);
  expect(f.control.agentWakes(user, profile().id, 10)).toEqual([
    expect.objectContaining({
      turn_id: turn!.id,
      session_id: assistant.id,
      state: 'completed',
      causes: ['routine'],
      routine_ids: ['stalled'],
      outcome: 'nothing',
      message_ids: [],
      question_ids: [],
      actions: 0,
    }),
  ]);
});

it('classes a wake that asked the user and left a message as asked, with both ids', async () => {
  const { f, as, profile, trackerTurns, ended, run } = await routineFixture(3000);
  run('stalled');
  await eventually(
    () => trackerTurns()[0]?.state === 'running',
    () => f.control.tick(),
  );
  const message = as<AgentMessage>('agent.tell_user', {
    text: 'Two tasks stalled overnight.',
    urgency: 'normal',
  });
  const question = as<LeadQuestion>('lead.ask', {
    question: 'Restart the stalled tasks?',
    options: ['Yes', 'No'],
    recommended: 'Yes',
    assumption: 'They stay stopped.',
    blocks: [],
  });
  await eventually(ended, () => f.control.tick(), 20_000);
  expect(f.control.agentWakes(user, profile().id, 10)).toEqual([
    expect.objectContaining({
      outcome: 'asked',
      message_ids: [message.id],
      question_ids: [question.id],
    }),
  ]);
});

it("lists a wake's messages and questions by their first line, cut at 140 characters, and counts the tasks it started", async () => {
  const { f, assistant, as, profile, trackerTurns, ended, run } = await routineFixture(3000);
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: assistant.id,
    input: 'Restart the stalled export tasks.',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  run('stalled');
  await eventually(
    () => trackerTurns()[0]?.state === 'running',
    () => f.control.tick(),
  );
  const message = as<AgentMessage>('agent.tell_user', {
    text: `${'Two tasks stalled overnight. '.repeat(6)}\nBoth wait on the export.`,
    urgency: 'normal',
  });
  const question = as<LeadQuestion>('lead.ask', {
    question: 'Restart the stalled tasks?\nThey stopped at midnight.',
    options: ['Yes', 'No'],
    recommended: 'Yes',
    assumption: 'They stay stopped.',
    blocks: [],
  });
  const task = (taskId: string) => ({
    id: taskId,
    title: `Restart ${taskId}`,
    goal: `Restart the stalled ${taskId} task`,
    lane: 'core',
    depends_on: [],
    source: ['Restart the stalled export tasks'],
    scope: [],
    acceptance: [],
    done_when: 'report',
  });
  as('board.plan.update', {
    base_version: 0,
    headline: 'Restart the stalled tasks',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [task('export'), task('import')],
    milestones: [],
    risks: [],
    assumptions: [],
  });
  as('task.start', { task_ids: ['export', 'import'] });
  await eventually(ended, () => f.control.tick(), 20_000);
  expect(f.control.agentWakes(user, profile().id, 10)).toEqual([
    expect.objectContaining({
      message_ids: [message.id],
      question_ids: [question.id],
      messages: [{ id: message.id, text: 'Two tasks stalled overnight. '.repeat(6).slice(0, 140) }],
      questions: [{ id: question.id, text: 'Restart the stalled tasks?' }],
      actions: 2,
      tasks_started: 2,
    }),
  ]);
});

it('lists each routine with its next run and the outcome of its last run', async () => {
  const { f, profile, trackerTurns, ended, run, start } = await routineFixture();
  run('stalled');
  await eventually(
    () => trackerTurns().length === 1 && ended(),
    () => f.control.tick(),
  );
  const routines = f.control.agentRoutines(user, f.project.id);
  expect(routines).toEqual([
    {
      agent_id: profile().id,
      agent_name: 'Assistant',
      agent_revision: profile().revision,
      routine: { id: 'stalled', prompt: 'Look for stalled tasks', at: '18:00', enabled: true },
      next_run_at: start + 9 * 60 * MINUTE,
      last_run: {
        turn_id: trackerTurns()[0]!.id,
        at: expect.any(Number),
        state: 'completed',
        outcome: 'nothing',
      },
    },
    {
      agent_id: profile().id,
      agent_name: 'Assistant',
      agent_revision: profile().revision,
      routine: {
        id: 'paused',
        prompt: 'Look for stale branches',
        every_ms: 60 * MINUTE,
        enabled: false,
      },
    },
  ]);
});

it("hands a wake's output to the Assistant as the user's request, whose words a task may quote", async () => {
  const { f, assistant, trackerTurns, ended, run, advance } = await routineFixture();
  run('stalled');
  await eventually(
    () => trackerTurns().length === 1 && ended(),
    () => f.control.tick(),
  );
  const writePlan = () =>
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: 0,
        headline: 'Fix what the routine found',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [
          {
            id: 'fix',
            title: 'Fix',
            goal: 'Fix what the routine found',
            lane: 'core',
            milestone: 'm1',
            depends_on: [],
            source: ['fixture completed'],
            scope: ['src'],
            acceptance: ['pnpm test'],
          },
        ],
        milestones: [{ id: 'm1', title: 'Fixed', criteria: ['Fixed'], tasks: ['fix'] }],
        risks: [],
        assumptions: [],
      },
      null,
      lead(f, assistant.id),
    );
  expect(writePlan).toThrow(/fixture completed/);

  f.call('agent.wake.to_task', { turn_id: trackerTurns()[0]!.id });
  const notes = f.store
    .events(0, f.project.id, 1000, ['lead.note_added'])
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === 'user_edit');
  expect(notes).toEqual([
    expect.objectContaining({
      bypass_hold: 'user',
      text: expect.stringContaining(`turn ${trackerTurns()[0]!.id} on routine stalled`),
    }),
  ]);
  expect(notes[0]!.text).toContain('fixture completed');
  advance(2 * MINUTE);
  await eventually(
    () => trackerTurns().length === 2,
    () => f.control.tick(),
  );
  expect(trackerTurns()[1]!.wake?.causes).toEqual(['user_edit']);
  expect(writePlan).not.toThrow();
  expect(() =>
    f.call('agent.wake.to_task', { turn_id: trackerTurns()[0]!.id }, null, lead(f, assistant.id)),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});
