import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import type { BoardPage } from '@/data/board-page';
import { BoardView } from '@/screens/board/BoardScreen';
import { DEFAULT_LAYOUT, saveLayout, setSpan } from '@/screens/board/panel-layout';
import { InsightsView, type InsightsSection } from '@/screens/insights/InsightsScreen';
import { zh } from './i18n-setup.js';
import { setupRead } from './setup-fixture.js';

const NOW = Date.UTC(2026, 10, 3, 12);

const board = (over: Partial<BoardModel> = {}): BoardModel => ({
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
  ...over,
});

const view = (model: BoardModel, page: BoardPage, projectId?: string) =>
  renderToStaticMarkup(
    createElement(BoardView, {
      model,
      page,
      projectId,
      loading: false,
      error: null,
      onRetry() {},
      range: 7,
      onRange() {},
      onPage() {},
      onOpenSession() {},
      onOpenStory() {},
      onOpenTrace() {},
      setup: setupRead('none'),
    }),
  );

const insights = (model: BoardModel, section: InsightsSection, projectId?: string) =>
  renderToStaticMarkup(
    createElement(InsightsView, {
      model,
      section,
      projectId,
      loading: false,
      error: null,
      onRetry() {},
      days: 7,
      onDays() {},
      onSection() {},
      onOpenSession() {},
      onOpenStory() {},
      setup: setupRead('none'),
    }),
  );

const busyBoard = () => board({ counts: { ...board().counts, running: 1 } });

describe('board canvas layout reset', () => {
  it('offers only the layout reset when the layout changed but the canvas hides nothing', () => {
    saveLayout('reset-only', setSpan(DEFAULT_LAYOUT, 'stall', 6));
    const html = view(busyBoard(), 'canvas', 'reset-only');
    expect(html).not.toContain('已隐藏');
    expect(html).toMatch(/<button[^>]*class="bd-hid"[^>]*>恢复默认布局<\/button>/);
    expect(view(busyBoard(), 'now', 'reset-only')).not.toContain('class="bd-hid"');
  });
});

describe('board empty state per tab', () => {
  const finding = {
    id: 'one',
    review_id: 'r1',
    review_revision: 2,
    severity: 'major' as const,
    text: 'finding from a discarded session',
    path: null,
    line: null,
    reviewer: 'codex',
    session_id: 's1',
    state: 'open' as const,
  };

  it('shows the findings of a board that has nothing else in the range', () => {
    const html = insights(board({ findings: [finding] }), 'quality');
    expect(html).toContain('finding from a discarded session');
    expect(html).not.toContain(zh('board.baseline.start'));
  });

  it('shows the panels that read their own data on an empty board', () => {
    const quality = insights(board(), 'quality', 'empty-board');
    expect(quality).toContain(zh('board.reviewMatrix.title'));
    expect(quality).toContain(zh('board.gateHistory.title'));
    expect(quality).not.toContain(zh('board.baseline.start'));
    expect(insights(board(), 'usage', 'empty-board')).toContain(zh('board.panels.byRole'));
    expect(view(board(), 'now', 'empty-board')).toContain(zh('board.baseline.start'));
  });
});

describe('board panel menu', () => {
  const css = (name: string) =>
    readFileSync(new URL(`../../apps/web/src/screens/board/${name}`, import.meta.url), 'utf8');
  const px = (rule: string, prop: string) =>
    Number(new RegExp(`(?:^|[;\\s])${prop}: (\\d+)px`).exec(rule)?.[1] ?? NaN);

  it('keeps the header tools of an edge-to-edge panel clear of the menu', () => {
    const boardCss = css('board.css');
    const menu = /\n\.bd-sub > \* > \.bd-pmenu \{([^}]*)\}/.exec(boardCss)![1]!;
    const reach = px(menu, 'right') + px(menu, 'width');
    // The progress table panel has no side padding; its header pads itself.
    expect(css('progress.css')).toMatch(/(?:^|\n)\.bp-tblp \{[^}]*padding: 16px 0 0;/);
    const header = [...boardCss.matchAll(/\n([^\n{]*\.bd-pmenu[^\n{]*) \{([^}]*)\}/g)].find(
      ([, selector]) => selector!.includes('.bp-tblp'),
    );
    expect(px(header?.[2] ?? '', 'padding-right')).toBeGreaterThan(reach);
  });
});

describe('board now strip', () => {
  const css = readFileSync(
    new URL('../../apps/web/src/screens/board/overview.css', import.meta.url),
    'utf8',
  );
  const rule = (selector: string) =>
    new RegExp(`\\n${selector.replace(/[.>]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('bounds the dispatch note and scrolls it, so the canvas under the strip stays in view', () => {
    expect(rule('.bld-dn')).toMatch(/max-height: /);
    expect(rule('.bld-dn')).toContain('overflow-y: auto');
  });

  it('stacks the leads, so each line keeps its glyphs and button in the lead area', () => {
    expect(rule('.bld-l')).toContain('flex-direction: column');
  });

  it('wraps the strip where the milestone, the away line and the leads do not fit', () => {
    expect(rule('.bov')).toContain('flex-wrap: wrap');
    expect(rule('.bov > .bms')).not.toMatch(/min-width: 0;/);
  });

  it("starts a group's label and its tasks' titles at one text edge", () => {
    const edge = (selector: string) => {
      const body = rule(selector);
      const first = /grid-template-columns: (\S+)/.exec(body)?.[1];
      return [first, /column-gap: ([^;]+);/.exec(body)?.[1], /padding: ([^;]+);/.exec(body)?.[1]];
    };
    expect(edge('.btl-gh')).toEqual(edge('.btl-r'));
  });

  it('keeps a readable width for the task title beside the metadata', () => {
    const columns = /grid-template-columns: ([^;]*);/.exec(rule('.btl-r'))?.[1] ?? '';
    expect(columns.split(/ (?![^(]*\))/)[1]).not.toMatch(/^minmax\(0,/);
  });
});

it('styles a progress segment for every task status', () => {
  const statuses: BoardTaskStatus[] = [
    'running',
    'waiting',
    'idle',
    'ready',
    'done',
    'failed',
    'todo',
    'discarded',
  ];
  const flow = readFileSync(
      new URL('../../apps/web/src/screens/board/flow.css', import.meta.url),
      'utf8',
    ),
    progress = readFileSync(
      new URL('../../apps/web/src/screens/board/progress.css', import.meta.url),
      'utf8',
    );
  expect(statuses.filter((status) => !flow.includes(`.bd-pbar .b-${status} {`))).toEqual([]);
  expect(statuses.filter((status) => !progress.includes(`.bp-b-${status} {`))).toEqual([]);
});
