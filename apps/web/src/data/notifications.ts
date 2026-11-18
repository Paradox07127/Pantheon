import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ATTENTION_KINDS,
  DEFAULT_ATTENTION_DELIVERY,
  deliveryFor,
  withinHours,
  type AppSettings,
  type AttentionDelivery,
  type AttentionKind,
  type BoardSnapshot,
  type NotificationTarget,
  type WorkbenchSession,
} from '@pantheon/protocol';
import { waitingSessions } from '../components/NeedsYou';
import { needKey } from '../screens/board/frame-model';
import { pendingPermissions, sessionRow } from '../screens/sessions/model';
import { t, type Message } from '../i18n';
import { listText } from '../lib/list-text';
import { useShell } from '../store';
import { useAppSettings, type AppSettingsPatch } from './app-settings';
import { useBoard } from './board';
import { focusRequest } from './focus-request';
import { answeredInStrip, becameReady, needsKey, needsSession, turnEndHold } from './notice-tiers';
import { needReasonText, reasonText, type NeedsYouItem } from './needs-you';
import { visibleProjects } from './projects';
import type { DaemonEvent, SyncView } from './sync';
import { sessionTitle } from './transcript';
import { readQuery, useFocusTick, useRefetchTick } from './workbench-sessions';

/** A system notification and the session a click on it opens. */
export interface Notice {
  title: string;
  body: string;
  target: NotificationTarget;
  silent?: boolean;
  /** The approval whose request card a click on the notice asks for; kept out of the notice itself. */
  request?: string;
  /** The needs-you card a click on the notice opens, for a wait no thread answers; kept out of the notice itself. */
  need?: string;
}

/** The events a notice is about. */
export type NoticeEvent =
  | 'approval_requested'
  | 'question_asked'
  | 'turn_completed'
  | 'ready_for_review'
  | 'merged'
  | 'turn_failed'
  | 'gate_failed'
  | 'merge_blocked';

/** What this computer keeps: whether notices play their sound, the dock badge and keeping awake. */
export interface NotificationPrefs {
  sound: boolean;
  badge: boolean;
  /** The desktop app keeps the computer awake while a session runs. */
  keep_awake: boolean;
}

export const NOTIFICATIONS_KEY = 'pantheon.notifications.v3';
/** Where an earlier version kept a switch per event; mapped once into the daemon's rules. */
export const EARLIER_NOTIFICATIONS_KEY = 'pantheon.notifications.v2';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A typed time of day as HH:MM, a one-digit hour padded; null when it is not one. */
export function readQuietTime(typed: string): string | null {
  const time = typed.trim().replace(/^(\d):/, '0$1:');
  return TIME.test(time) ? time : null;
}

export const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  sound: true,
  badge: true,
  keep_awake: true,
};

/** The stored preferences; anything unreadable is the default. */
export function readNotificationPrefs(raw: string | null): NotificationPrefs {
  let value: unknown = null;
  try {
    value = JSON.parse(raw ?? 'null');
  } catch {
    // The defaults apply.
  }
  const v = value as { sound?: unknown; badge?: unknown; keep_awake?: unknown } | null;
  const d = DEFAULT_NOTIFICATIONS;
  const flag = (given: unknown, fallback: boolean) =>
    typeof given === 'boolean' ? given : fallback;
  return {
    sound: flag(v?.sound, d.sound),
    badge: flag(v?.badge, d.badge),
    keep_awake: flag(v?.keep_awake, d.keep_awake),
  };
}

function loadNotificationPrefs(): NotificationPrefs {
  try {
    return readNotificationPrefs(
      localStorage.getItem(NOTIFICATIONS_KEY) ?? localStorage.getItem(EARLIER_NOTIFICATIONS_KEY),
    );
  } catch {
    return DEFAULT_NOTIFICATIONS;
  }
}

let prefs = loadNotificationPrefs();
const prefListeners = new Set<() => void>();
const subscribePrefs = (listener: () => void) => {
  prefListeners.add(listener);
  return () => void prefListeners.delete(listener);
};

export const getNotificationPrefs = () => prefs;

export function setNotificationPrefs(patch: Partial<NotificationPrefs>) {
  prefs = { ...prefs, ...patch };
  prefListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(prefs));
  } catch {
    // The choice still applies for this session.
  }
}

export function useNotificationPrefs(): NotificationPrefs {
  return useSyncExternalStore(subscribePrefs, getNotificationPrefs, getNotificationPrefs);
}

/** Takes up the preferences another window stores. */
function useStoredPrefs() {
  useEffect(() => {
    const follow = (e: StorageEvent) => {
      if (e.key !== NOTIFICATIONS_KEY) return;
      prefs = readNotificationPrefs(e.newValue);
      prefListeners.forEach((listener) => listener());
    };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, []);
}

/** The daemon's rules for how each kind reaches the user, and its quiet hours. */
export type DeliveryRules = Pick<AppSettings, 'attention_delivery' | 'quiet_hours'>;

// The rules the notices last read; none before the first read.
let rules: DeliveryRules | null = null;

export const getDeliveryRules = () => rules;

/** Whether a needs-you item or a notice of a kind sends its system notice now; every one does before the rules are read. */
export const noticeNow = (
  item: { decision?: AttentionKind; created_at: number },
  r: DeliveryRules | null = rules,
  now = Date.now(),
): boolean =>
  !r ||
  deliveryFor(r, { decision: item.decision ?? 'other', created_at: item.created_at }, now) ===
    'now';

/** Whether a notice about the session sends now: by the rule of its needs-you item, else of other. */
export const sessionNoticeNow = (
  sessionId: string,
  items: readonly NeedsYouItem[] | null,
  r: DeliveryRules | null = rules,
): boolean =>
  noticeNow(
    items?.find((item) => needsSession(item) === sessionId) ?? {
      decision: 'other',
      created_at: Date.now(),
    },
    r,
  );

// Named so the message extractor reads these descriptors as messages.
const defineMessage = (message: Message): Message => message;

/** Each kind's name, in the order the settings list them. */
export const DECISION_NAME: Record<AttentionKind, Message> = {
  plan_change: defineMessage({
    id: 'settings.notifications.planChange',
    defaultMessage: 'Plan change',
  }),
  question: defineMessage({ id: 'settings.notifications.question', defaultMessage: 'Question' }),
  repeated_failure: defineMessage({
    id: 'settings.notifications.repeatedFailure',
    defaultMessage: 'Failed twice',
  }),
  permission: defineMessage({
    id: 'settings.notifications.permission',
    defaultMessage: 'Permission request',
  }),
  milestone_accept: defineMessage({
    id: 'settings.notifications.milestoneAccept',
    defaultMessage: 'Milestone to accept',
  }),
  agent_proposal: defineMessage({
    id: 'settings.notifications.agentProposal',
    defaultMessage: 'New agent',
  }),
  budget: defineMessage({ id: 'settings.notifications.budget', defaultMessage: 'Budget' }),
  improvement: defineMessage({
    id: 'settings.notifications.improvement',
    defaultMessage: 'Improvement',
  }),
  external: defineMessage({
    id: 'settings.notifications.external',
    defaultMessage: 'External approval',
  }),
  other: defineMessage({ id: 'settings.notifications.other', defaultMessage: 'Other' }),
  merged: defineMessage({ id: 'settings.notifications.merged', defaultMessage: 'Merged' }),
};

/** Each way a kind of decision can reach the user. */
export const DELIVERY_NAME: Record<AttentionDelivery, Message> = {
  now: defineMessage({ id: 'settings.notifications.now', defaultMessage: 'Now' }),
  brief: defineMessage({ id: 'settings.notifications.brief', defaultMessage: 'Brief only' }),
  never: defineMessage({ id: 'settings.notifications.never', defaultMessage: 'Never' }),
};

function readEarlier(raw: string) {
  try {
    return JSON.parse(raw) as {
      events?: Partial<Record<NoticeEvent, { system?: unknown } | null>>;
      quiet_hours?: unknown;
      quiet_start?: unknown;
      quiet_end?: unknown;
    } | null;
  } catch {
    return null;
  }
}

/**
 * The earlier per-event switches as the daemon's rules: a switched-off event waits for the brief;
 * turn ends and reviews follow other only when both were off.
 */
export function earlierRules(raw: string): AppSettingsPatch {
  const earlier = readEarlier(raw);
  const on = (event: NoticeEvent) => earlier?.events?.[event]?.system !== false;
  const rule = (now: boolean): AttentionDelivery => (now ? 'now' : 'brief');
  const time = (given: unknown, fallback: string) =>
    typeof given === 'string' && TIME.test(given) ? given : fallback;
  return {
    attention_delivery: {
      permission: rule(on('approval_requested')),
      question: rule(on('question_asked')),
      repeated_failure: rule(on('gate_failed') || on('turn_failed')),
      ...(!on('merged') && { merged: 'brief' as const }),
      ...(!on('turn_completed') && !on('ready_for_review') && { other: 'brief' as const }),
    },
    ...(earlier?.quiet_hours === true && {
      quiet_hours: {
        from: time(earlier.quiet_start, '22:00'),
        to: time(earlier.quiet_end, '08:00'),
      },
    }),
  };
}

/**
 * Maps the per-event switches an earlier version stored into the daemon's rules once, while those
 * are still the defaults, and keeps the rest of them under the current key.
 */
function useEarlierPrefs(settings: AppSettings | null, save: (patch: AppSettingsPatch) => void) {
  useEffect(() => {
    if (!settings) return;
    try {
      const raw = localStorage.getItem(EARLIER_NOTIFICATIONS_KEY);
      if (raw === null) return;
      const untouched =
        !settings.quiet_hours &&
        ATTENTION_KINDS.every(
          (kind) => settings.attention_delivery[kind] === DEFAULT_ATTENTION_DELIVERY[kind],
        );
      if (untouched) save(earlierRules(raw));
      setNotificationPrefs({});
      localStorage.removeItem(EARLIER_NOTIFICATIONS_KEY);
    } catch {
      // Storage is out of reach; the daemon's rules stand.
    }
  }, [settings]);
}

const EVENT_KINDS: Record<string, NoticeEvent> = {
  'turn.completed': 'turn_completed',
  'turn.failed': 'turn_failed',
  'session.gate_checked': 'gate_failed',
  'session.merged': 'merged',
  'session.merge_blocked': 'merge_blocked',
};

// A turn end, a review or a merge comes without sound.
const SILENT: readonly NoticeEvent[] = ['turn_completed', 'ready_for_review', 'merged'];

// Spread into a notice; the system's sound plays unless silent.
const sound = (event: NoticeEvent, p: NotificationPrefs) =>
  p.sound && !SILENT.includes(event) ? {} : { silent: true };

/** The ids of the events already looked at, since the last resync. */
export interface NoticeCursor {
  resync: number;
  seen: ReadonlySet<string>;
}

interface Request {
  tool?: string;
  questions?: readonly { question: string }[];
}

const TURN_ENDS: readonly string[] = ['turn.completed', 'turn.failed'];

// The turn end notices, which wait a moment for a review or a baseline's wait of their session to replace them.
const turnEnds = new WeakSet<Notice>();

const reasonDetail = (reason: string, detail: string): string =>
  t(
    { id: 'data.notifications.reasonDetail', defaultMessage: '{reason}: {detail}' },
    { reason, detail },
  );

function requestBody(request: Request | undefined, baseline: boolean): string {
  const reason = reasonText('permission_requested');
  return (
    request?.questions?.[0]?.question ??
    (request?.tool
      ? reasonDetail(reason, request.tool)
      : baseline
        ? t({
            id: 'data.notifications.baselinePending',
            defaultMessage: 'Baseline awaiting confirmation',
          })
        : reason)
  );
}

/** The sessions waiting now but not in the previous list; none when there is no previous list. */
export function newlyWaiting(
  previous: readonly WorkbenchSession[] | null,
  sessions: readonly WorkbenchSession[],
): WorkbenchSession[] {
  if (!previous) return [];
  const before = new Set(waitingSessions(previous).map((s) => s.id));
  return waitingSessions(sessions).filter((s) => !before.has(s.id));
}

/** The system notification of a waiting session: its title, and its newest request or the baseline review as the reason. */
export function waitNotice(
  session: WorkbenchSession,
  events: readonly DaemonEvent[],
): { title: string; body: string } {
  return {
    title: sessionRow(session).title,
    body: requestBody(pendingPermissions(events, session.id).at(-1), session.workspace_id === null),
  };
}

function eventBody(event: DaemonEvent): string | null {
  switch (event.kind) {
    case 'turn.completed':
      return t({ id: 'data.notifications.turnEnded', defaultMessage: 'Turn ended' });
    case 'turn.failed': {
      const { error } = (event.payload ?? {}) as { error?: unknown };
      return typeof error === 'string' && error
        ? t(
            { id: 'data.notifications.turnFailedWith', defaultMessage: 'Turn failed: {error}' },
            { error },
          )
        : t({ id: 'data.notifications.turnFailed', defaultMessage: 'Turn failed' });
    }
    case 'session.gate_checked': {
      const { results } = (event.payload ?? {}) as {
        results?: { name: string; exit_code: number; timed_out?: boolean }[];
      };
      const failed = results?.find((r) => r.exit_code !== 0 || r.timed_out);
      return failed ? reasonDetail(reasonText('gate_failed'), failed.name) : null;
    }
    case 'session.merged': {
      const { files, additions, deletions } = event.payload as Record<string, number>;
      return t(
        {
          id: 'data.notifications.merged',
          defaultMessage:
            'Merged: {files, plural, one {# file} other {# files}} +{additions} −{deletions}',
        },
        { files, additions, deletions },
      );
    }
    case 'session.merge_blocked': {
      const { reason } = (event.payload ?? {}) as { reason?: string };
      return reason
        ? reasonDetail(reasonText('merge_blocked'), reasonText(reason))
        : reasonText('merge_blocked');
    }
    default:
      return null;
  }
}

// A turn event names only its turn; the board's turn row, which can arrive later, names the session.
const turnSession = (event: DaemonEvent, board: BoardSnapshot): string | undefined =>
  board.session_turns.find((t) => t.id === event.aggregate_id)?.session_id;

// A resident's turn Pantheon woke it for ends quietly; the agent reaches the user with tell_user or ask_user.
const WAKE_ORIGINS: readonly (string | undefined)[] = ['tracker', 'sync', 'external'];

/** The notice of a message an agent left for the user; it opens the agent's conversation. */
function messageNotice(
  event: DaemonEvent,
  board: BoardSnapshot,
  p: NotificationPrefs,
): Notice | null {
  const message = (event.payload ?? {}) as {
    text?: string;
    urgency?: string;
    session_id?: string;
    agent_name?: string;
    delivery?: string;
  };
  const project = board.projects.find((p) => p.id === event.project_id);
  if (!project || !message.session_id || message.delivery === 'feed') return null;
  return {
    title: listText(project.name, message.agent_name),
    body: message.text ?? '',
    target: { project_id: project.id, session_id: message.session_id },
    ...(message.urgency === 'high' ? sound('question_asked', p) : { silent: true }),
  };
}

/**
 * The notice of a turn end, a check run, a merge, a blocked merge or an agent's message; none for
 * a merge whose rule is not now, nor for another event of a session whose needs-you item among
 * items, or other without one, has a rule that is not now.
 */
export function eventNotice(
  event: DaemonEvent,
  board: BoardSnapshot,
  p: NotificationPrefs = getNotificationPrefs(),
  items: readonly NeedsYouItem[] | null = null,
  r: DeliveryRules | null = getDeliveryRules(),
): Notice | null {
  if (event.kind === 'agent_message.created') return messageNotice(event, board, p);
  const kind = EVENT_KINDS[event.kind];
  if (!kind) return null;
  const body = eventBody(event);
  if (body === null) return null;
  const sessionId = TURN_ENDS.includes(event.kind) ? turnSession(event, board) : event.aggregate_id;
  const project = board.projects.find((p) => p.id === event.project_id);
  const session = board.sessions.find((s) => s.id === sessionId);
  if (!sessionId || !project || session?.change_story) return null;
  const turn = board.session_turns.find((t) => t.id === event.aggregate_id);
  if (TURN_ENDS.includes(event.kind) && session?.resident && WAKE_ORIGINS.includes(turn?.origin))
    return null;
  if (kind === 'merged' && !noticeNow({ decision: 'merged', created_at: Date.now() }, r))
    return null;
  if (kind !== 'merged' && !sessionNoticeNow(sessionId, items, r)) return null;
  const notice = {
    title: session ? listText(project.name, sessionTitle(session, board)) : project.name,
    body,
    target: { project_id: project.id, session_id: sessionId },
    ...sound(kind, p),
  };
  if (kind === 'turn_completed') turnEnds.add(notice);
  return notice;
}

/**
 * The notices of the events not seen before; the events present at the first look or after a
 * resync give none. Every event while there is no board, and a turn end whose session the board
 * does not name yet, stay unseen.
 */
export function liveNotices(
  cursor: NoticeCursor | null,
  sync: Pick<SyncView, 'board' | 'events' | 'resync'>,
  p: NotificationPrefs = getNotificationPrefs(),
  items: readonly NeedsYouItem[] | null = null,
): { cursor: NoticeCursor; notices: Notice[] } {
  const live = cursor !== null && cursor.resync === sync.resync;
  const notices: Notice[] = [];
  const seen = new Set<string>();
  for (const event of sync.events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    if (!live || cursor.seen.has(event.event_id)) continue;
    if (!sync.board || (TURN_ENDS.includes(event.kind) && !turnSession(event, sync.board))) {
      seen.delete(event.event_id);
      continue;
    }
    const notice = eventNotice(event, sync.board, p, items);
    if (notice) notices.push(notice);
  }
  return { cursor: { resync: sync.resync, seen }, notices };
}

/** A notice about no session, such as a milestone to accept, names the empty session; it opens the project's inbox. */
const INBOX = '';

/** Whether an item waits for the user's answer: a request, a lead's question or a workflow step's approval. */
export const waitsForAnswer = (item: NeedsYouItem) =>
  (item.source.table === 'approvals' && item.status === 'pending') ||
  item.kind === 'lead.question' ||
  item.kind === 'workflow.approval' ||
  item.kind === 'external.approval' ||
  item.kind === 'board.lane.approval';

/**
 * The dock badge: the items of every project that wait for the user's answer; null while the
 * items are not read, 0 with the badge off.
 */
export function badgeCount(
  items: readonly NeedsYouItem[] | null,
  p: NotificationPrefs = getNotificationPrefs(),
): number | null {
  if (!items) return null;
  if (!p.badge) return 0;
  return items.filter(waitsForAnswer).length;
}

/** The session's name on the board, or its project's when the board does not have it. */
function heading(board: BoardSnapshot, projectId: string, sessionId: string): string {
  const session = board.sessions.find((s) => s.id === sessionId);
  return session
    ? sessionTitle(session, board)
    : (board.projects.find((p) => p.id === projectId)?.name ?? '');
}

/**
 * The notices of the approvals and questions that joined the list, each once while it stays
 * listed; the items of the first read give none, and an unread list leaves seen as it was.
 */
export function requestNotices(
  seen: ReadonlySet<string> | null,
  items: readonly NeedsYouItem[] | null,
  board: BoardSnapshot | null,
  p: NotificationPrefs = getNotificationPrefs(),
  r: DeliveryRules | null = getDeliveryRules(),
): { seen: ReadonlySet<string> | null; notices: Notice[] } {
  if (!items || !board) return { seen, notices: [] };
  const next = new Set<string>();
  const notices: Notice[] = [];
  for (const item of items) {
    const key = needsKey(item);
    if (!key || next.has(key)) continue;
    next.add(key);
    const sessionId = needsSession(item);
    if (!seen || seen.has(key) || !sessionId) continue;
    const question =
      item.kind === 'lead.question' ? item.question?.question : item.questions?.[0]?.question;
    const kind = question !== undefined ? 'question_asked' : 'approval_requested';
    if (!noticeNow(item, r)) continue;
    const session = item.lane_title ?? heading(board, item.project_id, sessionId);
    notices.push({
      title:
        question !== undefined
          ? t({ id: 'data.notifications.asks', defaultMessage: '{session} asks you' }, { session })
          : t(
              {
                id: 'data.notifications.waitsApproval',
                defaultMessage: '{session} is waiting for your approval',
              },
              { session },
            ),
      body: question ?? item.binding?.input_summary ?? item.binding?.action ?? needReasonText(item),
      target: { project_id: item.project_id, session_id: sessionId },
      ...(item.source.table === 'approvals'
        ? { request: item.source.id }
        : answeredInStrip(item)
          ? { need: key }
          : {}),
      ...sound(kind, p),
    });
  }
  return { seen: next, notices };
}

/**
 * One notice for the sessions of every project that became ready for review and whose rule is
 * now, naming the session when it is one; it opens that session, or else the first one's project.
 */
export function reviewNotice(
  became: readonly { project_id: string; session: WorkbenchSession }[],
  board: BoardSnapshot | null,
  p: NotificationPrefs = getNotificationPrefs(),
  items: readonly NeedsYouItem[] | null = null,
  r: DeliveryRules | null = getDeliveryRules(),
): Notice | null {
  const ready = became.filter(({ session }) => sessionNoticeNow(session.id, items, r));
  if (ready.length === 0) return null;
  const one = ready.length === 1 ? ready[0]!.session : undefined;
  const projects = [...new Set(ready.map((r) => r.project_id))];
  return {
    title: one
      ? t(
          { id: 'data.notifications.review', defaultMessage: '{session} is ready for review' },
          { session: sessionRow(one).title },
        )
      : t(
          {
            id: 'data.notifications.groupReview',
            defaultMessage:
              '{count, plural, one {# session ready for review} other {# sessions ready for review}}',
          },
          { count: ready.length },
        ),
    body: ready.every((r) => r.session.gate?.state === 'passed')
      ? t({ id: 'data.notifications.allPassed', defaultMessage: 'All checks passed' })
      : listText(
          ...projects.map((id) => board?.projects.find((project) => project.id === id)?.name),
        ),
    target: { project_id: ready[0]!.project_id, session_id: one ? one.id : INBOX },
    ...sound('ready_for_review', p),
  };
}

const DECISIONS: readonly string[] = [
  'milestone.ready_for_acceptance',
  'improvement.candidate',
  'board.plan.proposal',
];

/**
 * The notices of the milestones ready for acceptance and the proposals that joined the list, each
 * once while it stays listed; the items of the first read give none, and an unread list leaves
 * seen as it was.
 */
export function decisionNotices(
  seen: ReadonlySet<string> | null,
  items: readonly NeedsYouItem[] | null,
  board: BoardSnapshot | null,
  p: NotificationPrefs = getNotificationPrefs(),
  r: DeliveryRules | null = getDeliveryRules(),
): { seen: ReadonlySet<string> | null; notices: Notice[] } {
  if (!items || !board) return { seen, notices: [] };
  const decisions = items.filter((item) => DECISIONS.includes(item.kind));
  const next = new Set<string>();
  const notices: Notice[] = [];
  for (const item of decisions) {
    const key = needKey(item);
    if (next.has(key)) continue;
    next.add(key);
    const project = board.projects.find((p) => p.id === item.project_id);
    if (!seen || seen.has(key) || !project || !noticeNow(item, r)) continue;
    const title = board.milestones?.find((m) => m.id === item.source.id)?.title;
    notices.push({
      title: project.name,
      body: title ? reasonDetail(reasonText(item.reason), title) : reasonText(item.reason),
      target: { project_id: project.id, session_id: INBOX },
      ...sound('approval_requested', p),
    });
  }
  return { seen: next, notices };
}

/**
 * Opens the project and session of a clicked notification, or the project's board, and asks for
 * the card of the request given.
 */
export function openNotice(target: NotificationTarget, request?: string): void {
  if (target.session_id === INBOX) useShell.getState().openProjectBoard(target.project_id);
  else useShell.getState().openProjectSession(target.project_id, target.session_id);
  if (request) focusRequest(request);
}

/** Whether this computer's clock is inside the daemon's quiet hours, when they are set. */
export function inQuietHours(r: DeliveryRules | null = getDeliveryRules()): boolean {
  return !!r?.quiet_hours && withinHours(r.quiet_hours, Date.now());
}

/** Calls then with whether a Pantheon window has focus: the desktop app's answer, or this page's focus without it. */
export function withFocus(then: (front: boolean) => void): void {
  const bridge = window.pantheon;
  if (!bridge?.appFocused) return then(document.hasFocus());
  void bridge
    .appFocused()
    .catch(() => document.hasFocus())
    .then(then);
}

// The target and the approval or needs-you card of each notice sent with one, the newest kept, by the token its target carries.
const asks = new Map<string, { target: NotificationTarget; ask: string }>();
const ASKS_KEPT = 100;

/** Sends a system notification while the app is in the background, except during the quiet hours. */
function send(notice: Notice) {
  if (!inQuietHours()) notify(notice);
}

/** Sends a system notification while the app is in the background; a needs-you item's rules weighed the quiet hours. */
function notify(notice: Notice) {
  withFocus((front) => {
    if (front) return;
    const { request, need, ...shown } = notice;
    const ask = request ?? need;
    if (ask) {
      const token = crypto.randomUUID();
      asks.set(token, { target: shown.target, ask });
      if (asks.size > ASKS_KEPT) asks.delete(asks.keys().next().value!);
      // Ids never hold a newline, so the token follows the project's after one. A wait the strip
      // answers names no session, so the desktop hands its click to the main window.
      shown.target = {
        project_id: `${shown.target.project_id}\n${token}`,
        session_id: need ? INBOX : shown.target.session_id,
      };
    }
    void window.pantheon?.notify(shown).catch(() => {});
  });
}

/** Sends a sample notification with sound that opens nothing, whatever the preferences; resolves to whether the desktop took it. */
export const sendTestNotice = (): Promise<boolean> =>
  window.pantheon
    ? window.pantheon
        .notify({
          title: 'Pantheon',
          body: t({ id: 'data.notifications.test', defaultMessage: 'Notifications are on' }),
        })
        .then(
          () => true,
          () => false,
        )
    : Promise.resolve(false);

/**
 * Notifies each baseline session of the project once when it starts waiting for its review;
 * nothing from the first list.
 */
function useSessionNotices(
  projectId: string | null,
  sessions: readonly WorkbenchSession[] | null,
  hold: ReturnType<typeof turnEndHold>,
) {
  const seen = useRef<{ projectId: string | null; sessions: readonly WorkbenchSession[] } | null>(
    null,
  );
  useEffect(() => {
    if (!sessions || !projectId) return;
    const previous = seen.current?.projectId === projectId ? seen.current.sessions : null;
    seen.current = { projectId, sessions };
    const { board, events } = useBoard.getState();
    const name = board?.projects.find((p) => p.id === projectId)?.name;
    const p = getNotificationPrefs();
    for (const session of newlyWaiting(previous, sessions)) {
      // A waiting request is noticed from the needs-you list.
      if (session.workspace_id !== null || pendingPermissions(events, session.id).length) continue;
      if (!noticeNow({ decision: 'permission', created_at: Date.now() })) continue;
      const notice = waitNotice(session, events);
      send({
        title: name ? listText(name, notice.title) : notice.title,
        body: notice.body,
        target: { project_id: projectId, session_id: session.id },
        ...sound('approval_requested', p),
      });
      // This notice tells the baseline's turn end.
      hold.ready(session.id);
    }
    for (const session of becameReady(previous, sessions)) hold.ready(session.id);
  }, [projectId, sessions]);
}

const SESSION_KINDS = ['session.', 'turn.', 'workspace.'];
const newestSessionEvent = (events: readonly DaemonEvent[]): number => {
  for (let i = events.length - 1; i >= 0; i--)
    if (SESSION_KINDS.some((prefix) => events[i]!.kind.startsWith(prefix)))
      return events[i]!.sequence;
  return 0;
};

type SessionLists = Readonly<Record<string, readonly WorkbenchSession[]>>;
const NO_LISTS: SessionLists = {};

/**
 * The session list of every project by project, read together again after session events, on
 * focus and on resync; a project whose read fails is left out.
 */
function useEverySessionList(): SessionLists {
  const projects = useBoard((s) => s.board?.projects);
  const ids = visibleProjects(projects ?? []).map((p) => p.id);
  const key = ids.join('\n');
  const resync = useBoard((s) => s.resync);
  const tick = useRefetchTick(
    useBoard((s) => newestSessionEvent(s.events)),
    false,
  );
  const focus = useFocusTick();
  const live = useBoard((s) => s.status.state === 'live');
  // Counts the times the stream went live, so a disconnect alone reads nothing.
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  const reconnected = reconnects.current.count;
  const [lists, setLists] = useState(NO_LISTS);
  // Session events read only their own projects; the newest read sent of a project wins.
  const sent = useRef({
    triggers: null as readonly unknown[] | null,
    through: 0,
    order: 0,
    whole: 0,
    by: {} as Record<string, number>,
  });
  useEffect(() => {
    if (!ids.length) return;
    const s = sent.current;
    const triggers = [key, focus, resync, reconnected];
    const whole = !s.triggers || triggers.some((each, i) => each !== s.triggers![i]);
    s.triggers = triggers;
    const { events } = useBoard.getState();
    const touched = new Set(
      events
        .filter(
          (e) =>
            e.sequence > s.through && SESSION_KINDS.some((prefix) => e.kind.startsWith(prefix)),
        )
        .map((e) => e.project_id),
    );
    s.through = newestSessionEvent(events);
    const read = whole || touched.has('') ? ids : ids.filter((id) => touched.has(id));
    if (!read.length) return;
    const order = ++s.order;
    if (whole) s.whole = order;
    for (const id of read) s.by[id] = order;
    void Promise.all(read.map((project_id) => readQuery('session.list', { project_id }))).then(
      (results) => {
        if (order < s.whole) return;
        setLists((all) => {
          // A whole read drops the projects gone since; one overtaken by a later read keeps its list.
          const next: Record<string, readonly WorkbenchSession[]> = whole
            ? Object.fromEntries(Object.entries(all).filter(([id]) => read.includes(id)))
            : { ...all };
          results.forEach((result, i) => {
            const id = read[i]!;
            if (s.by[id] !== order) return;
            if (result.ok && Array.isArray(result.value))
              next[id] = result.value as WorkbenchSession[];
            else delete next[id];
          });
          return next;
        });
      },
    );
  }, [key, tick, focus, resync, reconnected]);
  return lists;
}

/** One notice for the sessions of every project that became ready for review since its previous list; none from a project's first list. */
function useReviewNotices(
  lists: SessionLists,
  hold: ReturnType<typeof turnEndHold>,
  items: { current: readonly NeedsYouItem[] | null },
) {
  const before = useRef(NO_LISTS);
  useEffect(() => {
    const ready = Object.entries(lists).flatMap(([project_id, list]) =>
      becameReady(before.current[project_id] ?? null, list).map((session) => ({
        project_id,
        session,
      })),
    );
    before.current = { ...before.current, ...lists };
    for (const { session } of ready) hold.ready(session.id);
    const review = reviewNotice(ready, useBoard.getState().board, undefined, items.current);
    if (review) send(review);
  }, [lists]);
}

/** Notifies each approval and question of every project once. */
function useRequestNotices(items: readonly NeedsYouItem[] | null) {
  const seen = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const next = requestNotices(seen.current, items, useBoard.getState().board);
    seen.current = next.seen;
    next.notices.forEach(notify);
  }, [items]);
}

/** Notifies each milestone ready for acceptance and each new proposal of every project once. */
function useDecisionNotices(items: readonly NeedsYouItem[] | null) {
  const seen = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const next = decisionNotices(seen.current, items, useBoard.getState().board);
    seen.current = next.seen;
    next.notices.forEach(notify);
  }, [items]);
}

/** Tells the desktop app how many sessions run, so it keeps the computer awake while any does. */
function useKeepAwake(enabled: boolean) {
  const running = useBoard(
    (s) => s.board?.sessions.filter((session) => session.state === 'running').length ?? 0,
  );
  useEffect(() => {
    void window.pantheon?.keepAwake?.({ enabled, running }).catch(() => {});
  }, [enabled, running]);
}

/**
 * Sends the system notifications of every project, opens the session of a clicked one and keeps
 * the computer awake while sessions run; items are the needs-you items of every project.
 */
export function useNotices(
  projectId: string | null,
  sessions: readonly WorkbenchSession[] | null,
  items: readonly NeedsYouItem[] | null = null,
) {
  // Reading the preferences here renders the caller again, and so its badge, when they change.
  const p = useNotificationPrefs();
  useStoredPrefs();
  const { settings, save } = useAppSettings();
  // Set before the notice effects below read it.
  useEffect(() => {
    rules = settings;
  }, [settings]);
  useEarlierPrefs(settings, (patch) => void save(patch));
  const hold = useRef(turnEndHold());
  useEffect(() => () => hold.current.stop(), []);
  const latest = useRef(items);
  latest.current = items;
  useSessionNotices(projectId, sessions, hold.current);
  useReviewNotices(useEverySessionList(), hold.current, latest);
  useRequestNotices(items);
  useDecisionNotices(items);
  useKeepAwake(p.keep_awake);
  const board = useBoard((s) => s.board);
  const events = useBoard((s) => s.events);
  const resync = useBoard((s) => s.resync);
  const cursor = useRef<NoticeCursor | null>(null);
  useEffect(() => {
    const next = liveNotices(cursor.current, { board, events, resync }, undefined, latest.current);
    cursor.current = next.cursor;
    for (const notice of next.notices)
      if (turnEnds.has(notice)) hold.current.ended(notice.target.session_id, () => send(notice));
      else send(notice);
  }, [board, events, resync]);
  useEffect(
    () =>
      window.pantheon?.onNotificationClick((target) => {
        const [project_id = '', token] = target.project_id.split('\n');
        const sent = token === undefined ? undefined : asks.get(token);
        const ask = sent?.ask;
        // A wait no thread answers opens where it is answered.
        if (ask && latest.current?.some((item) => answeredInStrip(item) && needsKey(item) === ask))
          return useShell.getState().openProjectNeed(project_id, ask);
        // An answered request leaves the list; its session opens without the ask.
        const waiting = latest.current?.some(
          (item) =>
            item.source.table === 'approvals' &&
            item.source.id === ask &&
            item.status === 'pending',
        );
        openNotice(
          sent?.target ?? { project_id, session_id: target.session_id },
          waiting ? ask : undefined,
        );
      }),
    [],
  );
}
