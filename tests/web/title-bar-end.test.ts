import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TitleBarEnd } from '@/components/TitleBarEnd';
import type { NeedsYouItem } from '@/data/needs-you';
import { FakeDocument, FakeElement, FakeNode } from './web-fake-dom.js';
import { zh, zhf } from './i18n-setup.js';

const waiting = (count: number) =>
  Array.from({ length: count }, (_, i): NeedsYouItem => ({
    source: { table: 'approvals', id: `a${i}`, revision: 1 },
    kind: 'permission',
    project_id: 'alpha',
    status: 'pending',
    created_at: 0,
    reason: 'permission_requested',
    actions: [],
  }));
const render = (count: number) =>
  renderToStaticMarkup(createElement(TitleBarEnd, { needs: waiting(count) }));
/** The opening tags of the buttons named `name`. */
const buttons = (html: string, name: string) =>
  [...html.matchAll(/<button[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`aria-label="${name}"`));

describe('title bar end', () => {
  it('counts what waits for the user, and shows nothing while nothing does', () => {
    const name = zhf('components.titleBarEnd.needs', { count: 3 });
    expect(name).toBe('3 件事等你');
    expect(buttons(render(3), name)).toHaveLength(1);
    expect(render(0)).not.toContain('<button');
    expect(buttons(render(0), zhf('components.titleBarEnd.needs', { count: 0 }))).toEqual([]);
  });

  it('holds no search', () => {
    expect(render(3).match(/<button/g)).toHaveLength(1);
    expect(render(3)).not.toContain(zh('components.windowControls.search'));
  });
});

describe('title bar end in the window', () => {
  const doc = new FakeDocument();
  const win = {
    document: doc,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {},
  };
  doc.defaultView = win;
  /** Whether the root is marked for the waiting count. */
  const marks = () => doc.documentElement.hasAttribute('data-title-needs');
  const show = async (count: number) => {
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as never);
    await act(async () => root.render(createElement(TitleBarEnd, { needs: waiting(count) })));
    return root;
  };

  beforeAll(() => {
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    for (const name of ['Node', 'Element', 'HTMLElement'] as const) vi.stubGlobal(name, win[name]);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    for (const name of ['ResizeObserver', 'MutationObserver'])
      vi.stubGlobal(
        name,
        class {
          observe() {}
          disconnect() {}
        },
      );
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('marks the root while it shows the waiting count, and unmarks it as it goes', async () => {
    const root = await show(2);
    expect(marks()).toBe(true);
    await act(async () => root.render(createElement(TitleBarEnd, { needs: [] })));
    expect(marks()).toBe(false);
    act(() => root.unmount());
    expect(marks()).toBe(false);
  });

  it('keeps the mark while another title bar end still shows it', async () => {
    const first = await show(1);
    const second = await show(1);
    act(() => first.unmount());
    expect(marks()).toBe(true);
    act(() => second.unmount());
    expect(marks()).toBe(false);
  });
});
