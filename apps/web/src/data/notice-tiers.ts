import type { BoardSnapshot, WorkbenchSession } from '@pantheon/protocol';
import type { NeedsNoticeOptions, ResultNoticeOptions } from '../components/Toast';
import { t } from '../i18n';
import { sessionRow } from '../screens/sessions/model';
import type { SessionGroupKey } from '../screens/sessions/session-groups';
import { useShell } from '../store';
import { useCurrentProject } from './current-project';
import { failureText, needReasonText, reasonText, type NeedsYouItem } from './needs-you';
import type { NoticeCursor, NoticeEvent } from './notifications';
import type { DaemonEvent, SyncView } from './sync';
import { sessionTitle } from './transcript';

/** The session in front of the user: the shown one, while the window has focus. */
export interface NoticeWatch {
  /** The session the sessions screen shows; null on other screens. */
  sessionId: string | null;
  /** The project whose runs going now the screen shows: their rows answer its approvals, its needs-you strip the rest. */
  queue: string | null;
  focused: boolean;
  /** The sessions the session windows show while one of them has focus. */
  elsewhere?: ReadonlySet<string>;
}

/** The channel on which a session window tells the other windows what it shows while it has focus. */
export const WATCH_CHANNEL = 'pantheon.watching';

/** A session window's word on the watch channel: its own id, and its session while it has focus, else null. */
export interface WatchWord {
  window: string;
  session_id: string | null;
}

export type Decision = 'approve' | 'reject';

/** A card that needs the user, named by what it waits on. */
export interface NeedsCard {
  /** The event whose in-app choice the card follows. */
  event: NoticeEvent;
  session_id: string | null;
  options: NeedsNoticeOptions & { id: string };
}

/** The results that fold into one card when they pile up. */
export type ResultGroup = 'done' | 'review' | 'merged';

export interface ResultCard {
  /** null for a failure, which never folds. */
  group: ResultGroup | null;
  /** The event whose in-app choice the card follows. */
  event: NoticeEvent;
  project_id: string;
  session_id: string;
  options: ResultNoticeOptions;
  /** On a session ready for review: whether its checks passed. */
  passed?: boolean;
}

const watching = (view: NoticeWatch, sessionId: string | null | undefined) =>
  sessionId !== null &&
  sessionId !== undefined &&
  ((view.focused && view.sessionId === sessionId) || !!view.elsewhere?.has(sessionId));

/** Whether a wait can be answered on the screen in front of the user, so it needs no card. */
export const waitInView = (
  view: NoticeWatch,
  wait: {
    id: string;
    project: string;
    session: string | null | undefined;
    approval: boolean;
    strip: boolean;
  },
) =>
  watching(view, wait.session) ||
  ((wait.approval || wait.strip) && view.focused && view.queue === wait.project);

const opener = (projectId: string, sessionId: string) => () =>
  useShell.getState().openProjectSession(projectId, sessionId);

/** The session's name on the board, or its project's when the board does not have it. */
function heading(board: BoardSnapshot, projectId: string, sessionId: string | undefined): string {
  const session = board.sessions.find((s) => s.id === sessionId);
  return session
    ? sessionTitle(session, board)
    : (board.projects.find((p) => p.id === projectId)?.name ?? '');
}

/** The card id of a pending approval, a lead question or an external request; null for any other item. */
export function needsKey(item: NeedsYouItem): string | null {
  if (item.kind === 'permission' && item.reason === 'permission_requested') return item.source.id;
  if (item.kind === 'lead.question') return `${item.source.id}:${item.request_id ?? ''}`;
  // One plan holds every held external request and held lane of its lead.
  if (item.kind === 'external.approval' || item.kind === 'board.lane.approval')
    return `${item.source.table}:${item.source.id}:${item.request_id ?? ''}`;
  return null;
}

/** Whether the needs-you strip answers the item rather than a session's thread. */
export const answeredInStrip = (item: NeedsYouItem): boolean =>
  item.kind === 'lead.question' ||
  item.kind === 'external.approval' ||
  item.kind === 'board.lane.approval';

/** The session the item waits in; a session item's source is the session itself. */
export const needsSession = (item: NeedsYouItem): string | undefined =>
  item.session_id ?? (item.source.table === 'sessions' ? item.source.id : undefined);

/** The card of an approval or a question; none for a wait on the screen in front of the user. */
export function needsCard(
  item: NeedsYouItem,
  board: BoardSnapshot,
  view: NoticeWatch,
  respond: (item: NeedsYouItem, decision: Decision, heading: string) => void,
): NeedsCard | null {
  const id = needsKey(item);
  if (!id) return null;
  const strip = answeredInStrip(item);
  // The session whose thread answers the wait.
  const session_id = strip ? null : (item.session_id ?? null);
  const wait = {
    id,
    project: item.project_id,
    session: session_id,
    approval: item.kind === 'permission',
    strip,
  };
  if (waitInView(view, wait)) return null;
  const name = item.lane_title ?? heading(board, item.project_id, needsSession(item));
  const base = {
    id,
    heading: name,
    since: item.created_at,
    ...(strip
      ? { open: () => useShell.getState().openProjectNeed(item.project_id, id) }
      : item.session_id
        ? { open: opener(item.project_id, item.session_id) }
        : {}),
  };
  const question =
    item.kind === 'lead.question' ? item.question?.question : item.questions?.[0]?.question;
  if (question !== undefined)
    return {
      event: 'question_asked',
      session_id,
      options: {
        ...base,
        event: t({ id: 'data.noticeTiers.asks', defaultMessage: 'asks you' }),
        summary: question,
      },
    };
  const command = item.binding?.input_summary ?? item.binding?.action;
  const allowed = item.actions.find((a) => a.command === 'approval.respond')?.allowed === true;
  return {
    event: 'approval_requested',
    session_id,
    options: {
      ...base,
      event: t({ id: 'data.noticeTiers.waitsApproval', defaultMessage: 'waiting for approval' }),
      ...(command ? { command } : {}),
      ...(strip ? { summary: needReasonText(item) } : {}),
      ...(allowed
        ? {
            actions: [
              // A question request reaches here only when its questions could not be read, and the
              // daemon approves one only with answers.
              ...(item.binding?.action === 'AskUserQuestion'
                ? []
                : [
                    {
                      label: t({ id: 'data.noticeTiers.allowOnce', defaultMessage: 'Allow once' }),
                      run: () => respond(item, 'approve', name),
                      primary: true,
                    },
                  ]),
              {
                label: t({ id: 'data.noticeTiers.reject', defaultMessage: 'Reject' }),
                run: () => respond(item, 'reject', name),
              },
            ],
          }
        : {}),
    },
  };
}

const TURN_ENDS: readonly string[] = ['turn.completed', 'turn.failed'];

function failure(projectId: string, sessionId: string, name: string, event: string) {
  return {
    heading: name,
    event,
    tone: 'failed' as const,
    actions: [
      {
        label: t({ id: 'data.noticeTiers.seeFailure', defaultMessage: 'See failures' }),
        run: opener(projectId, sessionId),
      },
    ],
  };
}

/**
 * The card of a turn end, a check run, a merge or a blocked merge; none for the session in front
 * of the user or a change story, and undefined for a turn whose session the board does not name yet.
 */
export function eventCard(
  event: DaemonEvent,
  board: BoardSnapshot,
  view: NoticeWatch,
): ResultCard | null | undefined {
  const turn = TURN_ENDS.includes(event.kind);
  const sessionId = turn
    ? board.session_turns.find((t) => t.id === event.aggregate_id)?.session_id
    : event.aggregate_id;
  if (!sessionId) return turn ? undefined : null;
  const session = board.sessions.find((s) => s.id === sessionId);
  if (
    session?.change_story ||
    watching(view, sessionId) ||
    !board.projects.some((p) => p.id === event.project_id)
  )
    return null;
  const name = heading(board, event.project_id, sessionId);
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const result = (group: ResultGroup, kind: NoticeEvent, text: string): ResultCard => ({
    group,
    event: kind,
    project_id: event.project_id,
    session_id: sessionId,
    options: {
      heading: name,
      event: text,
      tone: 'done',
      open: opener(event.project_id, sessionId),
    },
  });
  switch (event.kind) {
    case 'turn.completed':
      return result(
        'done',
        'turn_completed',
        t({ id: 'data.noticeTiers.turnDone', defaultMessage: 'turn finished' }),
      );
    case 'session.merged':
      return result(
        'merged',
        'merged',
        t({ id: 'data.noticeTiers.merged', defaultMessage: 'merged' }),
      );
    case 'turn.failed': {
      const line = typeof payload.error === 'string' ? payload.error.split('\n')[0] : '';
      return {
        group: null,
        event: 'turn_failed',
        project_id: event.project_id,
        session_id: sessionId,
        options: {
          ...failure(
            event.project_id,
            sessionId,
            name,
            t({ id: 'data.noticeTiers.turnFailed', defaultMessage: 'turn failed' }),
          ),
          ...(line ? { summary: line } : {}),
        },
      };
    }
    case 'session.gate_checked': {
      const results = (payload.results ?? []) as {
        name: string;
        exit_code: number;
        timed_out?: boolean;
      }[];
      const failed = results.filter((r) => r.exit_code !== 0 || r.timed_out);
      if (failed.length === 0) return null;
      return {
        group: null,
        event: 'gate_failed',
        project_id: event.project_id,
        session_id: sessionId,
        options: {
          ...failure(
            event.project_id,
            sessionId,
            name,
            t({ id: 'data.noticeTiers.checksFailed', defaultMessage: 'checks failed' }),
          ),
          command: failed[0]!.name,
          summary: t(
            { id: 'data.noticeTiers.failing', defaultMessage: '{count} failing' },
            { count: failed.length },
          ),
        },
      };
    }
    case 'session.merge_blocked': {
      const reason = typeof payload.reason === 'string' ? payload.reason : '';
      return {
        group: null,
        event: 'merge_blocked',
        project_id: event.project_id,
        session_id: sessionId,
        options: {
          ...failure(
            event.project_id,
            sessionId,
            name,
            t({ id: 'data.noticeTiers.mergeBlocked', defaultMessage: 'merge blocked' }),
          ),
          ...(reason ? { summary: reasonText(reason) } : {}),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * The cards of the events not seen before; the events present at the first look or after a
 * resync give none. Every event while there is no board, and a turn end whose session the board
 * does not name yet, stay unseen.
 */
export function liveCards(
  cursor: NoticeCursor | null,
  sync: Pick<SyncView, 'board' | 'events' | 'resync'>,
  view: NoticeWatch,
): { cursor: NoticeCursor; cards: ResultCard[] } {
  const live = cursor !== null && cursor.resync === sync.resync;
  const cards: ResultCard[] = [];
  const seen = new Set<string>();
  for (const event of sync.events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    if (!live || cursor.seen.has(event.event_id)) continue;
    const card = sync.board ? eventCard(event, sync.board, view) : undefined;
    if (card === undefined) seen.delete(event.event_id);
    else if (card) cards.push(card);
  }
  return { cursor: { resync: sync.resync, seen }, cards };
}

/** The sessions that became ready for review since the previous list; none from the first list. */
export function becameReady(
  before: readonly WorkbenchSession[] | null,
  after: readonly WorkbenchSession[],
): WorkbenchSession[] {
  if (!before) return [];
  return after.filter(
    (s) => s.state === 'ready' && before.find((b) => b.id === s.id)?.state !== 'ready',
  );
}

/** The cards of the project's sessions that became ready for review since the previous list. */
export function reviewCards(
  before: readonly WorkbenchSession[] | null,
  after: readonly WorkbenchSession[],
  projectId: string,
  view: NoticeWatch,
): ResultCard[] {
  return becameReady(before, after)
    .filter((s) => !watching(view, s.id))
    .map((s) => ({
      group: 'review',
      event: 'ready_for_review',
      project_id: projectId,
      session_id: s.id,
      passed: s.gate?.state === 'passed',
      options: {
        heading: sessionRow(s).title,
        event: t({ id: 'data.noticeTiers.review', defaultMessage: 'ready for review' }),
        tone: 'review',
        ...(s.changes
          ? { diff: { additions: s.changes.additions, deletions: s.changes.deletions } }
          : {}),
        open: opener(projectId, s.id),
      },
    }));
}

/** How long a turn's end waits for its session to become ready for review, which then tells it alone. */
export const TURN_END_HOLD_MS = 1500;

/** Holds each turn end, so a session ready for review right after its turn gives only the review. */
export function turnEndHold() {
  const held = new Map<string, ReturnType<typeof setTimeout>>();
  const ready = new Map<string, number>();
  return {
    /** Shows the turn end after the hold, unless its session becomes ready for review around it. */
    ended(sessionId: string, show: () => void) {
      if (Date.now() - (ready.get(sessionId) ?? -Infinity) < TURN_END_HOLD_MS) return;
      clearTimeout(held.get(sessionId));
      held.set(
        sessionId,
        setTimeout(() => {
          held.delete(sessionId);
          show();
        }, TURN_END_HOLD_MS),
      );
    },
    ready(sessionId: string) {
      clearTimeout(held.get(sessionId));
      held.delete(sessionId);
      const now = Date.now();
      for (const [id, at] of ready) if (now - at >= TURN_END_HOLD_MS) ready.delete(id);
      ready.set(sessionId, now);
    },
    stop() {
      held.forEach(clearTimeout);
      held.clear();
    },
  };
}

/** The sessions that waited for the user in the previous list and no longer do. */
export function stoppedWaiting(
  before: readonly WorkbenchSession[] | null,
  after: readonly WorkbenchSession[],
): string[] {
  if (!before) return [];
  const waited = new Set(before.filter((s) => s.state === 'waiting').map((s) => s.id));
  return after.filter((s) => waited.has(s.id) && s.state !== 'waiting').map((s) => s.id);
}

// A session that finished a turn is unread, so the list puts it under review.
const LIST_GROUP: Record<ResultGroup, SessionGroupKey> = {
  done: 'review',
  review: 'review',
  merged: 'merged',
};

/** One card for several results of a kind in one project; it opens that project's group of them. */
export function groupCard(
  group: ResultGroup,
  projectId: string,
  count: number,
  passed: boolean,
): ResultNoticeOptions & { id: string } {
  const headings: Record<ResultGroup, string> = {
    review: t(
      {
        id: 'data.noticeTiers.groupReview',
        defaultMessage:
          '{count, plural, one {# session ready for review} other {# sessions ready for review}}',
      },
      { count },
    ),
    done: t(
      {
        id: 'data.noticeTiers.groupDone',
        defaultMessage:
          '{count, plural, one {# session finished a turn} other {# sessions finished a turn}}',
      },
      { count },
    ),
    merged: t(
      {
        id: 'data.noticeTiers.groupMerged',
        defaultMessage: '{count, plural, one {# session merged} other {# sessions merged}}',
      },
      { count },
    ),
  };
  return {
    id: `notice-group-${group}-${projectId}`,
    heading: headings[group],
    tone: group === 'review' ? 'review' : 'done',
    ...(group === 'review' && passed
      ? { summary: t({ id: 'data.noticeTiers.allPassed', defaultMessage: 'All checks passed' }) }
      : {}),
    open: () => {
      useCurrentProject.getState().choose(projectId);
      useShell.getState().openSessionGroup(LIST_GROUP[group]);
    },
  };
}

/** The failure card of an answer the daemon did not take. */
export function answerFailed(
  name: string,
  error: { code: string; message: string },
): ResultNoticeOptions {
  return {
    heading: name,
    event: t({ id: 'data.noticeTiers.answerFailed', defaultMessage: 'answer not sent' }),
    tone: 'failed',
    summary: failureText(error),
  };
}
