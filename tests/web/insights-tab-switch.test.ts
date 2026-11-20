import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import type { InsightsSection } from '@/screens/insights/InsightsScreen';
import { zh } from './i18n-setup.js';
import { FakeDocument, FakeElement, FakeNode } from './web-fake-dom.js';

// The panels alone: the bar's tabs are laid out in insights-top-bar-fit.
vi.mock('@/components/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/screens/board/UsageCharts', async (actual) => {
  const { createElement } = await import('react');
  return {
    ...(await actual<object>()),
    UsageStackPanel: () => createElement('p', null, 'usage content'),
  };
});

// No transitions run on the panels, as in the app.
class AnimatedElement extends FakeElement {
  getAnimations() {
    return [];
  }
}

const doc = new FakeDocument(AnimatedElement);
const win = {
  document: doc,
  HTMLIFrameElement: class {},
  Node: FakeNode,
  Element: FakeElement,
  HTMLElement: FakeElement,
  innerWidth: 1440,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
};
doc.defaultView = win;
const container = doc.createElement('div');
doc.body.appendChild(container);
let root: { render: (node: ReactNode) => void; unmount: () => void };
let show: (section: InsightsSection, projectId?: string) => Promise<void>;
let settle: () => Promise<void>;
const frames = new Map<number, (at: number) => void>();
let lastFrame = 0;

function all(node: FakeNode, test: (n: FakeNode) => boolean): FakeElement[] {
  return [
    ...(test(node) ? [node as FakeElement] : []),
    ...node.childNodes.flatMap((c) => all(c, test)),
  ];
}
// A panel on screen: the tabs did not hide it and nothing set display:none on it.
const shownPanels = () =>
  all(
    container,
    (n) =>
      n instanceof FakeElement &&
      n.getAttribute('role') === 'tabpanel' &&
      !n.hasAttribute('hidden') &&
      n.style.display !== 'none',
  );
const NOW = Date.UTC(2026, 10, 3, 12);
const model = {
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
} satisfies BoardModel;

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  for (const name of ['Node', 'Element', 'HTMLElement'] as const) vi.stubGlobal(name, win[name]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Animation frames wait for `settle()`, so a check before it sees the first commit after a switch.
  vi.stubGlobal('requestAnimationFrame', (run: (at: number) => void) => {
    frames.set(++lastFrame, run);
    return lastFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const { act, createElement } = await import('react');
  settle = () =>
    act(async () => {
      for (let round = 0; round < 3; round++) {
        const due = [...frames.values()];
        frames.clear();
        due.forEach((run) => run(0));
        await Promise.resolve();
      }
    });
  const { createRoot } = await import('react-dom/client');
  const { InsightsView } = await import('@/screens/insights/InsightsScreen');
  root = createRoot(container as never);
  show = (section, projectId) =>
    act(async () =>
      root.render(
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
      ),
    );
  await show('usage');
});

afterAll(async () => {
  const { act } = await import('react');
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("shows only the picked tab's panel, with its content, in the first commit after a switch", async () => {
  const [usage] = shownPanels();
  expect(shownPanels()).toHaveLength(1);
  expect(usage!.textContent).toContain('usage content');
  await show('quality');
  const shown = shownPanels();
  expect(shown.map((p) => p.textContent)).toEqual([
    expect.stringContaining(zh('board.trend.empty')),
  ]);
  expect(shown[0]!.textContent).not.toContain('usage content');
});

it('shows the panel last drawn for a tab when it comes back to that tab', async () => {
  const usage = () => shownPanels().find((p) => p.textContent.includes('usage content'));
  await show('usage');
  await settle();
  const drawn = usage();
  expect(drawn).toBeDefined();
  await show('quality');
  await settle();
  await show('usage');
  expect(usage() === drawn).toBe(true);
});

it('opens the quality tab for a stored repository tab', async () => {
  const { readInsightsSection } = await import('@/screens/insights/InsightsScreen');
  await show('quality');
  await settle();
  const quality = shownPanels().map((p) => p.textContent);
  await show(readInsightsSection('repo'));
  expect(shownPanels().map((p) => p.textContent)).toEqual(quality);
  expect(quality.join('')).not.toContain(zh('board.repo.title'));
});
