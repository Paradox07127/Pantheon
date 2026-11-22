import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
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
import { DEFAULT_SESSION_DISPLAY, setSessionDisplay } from '@/data/session-display';
import { runShortcut } from '@/lib/shortcuts';
import { SessionHeader, SessionsScreen } from '@/screens/sessions/SessionsScreen';

let answers: Record<string, unknown>;
let bridge: Record<string, ReturnType<typeof vi.fn>>;
let stored: Map<string, string>;

beforeEach(() => {
  answers = {};
  mock.board = {
    board: {
      sessions: [],
      session_turns: [],
      projects: [],
      workspaces: [{ id: 'workspace-a', path: '/work/a', source: '/src/a' }],
      cursor: 1,
    },
    events: [],
    status: { state: 'live' },
    cursor: 1,
    resync: 0,
    refresh() {},
  };
  mock.shell = {
    sessionId: 'session-a',
    sessionGroup: null,
    sessionTab: null,
    sessionOpened: 1,
    followed: null,
    openSettings() {},
    openSession: vi.fn(),
    followFirstSession() {},
    follow() {},
  };
  const ok = async () => ({ ok: true, value: null });
  bridge = {
    command: vi.fn(async () => ({ ok: true, value: {} })),
    query: vi.fn(async (method: string) => ({ ok: true, value: answers[method] ?? null })),
    openInEditor: vi.fn(ok),
    openInTerminal: vi.fn(ok),
    revealPath: vi.fn(ok),
  };
  stored = new Map();
  vi.stubGlobal('window', {
    innerWidth: 1400,
    pantheon: bridge,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard: { writeText: vi.fn() } });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  setAppearance({ inspector: 'auto', reading_width: 760 });
});
afterEach(() => {
  unmountAll();
  setSessionDisplay(DEFAULT_SESSION_DISPLAY);
  vi.unstubAllGlobals();
});

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const session = (id: string): Session => ({
  id,
  revision: 4,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
});

type HeaderProps = Partial<Parameters<typeof SessionHeader>[0]>;
function header(props: HeaderProps = {}) {
  const row = props.listed ?? listed('session-a');
  return mount(() =>
    SessionHeader({
      session: session(row.id),
      listed: row,
      title: row.title,
      parent: null,
      plan: null,
      panels: [],
      onPanel: vi.fn(),
      overview: true,
      onOverview: vi.fn(),
      ...props,
    }),
  );
}

const labelled = (tree: ReactNode, label: string) =>
  nodes(tree).find((n) => n.props['aria-label'] === label);
const toolbar = (h: HookHost<any>) => find(h.value, (n) => n.props.role === 'toolbar');
const toggles = (h: HookHost<any>) =>
  nodes(toolbar(h)).filter((n) => n.type === 'button') as ReactElement<any>[];
const part = (h: HookHost<any>, name: string) => {
  const element = named(h.value, name);
  return mount(() => (element.type as (props: unknown) => ReactNode)(element.props));
};
const item = (h: HookHost<any>, label: string): ReactElement<any> =>
  find(
    h.value,
    (n) => typeof n.type !== 'string' && typeof n.props.onClick === 'function' && text(n) === label,
  );
const gates = {
  configured: true,
  running: false,
  last: {
    commit: 'abc',
    checked_at: 1,
    results: [
      { name: 'test', exit_code: 0, timed_out: false, output_tail: '' },
      { name: 'types', exit_code: 0, timed_out: false, output_tail: '' },
      { name: 'lint', exit_code: 1, timed_out: false, output_tail: '' },
    ],
  },
};

describe('session bar', () => {
  it('lays out state, source, title, branch, changes, checks, clock, panels, overview and more in order', async () => {
    answers['session.gates'] = gates;
    answers['project.facts.read'] = {
      workstreams: [],
      facts: { folders: [{ root: '/src/a', branch: 'main' }] },
    };
    const row = listed('session-ordered', {
      state: 'running',
      created_at: new Date(Date.now() - 5_000).toISOString(),
      forked_from: { session_id: 'session-lead' },
      changes: { files: 2, additions: 61, deletions: 19 },
    });
    const h = header({
      listed: row,
      parent: listed('session-lead', { title: 'Lead plan' }),
      plan: ['completed', 'in_progress', 'pending'],
    });
    await h.flush();
    const all = nodes(h.value);
    const at = (predicate: (n: ReactElement<any>) => boolean) => {
      const i = all.findIndex(predicate);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at((n) => typeof n.type === 'function' && n.type.name === 'SessionStateIcon'),
      at((n) => n.type === 'button' && text(n).includes('Lead plan')),
      at((n) => n.type === 'button' && n.props['aria-label'] === zh('sessions.screen.editTitle')),
      at((n) => typeof n.type === 'string' && text(n) === 'main'),
      at((n) => typeof n.type === 'function' && text(n) === '+61 −19'),
      at((n) => n.props.role === 'img' && n.props['aria-label'] === '检查通过 2 / 3'),
      at((n) => typeof n.type === 'function' && n.type.name === 'RunClock'),
      at((n) => n.props.role === 'toolbar'),
      at((n) => n.props['aria-label'] === zh('sessions.header.overview')),
      at((n) => typeof n.type === 'function' && n.type.name === 'MoreMenu'),
      at((n) => n.props.role === 'img' && /^计划/.test(n.props['aria-label'])),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text(part(h, 'RunClock').value)).toBe(zhf('data.elapsed.seconds', { seconds: 5 }));
    expect(labelled(h.value, '检查通过 2 / 3')).toBeTruthy();
    expect(text(h.value)).not.toContain(zh('components.sessionState.running'));
    expect(text(h.value)).not.toContain(zh('sessions.screen.details'));
  });

  it('gives each panel of the session one toggle, pressed for the open panels only', () => {
    const shut = header({ panels: [] });
    expect(toggles(shut).map((b) => b.props['aria-label'])).toEqual([
      zh('sessions.screen.tabChanges'),
      zh('sessions.screen.tabChecks'),
      zh('sessions.panel.dock.plan'),
      zh('sessions.panel.dock.trace'),
      zh('sessions.panel.dock.monitor'),
    ]);
    expect(toggles(shut).every((b) => b.props['aria-pressed'] === false)).toBe(true);
    const open = header({ panels: ['checks', 'plan', 'trace'] });
    expect(toggles(open).map((b) => b.props['aria-pressed'])).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    const off = (h: HookHost<any>) =>
      toggles(h)
        .filter((b) => b.props['aria-disabled'] === 'true')
        .map((b) => b.props['aria-label']);
    const inPlace = header({ listed: listed('session-a', { workspace_kind: 'in_place' }) });
    expect(off(inPlace)).toEqual([zh('sessions.screen.tabChecks')]);
    const baseline = header({ listed: listed('session-a', { workspace_id: null }) });
    expect(toggles(baseline).map((b) => b.props['aria-label'])).toEqual(
      toggles(shut).map((b) => b.props['aria-label']),
    );
    expect(off(baseline)).toEqual([
      zh('sessions.screen.tabChanges'),
      zh('sessions.screen.tabChecks'),
    ]);
  });

  it('toggles the panel of each pressed or unpressed toggle', () => {
    const onPanel = vi.fn();
    const h = header({ panels: ['changes'], onPanel });
    labelled(toolbar(h), zh('sessions.panel.dock.plan'))!.props.onClick();
    labelled(toolbar(h), zh('sessions.screen.tabChanges'))!.props.onClick();
    labelled(toolbar(h), zh('sessions.panel.dock.trace'))!.props.onClick();
    expect(onPanel.mock.calls).toEqual([['plan'], ['changes'], ['trace']]);
  });

  it('toggles the panel last opened or closed with the details shortcut', () => {
    const onPanel = vi.fn();
    const h = header({ panels: ['changes'], recent: 'plan', onPanel });
    runShortcut('details');
    h.unmount();
    const first = header({ panels: [], onPanel });
    runShortcut('details');
    first.unmount();
    expect(onPanel.mock.calls).toEqual([['plan'], ['changes']]);
  });

  it('presses the overview toggle while the overview shows', () => {
    const onOverview = vi.fn();
    const on = header({ overview: true, onOverview });
    expect(labelled(on.value, zh('sessions.header.overview'))!.props['aria-pressed']).toBe(true);
    labelled(on.value, zh('sessions.header.overview'))!.props.onClick();
    expect(onOverview).toHaveBeenCalledOnce();
    expect(
      labelled(header({ overview: false }).value, zh('sessions.header.overview'))!.props[
        'aria-pressed'
      ],
    ).toBe(false);
  });

  it('marks a main agent with a named glyph, and no other session', () => {
    const conductor = zh('sessions.conductor.name');
    const lead = header({ listed: listed('session-a', { conductor: true }) });
    expect(labelled(lead.value, conductor)?.props.role).toBe('img');
    expect(labelled(header().value, conductor)).toBeUndefined();
  });

  it('links the session it was forked from and opens it', () => {
    const h = header({
      listed: listed('session-a', { forked_from: { session_id: 'session-lead' } }),
      parent: listed('session-lead', { title: 'Lead plan' }),
    });
    const link = find(h.value, (n) => n.type === 'button' && text(n).includes('Lead plan'));
    expect(link.props['aria-label']).toBe(
      zhf('sessions.header.forkedFrom', { title: 'Lead plan' }),
    );
    link.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('session-lead');
  });

  it('links the session that spawned it as the one it was spawned by', () => {
    const h = header({
      listed: listed('session-a', { spawned_by: { session_id: 'session-lead' } }),
      parent: listed('session-lead', { title: 'Lead plan' }),
    });
    const link = find(h.value, (n) => n.type === 'button' && text(n).includes('Lead plan'));
    expect(link.props['aria-label']).toBe(zhf('sessions.header.spawnedBy', { title: 'Lead plan' }));
  });

  it('labels the plan strip with its steps, done steps and the current one', () => {
    const h = header({ plan: ['completed', 'completed', 'in_progress', 'pending'] });
    const strip = find(
      h.value,
      (n) => n.props.role === 'img' && /^计划/.test(n.props['aria-label']),
    );
    expect(strip.props['aria-label']).toBe('计划 4 步，完成 2 步，当前第 3 步');
    expect(nodes(strip).filter((n) => n.type === 'i')).toHaveLength(4);
  });

  it('leaves out the source, plan, checks and clock without their data', async () => {
    const h = header({
      listed: listed('session-bare', { forked_from: { session_id: 'session-gone' } }),
    });
    await h.flush();
    expect(nodes(h.value).some((n) => n.props.role === 'img')).toBe(false);
    expect(
      nodes(h.value).some(
        (n) =>
          n.props['aria-label'] === zhf('sessions.header.forkedFrom', { title: 'session-gone' }),
      ),
    ).toBe(false);
    expect(
      nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'RunClock'),
    ).toBe(false);
    expect(text(h.value)).not.toContain('/');
  });

  it('offers each way to open the worktree once in the more menu', async () => {
    const more = part(header(), 'MoreMenu');
    // The Open menu's own items open the worktree a second way; the more menu leaves them out.
    expect(
      nodes(more.value).some((n) => typeof n.type === 'function' && n.type.name === 'OpenItems'),
    ).toBe(false);
    const opens = (label: string) =>
      nodes(more.value).filter(
        (n) =>
          typeof n.type !== 'string' && typeof n.props.onClick === 'function' && text(n) === label,
      );
    for (const label of ['openInEditor', 'openInTerminal', 'copyPath'].map((key) =>
      zh(`sessions.screen.${key}`),
    ))
      expect(opens(label!)).toEqual([]);
    const openIn = find(more.value, (n) => n.props.label === zh('sessions.rowMenu.openIn'));
    for (const label of ['editor', 'terminal', 'finder'].map((key) =>
      zh(`sessions.rowMenu.${key}`),
    )) {
      expect(opens(label!)).toHaveLength(1);
      expect(nodes(openIn).includes(opens(label!)[0]!)).toBe(true);
      expect(opens(label!)[0]!.props.disabled).toBe(false);
    }
    opens(zh('sessions.rowMenu.editor')!)[0]!.props.onClick();
    await more.flush();
    expect(bridge.openInEditor).toHaveBeenCalledWith('workspace-a');
    for (const label of [zh('sessions.model.menu.pin'), zh('sessions.model.menu.archive')])
      expect(item(more, label!)).toBeTruthy();
  });
});

describe('remote pull in the session bar', () => {
  const at = '2026-11-14T00:00:00.000Z';
  const remote = (pull: WorkbenchSession['remote_pull']) =>
    header({ listed: listed('session-remote', { device_id: 'ws', remote_pull: pull }) });
  const pull = (h: HookHost<any>) =>
    nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'RemotePull')
      ? part(h, 'RemotePull')
      : null;
  const glyph = (h: HookHost<any>) => named(h.value, 'StateGlyph').props.name;
  const reconnect = (h: HookHost<any>) =>
    find(h.value, (n) => n.type === 'button' && text(n) === zh('sessions.header.reconnect'));

  it('shows the device chip of a remote session and no pull for a local one', () => {
    const h = remote({ status: 'not_needed', changed_at: at });
    const chip = find(h.value, (n) => typeof n.type === 'string' && text(n) === 'ws');
    expect(chip.props.className).toContain('chip mono');
    expect(pull(h)).toBeNull();
    const local = header({ listed: listed('session-local', { device_id: 'local' }) });
    expect(nodes(local.value).some((n) => text(n) === 'local')).toBe(false);
  });

  it('names a running, done and failed pull with its glyph, and offers reconnect on failure only', () => {
    const running = pull(remote({ status: 'running', changed_at: at }))!;
    expect(text(running.value)).toBe(zh('sessions.header.pullRunning'));
    expect(glyph(running)).toBe('starting');
    expect(nodes(running.value).some((n) => n.type === 'button')).toBe(false);
    const done = pull(remote({ status: 'done', changed_at: at }))!;
    expect(text(done.value)).toBe(zh('sessions.header.pullDone'));
    expect(glyph(done)).toBe('done');
    const failed = pull(remote({ status: 'failed', changed_at: at, reason: 'host unreachable' }))!;
    expect(text(failed.value)).toContain('改动还在 ws 上：host unreachable');
    expect(glyph(failed)).toBe('failed');
    expect(reconnect(failed)).toBeTruthy();
  });

  it('sends reconnect once, busy meanwhile, and shows why it failed', async () => {
    let answer!: (result: unknown) => void;
    bridge.command!.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const h = pull(remote({ status: 'failed', changed_at: at, reason: 'host unreachable' }))!;
    reconnect(h).props.onClick();
    await h.flush();
    expect(bridge.command).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.reconnect',
        input: { session_id: 'session-remote' },
      }),
    );
    expect(reconnect(h).props).toMatchObject({ 'aria-busy': true, disabled: true });
    answer({ ok: false, error: { code: 'remote_pull_failed', message: 'device offline' } });
    await h.flush();
    expect(reconnect(h).props).toMatchObject({ 'aria-busy': false, disabled: false });
    const alert = find(h.value, (n) => n.props.role === 'alert');
    expect(text(alert)).toBe('device offline');
    expect(bridge.command).toHaveBeenCalledTimes(1);
  });
});

describe('overview toggle', () => {
  const list = {
    data: [listed('session-a'), listed('baseline', { workspace_id: null })],
    loading: false,
    error: null,
    reload() {},
  };
  const needs = { items: [], loading: false, error: null, reload() {} };
  const screen = () => mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  const floating = (h: HookHost<any>) =>
    nodes(h.value).find((n) => typeof n.type === 'function' && n.type.name === 'SessionCard');
  const thread = (h: HookHost<any>) => named(h.value, 'Thread');
  const dock = (h: HookHost<any>) =>
    nodes(h.value).find(
      (n) => n.type === 'aside' && n.props['aria-label'] === zh('sessions.header.panels'),
    );

  it('docks the overview at the right of the thread like a panel', () => {
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: [] }));
    const h = screen();
    expect(nodes(dock(h)).includes(floating(h)!)).toBe(true);
    thread(h).props.onOverview();
    h.render();
    expect(dock(h)).toBeUndefined();
  });

  it('opens the overview over the thread in a narrow window only once asked', () => {
    vi.stubGlobal('window', { ...window, innerWidth: 700 });
    const h = screen();
    const sheet = () => labelled(h.value, zh('sessions.screen.details'))!;
    const root = () => nodes(h.value).find((n) => nodes(n).includes(sheet()) && 'open' in n.props)!;
    expect(thread(h).props.overview).toBe(false);
    expect(root().props.open).toBe(false);
    expect(floating(h)).toBeUndefined();
    thread(h).props.onOverview();
    h.render();
    expect(thread(h).props.overview).toBe(true);
    expect(root().props.open).toBe(true);
    expect(nodes(sheet()).includes(floating(h)!)).toBe(true);
    expect(dock(h)).toBeUndefined();
    root().props.onOpenChange(false);
    h.render();
    expect(thread(h).props.overview).toBe(false);
    expect(JSON.parse(stored.get('pantheon.inspector.session-a')!).overview).toBe(false);
  });

  it('hides and shows the docked overview and remembers the choice', () => {
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: [] }));
    const h = screen();
    expect(floating(h)).toBeTruthy();
    expect(thread(h).props.overview).toBe(true);
    thread(h).props.onOverview();
    h.render();
    expect(floating(h)).toBeUndefined();
    expect(thread(h).props.overview).toBe(false);
    expect(JSON.parse(stored.get('pantheon.inspector.session-a')!)).toEqual({
      panels: [],
      overview: false,
    });
    expect(floating(screen())).toBeUndefined();
    thread(h).props.onOverview();
    h.render();
    expect(floating(h)).toBeTruthy();
  });

  it('keeps the overview hidden while the panel opens and closes', () => {
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: [], overview: false }));
    const h = screen();
    thread(h).props.onPanel('checks');
    h.render();
    expect(thread(h).props.panels).toEqual(['checks']);
    expect(floating(h)).toBeUndefined();
    thread(h).props.onPanel('checks');
    h.render();
    expect(floating(h)).toBeUndefined();
    expect(JSON.parse(stored.get('pantheon.inspector.session-a')!).overview).toBe(false);
  });

  it('docks the trace panel when its toggle is pressed, in place of the overview', () => {
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: [] }));
    const h = screen();
    thread(h).props.onPanel('trace');
    h.render();
    expect(thread(h).props.panels).toEqual(['trace']);
    expect(named(dock(h), 'SessionInspector').props.panels).toEqual(['trace']);
    expect(floating(h)).toBeUndefined();
    thread(h).props.onPanel('trace');
    h.render();
    expect(thread(h).props.panels).toEqual([]);
  });

  it('shows the trace panel in the sheet over the thread in a narrow window', () => {
    vi.stubGlobal('window', { ...window, innerWidth: 700 });
    const h = screen();
    thread(h).props.onPanel('trace');
    h.render();
    const sheet = labelled(h.value, zh('sessions.screen.details'))!;
    expect(named(sheet, 'SessionInspector').props.panels).toEqual(['trace']);
    expect(dock(h)).toBeUndefined();
  });

  it('offers the overview toggle and card for a session without a worktree', () => {
    mock.shell = { ...mock.shell, sessionId: 'baseline' };
    stored.set('pantheon.inspector.baseline', JSON.stringify({ panels: [] }));
    const h = screen();
    expect(thread(h).props.onOverview).toBeDefined();
    expect(floating(h)).toBeTruthy();
  });

  it('passes the listed session it was forked from to the thread', () => {
    const led = {
      ...list,
      data: [
        listed('session-a', { forked_from: { session_id: 'session-lead' } }),
        listed('session-lead'),
      ],
    };
    const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list: led }));
    expect(thread(h).props.parent.id).toBe('session-lead');
  });

  it('starts hidden when the overview is off, unless the session was shown it', () => {
    setSessionDisplay({ overview: 'off' });
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: [] }));
    const h = screen();
    expect(floating(h)).toBeUndefined();
    expect(thread(h).props.overview).toBe(false);
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: [], overview: true }));
    expect(floating(screen())).toBeTruthy();
  });
});

describe('session bar display settings', () => {
  const strip = (h: HookHost<any>) =>
    nodes(h.value).find((n) => n.props.role === 'img' && /^计划/.test(n.props['aria-label']));
  const tokens = (h: HookHost<any>) =>
    nodes(h.value).find((n) => typeof n.type === 'function' && n.type.name === 'LiveTokens');

  it('leaves the plan strip out when its switch is off', () => {
    const plan = ['completed', 'in_progress'] as const;
    expect(strip(header({ plan }))).toBeTruthy();
    setSessionDisplay({ plan_bar: false });
    expect(strip(header({ plan }))).toBeUndefined();
  });

  it('leaves the token row of the more menu out when context and usage are off', () => {
    expect(tokens(header())).toBeTruthy();
    setSessionDisplay({ context_usage: false });
    expect(tokens(header())).toBeUndefined();
  });
});
