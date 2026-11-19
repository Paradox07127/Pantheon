import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import type { BoardPage } from '@/data/board-page';
import { BoardView } from '@/screens/board/BoardScreen';
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
    }),
  );

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
    expect(view(board(), 'overview', 'empty-board')).toContain(zh('board.baseline.start'));
  });
});

describe('board lead lines', () => {
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
});
