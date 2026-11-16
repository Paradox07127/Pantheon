import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { InsightsSection } from '@/screens/insights/InsightsScreen';
import { zh } from './i18n-setup.js';
import { FakeDocument, FakeElement, FakeNode } from './web-fake-dom.js';

/** Each tab is this wide in the laid-out bar. */
const TAB_PX = 100;
// The room the bar leaves the tab list; a resize observer callback reads it again.
const room = { px: 1000 };
const resized = new Set<() => void>();

function all(node: FakeNode, test: (n: FakeNode) => boolean): FakeElement[] {
  return [
    ...(test(node) ? [node as FakeElement] : []),
    ...node.childNodes.flatMap((c) => all(c, test)),
  ];
}
const withRole = (node: FakeNode, role: string) =>
  all(node, (n) => n instanceof FakeElement && n.getAttribute('role') === role);

/** Lays the tab list out as the bar does: tabs side by side from its left edge, clipped at the room's end. */
class LaidOutElement extends FakeElement {
  getAnimations() {
    return [];
  }
  getRootNode() {
    return doc;
  }
  get clientWidth() {
    return this.getAttribute('role') === 'tablist' ? room.px : 0;
  }
  get scrollWidth() {
    return this.getAttribute('role') === 'tablist' ? withRole(this, 'tab').length * TAB_PX : 0;
  }
}

const doc = new FakeDocument(LaidOutElement);
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
let show: (section: InsightsSection) => Promise<void>;
let resize: (px: number) => Promise<void>;

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  for (const name of ['Node', 'Element', 'HTMLElement'] as const) vi.stubGlobal(name, win[name]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private run: () => void) {}
      observe() {
        resized.add(this.run);
      }
      unobserve() {}
      disconnect() {
        resized.delete(this.run);
      }
    },
  );
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { InsightsView } = await import('@/screens/insights/InsightsScreen');
  root = createRoot(container as never);
  show = (section) =>
    act(async () =>
      root.render(
        createElement(InsightsView, {
          // The bar alone: no board read yet.
          model: null,
          section,
          loading: true,
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
  resize = (px) =>
    act(async () => {
      room.px = px;
      resized.forEach((run) => run());
    });
});

afterAll(async () => {
  const { act } = await import('react');
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const shownTabs = () => withRole(container, 'tab').map((tab) => tab.textContent);
const moreTabs = () =>
  all(
    container,
    (n) => n instanceof FakeElement && n.getAttribute('aria-label') === zh('insights.tabs.more'),
  );
/** Each shown tab's box, side by side from the list's left edge, ends inside the list's box. */
const tabsInside = () => shownTabs().every((_, i) => (i + 1) * TAB_PX <= room.px);

describe('engineering board tabs in a bar too narrow for them', () => {
  it('shows every tab while they fit', async () => {
    room.px = 1000;
    await show('usage');
    expect(shownTabs()).toHaveLength(7);
    expect(moreTabs()).toHaveLength(0);
  });

  it('moves the tabs that do not fit into a menu, so no tab runs under the controls after it', async () => {
    await resize(450);
    expect(tabsInside()).toBe(true);
    expect(shownTabs().length).toBeLessThan(7);
    expect(shownTabs()).toContain(zh('board.sections.usage'));
    expect(moreTabs()).toHaveLength(1);
  });

  it('keeps the picked tab in the bar when it comes after the ones that fit', async () => {
    await show('digest');
    expect(tabsInside()).toBe(true);
    expect(shownTabs()).toContain(zh('insights.digest.label'));
  });

  it('brings every tab back once the bar is wide again', async () => {
    await resize(1000);
    expect(shownTabs()).toHaveLength(7);
    expect(moreTabs()).toHaveLength(0);
  });
});
