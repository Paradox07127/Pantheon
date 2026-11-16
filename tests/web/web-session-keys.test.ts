import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { type HookHost, find, mount, named, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  projects: {} as any,
  current: {} as any,
}));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
    }),
);
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign(
    store(() => mock.shell),
    {
      setState: (patch: object) => Object.assign(mock.shell, patch),
    },
  ),
}));
vi.mock('@/screens/projects/view', () => ({ useProjectsView: store(() => mock.projects) }));
vi.mock('@/data/current-project', () => ({
  useCurrentProject: Object.assign(
    store(() => mock.current),
    { subscribe: () => () => {} },
  ),
}));
import { Sidebar } from '@/components/Sidebar';
import { Splitter } from '@/components/Splitter';
import { Tip } from '@/components/Tip';
import { toastManager } from '@/components/Toast';
import { failureText, type NeedsYouItem } from '@/data/needs-you';
import { markUnread } from '@/data/unread';
import { resetShortcuts, setShortcutOverrides, SHORTCUTS } from '@/lib/shortcuts';
import { sessionMenu } from '@/screens/sessions/model';
import { SessionHeader, SessionListRow } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const groupName = (key: string) => zh(`sessions.model.group.${key}`);

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const session = (
  id: string,
  state: WorkbenchSession['state'],
  minute: number,
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id,
  created_at: at(0),
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state,
  waiting: state === 'waiting' ? 1 : 0,
  waiting_kind: state === 'waiting' ? 'approval' : undefined,
  reconciling: false,
  stopping: false,
  last_activity_at: at(minute),
  changes: null,
  merge: null,
  ...extra,
});

const item = (project_id: string, id: string): NeedsYouItem => ({
  source: { table: 'sessions', id, revision: 1 },
  kind: 'session.failed',
  project_id,
  status: 'failed',
  created_at: 1,
  reason: 'session_failed',
  actions: [],
});

// Needs you, working (newest first), then ended.
const LIST = [
  session('r2', 'running', 2),
  session('w1', 'waiting', 1),
  session('i1', 'idle', 1),
  session('r1', 'running', 5),
  session('d1', 'done', 1),
];
const STOPS = ['group:waiting', 'w1', 'group:working', 'r1', 'r2', 'group:ended', 'i1', 'd1'];

type Listener = (e: KeyboardEvent) => void;
let listeners: { type: string; run: Listener }[];
let commands: { type: string; input: unknown }[];

beforeEach(() => {
  listeners = [];
  commands = [];
  mock.board = {
    board: {
      sessions: LIST.map((s) => ({ id: s.id, revision: 3, project_id: 'project-a' })),
      workspaces: [],
    },
    events: [],
    status: { state: 'live' },
    refresh() {},
  };
  mock.projects = { setOpening: vi.fn() };
  mock.current = { choose: vi.fn() };
  mock.shell = {
    screen: 'board',
    sessionId: null,
    theme: 'system',
    sessionGroup: null,
    setScreen: vi.fn(),
    startNewSession: vi.fn(),
    followFirstSession: vi.fn(),
    renaming: null,
    renameSession: vi.fn((id: string | null) => {
      mock.shell.renaming = id;
    }),
    openSession: vi.fn((id: string) => {
      mock.shell.screen = 'sessions';
      mock.shell.sessionId = id;
    }),
    openProjectSession: vi.fn(),
  };
  vi.stubGlobal('window', {
    addEventListener: (type: string, run: Listener) => listeners.push({ type, run }),
    removeEventListener: (type: string, run: Listener) => {
      listeners = listeners.filter((l) => l.type !== type || l.run !== run);
    },
    matchMedia: () => ({ matches: true }),
    pantheon: {
      command: vi.fn(async (command: any) => {
        commands.push(command);
        return { ok: true, value: {} };
      }),
      query: vi.fn(async () => ({ ok: true, value: null })),
    },
  });
  vi.stubGlobal('document', {
    addEventListener() {},
    removeEventListener() {},
    hasFocus: () => true,
    visibilityState: 'visible',
  });
  // These lists are grouped by state.
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key.startsWith('pantheon.sessionView.') ? '{"grouping":"state"}' : null,
    setItem() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const event = (key: string, mods: Record<string, unknown> = {}) =>
  ({
    key,
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...mods,
  }) as any;

const press = (key: string, mods: Record<string, unknown> = {}, type = 'keydown') => {
  const e = event(key, mods);
  for (const l of [...listeners]) if (l.type === type) l.run(e);
  return e.preventDefault as ReturnType<typeof vi.fn>;
};

function mountSidebar(
  all: NeedsYouItem[] = [],
  list: WorkbenchSession[] = LIST,
  layout: () => { collapsed: boolean; toggle: () => void } = () => ({
    collapsed: false,
    toggle: () => {},
  }),
  failed: { allNeeds?: string } = {},
) {
  return mount(() =>
    Sidebar({
      layout: { width: 280, resize: () => {}, commit: () => {}, reset: () => {}, ...layout() },
      projects: [
        { id: 'project-a', name: 'Alpha' },
        { id: 'project-b', name: 'Beta' },
      ],
      currentProjectId: 'project-a',
      onChooseProject: () => {},
      list: { data: list } as any,
      allNeeds: failed.allNeeds
        ? ({ items: null, error: failed.allNeeds } as any)
        : ({ items: all, error: null } as any),
    }),
  );
}

const rowIds = (h: HookHost<any>) =>
  nodes(h.value)
    .filter((n) => n.type === SessionListRow)
    .map((n) => n.props.session.id);

/** Fake list stops, one per key, recording focus. */
const stops = (keys: readonly string[]) =>
  keys.map((key) => ({
    dataset: key.startsWith('group:') ? { stop: key } : { session: key },
    focus: vi.fn(),
  }));

function listKey(h: HookHost<any>, from: string, key: string, mods = {}) {
  const els = stops(STOPS);
  const nav = find(h.value, (n) => n.type === 'nav');
  const e = event(key, {
    ...mods,
    target: { dataset: from.startsWith('group:') ? { stop: from } : { session: from } },
    currentTarget: { querySelectorAll: () => els },
  });
  nav.props.onKeyDown(e);
  h.render();
  const focused = els.find((el) => el.focus.mock.calls.length > 0);
  return {
    focused: focused ? (focused.dataset.session ?? focused.dataset.stop) : null,
    handled: e.preventDefault.mock.calls.length > 0,
  };
}

describe('asked session group', () => {
  it('groups the list by state and unfolds the rail to show the group asked for', () => {
    const saved = new Map([['pantheon.sessionView.project-a', '{"grouping":"lead"}']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    });
    let collapsed = true;
    const toggle = vi.fn(() => {
      collapsed = !collapsed;
    });
    mock.shell.sessionGroup = 'working';
    const h = mountSidebar([], LIST, () => ({ collapsed, toggle }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(JSON.parse(saved.get('pantheon.sessionView.project-a')!).grouping).toBe('state');
    expect(mock.shell.sessionGroup).toBe('working');
    h.render();
    expect(mock.shell.sessionGroup).toBeNull();
    const group = find(
      h.value,
      (n) => n.type === 'section' && n.props['aria-label'] === groupName('working'),
    );
    expect(nodes(group).some((n) => n.type === SessionListRow && n.props.session.id === 'r1')).toBe(
      true,
    );
  });
});

describe('session list keys', () => {
  // These entries have no default keys; the user records them.
  beforeEach(() =>
    setShortcutOverrides({
      'session-pin': 'Meta+Alt+P',
      'session-unread': 'Meta+Shift+U',
      'session-rename': 'Meta+Alt+R',
      'next-attention': 'Meta+Alt+A',
    }),
  );
  afterEach(() => resetShortcuts());

  it('moves between group headers and rows with the arrows, Home and End', () => {
    const h = mountSidebar();
    expect(listKey(h, 'group:waiting', 'ArrowDown').focused).toBe('w1');
    expect(listKey(h, 'w1', 'ArrowDown').focused).toBe('group:working');
    expect(listKey(h, 'w1', 'ArrowUp').focused).toBe('group:waiting');
    expect(listKey(h, 'r2', 'Home').focused).toBe('group:waiting');
    expect(listKey(h, 'r2', 'End').focused).toBe('group:ended');
    expect(listKey(h, 'group:ended', 'ArrowDown')).toEqual({ focused: null, handled: true });
  });

  it('keeps one tab stop, on the row last moved to', () => {
    const h = mountSidebar();
    const tabStops = () =>
      nodes(h.value)
        .filter((n) => n.props.tabIndex === 0)
        .map((n) => n.props.session?.id ?? n.props['data-stop']);
    expect(tabStops()).toEqual(['group:waiting']);
    listKey(h, 'w1', 'ArrowDown');
    expect(tabStops()).toEqual(['group:working']);
  });

  it('opens the focused row with Enter', () => {
    const h = mountSidebar();
    expect(listKey(h, 'r2', 'Enter').handled).toBe(true);
    expect(mock.shell.openSession).toHaveBeenCalledWith('r2');
  });

  it('folds the group of the focused row with ← and unfolds it with →', () => {
    const h = mountSidebar();
    expect(listKey(h, 'r1', 'ArrowLeft').focused).toBe('group:working');
    expect(rowIds(h)).toEqual(['w1']);
    listKey(h, 'group:working', 'ArrowRight');
    expect(rowIds(h)).toEqual(['w1', 'r1', 'r2']);
  });

  it('opens the third visible session with ⌘3', () => {
    mountSidebar();
    expect(press('3', { metaKey: true, code: 'Digit3' })).toHaveBeenCalled();
    expect(mock.shell.openSession).toHaveBeenCalledWith('r2');
  });

  /** The sidebar after opening w1, r1 and i1 in turn. */
  const afterOpening = () => {
    const h = mountSidebar();
    mock.shell.screen = 'sessions';
    for (const id of ['w1', 'r1', 'i1']) {
      mock.shell.sessionId = id;
      h.render();
    }
    return h;
  };

  it('cycles the recently opened sessions with ⌃Tab while ⌃ is held', () => {
    const h = afterOpening();
    press('Tab', { ctrlKey: true });
    expect(mock.shell.sessionId).toBe('r1');
    h.render();
    press('Tab', { ctrlKey: true });
    expect(mock.shell.sessionId).toBe('w1');
    h.render();
    press('Control', {}, 'keyup');
    h.render();
    press('Tab', { ctrlKey: true });
    expect(mock.shell.sessionId).toBe('i1');
  });

  it('ends the ⌃Tab cycle when the window loses focus before ⌃ is released', () => {
    const h = afterOpening();
    press('Tab', { ctrlKey: true });
    expect(mock.shell.sessionId).toBe('r1');
    h.render();
    press('', {}, 'blur');
    mock.shell.sessionId = 'w1';
    h.render();
    press('Tab', { ctrlKey: true });
    expect(mock.shell.sessionId).toBe('r1');
  });

  it('goes back through the recent sessions with ⌃⇧Tab', () => {
    afterOpening();
    press('Tab', { ctrlKey: true, shiftKey: true });
    expect(mock.shell.sessionId).toBe('w1');
  });

  it('opens the next session needing attention in another project with ⌘⌥A', () => {
    const h = mountSidebar([item('project-a', 'w1'), item('project-b', 'x')]);
    mock.shell.screen = 'sessions';
    mock.shell.sessionId = 'w1';
    h.render();
    expect(press('å', { metaKey: true, altKey: true, code: 'KeyA' })).toHaveBeenCalled();
    expect(mock.shell.openProjectSession).toHaveBeenCalledWith('project-b', 'x');
    expect(mock.current.choose).not.toHaveBeenCalled();
    expect(mock.shell.openSession).not.toHaveBeenCalled();
  });

  it('skips an archived session needing attention with ⌘⌥A', () => {
    const archived = session('f1', 'failed', 9, { archived_at: at(10) });
    const h = mountSidebar([item('project-a', 'w1')], [...LIST, archived]);
    mock.shell.screen = 'sessions';
    mock.shell.sessionId = 'w1';
    h.render();
    press('å', { metaKey: true, altKey: true, code: 'KeyA' });
    expect(mock.shell.openSession).toHaveBeenCalledWith('w1');
    expect(mock.shell.openSession).not.toHaveBeenCalledWith('f1');
  });

  it('reaches the session of another project waiting for approval with ⌘⌥A', () => {
    const approval: NeedsYouItem = {
      ...item('project-b', 'approval-1'),
      source: { table: 'approvals', id: 'approval-1', revision: 1 },
      kind: 'permission',
      reason: 'permission_requested',
      session_id: 'y',
    };
    const h = mountSidebar([item('project-a', 'w1'), approval]);
    mock.shell.screen = 'sessions';
    mock.shell.sessionId = 'w1';
    h.render();
    press('å', { metaKey: true, altKey: true, code: 'KeyA' });
    expect(mock.shell.openProjectSession).toHaveBeenCalledWith('project-b', 'y');
    expect(mock.current.choose).not.toHaveBeenCalled();
  });

  it('pins the focused row with ⌘⌥P and marks it unread with ⌘⇧U', async () => {
    const h = mountSidebar();
    const nav = find(h.value, (n) => n.type === 'nav');
    nav.props.onFocus({ target: { matches: () => true, dataset: { session: 'r1' } } });
    h.render();
    press('π', { metaKey: true, altKey: true, code: 'KeyP' });
    await Promise.resolve();
    expect(commands).toMatchObject([
      { type: 'session.pin', input: { session_id: 'r1', pinned: true } },
    ]);
    expect(press('U', { metaKey: true, shiftKey: true })).toHaveBeenCalled();
    h.render();
    const row = find(h.value, (n) => n.type === SessionListRow && n.props.session.id === 'r1');
    expect(row.props.unread).toBe(true);
  });

  it('tells why the daemon refused the pin of ⌘⌥P', async () => {
    const error = { code: 'permission_denied', message: 'Only user' };
    vi.mocked(window.pantheon!.command).mockResolvedValueOnce({ ok: false, error });
    const added = vi.spyOn(toastManager, 'add');
    mock.shell.screen = 'sessions';
    mock.shell.sessionId = 'r1';
    mountSidebar();
    press('π', { metaKey: true, altKey: true, code: 'KeyP' });
    await vi.waitFor(() => expect(added).toHaveBeenCalled());
    expect(added.mock.calls[0]![0]).toMatchObject({ title: failureText(error), type: 'failure' });
    added.mockRestore();
  });

  it('pins the session whose menu is open with ⌘⌥P, not the shown one', async () => {
    const h = mountSidebar();
    mock.shell.screen = 'sessions';
    mock.shell.sessionId = 'w1';
    h.render();
    const nav = find(h.value, (n) => n.type === 'nav');
    nav.props.onFocus({ target: { matches: () => true, dataset: { session: 'r1' } } });
    h.render();
    find(h.value, (n) => n.type === SessionListRow && n.props.session.id === 'r1').props.onMenu(
      true,
    );
    nav.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
    h.render();
    press('π', { metaKey: true, altKey: true, code: 'KeyP' });
    await Promise.resolve();
    expect(commands).toMatchObject([
      { type: 'session.pin', input: { session_id: 'r1', pinned: true } },
    ]);
  });

  it('marks and pins the session the thread follows, not the newest one', async () => {
    mock.shell.screen = 'sessions';
    mock.shell.followed = 'r2';
    const h = mountSidebar();
    const on = nodes(h.value).filter((n) => n.type === SessionListRow && n.props.on);
    expect(on.map((n) => n.props.session.id)).toEqual(['r2']);
    press('π', { metaKey: true, altKey: true, code: 'KeyP' });
    await Promise.resolve();
    expect(commands).toMatchObject([
      { type: 'session.pin', input: { session_id: 'r2', pinned: true } },
    ]);
  });

  it('asks to rename the focused row with ⌘⌥R, but not a baseline session', () => {
    const h = mountSidebar();
    const nav = find(h.value, (n) => n.type === 'nav');
    nav.props.onFocus({ target: { matches: () => true, dataset: { session: 'r1' } } });
    h.render();
    expect(press('®', { metaKey: true, altKey: true, code: 'KeyR' })).toHaveBeenCalled();
    expect(mock.shell.renaming).toBe('r1');
    mock.shell.renaming = null;
    LIST[2] = { ...LIST[2]!, workspace_id: null };
    try {
      nav.props.onFocus({ target: { matches: () => true, dataset: { session: 'i1' } } });
      h.render();
      press('®', { metaKey: true, altKey: true, code: 'KeyR' });
      expect(mock.shell.renaming).toBe(null);
    } finally {
      LIST[2] = { ...LIST[2]!, workspace_id: 'workspace-i1' };
    }
  });

  it('shows a recorded ⌘⌥R on the rename item of the session menu', () => {
    const rename = sessionMenu(session('r1', 'running', 1))
      .flat()
      .find((one) => one.label === zh('sessions.model.menu.rename'));
    expect(rename).toMatchObject({ keys: 'Meta+Alt+R' });
  });

  it('answers ⌘⌫ only on a focused row', () => {
    mountSidebar();
    expect(press('Backspace', { metaKey: true })).not.toHaveBeenCalled();
  });

  it('lists every list key in the registry', () => {
    const keys = SHORTCUTS.map((s) => s.keys);
    for (const k of [
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
      'Enter',
      'ArrowLeft',
      'ArrowRight',
      'Shift+F10',
      'Meta+1–9',
      'Control+Tab',
      'Control+Shift+Tab',
      'Meta+Backspace',
    ])
      expect(keys).toContain(k);
  });
});

describe('session row keys', () => {
  const mountRow = (listed: WorkbenchSession) =>
    mount(() => SessionListRow({ session: listed, on: false, now: 0, onSelect() {} }));
  const rowKey = (h: HookHost<any>, key: string, mods = {}) => {
    const e = event(key, mods);
    named(h.value, 'SessionRowButton').props.onKeyDown(e);
    h.render();
    return e.preventDefault.mock.calls.length > 0;
  };
  const menuOpen = (h: HookHost<any>) =>
    find(h.value, (n) => n.props.open !== undefined && n.props.onOpenChange && !n.props.title).props
      .open;

  it('opens the rename dialog of a row asked to rename that is not the shown session', () => {
    mock.shell.renaming = 'r1';
    const h = mountRow(session('r1', 'running', 1));
    expect(named(h.value, 'RenameDialog').props.sessionId).toBe('r1');
    expect(mock.shell.renaming).toBe(null);
  });

  it('leaves the rename of the shown session to the thread header', () => {
    mock.shell.renaming = 'r1';
    const h = mount(() =>
      SessionListRow({ session: session('r1', 'running', 1), on: true, now: 0, onSelect() {} }),
    );
    expect(() => named(h.value, 'RenameDialog')).toThrow();
    const header = mount(() =>
      SessionHeader({
        session: {
          id: 'r1',
          revision: 3,
          project_id: 'project-a',
          runtime: 'claude',
          state: 'open',
          turn_count: 1,
          workspace_id: 'workspace-r1',
        } as any,
        listed: session('r1', 'running', 1),
        title: 'title of r1',
        panels: [],
        onPanel() {},
        overview: true,
      }),
    );
    expect(find(header.value, (n) => n.type === 'input').props['aria-label']).toBe(
      zh('sessions.screen.sessionTitle'),
    );
    expect(mock.shell.renaming).toBe(null);
  });

  it('opens the row menu with Shift+F10', () => {
    const h = mountRow(session('r1', 'running', 1));
    expect(menuOpen(h)).toBe(false);
    expect(rowKey(h, 'F10', { shiftKey: true })).toBe(true);
    expect(menuOpen(h)).toBe(true);
  });

  it('asks to delete the focused row with ⌘⌫, unless delete is off', () => {
    const h = mountRow(session('d1', 'done', 1));
    expect(rowKey(h, 'Backspace', { metaKey: true })).toBe(true);
    expect(named(h.value, 'DeleteDialog').props.open).toBe(true);
    const merged = mountRow(session('m1', 'merged', 1));
    rowKey(merged, 'Backspace', { metaKey: true });
    expect(named(merged.value, 'DeleteDialog').props.open).toBe(false);
  });
});

describe('sidebar counts', () => {
  const tips = (h: HookHost<any>) =>
    nodes(h.value)
      .filter((n) => n.type === Tip)
      .map((n) => n.props.content);

  it('puts no state count tips under the project name', () => {
    for (const label of ['运行', '待处理', '待合并', '失败'])
      expect(tips(mountSidebar())).not.toContain(label);
  });
});

describe('idle session with news', () => {
  const inGroup = (h: HookHost<any>, key: string) =>
    nodes(h.value)
      .filter((n) => n.type === 'section' && n.props['aria-label'] === groupName(key))
      .flatMap((group) => nodes(group).filter((n) => n.type === SessionListRow))
      .map((n) => n.props.session.id);

  it('lists an unread idle session to review until it is opened', () => {
    const list = [session('news', 'idle', 1), session('w1', 'waiting', 1)];
    const h = mountSidebar([], list);
    expect(inGroup(h, 'ended')).toEqual([]);
    find(h.value, (n) => n.props['data-stop'] === 'group:ended').props.onClick();
    h.render();
    expect(inGroup(h, 'ended')).toEqual(['news']);
    markUnread('project-a', list[0]!);
    h.render();
    expect(inGroup(h, 'review')).toEqual(['news']);
    expect(inGroup(h, 'waiting')).toEqual(['w1']);
    expect(inGroup(h, 'ended')).toEqual([]);
    mock.shell.screen = 'sessions';
    mock.shell.sessionId = 'news';
    h.render();
    h.render();
    expect(inGroup(h, 'review')).toEqual([]);
    expect(inGroup(h, 'ended')).toEqual(['news']);
  });
});

describe('folded sidebar peek', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const folded = () => mountSidebar([], LIST, () => ({ collapsed: true, toggle: () => {} }));
  const aside = (h: HookHost<any>) => find(h.value, (n) => n.type === 'aside');
  const panel = (h: HookHost<any>) => nodes(h.value).find((n) => n.props.className === 'sb-peek');
  // A pointer target that sits on a rail icon, or inside the open panel.
  const onIcon = { closest: (selector: string) => (selector === '.ib' ? {} : null) };
  const inPanel = { closest: (selector: string) => (selector === '.sb-peek' ? {} : null) };
  const over = (h: HookHost<any>, target: object) =>
    aside(h).props.onPointerOver({ pointerType: 'mouse', target });
  const wait = (h: HookHost<any>, ms: number) => {
    vi.advanceTimersByTime(ms);
    h.render();
  };
  const opened = () => {
    const h = folded();
    over(h, onIcon);
    wait(h, 120);
    return h;
  };
  const railTips = (h: HookHost<any>) =>
    nodes(h.value).filter((n) => n.type === Tip && n.props.side === 'right');

  it('floats the open sidebar after a short hover on a rail icon, without the splitter', () => {
    const h = folded();
    over(h, onIcon);
    wait(h, 100);
    expect(panel(h)).toBeUndefined();
    wait(h, 20);
    const shown = panel(h)!;
    expect(shown.props.style).toEqual({ width: 280 });
    expect(nodes(shown).some((n) => n.type === 'nav')).toBe(true);
    // The ended group starts folded.
    expect(nodes(shown).filter((n) => n.type === SessionListRow).length).toBe(3);
    expect(nodes(shown).some((n) => n.type === Splitter)).toBe(false);
    expect(nodes(aside(h)).filter((n) => n.type === Splitter)).toHaveLength(1);
  });

  it('turns the rail tips off while the panel is open', () => {
    const h = folded();
    expect(railTips(h).length).toBeGreaterThan(0);
    expect(railTips(h).some((n) => n.props.disabled)).toBe(false);
    over(h, onIcon);
    wait(h, 120);
    expect(railTips(h).every((n) => n.props.disabled)).toBe(true);
  });

  it('opens on no hover that leaves the icon first', () => {
    const h = folded();
    over(h, onIcon);
    wait(h, 60);
    over(h, { closest: () => null });
    wait(h, 200);
    expect(panel(h)).toBeUndefined();
  });

  it('closes a while after the pointer leaves the rail and the panel', () => {
    const h = opened();
    over(h, inPanel);
    aside(h).props.onPointerLeave({});
    wait(h, 150);
    over(h, inPanel);
    wait(h, 200);
    expect(panel(h)!.props['data-ending-style']).toBeUndefined();
    aside(h).props.onPointerLeave({});
    wait(h, 200);
    const closing = panel(h)!;
    expect(closing.props['data-ending-style']).toBe('');
    closing.props.onTransitionEnd({ target: 1, currentTarget: 1, propertyName: 'opacity' });
    h.render();
    expect(panel(h)).toBeUndefined();
  });

  it('closes on Escape and after a pick, not after opening a fold or a menu', () => {
    const h = opened();
    press('Escape');
    h.render();
    expect(panel(h)!.props['data-ending-style']).toBe('');
    const click = (h: HookHost<any>, attribute: string | null) =>
      panel(h)!.props.onClick({
        target: { closest: () => ({ hasAttribute: (name: string) => name === attribute }) },
      });
    const g = opened();
    click(g, 'aria-expanded');
    click(g, 'aria-haspopup');
    g.render();
    expect(panel(g)!.props['data-ending-style']).toBeUndefined();
    click(g, null);
    g.render();
    expect(panel(g)!.props['data-ending-style']).toBe('');
  });
});
