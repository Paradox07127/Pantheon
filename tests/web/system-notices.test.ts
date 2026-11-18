import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  DEFAULT_ATTENTION_DELIVERY,
  type AppSettings,
  type BoardSnapshot,
  type NotificationTarget,
  type WorkbenchSession,
} from '@pantheon/protocol';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { Collapsible } from '../../apps/web/node_modules/@base-ui/react/collapsible/index.mjs';
import { NoticeFeed } from '@/components/NoticeFeed';
import { toastManager } from '@/components/Toast';
import { useBoard } from '@/data/board';
import { focusRequest, wantedRequest } from '@/data/focus-request';
import type { NeedsYouItem } from '@/data/needs-you';
import {
  badgeCount,
  DEFAULT_NOTIFICATIONS,
  getNotificationPrefs,
  NOTIFICATIONS_KEY,
  setNotificationPrefs,
  useNotices,
} from '@/data/notifications';
import type { DaemonEvent, SyncView } from '@/data/sync';
import type { RequestItem } from '@/data/transcript';
import type { PendingPermission } from '@/screens/sessions/model';
import { RequestSlot } from '@/screens/sessions/SessionsScreen';
import { useShell } from '@/store';
import { mount, nodes, unmountAll, type HookHost } from './web-hook-host.js';
import { mountToastStore } from './web-toast-store.js';
import { zh } from './i18n-setup.js';

const NOW = new Date(2026, 10, 13, 9).getTime();

const board = {
  cursor: 0,
  projects: [
    { id: 'alpha', name: 'Alpha app' },
    { id: 'beta', name: 'Beta app' },
  ],
  sessions: [
    { id: 'beta-login', project_id: 'beta', native_title: 'Fix login' },
    { id: 'beta-docs', project_id: 'beta', native_title: 'Write docs' },
  ],
  session_turns: [
    { id: 'turn-login', session_id: 'beta-login', project_id: 'beta' },
    { id: 'turn-docs', session_id: 'beta-docs', project_id: 'beta' },
  ],
  workspaces: [],
} as unknown as BoardSnapshot;

let sequence = 0;
const event = (kind: string, aggregate_id: string, payload: unknown = {}): DaemonEvent => ({
  sequence: ++sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id: 'beta',
  causation_id: '',
  created_at: sequence,
  payload,
});
const turnFailed = () => event('turn.failed', 'turn-login', { error: 'adapter crashed' });

const need = (id: string, extra: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
  source: { table: 'approvals', id, revision: 3 },
  kind: 'permission',
  project_id: 'beta',
  session_id: 'beta-login',
  status: 'pending',
  created_at: NOW - 60_000,
  reason: 'permission_requested',
  actions: [{ command: 'approval.respond', allowed: true }],
  binding: { action: 'Bash', input_summary: 'pnpm db:migrate --env staging' },
  ...extra,
});
const step = need('step-1', {
  source: { table: 'workflow_step_runs', id: 'step-1', revision: 1 },
  kind: 'workflow.approval',
  reason: 'workflow_approval',
  binding: undefined,
  actions: [{ command: 'workflow.step.decide', allowed: true }],
});
const external = need('beta-docs', {
  source: { table: 'board_plans', id: 'beta-docs', revision: 1 },
  kind: 'external.approval',
  reason: 'external_approval',
  session_id: 'beta-docs',
  request_id: 'github:acme/docs#3',
  binding: undefined,
  actions: [{ command: 'external.approve', allowed: true }],
});
const leadQuestion = need('beta-lead', {
  source: { table: 'board_plans', id: 'beta-lead', revision: 2 },
  kind: 'lead.question',
  session_id: 'beta-lead',
  request_id: 'question-1',
  reason: 'lead_question',
  binding: undefined,
  actions: [{ command: 'lead.question.answer', allowed: true }],
  question: { id: 'question-1', at: 0, question: 'Split the partial refund?' } as never,
});

const session = (
  id: string,
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state,
  waiting: state === 'waiting' ? 1 : 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: { files: 1, additions: 4, deletions: 1 },
  merge: null,
  ...extra,
});
const passed = { gate: { state: 'passed', passed: 1, failed: 0, running: 0 } } as const;

const shell = useShell.getState();
const boardState = useBoard.getState();
let notify: Mock;
let appFocused: Mock<() => Promise<boolean>>;
let pageFocused: boolean;
let click: ((target: NotificationTarget) => void) | null;
let storage: ((e: { key: string | null; newValue: string | null }) => void)[];
let openProjectSession: Mock<(projectId: string, sessionId: string) => void>;
let cards: ReturnType<typeof mountToastStore>;
let props: {
  sessions: readonly WorkbenchSession[] | null;
  items: readonly NeedsYouItem[] | null;
};
// What the daemon answers app.settings with.
let appSettings: Pick<AppSettings, 'attention_delivery' | 'quiet_hours'>;
// The session list each project's read answers with.
let lists: Record<string, readonly WorkbenchSession[]>;
let host: HookHost<null>;

const render = (next: Partial<typeof props> = {}) => {
  props = { ...props, ...next };
  host.render();
};
const deliver = (...events: DaemonEvent[]) => {
  useBoard.setState({ events: [...useBoard.getState().events, ...events] } as Partial<SyncView>);
  render();
};
const settle = async () => {
  await host.flush();
  await vi.advanceTimersByTimeAsync(2000);
  await host.flush();
};
const sent = () => notify.mock.calls.map(([notice]) => notice);
// Answers the next reads of the projects' session lists with these, after a session event of each.
const relist = (next: typeof lists) => {
  lists = { ...lists, ...next };
  deliver(
    ...Object.keys(next).map((project_id) => ({
      ...event('session.updated', `${project_id}-login`),
      project_id,
    })),
  );
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  notify = vi.fn(async () => {});
  appFocused = vi.fn(async () => false);
  pageFocused = true;
  click = null;
  storage = [];
  appSettings = { attention_delivery: DEFAULT_ATTENTION_DELIVERY };
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  });
  vi.stubGlobal('window', {
    pantheon: {
      notify,
      appFocused,
      keepAwake: async () => {},
      command: async () => ({ ok: true, value: {} }),
      query: async (method: string, params: { project_id: string }) => ({
        ok: true,
        value: method === 'app.settings' ? appSettings : (lists[params.project_id] ?? []),
      }),
      onNotificationClick: (listener: (target: NotificationTarget) => void) => {
        click = listener;
        return () => {};
      },
    },
    addEventListener: (type: string, listener: never) => {
      if (type === 'storage') storage.push(listener);
    },
    removeEventListener: (type: string, listener: never) => {
      if (type === 'storage') storage = storage.filter((l) => l !== listener);
    },
  });
  vi.stubGlobal('document', { activeElement: null, hasFocus: () => pageFocused });
  openProjectSession = vi.fn<(projectId: string, sessionId: string) => void>();
  // The board in front has drawn and lists no wait.
  useShell.setState({ openProjectSession, screen: 'board', boardWaits: new Set() });
  useBoard.setState({ board, events: [], resync: 0 } as Partial<SyncView>);
  cards = mountToastStore();
  props = {
    sessions: [session('beta-login', 'running'), session('beta-docs', 'running')],
    items: [],
  };
  lists = { alpha: [], beta: props.sessions! };
  host = mount(() => {
    useNotices('beta', props.sessions, props.items);
    return NoticeFeed({ projectId: 'beta', sessions: props.sessions, allNeeds: props.items });
  });
});
afterEach(() => {
  unmountAll();
  toastManager.close();
  cards.stop();
  useShell.setState(shell);
  useBoard.setState(boardState);
  setNotificationPrefs(DEFAULT_NOTIFICATIONS);
  focusRequest(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('system notifications and in-app cards', () => {
  it('sends no system notification while a Pantheon window is in front, not even for an approval', async () => {
    appFocused.mockResolvedValue(true);
    pageFocused = false;
    render({ items: [need('approval-1')] });
    deliver(turnFailed());
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(cards.shown()).toEqual(['Fix login', 'Fix login']);
  });

  it('sends system notifications in the background and keeps only the cards that need the user', async () => {
    render({ items: [need('approval-1')] });
    deliver(turnFailed());
    await settle();
    expect(sent().map((n) => n.title)).toEqual(['Fix login 等你审批', 'Beta app, Fix login']);
    expect(cards.shown()).toEqual(['Fix login']);
  });

  it('shows nothing either way in the quiet hours and still counts the badge', async () => {
    appSettings = { ...appSettings, quiet_hours: { from: '08:00', to: '10:00' } };
    deliver(event('app.settings_set', 'app.settings'));
    await settle();
    render({ items: [need('approval-1')] });
    deliver(turnFailed());
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(cards.shown()).toEqual([]);
    expect(badgeCount([need('approval-1')])).toBe(1);
  });

  it('titles an approval with its session and gives its command as the body, without buttons', async () => {
    render({ items: [need('approval-1')] });
    await settle();
    expect(sent()).toEqual([
      {
        title: 'Fix login 等你审批',
        body: 'pnpm db:migrate --env staging',
        target: { project_id: expect.stringMatching(/^beta\n/), session_id: 'beta-login' },
      },
    ]);
  });

  it('folds the sessions that became ready together into one notice', async () => {
    const ids = ['a', 'b', 'c'];
    await settle();
    relist({ beta: ids.map((id) => session(id, 'running')) });
    await settle();
    relist({ beta: ids.map((id) => session(id, 'ready', passed)) });
    await settle();
    expect(sent()).toEqual([
      expect.objectContaining({
        title: '3 个会话可以审阅',
        body: zh('data.notifications.allPassed'),
      }),
    ]);
  });

  it('folds the sessions of every project that became ready into one notice, not only the current project', async () => {
    await settle();
    relist({ alpha: [session('alpha-a', 'running'), session('alpha-b', 'running')] });
    await settle();
    relist({
      alpha: [session('alpha-a', 'ready', passed), session('alpha-b', 'ready', passed)],
      beta: [session('beta-login', 'ready', passed), session('beta-docs', 'running')],
    });
    await settle();
    expect(sent()).toEqual([
      expect.objectContaining({
        title: '3 个会话可以审阅',
        body: zh('data.notifications.allPassed'),
      }),
    ]);
    notify.mockClear();
    relist({
      alpha: [
        session('alpha-a', 'ready'),
        session('alpha-b', 'ready'),
        session('alpha-c', 'ready'),
      ],
      beta: [session('beta-login', 'ready'), session('beta-docs', 'ready')],
    });
    await settle();
    expect(sent()).toEqual([
      {
        title: '2 个会话可以审阅',
        body: 'Alpha app, Beta app',
        target: { project_id: 'alpha', session_id: '' },
        silent: true,
      },
    ]);
  });

  it('tells a turn that ends ready for review only as ready, in the app and on the system', async () => {
    await settle();
    lists = { ...lists, beta: [session('beta-login', 'ready'), session('beta-docs', 'running')] };
    deliver(event('turn.completed', 'turn-login'));
    render({ sessions: lists.beta });
    await settle();
    expect(sent().map((n) => n.title)).toEqual(['title of beta-login 可以审阅']);
    notify.mockClear();
    appFocused.mockResolvedValue(true);
    lists = { ...lists, beta: [session('beta-login', 'ready'), session('beta-docs', 'ready')] };
    deliver(event('turn.completed', 'turn-docs'));
    render({ sessions: lists.beta });
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(cards.shown()).toEqual(['title of beta-docs']);
  });

  it('notifies a turn end of the session the sessions screen shows while the app is in the background', async () => {
    useShell.setState({ screen: 'sessions', sessionId: 'beta-login' });
    render();
    await settle();
    deliver(turnFailed());
    await settle();
    expect(sent().map((n) => n.title)).toEqual(['Beta app, Fix login']);
  });

  it("notifies a baseline's failed turn, and leaves its finished turn to the notice that it waits for review", async () => {
    const survey = (state: WorkbenchSession['state']) =>
      session('beta-survey', state, { workspace_id: null, workspace_kind: null as never });
    useBoard.setState({
      board: {
        ...board,
        sessions: [
          ...board.sessions,
          { id: 'beta-survey', project_id: 'beta', title: 'Survey', baseline: { id: 'b' } },
        ],
        session_turns: [
          ...board.session_turns,
          { id: 'turn-survey', session_id: 'beta-survey', project_id: 'beta' },
        ],
      } as unknown as BoardSnapshot,
    } as Partial<SyncView>);
    const others = props.sessions!;
    render({ sessions: [...others, survey('running')] });
    await settle();
    deliver(event('turn.failed', 'turn-survey', { error: 'adapter crashed' }));
    await settle();
    expect(sent().map((n) => n.title)).toEqual(['Beta app, Survey']);
    notify.mockClear();
    deliver(event('turn.completed', 'turn-survey'));
    render({ sessions: [...others, survey('waiting')] });
    await settle();
    expect(sent().map((n) => n.body)).toEqual([zh('data.notifications.baselinePending')]);
  });

  it('notifies a workflow step and an external request waiting for approval, and shows their cards', async () => {
    render({ items: [step, external] });
    await settle();
    // Their target names no session, so the desktop hands the click to the main window's strip.
    expect(sent()).toEqual([
      {
        title: 'Fix login 等你审批',
        body: zh('data.reason.workflowApproval'),
        target: { project_id: expect.stringMatching(/^beta\n/), session_id: '' },
      },
      {
        title: 'Write docs 等你审批',
        body: zh('data.reason.externalApproval'),
        target: { project_id: expect.stringMatching(/^beta\n/), session_id: '' },
      },
    ]);
    expect(cards.shown()).toEqual(['Write docs', 'Fix login']);
  });

  it("reads every project's session list again when the stream comes back live", async () => {
    const query = vi.fn(async (_method: string) => ({
      ok: false,
      error: { code: 'daemon_unavailable', message: 'down' },
    }));
    window.pantheon!.query = query as never;
    useBoard.setState({ status: { state: 'offline', reason: 'down' } } as Partial<SyncView>);
    render();
    await settle();
    const before = query.mock.calls.length;
    useBoard.setState({ status: { state: 'live' } } as Partial<SyncView>);
    render();
    await settle();
    expect(query.mock.calls.slice(before).map(([method]) => method)).toEqual([
      'session.list',
      'session.list',
    ]);
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
  ])('%s', async (_, events, read) => {
    await settle();
    const query = vi.spyOn(window.pantheon!, 'query');
    deliver(
      ...events.map(([kind, project_id]) => ({
        ...event(kind!, 'other'),
        project_id: project_id!,
      })),
    );
    await settle();
    expect(
      query.mock.calls
        .filter(([method]) => method === 'session.list')
        .map(([, params]) => (params as { project_id: string }).project_id)
        .sort(),
    ).toEqual(read);
  });
});

describe('the dock badge', () => {
  it('counts only what waits for an answer: requests, lead questions and workflow approvals', () => {
    const items: NeedsYouItem[] = [
      need('approval-1'),
      need('approval-2', { project_id: 'alpha', questions: [] }),
      need('lead', {
        source: { table: 'board_plans', id: 'lead', revision: 1 },
        kind: 'lead.question',
        reason: 'lead_question',
      }),
      need('step', {
        source: { table: 'workflow_step_runs', id: 'step', revision: 1 },
        kind: 'workflow.approval',
        reason: 'workflow_approval',
      }),
      need('undelivered', { status: 'undelivered', reason: 'answer_undelivered' }),
      ...(
        [
          ['session.failed', 'session_failed'],
          ['session.gate_failed', 'gate_failed'],
          ['session.merge_blocked', 'merge_blocked'],
          ['milestone.ready_for_acceptance', 'milestone_ready_for_acceptance'],
          ['improvement.candidate', 'improvement_awaiting_decision'],
          ['project.over_budget', 'project_over_budget'],
        ] as const
      ).map(([kind, reason]) =>
        need(kind, { source: { table: 'sessions', id: kind, revision: 1 }, kind, reason }),
      ),
    ];
    expect(badgeCount(items)).toBe(4);
  });
});

describe('notice events', () => {
  it('send a notice for each event, which has no switch of its own', async () => {
    deliver(
      event('turn.completed', 'turn-docs'),
      turnFailed(),
      event('session.merge_blocked', 'beta-docs', { reason: 'no_changes' }),
    );
    await settle();
    expect(sent().map((n) => n.body)).toEqual([
      '回合失败：adapter crashed',
      '合并被挡：没有可合并的提交',
      zh('data.notifications.turnEnded'),
    ]);
  });

  it('follow the preferences another window stores', async () => {
    const stored = { ...DEFAULT_NOTIFICATIONS, sound: false };
    expect(storage).toHaveLength(1);
    storage[0]!({ key: NOTIFICATIONS_KEY, newValue: JSON.stringify(stored) });
    expect(getNotificationPrefs().sound).toBe(false);
    deliver(turnFailed());
    await settle();
    expect(sent().map((n) => n.silent)).toEqual([true]);
  });
});

describe('a click on a system notification', () => {
  it('opens the session and asks for its waiting request card', async () => {
    render({ items: [need('approval-1')] });
    await settle();
    expect(sent()[0]!.target).toEqual({
      project_id: expect.stringMatching(/^beta\n/),
      session_id: 'beta-login',
    });
    click!(sent()[0]!.target);
    expect(openProjectSession).toHaveBeenCalledWith('beta', 'beta-login');
    expect(wantedRequest()).toBe('approval-1');
  });

  it('only opens the session once the request is answered', async () => {
    render({ items: [need('approval-1')] });
    await settle();
    render({ items: [] });
    click!(sent()[0]!.target);
    expect(openProjectSession).toHaveBeenCalledWith('beta', 'beta-login');
    expect(wantedRequest()).toBeNull();
  });

  it('asks for the request card of the notice clicked, not of a later request of the same session', async () => {
    render({ items: [need('approval-1')] });
    await settle();
    render({ items: [need('approval-1'), need('approval-2')] });
    await settle();
    expect(sent()).toHaveLength(2);
    click!(sent()[0]!.target);
    expect(wantedRequest()).toBe('approval-1');
    click!(sent()[1]!.target);
    expect(wantedRequest()).toBe('approval-2');
    expect(openProjectSession.mock.calls).toEqual([
      ['beta', 'beta-login'],
      ['beta', 'beta-login'],
    ]);
  });

  it('opens the workflow step of the notice clicked, not a later step of the same session', async () => {
    const openProjectNeed = vi.fn<(projectId: string, needKey: string) => void>();
    useShell.setState({ openProjectNeed });
    const later = need('step-2', {
      ...step,
      source: { table: 'workflow_step_runs', id: 'step-2', revision: 1 },
    });
    render({ items: [step, later] });
    await settle();
    for (const target of sent().map((n) => n.target)) click!(target);
    expect(openProjectNeed.mock.calls).toEqual([
      ['beta', 'workflow_step_runs:step-1'],
      ['beta', 'workflow_step_runs:step-2'],
    ]);
  });

  it("opens a lead's question where it is answered, and the lead's session once it is answered", async () => {
    const openProjectNeed = vi.fn<(projectId: string, needKey: string) => void>();
    useShell.setState({ openProjectNeed });
    render({ items: [leadQuestion] });
    await settle();
    click!(sent()[0]!.target);
    expect(openProjectNeed.mock.calls).toEqual([['beta', 'beta-lead:question-1']]);
    expect(openProjectSession).not.toHaveBeenCalled();
    render({ items: [] });
    click!(sent()[0]!.target);
    expect(openProjectSession).toHaveBeenCalledWith('beta', 'beta-lead');
    expect(openProjectNeed).toHaveBeenCalledTimes(1);
  });

  it('opens a workflow step and an external request waiting for approval where they are answered', async () => {
    const openProjectNeed = vi.fn<(projectId: string, needKey: string) => void>();
    useShell.setState({ openProjectNeed });
    render({ items: [step, external] });
    await settle();
    for (const target of sent().map((n) => n.target)) click!(target);
    expect(openProjectNeed.mock.calls).toEqual([
      ['beta', 'workflow_step_runs:step-1'],
      ['beta', 'board_plans:beta-docs:github:acme/docs#3'],
    ]);
    expect(openProjectSession).not.toHaveBeenCalled();
  });
});

describe('the asked request card', () => {
  const item: RequestItem = {
    kind: 'request',
    id: 'req-1',
    tool: 'Bash',
    input: {},
    questions: [],
  };
  const permission: PendingPermission = {
    id: 'approval-1',
    tool: 'Bash',
    revision: 1,
    request: 'req-1',
  };
  const needs = { items: [], loading: false, error: null, reload: () => {} };

  function slot(answered: boolean) {
    const h = mount(() =>
      RequestSlot({
        item: answered ? { ...item, outcome: 'approve' } : item,
        permission,
        needs,
        folders: [],
        enter: '',
      }),
    );
    const panel = nodes(h.value).find((n) => n.type === Collapsible.Panel)!;
    const button = { focus: vi.fn() };
    const card = {
      scrollIntoView: vi.fn(),
      querySelector: vi.fn(() => button),
      contains: () => false,
    };
    (panel.props.ref as { current: unknown }).current = card;
    return { h, card, button };
  }

  it('scrolls into view and focuses its first button once asked for', () => {
    const { h, card, button } = slot(false);
    focusRequest('approval-1');
    h.render();
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(button.focus).toHaveBeenCalled();
    expect(wantedRequest()).toBeNull();
  });

  it('takes no focus once its request is answered', () => {
    const { h, card, button } = slot(true);
    focusRequest('approval-1');
    h.render();
    expect(card.scrollIntoView).not.toHaveBeenCalled();
    expect(button.focus).not.toHaveBeenCalled();
  });
});
