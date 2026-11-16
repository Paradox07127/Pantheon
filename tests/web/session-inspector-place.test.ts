import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { type HookHost, find, mount, named, nodes, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
vi.mock('@/data/feedback', async (actual) => ({
  ...(await actual<object>()),
  useFeedback: (selector: any) => selector({ items: {} }),
}));
import { setAppearance } from '@/data/layout';
import { t } from '@/i18n';
import { SessionInspector, SessionsScreen } from '@/screens/sessions/SessionsScreen';

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T08:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'fixture',
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

const list = {
  data: [listed('session-a'), listed('session-b'), listed('baseline', { workspace_id: null })],
  loading: false,
  error: null,
  reload() {},
};
const needs = { items: [], loading: false, error: null, reload() {} };

let stored: Map<string, string>;
const screen = () => mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
const show = (h: HookHost<any>, sessionId: string) => {
  mock.shell = { ...mock.shell, sessionId, sessionOpened: mock.shell.sessionOpened + 1 };
  h.render();
};
const inspector = (h: HookHost<any>) => named(h.value, 'SessionInspector');
// The dock also holds the session overview; only a dock showing the inspector is a panel column.
const column = (h: HookHost<any>) =>
  nodes(h.value).find(
    (n) => n.type === 'aside' && nodes(n.props.children).some((c) => c.type === SessionInspector),
  );
const sheet = (h: HookHost<any>) =>
  nodes(h.value).find((n) => typeof n.props.onOpenChange === 'function');
const popup = (h: HookHost<any>) =>
  find(h.value, (n) => n.props['aria-label'] === zh('sessions.screen.details'));

beforeEach(() => {
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    cursor: 0,
    resync: 0,
  };
  mock.shell = {
    sessionId: 'session-a',
    sessionGroup: null,
    sessionTab: null,
    sessionOpened: 1,
    followed: null,
    openSettings() {},
    openSession() {},
    followFirstSession() {},
    follow(followed: string | null) {
      mock.shell = { ...mock.shell, followed };
    },
  };
  stored = new Map();
  vi.stubGlobal('window', {
    innerWidth: 1400,
    pantheon: { query: vi.fn(async () => ({ ok: true, value: [] })) },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  // These cases test the open state, so a wide window opens the inspector by itself.
  setAppearance({ inspector: 'auto' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('panel open state', () => {
  it('toggles with the panel toggle and closes with its close button', () => {
    const h = screen();
    expect(column(h)).toBeTruthy();
    expect(named(h.value, 'Thread').props.panels).toEqual(['changes']);
    named(h.value, 'Thread').props.onPanel('changes');
    h.render();
    expect(column(h)).toBeUndefined();
    expect(named(h.value, 'Thread').props.panels).toEqual([]);
    named(h.value, 'Thread').props.onPanel('changes');
    h.render();
    expect(column(h)).toBeTruthy();
    inspector(h).props.onClose('changes');
    h.render();
    expect(column(h)).toBeUndefined();
  });

  it('marks the conversation as beside the dock only while the dock shows', () => {
    const conversation = (h: HookHost<any>) =>
      find(h.value, (n) => n.props['aria-label'] === zh('sessions.screen.conversation'));
    const dock = (h: HookHost<any>) =>
      nodes(h.value).find((n) => n.props['aria-label'] === zh('sessions.header.panels'));
    const h = screen();
    expect(column(h)).toBeTruthy();
    expect(conversation(h).props['data-docked']).toBe('');
    named(h.value, 'Thread').props.onPanel('changes');
    h.render();
    // The overview takes the panels' place in the dock.
    expect(named(dock(h)!, 'SessionCard')).toBeTruthy();
    expect(conversation(h).props['data-docked']).toBe('');
    named(h.value, 'Thread').props.onOverview();
    h.render();
    expect(dock(h)).toBeUndefined();
    expect(conversation(h).props['data-docked']).toBeUndefined();
  });

  it('wires the close button of each column', () => {
    const onClose = vi.fn();
    const session: Session = {
      id: 'session-a',
      revision: 1,
      project_id: 'project-a',
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
    };
    const h = mount(() =>
      SessionInspector({
        sessionId: 'session-a',
        listed: listed('session-a'),
        session,
        panels: ['changes'],
        onOpen() {},
        onClose,
        onView: () => {},
      }),
    );
    const close = t(
      { id: 'sessions.screen.closePanel', defaultMessage: 'Close {panel}' },
      { panel: zh('sessions.screen.tabChanges') },
    );
    find(h.value, (n) => n.type === 'button' && n.props['aria-label'] === close).props.onClick();
    expect(onClose).toHaveBeenCalledExactlyOnceWith('changes');
  });

  it('switches the changes column between its diff, its change story and its review', () => {
    const onView = vi.fn();
    const session: Session = {
      id: 'session-a',
      revision: 1,
      project_id: 'project-a',
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
    };
    let view: 'diff' | 'review' | 'story' = 'diff';
    const h = mount(() =>
      SessionInspector({
        sessionId: 'session-a',
        listed: listed('session-a'),
        session,
        panels: ['changes'],
        view,
        onOpen() {},
        onClose() {},
        onView,
      }),
    );
    const pressed = (key: string) =>
      find(
        h.value,
        (n) =>
          n.type === 'button' &&
          [n.props.children].flat().includes(zh(`sessions.panel.dock.${key}`)),
      );
    pressed('explain').props.onClick();
    pressed('review').props.onClick();
    view = 'story';
    h.render();
    expect(pressed('explain').props['aria-pressed']).toBe(true);
    pressed('explain').props.onClick();
    view = 'review';
    h.render();
    expect(pressed('review').props['aria-pressed']).toBe(true);
    pressed('review').props.onClick();
    expect(onView.mock.calls).toEqual([['story'], ['review'], ['diff'], ['diff']]);
  });

  it('offers the plan panel of a baseline session and opens it by itself', () => {
    const h = screen();
    show(h, 'baseline');
    expect(named(h.value, 'Thread').props.onPanel).toBeTypeOf('function');
    expect(inspector(h).props.panels).toEqual(['plan']);
  });

  it('keeps two panels open side by side and toggles each from the header', () => {
    const h = screen();
    const thread = () => named(h.value, 'Thread');
    thread().props.onPanel('plan');
    h.render();
    expect(inspector(h).props.panels).toEqual(['changes', 'plan']);
    expect(thread().props.panels).toEqual(['changes', 'plan']);
    thread().props.onPanel('changes');
    h.render();
    expect(inspector(h).props.panels).toEqual(['plan']);
    expect(thread().props.recent).toBe('changes');
  });
});

describe('panel memory', () => {
  it('remembers the open panels of each session', () => {
    const h = screen();
    inspector(h).props.onOpen('checks');
    h.render();
    show(h, 'session-b');
    expect(inspector(h).props.panels).toEqual(['changes']);
    inspector(h).props.onOpen('plan');
    h.render();
    inspector(h).props.onClose('changes');
    h.render();
    inspector(h).props.onClose('plan');
    h.render();
    expect(column(h)).toBeUndefined();
    show(h, 'session-a');
    expect(column(h)).toBeTruthy();
    expect(inspector(h).props.panels).toEqual(['changes', 'checks']);
    show(h, 'session-b');
    expect(column(h)).toBeUndefined();

    expect(JSON.parse(stored.get('pantheon.inspector.session-a')!)).toEqual({
      panels: ['changes', 'checks'],
      recent: 'checks',
    });
    expect(JSON.parse(stored.get('pantheon.inspector.session-b')!)).toEqual({
      panels: [],
      recent: 'plan',
    });
    mock.shell = { ...mock.shell, sessionId: 'session-a' };
    expect(inspector(screen()).props.panels).toEqual(['changes', 'checks']);
  });

  it('opens the panel a navigation asks for, the change story and the review in the changes panel', () => {
    const h = screen();
    mock.shell = { ...mock.shell, sessionTab: 'story', sessionOpened: 2 };
    h.render();
    expect(inspector(h).props.panels).toEqual(['changes']);
    expect(inspector(h).props.view).toBe('story');
    inspector(h).props.onView('diff');
    h.render();
    expect(inspector(h).props.view).toBe('diff');
    expect(JSON.parse(stored.get('pantheon.inspector.session-a')!).view).toBe('diff');
  });

  it('adds the panel a navigation asks for beside the open ones', () => {
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: ['changes'] }));
    const h = screen();
    mock.shell = { ...mock.shell, sessionTab: 'checks', sessionOpened: 2 };
    h.render();
    expect(inspector(h).props.panels).toEqual(['changes', 'checks']);
    stored.set('pantheon.inspector.session-b', JSON.stringify({ panels: [] }));
    mock.shell = { ...mock.shell, sessionId: 'session-b', sessionTab: 'review', sessionOpened: 3 };
    h.render();
    expect(inspector(h).props.panels).toEqual(['changes']);
    expect(inspector(h).props.view).toBe('review');
  });

  it('shows the panel a navigation asks for when only one fits, and makes it the details target', () => {
    vi.stubGlobal('window', { ...window, innerWidth: 1000 });
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: ['changes', 'checks'] }));
    const h = screen();
    expect(inspector(h).props.panels).toEqual(['checks']);
    mock.shell = { ...mock.shell, sessionTab: 'review', sessionOpened: 2 };
    h.render();
    expect(inspector(h).props.panels).toEqual(['changes']);
    expect(inspector(h).props.view).toBe('review');
    expect(named(h.value, 'Thread').props.recent).toBe('changes');
  });

  it('shows the panel a navigation asks for in the sheet of a narrow window', () => {
    vi.stubGlobal('window', { ...window, innerWidth: 700 });
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: ['changes', 'checks'] }));
    const h = screen();
    mock.shell = { ...mock.shell, sessionTab: 'changes', sessionOpened: 2 };
    h.render();
    expect(sheet(h)!.props.open).toBe(true);
    expect(inspector(h).props.panels).toEqual(['changes']);
  });

  it('leaves two sessions side by side for the panel a navigation asks for in the left one', () => {
    const closeSplit = vi.fn(() => {
      mock.shell = { ...mock.shell, splitId: null, splitPane: 'left' };
    });
    mock.shell = { ...mock.shell, splitId: 'session-b', splitPane: 'left', closeSplit };
    const h = screen();
    expect(nodes(h.value).filter((n) => n.props.className === 'sp-pane')).toHaveLength(2);
    mock.shell = { ...mock.shell, sessionTab: 'changes', sessionOpened: 2 };
    h.render();
    expect(closeSplit).toHaveBeenCalledExactlyOnceWith('right');
    h.render();
    expect(inspector(h).props.panels).toEqual(['changes']);
  });

  it('still works when the storage cannot be used', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const h = screen();
    inspector(h).props.onOpen('plan');
    h.render();
    expect(inspector(h).props.panels).toEqual(['changes', 'plan']);
  });
});

describe('followed session', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  const follow = (data: WorkbenchSession[]) => {
    mock.shell = { ...mock.shell, sessionId: null };
    const shown = { ...list, data };
    const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list: shown }));
    return { h, shown };
  };
  const thread = (h: HookHost<any>) => named(h.value, 'Thread').props.sessionId;

  const running = (id: string, minute: number) =>
    listed(id, { state: 'running', last_activity_at: at(minute) });
  it.each([
    [
      'keeps the shown session when another one becomes more recent',
      [running('session-a', 5), running('session-b', 9)],
      'session-a',
    ],
    [
      'keeps the shown session after it settles',
      [listed('session-a', { last_activity_at: at(5) }), running('session-b', 1)],
      'session-a',
    ],
    [
      'moves to the first open session once the shown one is archived',
      [
        listed('session-a', { archived_at: at(6), last_activity_at: at(5) }),
        running('session-b', 1),
      ],
      'session-b',
    ],
  ])('%s', (_name, next, shownId) => {
    const { h, shown } = follow([running('session-a', 5), running('session-b', 1)]);
    expect(thread(h)).toBe('session-a');
    shown.data = next;
    h.render();
    expect(thread(h)).toBe(shownId);
    expect(mock.shell.followed).toBe(shownId);
  });
});

describe('narrow window', () => {
  it('slides the inspector in over the thread instead of a column', () => {
    vi.stubGlobal('window', { ...window, innerWidth: 700 });
    const h = screen();
    expect(column(h)).toBeUndefined();
    expect(sheet(h)!.props.open).toBe(false);
    named(h.value, 'Thread').props.onPanel('changes');
    h.render();
    expect(sheet(h)!.props.open).toBe(true);
    expect(named(popup(h), 'SessionInspector').props.sessionId).toBe('session-a');
    expect(column(h)).toBeUndefined();
    sheet(h)!.props.onOpenChange(false);
    h.render();
    expect(sheet(h)!.props.open).toBe(false);
  });

  it('dims the backdrop of the sheet with a dark scrim in the dark theme', () => {
    vi.stubGlobal('window', { ...window, innerWidth: 700 });
    const h = screen();
    const scrim = find(h.value, (n) => String(n.props.className).includes('scrim'));
    expect(scrim.props.className).toBe('pj-scrim');
    const css = readFileSync(
      fileURLToPath(new URL('../../apps/web/src/index.css', import.meta.url)),
      'utf8',
    );
    expect(css).toMatch(
      /^\.pj-scrim\{[^}]*background:color-mix\(in srgb,var\(--bg\) \d+%,transparent\)/m,
    );
  });

  it('puts a dialog scrim over the sheet and the sheet over its own scrim', () => {
    vi.stubGlobal('window', { ...window, innerWidth: 700 });
    const h = screen();
    const scrim = find(h.value, (n) => String(n.props.className).includes('scrim'));
    const css = ['index.css', 'screens/sessions/panel.css']
      .map((file) =>
        readFileSync(fileURLToPath(new URL(`../../apps/web/src/${file}`, import.meta.url)), 'utf8'),
      )
      .join('\n');
    const z = (selector: string) =>
      Number(
        new RegExp(`^${selector.replace(/\./g, '\\.')}\\s*\\{[^}]*z-index:\\s*(\\d+)`, 'm').exec(
          css,
        )?.[1],
      );
    // Inline, so that the order of the stylesheets cannot lift it over the sheet.
    expect(scrim.props.style?.zIndex).toBeLessThan(z('.ss-sheet'));
    expect(z('.ss-sheet')).toBeLessThan(z('.pj-scrim'));
    expect(z('.pj-scrim')).toBeLessThan(z('.pj-dlg'));
  });

  it('focuses the sheet itself as it opens, not its close button', () => {
    vi.stubGlobal('window', { ...window, innerWidth: 700 });
    const h = screen();
    const sheetPopup = popup(h);
    expect(sheetPopup.props.initialFocus).toBeDefined();
    expect(sheetPopup.props.initialFocus).toBe(sheetPopup.props.ref);
  });

  it('keeps the sheet no wider than the room the window has', () => {
    stored.set('pantheon.panel-widths', JSON.stringify({ changes: 900 }));
    vi.stubGlobal('window', { ...window, innerWidth: 700 });
    const h = screen();
    named(h.value, 'Thread').props.onPanel('changes');
    h.render();
    expect(popup(h).props.style.width).toBeLessThanOrEqual(700);
  });

  it('tells the inspector it is a sheet only in a narrow window', () => {
    expect(inspector(screen()).props.sheet).toBe(false);
    vi.stubGlobal('window', { ...window, innerWidth: 700 });
    expect(inspector(screen()).props.sheet).toBe(true);
  });
});
