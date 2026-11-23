import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { inspectorTabs } from '@/screens/sessions/inspector-model';
import { FilesPanel } from '@/screens/sessions/FilesPanel';
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
  const mount = () => {
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
    const h = new HookHost(() => FilesPanel({ projectId: 'project-a', sessionId: 'session-a' }));
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
