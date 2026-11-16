import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import { BoardView, PanelBoundary } from '../../apps/web/src/screens/board/BoardScreen.js';
import { MergesPanel } from '../../apps/web/src/screens/board/Lists.js';
import { TaskDrawer } from '../../apps/web/src/screens/board/TaskDrawer.js';
import { t } from '../../apps/web/src/i18n/index.js';
import { zh } from './i18n-setup.js';
import { setupRead } from './setup-fixture.js';

const NOW = new Date(2026, 10, 1, 15, 0).getTime();
const noop = () => {};
const say = (id: string, values: Record<string, string>) => t({ id, defaultMessage: '' }, values);
const openStory = (title: string) => say('board.merges.openStory', { title });

const task = (id: string, sessionId: string): BoardModel['tasks'][number] => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'done',
  blockers: [],
  segments: [
    {
      id: sessionId,
      session_id: sessionId,
      title: `session ${sessionId}`,
      runtime: 'claude',
      model: null,
      status: 'done',
      started_at: null,
      ended_at: null,
      tokens: 0,
    },
  ],
  additions: 3,
  deletions: 1,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
});

const merge = (
  sessionId: string,
  story_id: string | null,
  from_sha: string | null = '0123456789abcdef',
): BoardModel['merges'][number] => ({
  session_id: sessionId,
  title: `session ${sessionId}`,
  merged_at: new Date(2026, 10, 1, 14, 5).getTime(),
  from_sha,
  sha: 'fedcba9876543210',
  additions: 3,
  deletions: 1,
  story_id,
});

const model = (merges: BoardModel['merges']): BoardModel => ({
  since: NOW - 86_400_000,
  now: NOW,
  headline: null,
  counts: {
    running: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    merged: merges.length,
    reverted: 0,
    median_ms: null,
    tokens: 0,
    tokens_by_runtime: {},
    previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
    cost_usd: null,
  },
  lanes: [],
  tasks: [task('merged', 's1'), task('open', 's2')],
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
  merges,
  findings: [],
  risks: [],
});

const drawer = (board: BoardModel, taskId: string) =>
  renderToStaticMarkup(
    createElement(TaskDrawer, {
      model: board,
      taskId,
      onSelect: noop,
      onOpenSession: noop,
      onOpenStory: noop,
    }),
  );

describe('board drawer merge section', () => {
  const storyLink = `aria-label="${say('board.task.story.openLabel', { title: 'session s1' })}"`;
  it.each([
    [
      'lists the merge time, commit range, change counts and the story link',
      merge('s1', 'story-1'),
      'merged',
      ['14:05', '0123456..fedcba9', '+3', '−1', storyLink],
      [],
    ],
    [
      'leaves out the story link without a ready story and the range start when unrecorded',
      merge('s1', null, null),
      'merged',
      ['fedcba9'],
      ['..', zh('board.task.story.open')],
    ],
    [
      'says not merged for a task whose sessions have no merge',
      merge('s1', 'story-1'),
      'open',
      [zh('board.task.drawer.notMerged')],
      [],
    ],
  ])('%s', (_, merged, taskId, shown, hidden) => {
    const html = drawer(model([merged]), taskId);
    const section = html.slice(
      html.indexOf(`<h3>${zh('board.task.drawer.merge')}</h3>`),
      html.indexOf(`<h3>${zh('board.task.drawer.upstream')}</h3>`),
    );
    for (const part of shown) expect(section).toContain(part);
    for (const part of hidden) expect(section).not.toContain(part);
  });
});

describe('board drawer new session', () => {
  it('offers a new session only for a task a lead wrote', () => {
    const board = model([]);
    board.tasks[0] = { ...board.tasks[0]!, owner_session_id: 'lead-1' };
    const props = {
      model: board,
      onSelect: noop,
      onOpenSession: noop,
      onOpenStory: noop,
      onStartTask: noop,
    };
    const lead = renderToStaticMarkup(createElement(TaskDrawer, { ...props, taskId: 'merged' }));
    expect(lead).toContain(
      `aria-label="${say('board.task.drawer.startLabel', { title: 'task merged' })}"`,
    );
    expect(lead).toContain(zh('board.task.drawer.start'));
    const other = renderToStaticMarkup(createElement(TaskDrawer, { ...props, taskId: 'open' }));
    expect(other).not.toContain(zh('board.task.drawer.start'));
  });
});

describe('board recent merges story link', () => {
  it('shows the story link only for merges with a ready story', () => {
    const html = renderToStaticMarkup(
      createElement(MergesPanel, {
        model: model([merge('s1', 'story-1'), merge('s2', null)]),
        onOpenSession: noop,
        onOpenStory: noop,
      }),
    );
    expect(html).toContain(openStory('session s1'));
    expect(html).not.toContain(openStory('session s2'));
  });

  it('names a merge of a deleted session by its id and links to neither it nor its story', () => {
    const gone = { ...merge('deleted-session-1', 'story-1'), title: '' };
    const html = renderToStaticMarkup(
      createElement(MergesPanel, { model: model([gone]), onOpenSession: noop, onOpenStory: noop }),
    );
    const list = html.slice(html.indexOf('bp-mgl'));
    expect(list).toContain(
      `<span class="nm">${zh('board.session.fallbackTitle').replace('{id}', '')}`,
    );
    expect(list).not.toContain('<button class="nm"');
    expect(list).not.toContain(zh('board.merges.story'));
  });
});

describe('board panel failure', () => {
  it('shows one failure line with a retry button in place of a panel that threw', () => {
    const boundary = new PanelBoundary({
      title: '用量',
      model: model([]),
      onRetry: noop,
      children: null,
    });
    boundary.state = {
      ...boundary.state,
      ...PanelBoundary.getDerivedStateFromError(new Error('bad usage row')),
    };
    const html = renderToStaticMarkup(boundary.render() as never);
    expect(html).toContain('<h2');
    expect(html).toContain('用量');
    expect(html).toContain('role="alert"');
    expect(html).toContain('bad usage row');
    expect(html).toContain(zh('board.query.retry'));
  });
});

describe('board view with no tasks in the range', () => {
  it('still shows the risks, milestones and completion trend of the range', () => {
    const board: BoardModel = {
      ...model([]),
      tasks: [],
      milestones: [
        {
          id: 'm1',
          title: 'ship the importer',
          session_ids: ['s1'],
          merged: 1,
          status: 'ready_for_acceptance',
          criteria: [],
        },
      ],
      burnup: [
        { day: '10-31', scope: 2, done: 2 },
        { day: '11-01', scope: 2, done: 2 },
      ],
      risks: [{ text: 'imports may drop rows', kind: 'risk' }],
    };
    const html = renderToStaticMarkup(
      createElement(BoardView, {
        model: board,
        loading: false,
        error: null,
        onRetry: noop,
        range: 7,
        onRange: noop,
        page: 'canvas',
        onPage: noop,
        onOpenSession: noop,
        onOpenStory: noop,
        onOpenTrace: noop,
        setup: setupRead('none'),
      }),
    );
    expect(html).toContain('imports may drop rows');
    expect(html).toContain('ship the importer');
    expect(html).not.toContain(zh('board.baseline.start'));
  });
});

describe('board panel retry', () => {
  const failed = (board: BoardModel, onRetry: () => void) => {
    const boundary = new PanelBoundary({ title: '用量', model: board, onRetry, children: null });
    boundary.state = {
      ...boundary.state,
      ...PanelBoundary.getDerivedStateFromError(new Error('bad usage row')),
    };
    boundary.setState = (next) => Object.assign(boundary.state, next);
    return boundary;
  };
  const retryOf = (boundary: PanelBoundary): (() => void) => {
    const section = boundary.render() as ReactElement<{ children: ReactElement<any>[] }>;
    return section.props.children[1]!.props.onRetry;
  };

  it('clears the failure line and reloads on retry even when the model stays the same', () => {
    let reloads = 0;
    const boundary = failed(model([]), () => reloads++);
    retryOf(boundary)();
    expect(reloads).toBe(1);
    expect(boundary.state.error).toBeNull();
  });

  it('clears the failure when a new model arrives and not for the same one', () => {
    const board = model([]);
    const boundary = failed(board, noop);
    const props = { title: '用量', model: board, onRetry: noop, children: null };
    expect(PanelBoundary.getDerivedStateFromProps(props, boundary.state)).toBeNull();
    const next = PanelBoundary.getDerivedStateFromProps(
      { ...props, model: model([]) },
      boundary.state,
    );
    expect(next?.error).toBeNull();
  });
});
