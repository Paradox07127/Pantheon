import { describe, expect, it } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import type { DaemonEvent } from '@/data/sync';
import { recentActivity } from '@/data/recent-activity';

const session = (id: string): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
});

let sequence = 0;
const event = (kind: string, aggregate_id: string, payload: unknown = {}): DaemonEvent => {
  sequence += 1;
  return {
    sequence,
    event_id: `event-${sequence}`,
    kind,
    aggregate_id,
    aggregate_revision: 1,
    project_id: 'project-a',
    causation_id: '',
    created_at: 1000 + sequence,
    payload,
  };
};
const completed = (session_id: string) => event('turn.completed', `turn-${session_id}`);

const sessions = [session('a'), session('b')];
const turns = [
  { id: 'turn-a', session_id: 'a' },
  { id: 'turn-b', session_id: 'b' },
  { id: 'turn-other', session_id: 'other' },
];
const shape = (rows: ReturnType<typeof recentActivity>) =>
  rows.map((row) => [row.session_id, row.kind]);

describe('recent activity', () => {
  it.each([
    [
      'keeps confirmed gate and merge cancellations as neutral history entries',
      [
        event('session.merge_cancel_requested', 'a'),
        event('session.merge_cancelled', 'a'),
        event('session.gate_run_cancelled', 'b'),
      ],
      [
        ['b', 'cancelled'],
        ['a', 'cancelled'],
      ],
    ],
    [
      'keeps merges, blocked merges, failed turns and completed turns only',
      [
        event('session.merged', 'a'),
        event('session.merge_blocked', 'b'),
        event('turn.failed', 'turn-a', { error: 'boom' }),
        completed('b'),
        event('agent.turn.completed', 'a', { kind: 'turn.completed' }),
        event('agent.message.delta', 'a', { turn_id: 'turn-a' }),
        event('session.created', 'a'),
      ],
      [
        ['b', 'completed'],
        ['a', 'failed'],
        ['b', 'merge_blocked'],
        ['a', 'merged'],
      ],
    ],
    [
      'leaves out events of sessions outside the list',
      [
        event('session.merged', 'other'),
        event('turn.failed', 'turn-other'),
        event('turn.failed', 'turn-unknown'),
        completed('a'),
      ],
      [['a', 'completed']],
    ],
  ])('%s', (_, events, expected) => {
    expect(shape(recentActivity(events, sessions, turns))).toEqual(expected);
  });

  it('puts the newest first with the event id and time', () => {
    const merged = event('session.merged', 'a');
    const done = completed('b');
    expect(recentActivity([merged, done], sessions, turns)).toEqual([
      { id: done.event_id, session_id: 'b', kind: 'completed', at: done.created_at },
      { id: merged.event_id, session_id: 'a', kind: 'merged', at: merged.created_at },
    ]);
  });

  it('keeps at most the limit', () => {
    const events = Array.from({ length: 80 }, (_, i) => event('session.merged', i % 2 ? 'a' : 'b'));
    expect(recentActivity(events, sessions, turns)).toHaveLength(50);
    const three = recentActivity(events, sessions, turns, 3);
    expect(three.map((row) => row.id)).toEqual(
      events
        .slice(-3)
        .reverse()
        .map((e) => e.event_id),
    );
  });

  it('keeps only the newest of the completed turns a session has in a row', () => {
    const first = completed('a');
    const otherSession = completed('b');
    const second = completed('a');
    const merged = event('session.merged', 'a');
    const third = completed('a');
    const fourth = completed('a');
    expect(
      recentActivity([first, otherSession, second, merged, third, fourth], sessions, turns).map(
        (row) => row.id,
      ),
    ).toEqual([fourth.event_id, merged.event_id, second.event_id, otherSession.event_id]);
  });
});

describe('recent activity of a turn that did not complete', () => {
  it('lists a failed turn once and leaves out cancelled turns and raw runtime turn ends', () => {
    const rows = recentActivity(
      [
        event('agent.turn.completed', 'a', { turn_id: 'turn-a', status: 'failed' }),
        event('turn.failed', 'turn-a', { error: 'boom' }),
        event('agent.turn.completed', 'b', { turn_id: 'turn-b', status: 'interrupted' }),
        event('turn.cancelled', 'turn-b', { reason: 'interrupted' }),
      ],
      sessions,
      turns,
    );
    expect(rows.map((r) => [r.session_id, r.kind])).toEqual([['a', 'failed']]);
  });
});
