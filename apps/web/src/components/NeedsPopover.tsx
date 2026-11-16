import { useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { WorkbenchSession } from '@pantheon/protocol';
import { useBoard } from '../data/board';
import { runCommand } from '../data/commands';
import { ageText, failureText, reasonText, useNow, type NeedsYouItem } from '../data/needs-you';
import { needsKey } from '../data/notice-tiers';
import { sessionTitle } from '../data/transcript';
import { t } from '../i18n';
import { durationText } from '../screens/board/panels-model';
import { runningSince, useProjectSessions } from '../shell/TrayPopover';
import { useShell } from '../store';
import { DiffCounts } from './DiffCounts';
import { ProjectMonogram } from './ProjectMonogram';
import { RuntimeGlyph } from './RuntimeGlyph';
import { GateMark, MergeBlockedGlyph, StateGlyph } from './SessionStateIcon';
import './needs-popover.css';

interface ListRow {
  key: string;
  projectId: string;
  /** The session the row opens; without one it opens the project. */
  sessionId: string | undefined;
  /** Opens what the row is about instead of the session. */
  open?: () => void;
  /** Unix milliseconds the wait or run began; the oldest comes first. */
  since: number;
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
  end?: ReactNode;
  dim?: boolean;
}

const STEPS: Readonly<Record<string, 1 | -1>> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };

/** Up, down, J and K move the focus between the rows' open buttons. */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  const step = STEPS[e.key];
  if (!step || e.metaKey || e.ctrlKey || e.altKey) return;
  const opens = [...e.currentTarget.querySelectorAll<HTMLElement>('.np-open')];
  const at = opens.findIndex((open) => open.parentElement?.contains(e.target as Node));
  const next = opens[at < 0 ? 0 : at + step];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

function openRow(row: ListRow) {
  if (row.open) row.open();
  else if (row.sessionId) useShell.getState().openProjectSession(row.projectId, row.sessionId);
  else useShell.getState().openProject(row.projectId);
}

/** The rows by project; projects and their rows in the order their oldest row began. */
function listPopover(props: {
  trigger: ReactElement;
  open: boolean;
  setOpen: (open: boolean) => void;
  label: string;
  rows: readonly ListRow[];
  projects: readonly { id: string; name: string }[];
}) {
  const groups = new Map<string, ListRow[]>();
  for (const row of [...props.rows].sort((a, b) => a.since - b.since))
    groups.set(row.projectId, [...(groups.get(row.projectId) ?? []), row]);
  return (
    <Popover.Root open={props.open} onOpenChange={props.setOpen}>
      <Popover.Trigger render={props.trigger} />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
          <Popover.Popup className="pop np" aria-label={props.label} onKeyDown={moveFocus}>
            {[...groups].map(([projectId, rows]) => {
              const name = props.projects.find((p) => p.id === projectId)?.name ?? '';
              return (
                <div key={projectId} role="group" aria-label={name} className="np-grp">
                  <div className="np-g">
                    <ProjectMonogram id={projectId} name={name} />
                    <b>{name}</b>
                    <span className="np-n">{rows.length}</span>
                  </div>
                  {rows.map((row) => (
                    <div key={row.key} className="np-r" data-dim={row.dim || undefined}>
                      <span className="np-ic">{row.icon}</span>
                      <button
                        type="button"
                        className="np-open"
                        onClick={() => {
                          props.setOpen(false);
                          openRow(row);
                        }}
                      >
                        <span className="np-t">{row.title}</span>
                        {row.detail && <span className="np-d">{row.detail}</span>}
                      </button>
                      <span className="np-a">{row.actions}</span>
                      <span className="np-e">{row.end}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function needsGlyph(item: NeedsYouItem): ReactNode {
  switch (item.kind) {
    case 'permission':
      return <StateGlyph name={item.questions?.length ? 'question' : 'approval'} />;
    case 'lead.question':
      return <StateGlyph name="question" />;
    case 'session.reconciling':
      return <StateGlyph name="reconciling" />;
    case 'session.failed':
    case 'session.gate_failed':
      return <StateGlyph name="failed" />;
    case 'session.merge_blocked':
      return <MergeBlockedGlyph />;
    case 'milestone.ready_for_acceptance':
      return <StateGlyph name="ready" />;
    case 'workflow.approval':
    case 'external.approval':
      return <StateGlyph name="approval" />;
    default:
      return <StateGlyph name="baseline_review" />;
  }
}

// A session item's source is the session itself.
const itemSession = (item: NeedsYouItem): string | undefined =>
  item.session_id ?? (item.source.table === 'sessions' ? item.source.id : undefined);

/** A permission request answered with allow or deny; one that asks questions opens instead. */
const answerable = (item: NeedsYouItem) =>
  item.kind === 'permission' &&
  item.reason === 'permission_requested' &&
  !item.questions?.length &&
  item.actions.find((a) => a.command === 'approval.respond')?.allowed === true;

const ANSWERING = '';
const NO_PROJECTS: readonly never[] = [];

/** What needs you across the projects, by project, the longest wait first. */
export function NeedsPopover({
  items,
  trigger,
}: {
  items: readonly NeedsYouItem[];
  trigger: ReactElement;
}) {
  const board = useBoard((s) => s.board);
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  // By approval id: ANSWERING while the answer is out, else why it failed.
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());

  async function answer(item: NeedsYouItem, decision: 'approve' | 'reject') {
    const id = item.source.id;
    setAnswers((all) => ({ ...all, [id]: ANSWERING }));
    const result = await runCommand(
      'approval.respond',
      { approval_id: id, decision },
      item.source.revision,
    );
    setAnswers(({ [id]: _, ...rest }) =>
      result.ok ? rest : { ...rest, [id]: failureText(result.error) },
    );
    if (result.ok) setAnswered((all) => new Set(all).add(id));
  }

  const rows = items
    .filter((item) => !answered.has(item.source.id))
    .map((item): ListRow => {
      const sessionId = itemSession(item);
      const session = sessionId ? board?.sessions.find((s) => s.id === sessionId) : undefined;
      const reason = reasonText(item.reason);
      const failed = answers[item.source.id];
      // A lead's question is answered on its card, which the lead's thread does not show.
      const card = item.kind === 'lead.question' ? needsKey(item) : null;
      return {
        key: `${item.source.table}:${item.source.id}:${item.reason}`,
        projectId: item.project_id,
        sessionId,
        ...(card && { open: () => useShell.getState().openProjectNeed(item.project_id, card) }),
        since: item.created_at,
        icon: needsGlyph(item),
        title: session && board ? sessionTitle(session, board) : reason,
        detail: failed ? <span role="alert">{failed}</span> : session ? reason : undefined,
        actions: answerable(item) && (
          <>
            <button
              type="button"
              className="btn sm pri"
              disabled={failed === ANSWERING}
              onClick={() => void answer(item, 'approve')}
            >
              {t({ id: 'projects.needs.allow', defaultMessage: 'Allow' })}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={failed === ANSWERING}
              onClick={() => void answer(item, 'reject')}
            >
              {t({ id: 'projects.needs.deny', defaultMessage: 'Deny' })}
            </button>
          </>
        ),
        end: ageText(item.created_at, now),
      };
    });

  return listPopover({
    trigger,
    open,
    setOpen,
    rows,
    projects: board?.projects ?? NO_PROJECTS,
    label: t(
      {
        id: 'projects.needs.label',
        defaultMessage: '{count, plural, one {# thing needs you} other {# things need you}}',
      },
      { count: rows.length },
    ),
  });
}

const RUNNING: readonly WorkbenchSession['state'][] = ['starting', 'running', 'merging'];

/** The running and queued, or the ready sessions of the projects, read while the list is open. */
export function SessionsPopover({
  show,
  projectIds,
  trigger,
}: {
  show: 'running' | 'ready';
  projectIds: readonly string[];
  trigger: ReactElement;
}) {
  const board = useBoard((s) => s.board);
  const events = useBoard((s) => s.events);
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const listed = useProjectSessions(open ? projectIds : NO_PROJECTS);

  const titleOf = (session: WorkbenchSession) => {
    const known = board?.sessions.find((s) => s.id === session.id);
    return known && board ? sessionTitle(known, board) : session.title;
  };
  const rows = listed.flatMap(({ project_id, session }): ListRow[] => {
    if (session.archived_at) return [];
    const base = { key: session.id, projectId: project_id, sessionId: session.id };
    const activity = Date.parse(session.last_activity_at);
    if (show === 'ready') {
      if (session.state !== 'ready') return [];
      const { additions = 0, deletions = 0 } = session.changes ?? {};
      return [
        {
          ...base,
          since: activity,
          icon: <StateGlyph name="ready" />,
          title: titleOf(session),
          detail: (
            <>
              <span className="mono">
                <DiffCounts additions={additions} deletions={deletions} />
              </span>
              <GateMark gate={session.gate} />
            </>
          ),
          actions: (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setOpen(false);
                useShell.getState().openProjectSession(project_id, session.id);
              }}
            >
              {t({ id: 'projects.ready.review', defaultMessage: 'Review' })}
            </button>
          ),
        },
      ];
    }
    const running = session.reconciling || RUNNING.includes(session.state);
    if (!running && session.last_turn?.state !== 'queued') return [];
    const since = running && board ? runningSince(session.id, board, events, session) : null;
    return [
      {
        ...base,
        since: since ?? activity,
        icon: <RuntimeGlyph runtime={session.runtime} />,
        title: titleOf(session),
        end: !running ? (
          <StateGlyph name="idle" />
        ) : (
          since !== null && durationText(Math.max(0, now - since))
        ),
        dim: !running,
      },
    ];
  });

  return listPopover({
    trigger,
    open,
    setOpen,
    rows,
    projects: board?.projects ?? NO_PROJECTS,
    label:
      show === 'ready'
        ? t(
            {
              id: 'projects.ready.label',
              defaultMessage:
                '{count, plural, one {# session ready to merge} other {# sessions ready to merge}}',
            },
            { count: rows.length },
          )
        : t(
            {
              id: 'projects.running.label',
              defaultMessage: '{count, plural, one {# running session} other {# running sessions}}',
            },
            { count: rows.length },
          ),
  });
}
