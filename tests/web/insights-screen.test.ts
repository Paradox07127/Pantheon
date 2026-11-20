import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import { SCREEN_NAMES } from '@/screens';
import { BoardView } from '@/screens/board/BoardScreen';
import { DEFAULT_LAYOUT, saveLayout, setHidden, setSpan } from '@/screens/board/panel-layout';
import {
  InsightsView,
  insightsSectionLabel,
  pickInsightsSection,
  readInsightsSection,
  type InsightsSection,
} from '@/screens/insights/InsightsScreen';
import { zh, zhf } from './i18n-setup.js';

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
  tasks: [],
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

const insights = (section: InsightsSection, projectId?: string) =>
  renderToStaticMarkup(
    createElement(InsightsView, {
      model: board(),
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

const progress = (projectId: string) =>
  renderToStaticMarkup(
    createElement(BoardView, {
      model: board(),
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

const tabs = (html: string) => [...html.matchAll(/role="tab"[^>]*>([^<]*)</g)].map((m) => m[1]);

describe('engineering board tabs', () => {
  const sections: InsightsSection[] = ['quality', 'usage'];

  it('names the tabs quality and usage in that order', () => {
    const html = insights('quality');
    expect(html).toContain(`aria-label="${zh('insights.tabs.label')}"`);
    expect(tabs(html)).toEqual(['board.sections.quality', 'board.sections.usage'].map(zh));
    expect(sections.map(insightsSectionLabel)).toEqual(tabs(html));
  });

  it('has no repository tab, and opens quality for a stored repository tab', () => {
    expect(tabs(insights('quality'))).not.toContain(zh('board.repo.title'));
    expect(readInsightsSection('repo')).toBe('quality');
  });

  it('reads each stored tab back and opens quality for anything else', () => {
    for (const key of sections) expect(readInsightsSection(key)).toBe(key);
    for (const raw of [null, '', 'progress', 'milestones', 'review', '"usage"'])
      expect(readInsightsSection(raw)).toBe('quality');
  });

  it('opens quality for a stored iterations, collaboration, workflow, weekly digest or signals tab', () => {
    for (const raw of ['iterations', 'collab', 'workflow', 'digest', 'signals'])
      expect(readInsightsSection(raw)).toBe('quality');
  });

  it('has no retrospectives tab, and opens quality for a stored retrospectives tab', () => {
    expect(tabs(insights('quality'))).not.toContain('复盘');
    expect(readInsightsSection('retro')).toBe('quality');
    expect(insights('quality')).not.toContain('还没有复盘');
    expect(progress('retro-on-board')).not.toContain('还没有复盘');
  });

  it('shows the usage overview on the usage tab', () => {
    expect(insights('usage', 'usage-overview')).toContain(`aria-label="${zh('board.kpi.label')}"`);
  });
});

describe('engineering board quality tab', () => {
  it('shows the first-pass ring, then the completion trend, the cycle time distribution and the merges per day', () => {
    const model = board();
    const html = renderToStaticMarkup(
      createElement(InsightsView, {
        model: {
          ...model,
          counts: { ...model.counts, merged: 1, gate_first_pass: { tasks: 4, passed: 3 } },
          merges: [
            {
              session_id: 'merged-1',
              title: 'Refund retries',
              merged_at: NOW - 3_600_000,
              from_sha: null,
              sha: 'a1b2c3d4e5',
              additions: 1,
              deletions: 0,
              story_id: null,
            },
          ],
        },
        section: 'quality',
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
    expect(html).toMatch(
      new RegExp(
        `role="img" aria-label="${zhf('insights.quality.firstPassRing', { percent: 75 })}"`,
      ),
    );
    const at = (title: string) => html.indexOf(`>${title}</h2>`);
    const order = [
      zh('board.trend.title'),
      zh('board.cycle.title'),
      zh('insights.mergesPerDay.title'),
      zh('board.findings.title'),
    ].map(at);
    expect(order.every((i) => i > html.indexOf(zh('insights.quality.merged')))).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });
});

describe('engineering board storage', () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores the picked tab per project', () => {
    pickInsightsSection('insights-alpha', 'usage');
    expect(stored.get('pantheon.insights.insights-alpha')).toBe('usage');
    expect(stored.has('pantheon.insights.insights-beta')).toBe(false);
  });

  it('keeps the hidden panels and the layout reset of each page to that page', () => {
    saveLayout('layout-split', setHidden(DEFAULT_LAYOUT, 'gates', true));
    expect(insights('quality', 'layout-split')).toContain('已隐藏 1');
    expect(progress('layout-split')).not.toContain('class="bd-hid"');
    saveLayout('layout-board-only', setSpan(DEFAULT_LAYOUT, 'stall', 6));
    expect(insights('quality', 'layout-board-only')).not.toContain('class="bd-hid"');
  });
});

describe('engineering board place', () => {
  it('names the screen in its top bar, whatever tab shows', () => {
    expect(SCREEN_NAMES.insights).toBe(zh('app.screenName.insights'));
    expect(insights('usage')).toContain(
      `<header class="tb"><h1>${zh('app.screenName.insights')}</h1>`,
    );
  });
});

describe('engineering board top bar in a narrow window', () => {
  const sheet = (file: string) =>
    readFileSync(new URL(`../../apps/web/src/${file}`, import.meta.url), 'utf8');

  it('scrolls the tab strip sideways', () => {
    expect(sheet('index.css')).toMatch(/\n\.tb-tabs\{[^}]*overflow-x:auto/);
  });
});
