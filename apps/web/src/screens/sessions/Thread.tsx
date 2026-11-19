import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { LoadError } from '../../components/LoadError';
import { Collapsible } from '@base-ui/react/collapsible';
import { Tooltip } from '@base-ui/react/tooltip';
import {
  AppWindow,
  Bell,
  Bot,
  CheckIcon,
  ChevronRight,
  Crown,
  KeyRound,
  Minus,
  RefreshCw,
  Undo2,
  User,
} from 'lucide-react';
import type { BoardHistory, BoardSnapshot, WorkbenchSession } from '@pantheon/protocol';
import { MarkdownLinks } from '../../components/Markdown';
import { Skeleton } from '../../components/Skeleton';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { useBoardHistory } from '../../data/board-history';
import { runCommand } from '../../data/commands';
import { useLook } from '../../data/layout';
import { useSessionDisplay } from '../../data/session-display';
import { mergeEvents, useEventHistory } from '../../data/logs';
import { supports, useRuntimeStatus } from '../../data/runtime-status';
import { useMemorySessionTurns } from '../../data/memory';
import { reducedMotion } from '../../lib/motion';
import { failureText, type NeedsYouState } from '../../data/needs-you';
import {
  openPersonalAgent,
  personalCall,
  personalHomeOf,
  useBuiltInPersonalKey,
  type PersonalCall,
} from '../../data/personal-agent';
import type { DaemonEvent } from '../../data/sync';
import { workspaceFile } from '../../data/tool-calls';
import {
  buildTranscript,
  composeState,
  foldTurn,
  isQuietEvent,
  isSessionEvent,
  type RequestItem,
  type Session,
  type SessionTurn,
  type ToolItem,
  type TranscriptItem,
  type TurnView,
} from '../../data/transcript';
import { t } from '../../i18n';
import { SCREEN_NAMES } from '../../screens';
import { useShortcut } from '../../lib/shortcuts';
import { clockText } from '../../lib/time-text';
import {
  arrivals,
  endedText,
  isSessionApproval,
  NO_ARRIVALS,
  pendingPermissions,
  sessionRow,
  threadIds,
  toldItem,
  turnStatus,
  turnStatusSpoken,
  turnStatusText,
  unplacedPermissions,
  type TurnStatus,
} from './model';
import { appCallsOf, appDisplay } from './app-display';
import type { Panel } from './inspector-model';
import { shownInput, statusTicks, timelineNodes, type TimelineNode } from './thread-model';
import { ThreadFind, useThreadFind } from './ThreadFind';
import { MemoryUsed } from './MemoryUsed';
import { PersonalNeedsList, PersonalSentLine } from './PersonalNeedsList';
import { ChapterMark, Items, ResolveButtons, ThreadMark, TurnWork } from './parts';
import { showThreadTurns } from './trace';
import { BaselineReview, PendingQuestions, RequestCard, RequestSlot } from './RequestCards';
import {
  checkpointed,
  SessionHeader,
  type PlanStep,
  type SplitEntry,
  type TerminalToggle,
} from './SessionHeader';
import { RoutingLine } from '../board/PublishBar';
import { showFile } from './FilesPanel';
import { SessionCompose } from './SessionCompose';
import { fail, useSecondTick } from './shared';
import { CheckpointBack, ReplyActions, TurnActions } from './TurnMenu';
import { RESIDENTS, WorkerStrip } from './WorkerStrip';
import '../../components/state-icon.css';

/** The session's worktree and its project's folders; tool call paths are shown relative to them. */
function sessionFolders(board: BoardSnapshot, session: Session): string[] {
  const workspace = board.workspaces.find((w) => w.id === session.workspace_id);
  const roots = board.projects.find((p) => p.id === session.project_id)?.roots ?? [];
  return workspace ? [workspace.path, ...roots] : roots;
}

/** `next`, or the array of the last render while it holds the same events, so memos on it hold. */
function useSameEvents(next: readonly DaemonEvent[] | null): readonly DaemonEvent[] | null {
  const held = useRef(next);
  const before = held.current;
  if (
    before !== next &&
    !(before && next && before.length === next.length && before.every((e, i) => e === next[i]))
  )
    held.current = next;
  return held.current;
}

export function Thread(props: {
  board: BoardSnapshot;
  sessionId: string;
  listed: WorkbenchSession | null;
  needs: NeedsYouState;
  /** The listed lead session this one was opened from. */
  parent: WorkbenchSession | null;
  panels: readonly Panel[];
  /** The panel last opened or closed. */
  recent?: Panel;
  onPanel: (tab: Panel) => void;
  overview: boolean;
  onOverview?: () => void;
  onDiscarded: () => void;
  /** The window draws its own bar over the thread, in place of the session header. */
  ownBar?: boolean;
  /** The head of a pane beside another session, drawn in place of the session bar and timeline. */
  head?: ReactNode;
  /** Whether the window's keys act on this thread; false in the pane that is not current. */
  active?: boolean;
  /** The session bar's entry that picks a session to show beside this one. */
  split?: SplitEntry;
  /** The project's open sessions, offered for a message to refer to. */
  sessions?: readonly WorkbenchSession[];
  /** The session bar's terminal switch. */
  terminal?: TerminalToggle;
  /** The listed sessions working on tasks this one dispatched. */
  workers?: readonly WorkbenchSession[];
}) {
  const { board, sessionId, listed, active = true } = props;
  // Read when asked, so a new list read does not render every turn again.
  const sessionList = useRef(props.sessions);
  sessionList.current = props.sessions;
  const listedSessions = useCallback(() => sessionList.current ?? [], []);
  const live = useBoard((s) => s.events);
  const session = board.sessions.find((s) => s.id === sessionId) ?? null;
  // Every board snapshot parses new turn objects; a turn that reads the same keeps its object.
  const heldTurns = useRef(new Map<string, SessionTurn>());
  const turns = useMemo(() => {
    const next = board.session_turns
      .filter((t) => t.session_id === sessionId)
      .map((t) => {
        const before = heldTurns.current.get(t.id);
        return before && JSON.stringify(before) === JSON.stringify(t) ? before : t;
      });
    heldTurns.current = new Map(next.map((t) => [t.id, t]));
    return next;
  }, [board, sessionId]);
  const turnIds = useMemo(() => new Set(turns.map((t) => t.id)), [turns]);
  // Asked for only by a thread holding a turn a personal key sent.
  const sentByKey = useMemo(() => turns.some((t) => t.via), [turns]);
  const personalKey = useBuiltInPersonalKey(
    sentByKey ? (personalHomeOf(board.projects)?.id ?? null) : null,
  );
  const keep = (e: DaemonEvent) =>
    isSessionEvent(e, sessionId, turnIds) || isSessionApproval(e, sessionId);
  const history = useEventHistory({
    key: sessionId,
    project_id: session?.project_id ?? null,
    after: 0,
    keep,
  });
  // Both lists are new arrays on every render, also when no event arrived.
  const past = useSameEvents(history.events);
  const recent = useSameEvents(live.filter(keep));
  const events = useMemo(() => (past ? mergeEvents(past, recent ?? []) : null), [past, recent]);
  const view = useMemo(() => (events ? buildTranscript(turns, events) : null), [turns, events]);
  // The dock, full screen and palette find the session's interfaces here.
  useEffect(() => {
    if (view) appDisplay.getState().setCalls(sessionId, appCallsOf(view));
  }, [sessionId, view]);
  const pending = useMemo(
    () => (events ? pendingPermissions(events, sessionId) : []),
    [events, sessionId],
  );
  // Held by content: every board snapshot is new, and each turn row takes these folders.
  const joined = session ? sessionFolders(board, session).join('\0') : '';
  const folders = useMemo(() => (joined ? joined.split('\0') : []), [joined]);
  const showLinked = useCallback(
    (ref: { path: string; line?: number }) => {
      const path = workspaceFile(ref.path, folders);
      if (path !== null) showFile(sessionId, path, ref.line);
      return path !== null;
    },
    [folders, sessionId],
  );
  const arrived = useRef(NO_ARRIVALS);
  arrived.current = arrivals(arrived.current, view ? threadIds(view, pending) : null);
  const { fresh } = arrived.current;
  const expanded = useLook().transcript === 'expanded';
  const timeline = useSessionDisplay().timeline;
  const waitingFor = pending[0] ? (pending[0].questions?.length ? 'question' : 'approval') : null;
  const statuses = view?.turns.map((t) => turnStatus(t, waitingFor)) ?? [];
  const spoken = turnStatusSpoken(
    statuses.findLast((s) => s.kind !== 'ended') ?? turnStatus(null, null),
  );
  const findOpen = () => useThreadFind.getState().sessionId === sessionId;
  const finding = useSyncExternalStore(useThreadFind.subscribe, findOpen, findOpen);
  useShortcut(
    'thread-find',
    () => useThreadFind.getState().show(sessionId, document.activeElement as HTMLElement),
    active,
  );
  // A new array after every event, so the map, and `request` with it, are held by its content.
  const waiting = JSON.stringify(pending);
  const byRequest = useMemo(
    () => new Map(pending.flatMap((p) => (p.request ? [[p.request, p] as const] : []))),
    [waiting],
  );
  // Request cards read only the approval items and the error; every needs-you reread is a new object.
  const approvals = JSON.stringify(
    props.needs.items?.filter((i) => i.source.table === 'approvals') ?? null,
  );
  const needs = useMemo(() => props.needs, [approvals, props.needs.error]);
  const request = useCallback(
    (item: RequestItem, enter: string) => (
      <RequestSlot
        key={`request-${item.id}`}
        item={item}
        permission={byRequest.get(item.id)}
        needs={needs}
        folders={folders}
        enter={enter}
      />
    ),
    [byRequest, needs, folders],
  );
  const title = listed ? sessionRow(listed).title : (session?.title ?? '');
  const runtimeStatus = useRuntimeStatus().read;
  const report =
    runtimeStatus.state === 'ready'
      ? runtimeStatus.statuses.find((s) => s.runtime === session?.runtime)
      : undefined;
  // The daemon forks from before a step only off the current files of an idle session.
  const forkSteps =
    !!report &&
    supports(report, 'fork_within_turn') &&
    !!listed?.workspace_id &&
    listed.workspace_kind !== 'in_place' &&
    !endedText(listed) &&
    session?.state === 'open' &&
    !session.stop_pending &&
    !session.rollback_pending &&
    session.merge?.state !== 'running';
  const reconciling =
    session?.state === 'reconciling'
      ? props.needs.items?.find(
          (i) => i.kind === 'session.reconciling' && i.source.id === sessionId,
        )
      : undefined;
  const flow = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  // Where the thread was last scrolled to, by the user or by following the bottom.
  const top = useRef(0);
  // A turn off screen holds a placeholder height until it is drawn, which moves the bottom with no render.
  const scroller = useCallback((el: HTMLDivElement) => {
    flow.current = el;
    const resized = new ResizeObserver(() => {
      if (!stuck.current) return;
      el.scrollTop = el.scrollHeight;
      top.current = el.scrollTop;
    });
    resized.observe(el.firstElementChild!);
    return () => resized.disconnect();
  }, []);

  // After every render: the cards, panel and look below the transcript change its height too.
  useLayoutEffect(() => {
    const el = flow.current;
    if (!el || !stuck.current) return;
    el.scrollTop = el.scrollHeight;
    top.current = el.scrollTop;
  });

  useEffect(() => showThreadTurns({ sessionId, turns: view?.turns ?? null }));
  useEffect(() => () => showThreadTurns({ sessionId, turns: null }), [sessionId]);

  const loose =
    view?.loose.items.filter((item) => item.kind !== 'event' || !isQuietEvent(item.event)) ?? [];
  const below = view ? unplacedPermissions(pending, view) : pending;
  const runningTurn = view?.turns.findLast((t) => t.turn.state === 'running');
  const kept = view?.turns.filter((t) => !t.turn.rolled_back);
  // The main agent's newest TodoWrite is the session's plan, as in the composer's todo line.
  const todoCall = kept
    ?.flatMap((t) => t.items)
    .findLast((i) => i.kind === 'tool' && i.name === 'TodoWrite' && !i.parent);
  const todos =
    todoCall?.kind === 'tool' ? (todoCall.input as { todos?: unknown } | null)?.todos : null;
  const plan =
    Array.isArray(todos) && todos.length > 0
      ? todos.map((todo): PlanStep => {
          const status = (todo as { status?: unknown } | null)?.status;
          return status === 'completed' || status === 'in_progress' ? status : 'pending';
        })
      : null;
  const turnTimes =
    view?.turns.map((t) => ({
      id: t.turn.id,
      at: t.at,
      ...(t.summary === undefined ? {} : { summary: t.summary }),
    })) ?? [];
  const waits = pending.flatMap((p) => {
    const at = events?.find((e) => e.aggregate_id === p.id)?.created_at;
    if (at === undefined) return [];
    const turn = view?.turns.find((t) =>
      t.items.some((item) => item.kind === 'request' && item.id === p.request),
    );
    return [{ id: p.id, at, turn: turn?.turn.id ?? null, question: !!p.questions?.length }];
  });
  const retryable = !!session && composeState(session).send.enabled;
  const planHistory = useBoardHistory(session?.project_id ?? null).data ?? null;
  const memoryTurns = useMemorySessionTurns(sessionId).data?.turns;
  const memoryCounts = new Map(memoryTurns?.map((m) => [m.turn_id, m.count]));
  // Held by content: `turnTimes` is new on every render, and each turn row takes its marks.
  const times = JSON.stringify(turnTimes);
  const marks = useMemo(() => {
    const byTurn = new Map<string | null, TimelineNode[]>();
    for (const node of timelineNodes({
      sessionId,
      history: planHistory,
      turns: JSON.parse(times),
      waits: [],
    }))
      // A key point names its turn only on the timeline.
      if (node.kind !== 'turn') byTurn.set(node.turn, [...(byTurn.get(node.turn) ?? []), node]);
    return byTurn;
  }, [sessionId, planHistory, times]);
  // Each turn's next turn that is not a steer or compaction turn.
  const afters = useMemo(() => {
    const turns = view?.turns ?? [];
    const ids: (string | null)[] = [];
    let next: string | null = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      ids[i] = next;
      const { turn } = turns[i]!;
      if (turn.kind !== 'steer' && turn.origin !== 'compaction') next = turn.id;
    }
    return ids;
  }, [view]);
  return (
    <>
      {props.head ??
        (!props.ownBar && (
          <SessionHeader
            session={session}
            listed={listed}
            title={title}
            parent={props.parent}
            plan={plan}
            panels={props.panels}
            {...(props.recent ? { recent: props.recent } : {})}
            onPanel={props.onPanel}
            overview={props.overview}
            {...(props.onOverview ? { onOverview: props.onOverview } : {})}
            onDiscarded={props.onDiscarded}
            {...(props.split ? { split: props.split } : {})}
            {...(props.terminal ? { terminal: props.terminal } : {})}
          />
        ))}
      {listed?.resident && !props.head && <WorkerStrip workers={props.workers ?? []} />}
      {finding && view && <ThreadFind turns={view.turns} scroller={flow} />}
      <div className="ss-flow" data-debug-region="sessions.transcript">
        {!props.head && timeline !== 'off' && (
          <MemoSessionTimeline
            sessionId={sessionId}
            history={planHistory}
            turns={turnTimes}
            waits={waits}
            goal={listed?.goal ?? null}
            title={listed?.title ?? ''}
            scroller={flow}
            slim={timeline === 'marks' || props.panels.length > 0}
          />
        )}
        <MarkdownLinks base={folders[0]} show={showLinked}>
          <div
            className="ss-scroll"
            ref={scroller}
            onWheel={(e) => {
              // A scroll up lands before its scroll event, and following the bottom would undo it.
              if (e.deltaY < 0 && e.currentTarget.scrollTop > 0) stuck.current = false;
            }}
            onKeyDown={(e) => {
              // In a field these keys move the caret, and a widget that takes them prevents the scroll.
              if (
                ['PageUp', 'ArrowUp', 'Home'].includes(e.key) &&
                !e.defaultPrevented &&
                e.currentTarget.scrollTop > 0 &&
                !(e.target as HTMLElement).closest('input, textarea, [contenteditable]')
              )
                stuck.current = false;
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
              // Following the bottom only moves down, so a move up short of the bottom is the user's, as when dragging the scrollbar.
              stuck.current = gap < 1 || (gap < 24 && el.scrollTop >= top.current);
              top.current = el.scrollTop;
            }}
          >
            <div className="ss-thread">
              <div className="tr-live" aria-live="polite">
                {spoken}
              </div>
              {history.error && <LoadError message={history.error} onRetry={history.reload} />}
              {listed?.resident &&
                listed.resident.kind !== 'personal' &&
                view?.turns.length === 0 && (
                  <p className="ss-emp">
                    {t(
                      {
                        id: 'sessions.residents.empty',
                        defaultMessage: 'Tell {name} what {project} should do next.',
                      },
                      {
                        name:
                          RESIDENTS.find((r) => r.kind === listed.resident!.kind)?.name ?? title,
                        project:
                          board.projects.find((p) => p.id === session?.project_id)?.name ?? '',
                      },
                    )}
                  </p>
                )}
              {view?.chapter && <ChapterMark event={view.chapter} />}
              {!view
                ? !history.error && (
                    <div className="tr-typing" aria-busy="true">
                      <Skeleton style={{ height: 10, width: '80%' }} />
                      <Skeleton style={{ height: 10, width: '50%' }} />
                    </div>
                  )
                : view.turns.map((t, i) => (
                    <MemoThreadTurn
                      key={t.turn.id}
                      view={t}
                      folders={folders}
                      status={statuses[i]!}
                      fresh={fresh}
                      request={request}
                      listed={listed}
                      after={afters[i]!}
                      checkpoint={checkpointAfter(view.turns[i + 1])}
                      retry={
                        retryable &&
                        i === view.turns.length - 1 &&
                        t.end?.state === 'failed' &&
                        !t.turn.origin
                      }
                      marks={marks.get(t.turn.id)}
                      memoryCount={memoryCounts.get(t.turn.id)}
                      statusInCompose={session?.state === 'running' && t === runningTurn}
                      forkSteps={forkSteps}
                      sessions={listedSessions}
                      personalKey={personalKey}
                    />
                  ))}
              {(expanded ? (view?.loose.items ?? []) : loose).length > 0 && (
                <Items
                  items={view!.loose.items}
                  verbose={expanded}
                  ended
                  folders={folders}
                  sessionId={sessionId}
                  owner="loose"
                  fresh={fresh}
                  request={request}
                />
              )}
              {below.map((p) => (
                <div
                  key={p.id}
                  className={`ss-req${fresh.has(`approval:${p.id}`) ? ' tr-in' : ''}`}
                  data-approval={p.id}
                >
                  <RequestCard permission={p} needs={props.needs} />
                </div>
              ))}
              {reconciling && <ResolveButtons item={reconciling} title={title} />}
              {session?.baseline && <BaselineReview session={session} />}
            </div>
          </div>
        </MarkdownLinks>
      </div>
      {session ? (
        <SessionCompose
          session={session}
          listed={listed}
          title={title}
          usage={kept?.findLast((t) => t.usage != null)?.usage ?? null}
          running={runningTurn ?? null}
          waiting={waitingFor}
          asks={<PendingQuestions session={session} pending={pending} scroller={flow} />}
          {...(active ? {} : { active })}
          {...(props.sessions ? { sessions: props.sessions } : {})}
        />
      ) : (
        <div className="cp-dock" aria-busy="true" />
      )}
    </>
  );
}

/** The next turn's id when it starts from a checkpoint that was not rolled back; a steer or compaction turn has none. */
const checkpointAfter = (next: TurnView | undefined) =>
  next && next.turn.kind !== 'steer' && next.turn.origin !== 'compaction' && !next.turn.rolled_back
    ? next.turn.id
    : null;

/** The one line a resident's turn woken by its workers, an outside event or a plan sync folds to. */
const WAKE: Partial<Record<NonNullable<SessionTurn['origin']>, () => string>> = {
  tracker: () => t({ id: 'sessions.residents.wake.tracker', defaultMessage: 'Workers reported' }),
  external: () => t({ id: 'sessions.residents.wake.external', defaultMessage: 'Outside event' }),
  sync: () => t({ id: 'sessions.residents.wake.sync', defaultMessage: 'Plan synced' }),
};

/** foldTurn, with what tell_user calls told the user kept outside the folded work. */
function foldTold(items: TranscriptItem[], told: ReadonlySet<TranscriptItem>) {
  const fold = foldTurn(items);
  if (!fold) return null;
  const work = fold.work.filter((item) => !told.has(item));
  if (!work.some((item) => item.kind === 'tool')) return null;
  const kept = items.filter(
    (item) => fold.kept.includes(item) || (told.has(item) && fold.work.includes(item)),
  );
  return { ...fold, work, kept };
}

const PantheonMark = () => (
  <svg className="ss-pg" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M1.8 5.2 7 2.2l5.2 3zM3.5 6.8v4M7 6.8v4M10.5 6.8v4M2 12.2h10" />
  </svg>
);

export function ThreadTurn(props: {
  view: TurnView;
  folders: readonly string[];
  status: TurnStatus;
  fresh: ReadonlySet<string>;
  request: (item: RequestItem, enter: string) => ReactNode;
  listed: WorkbenchSession | null;
  /** The next turn that starts from a checkpoint; a fork after this turn starts from it. */
  after?: string | null;
  /** The turn right after this one when it starts from a checkpoint that was not rolled back. */
  checkpoint?: string | null;
  /** The turn failed and is the session's last, which can take it again. */
  retry?: boolean;
  /** The tasks finished and milestones reached while this turn was the newest. */
  marks?: readonly TimelineNode[];
  /** How many memory entries the turn was given; none when it was given none. */
  memoryCount?: number;
  /** The composer's status line already says what this turn does. */
  statusInCompose?: boolean;
  /** The turn's tool calls offer a fork from before them. */
  forkSteps?: boolean;
  /** The project's listed sessions, read when a rewrite puts the turn's references back. */
  sessions?: () => readonly WorkbenchSession[];
  /** The built-in personal agent's key; a turn it sent names the personal agent. */
  personalKey?: string | null;
}) {
  const { view, listed } = props;
  const { turn } = view;
  const working = turn.state === 'running' || turn.state === 'queued';
  const streaming = props.status.kind === 'writing';
  const rollable =
    !!listed?.workspace_id &&
    listed.workspace_kind !== 'in_place' &&
    !endedText(listed) &&
    !turn.rolled_back &&
    !working;
  const busy = !!listed && ['running', 'merging', 'waiting'].includes(listed.state);
  const runtime = useBoard(
    (s) => s.board?.sessions.find((k) => k.id === turn.session_id)?.runtime ?? '',
  );
  const told = new Set<TranscriptItem>();
  // Only the personal agent's own thread looks for its needs-you reads and sent requests.
  const personal: { item: ToolItem; call: PersonalCall }[] = [];
  if (listed?.resident?.kind === 'personal')
    for (const item of view.items)
      if (item.kind === 'tool') {
        const call = personalCall(item);
        if (call) personal.push({ item, call });
      }
  // Items counts ids in `all`, which keeps view.items' places so the ids match threadIds.
  const all = view.items.map(toldItem);
  all.forEach((item, i) => item !== view.items[i] && told.add(item));
  const shown = personal.length
    ? all.filter((_, i) => personal.every((p) => p.item !== view.items[i]))
    : all;
  const reply = shown.flatMap((item) => (item.kind === 'text' ? [item.text] : []));
  const model = turn.reported_model ?? turn.model ?? null;
  const spoke = view.started_at ?? view.at;
  // Kept after streaming stops so the caret can fade out.
  const [caret, setCaret] = useState(false);
  useEffect(() => {
    if (streaming) setCaret(true);
  }, [streaming]);
  // A wake turn of a resident shows its input only once opened.
  const [wakeOpen, setWakeOpen] = useState(false);
  const wake =
    listed?.resident && turn.origin
      ? turn.wake?.causes.length && turn.wake.causes.every((cause) => cause === 'signal')
        ? () => t({ id: 'sessions.residents.wake.signals', defaultMessage: 'Signals' })
        : WAKE[turn.origin]
      : undefined;
  // A compaction is drawn as a mark, not as a message.
  const compaction = turn.origin === 'compaction';
  // Every origin but lead is Pantheon writing to the session.
  const from = turn.origin === 'lead' ? 'lead' : turn.origin ? 'pantheon' : null;
  const leadRuntime = useBoard((s) => {
    const lead = s.board?.sessions.find((k) => k.id === turn.session_id)?.task?.lead_session_id;
    return lead ? s.board?.sessions.find((k) => k.id === lead)?.runtime : undefined;
  });
  // In the baseline's own session a baseline turn carries the user's answers to a round; 0 elsewhere.
  const answersRound = useBoard((s) =>
    turn.origin === 'baseline' && s.board?.sessions.find((k) => k.id === turn.session_id)?.baseline
      ? (s.board.session_turns ?? [])
          .filter((k) => k.session_id === turn.session_id && k.origin === 'baseline')
          .findIndex((k) => k.id === turn.id) + 1
      : 0,
  );
  const sent = view.at === null ? null : clockText(view.at);
  const entering = props.fresh.has(`turn:${turn.id}`) ? ' tr-in' : '';
  const expanded = useLook().transcript === 'expanded';
  // An expanded transcript shows the whole turn.
  const fold = working || expanded || compaction ? null : foldTold(shown, told);
  const items = (shown: TranscriptItem[]) => (
    <Items
      items={shown}
      all={all}
      verbose={expanded}
      ended={view.end !== null || !working}
      folders={props.folders}
      sessionId={turn.session_id}
      owner={turn.id}
      // Folding draws the items in new places; with `fresh` they would enter a second time.
      {...(!fold && { fresh: props.fresh })}
      request={props.request}
      {...(props.forkSteps && { forkSteps: true })}
    />
  );
  return (
    <div className="ss-turn" data-turn={turn.id} data-rolled-back={turn.rolled_back || undefined}>
      {turn.rolled_back && (
        <span className="ss-vh">
          {t({ id: 'sessions.screen.rolledBack', defaultMessage: 'Rolled back' })}
        </span>
      )}
      {compaction ? (
        working && (
          <ThreadMark glyph={<RefreshCw className="si-spin" />} at={null}>
            <span>
              {t({ id: 'sessions.thread.compacting', defaultMessage: 'Compacting context' })}
            </span>
            {turn.input && (
              <span className="ss-marki" title={turn.input}>
                {turn.input}
              </span>
            )}
          </ThreadMark>
        )
      ) : wake ? (
        <>
          <button
            type="button"
            className="ss-ev"
            aria-expanded={wakeOpen}
            onClick={() => setWakeOpen((was) => !was)}
          >
            <Bell className="ic-sm" aria-hidden="true" />
            <span className="ss-ttl">{wake()}</span>
            {sent && <span className="ss-evt">{sent}</span>}
            <ChevronRight className="ic-sm ss-evc" aria-hidden="true" />
          </button>
          {wakeOpen && (
            <div className="ss-evn" data-find="input">
              {shownInput(turn)}
            </div>
          )}
        </>
      ) : (
        <div className="ss-uh" data-from={from ?? undefined}>
          <div className="ss-uc">
            {from === 'pantheon' ? (
              <div className={`ss-sys${entering}`} role="note">
                <PantheonMark />
                <div>
                  <div className="ss-from">
                    <b>Pantheon</b>
                    {sent && <span>{sent}</span>}
                  </div>
                  {turn.origin === 'baseline' ? (
                    <Collapsible.Root className="ss-hof">
                      <Collapsible.Trigger className="ss-hoft">
                        <ChevronRight aria-hidden="true" />
                        {answersRound
                          ? t(
                              {
                                id: 'sessions.thread.baselineAnswers',
                                defaultMessage: 'Your answers, round {round}',
                              },
                              { round: answersRound },
                            )
                          : t({
                              id: 'sessions.thread.confirmedBaseline',
                              defaultMessage: 'Confirmed baseline',
                            })}
                      </Collapsible.Trigger>
                      <Collapsible.Panel className="ss-hofp">
                        <div className="ss-hofx" data-find="input">
                          {shownInput(turn)}
                        </div>
                      </Collapsible.Panel>
                    </Collapsible.Root>
                  ) : (
                    <span data-find="input">{shownInput(turn)}</span>
                  )}
                </div>
              </div>
            ) : from === 'lead' ? (
              <div className={`ss-lead${entering}`} role="note">
                <div className="ss-from">
                  {leadRuntime && <RuntimeGlyph runtime={leadRuntime} />}
                  <b>lead</b>
                  {sent && <span>{sent}</span>}
                </div>
                <p data-find="input">{shownInput(turn)}</p>
              </div>
            ) : (
              <>
                {view.app && (
                  <span className="apd-from">
                    <AppWindow aria-hidden="true" />
                    <span className="mono">{view.app.server}</span>
                  </span>
                )}
                {turn.via &&
                  (turn.via.key_id === props.personalKey ? (
                    <span
                      className="apd-from"
                      role="group"
                      aria-label={t({
                        id: 'sessions.personalAgent.sentBy',
                        defaultMessage: 'Sent by Personal agent',
                      })}
                    >
                      <User aria-hidden="true" />
                      <button
                        type="button"
                        className="pn-ref"
                        onClick={() => void openPersonalAgent()}
                      >
                        {SCREEN_NAMES.personal}
                      </button>
                    </span>
                  ) : (
                    <span className="apd-from">
                      <KeyRound aria-hidden="true" />
                      {t({
                        id: 'sessions.thread.viaPersonal',
                        defaultMessage: 'Personal agent key',
                      })}
                    </span>
                  ))}
                <div className={`ss-user${entering}`} data-find="input">
                  {turn.input}
                </div>
                {turn.routing && (
                  <RoutingLine turn={{ ...turn, routing: turn.routing }} run={runCommand} />
                )}
              </>
            )}
            {turn.handoff && (
              <Collapsible.Root className="ss-hof">
                <Collapsible.Trigger className="ss-hoft">
                  <ChevronRight aria-hidden="true" />
                  {t({ id: 'sessions.screen.handoff', defaultMessage: 'Handoff notes' })}
                </Collapsible.Trigger>
                <Collapsible.Panel className="ss-hofp">
                  <div className="ss-hofx">{turn.handoff}</div>
                </Collapsible.Panel>
              </Collapsible.Root>
            )}
            <TurnActions
              sessionId={turn.session_id}
              turnId={turn.id}
              input={turn.input}
              attachments={turn.attachments ?? []}
              skills={turn.skills ?? []}
              refs={turn.refs ?? []}
              rollable={rollable}
              checkpointed={checkpointed(view)}
              busy={busy}
              {...(props.sessions ? { sessions: props.sessions } : {})}
            />
          </div>
        </div>
      )}
      {view.items.length > 0 && !compaction && (
        <div className="ss-who">
          <RuntimeGlyph runtime={runtime} />
          <b>{t({ id: 'sessions.thread.main', defaultMessage: 'Main' })}</b>
          {/* The main agent's mark, named by the word before it; the session need not be a lead. */}
          <Crown className="lead-crown" aria-hidden="true" />
          {model && <span>{model}</span>}
          {spoke !== null && <span className="ss-whot">{clockText(spoke)}</span>}
        </div>
      )}
      {personal.map(
        ({ item, call }) =>
          call.kind === 'sent' && (
            <PersonalSentLine key={`sent-${item.id}`} call={call} at={item.completed_at} />
          ),
      )}
      {fold ? (
        <>
          {items(fold.head)}
          <TurnWork
            work={fold.work}
            end={view.end}
            started_at={view.started_at}
            ended_at={view.ended_at}
          >
            {items(fold.work)}
          </TurnWork>
          {items(fold.kept)}
          {items(fold.tail)}
        </>
      ) : (
        items(shown)
      )}
      {personal.map(
        ({ item, call }) =>
          call.kind === 'needs' && (
            <PersonalNeedsList key={`needs-${item.id}`} items={call.items} at={call.at} />
          ),
      )}
      {(streaming || caret) && (
        <span
          className={streaming ? 'tr-caret' : 'tr-caret end'}
          aria-hidden="true"
          onTransitionEnd={() => setCaret(false)}
        />
      )}
      {!working && !!props.memoryCount && (
        <MemoryUsed sessionId={turn.session_id} turnId={turn.id} count={props.memoryCount} />
      )}
      {!working && reply.length > 0 && !compaction && (
        <ReplyActions
          sessionId={turn.session_id}
          text={reply.join('\n\n')}
          fork={rollable ? { before: props.after ?? null } : null}
          merging={listed?.state === 'merging'}
        />
      )}
      {!props.statusInCompose && !compaction && <TurnStatusLine status={props.status} />}
      {view.end?.state === 'cancelled' || view.end?.state === 'interrupted' ? (
        <div className="ss-nb" role="note">
          <span className="ss-nbd" data-tone="idle" aria-hidden="true" />
          <span>{t({ id: 'sessions.thread.interrupted', defaultMessage: 'Interrupted' })}</span>
          <span className="ss-nbx">
            {t({
              id: 'sessions.thread.interruptedKept',
              defaultMessage: 'Changes so far are kept',
            })}
          </span>
          {view.ended_at !== null && <span className="ss-nbt">{clockText(view.ended_at)}</span>}
        </div>
      ) : view.end?.state === 'failed' ? (
        <FailedNotice
          error={view.end.error}
          retry={
            props.retry && !compaction
              ? {
                  sessionId: turn.session_id,
                  input: turn.input,
                  attachments: (turn.attachments ?? []).map((a) => a.id),
                  skills: turn.skills ?? [],
                  refs: turn.refs ?? [],
                }
              : null
          }
        />
      ) : (
        view.end?.error && <span className="tr-err mono">{view.end.error}</span>
      )}
      {props.marks?.map((mark) => (
        <ThreadMark key={mark.id} glyph={TIMELINE_GLYPH[mark.kind]} at={mark.at}>
          <span>{mark.name}</span>
        </ThreadMark>
      ))}
      {rollable && props.checkpoint && (
        <ThreadMark glyph={<Undo2 />} at={null}>
          <span>{t({ id: 'sessions.thread.checkpoint', defaultMessage: 'Checkpoint' })}</span>
          {view.ended_at !== null && <span className="ss-markt">{clockText(view.ended_at)}</span>}
          <CheckpointBack sessionId={turn.session_id} turnId={props.checkpoint} busy={busy} />
        </ThreadMark>
      )}
    </div>
  );
}

/** A failed turn: its error, and on the session's last turn a retry that sends its input again. */
function FailedNotice(props: {
  error: string | null;
  retry: {
    sessionId: string;
    input: string;
    attachments: string[];
    skills: readonly { name: string; path: string }[];
    refs: NonNullable<SessionTurn['refs']>;
  } | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async (again: NonNullable<typeof props.retry>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'session.send',
      {
        session_id: again.sessionId,
        input: again.input,
        ...(again.attachments.length ? { attachments: again.attachments } : {}),
        ...(again.skills.length ? { skills: again.skills } : {}),
        ...(again.refs.length ? { refs: again.refs } : {}),
      },
      useBoard.getState().board?.sessions.find((s) => s.id === again.sessionId)?.revision ?? null,
    ).catch(fail);
    setBusy(false);
    if (!result.ok) setError(failureText(result.error));
  };
  return (
    <div className="ss-nb" role="note">
      <span className="ss-nbd" data-tone="bad" aria-hidden="true" />
      <span>{t({ id: 'sessions.thread.failed', defaultMessage: 'Failed' })}</span>
      {props.error && <span className="ss-nbx mono">{props.error}</span>}
      {props.retry && (
        <button
          type="button"
          className="btn ss-nbb"
          disabled={busy}
          aria-disabled={busy || undefined}
          onClick={() => void retry(props.retry!)}
        >
          {t({ id: 'sessions.screen.retry', defaultMessage: 'Retry' })}
        </button>
      )}
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** The list row fields ThreadTurn reads; the row is a new object on every list read. */
const sameListed = (a: WorkbenchSession | null, b: WorkbenchSession | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.id === b.id &&
    a.workspace_id === b.workspace_id &&
    a.workspace_kind === b.workspace_kind &&
    a.state === b.state);

/** ThreadTurn rendered again only when a prop changes; its status is a new object on every render. */
// `fresh` is not compared: it gains the ids of a turn only together with a new `view` for that turn.
const MemoThreadTurn = memo(ThreadTurn, (a, b) =>
  (Object.keys(b) as (keyof typeof b)[]).every(
    (key) =>
      key === 'fresh' ||
      (key === 'marks'
        ? JSON.stringify(a.marks) === JSON.stringify(b.marks)
        : key === 'status'
          ? a.status.kind === b.status.kind &&
            a.status.tool === b.status.tool &&
            a.status.since === b.status.since &&
            a.status.agents?.done === b.status.agents?.done &&
            a.status.agents?.total === b.status.agents?.total &&
            a.status.retry?.attempt === b.status.retry?.attempt
          : key === 'listed'
            ? sameListed(a.listed, b.listed)
            : Object.is(a[key], b[key])),
  ),
);

/** The status line of a working turn; only it re-renders as the seconds pass. */
function TurnStatusLine({ status }: { status: TurnStatus }) {
  const ticking = statusTicks(status.kind);
  useSecondTick(ticking);
  const text = turnStatusText(status, Date.now());
  if (!text) return null;
  const waiting = status.kind === 'approval' || status.kind === 'question';
  return (
    <div className="ss-stl">
      {status.kind === 'agents' ? (
        <Bot className="ic-sm" aria-hidden="true" />
      ) : (
        <span className="ss-stg" data-kind={waiting ? 'waiting' : status.kind} aria-hidden="true" />
      )}
      <div className={`tr-status ${waiting ? 'waiting' : status.kind}`}>
        {text}
        {ticking && (
          <span className="tr-shine" aria-hidden="true">
            {text}
          </span>
        )}
      </div>
    </div>
  );
}

const TIMELINE_GLYPH: Record<TimelineNode['kind'], ReactNode> = {
  goal: <span className="ss-ggoal" />,
  task: <CheckIcon className="ss-gok" aria-hidden="true" />,
  milestone: <span className="ss-gmile" />,
  wait: <span className="ss-gwait" />,
  turn: <Minus className="ss-gturn" aria-hidden="true" />,
};

/** The element of the thread a node points at: its turn, or the waiting card. */
const nodeTarget = (node: TimelineNode) =>
  node.turn !== null
    ? `[data-turn="${node.turn}"]`
    : `[data-approval="${node.id.slice('wait:'.length)}"]`;

// px: the rail's top padding and the height of a mark.
const RAIL_TOP = 24;
const MARK = 20;

/**
 * The thread's milestones along its left edge, spaced as in the thread; `slim` keeps only the marks.
 * Without nodes the rail still takes its column, so the first node moves neither thread nor composer.
 */
export function RequestIndex({
  nodes: given,
  scroller,
  slim,
}: {
  nodes: readonly TimelineNode[];
  scroller: RefObject<HTMLDivElement | null>;
  slim?: boolean;
}) {
  // A lone mark has nothing to place it against, and slim it reads as a stray button.
  const nodes = given.length > 1 ? given : [];
  // Where each node's target starts in the thread's content, and the part of it on screen.
  const [seen, setSeen] = useState<{ at: number[]; top: number; bottom: number } | null>(null);
  const targets = nodes.map(nodeTarget).join('\n');
  useEffect(() => {
    const el = scroller.current;
    if (!el || !targets) return;
    const measure = () => {
      const origin = el.getBoundingClientRect().top - el.scrollTop;
      let last = 0;
      const at = targets.split('\n').map((selector) => {
        const target = el.querySelector(selector);
        if (target) last = target.getBoundingClientRect().top - origin;
        return last;
      });
      setSeen({ at, top: el.scrollTop, bottom: el.scrollTop + el.clientHeight });
    };
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(el.firstElementChild!);
    // The window or the terminal dock resizes the thread with no change to its content.
    resized.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      resized.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [scroller, targets]);
  const jump = (node: TimelineNode) => {
    const el = scroller.current;
    const target = el?.querySelector(nodeTarget(node));
    if (!el || !target) return;
    // The turns a smooth scroll passes are drawn on the way and grow, so a far target keeps moving.
    const far =
      Math.abs(target.getBoundingClientRect().top - el.getBoundingClientRect().top) >
      2 * el.clientHeight;
    target.scrollIntoView({ block: 'start', behavior: far || reducedMotion() ? 'auto' : 'smooth' });
  };
  const at = seen?.at.length === nodes.length ? seen.at : null;
  const gaps = nodes.slice(1).map((_, i) => (at ? Math.max(0, at[i + 1]! - at[i]!) : 0));
  const widest = Math.max(1, ...gaps);
  const lines = gaps.map((gap) => 8 + Math.round((56 * gap) / widest));
  // The top of each mark on the rail.
  let above = 0;
  const tops = nodes.map((_, i) => {
    const top = RAIL_TOP + i * MARK + above;
    above += lines[i] ?? 0;
    return top;
  });
  /** A place in the thread as a place on the rail, between the marks around it. */
  const place = (y: number, from: readonly number[]) => {
    if (y <= from[0]!) return tops[0]!;
    const next = from.findIndex((a) => a > y);
    if (next === -1) return tops.at(-1)! + MARK;
    const span = from[next]! - from[next - 1]!;
    return tops[next - 1]! + ((y - from[next - 1]!) / span) * (tops[next]! - tops[next - 1]!);
  };
  // Past the last node the block stays on its mark, so it never frames empty rail.
  const from = at && seen ? Math.min(Math.round(place(seen.top, at)), tops.at(-1)!) : 0;
  const block =
    at && seen
      ? {
          top: from - 4,
          bottom: Math.max(Math.round(place(seen.bottom, at)), from + MARK) + 4,
        }
      : null;
  const current = at && seen ? at.findLastIndex((a) => a < seen.bottom) : -1;
  const rail = useRef<HTMLElement>(null);
  const currentTop = current === -1 ? null : tops[current]!;
  useEffect(() => {
    const el = rail.current;
    if (!el || currentTop === null) return;
    // A timeline taller than its column scrolls so the current mark stays on screen.
    if (currentTop - RAIL_TOP < el.scrollTop) el.scrollTop = currentTop - RAIL_TOP;
    else if (currentTop + MARK + RAIL_TOP > el.scrollTop + el.clientHeight)
      el.scrollTop = currentTop + MARK + RAIL_TOP - el.clientHeight;
  }, [currentTop]);
  return (
    <nav
      ref={rail}
      className="ss-tl"
      data-slim={slim || undefined}
      aria-label={t({ id: 'sessions.thread.timeline', defaultMessage: 'Session timeline' })}
      aria-hidden={nodes.length === 0 || undefined}
    >
      {block && (
        <i
          className="ss-tlv"
          aria-hidden="true"
          style={{ transform: `translateY(${block.top}px)`, height: block.bottom - block.top }}
        />
      )}
      {nodes.map((node, i) => (
        <Fragment key={node.id}>
          {i > 0 && <i className="ss-tla" aria-hidden="true" style={{ height: lines[i - 1] }} />}
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <button
                  type="button"
                  className="ss-tlm"
                  aria-current={i === current ? 'true' : undefined}
                  aria-label={t(
                    { id: 'sessions.thread.timeline.node', defaultMessage: '{time} {label}' },
                    { time: clockText(node.at), label: node.name },
                  )}
                  onClick={() => jump(node)}
                >
                  <span className="ss-tlg" data-kind={node.kind} aria-hidden="true">
                    {TIMELINE_GLYPH[node.kind]}
                  </span>
                  <span className="ss-tll">{node.label}</span>
                </button>
              }
            />
            <Tooltip.Portal>
              <Tooltip.Positioner side="right" sideOffset={8} style={{ zIndex: 60 }}>
                <Tooltip.Popup className="tip ss-rip">
                  <span>{node.name}</span>
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Fragment>
      ))}
    </nav>
  );
}

/** The timeline of the session: its goal, its tasks and milestones from the board history, and its waits. */
function SessionTimeline(props: {
  sessionId: string;
  history: BoardHistory | null;
  turns: readonly { id: string; at: number | null }[];
  waits: readonly { id: string; at: number; turn: string | null; question: boolean }[];
  goal: { text: string; at: string } | null;
  title: string;
  scroller: RefObject<HTMLDivElement | null>;
  slim: boolean;
}) {
  return (
    <RequestIndex
      nodes={timelineNodes({
        sessionId: props.sessionId,
        history: props.history,
        turns: props.turns,
        waits: props.waits,
        goal: props.goal,
        title: props.title,
      })}
      scroller={props.scroller}
      slim={props.slim}
    />
  );
}

// `turns` and `waits` are new arrays on every thread render; the timeline reads only their content.
const MemoSessionTimeline = memo(
  SessionTimeline,
  (a, b) =>
    a.sessionId === b.sessionId &&
    a.history === b.history &&
    a.scroller === b.scroller &&
    a.slim === b.slim &&
    a.title === b.title &&
    JSON.stringify(a.turns) === JSON.stringify(b.turns) &&
    JSON.stringify(a.waits) === JSON.stringify(b.waits) &&
    JSON.stringify(a.goal) === JSON.stringify(b.goal),
);
