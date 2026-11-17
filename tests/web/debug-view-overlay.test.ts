import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const MILESTONE_SRC = 'apps/web/src/screens/board/MilestoneCard.tsx:182:5';
const PUBLISH_SRC = 'apps/web/src/screens/board/PublishBar.tsx:322:5';

const { seen } = vi.hoisted(() => ({
  seen: {
    palette: [] as {
      open: boolean;
      items: { id: string; run: () => void }[];
      onOpenChange: (open: boolean) => void;
    }[],
    appClicks: 0,
  },
}));
const { list, needs } = vi.hoisted(() => ({
  list: { data: [], loading: false, error: null, reload() {} },
  needs: { items: [], loading: false, error: null, reload() {} },
}));
vi.mock('@/data/debug-view', async (actual) => ({
  ...(await actual<object>()),
  sendDebugItems: vi.fn(async () => true),
}));
// The board's regions, marked on their components' roots as on the real screen.
vi.mock('@/screens/board/BoardScreen', async (actual) => {
  const { createElement } = await import('react');
  function PublishBar({ branch }: { branch: string }) {
    return createElement(
      'div',
      { 'data-debug-region': 'board.publish-bar', 'data-pt-src': PUBLISH_SRC },
      branch,
    );
  }
  function MilestoneCard({ title }: { title: string }) {
    return createElement(
      'section',
      { 'data-debug-region': 'board.milestone', 'data-pt-src': MILESTONE_SRC },
      title,
    );
  }
  return {
    ...(await actual<object>()),
    BoardScreen: () =>
      createElement(
        'main',
        null,
        createElement(PublishBar, { branch: 'main' }),
        createElement(MilestoneCard, { title: 'Release 0.9' }),
        createElement('button', { onClick: () => seen.appClicks++ }, 'Merge'),
      ),
  };
});
vi.mock('@/components/Sidebar', async () => {
  const { createElement } = await import('react');
  return {
    Sidebar: () => createElement('nav'),
    useSidebarLayout: () => ({ collapsed: false, toggle() {} }),
  };
});
vi.mock('@/components/Shortcuts', () => ({ ShortcutSheet: () => null }));
vi.mock('@/components/Toast', () => ({ Toasts: () => null, toast: vi.fn() }));
vi.mock('@/components/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: (props: (typeof seen.palette)[number]) => {
    seen.palette.push(props);
    return null;
  },
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => list,
}));
vi.mock('@/data/needs-you', async (actual) => ({
  ...(await actual<object>()),
  useNeedsYou: () => needs,
}));
vi.mock('@/data/notifications', async (actual) => ({
  ...(await actual<object>()),
  useNotices: () => {},
}));
vi.mock('@/screens/sessions/parts', () => ({ useQueueDispatch: () => {} }));
vi.mock('@/data/facts-read', () => ({ useFactsRefreshOnOpen: () => {} }));
vi.mock('@/components/NoticeFeed', () => ({ NoticeFeed: () => null }));

import { act, createElement } from 'react';
import { App } from '@/App';
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import { sendDebugItems } from '@/data/debug-view';
import { useShell } from '@/store';
import { FakeDocument, FakeElement, FakeNode } from './web-fake-dom.js';
import { zh, zhf } from './i18n-setup.js';

/** An element that lays out, takes focus and answers the reads a debug pick makes. */
class LaidOutElement extends FakeElement {
  get parentElement(): LaidOutElement | null {
    return this.parentNode instanceof LaidOutElement ? this.parentNode : null;
  }
  get innerText() {
    return this.textContent;
  }
  getBoundingClientRect() {
    return { x: 40, y: 80, width: 300, height: 40 };
  }
  focus() {
    focus.at = this;
  }
}

/** The element document.activeElement gives. */
const focus: { at: FakeElement | null } = { at: null };
const doc = Object.defineProperty(new FakeDocument(LaidOutElement), 'activeElement', {
  get: () => focus.at,
}) as FakeDocument & {
  elementsFromPoint: (x: number, y: number) => FakeElement[];
  querySelectorAll: (selector: string) => FakeElement[];
};
type Listener = (e: never) => void;
type Options = boolean | { capture?: boolean } | undefined;
const captures = (options: Options) =>
  typeof options === 'boolean' ? options : !!options?.capture;
let listeners: { type: string; fn: Listener; capture: boolean }[] = [];
const win = {
  document: doc,
  HTMLIFrameElement: class {},
  innerWidth: 1440,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener: (type: string, fn: Listener, options?: Options) =>
    listeners.push({ type, fn, capture: captures(options) }),
  removeEventListener: (type: string, fn: Listener, options?: Options) => {
    listeners = listeners.filter(
      (l) => !(l.type === type && l.fn === fn && l.capture === captures(options)),
    );
  },
};
doc.defaultView = win;
const container = doc.createElement('div');
doc.body.appendChild(container);
let root: { render: (node: ReactNode) => void; unmount: () => void };

function all(node: FakeNode, test: (n: FakeElement) => boolean): FakeElement[] {
  const here = node instanceof FakeElement && test(node) ? [node] : [];
  return [...here, ...node.childNodes.flatMap((c) => all(c, test))];
}
const find = (node: FakeNode, test: (n: FakeElement) => boolean) => all(node, test)[0];
const byRole = (role: string) => find(doc.body, (n) => n.getAttribute('role') === role);
const byLabel = (label: string) => all(doc.body, (n) => n.getAttribute('aria-label') === label);
const button = (within: FakeNode, text: string) =>
  find(within, (n) => n.nodeName === 'BUTTON' && n.textContent === text);
const region = (name: string) =>
  find(container, (n) => n.getAttribute('data-debug-region') === name)!;
const handlers = (el: FakeElement) => {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'))!;
  return (el as never as Record<string, Record<string, (e?: unknown) => unknown>>)[key]!;
};

const toolbar = () => byRole('toolbar');
const description = () => byLabel(zh('components.debugView.request'))[0]!;
const describe = (text: string) =>
  act(() => handlers(description()).onChange!({ target: { value: text } }));
const inspector = () => byLabel(zh('components.debugView.inspector'))[0];
const hit = () => byRole('application')!;
const hover = (name: string) =>
  act(() => {
    doc.elementsFromPoint = () => [hit(), region(name)];
    handlers(hit()).onPointerMove!({ clientX: 60, clientY: 100 });
  });
// A macrotask, so the async work a handler starts has run.
const settle = () => new Promise((done) => setTimeout(done, 0));
const REACT_PROPS: Record<string, string> = { click: 'onClick', keydown: 'onKeyDown' };
/** Runs an event as the browser does: the window's capture listeners, the target's React handler, then the window's other listeners. */
const dispatch = async (type: string, target: FakeElement, init: object = {}) => {
  let stopped = false;
  let immediate = false;
  const e = {
    type,
    target,
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    stopImmediatePropagation() {
      stopped = immediate = true;
    },
    ...init,
  };
  const run = (capture: boolean) => {
    for (const l of [...listeners])
      if (!immediate && l.type === type && l.capture === capture) l.fn(e as never);
  };
  await act(async () => {
    run(true);
    if (!stopped) handlers(target)?.[REACT_PROPS[type]!]?.(e);
    if (!stopped) run(false);
    await settle();
  });
  return e;
};
const click = (el: FakeElement) => dispatch('click', el);
const press = (key: string, target: FakeElement = hit()) => dispatch('keydown', target, { key });

async function openFromPalette() {
  await act(() => seen.palette.at(-1)!.onOpenChange(true));
  const command = seen.palette.at(-1)!.items.find((item) => item.id === 'debug-view')!;
  await act(() => {
    command.run();
    seen.palette.at(-1)!.onOpenChange(false);
  });
}

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('Node', FakeNode);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'flex' }));
  doc.querySelectorAll = () => all(container, (n) => n.hasAttribute('data-debug-region'));
  useBoard.setState({
    start() {},
    stop() {},
    board: { projects: [{ id: 'alpha', name: 'alpha', roots: [] }] } as never,
  });
  useCurrentProject.getState().choose('alpha');
  useShell.setState({ screen: 'board' });
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container as never);
  await act(() => root.render(createElement(App)));
});

afterAll(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const before = doc.createElement('button');

it('opens the debug view from the palette command', async () => {
  focus.at = before;
  expect(toolbar()).toBeUndefined();
  await openFromPalette();
  expect(toolbar()?.getAttribute('aria-label')).toBe(zh('components.debugView.title'));
  expect(focus.at).toBe(hit());
});

it.each([
  {
    region: 'board.milestone',
    name: zh('components.debugView.region.milestone'),
    file: 'apps/web/src/screens/board/MilestoneCard.tsx',
  },
  {
    region: 'board.publish-bar',
    name: zh('components.debugView.region.publishBar'),
    file: 'apps/web/src/screens/board/PublishBar.tsx',
  },
])('names the marked region $region and its file while the pointer is over it', async (r) => {
  await hover(r.region);
  expect(byRole('status')!.textContent).toBe(`${r.name}${r.file}`);
});

it('picks the region on a click and shows its source location in the inspector', async () => {
  await hover('board.milestone');
  await click(hit());
  expect(inspector()!.textContent).toContain(MILESTONE_SRC);
  expect(inspector()!.textContent).toContain(zh('components.debugView.region.milestone'));
});

it('sends only once the request is written', async () => {
  const send = () => button(inspector()!, zh('components.debugView.send'))!;
  expect(send().hasAttribute('disabled')).toBe(true);
  await describe('  \n ');
  expect(send().hasAttribute('disabled')).toBe(true);
  await describe('show the merged count');
  expect(send().hasAttribute('disabled')).toBe(false);
});

it('sends the pick with its note and the request, then leaves and gives focus back', async () => {
  const note = byLabel(zh('components.debugView.note'))[0]!;
  await act(() => handlers(note).onChange!({ target: { value: 'the count is off' } }));
  await click(button(inspector()!, zh('components.debugView.send'))!);
  expect(vi.mocked(sendDebugItems)).toHaveBeenCalledWith(
    [
      {
        pick: expect.objectContaining({ region: 'board.milestone', source: MILESTONE_SRC }),
        note: 'the count is off',
        image: null,
      },
    ],
    'show the merged count',
  );
  expect(toolbar()).toBeUndefined();
  expect(focus.at).toBe(before);
});

it('lists a second pick, made with Enter, beside the first and sends both', async () => {
  await openFromPalette();
  await hover('board.milestone');
  await click(hit());
  await hover('board.publish-bar');
  await press('Enter');
  const removes = [
    zh('components.debugView.region.milestone'),
    zh('components.debugView.region.publishBar'),
  ].map((name) => byLabel(zhf('components.debugView.remove', { name }))[0]);
  expect(removes.every(Boolean)).toBe(true);
  expect(button(inspector()!, zhf('components.debugView.sendCount', { count: 2 }))).toBeDefined();
});

it('takes one item off the list with its remove button', async () => {
  const name = zh('components.debugView.region.milestone');
  await click(byLabel(zhf('components.debugView.remove', { name }))[0]!);
  expect(byLabel(zhf('components.debugView.remove', { name }))).toEqual([]);
  expect(button(inspector()!, zh('components.debugView.send'))).toBeDefined();
  expect(inspector()!.textContent).toContain(PUBLISH_SRC);
});

it('keeps a region picked twice as one item', async () => {
  await hover('board.publish-bar');
  await click(hit());
  expect(button(inspector()!, zh('components.debugView.send'))).toBeDefined();
  expect(
    byLabel(
      zhf('components.debugView.remove', { name: zh('components.debugView.region.publishBar') }),
    ),
  ).toEqual([]);
});

it('stays open with its items and the request when the send fails', async () => {
  vi.mocked(sendDebugItems).mockResolvedValueOnce(false);
  await describe('the bar hides the branch');
  await click(button(inspector()!, zh('components.debugView.send'))!);
  expect(toolbar()).toBeDefined();
  expect(inspector()!.textContent).toContain(PUBLISH_SRC);
  expect(handlers(description()).value as unknown).toBe('the bar hides the branch');
});

it('closes the inspector on Esc, then leaves the debug view on the next', async () => {
  await press('Escape');
  expect(inspector()).toBeUndefined();
  expect(toolbar()).toBeDefined();
  await press('Escape');
  expect(toolbar()).toBeUndefined();
});

it('keeps clicks and keys from the app while open and gives them back after', async () => {
  const keys: string[] = [];
  // Registered like the app's own window key handlers, before the view opens.
  win.addEventListener('keydown', (e: { key: string }) => keys.push(e.key));
  const merge = button(container, 'Merge')!;
  await click(merge);
  await press('j', doc.body);
  expect([seen.appClicks, keys]).toEqual([1, ['j']]);

  await openFromPalette();
  await click(merge);
  await press('j');
  await press('j', doc.body);
  expect([seen.appClicks, keys]).toEqual([1, ['j']]);

  await hover('board.milestone');
  await click(hit());
  await press('Escape');
  expect(inspector()).toBeUndefined();
  // With no request yet, the toolbar's Send asks for one.
  const sends = vi.mocked(sendDebugItems).mock.calls.length;
  await click(button(toolbar()!, zh('components.debugView.send'))!);
  expect(vi.mocked(sendDebugItems).mock.calls.length).toBe(sends);
  expect(focus.at).toBe(description());
  expect((await press('a', description())).defaultPrevented).toBe(false);
  await describe('a');
  expect(button(inspector()!, zh('components.debugView.send'))!.hasAttribute('disabled')).toBe(
    false,
  );

  await press('Escape', description());
  await press('Escape');
  expect(toolbar()).toBeUndefined();
  await click(merge);
  await press('j', doc.body);
  expect([seen.appClicks, keys]).toEqual([2, ['j', 'a', 'j']]);
});
