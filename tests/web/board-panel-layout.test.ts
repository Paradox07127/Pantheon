import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import { InsightsView } from '@/screens/insights/InsightsScreen';
import {
  DEFAULT_LAYOUT,
  mergeLayout,
  movePanel,
  readLayout,
  saveLayout,
  setHeight,
  setHidden,
  setSpan,
  type BoardLayout,
} from '@/screens/board/panel-layout';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 3, 12);

const board = (): BoardModel => ({
  since: NOW - 7 * 86_400_000,
  now: NOW,
  headline: null,
  counts: {
    running: 1,
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
  tasks: [
    {
      id: 'lead-1:t1',
      title: 'task t1',
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
    },
  ],
  edges: [],
  milestones: [],
  burnup: [],
  goals: [],
  task_progress: {
    totals: {
      done: 0,
      running: 1,
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

const keys = (layout: BoardLayout, tab: keyof BoardLayout) => layout[tab].map((p) => p.key);
const place = (layout: BoardLayout, key: string) =>
  Object.values(layout)
    .flat()
    .find((p) => p.key === key)!;

describe('board panel layout', () => {
  it('starts from the current order and widths at automatic height', () => {
    expect(mergeLayout(null, DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT);
    expect(keys(DEFAULT_LAYOUT, 'progress')).toEqual(['main', 'table', 'trend', 'cycle', 'stall']);
    expect(DEFAULT_LAYOUT.progress.map((p) => p.span)).toEqual([12, 12, 6, 6, 12]);
    expect(keys(DEFAULT_LAYOUT, 'quality')).toEqual([
      'qualityKpis',
      'qualityTrend',
      'qualityCycle',
      'mergesPerDay',
      'gateFailures',
      'findings',
      'matrix',
      'merges',
      'gates',
    ]);
    expect(keys(DEFAULT_LAYOUT, 'usage')).toEqual(['quota', 'runtime', 'usage', 'roles']);
    expect(Object.keys(DEFAULT_LAYOUT)).toEqual(['progress', 'milestones', 'quality', 'usage']);
    expect(
      Object.values(DEFAULT_LAYOUT)
        .flat()
        .every((p) => p.height === 'auto' && !p.hidden),
    ).toBe(true);
  });

  it('keeps the stored order and appends panels the stored layout does not know', () => {
    const merged = mergeLayout(
      { progress: [{ key: 'stall', span: 6, height: 'L', hidden: true }, { key: 'main' }] },
      DEFAULT_LAYOUT,
    );
    expect(keys(merged, 'progress')).toEqual(['stall', 'main', 'table', 'trend', 'cycle']);
    expect(place(merged, 'stall')).toEqual({ key: 'stall', span: 6, height: 'L', hidden: true });
    expect(merged.usage).toEqual(DEFAULT_LAYOUT.usage);
  });

  it('drops unknown keys, panels of another tab and repeated keys', () => {
    const merged = mergeLayout(
      {
        progress: [{ key: 'gone' }, { key: 'risks' }, { key: 'trend' }, { key: 'trend', span: 12 }],
        elsewhere: [{ key: 'main' }],
      },
      DEFAULT_LAYOUT,
    );
    expect(keys(merged, 'progress')).toEqual(['trend', 'main', 'table', 'cycle', 'stall']);
    expect(place(merged, 'trend').span).toBe(6);
    expect(keys(merged, 'milestones')).toEqual(['milestones', 'risks']);
    expect(Object.keys(merged)).toEqual(Object.keys(DEFAULT_LAYOUT));
  });

  it('ignores a stored layout of the iterations, collaboration, workflow, weekly digest and signals tabs', () => {
    const merged = mergeLayout(
      {
        iterations: [{ key: 'iterations', span: 12 }],
        collab: [{ key: 'collab', span: 12 }],
        workflow: [{ key: 'workflow', span: 12 }],
        digest: [{ key: 'digest', span: 6, hidden: true }],
        signals: [{ key: 'signals', span: 12 }],
        usage: [{ key: 'roles', span: 6 }],
      },
      DEFAULT_LAYOUT,
    );
    expect(Object.keys(merged)).toEqual(['progress', 'milestones', 'quality', 'usage']);
    expect(keys(merged, 'usage')).toEqual(['roles', 'quota', 'runtime', 'usage']);
    expect(merged.quality).toEqual(DEFAULT_LAYOUT.quality);
  });

  it('falls back to the default for each value it cannot read', () => {
    const merged = mergeLayout(
      {
        progress: [{ key: 'trend', span: 7, height: 'XL', hidden: 'yes' }, 'main', null],
        quality: 'none',
      },
      DEFAULT_LAYOUT,
    );
    expect(place(merged, 'trend')).toEqual({
      key: 'trend',
      span: 6,
      height: 'auto',
      hidden: false,
    });
    expect(merged.quality).toEqual(DEFAULT_LAYOUT.quality);
    expect(mergeLayout('broken', DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT);
  });

  it('moves a panel one place within its tab and leaves the ends where they are', () => {
    expect(keys(movePanel(DEFAULT_LAYOUT, 'table', -1), 'progress')).toEqual([
      'table',
      'main',
      'trend',
      'cycle',
      'stall',
    ]);
    expect(keys(movePanel(DEFAULT_LAYOUT, 'table', 1), 'progress')).toEqual([
      'main',
      'trend',
      'table',
      'cycle',
      'stall',
    ]);
    expect(movePanel(DEFAULT_LAYOUT, 'main', -1)).toBe(DEFAULT_LAYOUT);
    expect(movePanel(DEFAULT_LAYOUT, 'stall', 1)).toBe(DEFAULT_LAYOUT);
    expect(movePanel(DEFAULT_LAYOUT, 'risks', 1)).toBe(DEFAULT_LAYOUT);
  });

  it('moves past hidden panels to the next shown one', () => {
    const layout = setHidden(DEFAULT_LAYOUT, 'cycle', true);
    expect(keys(movePanel(layout, 'stall', -1), 'progress')).toEqual([
      'main',
      'table',
      'stall',
      'trend',
      'cycle',
    ]);
    expect(movePanel(setHidden(DEFAULT_LAYOUT, 'main', true), 'table', -1)).toEqual(
      setHidden(DEFAULT_LAYOUT, 'main', true),
    );
  });

  it('changes one panel width, height and visibility', () => {
    const layout = setHeight(
      setSpan(setHidden(DEFAULT_LAYOUT, 'risks', true), 'main', 6),
      'main',
      'M',
    );
    expect(place(layout, 'main')).toEqual({ key: 'main', span: 6, height: 'M', hidden: false });
    expect(place(layout, 'risks').hidden).toBe(true);
    expect(place(DEFAULT_LAYOUT, 'main')).toEqual({
      key: 'main',
      span: 12,
      height: 'auto',
      hidden: false,
    });
  });
});

describe('board panel layout storage', () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps each project its own layout', () => {
    saveLayout('layout-alpha', setHidden(DEFAULT_LAYOUT, 'trend', true));
    expect(JSON.parse(stored.get('pantheon.board.layout.layout-alpha')!)).toEqual(
      setHidden(DEFAULT_LAYOUT, 'trend', true),
    );
    expect(stored.has('pantheon.board.layout.layout-beta')).toBe(false);
    expect(place(readLayout('layout-alpha'), 'trend').hidden).toBe(true);
    expect(readLayout('layout-beta')).toEqual(DEFAULT_LAYOUT);
  });

  it('reads a stored layout through the merge', () => {
    stored.set('pantheon.board.layout.layout-gamma', JSON.stringify({ usage: [{ key: 'roles' }] }));
    expect(keys(readLayout('layout-gamma'), 'usage')).toEqual([
      'roles',
      'quota',
      'runtime',
      'usage',
    ]);
    stored.set('pantheon.board.layout.layout-delta', '{not json');
    expect(readLayout('layout-delta')).toEqual(DEFAULT_LAYOUT);
  });

  /** The classes of the layout cell holding the panel titled `title`. */
  const cell = (html: string, title: string) =>
    [
      ...html.slice(0, html.indexOf(`>${title}</h2>`)).matchAll(/class="(bd-s(?:6|12)\b[^"]*)"/g),
    ].at(-1)?.[1];

  it('draws the completion trend full width and the cycle time and merges per day halves on the quality tab', () => {
    const html = renderToStaticMarkup(
      createElement(InsightsView, {
        model: board(),
        section: 'quality',
        projectId: 'layout-quality',
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
    expect(cell(html, zh('board.trend.title'))).toContain('bd-s12');
    expect(cell(html, zh('board.cycle.title'))).toContain('bd-s6');
    expect(cell(html, zh('insights.mergesPerDay.title'))).toContain('bd-s6');
  });
});
