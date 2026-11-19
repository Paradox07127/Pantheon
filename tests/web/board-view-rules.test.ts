import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import { BoardView } from '@/screens/board/BoardScreen';
import { criticalPath, readyTasks } from '@/screens/board/view-rules';
import { zh } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
type Edge = BoardModel['edges'][number];

const NOW = Date.UTC(2026, 10, 3, 12);
const LEAD = 'lead-1';

const task = (id: string, status: BoardTaskStatus = 'todo', patch: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status,
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
  ...patch,
});

const plan = (id: string, status?: BoardTaskStatus, patch?: Partial<Task>) =>
  task(`${LEAD}:${id}`, status, patch);
const edge = (from: string, to: string): Edge => ({
  from: `${LEAD}:${from}`,
  to: `${LEAD}:${to}`,
  state: 'pending',
});
const segment = (id: string): Task['segments'][number] => ({
  id,
  session_id: id,
  title: id,
  runtime: 'claude',
  model: null,
  status: 'done',
  started_at: NOW - 3_600_000,
  ended_at: NOW - 1_800_000,
  tokens: 0,
});

const board = (tasks: Task[], edges: Edge[] = []): BoardModel => ({
  since: NOW - 7 * 86_400_000,
  now: NOW,
  headline: null,
  counts: {
    running: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    merged: 0,
    reverted: 0,
    median_ms: null,
    tokens: 0,
    tokens_by_runtime: {},
    previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
    cost_usd: null,
  },
  lanes: [],
  tasks,
  edges,
  milestones: [],
  burnup: [],
  goals: [],
  task_progress: {
    totals: {
      done: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      ready: 0,
      failed: 0,
      discarded: 0,
      not_started: 0,
    },
    daily: [],
    cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
  },
  usage: [],
  models: [],
  merges: [],
  findings: [],
  risks: [],
});

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const chain = (n: number) =>
  board(
    ids(n).map((id) => plan(id)),
    ids(n)
      .slice(1)
      .map((id, i) => edge(`t${i + 1}`, id)),
  );
const fanOut = (leaves: number) =>
  board(
    [plan('root', 'done'), ...ids(leaves).map((id) => plan(id))],
    ids(leaves).map((id) => edge('root', id)),
  );

describe('main view rules', () => {
  it('follows the longest path through tasks not done yet', () => {
    const model = board(
      [
        plan('a', 'done'),
        plan('b', 'done'),
        plan('c', 'running'),
        plan('d'),
        plan('e'),
        plan('f'),
        plan('g'),
      ],
      [
        edge('a', 'b'),
        edge('b', 'c'),
        edge('a', 'd'),
        edge('d', 'e'),
        edge('e', 'f'),
        edge('c', 'g'),
      ],
    );
    expect(criticalPath(model)).toEqual([`${LEAD}:d`, `${LEAD}:e`, `${LEAD}:f`]);
    expect(criticalPath(chain(3))).toEqual([`${LEAD}:t1`, `${LEAD}:t2`, `${LEAD}:t3`]);
  });

  it('takes the first of two paths of the same length', () => {
    const model = board(
      [plan('a'), plan('b'), plan('c'), plan('d')],
      [edge('a', 'b'), edge('c', 'd')],
    );
    expect(criticalPath(model)).toEqual([`${LEAD}:a`, `${LEAD}:b`]);
  });

  it('marks ready only tasks not started whose upstream tasks are all done', () => {
    const model = board(
      [
        plan('a', 'done'),
        plan('b', 'done'),
        plan('c'),
        plan('d', 'waiting'),
        plan('e'),
        plan('f', 'todo', { segments: [segment('s1')] }),
        plan('g', 'running'),
        task('session-a'),
      ],
      [
        edge('a', 'c'),
        edge('b', 'c'),
        edge('a', 'd'),
        edge('a', 'e'),
        edge('g', 'e'),
        edge('a', 'f'),
      ],
    );
    expect(readyTasks(model)).toEqual([`${LEAD}:c`, `${LEAD}:d`]);
  });
});

describe('main view grouping', () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const view = (projectId: string, model: BoardModel = fanOut(5)) =>
    renderToStaticMarkup(
      createElement(BoardView, {
        model,
        page: 'tasks',
        projectId,
        loading: false,
        error: null,
        onRetry() {},
        onPage() {},
        onOpenSession() {},
        onOpenStory() {},
        onOpenTrace() {},
      }),
    );
  const checked = (html: string) =>
    [...html.matchAll(/<[^>]*role="radio"[^>]*aria-checked="true"[^>]*>([^<]*)</g)].map(
      (m) => m[1],
    );

  it('shows only the band of sessions on a board without plan tasks', () => {
    const html = view('alpha', board([task('s1', 'running'), task('s2', 'waiting')]));
    expect(html).toContain('aria-label="主视图"');
    expect(html).toContain(zh('board.plan.view.empty'));
    expect(html).not.toContain('aria-label="分组"');
  });

  it('starts banded by work line, with no view switch', () => {
    const html = view('alpha');
    expect(checked(html)).toContain(zh('board.canvas.group.lane'));
    expect(html).not.toContain('aria-label="视图"');
    expect(html).not.toContain('按形状自动');
  });

  it('keeps the grouping stored for the project on the next mount', () => {
    stored.set('pantheon.board-group.v1', JSON.stringify({ beta: 'kind' }));
    expect(checked(view('beta'))).toContain(zh('board.canvas.group.kind'));
    expect(checked(view('alpha'))).toContain(zh('board.canvas.group.lane'));
  });
});
