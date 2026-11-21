import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { PopupMenuItem, WorkbenchSession } from '@pantheon/protocol';
import { ContextMenu } from '../../apps/web/node_modules/@base-ui/react/context-menu/index.mjs';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
}));
import { shortcutKeys, useShortcut } from '@/lib/shortcuts';
import { sessionMenu, type SessionMenuEntry } from '@/screens/sessions/model';
import { SessionHeader, SessionListRow } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

type Listener = (e: KeyboardEvent) => void;

const listed = (
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const workspace = { id: 'workspace-a', path: '/work/a', base_sha: 'abc1234' };
const shape = (groups: SessionMenuEntry[][]) =>
  groups.map((group) =>
    group.map((entry) =>
      'items' in entry
        ? `${entry.label} ▸ ${entry.items.map((i) => i.label).join(', ')}`
        : entry.label,
    ),
  );
const commands = (groups: SessionMenuEntry[][]) =>
  groups
    .flat()
    .flatMap((entry) => ('items' in entry ? entry.items : [entry]).map((i) => i.command));

let listeners: Listener[] = [];
let sent: { type: string; input: unknown }[];
let openWindow: ReturnType<typeof vi.fn>;
let popupMenu: ReturnType<typeof vi.fn<(entries: PopupMenuItem[]) => Promise<string | null>>>;

const stubWindow = (bridge: boolean) =>
  vi.stubGlobal('window', {
    ...(bridge
      ? {
          pantheon: {
            command: vi.fn(async (command: any) => {
              sent.push(command);
              return { ok: true, value: {} };
            }),
            query: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'x' } })),
            openWindow,
            popupMenu,
          },
        }
      : {}),
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && listeners.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((l) => l !== fn);
    },
  });
const event = (key: string, target: unknown = { tagName: 'DIV', isContentEditable: false }) =>
  ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    preventDefault: vi.fn(),
  }) as unknown as KeyboardEvent;
const press = (key: string, target?: unknown) => {
  const e = event(key, target);
  for (const listener of [...listeners]) listener(e);
};
const INPUT = { tagName: 'INPUT', isContentEditable: false };

// The clickable entries, plain items or ones turned off with a reason.
const items = (tree: unknown): ReactElement<any>[] =>
  nodes(tree as any).filter(
    (n) =>
      typeof n.type !== 'string' &&
      (typeof n.props.onClick === 'function' || n.props.disabled === true) &&
      n.props['aria-label'] === undefined,
  );
// An entry's label is its text, or the text of its label span when a hint follows it.
const labelOf = (n: ReactElement<any>) =>
  text(nodes(n.props.children).find((c) => c.props.className === 'mn-tx') ?? n);
const item = (tree: unknown, label: string) => items(tree).find((n) => labelOf(n) === label)!;
const row = (s: WorkbenchSession, onSelect = () => {}) =>
  mount(() => SessionListRow({ session: s, on: false, now: 0, onSelect }));
const header = (s: WorkbenchSession) => {
  const h = mount(() =>
    SessionHeader({
      session: {
        id: 'session-a',
        revision: 5,
        project_id: 'project-a',
        runtime: 'claude',
        state: 'open',
        turn_count: 1,
        workspace_id: 'workspace-a',
      } as Session,
      listed: s,
      title: 'Release notes',
      panels: ['changes'],
      onPanel() {},
      overview: true,
    }),
  );
  const more = named(h.value, 'MoreMenu');
  return mount(() => (more.type as (props: unknown) => ReactNode)(more.props));
};
const popupOf = (h: HookHost<any>) =>
  find(h.value, (n) => n.props.className === 'mn mn-menu pop' && n.props.style !== undefined);

beforeEach(() => {
  sent = [];
  listeners = [];
  openWindow = vi.fn(async () => ({ ok: true, value: null }));
  popupMenu = vi.fn(async () => null);
  mock.board = {
    board: {
      sessions: [{ id: 'session-a', revision: 5, project_id: 'project-a' }],
      session_turns: [],
      projects: [],
      workspaces: [workspace],
      cursor: 1,
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.shell = {
    sessionId: 'session-b',
    followFirstSession: vi.fn(),
    openSession: vi.fn(),
  };
  stubWindow(true);
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard: { writeText: vi.fn() } });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('session row menu order', () => {
  it('lists open, then edit, then the work, then where to open and copy, then archive and removal', () => {
    const groups = sessionMenu(listed('running'), {
      workspace,
      discardable: true,
      newWindow: true,
    });
    expect(shape(groups)).toEqual([
      [zh('sessions.rowMenu.open'), zh('sessions.rowMenu.openWindow')],
      [
        zh('sessions.model.menu.rename'),
        zh('sessions.model.menu.pin'),
        zh('sessions.model.menu.snooze'),
        zh('sessions.model.menu.markUnread'),
      ],
      [
        zh('sessions.model.menu.stopTurn'),
        zh('sessions.model.menu.runChecks'),
        zh('sessions.model.menu.merge'),
      ],
      [
        '打开于 ▸ 编辑器, 终端, Finder',
        '复制 ▸ worktree 路径, 会话 ID, 基线提交, 复制为 Markdown, 导出为 Markdown…',
      ],
      [zh('sessions.model.menu.discard'), zh('sessions.model.menu.delete')],
    ]);
  });

  it('keeps every action the menu had, the archive one among the last', () => {
    const ready = sessionMenu(listed('ready'), {
      workspace,
      discardable: true,
      unread: true,
      newWindow: true,
    });
    expect(commands(ready)).toEqual([
      'session.open',
      'session.open_window',
      'session.rename',
      'session.pin',
      'session.snooze',
      'session.mark_read',
      'session.gates.run',
      'session.merge',
      'open.editor',
      'open.terminal',
      'open.finder',
      'copy',
      'copy',
      'copy',
      'session.copy_markdown',
      'session.export_markdown',
      'session.archive',
      'session.discard',
      'session.delete',
    ]);
    const archived = sessionMenu(listed('done', { archived_at: '2026-11-03T00:00:00.000Z' }), {
      workspace,
    });
    expect(shape(archived).at(-1)).toEqual([
      zh('sessions.model.menu.unarchive'),
      zh('sessions.model.menu.delete'),
    ]);
    expect(commands(archived)).not.toContain('session.snooze');
  });

  it('shows F2 on rename and E on archive', () => {
    const menu = sessionMenu(listed('ready'), { workspace }).flat();
    const keys = (command: string) =>
      (menu.find((one) => 'command' in one && one.command === command) as { keys?: string }).keys;
    expect([keys('session.rename'), keys('session.archive')]).toEqual(['F2', 'E']);
    const h = row(listed('ready'));
    expect(item(h.value, zh('sessions.model.menu.rename')).props.keys).toBe('F2');
    expect(item(h.value, zh('sessions.model.menu.archive')).props.keys).toBe('E');
  });
});

describe('session row menu actions', () => {
  it('opens the session in this window', () => {
    const h = row(listed('ready'));
    item(h.value, zh('sessions.rowMenu.open')).props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('session-a');
  });

  it('opens the session in a window of its own, hinting the ⌘-click', async () => {
    const h = row(listed('ready'));
    const entry = item(h.value, zh('sessions.rowMenu.openWindow'));
    expect(text(entry)).toBe('在新窗口打开⌘点击');
    entry.props.onClick();
    await h.flush();
    expect(openWindow).toHaveBeenCalledWith({
      kind: 'session',
      project_id: 'project-a',
      session_id: 'session-a',
    });
    expect(mock.shell.openSession).not.toHaveBeenCalled();
  });

  it('leaves the new window item out without the desktop bridge', () => {
    stubWindow(false);
    const h = row(listed('ready'));
    const labels = items(h.value).map(labelOf);
    expect(labels).toContain(zh('sessions.rowMenu.open'));
    expect(labels).not.toContain(zh('sessions.rowMenu.openWindow'));
  });

  it('opens a ⌘-clicked row in a new window without showing it here', () => {
    const onSelect = vi.fn();
    const h = row(listed('ready'), onSelect);
    const button = named(h.value, 'SessionRowButton');
    button.props.onSelect({ metaKey: true });
    expect(openWindow).toHaveBeenCalledWith({
      kind: 'session',
      project_id: 'project-a',
      session_id: 'session-a',
    });
    expect(onSelect).not.toHaveBeenCalled();
    button.props.onSelect({ metaKey: false });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  it('renames on F2 outside a text field', () => {
    expect(shortcutKeys('session-rename')).toBe('F2');
    const run = vi.fn();
    mount(() => useShortcut('session-rename', run));
    press('F2', INPUT);
    expect(run).not.toHaveBeenCalled();
    press('F2');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('archives the highlighted row on E, and not on an E typed in a field', async () => {
    const h = row(listed('ready'));
    press('e', INPUT);
    await h.flush();
    expect(sent).toEqual([]);
    const e = event('e');
    named(h.value, 'SessionRowButton').props.onKeyDown(e);
    await h.flush();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(sent).toMatchObject([
      { type: 'session.archive', input: { session_id: 'session-a' }, expected_revision: 5 },
    ]);
  });
});

describe('session row native menu', () => {
  // The items a native menu shows, its submenus' items in place of the submenus.
  const leaves = (entries: PopupMenuItem[]): PopupMenuItem[] =>
    entries.flatMap((entry) =>
      'separator' in entry ? [] : entry.items ? leaves(entry.items) : [entry],
    );
  const rightClick = (h: HookHost<any>) => {
    const row = named(h.value, 'SessionRowButton');
    const button = (row.type as (props: unknown) => ReactElement<any>)(row.props);
    const e = { preventDefault: vi.fn() };
    button.props.onContextMenu?.(e);
    return { name: button.props['aria-label'] as string, e };
  };
  const hasContextMenu = (h: HookHost<any>) =>
    nodes(h.value).some((n) => n.type === ContextMenu.Root);

  it('pops up the items of the ⋯ menu as a native menu on right-click and runs the one picked', async () => {
    popupMenu.mockImplementation(
      async (entries) =>
        (
          leaves(entries).find(
            (entry) => 'label' in entry && entry.label === zh('sessions.rowMenu.open'),
          ) as { id: string }
        ).id,
    );
    const h = row(listed('ready'));
    const shown = items(popupOf(h)).map(labelOf);
    expect(hasContextMenu(h)).toBe(false);
    const { name, e } = rightClick(h);
    expect(name.startsWith('Release notes')).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    await h.flush();
    expect(popupMenu).toHaveBeenCalledTimes(1);
    const native = leaves(popupMenu.mock.calls[0]![0]);
    expect(native.map((entry) => 'label' in entry && entry.label)).toEqual(shown);
    expect(native.map((entry) => 'enabled' in entry && entry.enabled)).toEqual(
      items(popupOf(h)).map((n) => n.props.disabled !== true),
    );
    expect(mock.shell.openSession).toHaveBeenCalledWith('session-a');
  });

  it('runs nothing when the native menu closes without a pick', async () => {
    const h = row(listed('ready'));
    rightClick(h);
    await h.flush();
    expect(popupMenu).toHaveBeenCalledTimes(1);
    expect(mock.shell.openSession).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('keeps the page context menu without the desktop bridge', () => {
    stubWindow(false);
    const h = row(listed('ready'));
    expect(hasContextMenu(h)).toBe(true);
    const { e } = rightClick(h);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(popupMenu).not.toHaveBeenCalled();
  });
});

describe('session header more menu', () => {
  it('has the row menu without open', () => {
    const s = listed('ready');
    const labels = (h: HookHost<any>) => items(popupOf(h)).map(labelOf);
    const fromRow = labels(row(s));
    const fromHeader = labels(header(s));
    expect(fromRow[0]).toBe(zh('sessions.rowMenu.open'));
    expect(fromHeader).not.toContain(zh('sessions.rowMenu.open'));
    // The header's own session actions come first.
    expect(fromHeader.slice(4, fromRow.length + 3)).toEqual(fromRow.slice(1));
  });
});
