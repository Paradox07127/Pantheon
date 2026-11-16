import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
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
import { DEFAULT_APPEARANCE, readAppearance, setAppearance } from '@/data/layout';
import { readInspector } from '@/screens/sessions/model';
import {
  SessionCard,
  SessionHeader,
  SessionInspector,
  SessionsScreen,
} from '@/screens/sessions/SessionsScreen';

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
const session = (id: string): Session => ({
  id,
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 0,
  workspace_id: `workspace-${id}`,
});

const list = {
  data: [listed('session-a'), listed('baseline', { workspace_id: null })],
  loading: false,
  error: null,
  reload() {},
};
const needs = { items: [], loading: false, error: null, reload() {} };

let stored: Map<string, string>;
const screen = (projectId: string | null = 'project-a') =>
  mount(() => SessionsScreen({ projectId, needs, list }));
const stubWidth = (innerWidth: number) => vi.stubGlobal('window', { ...window, innerWidth });
const column = (h: HookHost<any>) => nodes(h.value).find((n) => n.type === 'aside');
const floating = (h: HookHost<any>) =>
  nodes(h.value).find((n) => typeof n.type === 'function' && n.type.name === 'SessionCard');
const thread = (h: HookHost<any>) => named(h.value, 'Thread');
const inspector = (h: HookHost<any>) => named(h.value, 'SessionInspector');
const docked = (h: HookHost<any>) =>
  nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'SessionInspector');
const opened = (panels: string[] = ['changes']) =>
  stored.set('pantheon.inspector.session-a', JSON.stringify({ panels }));
const labelled = (tree: any, label: string) =>
  nodes(tree).find((n) => n.props['aria-label'] === label);

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
    openSettings() {},
    openSession() {},
    followFirstSession() {},
    follow() {},
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
  setAppearance(DEFAULT_APPEARANCE);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('inspector opening', () => {
  it('opens only on demand unless the appearance setting says otherwise', () => {
    expect(DEFAULT_APPEARANCE.inspector).toBe('never');
    expect(readAppearance(null).inspector).toBe('never');
    expect(readAppearance('{bad').inspector).toBe('never');
    expect(readAppearance(JSON.stringify({ inspector: 'auto' })).inspector).toBe('auto');
    expect(readAppearance(JSON.stringify({ inspector: 'always' })).inspector).toBe('always');
  });

  it('keeps the inspector of a wide window closed until it is asked for', () => {
    const h = screen();
    expect(docked(h)).toBe(false);
    thread(h).props.onPanel('changes');
    h.render();
    expect(docked(h)).toBe(true);
    expect(JSON.parse(stored.get('pantheon.inspector.session-a')!).panels).toEqual(['changes']);
  });
});

describe('overview panel', () => {
  it('docks at the right of the thread while no panel is open, at the width of its column', () => {
    const h = screen();
    expect(floating(h)!.props).toMatchObject({ sessionId: 'session-a' });
    expect(floating(h)!.props.listed.id).toBe('session-a');
    expect(nodes(column(h)).includes(floating(h)!)).toBe(true);
    expect(h.value.props.className).toBe('ss');
    expect(h.value.props.style['--ss-pw']).toBe('auto');
  });

  it('opens the panel a cell of the card asks for', () => {
    const h = screen();
    floating(h)!.props.onTab('checks');
    h.render();
    expect(column(h)).toBeTruthy();
    expect(inspector(h).props.panels).toEqual(['checks']);
    expect(JSON.parse(stored.get('pantheon.inspector.session-a')!)).toEqual({
      panels: ['checks'],
      recent: 'checks',
    });
    expect(floating(h)).toBeUndefined();
  });

  it('is not offered while the inspector is open', () => {
    opened();
    const h = screen();
    expect(floating(h)).toBeUndefined();
  });

  it('docks for a session without a worktree too', () => {
    mock.shell = { ...mock.shell, sessionId: 'baseline' };
    stored.set('pantheon.inspector.baseline', JSON.stringify({ panels: [] }));
    const h = screen();
    expect(floating(h)?.props.listed.id).toBe('baseline');
  });

  it('docks whatever the reading width, and only once asked as a sheet in a narrow window', () => {
    for (const reading of [760, 'none'] as const) {
      setAppearance({ reading_width: reading });
      stubWidth(1100);
      expect(nodes(column(screen())).some((n) => n.type === SessionCard)).toBe(true);
    }
    stubWidth(700);
    const narrow = screen();
    expect(floating(narrow)).toBeUndefined();
    thread(narrow).props.onOverview();
    narrow.render();
    floating(narrow)!.props.onTab('checks');
    narrow.render();
    expect(inspector(narrow).props.panels).toEqual(['checks']);
    expect(thread(narrow).props.panels).toEqual(['checks']);
    expect(floating(narrow)).toBeUndefined();
  });
});

describe('session card', () => {
  const card = (onTab = vi.fn(), row = listed('session-a')) =>
    mount(() =>
      SessionCard({ sessionId: 'session-a', listed: row, session: session('session-a'), onTab }),
    );

  it('holds the merge bar, the bar opening the checks tab', () => {
    const onTab = vi.fn();
    const h = card(onTab);
    expect(h.value!.props.className).toBe('ov-card');
    const bar = named(h.value, 'MergeBar');
    expect(find(h.value, (n) => n.props.className === 'ss-pf')).toBeTruthy();
    bar.props.onChecks();
    expect(onTab.mock.calls).toEqual([['checks']]);
    expect(bar.props).toMatchObject({ sessionId: 'session-a', revision: 1, live: true });
  });

  it('shows the merge block above the merge bar', () => {
    const h = card(
      vi.fn(),
      listed('session-a', {
        merge: { state: 'blocked', reason: 'rebase_conflict', conflicts: ['a.ts'] } as never,
      }),
    );
    const error = find(h.value, (n) => n.props.className === 'ss-cerr');
    expect(text(error)).toContain('和源分支冲突：a.ts');
  });

  it('shows a failed preflight read with a retry above the merge bar', async () => {
    const query = vi.fn(async (method: string) =>
      method === 'session.preflight'
        ? { ok: false, error: { code: 'command_timeout', message: 'preflight timed out' } }
        : { ok: true, value: [] },
    );
    vi.stubGlobal('window', { ...window, pantheon: { query } });
    const h = card();
    await h.flush();
    const all = nodes(h.value);
    const failed = find(h.value, (n) => n.props.role === 'alert');
    expect(text(failed)).toContain('preflight timed out');
    expect(all.indexOf(failed)).toBeLessThan(all.indexOf(named(h.value, 'MergeBar')));
    const reads = () => query.mock.calls.filter(([method]) => method === 'session.preflight');
    const before = reads().length;
    find(
      failed,
      (n) => n.type === 'button' && text(n) === zh('sessions.screen.retry'),
    ).props.onClick();
    await h.flush();
    expect(reads().length).toBe(before + 1);
  });

  it('waits for the worktree to be set up before reading the merge facts', async () => {
    const query = vi.fn(async (_method: string) => ({ ok: true, value: [] }));
    vi.stubGlobal('window', { ...window, pantheon: { query } });
    mock.board.board.workspaces = [
      { id: 'workspace-session-a', provisioning: { state: 'running', base_ref: 'main' } },
    ];
    const h = card();
    await h.flush();
    expect(query.mock.calls.filter(([method]) => method === 'session.preflight')).toEqual([]);
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
    expect(named(h.value, 'MergeBar').props.preflight).toBeNull();
  });

  it('names a worktree that could not be read in words, not by its code', async () => {
    const query = vi.fn(async (method: string) =>
      method === 'session.preflight'
        ? {
            ok: false,
            error: { code: 'workspace_read_failed', message: 'Worktree status could not be read' },
          }
        : { ok: true, value: [] },
    );
    vi.stubGlobal('window', { ...window, pantheon: { query } });
    const h = card();
    await h.flush();
    const failed = text(find(h.value, (n) => n.props.role === 'alert'));
    expect(failed).not.toContain('workspace_read_failed');
    expect(failed).toContain(zh('data.reason.workspaceReadFailed'));
  });
});

describe('session card button', () => {
  const header = (onOverview?: () => void) =>
    mount(() =>
      SessionHeader({
        session: session('session-a'),
        listed: listed('session-a'),
        title: 'title of session-a',
        panels: [],
        onPanel() {},
        overview: true,
        ...(onOverview ? { onOverview } : {}),
      }),
    );

  it('toggles the overview panel from a button right of the panel toggles, with no popup of its own', () => {
    const onOverview = vi.fn();
    const h = header(onOverview);
    const all = nodes(h.value);
    const toggle = labelled(h.value, zh('sessions.header.overview'))!;
    const panels = all.find((n) => n.props.role === 'toolbar')!;
    expect(all.indexOf(panels)).toBeLessThan(all.indexOf(toggle));
    expect(toggle.type).toBe('button');
    expect(toggle.props['aria-pressed']).toBe(true);
    toggle.props.onClick();
    expect(onOverview).toHaveBeenCalledOnce();
  });

  it('is absent without an overview to toggle', () => {
    expect(labelled(header().value, zh('sessions.header.overview'))).toBeUndefined();
  });
});

describe('docked panels', () => {
  it('has no maximize toggle, only a close button for each column', () => {
    const h = mount(() =>
      SessionInspector({
        sessionId: 'session-a',
        listed: listed('session-a'),
        session: session('session-a'),
        panels: ['changes'],
        onOpen() {},
        onClose() {},
        onView: () => {},
      }),
    );
    expect(labelled(h.value, '最大化详情')).toBeUndefined();
    expect(labelled(h.value, '关闭改动')).toBeTruthy();
  });

  it('sizes the dock to its columns, keeps the thread mounted and remembers the panels', () => {
    opened(['checks']);
    const h = screen();
    expect(h.value.props.className).toBe('ss');
    expect(h.value.props.style['--ss-pw']).toBe('340px');
    inspector(h).props.onOpen('plan');
    h.render();
    expect(h.value.props.style['--ss-pw']).toBe('680px');
    expect(thread(h)).toBeTruthy();
    expect(JSON.parse(stored.get('pantheon.inspector.session-a')!)).toEqual({
      panels: ['checks', 'plan'],
      recent: 'plan',
    });
    inspector(h).props.onClose('checks');
    h.render();
    inspector(h).props.onClose('plan');
    h.render();
    // The overview takes the place of the last panel to close.
    expect(docked(h)).toBe(false);
    expect(nodes(column(h)).some((n) => n.type === SessionCard)).toBe(true);
  });

  it('reads a stored maximized state as no panel open', () => {
    expect(readInspector(JSON.stringify({ open: true, max: true }))).toEqual({ panels: [] });
  });
});

describe('new session page', () => {
  it('has no second title over the new-session page, but keeps the bar without a project', () => {
    mock.shell = { ...mock.shell, sessionId: '' };
    const h = screen();
    expect(nodes(h.value).some((n) => n.props.className === 'ss-head')).toBe(false);
    expect(
      nodes(h.value).some((n) => text(n) === zh('sessions.composer.newSession') && n.type === 'h1'),
    ).toBe(false);
    expect(nodes(screen(null).value).some((n) => n.props.className === 'ss-head')).toBe(true);
  });
});

describe('session card styles', () => {
  const sheets: Record<string, string> = {
    '.ov-card': 'screens/sessions/overview.css',
  };
  /** The declarations of a top-level rule, without a space after each colon. */
  const rule = (selector: string) =>
    new RegExp(`^${selector.replace(/[.[\]()>]/g, '\\$&')} ?\\{([^}]*)\\}`, 'm')
      .exec(
        readFileSync(
          fileURLToPath(new URL(`../../apps/web/src/${sheets[selector]}`, import.meta.url)),
          'utf8',
        ),
      )![1]!
      .replace(/:\s+/g, ':');

  it.each([
    ['.ov-card', 'width', '280px'],
    ['.ov-card', 'background', 'var(--sf)'],
    ['.ov-card', 'border-left', 'var(--hair) solid var(--bd2)'],
    ['.ov-card', 'overflow-y', 'auto'],
  ])('%s sets %s to %s', (selector, property, value) => {
    expect(rule(selector)).toContain(`${property}:${value}`);
  });

  it('frames the card without a shadow', () => {
    expect(rule('.ov-card')).not.toContain('shadow');
  });
});
