import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BridgeResult, RuntimeStatus, WorkbenchSession } from '@pantheon/protocol';
import type { NeedsYouItem } from '@/data/needs-you';
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
import { TrayPopover, useProjectSessions } from '@/shell/TrayPopover';
import { zh } from './i18n-setup.js';

const WAITING = zh('trayPopover.waiting.title');

const NOW = Date.parse('2026-11-13T10:42:00.000Z');
const MINUTE = 60_000;

function approval(id: string, over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    source: { table: 'approvals', id, revision: 3 },
    kind: 'permission',
    project_id: 'alpha',
    session_id: 'session-a',
    status: 'pending',
    created_at: NOW - 18 * MINUTE,
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
  created_at: NOW - 6 * MINUTE,
  reason: 'lead_question',
  actions: [],
};

const workflowApproval: NeedsYouItem = {
  source: { table: 'workflow_step_runs', id: 'step-1', revision: 1 },
  kind: 'workflow.approval',
  project_id: 'alpha',
  session_id: 'session-a',
  status: 'waiting',
  created_at: NOW - 2 * MINUTE,
  reason: 'workflow_approval',
  step_title: 'Deploy to staging',
  actions: [],
};

const heldRequest: NeedsYouItem = {
  source: { table: 'board_plans', id: 'lead-2', revision: 1 },
  kind: 'external.approval',
  project_id: 'beta',
  session_id: 'lead-2',
  request_id: 'github:acme/docs#3',
  status: 'pending',
  created_at: NOW - 3 * MINUTE,
  reason: 'external_approval',
  actions: [],
};

const failedSession: NeedsYouItem = {
  source: { table: 'sessions', id: 'session-b', revision: 1 },
  kind: 'session.failed',
  project_id: 'alpha',
  status: 'failed',
  created_at: NOW - MINUTE,
  reason: 'session_failed',
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
    last_activity_at: '2026-11-13T09:00:00.000Z',
    changes: null,
    merge: null,
    ...over,
  };
}

const status = (over: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({
    runtime: 'claude',
    enabled: true,
    installed: true,
    auth: { state: 'logged_in' },
    ...over,
  }) as RuntimeStatus;

let needs: NeedsYouItem[];
let lists: Record<string, WorkbenchSession[]>;
let statuses: RuntimeStatus[];
let bridge: Record<string, any>;
let observers: { callback: () => void; target: unknown; disconnected: boolean }[];
let frames: (() => void)[];

const ok = (value: unknown): BridgeResult<unknown> => ({ ok: true, value });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval'] });
  needs = [];
  lists = { alpha: [], beta: [] };
  statuses = [status()];
  observers = [];
  frames = [];
  mock.board = {
    board: {
      cursor: 1,
      projects: [
        { id: 'alpha', name: 'Payments', roots: ['/work/alpha'] },
        { id: 'beta', name: 'Refunds', roots: ['/work/beta'] },
      ],
      sessions: [
        { id: 'session-a', project_id: 'alpha', title: 'Callback signatures', state: 'open' },
        { id: 'lead-1', project_id: 'beta', title: 'lead', state: 'running' },
        { id: 'session-c', project_id: 'beta', title: 'Idempotent refunds', state: 'running' },
      ],
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
      if (method === 'runtime.status') return ok(statuses);
      return { ok: false, error: { code: 'unknown_route', message: method } };
    }),
    command: vi.fn(async () => ok(null)),
    setPopoverHeight: vi.fn(async () => {}),
    revealMain: vi.fn(async () => {}),
    showInMainWindow: vi.fn(async () => ok(null)),
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      entry: { callback: () => void; target: unknown; disconnected: boolean };
      constructor(callback: () => void) {
        this.entry = { callback, target: null, disconnected: false };
        observers.push(this.entry);
      }
      observe(target: unknown) {
        this.entry.target = target;
        this.entry.callback();
      }
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function popover() {
  const h = mount(() => TrayPopover());
  await h.flush();
  await h.flush();
  return h;
}

/** The group headed by title: its count and its rows' text. */
function group(tree: ReactElement, title: string) {
  const section = find(
    tree,
    (n) =>
      n.type === 'section' &&
      nodes(n.props.children).some(
        (h) => h.type === 'h2' && text(h.props.children).startsWith(title),
      ),
  );
  const head = find(section, (n) => n.type === 'h2');
  return {
    section,
    count: text(find(head, (n) => n.props.className === 'tp-n')),
  };
}
const hasGroup = (tree: ReactElement, title: string) => {
  try {
    group(tree, title);
    return true;
  } catch {
    return false;
  }
};
const button = (tree: ReactElement, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n.props.children).includes(label));

describe('tray popover waiting group', () => {
  it('counts only approvals, questions and workflow approvals across every project', async () => {
    needs = [approval('ap-1'), question, workflowApproval, failedSession];
    const tree = (await popover()).value;
    expect(bridge.query).toHaveBeenCalledWith('needs_you.list', undefined);
    const waiting = group(tree, WAITING);
    expect(waiting.count).toBe('3');
    const body = text(waiting.section);
    expect(body).toContain('Callback signatures');
    expect(body).toContain('18 分');
    expect(body).toContain('pnpm db:migrate --env staging');
    expect(body).toContain('lead 问了一个问题');
    expect(body).toContain('Deploy to staging');
    expect(body).not.toContain(zh('data.reason.sessionFailed'));
  });

  it('lists five and opens the main window for the rest', async () => {
    needs = Array.from({ length: 7 }, (_, i) => approval(`ap-${i}`));
    const tree = (await popover()).value;
    const waiting = group(tree, WAITING);
    expect(waiting.count).toBe('7');
    expect(nodes(waiting.section).filter((n) => n.props.className === 'tp-ask').length).toBe(5);
    button(waiting.section, '还有 2 条').props.onClick();
    expect(bridge.revealMain).toHaveBeenCalledWith();
  });

  it('allows a request in place and drops it once answered', async () => {
    needs = [approval('ap-1'), approval('ap-2', { session_id: 'session-a' })];
    const h = await popover();
    const first = nodes(group(h.value, WAITING).section).filter(
      (n) => n.props.className === 'tp-ask',
    )[0]!;
    button(first, zh('trayPopover.waiting.allow')).props.onClick();
    await h.flush();
    expect(bridge.command).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approval.respond',
        input: { approval_id: 'ap-1', decision: 'approve' },
        expected_revision: 3,
      }),
    );
    const left = nodes(group(h.value, WAITING).section).filter(
      (n) => n.props.className === 'tp-ask',
    );
    expect(left.map((n) => n.key)).toEqual(['ap-2']);
    expect(group(h.value, WAITING).count).toBe('1');
  });

  it('denies a request and shows a failure in that item', async () => {
    needs = [approval('ap-1'), approval('ap-2')];
    bridge.command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'approval_not_pending', message: 'gone' },
    });
    const h = await popover();
    const asks = () =>
      nodes(group(h.value, WAITING).section).filter((n) => n.props.className === 'tp-ask');
    button(asks()[1]!, zh('trayPopover.waiting.deny')).props.onClick();
    await h.flush();
    expect(bridge.command).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approval.respond',
        input: { approval_id: 'ap-2', decision: 'reject' },
      }),
    );
    expect(asks()).toHaveLength(2);
    const alert = find(asks()[1]!, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain(zh('data.reason.approvalNotPending'));
    expect(() => find(asks()[0]!, (n) => n.props.role === 'alert')).toThrow();
  });

  it('opens a request and a question in the main window', async () => {
    needs = [approval('ap-1'), question];
    const tree = (await popover()).value;
    const waiting = group(tree, WAITING).section;
    button(
      find(waiting, (n) => n.props.className === 'tp-ask'),
      zh('trayPopover.open'),
    ).props.onClick();
    expect(bridge.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'alpha',
      session_id: 'session-a',
    });
    button(waiting, 'lead 问了一个问题').props.onClick();
    expect(bridge.showInMainWindow).toHaveBeenLastCalledWith({
      project_id: 'beta',
      session_id: 'lead-1',
    });
  });

  it('lists an external request that waits for approval and opens its triage session', async () => {
    needs = [heldRequest, failedSession];
    const tree = (await popover()).value;
    const waiting = group(tree, WAITING);
    expect(waiting.count).toBe('1');
    button(waiting.section, zh('data.reason.externalApproval')).props.onClick();
    expect(bridge.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'beta',
      session_id: 'lead-2',
    });
  });

  it('lists a lane whose plan waits for approval, says while its review still runs, and opens its lead', async () => {
    const lane = (request_id: string, plan_review_running?: boolean): NeedsYouItem => ({
      source: { table: 'board_plans', id: 'lead-2', revision: 1 },
      kind: 'board.lane.approval',
      project_id: 'beta',
      session_id: 'lead-2',
      request_id,
      status: 'pending',
      created_at: NOW - 3 * MINUTE,
      reason: 'lane_plan_awaiting_approval',
      actions: [{ command: 'board.lane.approve', allowed: true }],
      ...(plan_review_running === undefined ? {} : { plan_review_running }),
    });
    needs = [lane('lane-docs'), failedSession];
    const tree = (await popover()).value;
    const waiting = group(tree, WAITING);
    expect(waiting.count).toBe('1');
    button(waiting.section, zh('data.reason.lanePlanAwaitingApproval')).props.onClick();
    expect(bridge.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'beta',
      session_id: 'lead-2',
    });
    needs = [lane('lane-api', true)];
    const reviewing = group((await popover()).value, WAITING);
    expect(text(reviewing.section)).toContain(zh('data.reason.lanePlanAwaitingApprovalReviewing'));
  });
});

describe('tray popover other groups', () => {
  it('lists reviewable sessions of every project in their own group, outside the waiting count', async () => {
    needs = [approval('ap-1')];
    lists = {
      alpha: [listed('session-r', { title: 'Refund list', state: 'ready' }), listed('session-i')],
      beta: [listed('session-s', { title: 'Export CSV', state: 'ready' })],
    };
    const tree = (await popover()).value;
    expect(group(tree, WAITING).count).toBe('1');
    const review = group(tree, zh('trayPopover.review.title'));
    expect(review.count).toBe('2');
    expect(text(review.section)).toContain('Refund list');
    expect(text(review.section)).not.toContain('session-i');
    button(review.section, 'Export CSV').props.onClick();
    expect(bridge.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'beta',
      session_id: 'session-s',
    });
  });

  it('lists running sessions with how long they have run', async () => {
    lists = {
      alpha: [],
      beta: [
        listed('session-c', {
          state: 'running',
          last_activity_at: new Date(NOW - 12 * MINUTE).toISOString(),
        }),
      ],
    };
    const tree = (await popover()).value;
    const running = group(tree, zh('trayPopover.running.title'));
    expect(running.count).toBe('2');
    const body = text(running.section);
    expect(body).toContain('lead');
    expect(body).toContain('Idempotent refunds');
    expect(body).toContain('12 分');
  });

  it('shows the subscription quota with a meter, and no row without quota data', async () => {
    let tree = (await popover()).value;
    expect(nodes(tree).some((n) => n.props.role === 'meter')).toBe(false);
    statuses = [
      status({
        quota: {
          windows: [
            { window: '5h', used_percent: 38 },
            { window: '7d', used_percent: 12 },
          ],
          seen_at: NOW,
        },
      }),
    ];
    tree = (await popover()).value;
    const meter = find(tree, (n) => n.props.role === 'meter');
    expect(meter.props['aria-valuenow']).toBe(38);
    expect(meter.props.style).toEqual({ '--v': '38%' });
    expect(text(tree)).toContain('Claude 订阅额度');
    expect(text(tree)).toContain('38%');
  });

  it('says nothing needs you and keeps the two actions when every group is empty', async () => {
    mock.board.board.sessions = [];
    const tree = (await popover()).value;
    expect(hasGroup(tree, WAITING)).toBe(false);
    expect(hasGroup(tree, zh('trayPopover.review.title'))).toBe(false);
    expect(hasGroup(tree, zh('trayPopover.running.title'))).toBe(false);
    expect(text(tree)).toContain(zh('trayPopover.empty'));
    const actions = nodes(tree).filter((n) => n.type === 'button');
    expect(actions.map((n) => text(n.props.children))).toEqual([
      `${zh('trayPopover.newSession')}⌘N`,
      zh('trayPopover.openPantheon'),
    ]);
  });
});

describe('tray popover session lists', () => {
  let sequence = 0;
  const sessionEvent = (kind: string, project_id: string) => ({
    sequence: ++sequence,
    event_id: `event-${sequence}`,
    kind,
    aggregate_id: 'other',
    aggregate_revision: 1,
    project_id,
    causation_id: '',
    created_at: NOW,
    payload: {},
  });

  it.each([
    [
      'reads again only the session list of the project a session event belongs to',
      [['session.updated', 'alpha']],
      ['alpha'],
    ],
    [
      'reads each project with events since the last read once',
      [
        ['turn.completed', 'alpha'],
        ['workspace.updated', 'beta'],
        ['session.updated', 'alpha'],
      ],
      ['alpha', 'beta'],
    ],
    [
      'reads every project after a session event of no project',
      [['session.updated', '']],
      ['alpha', 'beta'],
    ],
  ])('%s, keeping the lists of the others', async (_, events, read) => {
    lists = { alpha: [listed('alpha-old')], beta: [listed('beta-old')] };
    const h = mount(() => useProjectSessions(['alpha', 'beta']));
    await h.flush();
    bridge.query.mockClear();
    lists = { alpha: [listed('alpha-new')], beta: [listed('beta-new')] };
    mock.board = {
      ...mock.board,
      events: events.map(([kind, project_id]) => sessionEvent(kind!, project_id!)),
    };
    h.render();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(
      bridge.query.mock.calls
        .filter(([method]: [string]) => method === 'session.list')
        .map(([, params]: [string, { project_id: string }]) => params.project_id)
        .sort(),
    ).toEqual(read);
    expect(h.value.map((each) => each.session.id)).toEqual(
      ['alpha', 'beta'].map((id) => `${id}-${read.includes(id) ? 'new' : 'old'}`),
    );
  });
});

describe('tray popover actions and size', () => {
  it('starts a new session and opens Pantheon through the main window', async () => {
    const tree = (await popover()).value;
    button(tree, zh('trayPopover.newSession')).props.onClick();
    expect(bridge.revealMain).toHaveBeenCalledWith('new-session');
    button(tree, zh('trayPopover.openPantheon')).props.onClick();
    expect(bridge.revealMain).toHaveBeenLastCalledWith();
  });

  it('asks for the content height whenever it changes', async () => {
    const tree = (await popover()).value;
    const content = find(tree, (n) => n.props.className === 'tp');
    let height = 212;
    const element = { getBoundingClientRect: () => ({ height }) };
    content.props.ref(element);
    expect(observers.at(-1)!.target).toBe(element);
    expect(bridge.setPopoverHeight).toHaveBeenLastCalledWith(212);
    observers.at(-1)!.callback();
    expect(bridge.setPopoverHeight).toHaveBeenCalledTimes(1);
    height = 300.4;
    observers.at(-1)!.callback();
    expect(bridge.setPopoverHeight).toHaveBeenLastCalledWith(301);
  });

  it('tells the desktop shell once its list or empty state is painted', async () => {
    const reads = { answer: (_: BridgeResult<unknown>) => {} };
    const query = bridge.query;
    bridge.query = vi.fn((method: string, params?: Record<string, string>) =>
      method === 'needs_you.list'
        ? new Promise<BridgeResult<unknown>>((done) => (reads.answer = done))
        : query(method, params),
    );
    mock.board.board.sessions = [];
    const h = mount(() => TrayPopover());
    await h.flush();
    frames.splice(0).forEach((run) => run());
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.ready).not.toHaveBeenCalled();
    reads.answer(ok({ items: [] }));
    await h.flush();
    expect(text(h.value)).toContain(zh('trayPopover.empty'));
    expect(bridge.ready).not.toHaveBeenCalled();
    frames.splice(0).forEach((run) => run());
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.ready).toHaveBeenCalledTimes(1);
    h.render();
    frames.splice(0).forEach((run) => run());
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.ready).toHaveBeenCalledTimes(1);
  });
});
