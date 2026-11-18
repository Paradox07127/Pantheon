import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ReactElement } from 'react';
import {
  DEFAULT_ATTENTION_DELIVERY,
  type BoardSnapshot,
  type WorkbenchSession,
} from '@pantheon/protocol';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { ToastStore } from '../../apps/web/node_modules/@base-ui/react/toast/store.mjs';
import { BackgroundHooks } from '@/components/BackgroundHooks';
import { NoticeFeed } from '@/components/NoticeFeed';
import { Toasts, noticeNeeds, toastManager } from '@/components/Toast';
import { useBoard } from '@/data/board';
import { failureText, reasonText, type NeedsYouItem } from '@/data/needs-you';
import {
  eventCard,
  groupCard,
  liveCards,
  needsCard,
  reviewCards,
  stoppedWaiting,
  BOARD_LIST_HOLD_MS,
  TURN_END_HOLD_MS,
  WATCH_CHANNEL,
  type NoticeWatch,
} from '@/data/notice-tiers';
import { useCurrentProject } from '@/data/current-project';
import { DEFAULT_NOTIFICATIONS, setNotificationPrefs, useNotices } from '@/data/notifications';
import type { DaemonEvent } from '@/data/sync';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';
import { find, HookHost, mount } from './web-hook-host.js';
import { NeedsStrip } from '@/screens/board/BoardFrame';

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
    { id: 'beta-lead', project_id: 'beta', native_title: 'Lead' },
    { id: 'beta-story', project_id: 'beta', change_story: { story_id: 'story' } },
  ],
  session_turns: [
    { id: 'turn-login', session_id: 'beta-login', project_id: 'beta' },
    { id: 'turn-docs', session_id: 'beta-docs', project_id: 'beta' },
    { id: 'turn-story', session_id: 'beta-story', project_id: 'beta' },
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

const approval = (
  id: string,
  session_id: string,
  extra: Partial<NeedsYouItem> = {},
): NeedsYouItem => ({
  source: { table: 'approvals', id, revision: 3 },
  kind: 'permission',
  project_id: 'beta',
  session_id,
  status: 'pending',
  created_at: NOW - 2 * 60_000,
  reason: 'permission_requested',
  actions: [{ command: 'approval.respond', allowed: true }],
  binding: { action: 'Bash', input_summary: 'pnpm db:migrate --env staging' },
  ...extra,
});

const askUser = (id: string, session_id: string) =>
  approval(id, session_id, {
    binding: { action: 'AskUserQuestion' },
    questions: [
      { question: 'Should refunds get their own endpoint?', header: 'API', options: [] },
    ] as never,
  });

const workflowStep = approval('step-1', 'beta-login', {
  source: { table: 'workflow_step_runs', id: 'step-1', revision: 1 },
  kind: 'workflow.approval',
  reason: 'workflow_approval',
  binding: undefined,
  actions: [{ command: 'workflow.step.decide', allowed: true }],
});
const externalRequest = approval('beta-docs', 'beta-docs', {
  source: { table: 'board_plans', id: 'beta-docs', revision: 1 },
  kind: 'external.approval',
  reason: 'external_approval',
  request_id: 'github:acme/docs#3',
  binding: undefined,
  actions: [{ command: 'external.approve', allowed: true }],
});

// A wait of another project, in a session the board does not name.
const alphaApproval = approval('approval-9', 'alpha-fix', { project_id: 'alpha' });

const leadQuestion: NeedsYouItem = {
  source: { table: 'board_plans', id: 'beta-lead', revision: 2 },
  kind: 'lead.question',
  project_id: 'beta',
  session_id: 'beta-lead',
  request_id: 'question-1',
  status: 'pending',
  created_at: NOW - 6 * 60_000,
  reason: 'lead_question',
  actions: [{ command: 'lead.question.answer', allowed: true }],
  question: { id: 'question-1', at: 0, question: 'Split the partial refund?' } as never,
};

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
  changes: { files: 3, additions: 184, deletions: 22 },
  merge: null,
  ...extra,
});

const away: NoticeWatch = {
  sessionId: 'beta-other',
  queue: null,
  listed: new Set<string>(),
  focused: true,
};
const noRespond = () => {};

// What a card shows, without the functions it carries.
const shape = (options: object) =>
  Object.fromEntries(
    Object.entries(options).flatMap(([key, value]) =>
      typeof value === 'function'
        ? []
        : key === 'actions'
          ? [[key, (value as { label: string; primary?: boolean }[]).map((a) => a.label)]]
          : [[key, value]],
    ),
  );

/** A broadcast channel of this page alone, which hands each message to the other open channels of its name at once. */
class LocalChannel {
  static open = new Set<LocalChannel>();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    LocalChannel.open.add(this);
  }
  postMessage(data: unknown) {
    for (const other of LocalChannel.open)
      if (other !== this && other.name === this.name) other.onmessage?.({ data });
  }
  close() {
    LocalChannel.open.delete(this);
  }
}

const shell = useShell.getState();
let openProjectSession: Mock<(projectId: string, sessionId: string) => void>;
let openSessionGroup: Mock<(group: string) => void>;
beforeEach(() => {
  openProjectSession = vi.fn<(projectId: string, sessionId: string) => void>();
  openSessionGroup = vi.fn<(group: string) => void>();
  useShell.setState({ openProjectSession, openSessionGroup, screen: 'insights' });
});
afterEach(() => {
  useShell.setState(shell);
});

describe('cards for what needs the user', () => {
  it('asks for an approval with the command, the wait start and allow, reject and open', () => {
    const respond = vi.fn();
    const card = needsCard(approval('approval-1', 'beta-login'), board, away, respond)!;
    expect(card.session_id).toBe('beta-login');
    expect(shape(card.options)).toEqual({
      id: 'approval-1',
      heading: 'Fix login',
      event: zh('data.noticeTiers.waitsApproval'),
      command: 'pnpm db:migrate --env staging',
      since: NOW - 2 * 60_000,
      actions: [zh('data.noticeTiers.allowOnce'), zh('data.noticeTiers.reject')],
    });
    expect(card.options.actions!.map((a) => !!a.primary)).toEqual([true, false]);
    card.options.actions![0]!.run();
    card.options.actions![1]!.run();
    expect(
      respond.mock.calls.map(([item, decision, heading]) => [item.source.id, decision, heading]),
    ).toEqual([
      ['approval-1', 'approve', 'Fix login'],
      ['approval-1', 'reject', 'Fix login'],
    ]);
    card.options.open!();
    expect(openProjectSession).toHaveBeenCalledWith('beta', 'beta-login');
  });

  it('offers allow and reject only when the approval can be answered', () => {
    const refused = approval('approval-1', 'beta-login', {
      actions: [{ command: 'approval.respond', allowed: false, disabled_reason: 'not_owner' }],
    });
    for (const item of [refused, approval('approval-2', 'beta-login', { actions: [] })]) {
      const card = needsCard(item, board, away, noRespond)!;
      expect(card.options.actions).toBeUndefined();
      expect(card.options.open).toBeTypeOf('function');
    }
  });

  it('shows a question with its text and only an open button', () => {
    const asked = needsCard(askUser('approval-2', 'beta-docs'), board, away, noRespond)!;
    expect(shape(asked.options)).toEqual({
      id: 'approval-2',
      heading: 'Write docs',
      event: zh('data.noticeTiers.asks'),
      summary: 'Should refunds get their own endpoint?',
      since: NOW - 2 * 60_000,
    });
    const lead = needsCard(leadQuestion, board, away, noRespond)!;
    expect(shape(lead.options)).toEqual({
      id: 'beta-lead:question-1',
      heading: 'Lead',
      event: zh('data.noticeTiers.asks'),
      summary: 'Split the partial refund?',
      since: NOW - 6 * 60_000,
    });
    // A request's question is answered in its session's thread.
    asked.options.open!();
    expect(openProjectSession).toHaveBeenCalledWith('beta', 'beta-docs');
  });

  it("opens a lead's question where it is answered: the needs-you strip of the runs going now, on that question", () => {
    const lead = needsCard(leadQuestion, board, away, noRespond)!;
    lead.options.open!();
    expect(openProjectSession).not.toHaveBeenCalled();
    expect(useShell.getState()).toMatchObject({
      screen: 'trace',
      traceTab: 'runs',
      runsView: 'now',
      runsSession: null,
      askedNeed: 'beta-lead:question-1',
    });
  });

  it('gives a workflow step and an external request waiting for approval a card that opens it in the needs-you strip, even while its session is in front', () => {
    const step = approval('step-1', 'beta-login', {
      source: { table: 'workflow_step_runs', id: 'step-1', revision: 1 },
      kind: 'workflow.approval',
      reason: 'workflow_approval',
      binding: undefined,
      actions: [{ command: 'workflow.step.decide', allowed: true }],
    });
    const held = approval('beta-docs', 'beta-docs', {
      source: { table: 'board_plans', id: 'beta-docs', revision: 1 },
      kind: 'external.approval',
      reason: 'external_approval',
      request_id: 'github:acme/docs#3',
      binding: undefined,
      actions: [{ command: 'external.approve', allowed: true }],
    });
    const looking = { ...away, sessionId: 'beta-login' };
    const cards = [step, held].map((item) => needsCard(item, board, looking, noRespond));
    expect(cards.map((card) => card && shape(card.options))).toEqual([
      {
        id: 'workflow_step_runs:step-1',
        heading: 'Fix login',
        event: zh('data.noticeTiers.waitsApproval'),
        summary: reasonText('workflow_approval'),
        since: NOW - 2 * 60_000,
      },
      {
        id: 'board_plans:beta-docs:github:acme/docs#3',
        heading: 'Write docs',
        event: zh('data.noticeTiers.waitsApproval'),
        summary: reasonText('external_approval'),
        since: NOW - 2 * 60_000,
      },
    ]);
    cards[0]!.options.open!();
    expect(openProjectSession).not.toHaveBeenCalled();
    expect(useShell.getState()).toMatchObject({
      screen: 'trace',
      runsView: 'now',
      askedNeed: 'workflow_step_runs:step-1',
    });
  });

  it('gives a lane whose plan waits for approval a card that opens it in the needs-you strip, saying while its review still runs', () => {
    const lane = approval('beta-docs', 'beta-docs', {
      source: { table: 'board_plans', id: 'beta-docs', revision: 1 },
      kind: 'board.lane.approval',
      reason: 'lane_plan_awaiting_approval',
      request_id: 'lane-docs',
      plan_review_running: true,
      binding: undefined,
      actions: [{ command: 'board.lane.approve', allowed: true }],
    });
    const card = needsCard(lane, board, { ...away, sessionId: 'beta-docs' }, noRespond);
    expect(card && shape(card.options)).toEqual({
      id: 'board_plans:beta-docs:lane-docs',
      heading: 'Write docs',
      event: zh('data.noticeTiers.waitsApproval'),
      summary: zh('data.reason.lanePlanAwaitingApprovalReviewing'),
      since: NOW - 2 * 60_000,
    });
    card!.options.open!();
    expect(useShell.getState()).toMatchObject({
      screen: 'trace',
      runsView: 'now',
      askedNeed: 'board_plans:beta-docs:lane-docs',
    });
    const titled = needsCard(
      { ...lane, lane_title: 'Docs lane' },
      board,
      { ...away, sessionId: 'beta-docs' },
      noRespond,
    );
    expect(titled?.options.heading).toBe('Docs lane');
  });

  it('makes the asked question the current row of the needs-you strip, brings it into view and focuses its primary button, unfolding the strip for it', () => {
    const asked = (n: number) => ({
      ...leadQuestion,
      source: { ...leadQuestion.source, id: `beta-lead-${n}` },
      unblocks: 0,
    });
    const needs = [1, 2, 3, 4].map(asked);
    const h = mount(() =>
      NeedsStrip({
        model: { now: NOW, needs } as never,
        sessions: [],
        run: async () => null,
        onOpenSession: () => {},
      }),
    );
    const list = () => find(h.value, (n) => n.type === 'ul');
    expect(list().props.children).toHaveLength(3);
    const answer = { focus: vi.fn() };
    const card = { scrollIntoView: vi.fn(), querySelector: vi.fn(() => answer) };
    list().props.ref.current = { children: [{}, {}, {}, card] };
    useShell.setState({ askedNeed: 'beta-lead-4:question-1' });
    h.render();
    expect(list().props.children).toHaveLength(4);
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(answer.focus).toHaveBeenCalled();
    expect(useShell.getState().askedNeed).toBeNull();
    const cards = () => list().props.children.map((li: ReactElement<any>) => li.props.children);
    expect(cards().map((c: ReactElement<any>) => c.props.selected)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    // Once the row has handed over its primary button, the jump focuses that one.
    const primary = { focus: vi.fn() };
    cards()[1].props.primaryRef(primary);
    answer.focus.mockClear();
    list().props.ref.current = { children: [{}, card, {}, {}] };
    useShell.setState({ askedNeed: 'beta-lead-2:question-1' });
    h.render();
    expect(primary.focus).toHaveBeenCalled();
    expect(answer.focus).not.toHaveBeenCalled();
    expect(cards()[1].props.selected).toBe(true);
  });

  it('uncovers a strip the expanded chart hides before it jumps to the asked row, and not for a row it lacks', () => {
    const needs = [{ ...leadQuestion, project_id: 'beta', unblocks: 0 }];
    let hidden = true;
    const onShow = vi.fn(() => {
      hidden = false;
    });
    const h = mount(() =>
      NeedsStrip({
        model: { now: NOW, needs } as never,
        sessions: [],
        run: async () => null,
        onOpenSession: () => {},
        hidden,
        onShow,
      }),
    );
    const answer = { focus: vi.fn() };
    const card = { scrollIntoView: vi.fn(), querySelector: vi.fn(() => answer) };
    find(h.value, (n) => n.type === 'ul').props.ref.current = { children: [card] };
    useShell.setState({ askedNeed: 'other-lead:question-1' });
    h.render();
    expect(onShow).not.toHaveBeenCalled();
    useShell.setState({ askedNeed: 'beta-lead:question-1' });
    h.render();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(answer.focus).not.toHaveBeenCalled();
    h.render();
    expect(answer.focus).toHaveBeenCalled();
    expect(useShell.getState().askedNeed).toBeNull();
  });

  it("gives no card for the session the user is looking at, nor for other needs, but one for a lead's question, which its thread does not answer", () => {
    const looking = {
      sessionId: 'beta-login',
      queue: null,
      listed: new Set<string>(),
      focused: true,
    };
    expect(needsCard(approval('approval-1', 'beta-login'), board, looking, noRespond)).toBeNull();
    expect(
      needsCard(leadQuestion, board, { ...looking, sessionId: 'beta-lead' }, noRespond),
    ).not.toBeNull();
    const behind = {
      sessionId: 'beta-login',
      queue: null,
      listed: new Set<string>(),
      focused: false,
    };
    expect(
      needsCard(approval('approval-1', 'beta-login'), board, behind, noRespond),
    ).not.toBeNull();
    const failed = { ...approval('s', 'beta-login'), kind: 'session.failed' } as NeedsYouItem;
    expect(needsCard(failed, board, away, noRespond)).toBeNull();
  });

  it('gives no card for an approval of the project whose approvals the screen answers, while the window has focus', () => {
    const listing = { sessionId: null, queue: 'beta', listed: new Set<string>(), focused: true };
    expect(needsCard(approval('approval-1', 'beta-login'), board, listing, noRespond)).toBeNull();
    expect(needsCard(leadQuestion, board, listing, noRespond)).toBeNull();
    expect(needsCard(alphaApproval, board, listing, noRespond)).not.toBeNull();
    expect(
      needsCard(
        approval('approval-1', 'beta-login'),
        board,
        { ...listing, focused: false },
        noRespond,
      ),
    ).not.toBeNull();
  });

  it('gives no card for a workflow step or an external request of the project whose needs-you strip the screen shows, while the window has focus', () => {
    const listing = { sessionId: null, queue: 'beta', listed: new Set<string>(), focused: true };
    for (const item of [workflowStep, externalRequest]) {
      expect(needsCard(item, board, listing, noRespond)).toBeNull();
      expect(needsCard(item, board, { ...listing, focused: false }, noRespond)).not.toBeNull();
      expect(needsCard(item, board, { ...listing, queue: 'alpha' }, noRespond)).not.toBeNull();
    }
  });
});

describe('cards for results and failures', () => {
  const card = (e: DaemonEvent, view = away) => {
    const found = eventCard(e, board, view);
    return found && { group: found.group, ...shape(found.options) };
  };

  it('tells a finished turn and a merge as results that open the session', () => {
    expect(card(event('turn.completed', 'turn-login'))).toEqual({
      group: 'done',
      heading: 'Fix login',
      event: zh('data.noticeTiers.turnDone'),
      tone: 'done',
    });
    expect(
      card(event('session.merged', 'beta-docs', { files: 2, additions: 9, deletions: 1 })),
    ).toEqual({
      group: 'merged',
      heading: 'Write docs',
      event: zh('data.noticeTiers.merged'),
      tone: 'done',
    });
    eventCard(event('turn.completed', 'turn-login'), board, away)!.options.open!();
    expect(openProjectSession).toHaveBeenCalledWith('beta', 'beta-login');
  });

  it('tells a failed turn by the first line of its error, with a button to see it', () => {
    const failed = eventCard(
      event('turn.failed', 'turn-login', { error: 'adapter crashed\nstack trace' }),
      board,
      away,
    )!;
    expect({ group: failed.group, ...shape(failed.options) }).toEqual({
      group: null,
      heading: 'Fix login',
      event: zh('data.noticeTiers.turnFailed'),
      tone: 'failed',
      summary: 'adapter crashed',
      actions: [zh('data.noticeTiers.seeFailure')],
    });
    expect(failed.options.open).toBeUndefined();
    failed.options.actions![0]!.run();
    expect(openProjectSession).toHaveBeenCalledWith('beta', 'beta-login');
  });

  it('tells failed checks by the failing command and how many failed, and a blocked merge by its reason', () => {
    const results = [
      { name: 'lint', exit_code: 0 },
      { name: 'pnpm test:integration', exit_code: 1 },
      { name: 'typecheck', exit_code: 0, timed_out: true },
    ];
    expect(card(event('session.gate_checked', 'beta-login', { results }))).toEqual({
      group: null,
      heading: 'Fix login',
      event: zh('data.noticeTiers.checksFailed'),
      tone: 'failed',
      command: 'pnpm test:integration',
      summary: '2 项不过',
      actions: [zh('data.noticeTiers.seeFailure')],
    });
    expect(
      card(
        event('session.gate_checked', 'beta-login', { results: [{ name: 'lint', exit_code: 0 }] }),
      ),
    ).toBeNull();
    expect(card(event('session.merge_blocked', 'beta-docs', { reason: 'gate_failed' }))).toEqual({
      group: null,
      heading: 'Write docs',
      event: zh('data.noticeTiers.mergeBlocked'),
      tone: 'failed',
      summary: reasonText('gate_failed'),
      actions: [zh('data.noticeTiers.seeFailure')],
    });
  });

  it('gives no card for the session in front of the user, a change story, or an unknown kind', () => {
    const looking = {
      sessionId: 'beta-login',
      queue: null,
      listed: new Set<string>(),
      focused: true,
    };
    expect(card(event('turn.completed', 'turn-login'), looking)).toBeNull();
    expect(card(event('turn.failed', 'turn-login'), looking)).toBeNull();
    expect(card(event('turn.completed', 'turn-story'))).toBeNull();
    expect(card(event('session.opened', 'beta-login'))).toBeNull();
  });

  it('waits on a turn whose session the board does not name yet', () => {
    expect(eventCard(event('turn.completed', 'turn-later'), board, away)).toBeUndefined();
  });

  it('tells a session that became ready with its changed lines, and none from the first list', () => {
    const before = [session('a', 'running'), session('b', 'ready')];
    const after = [
      session('a', 'ready', { gate: { state: 'passed', passed: 2, failed: 0, running: 0 } }),
      session('b', 'ready'),
    ];
    const cards = reviewCards(before, after, 'beta', away);
    expect(cards.map((c) => ({ group: c.group, passed: c.passed, ...shape(c.options) }))).toEqual([
      {
        group: 'review',
        passed: true,
        heading: 'title of a',
        event: zh('data.noticeTiers.review'),
        tone: 'review',
        diff: { additions: 184, deletions: 22 },
      },
    ]);
    cards[0]!.options.open!();
    expect(openProjectSession).toHaveBeenCalledWith('beta', 'a');
    expect(reviewCards(null, after, 'beta', away)).toEqual([]);
    expect(
      reviewCards(before, after, 'beta', {
        sessionId: 'a',
        queue: null,
        listed: new Set<string>(),
        focused: true,
      }),
    ).toEqual([]);
  });

  it('names the sessions that stopped waiting', () => {
    expect(
      stoppedWaiting(
        [session('a', 'waiting'), session('b', 'waiting'), session('c', 'running')],
        [session('a', 'running'), session('b', 'waiting'), session('c', 'waiting')],
      ),
    ).toEqual(['a']);
    expect(stoppedWaiting(null, [session('a', 'running')])).toEqual([]);
  });

  it("folds results of one kind into a card that opens its project's group of them", () => {
    expect(shape(groupCard('review', 'beta', 3, true))).toEqual({
      id: 'notice-group-review-beta',
      heading: '3 个会话可以审阅',
      tone: 'review',
      summary: zh('data.noticeTiers.allPassed'),
    });
    expect(shape(groupCard('review', 'beta', 4, false))).toEqual({
      id: 'notice-group-review-beta',
      heading: '4 个会话可以审阅',
      tone: 'review',
    });
    expect(shape(groupCard('done', 'beta', 3, false)).heading).toBe('3 个会话回合完成');
    expect(shape(groupCard('merged', 'beta', 3, false)).heading).toBe('3 个会话已合并');
    const opened = (group: 'review' | 'done' | 'merged') => {
      useCurrentProject.setState({ projectId: 'alpha' });
      groupCard(group, 'beta', 3, false).open!();
      return [useCurrentProject.getState().projectId, openSessionGroup.mock.lastCall?.[0]];
    };
    expect(opened('review')).toEqual(['beta', 'review']);
    expect(opened('done')).toEqual(['beta', 'review']);
    expect(opened('merged')).toEqual(['beta', 'merged']);
  });

  it('gives cards only for the events after the first look, and keeps a turn its board has not named', () => {
    const old = event('turn.completed', 'turn-login');
    const first = liveCards(null, { board, events: [old], resync: 0 }, away);
    expect(first.cards).toEqual([]);
    const later = event('turn.completed', 'turn-later');
    const fresh = event('turn.completed', 'turn-docs');
    const next = liveCards(first.cursor, { board, events: [old, later, fresh], resync: 0 }, away);
    expect(next.cards.map((c) => c.options.heading)).toEqual(['Write docs']);
    const named = {
      ...board,
      session_turns: [...board.session_turns, { id: 'turn-later', session_id: 'beta-login' }],
    } as BoardSnapshot;
    const last = liveCards(
      next.cursor,
      { board: named, events: [old, later, fresh], resync: 0 },
      away,
    );
    expect(last.cards.map((c) => c.options.heading)).toEqual(['Fix login']);
    const resynced = liveCards(
      last.cursor,
      { board, events: [event('turn.completed', 'turn-docs')], resync: 1 },
      away,
    );
    expect(resynced.cards).toEqual([]);
  });
});

// The parts of Base UI's store the viewport drives; its base class's types do not resolve from here.
interface StoreView {
  state: {
    toasts: {
      id: string;
      title?: unknown;
      transitionStatus?: string;
      data?: { card?: Record<string, unknown> };
    }[];
  };
  addToast(options: object): string;
  closeToast(id?: string): void;
}

function mountStore() {
  const provider = Toasts() as ReactElement<{ limit: number; timeout: number }>;
  const store: StoreView = new ToastStore({
    timeout: provider.props.timeout,
    limit: 10,
    viewport: null,
    toasts: [],
    hovering: false,
    focused: false,
    isWindowFocused: true,
    prevFocusElement: null,
  }) as unknown as StoreView;
  const stop = toastManager[' subscribe'](({ action, options }) =>
    action === 'close' ? store.closeToast(options.id) : store.addToast(options),
  );
  const live = () => store.state.toasts.filter((one) => one.transitionStatus !== 'ending');
  return { stop, live, shown: () => live().map((one) => one.title) };
}

describe('the notice feed', () => {
  let mounted: ReturnType<typeof mountStore>;
  let focused: boolean;
  let command: ReturnType<typeof vi.fn>;
  let props: Parameters<typeof NoticeFeed>[0];
  let host: HookHost<null>;
  const boardState = useBoard.getState();
  const render = (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    host.render();
  };
  const card = (heading: string) =>
    mounted.live().find((one) => one.title === heading)?.data?.card as
      | { actions?: { label: string; run: () => void }[]; open?: () => void; summary?: string }
      | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    focused = true;
    vi.stubGlobal('document', { activeElement: null, hasFocus: () => focused });
    command = vi.fn(async () => ({ ok: true, value: {} }));
    vi.stubGlobal('window', { pantheon: { command } });
    useBoard.setState({ board, events: [], resync: 0 });
    mounted = mountStore();
    props = { projectId: 'beta', sessions: null, allNeeds: null };
    host = new HookHost(() => NoticeFeed(props));
  });
  afterEach(() => {
    host.unmount();
    toastManager.close();
    mounted.stop();
    useBoard.setState(boardState);
    setNotificationPrefs(DEFAULT_NOTIFICATIONS);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('replaces a card shown again under the same id', () => {
    noticeNeeds({ id: 'approval-1', heading: 'first' });
    noticeNeeds({ id: 'approval-1', heading: 'second' });
    expect(mounted.shown()).toEqual(['second']);
  });

  it('is mounted with the app-wide hooks', () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const hooks = new HookHost(() =>
      BackgroundHooks({ projectId: 'beta', sessions: null, allNeeds: null }),
    );
    const tree = hooks.render() as ReactElement<typeof props> | null;
    hooks.unmount();
    expect(tree?.type).toBe(NoticeFeed);
    expect(tree?.props).toEqual({ projectId: 'beta', sessions: null, allNeeds: null });
  });

  it('titles the window with the project and how many wait for the user in every project', () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const doc = { activeElement: null, hasFocus: () => true, title: '' };
    vi.stubGlobal('document', doc);
    let hookProps: Parameters<typeof BackgroundHooks>[0] = {
      projectId: 'beta',
      sessions: null,
      allNeeds: [approval('approval-1', 'beta-login'), alphaApproval, leadQuestion],
    };
    const hooks = mount(() => BackgroundHooks(hookProps));
    expect(doc.title).toBe('Beta app · 3 个等你');
    hookProps = { ...hookProps, allNeeds: [] };
    hooks.render();
    expect(doc.title).toBe('Beta app');
    hookProps = { ...hookProps, projectId: null };
    hooks.render();
    expect(doc.title).toBe('Pantheon');
    hooks.unmount();
  });

  it('gives the badge up to five sessions that wait for the user, titled as the sidebar names them', async () => {
    const setBadge = vi.fn(async (_count: number, _waiting?: unknown) => {});
    vi.stubGlobal('window', {
      pantheon: {
        command,
        setBadge,
        onNotificationClick: () => () => {},
        query: async () => ({ ok: false, error: { code: 'offline', message: 'offline' } }),
      },
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal('document', { activeElement: null, hasFocus: () => true, title: '' });
    const allNeeds = [
      approval('approval-1', 'beta-login'),
      approval('approval-2', 'beta-login'),
      leadQuestion,
      alphaApproval,
      approval('approval-3', 'beta-docs', {
        kind: 'session.failed',
        source: { table: 'sessions', id: 'beta-docs', revision: 1 },
        status: 'open',
      }),
      approval('approval-4', 'beta-docs'),
      approval('approval-5', 'beta-extra'),
      approval('approval-6', 'beta-more'),
    ];
    const hooks = mount(() =>
      BackgroundHooks({
        projectId: 'beta',
        sessions: [session('beta-login', 'waiting')],
        allNeeds,
      }),
    );
    await hooks.flush();
    expect(setBadge).toHaveBeenLastCalledWith(7, [
      { project_id: 'beta', session_id: 'beta-login', title: 'title of beta-login' },
      { project_id: 'beta', session_id: 'beta-lead', title: 'Lead' },
      { project_id: 'alpha', session_id: 'alpha-fix', title: 'Alpha app' },
      { project_id: 'beta', session_id: 'beta-docs', title: 'Write docs' },
      { project_id: 'beta', session_id: 'beta-extra', title: 'Beta app' },
    ]);
    hooks.unmount();
  });

  it('shows the waits present at start once each, and no results that ended before', () => {
    useBoard.setState({ events: [event('turn.completed', 'turn-login')] });
    render({
      allNeeds: [approval('approval-1', 'beta-login'), askUser('approval-2', 'beta-docs')],
    });
    expect(mounted.shown()).toEqual(['Write docs', 'Fix login']);
    render({
      allNeeds: [approval('approval-1', 'beta-login'), askUser('approval-2', 'beta-docs')],
    });
    useBoard.setState({ events: [...useBoard.getState().events] });
    render();
    expect(mounted.shown()).toEqual(['Write docs', 'Fix login']);
  });

  it('shows nothing for the session in front of the user', () => {
    useShell.setState({ screen: 'sessions', sessionId: 'beta-login' });
    render({ allNeeds: [approval('approval-1', 'beta-login')] });
    render();
    useBoard.setState({ events: [event('turn.completed', 'turn-login')] });
    render();
    expect(mounted.shown()).toEqual([]);
  });

  it("shows a lead's question while the lead session is in front, since its thread does not answer it", () => {
    useShell.setState({ screen: 'sessions', sessionId: 'beta-lead' });
    render({ sessions: [session('beta-lead', 'waiting')], allNeeds: [leadQuestion] });
    render();
    expect(mounted.shown()).toEqual(['Lead']);
  });

  it('shows nothing for the session a session window shows in front, and keeps the cards shown before its word', async () => {
    vi.stubGlobal('BroadcastChannel', LocalChannel);
    const appFocused = vi.fn(async () => true);
    vi.stubGlobal('window', { pantheon: { command, appFocused } });
    focused = false;
    render({ allNeeds: [approval('approval-1', 'beta-login')] });
    expect(mounted.shown()).toEqual(['Fix login']);
    const sessionWindow = new LocalChannel(WATCH_CHANNEL);
    sessionWindow.postMessage({ window: 'window-1', session_id: 'beta-login' });
    render();
    const later = [
      approval('approval-1', 'beta-login'),
      approval('approval-3', 'beta-login'),
      approval('approval-4', 'beta-docs'),
    ];
    render({ allNeeds: later });
    useBoard.setState({
      events: [event('turn.failed', 'turn-login'), event('turn.failed', 'turn-docs')],
    });
    render();
    await host.flush();
    expect(mounted.shown()).toEqual(['Write docs', 'Write docs', 'Fix login']);
    sessionWindow.postMessage({ window: 'window-1', session_id: null });
    render({ allNeeds: [...later, approval('approval-5', 'beta-login')] });
    expect(mounted.shown()).toEqual(['Fix login', 'Write docs', 'Write docs', 'Fix login']);
    sessionWindow.close();
  });

  it.each([
    [
      'waits for the session list before telling whether the followed session is in front',
      'beta-login',
      [],
    ],
    [
      'shows the card once the session list names another session in front',
      'beta-docs',
      ['Fix login'],
    ],
  ])('%s', (_name, followed, shown) => {
    useShell.setState({ screen: 'sessions', sessionId: null, followed });
    render({ allNeeds: [approval('approval-1', 'beta-login')] });
    expect(mounted.shown()).toEqual([]);
    render({ sessions: [session('beta-login', 'waiting'), session('beta-docs', 'running')] });
    expect(mounted.shown()).toEqual(shown);
  });

  it('keeps the cards while the needs-you group is open, which lists sessions and answers nothing', () => {
    useShell.setState({ screen: 'sessions', sessionId: null, sessionGroup: 'inbox' });
    render({ sessions: [], allNeeds: [approval('approval-1', 'beta-login'), alphaApproval] });
    expect(mounted.shown()).toEqual(['Alpha app', 'Fix login']);
  });

  it("gives no card for a lead's question while the runs going now show, since their needs-you strip answers it", () => {
    useShell.setState({ screen: 'trace', traceTab: 'runs', runsView: 'now' });
    render({ allNeeds: [approval('approval-1', 'beta-login'), leadQuestion] });
    expect(mounted.shown()).toEqual([]);
  });

  it('takes the cards of a workflow step and an external request away on arriving at the needs-you strip that answers them', () => {
    render({ allNeeds: [workflowStep, externalRequest] });
    expect(mounted.shown()).toEqual(['Write docs', 'Fix login']);
    useShell.setState({ screen: 'trace', traceTab: 'runs', runsView: 'now' });
    render();
    expect(mounted.shown()).toEqual([]);
  });

  it("shows only another project's waits while the runs tab shows the runs going now", () => {
    const waits = [approval('approval-1', 'beta-login'), alphaApproval];
    useShell.setState({ screen: 'trace', traceTab: 'runs', runsView: 'now' });
    render({ allNeeds: waits });
    expect(mounted.shown()).toEqual(['Alpha app']);
    useShell.setState({ screen: 'trace', traceTab: 'timeline', runsView: 'now' });
    render({ allNeeds: [...waits, approval('approval-3', 'beta-docs')] });
    useShell.setState({ screen: 'trace', traceTab: 'runs', runsView: 'history' });
    render({
      allNeeds: [
        ...waits,
        approval('approval-3', 'beta-docs'),
        approval('approval-4', 'beta-lead'),
      ],
    });
    expect(mounted.shown()).toEqual(['Lead', 'Write docs', 'Alpha app']);
  });

  it('gives no card for an approval the board lists, and a card for one its list folds away until the list shows it', () => {
    useShell.setState({ screen: 'board', boardWaits: new Set(['approval-1']) });
    render({
      allNeeds: [
        approval('approval-1', 'beta-login'),
        approval('approval-3', 'beta-docs'),
        leadQuestion,
      ],
    });
    vi.advanceTimersByTime(BOARD_LIST_HOLD_MS);
    expect([...mounted.shown()].sort()).toEqual(['Lead', 'Write docs']);
    useShell.setState({ boardWaits: new Set(['approval-1', 'approval-3']) });
    render();
    expect(mounted.shown()).toEqual(['Lead']);
  });

  it('gives no card for an approval the needs-you list shows while the chart answers another', () => {
    useShell.setState({
      screen: 'board',
      boardWaits: new Set(['approval-3']),
      stripWaits: new Set(['approval-1']),
    });
    render({
      allNeeds: [
        approval('approval-1', 'beta-login'),
        approval('approval-3', 'beta-docs'),
        leadQuestion,
      ],
    });
    vi.advanceTimersByTime(BOARD_LIST_HOLD_MS);
    expect(mounted.shown()).toEqual(['Lead']);
    useShell.setState({ stripWaits: null });
  });

  it('gives no card for a lead question the needs-you list shows', () => {
    useShell.setState({
      screen: 'board',
      boardWaits: new Set(),
      stripWaits: new Set(['beta-lead:question-1']),
    });
    render({ allNeeds: [leadQuestion, alphaApproval] });
    vi.advanceTimersByTime(BOARD_LIST_HOLD_MS);
    expect(mounted.shown()).toEqual(['Alpha app']);
    useShell.setState({ stripWaits: null });
  });

  it('holds the card of an approval that arrives while the board shows, and gives none when the board lists it within the hold', () => {
    useShell.setState({ screen: 'board', boardWaits: new Set() });
    render({ allNeeds: [approval('approval-1', 'beta-login'), alphaApproval] });
    expect(mounted.shown()).toEqual(['Alpha app']);
    useShell.setState({ boardWaits: new Set(['approval-1']) });
    render();
    vi.advanceTimersByTime(BOARD_LIST_HOLD_MS);
    expect(mounted.shown()).toEqual(['Alpha app']);
  });

  it('keeps holding an approval while the board in front has not listed its waits, then gives a card only if the list leaves it out', () => {
    useShell.setState({ screen: 'board', boardWaits: null });
    render({
      allNeeds: [approval('approval-1', 'beta-login'), approval('approval-3', 'beta-docs')],
    });
    vi.advanceTimersByTime(BOARD_LIST_HOLD_MS * 2);
    expect(mounted.shown()).toEqual([]);
    useShell.setState({ boardWaits: new Set(['approval-1']) });
    render();
    expect(mounted.shown()).toEqual(['Write docs']);
  });

  it('drops an approval held past the hold once it is answered before the board lists its waits', () => {
    useShell.setState({ screen: 'board', boardWaits: null });
    render({ allNeeds: [approval('approval-1', 'beta-login')] });
    vi.advanceTimersByTime(BOARD_LIST_HOLD_MS);
    render({ allNeeds: [] });
    useShell.setState({ boardWaits: new Set() });
    render();
    expect(mounted.shown()).toEqual([]);
  });

  it('drops a held card whose approval is answered within the hold', () => {
    useShell.setState({ screen: 'board', boardWaits: new Set() });
    render({ allNeeds: [approval('approval-1', 'beta-login')] });
    render({ allNeeds: [] });
    vi.advanceTimersByTime(BOARD_LIST_HOLD_MS);
    expect(mounted.shown()).toEqual([]);
  });

  it('takes a card away on arriving where its wait is in view, and does not show it again after', () => {
    const waits = [
      approval('approval-1', 'beta-login'),
      approval('approval-3', 'beta-docs'),
      approval('approval-4', 'beta-lead'),
      alphaApproval,
    ];
    render({ allNeeds: waits });
    expect(mounted.shown()).toEqual(['Alpha app', 'Lead', 'Write docs', 'Fix login']);
    useShell.setState({ screen: 'sessions', sessionId: 'beta-login' });
    render();
    expect(mounted.shown()).toEqual(['Alpha app', 'Lead', 'Write docs']);
    useShell.setState({ screen: 'trace', traceTab: 'runs', runsView: 'now' });
    render();
    expect(mounted.shown()).toEqual(['Alpha app']);
    useShell.setState({ screen: 'insights' });
    render({ allNeeds: [...waits] });
    expect(mounted.shown()).toEqual(['Alpha app']);
  });

  it('answers an approval from its card and tells why when the answer fails', async () => {
    render({
      allNeeds: [approval('approval-1', 'beta-login'), approval('approval-3', 'beta-docs')],
    });
    card('Fix login')!.actions![0]!.run();
    await host.flush();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]![0]).toMatchObject({
      type: 'approval.respond',
      input: { approval_id: 'approval-1', decision: 'approve' },
      expected_revision: 3,
    });
    const error = { code: 'approval_not_pending', message: 'gone' };
    command.mockResolvedValueOnce({ ok: false, error });
    card('Write docs')!.actions![1]!.run();
    await host.flush();
    expect(command.mock.calls[1]![0]).toMatchObject({
      input: { approval_id: 'approval-3', decision: 'reject' },
    });
    expect(card('Write docs')?.summary).toBe(failureText(error));
  });

  it('takes a card away once its wait is answered elsewhere', () => {
    render({
      sessions: [session('beta-login', 'waiting'), session('beta-docs', 'waiting')],
      allNeeds: [approval('approval-1', 'beta-login'), askUser('approval-2', 'beta-docs')],
    });
    expect(mounted.shown()).toEqual(['Write docs', 'Fix login']);
    render({ allNeeds: [askUser('approval-2', 'beta-docs')] });
    expect(mounted.shown()).toEqual(['Write docs']);
    render({ sessions: [session('beta-login', 'running'), session('beta-docs', 'running')] });
    expect(mounted.shown()).toEqual([]);
  });

  it("folds a third result of one kind into one card, counts the next, and opens the project's group", () => {
    const gate = { state: 'passed', passed: 1, failed: 0, running: 0 } as const;
    const ids = ['a', 'b', 'c', 'd'];
    render({ sessions: ids.map((id) => session(id, 'running')) });
    const ready = (n: number) =>
      render({
        sessions: ids.map((id, i) =>
          i < n ? session(id, 'ready', { gate }) : session(id, 'running'),
        ),
      });
    ready(1);
    ready(2);
    expect(mounted.shown()).toEqual(['title of b', 'title of a']);
    ready(3);
    expect(mounted.shown()).toEqual(['3 个会话可以审阅']);
    expect(card('3 个会话可以审阅')?.summary).toBe(zh('data.noticeTiers.allPassed'));
    ready(4);
    expect(mounted.shown()).toEqual(['4 个会话可以审阅']);
    useCurrentProject.setState({ projectId: 'alpha' });
    card('4 个会话可以审阅')!.open!();
    expect(useCurrentProject.getState().projectId).toBe('beta');
    expect(openSessionGroup).toHaveBeenCalledWith('review');
    useBoard.setState({ events: [event('turn.completed', 'turn-login')] });
    render();
    vi.advanceTimersByTime(TURN_END_HOLD_MS);
    expect(mounted.shown()).toEqual(['Fix login', '4 个会话可以审阅']);
  });

  it('shows the card of a wait again when it leaves the list and comes back', () => {
    render({ allNeeds: [approval('approval-1', 'beta-login')] });
    expect(mounted.shown()).toEqual(['Fix login']);
    render({ allNeeds: [] });
    expect(mounted.shown()).toEqual([]);
    render({ allNeeds: [approval('approval-1', 'beta-login')] });
    expect(mounted.shown()).toEqual(['Fix login']);
  });

  it('folds only the results of one project together', () => {
    const merged = (id: string, project_id: string) => ({
      ...event('session.merged', id),
      project_id,
    });
    useBoard.setState({
      board: {
        ...board,
        sessions: [
          ...board.sessions,
          { id: 'alpha-api', project_id: 'alpha', native_title: 'Ship API' },
        ],
      } as unknown as BoardSnapshot,
    });
    render();
    const events = [merged('beta-login', 'beta'), merged('beta-docs', 'beta')];
    useBoard.setState({ events });
    render();
    useBoard.setState({ events: [...events, merged('alpha-api', 'alpha')] });
    render();
    expect(mounted.shown()).toEqual(['Ship API', 'Write docs', 'Fix login']);
  });

  it('shows no card in the quiet hours', async () => {
    const settings = {
      attention_delivery: DEFAULT_ATTENTION_DELIVERY,
      quiet_hours: { from: '08:00', to: '10:00' },
    };
    vi.stubGlobal('window', {
      pantheon: {
        command,
        notify: async () => {},
        onNotificationClick: () => () => {},
        query: async (method: string) => ({
          ok: true,
          value: method === 'app.settings' ? settings : [],
        }),
      },
      addEventListener() {},
      removeEventListener() {},
    });
    // The daemon's quiet hours reach the feed through the app-wide notices.
    const notices = new HookHost(() => useNotices('beta', null, null));
    notices.render();
    await notices.flush();
    render({
      sessions: [session('a', 'running')],
      allNeeds: [approval('approval-1', 'beta-login')],
    });
    useBoard.setState({ events: [event('turn.completed', 'turn-login')] });
    render({ sessions: [session('a', 'ready')] });
    expect(mounted.shown()).toEqual([]);
    notices.unmount();
  });
});
