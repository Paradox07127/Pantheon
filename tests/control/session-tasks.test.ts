import { expect, it, vi } from 'vitest';
import type { AgentEvent, BackgroundTask, Session, SessionTask } from '@pantheon/domain';
import { settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
/** An agent event as a runtime emits it; the test numbers them in order. */
type Emitted = AgentEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'provider_sequence'>
    : never
  : never;
type Recorded = { at: number; event: Emitted };

const explorer = {
  id: 'explore-repo',
  kind: 'agent' as const,
  tool_call_id: 'call-explore',
  description: 'Explore the repository',
  agent_type: 'Explore',
  background: false,
  started_at: 1_000,
};
const devServer: BackgroundTask = {
  id: 'dev-server',
  kind: 'shell',
  description: 'pnpm dev',
  started_at: 2_000,
};
const usage = { tokens: 1200, tool_uses: 3, duration_ms: 4000 };

const started: Emitted = { kind: 'task.started', key: 'started', task: explorer };
const listed = (key: string, tasks: BackgroundTask[]): Emitted => ({
  kind: 'background.changed',
  key,
  tasks,
});

async function openSession() {
  const f = workbenchFixture();
  const session = f.create('Look around the repository');
  await settle(f, session);
  return { f, session };
}

/** Records the runtime events of the session at the given store times. */
function record(f: Fixture, sessionId: string, events: Recorded[]) {
  const now = vi.spyOn(f.store, 'now');
  for (const [index, { at, event }] of events.entries()) {
    now.mockReturnValue(at);
    f.store.event(
      `agent.${event.kind}`,
      f.store.must<Session>('sessions', sessionId),
      f.store.must<Session>('sessions', sessionId).project_id,
      { ...event, provider_sequence: index + 1 },
    );
  }
  now.mockRestore();
}

it.each<[string, Recorded[], Omit<SessionTask, 'session_id'>[]]>([
  [
    'opens a running row when a task starts',
    [{ at: 1_000, event: started }],
    [{ ...explorer, state: 'running' }],
  ],
  [
    'merges usage, the last tool and the summary of progress',
    [
      { at: 1_000, event: started },
      {
        at: 1_500,
        event: {
          kind: 'task.progress',
          key: 'progress-1',
          task_id: explorer.id,
          usage,
          last_tool: 'Read',
          summary: 'Reading the sources',
        },
      },
      {
        at: 1_600,
        event: {
          kind: 'task.progress',
          key: 'progress-2',
          task_id: explorer.id,
          last_tool: 'Grep',
        },
      },
    ],
    [{ ...explorer, state: 'running', usage, last_tool: 'Grep', summary: 'Reading the sources' }],
  ],
  [
    'settles a row when its task ends',
    [
      { at: 1_000, event: started },
      {
        at: 9_000,
        event: {
          kind: 'task.ended',
          key: 'ended',
          task_id: explorer.id,
          state: 'failed',
          summary: 'Gave up',
          usage,
          output_file: '/tmp/explore.out',
        },
      },
    ],
    [
      {
        ...explorer,
        state: 'failed',
        ended_at: 9_000,
        summary: 'Gave up',
        usage,
        output_file: '/tmp/explore.out',
      },
    ],
  ],
  [
    'ignores progress and an end of a task that never started',
    [
      {
        at: 1_500,
        event: { kind: 'task.progress', key: 'progress', task_id: 'hidden', last_tool: 'Read' },
      },
      {
        at: 9_000,
        event: { kind: 'task.ended', key: 'ended', task_id: 'hidden', state: 'completed' },
      },
    ],
    [],
  ],
  [
    'opens a row for a background task the runtime lists without a start',
    [{ at: 2_000, event: listed('listed', [devServer]) }],
    [{ ...devServer, background: true, state: 'running' }],
  ],
  [
    'completes a background task that left the list and keeps a foreground task running',
    [
      { at: 1_000, event: started },
      { at: 2_000, event: listed('listed', [devServer]) },
      { at: 7_000, event: listed('emptied', []) },
    ],
    [
      { ...explorer, state: 'running' },
      {
        ...devServer,
        background: true,
        state: 'completed',
        end_reason: 'ended_in_background',
        ended_at: 7_000,
      },
    ],
  ],
  [
    'stops the running tasks once the process exited',
    [
      { at: 1_000, event: started },
      { at: 2_000, event: listed('listed', [devServer]) },
      { at: 8_000, event: { kind: 'session.exited', key: 'exited', code: 0 } },
    ],
    [
      { ...explorer, state: 'stopped', end_reason: 'process_restarted', ended_at: 8_000 },
      {
        ...devServer,
        background: true,
        state: 'stopped',
        end_reason: 'process_restarted',
        ended_at: 8_000,
      },
    ],
  ],
])('%s', async (_name, events, tasks) => {
  const { f, session } = await openSession();
  record(f, session.id, events);
  expect(f.control.sessionTasks(user, session.id).tasks).toEqual(
    tasks.map((task) => ({ ...task, session_id: session.id })),
  );
});

it('reads the tasks at the sequence of the newest event of the session', async () => {
  const { f, session } = await openSession();
  record(f, session.id, [{ at: 1_000, event: started }]);
  const newest = f.store.db
    .prepare('SELECT max(sequence) AS sequence FROM events WHERE aggregate_id=?')
    .get(session.id) as { sequence: number };
  expect(f.control.sessionTasks(user, session.id).cursor).toBe(newest.sequence);
});

it('counts the running tasks on the session list', async () => {
  const { f, session } = await openSession();
  record(f, session.id, [
    { at: 1_000, event: started },
    { at: 2_000, event: listed('listed', [devServer]) },
  ]);
  const row = () => f.control.sessionList(user, f.project.id).find((s) => s.id === session.id)!;
  expect(row().tasks).toEqual({ running: 2 });
  record(f, session.id, [{ at: 3_000, event: { kind: 'session.exited', key: 'exited', code: 0 } }]);
  expect(row().tasks).toBeUndefined();
});
