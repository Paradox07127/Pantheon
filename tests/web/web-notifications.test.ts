import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ATTENTION_DELIVERY,
  type AppSettings,
  type BoardSnapshot,
} from '@pantheon/protocol';
import { useCurrentProject } from '@/data/current-project';
import type { NeedsYouItem } from '@/data/needs-you';
import {
  badgeCount,
  DEFAULT_NOTIFICATIONS,
  decisionNotices,
  eventNotice,
  liveNotices,
  openNotice,
  requestNotices,
} from '@/data/notifications';
import type { DaemonEvent } from '@/data/sync';
import { useShell } from '@/store';
import { zh, zhf } from './i18n-setup.js';

const board = {
  cursor: 0,
  projects: [
    { id: 'alpha', name: 'Alpha app' },
    { id: 'beta', name: 'Beta app' },
  ],
  sessions: [
    { id: 'alpha-shown', project_id: 'alpha', native_title: 'Shown work' },
    { id: 'alpha-other', project_id: 'alpha', native_title: 'Other work' },
    { id: 'beta-login', project_id: 'beta', native_title: 'Fix login' },
    { id: 'beta-story', project_id: 'beta', change_story: { story_id: 'story' } },
    { id: 'alpha-baseline', project_id: 'alpha', native_title: 'Survey', baseline: { id: 'b' } },
    { id: 'beta-baseline', project_id: 'beta', native_title: 'Survey', baseline: { id: 'b' } },
  ],
  session_turns: [
    { id: 'turn-alpha-shown', session_id: 'alpha-shown', project_id: 'alpha' },
    { id: 'turn-alpha-other', session_id: 'alpha-other', project_id: 'alpha' },
    { id: 'turn-beta', session_id: 'beta-login', project_id: 'beta' },
    { id: 'turn-story', session_id: 'beta-story', project_id: 'beta' },
    { id: 'turn-alpha-baseline', session_id: 'alpha-baseline', project_id: 'alpha' },
    { id: 'turn-beta-baseline', session_id: 'beta-baseline', project_id: 'beta' },
  ],
  workspaces: [],
} as unknown as BoardSnapshot;

let sequence = 0;
const event = (
  kind: string,
  aggregate_id: string,
  payload: unknown = {},
  project_id = 'beta',
): DaemonEvent => ({
  sequence: ++sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id,
  causation_id: '',
  created_at: sequence,
  payload,
});

const detail = (reason: string, detail: string) =>
  zhf('data.notifications.reasonDetail', { reason: zh(reason), detail });

const login = { project_id: 'beta', session_id: 'beta-login' };

describe('event notices', () => {
  it('gives each kind its text and its project and session as the target', () => {
    const notice = (e: DaemonEvent) => eventNotice(e, board);
    expect(notice(event('turn.completed', 'turn-beta'))).toEqual({
      title: 'Beta app, Fix login',
      body: zh('data.notifications.turnEnded'),
      target: login,
      silent: true,
    });
    expect(notice(event('turn.failed', 'turn-beta', { error: 'adapter crashed' }))).toEqual({
      title: 'Beta app, Fix login',
      body: zhf('data.notifications.turnFailedWith', { error: 'adapter crashed' }),
      target: login,
    });
    expect(
      notice(
        event('session.gate_checked', 'beta-login', {
          results: [
            { name: 'lint', exit_code: 0, timed_out: false },
            { name: 'test', exit_code: 1, timed_out: false },
          ],
        }),
      ),
    ).toEqual({
      title: 'Beta app, Fix login',
      body: detail('data.reason.gateFailed', 'test'),
      target: login,
    });
    expect(
      notice(
        event('session.merged', 'beta-login', {
          branch: 'pantheon/login',
          files: 3,
          additions: 10,
          deletions: 2,
        }),
      ),
    ).toEqual({
      title: 'Beta app, Fix login',
      body: '已合并：3 个文件 +10 −2',
      target: login,
      silent: true,
    });
    expect(
      notice(
        event('session.merge_blocked', 'beta-login', { state: 'blocked', reason: 'no_changes' }),
      ),
    ).toEqual({
      title: 'Beta app, Fix login',
      body: detail('data.reason.mergeBlocked', zh('data.reason.noChanges')),
      target: login,
    });
  });

  it('gives no notice for a passing gate, other kinds or a change story session', () => {
    const notice = (e: DaemonEvent) => eventNotice(e, board);
    expect(
      notice(
        event('session.gate_checked', 'beta-login', {
          results: [{ name: 'test', exit_code: 0, timed_out: false }],
        }),
      ),
    ).toBeNull();
    expect(notice(event('turn.running', 'turn-beta'))).toBeNull();
    expect(notice(event('turn.cancelled', 'turn-beta'))).toBeNull();
    expect(notice(event('turn.completed', 'turn-story'))).toBeNull();
  });

  it('gives the turn end of every session, the one the screen shows and a baseline too', () => {
    expect(
      eventNotice(event('turn.completed', 'turn-alpha-shown', {}, 'alpha'), board),
    ).toMatchObject({
      title: 'Alpha app, Shown work',
      target: { project_id: 'alpha', session_id: 'alpha-shown' },
    });
    expect(
      eventNotice(event('turn.completed', 'turn-alpha-other', {}, 'alpha'), board),
    ).toMatchObject({
      title: 'Alpha app, Other work',
      target: { project_id: 'alpha', session_id: 'alpha-other' },
    });
    expect(
      eventNotice(event('turn.failed', 'turn-alpha-baseline', {}, 'alpha'), board),
    ).toMatchObject({
      target: { project_id: 'alpha', session_id: 'alpha-baseline' },
    });
  });

  const residentBoard = {
    ...board,
    sessions: [
      ...board.sessions,
      {
        id: 'beta-assistant',
        project_id: 'beta',
        native_title: 'Assistant',
        resident: { kind: 'assistant' },
      },
    ],
    session_turns: [
      ...board.session_turns,
      ...(['tracker', 'sync', 'external', undefined] as const).map((origin) => ({
        id: `turn-assistant-${origin ?? 'user'}`,
        session_id: 'beta-assistant',
        project_id: 'beta',
        ...(origin && { origin }),
      })),
    ],
  } as unknown as BoardSnapshot;
  const assistant = { project_id: 'beta', session_id: 'beta-assistant' };

  it.each([
    ['no notice for a resident turn its workers woke', 'turn.completed', 'turn-assistant-tracker'],
    ['no notice for a resident turn a plan sync woke', 'turn.completed', 'turn-assistant-sync'],
    [
      'no notice for a resident turn an outside event woke',
      'turn.failed',
      'turn-assistant-external',
    ],
  ])('gives %s', (_name, kind, turnId) => {
    expect(eventNotice(event(kind, turnId), residentBoard)).toBeNull();
  });

  it.each([
    [
      "the user's own resident turn end",
      event('turn.completed', 'turn-assistant-user'),
      { body: zh('data.notifications.turnEnded'), target: assistant },
    ],
    [
      'a message the agent left for the user, opening its conversation',
      event('agent_message.created', 'message-1', {
        session_id: 'beta-assistant',
        text: 'The login fix merged; nothing waits on you.',
        urgency: 'normal',
        agent_name: 'Assistant',
      }),
      {
        title: 'Beta app, Assistant',
        body: 'The login fix merged; nothing waits on you.',
        target: assistant,
        silent: true,
      },
    ],
  ])('notifies %s', (_name, given, expected) => {
    expect(eventNotice(given, residentBoard)).toMatchObject(expected);
  });

  it('gives no notice for a message the agent left only in the feed', () => {
    const message = event('agent_message.created', 'message-2', {
      session_id: 'beta-assistant',
      text: 'The login fix merged; nothing waits on you.',
      urgency: 'high',
      agent_name: 'Assistant',
      delivery: 'feed',
    });
    expect(eventNotice(message, residentBoard)).toBeNull();
  });

  it('leaves a request to the needs-you list', () => {
    const requested = event('approval.requested', 'approval-2', {
      session_id: 'beta-login',
      tool: 'Bash',
    });
    expect(eventNotice(requested, board)).toBeNull();
  });
});

describe('live notices', () => {
  it('skips the events present at start and notifies the ones after it once', () => {
    const before = [event('turn.completed', 'turn-beta')];
    const start = liveNotices(null, { board, events: before, resync: 0 });
    expect(start.notices).toEqual([]);
    const ended = event('turn.failed', 'turn-beta', { error: 'boom' });
    const next = liveNotices(start.cursor, { board, events: [...before, ended], resync: 0 });
    expect(next.notices.map((n) => n.body)).toEqual([
      zhf('data.notifications.turnFailedWith', { error: 'boom' }),
    ]);
    const again = liveNotices(next.cursor, {
      board,
      events: [...before, ended, { ...ended }],
      resync: 0,
    });
    expect(again.notices).toEqual([]);
  });

  it('skips the events read back after a resync', () => {
    const start = liveNotices(null, { board, events: [], resync: 0 });
    const replaced = [event('turn.completed', 'turn-beta')];
    const after = liveNotices(start.cursor, { board, events: replaced, resync: 1 });
    expect(after.notices).toEqual([]);
    const merged = event('session.merged', 'beta-login', { files: 1, additions: 1, deletions: 0 });
    expect(
      liveNotices(after.cursor, { board, events: [...replaced, merged], resync: 1 }).notices,
    ).toHaveLength(1);
  });

  it.each([
    [
      'notifies a turn end once the board names its session, not before',
      { ...board, session_turns: [] },
    ],
    ['notifies what arrived before the board once the board is read', null],
  ])('%s', (_name, early) => {
    const start = liveNotices(null, { board: early, events: [], resync: 0 });
    const ended = [event('turn.completed', 'turn-beta')];
    const before = liveNotices(start.cursor, { board: early, events: ended, resync: 0 });
    expect(before.notices).toEqual([]);
    expect(liveNotices(before.cursor, { board, events: ended, resync: 0 }).notices).toEqual([
      {
        title: 'Beta app, Fix login',
        body: zh('data.notifications.turnEnded'),
        target: login,
        silent: true,
      },
    ]);
  });
});

const item = (project_id: string, table: 'approvals' | 'sessions', id: string): NeedsYouItem => ({
  source: { table, id, revision: 1 },
  kind: table === 'approvals' ? 'permission' : 'session.failed',
  project_id,
  status: 'pending',
  created_at: 0,
  reason: table === 'approvals' ? 'permission_requested' : 'session_failed',
  actions: [],
});

describe('dock badge', () => {
  it('counts the requests waiting in every project, and not the other needs-you items', () => {
    const items = [
      item('alpha', 'approvals', 'a1'),
      item('alpha', 'sessions', 'alpha-other'),
      item('beta', 'approvals', 'b1'),
      item('beta', 'sessions', 'beta-login'),
    ];
    expect(badgeCount(items)).toBe(2);
  });

  it('gives no count while the needs-you list is not read, so the dock keeps its badge', () => {
    expect(badgeCount(null)).toBeNull();
  });

  it('leaves plan failures and undelivered answers out', () => {
    const items: NeedsYouItem[] = [
      item('alpha', 'approvals', 'a1'),
      { ...item('alpha', 'approvals', 'a2'), status: 'undelivered', reason: 'answer_undelivered' },
      {
        ...item('alpha', 'sessions', 'lead'),
        source: { table: 'board_plans', id: 'plan', revision: 1 },
        session_id: 'lead',
        task_id: 'lead:task-1',
      },
    ];
    expect(badgeCount(items)).toBe(1);
  });
});

describe('decision notices', () => {
  const milestone: NeedsYouItem = {
    source: { table: 'milestones', id: 'milestone-1', revision: 2 },
    kind: 'milestone.ready_for_acceptance',
    project_id: 'beta',
    session_id: 'beta-login',
    status: 'ready_for_acceptance',
    created_at: 0,
    reason: 'milestone_ready_for_acceptance',
    actions: [{ command: 'milestone.accept', allowed: true }],
  };
  const proposal: NeedsYouItem = {
    source: { table: 'board_plans', id: 'alpha-lead', revision: 1 },
    kind: 'board.plan.proposal',
    project_id: 'alpha',
    session_id: 'alpha-lead',
    request_id: 'proposal-1',
    status: 'pending',
    created_at: 0,
    reason: 'plan_proposal_awaiting_decision',
    actions: [{ command: 'board.plan.proposal.resolve', allowed: true }],
  };
  const withMilestone = {
    ...board,
    milestones: [{ id: 'milestone-1', title: 'Search and redirects' }],
  } as unknown as BoardSnapshot;

  it("follows the daemon's rule for each item's kind of decision", () => {
    const { seen } = decisionNotices(null, [], withMilestone);
    const rules = (delivery: Partial<AppSettings['attention_delivery']>) => ({
      attention_delivery: { ...DEFAULT_ATTENTION_DELIVERY, ...delivery },
    });
    const sent = (delivery: Partial<AppSettings['attention_delivery']>) =>
      decisionNotices(
        seen,
        [
          { ...milestone, decision: 'milestone_accept' },
          { ...proposal, decision: 'plan_change' },
        ],
        withMilestone,
        DEFAULT_NOTIFICATIONS,
        rules(delivery),
      ).notices.map((n) => n.title);
    expect(sent({})).toEqual(['Alpha app']);
    expect(sent({ milestone_accept: 'now', plan_change: 'never' })).toEqual(['Beta app']);
  });

  it('notifies a milestone ready for acceptance and a new proposal once each while listed, opening the inbox', () => {
    const first = decisionNotices(null, [item('beta', 'approvals', 'b1')], withMilestone);
    expect(first.notices).toEqual([]);
    const next = decisionNotices(first.seen, [milestone, proposal], withMilestone);
    expect(next.notices).toEqual([
      {
        title: 'Beta app',
        body: detail('data.reason.milestoneReadyForAcceptance', 'Search and redirects'),
        target: { project_id: 'beta', session_id: '' },
      },
      {
        title: 'Alpha app',
        body: zh('data.reason.planProposalAwaitingDecision'),
        target: { project_id: 'alpha', session_id: '' },
      },
    ]);
    expect(decisionNotices(next.seen, [milestone, proposal], withMilestone).notices).toEqual([]);
    const gone = decisionNotices(next.seen, [], withMilestone);
    expect(gone.seen).toEqual(new Set());
    expect(decisionNotices(gone.seen, [milestone], withMilestone).notices).toHaveLength(1);
  });

  it('notifies a stalled session turn once while listed, opening the session; a usage limit gives none', () => {
    const session = (id: string, reason: NeedsYouItem['reason']): NeedsYouItem => ({
      source: { table: 'sessions', id, revision: 4 },
      kind: 'session.failed',
      project_id: 'beta',
      status: 'failed',
      created_at: 0,
      reason,
      decision: 'other',
      actions: [],
    });
    const limited = session('beta-login', 'usage_limit_reached');
    const stalled = session('beta-story', 'session_turn_stalled');
    const first = decisionNotices(null, [], board);
    const next = decisionNotices(first.seen, [limited, stalled], board);
    expect(next.notices).toEqual([
      {
        title: 'Beta app',
        body: zh('data.reason.sessionTurnStalled'),
        target: { project_id: 'beta', session_id: 'beta-story' },
      },
    ]);
    expect(decisionNotices(next.seen, [limited, stalled], board).notices).toEqual([]);
  });

  it('notifies none of the items present at the first read, nor while the list is not read', () => {
    const first = decisionNotices(null, [milestone], withMilestone);
    expect(first.notices).toEqual([]);
    const unread = decisionNotices(first.seen, null, withMilestone);
    expect(unread.notices).toEqual([]);
    expect(decisionNotices(unread.seen, [milestone, proposal], withMilestone).notices).toHaveLength(
      1,
    );
  });
});

describe('request notices', () => {
  it('forgets an approval that left the list, so its return notifies again', () => {
    const asked = { ...item('beta', 'approvals', 'b1'), session_id: 'beta-login' };
    const first = requestNotices(null, [], board);
    const next = requestNotices(first.seen, [asked], board);
    expect(next.notices).toHaveLength(1);
    expect(requestNotices(next.seen, [asked], board).notices).toEqual([]);
    const gone = requestNotices(next.seen, [], board);
    expect(gone.seen).toEqual(new Set());
    expect(requestNotices(gone.seen, [asked], board).notices).toHaveLength(1);
  });
});

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

describe('notification click', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    useCurrentProject.setState({ projectId: 'alpha' });
    useShell.setState({
      screen: 'board',
      sessionId: null,
      sessionRestored: false,
      history: [
        {
          projectId: 'alpha',
          screen: 'board',
          sessionId: null,
          sessionTask: null,
        },
      ],
      historyIndex: 0,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens the sessions of the project of a notice about no session in one navigation', () => {
    openNotice({ project_id: 'beta', session_id: '' });
    expect(useCurrentProject.getState().projectId).toBe('beta');
    expect({ screen: useShell.getState().screen, session: useShell.getState().sessionId }).toEqual({
      screen: 'sessions',
      session: null,
    });
    expect(useShell.getState().history).toHaveLength(2);
  });

  it('opens the project and session of the notice in one navigation', () => {
    openNotice(login);
    expect(useCurrentProject.getState().projectId).toBe('beta');
    const shell = useShell.getState();
    expect({ screen: shell.screen, session: shell.sessionId }).toEqual({
      screen: 'sessions',
      session: 'beta-login',
    });
    expect(shell.history).toMatchObject([
      { projectId: 'alpha', screen: 'board', sessionId: null },
      { projectId: 'beta', screen: 'sessions', sessionId: 'beta-login' },
    ]);
  });
});
