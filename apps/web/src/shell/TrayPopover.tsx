import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { ExternalLink, SquarePen } from 'lucide-react';
import type { BoardSnapshot, WorkbenchSession } from '@pantheon/protocol';
import { runtimeName } from '../components/RuntimeGlyph';
import { StateGlyph } from '../components/SessionStateIcon';
import { useBoard } from '../data/board';
import { runCommand } from '../data/commands';
import {
  failureText,
  needReasonText,
  useNeedsYou,
  useNow,
  type NeedsYouItem,
} from '../data/needs-you';
import { visibleProjects } from '../data/projects';
import { useRuntimeStatus } from '../data/runtime-status';
import type { DaemonEvent } from '../data/sync';
import { sessionTitle } from '../data/transcript';
import { readQuery, useFocusTick, useRefetchTick } from '../data/workbench-sessions';
import { t } from '../i18n';
import { keyText, shortcutKeys } from '../lib/shortcuts';
import { durationText } from '../lib/time-text';
import { resolveTheme, useShell } from '../store';
import { readyAfterPaint } from './window-kind';
import { EmptyState } from '../components/EmptyState';
import './tray-popover.css';

/** The needs-you reasons that want an answer now: a permission request, a question, a step, external request or lane plan to approve. */
export const WAITING: readonly NeedsYouItem['reason'][] = [
  'permission_requested',
  'lead_question',
  'workflow_approval',
  'external_approval',
  'lane_plan_awaiting_approval',
];
const SHOWN = 5;

/** A permission request answered with allow or deny; a request that asks questions opens instead. */
const isRequest = (item: NeedsYouItem) =>
  item.reason === 'permission_requested' && !item.questions?.length;

const SESSION_KINDS = ['session.', 'turn.', 'workspace.'];
const newestSessionEvent = (events: readonly DaemonEvent[]): number => {
  for (let i = events.length - 1; i >= 0; i--)
    if (SESSION_KINDS.some((prefix) => events[i]!.kind.startsWith(prefix)))
      return events[i]!.sequence;
  return 0;
};

/** The session lists of the projects, read again after session events, on focus and on resync. */
export function useProjectSessions(projectIds: readonly string[]) {
  const resync = useBoard((s) => s.resync);
  const tick = useRefetchTick(
    useBoard((s) => newestSessionEvent(s.events)),
    false,
  );
  const focus = useFocusTick();
  const [lists, setLists] = useState<Readonly<Record<string, readonly WorkbenchSession[]>>>({});
  const key = projectIds.join('\n');
  // Session events read only their own projects; the newest read sent of a project wins.
  const sent = useRef({
    triggers: null as readonly unknown[] | null,
    through: 0,
    order: 0,
    by: {} as Record<string, number>,
  });
  useEffect(() => {
    const s = sent.current;
    const triggers = [key, focus, resync];
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
    const read = whole || touched.has('') ? projectIds : projectIds.filter((id) => touched.has(id));
    const order = ++s.order;
    for (const project_id of read) {
      s.by[project_id] = order;
      void readQuery('session.list', { project_id }).then((result) => {
        if (s.by[project_id] !== order) return;
        const list =
          result.ok && Array.isArray(result.value) ? (result.value as WorkbenchSession[]) : null;
        setLists((all) => {
          const { [project_id]: _, ...rest } = all;
          return list ? { ...rest, [project_id]: list } : rest;
        });
      });
    }
  }, [key, tick, focus, resync]);
  return projectIds.flatMap((id) =>
    (lists[id] ?? []).map((session) => ({ project_id: id, session })),
  );
}

/** When the session's running turn started: from its event, else from the session list. */
export function runningSince(
  sessionId: string,
  board: BoardSnapshot,
  events: readonly DaemonEvent[],
  listed: WorkbenchSession | undefined,
): number | null {
  const turn = board.session_turns.find(
    (each) => each.session_id === sessionId && each.state === 'running',
  );
  if (turn)
    for (let i = events.length - 1; i >= 0; i--)
      if (events[i]!.kind === 'turn.running' && events[i]!.aggregate_id === turn.id)
        return events[i]!.created_at;
  return listed?.state === 'running' ? Date.parse(listed.last_activity_at) : null;
}

const NO_PROJECTS: readonly never[] = [];

/** The tray popover: what waits for an answer, what can be reviewed, what runs, and the quota. */
export function TrayPopover() {
  const board = useBoard((s) => s.board);
  const events = useBoard((s) => s.events);
  const theme = useShell((s) => s.theme);
  const needs = useNeedsYou(null);
  const { read } = useRuntimeStatus();
  const now = useNow(30_000);
  const projects = visibleProjects(board?.projects ?? NO_PROJECTS);
  const listed = useProjectSessions(projects.map((p) => p.id));
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const [listedOnce, setListedOnce] = useState(false);
  if (!listedOnce && (needs.items || needs.error)) setListedOnce(true);
  useEffect(() => (listedOnce ? readyAfterPaint() : undefined), [listedOnce]);

  useEffect(() => {
    useBoard.getState().start();
    return () => useBoard.getState().stop();
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle(
        'dark',
        resolveTheme(theme, query.matches) === 'dark',
      );
    apply();
    if (theme !== 'system') return;
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [theme]);

  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    let sent = 0;
    const observer = new ResizeObserver(() => {
      const px = Math.ceil(el.getBoundingClientRect().height);
      if (px === sent) return;
      sent = px;
      void window.pantheon?.setPopoverHeight(px).catch(() => {});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const open = (project_id: string, session_id?: string) =>
    void window.pantheon
      ?.showInMainWindow(session_id ? { project_id, session_id } : { project_id })
      .catch(() => {});
  const reveal = () => void window.pantheon?.revealMain().catch(() => {});
  const newSession = () => void window.pantheon?.revealMain('new-session').catch(() => {});

  async function answer(item: NeedsYouItem, decision: 'approve' | 'reject') {
    const id = item.source.id;
    if (busy.has(id)) return;
    setBusy((all) => new Set(all).add(id));
    setFailures(({ [id]: _, ...rest }) => rest);
    const result = await runCommand(
      'approval.respond',
      { approval_id: id, decision },
      item.source.revision,
    );
    setBusy((all) => {
      const next = new Set(all);
      next.delete(id);
      return next;
    });
    if (result.ok) setAnswered((all) => new Set(all).add(id));
    else setFailures((all) => ({ ...all, [id]: failureText(result.error) }));
  }

  const shownProjects = new Set(projects.map((p) => p.id));
  const listedById = new Map(listed.map(({ session }) => [session.id, session]));
  const nameOf = (project_id: string, session_id?: string): string => {
    const session = session_id ? board?.sessions.find((s) => s.id === session_id) : undefined;
    if (session && board) return sessionTitle(session, board);
    const row = session_id ? listedById.get(session_id) : undefined;
    return row?.title || (board?.projects.find((p) => p.id === project_id)?.name ?? '');
  };

  const waiting = (needs.items ?? []).filter(
    (item) =>
      shownProjects.has(item.project_id) &&
      WAITING.includes(item.reason) &&
      !answered.has(item.source.id),
  );
  const reviewable = listed.filter(({ session }) => session.state === 'ready');
  const running = (board?.sessions ?? []).filter(
    (s) => s.state === 'running' && shownProjects.has(s.project_id),
  );
  const quotas =
    read.state === 'ready'
      ? read.statuses.flatMap((s) =>
          s.quota?.windows.length
            ? [
                {
                  runtime: s.runtime,
                  percent: Math.round(Math.max(...s.quota.windows.map((w) => w.used_percent))),
                },
              ]
            : [],
        )
      : [];

  const head = (title: string, count: number) => (
    <h2 className="tp-h">
      {title}
      <span className="tp-n">{count}</span>
    </h2>
  );

  const waitingItem = (item: NeedsYouItem) => {
    const id = item.source.id;
    const waited = durationText(now - item.created_at);
    if (!isRequest(item)) {
      const approval = item.reason !== 'lead_question';
      const label = approval
        ? needReasonText(item)
        : t(
            { id: 'trayPopover.waiting.asked', defaultMessage: '{name} asked a question' },
            { name: nameOf(item.project_id, item.session_id) },
          );
      return (
        <button
          type="button"
          key={id}
          className="tp-row"
          // An external request that waits is listed by its lead session.
          onClick={() =>
            open(
              item.project_id,
              item.reason === 'external_approval' ? item.source.id : item.session_id,
            )
          }
        >
          <span className="tp-ic" aria-hidden="true">
            <StateGlyph name={approval ? 'approval' : 'question'} />
          </span>
          <span className="tp-nm">{label}</span>
          <span className="tp-ct">{waited}</span>
        </button>
      );
    }
    const off =
      needs.error !== null ||
      busy.has(id) ||
      item.actions.find((a) => a.command === 'approval.respond')?.allowed !== true;
    const summary = item.binding?.input_summary;
    return (
      <div key={id} className="tp-ask">
        <div className="tp-ah">
          <span className="tp-ic" aria-hidden="true">
            <StateGlyph name="approval" />
          </span>
          <span className="tp-nm">{nameOf(item.project_id, item.session_id)}</span>
          <span className="tp-ct">{waited}</span>
        </div>
        {summary && <code className="tp-cmd">{summary}</code>}
        <div className="tp-acts">
          <button
            type="button"
            className="btn sm pri"
            disabled={off}
            onClick={() => void answer(item, 'approve')}
          >
            {t({ id: 'trayPopover.waiting.allow', defaultMessage: 'Allow' })}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={off}
            onClick={() => void answer(item, 'reject')}
          >
            {t({ id: 'trayPopover.waiting.deny', defaultMessage: 'Deny' })}
          </button>
          <button
            type="button"
            className="btn sm ghost tp-open"
            onClick={() => open(item.project_id, item.session_id)}
          >
            {t({ id: 'trayPopover.open', defaultMessage: 'Open' })}
          </button>
        </div>
        {failures[id] && (
          <p className="tp-err" role="alert">
            {failures[id]}
          </p>
        )}
      </div>
    );
  };

  const blocks: ReactElement[] = [];
  if (waiting.length)
    blocks.push(
      <section key="waiting" className="tp-g">
        {head(
          t({ id: 'trayPopover.waiting.title', defaultMessage: 'Waiting for you' }),
          waiting.length,
        )}
        {waiting.slice(0, SHOWN).map(waitingItem)}
        {waiting.length > SHOWN && (
          <button type="button" className="tp-row" onClick={reveal}>
            <span className="tp-ic" />
            <span className="tp-nm">
              {t(
                {
                  id: 'trayPopover.waiting.more',
                  defaultMessage: '{count, plural, one {# more} other {# more}}',
                },
                { count: waiting.length - SHOWN },
              )}
            </span>
          </button>
        )}
      </section>,
    );
  if (reviewable.length)
    blocks.push(
      <section key="review" className="tp-g">
        {head(
          t({ id: 'trayPopover.review.title', defaultMessage: 'Ready to review' }),
          reviewable.length,
        )}
        {reviewable.map(({ project_id, session }) => (
          <button
            type="button"
            key={session.id}
            className="tp-row"
            onClick={() => open(project_id, session.id)}
          >
            <span className="tp-ic" aria-hidden="true">
              <StateGlyph name="ready" />
            </span>
            <span className="tp-nm">{session.title || nameOf(project_id, session.id)}</span>
          </button>
        ))}
      </section>,
    );
  if (running.length && board)
    blocks.push(
      <section key="running" className="tp-g">
        {head(t({ id: 'trayPopover.running.title', defaultMessage: 'Running' }), running.length)}
        {running.map((session) => {
          const since = runningSince(session.id, board, events, listedById.get(session.id));
          return (
            <button
              type="button"
              key={session.id}
              className="tp-row"
              onClick={() => open(session.project_id, session.id)}
            >
              <span className="tp-ic" aria-hidden="true">
                <StateGlyph name="running" />
              </span>
              <span className="tp-nm">{sessionTitle(session, board)}</span>
              {since !== null && (
                <span className="tp-ct">{durationText(Math.max(0, now - since))}</span>
              )}
            </button>
          );
        })}
      </section>,
    );
  if (quotas.length)
    blocks.push(
      <div key="quota" className="tp-g">
        {quotas.map(({ runtime, percent }) => {
          const label = t(
            { id: 'trayPopover.quota.label', defaultMessage: '{runtime} subscription quota' },
            { runtime: runtimeName(runtime) },
          );
          return (
            <div key={runtime} className="tp-quota">
              <div className="tp-qh">
                <span className="tp-nm">{label}</span>
                <span className="tp-n">{`${percent}%`}</span>
              </div>
              <div
                className="meter"
                role="meter"
                aria-label={label}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                style={{ '--v': `${percent}%` } as CSSProperties}
              >
                <i />
              </div>
            </div>
          );
        })}
      </div>,
    );
  if (needs.error)
    blocks.unshift(
      <p key="error" className="tp-err" role="alert">
        {needs.error}
      </p>,
    );
  else if (!blocks.length && needs.items)
    blocks.push(
      <EmptyState
        key="none"
        inline
        title={t({ id: 'trayPopover.empty', defaultMessage: 'Nothing needs you right now' })}
      />,
    );

  return (
    <div className="tp-win">
      <div className="tp" ref={measure}>
        {blocks.flatMap((block, i) =>
          i ? [<hr key={`sep-${i}`} className="tp-sep" />, block] : [block],
        )}
        {blocks.length > 0 && <hr className="tp-sep" />}
        <button type="button" className="tp-row" onClick={newSession}>
          <span className="tp-ic" aria-hidden="true">
            <SquarePen />
          </span>
          <span className="tp-nm">
            {t({ id: 'trayPopover.newSession', defaultMessage: 'New session' })}
          </span>
          <span className="tp-ct">
            <kbd className="kbd">{keyText(shortcutKeys('new'))}</kbd>
          </span>
        </button>
        <button type="button" className="tp-row" onClick={reveal}>
          <span className="tp-ic" aria-hidden="true">
            <ExternalLink />
          </span>
          <span className="tp-nm">
            {t({ id: 'trayPopover.openPantheon', defaultMessage: 'Open Pantheon' })}
          </span>
        </button>
      </div>
    </div>
  );
}
