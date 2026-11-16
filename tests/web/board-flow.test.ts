import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, BoardTaskState } from '../../packages/protocol/src/index.js';
import { activityLine } from '../../apps/web/src/screens/board/activity.js';
import type { BoardPage } from '../../apps/web/src/data/board-page.js';
import { BoardView } from '../../apps/web/src/screens/board/BoardScreen.js';
import { edgeState } from '../../apps/web/src/screens/board/FlowPanel.js';
import { t } from '../../apps/web/src/i18n/index.js';
import { zh } from './i18n-setup.js';
import {
  LANE_GAP,
  LANE_LABEL_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  flowLayout,
  layoutKey,
} from '../../apps/web/src/screens/board/flow-layout.js';

type Task = BoardModel['tasks'][number];
const zhs = (...ids: string[]) => ids.map((id) => zh(id));

const task = (id: string, lane_id: string | null, status: Task['status'] = 'todo'): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id,
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
});

const board = (patch: Partial<BoardModel> = {}): BoardModel => ({
  since: 0,
  now: 0,
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
  tasks: [],
  edges: [],
  milestones: [],
  burnup: [],
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
  ...patch,
});

const flowBoard = board({
  lanes: [
    { id: 'api', title: 'API' },
    { id: 'ui', title: 'UI' },
  ],
  tasks: [
    task('loose', null),
    task('a1', 'api', 'done'),
    task('a2', 'api', 'running'),
    task('a3', 'api'),
    task('u1', 'ui', 'done'),
    task('u2', 'ui'),
  ],
  edges: [
    { from: 'a1', to: 'a2', state: 'met' },
    { from: 'a1', to: 'a3', state: 'met' },
    { from: 'a2', to: 'u2', state: 'active' },
    { from: 'u1', to: 'u2', state: 'pending' },
  ],
});

const view = (
  model: BoardModel | null,
  extra: { loading?: boolean; error?: string; page?: BoardPage; projectId?: string } = {},
) =>
  renderToStaticMarkup(
    createElement(BoardView, {
      model,
      page: extra.page ?? 'now',
      projectId: extra.projectId,
      loading: extra.loading ?? false,
      error: extra.error ?? null,
      onRetry() {},
      range: 7,
      onRange() {},
      onPage() {},
      onOpenSession() {},
      onOpenSessions() {},
      onOpenStory() {},
      onOpenTrace() {},
    }),
  );

describe('board flow layout', () => {
  const layout = flowLayout(flowBoard, 1200);
  const at = new Map(layout.nodes.map((n) => [n.id, n]));

  it('groups tasks into the board lanes and puts tasks without a lane in a last unnamed lane', () => {
    expect(layout.lanes.map((l) => l.id)).toEqual(['api', 'ui', null]);
    expect(layout.lanes[2]!.title).toBe('');
    for (const [id, lane] of [
      ['a1', 0],
      ['a2', 0],
      ['a3', 0],
      ['u1', 1],
      ['u2', 1],
      ['loose', 2],
    ] as const) {
      const band = layout.lanes[lane]!;
      const node = at.get(id)!;
      expect(node.y).toBeGreaterThanOrEqual(band.y);
      expect(node.y + NODE_HEIGHT).toBeLessThanOrEqual(band.y + band.height);
    }
  });

  it('leaves a gap between lanes and spaces everything on the 4px grid', () => {
    layout.lanes.slice(1).forEach((band, i) => {
      const above = layout.lanes[i]!;
      expect(band.y).toBe(above.y + above.height + LANE_GAP);
    });
    const last = layout.lanes.at(-1)!;
    expect(layout.height).toBe(last.y + last.height);
    for (const size of [NODE_WIDTH, NODE_HEIGHT, LANE_GAP, LANE_LABEL_WIDTH])
      expect(size % 4).toBe(0);
    expect(layout.lanes.map((l) => [...l.tasks].sort())).toEqual([
      ['a1', 'a2', 'a3'],
      ['u1', 'u2'],
      ['loose'],
    ]);
  });

  it('places every task without overlapping another and dependents to the right', () => {
    expect(layout.nodes).toHaveLength(flowBoard.tasks.length);
    for (const a of layout.nodes)
      for (const b of layout.nodes) {
        if (a === b) continue;
        const apart =
          a.x + NODE_WIDTH <= b.x ||
          b.x + NODE_WIDTH <= a.x ||
          a.y + NODE_HEIGHT <= b.y ||
          b.y + NODE_HEIGHT <= a.y;
        expect(apart, `${a.id} and ${b.id}`).toBe(true);
      }
    for (const e of flowBoard.edges) expect(at.get(e.to)!.x).toBeGreaterThan(at.get(e.from)!.x);
  });

  it('carries each edge state through unchanged', () => {
    expect(layout.edges).toEqual(flowBoard.edges);
  });

  it('keeps the row of a dependency that skips columns clear of the cards it passes', () => {
    const chain = board({
      lanes: [{ id: 'api', title: 'API' }],
      tasks: ['a', 'b', 'c', 'd'].map((id) => task(id, 'api')),
      edges: [
        { from: 'a', to: 'b', state: 'pending' },
        { from: 'b', to: 'c', state: 'pending' },
        { from: 'c', to: 'd', state: 'pending' },
        { from: 'a', to: 'd', state: 'pending' },
      ],
    });
    const placed = new Map(flowLayout(chain, 1200).nodes.map((n) => [n.id, n]));
    const from = placed.get('a')!;
    const to = placed.get('d')!;
    for (const id of ['b', 'c']) {
      const card = placed.get(id)!;
      expect(card.x).toBeGreaterThan(from.x);
      expect(card.x).toBeLessThan(to.x);
      expect(card.y, id).not.toBe(to.y);
    }
  });
});

describe('board flow layout key', () => {
  const key = layoutKey(flowBoard);

  it('stays the same when only usage, counts, statuses or edge states change', () => {
    const refreshed = board({
      ...structuredClone(flowBoard),
      counts: { ...flowBoard.counts, running: 2, tokens: 5_000 },
      usage: [{ day: '11-01', runtime: 'claude', model: null, tokens: 5_000, cost_usd: 0.1 }],
      tasks: flowBoard.tasks.map((t) => ({ ...t, status: 'done' as const })),
      edges: flowBoard.edges.map((e) => ({ ...e, state: 'met' as const })),
    });
    expect(layoutKey(refreshed)).toBe(key);
  });

  it('changes when a task, a lane or an edge changes', () => {
    expect(
      layoutKey(board({ ...flowBoard, tasks: [...flowBoard.tasks, task('u3', 'ui')] })),
    ).not.toBe(key);
    expect(
      layoutKey(
        board({
          ...flowBoard,
          tasks: flowBoard.tasks.map((t) => (t.id === 'loose' ? { ...t, lane_id: 'ui' } : t)),
        }),
      ),
    ).not.toBe(key);
    expect(layoutKey(board({ ...flowBoard, lanes: [{ id: 'api', title: 'API' }] }))).not.toBe(key);
    expect(
      layoutKey(
        board({
          ...flowBoard,
          edges: [...flowBoard.edges, { from: 'a3', to: 'u2', state: 'pending' }],
        }),
      ),
    ).not.toBe(key);
  });
});

describe('board flow edges', () => {
  const from = (state: BoardTaskState, status: Task['status'] = 'todo'): Task => ({
    ...task('up', null, status),
    state,
  });

  const session = (status: Task['status']) => task('session', null, status);
  it.each([
    [
      'flows only while the upstream task runs',
      [from('running', 'running'), session('running')],
      ['active', 'active'],
    ],
    [
      'stays still while the upstream task waits for approval or is idle',
      [
        ...[from('waiting_approval', 'waiting'), from('claimed', 'running'), from('todo', 'idle')],
        ...(['waiting', 'idle', 'ready'] as const).map(session),
      ],
      Array(6).fill('pending'),
    ],
    [
      'blocks the edge once the upstream task failed, a failed session row stays pending',
      [from('failed', 'failed'), session('failed')],
      ['blocked', 'pending'],
    ],
  ])('%s', (_, ups, states) => {
    expect(ups.map((up) => edgeState(up))).toEqual(states);
  });

  it('turns done once the upstream task merged and counts one upstream task fewer', () => {
    expect(edgeState(from('merged', 'done'))).toBe('met');
    const down: Task = {
      ...task('down', null),
      state: 'waiting_upstream',
      dispatch_wait: 'upstream',
    };
    const waits = (first: BoardTaskState) =>
      activityLine(
        down,
        0,
        board({
          tasks: [from(first), { ...from('todo'), id: 'up2' }, down],
          edges: [
            { from: 'up', to: 'down', state: 'pending' },
            { from: 'up2', to: 'down', state: 'pending' },
          ],
        }),
      );
    const upstream = (count: number) =>
      t({ id: 'board.task.activity.waitingUpstream', defaultMessage: '' }, { count });
    expect(waits('gating')).toBe(upstream(2));
    expect(waits('merged')).toBe(upstream(1));
  });

  it('fades the flow out and colours the edge done through transitions', () => {
    const css = readFileSync(
      new URL('../../apps/web/src/screens/board/flow.css', import.meta.url),
      'utf8',
    );
    expect(css).toMatch(/\.bd-e \.react-flow__edge-path \{[^}]*transition:[^}]*stroke /);
    expect(css).toMatch(/\.bd-e \.bd-pulse \{[^}]*transition:[^}]*opacity /);
    expect(css).toMatch(/\.bd-e\.active \.bd-pulse \{[^}]*opacity: 1/);
    // Merged and not-yet upstreams draw solid lines; a running one draws moving dashes.
    expect(css).toMatch(/\.bd-e \.bd-pulse \{[^}]*stroke-dasharray: 4 4/);
    expect(css).not.toMatch(/\.bd-e\.(met|pending) \.react-flow__edge-path \{[^}]*dasharray/);
  });
});

describe('board view', () => {
  it('names the loading panel after the open view', () => {
    // A first read that fails shows the panel; one still out shows nothing under the view tabs.
    expect(view(null, { error: 'x', page: 'canvas' })).toContain(
      `<h2 id="bd-load-h">${zh('board.view.canvas')}</h2>`,
    );
    expect(view(null, { error: 'x', page: 'canvas' })).not.toContain(zh('app.screenName.flow'));
    expect(view(null, { loading: true, page: 'canvas' })).not.toContain('bd-load-h');
  });

  it('names the views now, whole history and canvas in that order', () => {
    const html = view(flowBoard, { projectId: 'flow-views' });
    const views = [
      ...html.matchAll(
        /role="radio"[^>]*>(?:<svg[\s\S]*?<\/svg>)?(?:<span class="tb-lbl">)?([^<]*)/g,
      ),
    ].map((m) => m[1]);
    expect(views.slice(0, 3)).toEqual(
      zhs('board.history.span.now', 'board.history.span.history', 'board.view.canvas'),
    );
  });

  it('shows the flow chart in the now view, and the progress table then the trend in the canvas view', () => {
    const main = `aria-label="${zh('board.plan.view.main')}"`;
    const tableHeading = `>${zh('board.progress.title')}</h2>`;
    const now = view(flowBoard);
    expect(now).toContain(main);
    expect(now).not.toContain(tableHeading);
    const html = view(flowBoard, { page: 'canvas' });
    const table = html.indexOf(tableHeading);
    const trend = html.indexOf(`>${zh('board.trend.title')}</h2>`);
    expect(html).not.toContain(main);
    expect(table).toBeGreaterThan(-1);
    expect(trend).toBeGreaterThan(table);
    expect(html).toContain(`aria-label="${zh('board.panels.tableView')}"`);
    expect(html).toContain(zh('board.columns.label'));
    expect(html).not.toContain('bd-col-row');
  });

  it('offers to open a session when the project has no tasks and no counts', () => {
    const html = view(board());
    expect(html).toContain(zh('board.empty.openSession'));
    expect(html).not.toContain(zh('app.screenName.flow'));
  });

  it('shows a retry button when the board read fails', () => {
    const html = view(null, { error: '读取失败' });
    expect(html).toContain('读取失败');
    expect(html).toContain(zh('board.query.retry'));
  });
});
