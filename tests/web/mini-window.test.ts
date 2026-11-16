import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BridgeResult, WorkbenchSession } from '@pantheon/protocol';
import type { NeedsYouItem } from '@/data/needs-you';
import { zh } from './i18n-setup.js';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any, shell: { theme: 'light' } as any }));
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
  resolveTheme: (theme: string, dark: boolean) =>
    theme === 'system' ? (dark ? 'dark' : 'light') : theme,
}));
import { SessionStateIcon, StateGlyph } from '@/components/SessionStateIcon';
import { MiniWindow, miniWindowPaletteItem, useMiniWindowPaletteItems } from '@/shell/MiniWindow';

const NOW = Date.parse('2026-11-13T10:42:00.000Z');
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

function approval(id: string, over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    source: { table: 'approvals', id, revision: 3 },
    kind: 'permission',
    project_id: 'alpha',
    session_id: 'session-a',
    status: 'pending',
    created_at: NOW - 5 * MINUTE,
    reason: 'permission_requested',
    actions: [{ command: 'approval.respond', allowed: true }],
    binding: { action: 'Bash', input_summary: 'pnpm db:migrate --env staging' },
    ...over,
  };
}

const question: NeedsYouItem = {
  source: { table: 'board_plans', id: 'lead-1', revision: 1 },
  kind: 'lead.question',
  project_id: 'beta',
  session_id: 'lead-1',
  request_id: 'q-1',
  status: 'pending',
  created_at: NOW - 40 * MINUTE,
  reason: 'lead_question',
  actions: [],
};

function listed(id: string, over: Partial<WorkbenchSession> = {}): WorkbenchSession {
  return {
    id,
    created_at: '2026-11-13T09:00:00.000Z',
    title: id,
    runtime: 'claude',
    model: null,
    effort: null,
    permission_mode: 'ask',
    workspace_id: `ws-${id}`,
    workspace_kind: 'linked_worktree',
    state: 'idle',
    waiting: 0,
    reconciling: false,
    stopping: false,
    last_activity_at: ago(30),
    changes: null,
    merge: null,
    ...over,
  };
}

let needs: NeedsYouItem[];
let lists: Record<string, WorkbenchSession[]>;
let bridge: Record<string, any>;
let frames: (() => void)[];

const ok = (value: unknown): BridgeResult<unknown> => ({ ok: true, value });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval'] });
  needs = [];
  lists = { alpha: [], beta: [] };
  frames = [];
  mock.board = {
    board: {
      cursor: 1,
      projects: [
        { id: 'alpha', name: 'Payments', roots: ['/work/alpha'] },
        { id: 'beta', name: 'Refunds', roots: ['/work/beta'] },
      ],
      sessions: [{ id: 'session-a', project_id: 'alpha', title: 'Callback signatures' }],
      session_turns: [],
      workspaces: [],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    start: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(),
  };
  bridge = {
    query: vi.fn(async (method: string, params?: Record<string, string>) => {
      if (method === 'needs_you.list') return ok({ items: needs });
      if (method === 'session.list') return ok(lists[params!.project_id!] ?? []);
      return { ok: false, error: { code: 'unknown_route', message: method } };
    }),
    command: vi.fn(async () => ok(null)),
    revealMain: vi.fn(async () => {}),
    showInMainWindow: vi.fn(async () => ok(null)),
    setMiniWindow: vi.fn(async () => ok(null)),
    miniWindowShown: vi.fn(async () => ok(true)),
    ready: vi.fn(),
  };
  vi.stubGlobal('window', {
    pantheon: bridge,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal('document', {
    documentElement: { classList: { toggle: vi.fn() } },
    hasFocus: () => true,
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function bar() {
  const h = mount(() => MiniWindow());
  await h.flush();
  await h.flush();
  return h;
}

const buttons = (tree: ReactElement) => nodes(tree).filter((n) => n.type === 'button');
const button = (tree: ReactElement, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n.props.children).includes(label));
const expandButton = (tree: ReactElement) =>
  find(tree, (n) => n.type === 'button' && n.props['aria-label'] === zh('shell.miniWindow.expand'));
const title = (tree: ReactElement) => text(find(tree, (n) => n.props.className === 'mw-nm'));
const has = (tree: ReactElement, className: string) =>
  nodes(tree).some((n) => n.props.className === className);

describe('mini window picks one thing to show', () => {
  it('shows the longest-waiting request it can answer in place, with allow and deny', async () => {
    needs = [
      approval('ap-new', { created_at: NOW - 2 * MINUTE, session_id: 'session-n' }),
      approval('ap-old', { created_at: NOW - 18 * MINUTE }),
      approval('ap-locked', {
        created_at: NOW - 30 * MINUTE,
        actions: [{ command: 'approval.respond', allowed: false }],
      }),
      approval('ap-asks', { created_at: NOW - 31 * MINUTE, questions: [{} as never] }),
      question,
    ];
    lists = { alpha: [listed('session-r', { state: 'running', last_activity_at: ago(1) })] };
    const tree = (await bar()).value;
    expect(title(tree)).toBe('Callback signatures');
    expect(find(tree, (n) => n.type === StateGlyph).props.name).toBe('approval');
    expect(buttons(tree).map((n) => text(n.props.children) || n.props['aria-label'])).toEqual([
      zh('shell.miniWindow.allow'),
      zh('shell.miniWindow.deny'),
      zh('shell.miniWindow.expand'),
    ]);
    expect(has(tree, 'mw-wait')).toBe(false);
  });

  it('shows the running session with the newest activity and how many wait for you', async () => {
    needs = [question, approval('ap-locked', { actions: [] })];
    lists = {
      alpha: [listed('session-old', { state: 'running', last_activity_at: ago(12) })],
      beta: [
        listed('session-new', {
          title: 'Idempotent refunds',
          state: 'running',
          last_activity_at: ago(2),
        }),
        listed('session-idle', { last_activity_at: ago(1) }),
      ],
    };
    const tree = (await bar()).value;
    expect(title(tree)).toBe('Idempotent refunds');
    expect(find(tree, (n) => n.type === SessionStateIcon).props.session.id).toBe('session-new');
    expect(has(tree, 'mw-state')).toBe(false);
    const waiting = find(tree, (n) => n.props.className === 'mw-wait');
    expect(text(waiting)).toBe('2');
    expect(waiting.props['aria-label']).toBe('2 个等你');
    expect(has(tree, 'mw-sep')).toBe(true);
    expandButton(tree).props.onClick();
    expect(bridge.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'beta',
      session_id: 'session-new',
    });
  });

  it('counts a held external request among those waiting, as the tray does', async () => {
    needs = [question, approval('ext-1', { reason: 'external_approval', actions: [] })];
    lists = { alpha: [listed('session-r', { state: 'running', last_activity_at: ago(1) })] };
    const tree = (await bar()).value;
    expect(text(find(tree, (n) => n.props.className === 'mw-wait'))).toBe('2');
  });

  it('shows the session with the newest activity and its state, and no count when nothing waits', async () => {
    lists = {
      alpha: [
        listed('session-x', { title: 'Export CSV', last_activity_at: ago(3) }),
        listed('session-z', { title: 'Archived', last_activity_at: ago(1), archived_at: ago(1) }),
      ],
      beta: [listed('session-y', { title: 'Refund list', last_activity_at: ago(9) })],
    };
    const tree = (await bar()).value;
    expect(title(tree)).toBe('Export CSV');
    expect(text(find(tree, (n) => n.props.className === 'mw-state'))).toBe(
      zh('components.sessionState.idle'),
    );
    expect(has(tree, 'mw-wait')).toBe(false);
    expect(has(tree, 'mw-sep')).toBe(false);
    expandButton(tree).props.onClick();
    expect(bridge.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'alpha',
      session_id: 'session-x',
    });
  });

  it('shows only the project name and expand without any session', async () => {
    const tree = (await bar()).value;
    expect(title(tree)).toBe('Payments');
    expect(buttons(tree)).toHaveLength(1);
    expandButton(tree).props.onClick();
    expect(bridge.showInMainWindow).toHaveBeenCalledWith({ project_id: 'alpha' });
  });
});

describe('mini window actions', () => {
  it('allows the request and moves on to what comes next', async () => {
    needs = [approval('ap-1', { created_at: NOW - 9 * MINUTE }), approval('ap-2')];
    const h = await bar();
    button(h.value, zh('shell.miniWindow.allow')).props.onClick();
    await h.flush();
    expect(bridge.command).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approval.respond',
        input: { approval_id: 'ap-1', decision: 'approve' },
        expected_revision: 3,
      }),
    );
    button(h.value, zh('shell.miniWindow.deny')).props.onClick();
    await h.flush();
    expect(bridge.command).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'approval.respond',
        input: { approval_id: 'ap-2', decision: 'reject' },
      }),
    );
    expect(title(h.value)).toBe('Payments');
  });

  it('says in the bar why an answer failed', async () => {
    needs = [approval('ap-1')];
    bridge.command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'approval_not_pending', message: 'gone' },
    });
    const h = await bar();
    expect(has(h.value, 'mw-err')).toBe(false);
    button(h.value, zh('shell.miniWindow.deny')).props.onClick();
    await h.flush();
    const alert = find(h.value, (n) => n.props.role === 'alert');
    expect(alert.props.className).toBe('mw-err');
    expect(text(alert)).toContain(zh('data.reason.approvalNotPending'));
    expect(title(h.value)).toBe('Callback signatures');
  });

  it('shows what the request would run beside allow, or the tool when it has no input', async () => {
    needs = [approval('ap-1')];
    const h = await bar();
    expect(text(find(h.value, (n) => n.props.className === 'mw-cmd'))).toBe(
      'pnpm db:migrate --env staging',
    );
    needs = [approval('ap-2', { binding: { action: 'WebFetch' } })];
    mock.board = { ...mock.board, resync: 1 };
    h.render();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.className === 'mw-cmd'))).toBe('WebFetch');
  });

  it('says in the bar why allow and deny are off after the list fails to read again', async () => {
    needs = [approval('ap-1')];
    const h = await bar();
    expect(has(h.value, 'mw-err')).toBe(false);
    bridge.query.mockImplementation(async (method: string) =>
      method === 'needs_you.list'
        ? { ok: false, error: { code: 'ipc_failed', message: 'pipe closed' } }
        : ok([]),
    );
    mock.board = { ...mock.board, resync: 1 };
    h.render();
    await h.flush();
    expect(button(h.value, zh('shell.miniWindow.allow')).props.disabled).toBe(true);
    const alert = find(h.value, (n) => n.props.role === 'alert');
    expect(alert.props.className).toBe('mw-err');
    expect(text(alert)).toContain('pipe closed');

    bridge.query.mockImplementation(async (method: string) =>
      method === 'needs_you.list' ? ok({ items: needs }) : ok([]),
    );
    button(h.value, zh('shell.miniWindow.retry')).props.onClick();
    await h.flush();
    await h.flush();
    expect(has(h.value, 'mw-err')).toBe(false);
    expect(button(h.value, zh('shell.miniWindow.allow')).props.disabled).toBe(false);
  });

  it('says why the list could not be read with a retry, and shows the request once it reads', async () => {
    needs = [approval('ap-1')];
    bridge.query.mockImplementation(async (method: string) =>
      method === 'needs_you.list'
        ? { ok: false, error: { code: 'ipc_failed', message: 'pipe closed' } }
        : ok([]),
    );
    const h = await bar();
    expect(title(h.value)).toBe('Payments');
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain('pipe closed');

    bridge.query.mockImplementation(async (method: string) =>
      method === 'needs_you.list' ? ok({ items: needs }) : ok([]),
    );
    button(h.value, zh('shell.miniWindow.retry')).props.onClick();
    await h.flush();
    await h.flush();
    expect(has(h.value, 'mw-err')).toBe(false);
    expect(title(h.value)).toBe('Callback signatures');
    expect(button(h.value, zh('shell.miniWindow.allow')).props.disabled).toBe(false);
  });

  it('opens the request in the main window and stays open', async () => {
    needs = [approval('ap-1')];
    const tree = (await bar()).value;
    expandButton(tree).props.onClick();
    expect(bridge.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'alpha',
      session_id: 'session-a',
    });
    expect(bridge.setMiniWindow).not.toHaveBeenCalled();
    expect(bridge.revealMain).not.toHaveBeenCalled();
  });

  it('tells the desktop shell once its first content is painted', async () => {
    await bar();
    expect(bridge.ready).not.toHaveBeenCalled();
    frames.splice(0).forEach((run) => run());
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.ready).toHaveBeenCalledTimes(1);
  });
});

describe('mini window palette command', () => {
  it('shows or hides the mini window as it is now', async () => {
    const show = miniWindowPaletteItem(false);
    expect([show.label, show.group]).toEqual([zh('shell.miniWindow.show'), 'action']);
    show.run();
    expect(bridge.setMiniWindow).toHaveBeenLastCalledWith(true);
    const hide = miniWindowPaletteItem(true);
    expect(hide.label).toBe(zh('shell.miniWindow.hide'));
    hide.run();
    expect(bridge.setMiniWindow).toHaveBeenLastCalledWith(false);
  });

  it('reads whether it shows when the palette opens, and offers nothing outside the desktop app', async () => {
    let open = false;
    const h = mount(() => useMiniWindowPaletteItems(open));
    await h.flush();
    expect(h.value).toEqual([]);
    expect(bridge.miniWindowShown).not.toHaveBeenCalled();
    open = true;
    h.render();
    await h.flush();
    expect(bridge.miniWindowShown).toHaveBeenCalledTimes(1);
    expect(h.value.map((item) => item.label)).toEqual([zh('shell.miniWindow.hide')]);

    vi.stubGlobal('window', {});
    const browser = mount(() => useMiniWindowPaletteItems(true));
    await browser.flush();
    expect(browser.value).toEqual([]);
  });
});
