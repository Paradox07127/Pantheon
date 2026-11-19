import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardActivity, BoardModel } from '@pantheon/protocol';
import { activityNote } from '@/screens/board/activity';
import { LeadPanel } from '@/screens/board/LeadPanel';
import type { BoardLead } from '@/screens/board/frame-model';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 19, 12);
const MIN = 60_000;

const task = (patch: Partial<Task>): Task => ({
  id: 'lead:t1',
  title: 'split the milestone',
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
  turn_running: true,
  ...patch,
});

const activity = (patch: Partial<BoardActivity>): BoardActivity => ({
  phase: 'tool',
  since: NOW - 5 * MIN,
  tool: { name: 'Read' },
  health: 'fresh',
  attempt: 1,
  ...patch,
});

const ago = (minutes: number) =>
  zhf('board.task.activity.ago', { age: zhf('data.age.minutes', { count: minutes }) });
const statusLine = (minutes: number) => ({
  text: 'splitting the last 2 tasks of M3',
  at: NOW - minutes * MIN,
});
const recap = (minutes: number) => ({
  headline: 'Ledger imported',
  happened: '',
  at: NOW - minutes * MIN,
});

describe('status line on the board', () => {
  it("shows a running task's status line with when it was written, else the tool under way", () => {
    expect(activityNote(task({ activity: activity({}), status_line: statusLine(3) }), NOW)).toEqual(
      { text: 'splitting the last 2 tasks of M3', ago: ago(3) },
    );
    expect(activityNote(task({ activity: activity({}) }), NOW)).toEqual({
      text: `${zh('runs.table.verb.read')}，5 分钟`,
    });
  });

  it('shows the newer of the status line and the recap', () => {
    const idle = { status: 'idle' as const, activity: activity({ phase: 'idle' }) };
    expect(
      activityNote(task({ ...idle, status_line: statusLine(9), recap: recap(2) }), NOW),
    ).toEqual({ text: 'Ledger imported', ago: ago(2) });
    expect(
      activityNote(task({ ...idle, status_line: statusLine(2), recap: recap(9) }), NOW),
    ).toEqual({ text: 'splitting the last 2 tasks of M3', ago: ago(2) });
  });

  it('keeps the board state over the status line, without a time', () => {
    const waiting = task({
      status: 'todo',
      dispatch_wait: 'capacity',
      activity: activity({ phase: 'queued' }),
      status_line: statusLine(1),
    });
    expect(activityNote(waiting, NOW)).toEqual({ text: zh('board.task.activity.waitingSlot') });
  });
});

describe('lead line', () => {
  afterEach(() => vi.useRealTimers());

  const lead: BoardLead = {
    session_id: 'lead-1',
    title: 'Plan',
    state: 'idle',
    inbox: 0,
    updated_at: NOW,
    activity: activity({ phase: 'idle', tool: undefined }),
    status_line: statusLine(3),
  };
  const html = (needs: unknown[]) => {
    vi.useFakeTimers({ now: NOW });
    return renderToStaticMarkup(
      createElement(LeadPanel, {
        model: { now: NOW, tasks: [], needs, leads: [lead] } as unknown as BoardModel,
        sessions: [],
        onOpenSession: vi.fn(),
        onOpenTask: vi.fn(),
      }),
    );
  };
  const line = (out: string) =>
    /<span class="bld-do" title="[^"]*">(.*?)<\/span><\/span>/
      .exec(out)?.[1]
      ?.replace(/<[^>]+>/g, '');

  it('says the status line and when the lead wrote it in one element', () => {
    expect(line(html([]))).toBe(`splitting the last 2 tasks of M3 ${ago(3)}`);
  });

  it('says the question the lead asked before its status line', () => {
    const asked = {
      kind: 'lead.question',
      session_id: 'lead-1',
      question: { question: 'Which ledger first?' },
    };
    const out = html([asked]);
    expect(out).toContain('Which ledger first?');
    expect(out).not.toContain('splitting the last 2 tasks of M3');
  });
});
