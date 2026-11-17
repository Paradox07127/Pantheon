import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BrowserState, WorkbenchSession } from '@pantheon/protocol';
import { HookHost, deferred, find, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { inspectorTabs } from '@/screens/sessions/inspector-model';
import { FilesPanel } from '@/screens/sessions/FilesPanel';
import { BrowserPanel, answerBrowser } from '@/screens/sessions/BrowserPanel';
import { appErrors, recordAppError } from '@/data/app-errors';
import { toastManager } from '@/components/Toast';
import { useShell } from '@/store';
import { useBoard } from '@/data/board';

const worktree = {
  id: 'session-a',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
} as WorkbenchSession;

const hosts: HookHost<any>[] = [];
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
});

const row = (tree: ReactElement, name: string) =>
  find(tree, (n) => n.props.role === 'treeitem' && text(n) === name);

describe('panel kinds of the session dock', () => {
  it('offers the files, trace and monitor panels, and the browser panel only beside a desktop browser', () => {
    vi.stubGlobal('window', {});
    expect(inspectorTabs(worktree)).toEqual([
      'changes',
      'checks',
      'plan',
      'files',
      'trace',
      'monitor',
    ]);
    vi.stubGlobal('window', { pantheon: { browserOpen: vi.fn() } });
    expect(inspectorTabs(worktree)).toEqual([
      'changes',
      'checks',
      'plan',
      'files',
      'browser',
      'trace',
      'monitor',
    ]);
  });

  it('offers the plan, files, trace and monitor panels to a session without a worktree', () => {
    const baseline = { ...worktree, workspace_id: null } as WorkbenchSession;
    vi.stubGlobal('window', {});
    expect(inspectorTabs(baseline)).toEqual(['plan', 'files', 'trace', 'monitor']);
    vi.stubGlobal('window', { pantheon: { browserOpen: vi.fn() } });
    expect(inspectorTabs(baseline)).toEqual(['plan', 'files', 'browser', 'trace', 'monitor']);
  });
});

describe('files panel', () => {
  const lists: Record<string, unknown> = {
    '': {
      entries: [
        { name: 'src', kind: 'dir' },
        { name: 'logo.png', kind: 'file', size: 40 },
        { name: 'server.log', kind: 'file', size: 900000 },
      ],
      truncated: false,
    },
    src: { entries: [{ name: 'main.ts', kind: 'file', size: 30 }], truncated: false },
  };
  const reads: Record<string, unknown> = {
    'src/main.ts': {
      path: 'src/main.ts',
      text: 'const first = 1;\nconst second = 2;\n',
      size: 36,
      truncated: false,
    },
    'logo.png': { path: 'logo.png', binary: true, size: 40, truncated: false },
    'server.log': { path: 'server.log', text: 'started\n', size: 900000, truncated: true },
  };
  let focus: () => void;
  const mount = (worktree = true) => {
    const query = vi.fn(async (method: string, params: Record<string, string>) => ({
      ok: true,
      value: method === 'files.list' ? lists[params.path ?? ''] : reads[params.path!],
    }));
    focus = () => {};
    vi.stubGlobal('window', {
      pantheon: { query },
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'focus') focus = listener;
      },
      removeEventListener: () => {},
    });
    const h = new HookHost(() =>
      FilesPanel({ projectId: 'project-a', sessionId: 'session-a', worktree }),
    );
    hosts.push(h);
    h.render();
    return { h, query };
  };
  const listed = (query: ReturnType<typeof vi.fn>) =>
    query.mock.calls.filter((call) => call[0] === 'files.list').map((call) => call[1].path ?? '');
  const tree = (h: HookHost<any>) => find(h.value, (n) => n.props.role === 'tree');
  /** The rows as the tree's key handler sees them in the page. */
  const drawn = (h: HookHost<any>) => {
    const items = nodes(tree(h)).filter((n) => n.props.role === 'treeitem');
    return items.map((n) => ({
      name: text(n),
      getAttribute: (name: string) => (n.props[name] === undefined ? null : String(n.props[name])),
      focus: vi.fn(() => n.props.onFocus()),
      click: () => n.props.onClick(),
    }));
  };
  const press = (h: HookHost<any>, name: string, key: string) => {
    const rows = drawn(h);
    const target = rows.find((r) => r.name === name)!;
    const event = {
      key,
      target,
      currentTarget: { querySelectorAll: () => rows },
      preventDefault: vi.fn(),
    };
    tree(h).props.onKeyDown(event);
    h.render();
    return { rows, event };
  };
  const tabbable = (h: HookHost<any>) =>
    nodes(tree(h))
      .filter((n) => n.props.role === 'treeitem' && n.props.tabIndex === 0)
      .map(text);

  it('lists a folder only once it is opened', async () => {
    const { h, query } = mount();
    await h.flush();
    expect(query.mock.calls).toEqual([
      ['files.list', { project_id: 'project-a', session_id: 'session-a' }],
    ]);
    expect(row(h.value, 'src').props['aria-expanded']).toBe(false);
    row(h.value, 'src').props.onClick();
    await h.flush();
    expect(query.mock.calls.at(-1)).toEqual([
      'files.list',
      { project_id: 'project-a', session_id: 'session-a', path: 'src' },
    ]);
    expect(row(h.value, 'src').props['aria-expanded']).toBe(true);
    expect(row(h.value, 'main.ts').props['aria-level']).toBe(2);
  });

  it("reads the project's folder for a session without a worktree", async () => {
    const { h, query } = mount(false);
    await h.flush();
    row(h.value, 'src').props.onClick();
    await h.flush();
    row(h.value, 'main.ts').props.onClick();
    await h.flush();
    expect(query.mock.calls).toEqual([
      ['files.list', { project_id: 'project-a' }],
      ['files.list', { project_id: 'project-a', path: 'src' }],
      ['files.read', { project_id: 'project-a', path: 'src/main.ts' }],
    ]);
  });

  it('shows a file read below the tree, numbered, binary or cut short', async () => {
    const { h, query } = mount();
    await h.flush();
    row(h.value, 'src').props.onClick();
    await h.flush();
    row(h.value, 'main.ts').props.onClick();
    await h.flush();
    expect(query.mock.calls.at(-1)).toEqual([
      'files.read',
      { project_id: 'project-a', session_id: 'session-a', path: 'src/main.ts' },
    ]);
    expect(row(h.value, 'main.ts').props['aria-selected']).toBe(true);
    const lines = find(h.value, (n) => n.props.className === 'ftr-code');
    expect(text(lines)).toBe('1const first = 1;2const second = 2;');

    row(h.value, 'logo.png').props.onClick();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.className === 'ftr-view'))).toContain(
      zh('sessions.panel.files.binary'),
    );

    row(h.value, 'server.log').props.onClick();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.className === 'ftr-view'))).toBe(
      `1started${zh('sessions.panel.files.truncated')}`,
    );
  });

  it('lists the open folders and reads the shown file again after the session changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      useBoard.setState({ events: [], board: null });
      const { h, query } = mount();
      await h.flush();
      row(h.value, 'src').props.onClick();
      await h.flush();
      row(h.value, 'main.ts').props.onClick();
      await h.flush();
      lists.src = { entries: [{ name: 'next.ts', kind: 'file', size: 9 }], truncated: false };
      reads['src/main.ts'] = { path: 'src/main.ts', text: 'const first = 2;\n', size: 17 };
      const calls = query.mock.calls.length;
      useBoard.setState({
        events: [{ sequence: 7, kind: 'agent.tool.completed', aggregate_id: 'session-a' } as any],
      });
      h.render();
      vi.advanceTimersByTime(1_000);
      await h.flush();
      expect(query.mock.calls.slice(calls).map((call) => [call[0], call[1].path ?? ''])).toEqual([
        ['files.list', ''],
        ['files.list', 'src'],
        ['files.read', 'src/main.ts'],
      ]);
      expect(row(h.value, 'next.ts').props['aria-level']).toBe(2);
      const lines = find(h.value, (n) => n.props.className === 'ftr-code');
      expect(text(lines)).toBe('1const first = 2;');
    } finally {
      lists.src = { entries: [{ name: 'main.ts', kind: 'file', size: 30 }], truncated: false };
      reads['src/main.ts'] = {
        path: 'src/main.ts',
        text: 'const first = 1;\nconst second = 2;\n',
        size: 36,
        truncated: false,
      };
      useBoard.setState({ events: [] });
      vi.useRealTimers();
    }
  });

  it('lists a folder again each time it opens and the tree again when the window takes focus', async () => {
    const { h, query } = mount();
    await h.flush();
    row(h.value, 'src').props.onClick();
    await h.flush();
    row(h.value, 'src').props.onClick();
    h.render();
    row(h.value, 'src').props.onClick();
    await h.flush();
    expect(listed(query)).toEqual(['', 'src', 'src']);
    focus();
    await h.flush();
    expect(listed(query)).toEqual(['', 'src', 'src', '', 'src']);
  });

  it('is one tab stop that the arrow keys move through, open and close', async () => {
    const { h, query } = mount();
    await h.flush();
    expect(tabbable(h)).toEqual(['src']);
    press(h, 'src', 'ArrowRight');
    await h.flush();
    expect(row(h.value, 'src').props['aria-expanded']).toBe(true);
    expect(listed(query)).toEqual(['', 'src']);
    let moved = press(h, 'src', 'ArrowRight');
    expect(moved.rows.find((r) => r.name === 'main.ts')!.focus).toHaveBeenCalled();
    expect(tabbable(h)).toEqual(['main.ts']);
    moved = press(h, 'main.ts', 'ArrowLeft');
    expect(moved.rows.find((r) => r.name === 'src')!.focus).toHaveBeenCalled();
    expect(tabbable(h)).toEqual(['src']);
    moved = press(h, 'src', 'End');
    expect(moved.rows.find((r) => r.name === 'server.log')!.focus).toHaveBeenCalled();
    moved = press(h, 'server.log', 'Home');
    expect(moved.rows.find((r) => r.name === 'src')!.focus).toHaveBeenCalled();
    press(h, 'src', 'ArrowLeft');
    expect(row(h.value, 'src').props['aria-expanded']).toBe(false);
    expect(tabbable(h)).toEqual(['src']);
  });
});

describe('browser panel', () => {
  /** A container the app portals one node into; it answers the attribute selectors a role takes. */
  const portal = (node: { role?: string; modal?: boolean; rect: object }) => ({
    contains: () => false,
    querySelectorAll: (selector: string) =>
      selector
        .split(',')
        .some((part) =>
          part.trim() === '*'
            ? true
            : part.includes(`[role="${node.role}"]`) &&
              !(node.modal === false && part.includes(':not([aria-modal="false"])')),
        )
        ? [{ getBoundingClientRect: () => node.rect }]
        : [],
  });
  const mount = (url?: string) => {
    const watching = { resized: new Set<() => void>(), mutated: new Set<(r: object[]) => void>() };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private run: () => void) {}
        observe() {
          watching.resized.add(this.run);
        }
        disconnect() {
          watching.resized.delete(this.run);
        }
      },
    );
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(private run: (records: object[]) => void) {}
        observe() {
          watching.mutated.add(this.run);
        }
        disconnect() {
          watching.mutated.delete(this.run);
        }
      },
    );
    const listeners = new Map<string, Set<() => void>>();
    const resized = () => [...watching.resized].forEach((run) => run());
    const mutated = () => [...watching.mutated].forEach((run) => run([{ target: {} }]));
    const windowEvent = (kind: string) => [...(listeners.get(kind) ?? [])].forEach((run) => run());
    // What the app portals outside its root: popups, dialogs and toasts.
    const overlays: object[] = [];
    vi.stubGlobal('document', { body: { children: overlays } });
    let listener = (_state: BrowserState) => {};
    const bridge = {
      browserOpen: vi.fn(async () => ({ ok: true, value: { id: 'view-a' } })),
      browserNavigate: vi.fn(async () => ({ ok: true, value: null })),
      browserSetBounds: vi.fn(async () => ({ ok: true, value: null })),
      browserClose: vi.fn(async () => ({ ok: true, value: null })),
      onBrowserState: vi.fn((next: (state: BrowserState) => void) => {
        listener = next;
        return () => {};
      }),
    };
    vi.stubGlobal('window', {
      pantheon: bridge,
      addEventListener(kind: string, run: () => void) {
        listeners.set(kind, (listeners.get(kind) ?? new Set()).add(run));
      },
      removeEventListener(kind: string, run: () => void) {
        listeners.get(kind)?.delete(run);
      },
    });
    const rect = { left: 600.4, top: 80.6, width: 380, height: 500 };
    const h = new HookHost(
      () => BrowserPanel(url === undefined ? {} : { url }),
      (tree) => {
        find(tree, (n) => n.props.className === 'brw-view').props.ref.current = {
          getBoundingClientRect: () => rect,
        };
      },
    );
    hosts.push(h);
    h.render();
    return {
      h,
      bridge,
      rect,
      resized,
      mutated,
      windowEvent,
      overlays,
      state: (s: BrowserState) => listener(s),
    };
  };
  const address = (tree: ReactElement) => find(tree, (n) => n.type === 'input');
  const enter = (h: HookHost<ReactElement>, text: string) => {
    address(h.value).props.onChange({ target: { value: text } });
    h.render();
    address(h.value).props.onKeyDown({
      key: 'Enter',
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
  };
  const button = (h: HookHost<ReactElement>, label: string) =>
    find(h.value, (n) => n.type === 'button' && n.props['aria-label'] === label);
  /** What Activity does when the screen hides and shows again: effects clean up and run anew, state stays. */
  const hideAndShow = async (h: HookHost<ReactElement>) => {
    h.unmount();
    await h.flush();
    for (const slot of h.slots)
      if (slot && typeof slot === 'object' && 'cleanup' in slot)
        Object.assign(slot, { deps: [{}], cleanup: undefined });
    h.render();
    await h.flush();
  };

  it('opens the page over its area, follows its size and closes when it goes', async () => {
    const { h, bridge, rect, resized } = mount('http://localhost:5173/');
    await h.flush();
    expect(bridge.browserOpen).toHaveBeenCalledWith({
      url: 'http://localhost:5173/',
      bounds: { x: 600, y: 81, width: 380, height: 500 },
    });
    rect.width = 300;
    resized();
    expect(bridge.browserSetBounds).toHaveBeenCalledWith({
      id: 'view-a',
      bounds: { x: 600, y: 81, width: 300, height: 500 },
    });
    h.unmount();
    await h.flush();
    expect(bridge.browserClose).toHaveBeenCalledWith({ id: 'view-a' });
  });

  it('starts with an empty address and opens nothing until one is entered', async () => {
    const { h, bridge } = mount();
    await h.flush();
    expect(address(h.value).props.value).toBe('');
    expect(bridge.browserOpen).not.toHaveBeenCalled();
    enter(h, 'localhost:3000/admin');
    await h.flush();
    expect(bridge.browserOpen).toHaveBeenCalledWith({
      url: 'http://localhost:3000/admin',
      bounds: { x: 600, y: 81, width: 380, height: 500 },
    });
  });

  it('navigates the open page to the address entered, and follows its state', async () => {
    const { h, bridge, state } = mount('http://localhost:5173/');
    await h.flush();
    enter(h, 'http://localhost:5173/admin');
    await h.flush();
    expect(bridge.browserNavigate).toHaveBeenCalledWith({
      id: 'view-a',
      url: 'http://localhost:5173/admin',
    });
    state({
      id: 'view-a',
      url: 'http://localhost:5173/login',
      title: 'Sign in',
      can_go_back: true,
      can_go_forward: false,
      loading: true,
    });
    await h.flush();
    expect(address(h.value).props.value).toBe('http://localhost:5173/login');
    expect(button(h, zh('sessions.panel.browser.back')).props.disabled).toBe(false);
    expect(button(h, zh('sessions.panel.browser.forward')).props.disabled).toBe(true);
    expect(button(h, zh('sessions.panel.browser.loading')).props['aria-busy']).toBe(true);
  });

  it('follows its place when the layout moves it without resizing it', async () => {
    const { h, bridge, rect, windowEvent } = mount('http://localhost:5173/');
    await h.flush();
    for (const [kind, left] of [
      ['resize', 400],
      ['scroll', 300],
      ['transitionend', 200],
    ] as const) {
      rect.left = left + 0.2;
      windowEvent(kind);
      expect(bridge.browserSetBounds).toHaveBeenLastCalledWith({
        id: 'view-a',
        bounds: { x: left, y: 81, width: 380, height: 500 },
      });
    }
  });

  it('steps the page aside while an overlay of the app lies over it', async () => {
    const { h, bridge, mutated, overlays } = mount('http://localhost:5173/');
    await h.flush();
    overlays.push(
      portal({ role: 'dialog', rect: { left: 520, top: 200, width: 400, height: 300 } }),
    );
    mutated();
    expect(bridge.browserSetBounds).toHaveBeenLastCalledWith({
      id: 'view-a',
      bounds: { x: 600, y: 81, width: 0, height: 0 },
    });
    overlays.pop();
    mutated();
    expect(bridge.browserSetBounds).toHaveBeenLastCalledWith({
      id: 'view-a',
      bounds: { x: 600, y: 81, width: 380, height: 500 },
    });
  });

  it('keeps the page in place under a tooltip or toast over it', async () => {
    const { h, bridge, mutated, overlays } = mount('http://localhost:5173/');
    await h.flush();
    const over = { left: 620, top: 100, width: 120, height: 28 };
    overlays.push(portal({ rect: over }), portal({ role: 'dialog', modal: false, rect: over }));
    mutated();
    expect(bridge.browserSetBounds).not.toHaveBeenCalledWith({
      id: 'view-a',
      bounds: { x: 600, y: 81, width: 0, height: 0 },
    });
  });

  it('opens the page it showed again when the screen shows again, with fresh controls', async () => {
    const { h, bridge, state } = mount();
    enter(h, 'localhost:3000');
    await h.flush();
    state({
      id: 'view-a',
      url: 'http://localhost:3000/login',
      title: 'Sign in',
      can_go_back: true,
      can_go_forward: false,
      loading: false,
    });
    await h.flush();
    await hideAndShow(h);
    expect(bridge.browserClose).toHaveBeenCalledWith({ id: 'view-a' });
    expect(bridge.browserOpen).toHaveBeenLastCalledWith({
      url: 'http://localhost:3000/login',
      bounds: { x: 600, y: 81, width: 380, height: 500 },
    });
    expect(address(h.value).props.value).toBe('http://localhost:3000/login');
    expect(button(h, zh('sessions.panel.browser.back')).props.disabled).toBe(true);
  });

  it('opens again after the bridge failed an open, and says why it failed', async () => {
    const { h, bridge } = mount();
    bridge.browserOpen.mockRejectedValueOnce(new Error('channel closed'));
    enter(h, 'localhost:3000');
    await h.flush();
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(true);
    enter(h, 'localhost:3001');
    await h.flush();
    expect(bridge.browserOpen).toHaveBeenCalledTimes(2);
    expect(bridge.browserOpen).toHaveBeenLastCalledWith({
      url: 'http://localhost:3001',
      bounds: { x: 600, y: 81, width: 380, height: 500 },
    });
  });

  it.each([
    ['back', 'browserBack', { can_go_back: true, can_go_forward: false }],
    ['forward', 'browserForward', { can_go_back: false, can_go_forward: true }],
    ['reload', 'browserReload', { can_go_back: false, can_go_forward: false }],
  ] as const)('says why %s failed', async (label, action, can) => {
    const { h, bridge, state } = mount();
    const failed = vi.fn(async () => ({ ok: false, error: { code: 'no_view', message: 'gone' } }));
    Object.assign(bridge, { [action]: failed });
    enter(h, 'localhost:3000');
    await h.flush();
    state({ id: 'view-a', url: 'http://localhost:3000/', title: '', loading: false, ...can });
    await h.flush();
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
    button(h, zh(`sessions.panel.browser.${label}`)).props.onClick();
    await h.flush();
    expect(failed).toHaveBeenCalledWith({ id: 'view-a' });
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(true);
  });

  it('goes to an address entered while the page was still opening', async () => {
    const { h, bridge } = mount();
    const opened = deferred<unknown>();
    bridge.browserOpen.mockReturnValueOnce(opened.promise as never);
    enter(h, 'localhost:3000');
    await h.flush();
    enter(h, 'localhost:3001');
    await h.flush();
    opened.resolve({ ok: true, value: { id: 'view-a' } });
    await h.flush();
    expect(bridge.browserOpen).toHaveBeenCalledTimes(1);
    expect(bridge.browserNavigate).toHaveBeenCalledWith({
      id: 'view-a',
      url: 'http://localhost:3001',
    });
  });
});

describe('a session opening a page in the browser panel', () => {
  const opened = async (viewing: string) => {
    useShell.setState({ screen: 'sessions', sessionId: viewing, sessionTab: null });
    const sent: { type: string; input: Record<string, unknown> }[] = [];
    const bridge = {
      command: vi.fn(async (c: { type: string; input: Record<string, unknown> }) => {
        sent.push(c);
        return { ok: true };
      }),
      onBrowserState: (listener: (state: Partial<BrowserState>) => void) => {
        setTimeout(() => {
          listener({ id: 'page', loading: true });
          listener({ id: 'page', loading: false, url: 'https://example.com/', title: 'Example' });
        });
        return () => {};
      },
    };
    await answerBrowser(bridge as never, {
      request_id: 'request-a',
      session_id: 'session-a',
      action: 'open',
      url: 'https://example.com/',
    });
    return { result: sent[0]!.input, shell: useShell.getState() };
  };

  it('shows the page while the user views that session', async () => {
    const { result, shell } = await opened('session-a');
    expect(result).toMatchObject({ page: { url: 'https://example.com/', title: 'Example' } });
    expect([shell.sessionId, shell.sessionTab]).toEqual(['session-a', 'browser']);
  });

  it('shows why the answer did not reach the daemon', async () => {
    const add = vi.spyOn(toastManager, 'add').mockReturnValue('toast-a');
    await answerBrowser(
      {
        command: vi.fn(async () => ({ ok: false, error: { code: 'gone', message: 'gone' } })),
      } as never,
      { request_id: 'request-a', session_id: 'session-a', action: 'read' },
    );
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ type: 'failure' }));
    add.mockRestore();
  });

  it('leaves the window on the session the user views and tells the agent the browser is busy', async () => {
    const { result, shell } = await opened('session-b');
    expect(result).toMatchObject({ error: { code: 'browser_busy' } });
    expect([shell.sessionId, shell.sessionTab]).toEqual(['session-b', null]);
  });
});

describe('a diagnosis session reading the app window', () => {
  const region = (name: string, left: number) => ({
    dataset: { debugRegion: name },
    getBoundingClientRect: () => ({ left: left + 0.4, top: 10.6, width: 200.2, height: 40 }),
  });
  const answered = async (
    request: { action: string; selector?: string },
    html = '<body></body>',
  ) => {
    const sent: { type: string; input: Record<string, unknown> }[] = [];
    const bridge = {
      command: vi.fn(async (c: (typeof sent)[number]) => {
        sent.push(c);
        return { ok: true };
      }),
      captureRegion: vi.fn(async () => ({ ok: true, value: 'data:image/png;base64,AQID' })),
    };
    const matched = { outerHTML: html };
    vi.stubGlobal('document', {
      title: 'Pantheon',
      querySelector: (selector: string) =>
        selector === 'body' || selector === '.sb' ? matched : null,
      querySelectorAll: () => [region('board.lead', 0), region('board.progress', 300)],
    });
    vi.stubGlobal('location', { href: 'app://pantheon/index.html' });
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 900);
    await answerBrowser(
      bridge as never,
      {
        request_id: 'request-a',
        session_id: 'diagnosis',
        ...request,
      } as never,
    );
    return { result: sent[0]!.input, bridge };
  };

  it('answers app_errors with the errors the window recorded', async () => {
    recordAppError({ source: 'console', message: 'render loop warning' });
    const { result } = await answered({ action: 'app_errors' });
    expect(result).toEqual({ request_id: 'request-a', errors: [...appErrors()] });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ source: 'console', message: 'render loop warning' }),
    );
  });

  it('answers app_screenshot with a PNG of the whole window, its base64 without the data URL prefix', async () => {
    const { result, bridge } = await answered({ action: 'app_screenshot' });
    expect(bridge.captureRegion).toHaveBeenCalledWith({ x: 0, y: 0, width: 1440, height: 900 });
    expect(result).toEqual({
      request_id: 'request-a',
      page: { url: 'app://pantheon/index.html', title: 'Pantheon', png: 'AQID' },
    });
  });

  it.each([
    { name: 'the whole window', selector: undefined },
    { name: 'the element a selector matches', selector: '.sb' },
  ])('answers app_dom with the HTML of $name and the named regions', async ({ selector }) => {
    const { result } = await answered({ action: 'app_dom', selector }, '<div class="sb"></div>');
    expect(result).toEqual({
      request_id: 'request-a',
      dom: {
        html: '<div class="sb"></div>',
        regions: [
          { name: 'board.lead', rect: { x: 0, y: 11, width: 200, height: 40 } },
          { name: 'board.progress', rect: { x: 300, y: 11, width: 200, height: 40 } },
        ],
      },
    });
  });

  it('cuts the HTML of app_dom to 100000 characters', async () => {
    const { result } = await answered({ action: 'app_dom' }, `<body>${'x'.repeat(200_000)}</body>`);
    expect((result.dom as { html: string }).html).toHaveLength(100_000);
  });

  it('answers app_dom with an error when the selector matches nothing', async () => {
    const { result } = await answered({ action: 'app_dom', selector: '.missing' });
    expect(result).toEqual({
      request_id: 'request-a',
      error: { code: 'app_dom_not_found', message: expect.stringContaining('.missing') },
    });
  });
});
