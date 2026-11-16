import { describe, expect, it } from 'vitest';
import type { BoardModel, BoardSegment } from '@pantheon/protocol';
import { RECENT_MS, runSessionIds, runtimeBoard } from '@/screens/runtime/runtime-model';

type Task = BoardModel['tasks'][number];
type Lead = NonNullable<BoardModel['leads']>[number];

const segment = (id: string, extra: Partial<BoardSegment> = {}): BoardSegment => ({
  id,
  session_id: id,
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  status: 'running',
  started_at: null,
  ended_at: null,
  tokens: 0,
  ...extra,
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'running',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  ...extra,
});

const lead = (session_id: string): Lead => ({
  session_id,
  title: `lead ${session_id}`,
  state: 'running',
  inbox: 0,
  updated_at: 0,
});

const queued: Task['activity'] = { phase: 'queued', since: 0, health: 'fresh', attempt: 1 };

describe('runtimeBoard', () => {
  const NOW = 10 * 60 * 60_000;
  const old = NOW - RECENT_MS - 1;
  const recent = NOW - RECENT_MS;

  it('keeps tasks live now and tasks with progress within the hour, in board order', () => {
    const { tasks } = runtimeBoard({
      now: NOW,
      since: 0,
      tasks: [
        task('lead:done-old', { status: 'done', last_progress_at: old }),
        task('lead:done-recent', { status: 'done', last_progress_at: recent }),
        task('lead:wait', { status: 'waiting', last_progress_at: old }),
        task('lead:todo', { status: 'todo' }),
        task('lead:queued', { status: 'todo', activity: queued }),
        task('lead:run'),
        task('lead:turn', { status: 'idle', turn_running: true, last_progress_at: old }),
        task('adhoc-done', { status: 'done', last_progress_at: old }),
        task('adhoc-run'),
      ],
    });
    expect(tasks.map((t) => t.id)).toEqual([
      'lead:done-recent',
      'lead:wait',
      'lead:queued',
      'lead:run',
      'lead:turn',
      'adhoc-run',
    ]);
  });

  it('drops a session idle for longer than the hour and keeps one that just ended its turn', () => {
    const { tasks } = runtimeBoard({
      now: NOW,
      since: 0,
      tasks: [
        task('lead:stale', { status: 'idle', last_progress_at: old }),
        task('adhoc-stale', { status: 'idle', last_progress_at: old }),
        task('lead:fresh', { status: 'idle', last_progress_at: NOW - 1000 }),
      ],
    });
    expect(tasks.map((t) => t.id)).toEqual(['lead:fresh']);
  });

  it('keeps a lead that runs, waits, changed its plan within the hour or owns a kept task', () => {
    const at = (session_id: string, extra: Partial<Lead>): Lead => ({
      ...lead(session_id),
      updated_at: old,
      ...extra,
    });
    const { leads } = runtimeBoard({
      now: NOW,
      since: 0,
      leads: [
        at('running', {}),
        at('waiting', { state: 'waiting' }),
        at('planned', { state: 'idle', updated_at: recent }),
        at('owner', { state: 'idle' }),
        at('stale', { state: 'idle' }),
        at('closed', { state: 'closed' }),
      ],
      tasks: [
        task('owner:run', { owner_session_id: 'owner' }),
        task('stale:old', { owner_session_id: 'stale', status: 'done', last_progress_at: old }),
      ],
    });
    expect(leads?.map((l) => l.session_id)).toEqual(['running', 'waiting', 'planned', 'owner']);
  });
});

describe('runSessionIds', () => {
  it('reads the leads and the sessions open or ended within the range, each once', () => {
    const ids = runSessionIds({
      since: 1_000,
      leads: [lead('lead-1')],
      tasks: [
        task('lead-1:a', {
          segments: [
            segment('old', { ended_at: 999 }),
            segment('recent', { ended_at: 1_000 }),
            segment('open'),
            segment('none', { session_id: null }),
          ],
        }),
        task('lead-1:b', { segments: [segment('open'), segment('lead-1')] }),
      ],
    });
    expect(ids).toEqual(['lead-1', 'recent', 'open']);
  });

  it('reads nothing without leads or segments', () => {
    expect(runSessionIds({ since: 0, tasks: [] })).toEqual([]);
  });
});
