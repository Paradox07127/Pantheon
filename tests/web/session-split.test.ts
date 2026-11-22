import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, HookHost, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
import { useCurrentProject } from '@/data/current-project';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

const shell = () => useShell.getState();

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T08:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'codex',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T08:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  useCurrentProject.setState({ projectId: 'project-a' });
  useShell.setState({
    screen: 'sessions',
    sessionId: 'session-a',
    followed: null,
    splitId: null,
    splitPane: 'left',
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the second session in the store', () => {
  it('opens beside the shown session as the current pane, and closes again', () => {
    shell().openSplit('session-b');
    expect(shell()).toMatchObject({
      sessionId: 'session-a',
      splitId: 'session-b',
      splitPane: 'right',
    });
    shell().focusPane('left');
    expect(shell().splitPane).toBe('left');
    shell().closeSplit('right');
    expect(shell()).toMatchObject({ sessionId: 'session-a', splitId: null, splitPane: 'left' });
  });

  it('keeps the followed session on the left when none was chosen', () => {
    useShell.setState({ sessionId: null, followed: 'session-c' });
    shell().openSplit('session-b');
    expect(shell()).toMatchObject({ sessionId: 'session-c', splitId: 'session-b' });
  });

  it('makes the right session the only one when the left pane closes', () => {
    shell().openSplit('session-b');
    shell().closeSplit('left');
    expect(shell()).toMatchObject({ sessionId: 'session-b', splitId: null, splitPane: 'left' });
  });

  it('never shows one session in both panes', () => {
    shell().openSplit('session-a');
    expect(shell().splitId).toBeNull();
    shell().openSplit('session-b');
    shell().openSession('session-b');
    expect(shell()).toMatchObject({ sessionId: 'session-b', splitId: null });
  });

  it('clears on a switch to another project', () => {
    shell().openSplit('session-b');
    shell().openProject('project-a');
    expect(shell().splitId).toBe('session-b');
    shell().openProject('project-b');
    expect(shell()).toMatchObject({ splitId: null, splitPane: 'left' });
  });

  it('is not stored with the project place', () => {
    shell().openSplit('session-b');
    expect([...stored.values()].join('')).not.toContain('session-b');
  });
});

type Listener = (e: KeyboardEvent) => void;
let keys: Listener[] = [];
let command: ReturnType<typeof vi.fn>;
const press = (key: string, mods: Partial<KeyboardEvent> = {}) => {
  const preventDefault = vi.fn();
  const e = { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  for (const listener of [...keys]) listener({ ...e, ...mods, preventDefault } as any);
  return preventDefault;
};
const session = (id: string, extra: object = {}) => ({
  id,
  revision: 3,
  project_id: 'project-a',
  runtime: 'codex',
  state: 'open',
  turn_count: 0,
  workspace_id: `workspace-${id}`,
  ...extra,
});
const list = (data: WorkbenchSession[]) => ({ data, loading: false, error: null, reload() {} });
const needs = { items: [], loading: false, error: null, reload() {} } as any;
const three = list([listed('session-a'), listed('session-b'), listed('session-c')]);

function stubWindow(innerWidth = 1600) {
  keys = [];
  command = vi.fn(async () => ({ ok: true, value: null }));
  vi.stubGlobal('window', {
    innerWidth,
    innerHeight: 900,
    pantheon: { command, query: vi.fn(async () => ({ ok: true, value: [] })) },
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && keys.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') keys = keys.filter((k) => k !== fn);
    },
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', { activeElement: null });
}

const { SessionsScreen } = await import('@/screens/sessions/SessionsScreen');
const { Thread } = await import('@/screens/sessions/Thread');
const { useThreadFind } = await import('@/screens/sessions/ThreadFind');
const { useDrafts } = await import('@/data/drafts');

const screen = (data = three) =>
  mount(() => SessionsScreen({ projectId: 'project-a', needs, list: data }));
const panes = (h: HookHost<any>) => nodes(h.value).filter((n) => n.type === 'section');
const threads = (h: HookHost<any>) => nodes(h.value).filter((n) => n.type === Thread);
const button = (tree: any, label: string) =>
  find(tree, (n) => n.type === 'button' && n.props['aria-label'] === label);
const draw = (el: any) => mount(() => el.type(el.props));

describe('two sessions side by side', () => {
  beforeEach(() => {
    stubWindow();
    useDrafts.setState({ drafts: {}, answers: {} });
    mock.board = {
      board: {
        cursor: 1,
        projects: [],
        workspaces: [],
        sessions: [session('session-a'), session('session-b')],
        session_turns: [],
      },
      events: [],
      resync: 0,
      status: { state: 'live' },
      refresh() {},
    };
    shell().openSplit('session-b');
  });
  afterEach(() => {
    unmountAll();
    useThreadFind.getState().close();
  });

  it('shows each session in a pane of its own with its head and no inspector or card', () => {
    const h = screen();
    expect(panes(h).map((p) => p.props['aria-label'])).toEqual([
      'title of session-a',
      'title of session-b',
    ]);
    expect(threads(h).map((t) => [t.props.sessionId, t.props.active])).toEqual([
      ['session-a', false],
      ['session-b', true],
    ]);
    expect(threads(h).every((t) => t.props.head)).toBe(true);
    expect(nodes(h.value).some((n) => n.type === 'aside')).toBe(false);
    expect(
      nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'SessionCard'),
    ).toBe(false);
  });

  it("keeps the shown session's thread in the same place when the second pane opens or closes", () => {
    // React keeps a component only while the same type and key stay at the same place.
    const place = (h: HookHost<any>) => {
      const main = find(h.value, (n) => n.type === 'main');
      const slots = [main.props.children].flat();
      const slot = slots.findIndex((s) =>
        nodes(s).some((n) => n.type === Thread && n.props.sessionId === 'session-a'),
      );
      const pane = slots[slot];
      return { slot, type: pane?.type, key: pane?.key, thread: pane?.props.children?.key };
    };
    const beside = place(screen());
    shell().closeSplit('right');
    expect(place(screen())).toEqual(beside);
    expect(beside).toEqual({ slot: 0, type: 'section', key: 'session-a', thread: 'session-a' });
  });

  it('marks the pane clicked or typed in as the current one', () => {
    const h = screen();
    panes(h)[0]!.props.onPointerDown();
    expect(shell().splitPane).toBe('left');
    panes(h)[1]!.props.onFocus();
    expect(shell().splitPane).toBe('right');
  });

  it('closes a pane from the close button in its head', () => {
    let h = screen();
    button(draw(threads(h)[1]!.props.head).value, zh('sessions.split.close')).props.onClick();
    expect(shell()).toMatchObject({ sessionId: 'session-a', splitId: null });
    shell().openSplit('session-b');
    h = screen();
    button(draw(threads(h)[0]!.props.head).value, zh('sessions.split.close')).props.onClick();
    expect(shell()).toMatchObject({ sessionId: 'session-b', splitId: null });
  });

  it('marks a main agent in its pane head, and no other session', () => {
    const conductor = zh('sessions.conductor.name');
    const h = screen(list([listed('session-a'), listed('session-b', { conductor: true })]));
    const mark = (pane: number) =>
      nodes(draw(threads(h)[pane]!.props.head).value).find(
        (n) => n.props['aria-label'] === conductor,
      );
    expect(mark(1)?.props.role).toBe('img');
    expect(mark(0)).toBeUndefined();
  });

  it("puts the terminal toggle in the current pane's head and shows its session's terminal under both", () => {
    const terminals = (h: HookHost<any>) =>
      nodes(h.value).filter((n) => typeof n.type === 'function' && n.type.name === 'TerminalPanel');
    const toggle = (h: HookHost<any>, pane: number) =>
      nodes(draw(threads(h)[pane]!.props.head).value).find(
        (n) => n.type === 'button' && n.props['aria-label'] === zh('sessions.terminal.title'),
      );
    const h = screen();
    expect(toggle(h, 0)).toBeUndefined();
    expect(toggle(h, 1)!.props['aria-pressed']).toBe(false);
    expect(terminals(h)).toEqual([]);
    toggle(h, 1)!.props.onClick();
    h.render();
    expect(toggle(h, 1)!.props['aria-pressed']).toBe(true);
    expect(terminals(h).map((n) => n.props.sessionId)).toEqual(['session-b']);
    expect(h.value.props.className).toContain('ss-tm');
    expect(h.value.props.style['--ss-th']).toBe('240px');
    shell().focusPane('left');
    h.render();
    expect(toggle(h, 1)).toBeUndefined();
    expect(toggle(h, 0)!.props['aria-pressed']).toBe(true);
    expect(terminals(h).map((n) => n.props.sessionId)).toEqual(['session-a']);
  });

  it("sends each pane's message to its own session", async () => {
    const h = screen();
    for (const [i, id] of [
      [0, 'session-a'],
      [1, 'session-b'],
    ] as const) {
      const pane = mount(() => Thread(threads(h)[i]!.props));
      expect(nodes(pane.value).some((n) => (n.type as any)?.name === 'SessionHeader')).toBe(false);
      const box = draw(named(pane.value, 'SessionCompose'));
      find(box.value, (n) => n.type === 'textarea').props.onChange({
        target: { value: `to ${id}` },
      });
      box.render();
      find(box.value, (n) => n.type === 'textarea').props.onKeyDown({
        key: 'Enter',
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        nativeEvent: { isComposing: false },
        preventDefault() {},
      });
      await box.flush();
    }
    expect(command.mock.calls.map(([c]) => [c.type, c.input.session_id, c.input.input])).toEqual([
      ['session.send', 'session-a', 'to session-a'],
      ['session.send', 'session-b', 'to session-b'],
    ]);
  });

  it('searches only in the current pane', () => {
    const h = screen();
    threads(h).forEach((t) => mount(() => Thread(t.props)));
    press('f', { metaKey: true });
    expect(useThreadFind.getState().sessionId).toBe('session-b');
  });

  it('keeps the sessions that show read, and not one that a narrow window hides', async () => {
    const { seenRecords } = await import('@/data/unread');
    vi.stubGlobal('document', {
      activeElement: null,
      visibilityState: 'visible',
      hasFocus: () => true,
    });
    const before = '2026-11-03T08:00:00.000Z';
    const after = '2026-11-03T09:00:00.000Z';
    const active = list([
      listed('session-a', { last_activity_at: after }),
      listed('session-b', { last_activity_at: after }),
    ]);
    const seen = (projectId: string) => {
      stored.set(
        `pantheon.unread.${projectId}`,
        JSON.stringify({
          'session-a': { seen_at: before, manual_unread: false },
          'session-b': { seen_at: before, manual_unread: false },
        }),
      );
      mount(() => SessionsScreen({ projectId, needs, list: active }));
      const records = seenRecords(projectId)!;
      return [records['session-a']!.seen_at, records['session-b']!.seen_at];
    };
    expect(seen('project-both-panes')).toEqual([after, after]);
    stubWindow(900);
    vi.stubGlobal('document', {
      activeElement: null,
      visibilityState: 'visible',
      hasFocus: () => true,
    });
    expect(seen('project-right-pane')).toEqual([before, after]);
  });

  it("opens the rename dialog from the shown session's pane head on a rename request", () => {
    const h = screen();
    useShell.setState({ renaming: 'session-a' });
    const left = draw(threads(h)[0]!.props.head);
    expect(shell().renaming).toBeNull();
    expect(nodes(left.value).some((n) => (n.type as any)?.name === 'RenameDialog')).toBe(true);
    // The row of the session beside takes its own rename requests.
    useShell.setState({ renaming: 'session-b' });
    draw(threads(h)[1]!.props.head);
    expect(shell().renaming).toBe('session-b');
    useShell.setState({ renaming: null });
  });

  it('closes the pane of a session discarded from its head', async () => {
    const { DiscardDialog } = await import('@/screens/sessions/parts');
    const h = screen();
    const head = draw(threads(h)[1]!.props.head);
    const more = draw(named(head.value, 'MoreMenu'));
    const dialog = [...nodes(head.value), ...nodes(more.value)].find(
      (n) => n.type === DiscardDialog,
    )!;
    dialog.props.onDiscarded();
    expect(shell()).toMatchObject({ sessionId: 'session-a', splitId: null });
  });

  it("interrupts only the current pane's turn", async () => {
    const { Sidebar } = await import('@/components/Sidebar');
    const running = list([
      listed('session-a', { state: 'running' }),
      listed('session-b', { state: 'running' }),
    ]);
    mount(() =>
      Sidebar({
        layout: { collapsed: false, width: 264, resize() {}, commit() {}, reset() {}, toggle() {} },
        projects: [{ id: 'project-a', name: 'Project A' }],
        currentProjectId: 'project-a',
        onChooseProject() {},
        list: running,
        allNeeds: { items: [] },
      } as any),
    );
    press('.', { metaKey: true });
    shell().focusPane('left');
    press('.', { metaKey: true });
    expect(command.mock.calls.map(([c]) => [c.type, c.input.session_id])).toEqual([
      ['session.interrupt', 'session-b'],
      ['session.interrupt', 'session-a'],
    ]);
  });

  const sidebar = async (projectId: string, data = three) => {
    const { Sidebar } = await import('@/components/Sidebar');
    return mount(() =>
      Sidebar({
        layout: { collapsed: false, width: 264, resize() {}, commit() {}, reset() {}, toggle() {} },
        projects: [{ id: projectId, name: 'Project A' }],
        currentProjectId: projectId,
        onChooseProject() {},
        list: data,
        allNeeds: { items: [] },
      } as any),
    );
  };

  it('keeps the left session read from the sidebar only while a narrow window shows its pane', async () => {
    const { seenRecords } = await import('@/data/unread');
    const { setSplitRoom } = await import('@/screens/sessions/shared');
    vi.stubGlobal('document', {
      activeElement: null,
      visibilityState: 'visible',
      hasFocus: () => true,
    });
    const before = '2026-11-03T08:00:00.000Z';
    const after = '2026-11-03T09:00:00.000Z';
    const active = list([
      listed('session-a', { last_activity_at: after }),
      listed('session-b', { last_activity_at: after }),
    ]);
    const leftSeen = async (projectId: string) => {
      stored.set(
        `pantheon.unread.${projectId}`,
        JSON.stringify({
          'session-a': { seen_at: before, manual_unread: false },
          'session-b': { seen_at: before, manual_unread: false },
        }),
      );
      await sidebar(projectId, active);
      return seenRecords(projectId)!['session-a']!.seen_at;
    };
    try {
      setSplitRoom(false);
      expect(await leftSeen('project-sidebar-right-pane')).toBe(before);
      shell().focusPane('left');
      expect(await leftSeen('project-sidebar-left-pane')).toBe(after);
      shell().focusPane('right');
      setSplitRoom(true);
      expect(await leftSeen('project-sidebar-both-panes')).toBe(after);
    } finally {
      setSplitRoom(true);
    }
  });

  it('tells those who read the room for two sessions when a resize changes it', async () => {
    const { setSplitRoom, subscribeSplitRoom, useSplitRoom } =
      await import('@/screens/sessions/shared');
    const seen: boolean[] = [];
    const stop = subscribeSplitRoom(() => seen.push(useSplitRoom()));
    try {
      setSplitRoom(false);
      setSplitRoom(false);
      setSplitRoom(true);
      expect(seen).toEqual([false, true]);
    } finally {
      stop();
      setSplitRoom(true);
    }
  });

  it("renames the current pane's session on the rename key", async () => {
    await sidebar('project-a');
    press('F2');
    expect(shell().renaming).toBe('session-b');
    shell().focusPane('left');
    press('F2');
    expect(shell().renaming).toBe('session-a');
    useShell.setState({ renaming: null });
  });
});

const { sessionMenu } = await import('@/screens/sessions/model');
const { SessionListRow } = await import('@/screens/sessions/SessionRow');
const { MoreMenu } = await import('@/screens/sessions/SessionHeader');
const { MenuItem } = await import('@/components/Menu');

const labels = (tree: any) =>
  nodes(tree)
    .filter((n) => typeof n.type !== 'string' && typeof n.props.onClick === 'function')
    .map((n) => text(nodes(n.props.children).find((c) => c.props.className === 'mn-tx') ?? n));
const entry = (tree: any, label: string) =>
  nodes(tree).find(
    (n) =>
      typeof n.type !== 'string' &&
      typeof n.props.onClick === 'function' &&
      text(nodes(n.props.children).find((c) => c.props.className === 'mn-tx') ?? n) === label,
  )!;
const picks = (h: HookHost<any>) => nodes(h.value).filter((n) => n.type === MenuItem);
const threadIn = (h: HookHost<any>) => mount(() => Thread(threads(h)[0]!.props));

describe('ways to open a session beside', () => {
  beforeEach(() => {
    mock.board = {
      board: {
        cursor: 1,
        projects: [],
        workspaces: [],
        sessions: [session('session-a'), session('session-b'), session('session-c')],
        session_turns: [],
      },
      events: [],
      resync: 0,
      status: { state: 'live' },
      refresh() {},
    };
  });
  afterEach(() => unmountAll());

  it('lists opening beside under opening in a new window, with its ⌥ click', () => {
    const [open] = sessionMenu(listed('session-b'), { newWindow: true, beside: {} });
    expect(open!.map((one) => one.label)).toEqual([
      zh('sessions.rowMenu.open'),
      zh('sessions.rowMenu.openWindow'),
      zh('sessions.split.openBeside'),
    ]);
    expect(open![2]).toMatchObject({ command: 'session.open_beside', click: 'Alt' });
    expect(sessionMenu(listed('session-b'))[0]!.map((one) => one.label)).toEqual([
      zh('sessions.rowMenu.open'),
    ]);
  });

  it('opens a row beside the shown session from its menu or an ⌥ click, but not the shown ones', () => {
    stubWindow();
    const row = (id: string) =>
      mount(() => SessionListRow({ session: listed(id), on: false, now: 0, onSelect() {} }));
    expect(labels(row('session-a').value)).not.toContain(zh('sessions.split.openBeside'));
    entry(row('session-b').value, zh('sessions.split.openBeside')).props.onClick();
    expect(shell()).toMatchObject({ sessionId: 'session-a', splitId: 'session-b' });
    expect(labels(row('session-b').value)).not.toContain(zh('sessions.split.openBeside'));
    named(row('session-c').value, 'SessionRowButton').props.onSelect({
      altKey: true,
      metaKey: false,
    });
    expect(shell().splitId).toBe('session-c');
  });

  it("picks the second session from the session bar's menu, listing this project's open sessions", () => {
    stubWindow();
    const data = list([
      listed('session-a'),
      listed('session-b'),
      listed('session-c', { archived_at: '2026-11-04T08:00:00.000Z' }),
    ]);
    const h = screen(data);
    const bar = named(threadIn(h).value, 'SessionHeader');
    const more = named(draw(bar).value, 'MoreMenu');
    const item = entry(draw(more).value, zh('sessions.split.openSession'));
    expect(item.props.keys).toBe('Meta+\\');
    item.props.onClick();
    h.render();
    expect(picks(h).map((n) => text(n.props.children))).toEqual(['title of session-b']);
    picks(h)[0]!.props.onClick();
    expect(shell()).toMatchObject({ sessionId: 'session-a', splitId: 'session-b' });
  });

  it('opens the picker on ⌘\\ and closes the second pane on it again', () => {
    stubWindow();
    const h = screen();
    expect(picks(h)).toEqual([]);
    press('\\', { metaKey: true });
    h.render();
    expect(picks(h).map((n) => text(n.props.children))).toEqual([
      'title of session-b',
      'title of session-c',
    ]);
    shell().openSplit('session-b');
    h.render();
    press('\\', { metaKey: true });
    expect(shell().splitId).toBeNull();
  });

  it('offers no second pane without room for two, and shows only the current one there', () => {
    stubWindow(900);
    let h = screen();
    press('\\', { metaKey: true });
    h.render();
    expect(picks(h)).toEqual([]);
    const bar = named(threadIn(h).value, 'SessionHeader');
    const more = named(draw(bar).value, 'MoreMenu');
    const tip = nodes(draw(more).value).find(
      (n) => n.props.content === zh('sessions.split.noRoom'),
    );
    expect(tip).toBeTruthy();
    const [open] = sessionMenu(listed('session-b'), { beside: { reason: 'narrow' } });
    expect(open![1]).toMatchObject({ reason: 'narrow' });
    shell().openSplit('session-b');
    h = screen();
    expect(panes(h).map((p) => p.props['aria-label'])).toEqual(['title of session-b']);
    stubWindow(1600);
    h = screen();
    expect(panes(h)).toHaveLength(2);
  });
});

describe('a project with no session', () => {
  beforeEach(() => {
    stubWindow();
    mock.board = {
      board: { cursor: 1, projects: [], workspaces: [], sessions: [], session_turns: [] },
      events: [],
      resync: 0,
      status: { state: 'live' },
      refresh() {},
    };
    useShell.setState({ sessionId: null, splitId: null });
  });
  afterEach(() => unmountAll());

  it('stays on the project page with the new-session box in it, also once a new session is asked for', async () => {
    const { NewSession } = await import('@/screens/sessions/NewSession');
    const page = () => {
      const h = screen(list([]));
      return find(h.value, (n) => n.type === NewSession);
    };
    expect(page().props.onClose).toBeUndefined();
    shell().startNewSession();
    expect(page().props.onClose).toBeUndefined();
  });

  it('shows no empty state when every session sits in a folded group, the box still in the page', async () => {
    const { NewSession } = await import('@/screens/sessions/NewSession');
    const { EmptyState } = await import('@/components/EmptyState');
    const h = screen(list([listed('session-a')]));
    expect(nodes(h.value).some((n) => n.type === EmptyState)).toBe(false);
    expect(nodes(h.value).some((n) => n.type === NewSession)).toBe(true);
  });

  it('starts a new session in the page of a project with sessions and closes back to the one before', async () => {
    const { NewSession } = await import('@/screens/sessions/NewSession');
    shell().openSession('session-a');
    shell().startNewSession();
    const h = screen();
    const composer = find(h.value, (n) => n.type === NewSession);
    composer.props.onClose();
    expect(shell().sessionId).toBe('session-a');
  });
});
