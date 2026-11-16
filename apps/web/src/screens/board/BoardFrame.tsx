import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Mail } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { RequestCard, type RequestCardProps } from '../../components/RequestCard';
import { StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import { needsKey } from '../../data/notice-tiers';
import { useImprovements, type Improvement } from '../../data/workflow-policy';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { acceptEvidence } from './Charts';
import {
  leadState,
  boardNeeds,
  needKey,
  needSession,
  needWho,
  seenOf,
  sinceLast,
  type BoardLead,
  type BoardNeed,
  type SeenBoard,
  type SinceLast,
} from './frame-model';
import {
  durationText,
  type RunBoardCommand,
  type SnapshotMilestone,
  type SnapshotSession,
} from './panels-model';
import './frame.css';

/** Each lead's state in the headline bar; a lead opens its session. */
export function LeadStates({
  leads,
  onOpenSession,
}: {
  leads: readonly BoardLead[];
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div
      className="bf-leads"
      role="group"
      aria-label={t({ id: 'board.frame.leads', defaultMessage: 'Leads' })}
    >
      {leads.map((lead) => {
        const state = leadState(lead);
        const name = lead.title || t({ id: 'board.lead.untitled', defaultMessage: 'Lead' });
        const button = (
          <button
            key={lead.session_id}
            type="button"
            className="bf-lead"
            aria-label={
              lead.inbox > 0
                ? t(
                    {
                      id: 'board.frame.lead.labelUnread',
                      defaultMessage: '{name} {state}, {count} unread, open session',
                    },
                    { name, state: state.label, count: lead.inbox },
                  )
                : t(
                    {
                      id: 'board.frame.lead.label',
                      defaultMessage: '{name} {state}, open session',
                    },
                    { name, state: state.label },
                  )
            }
            onClick={() => onOpenSession(lead.session_id)}
          >
            <StateGlyph name={state.glyph} />
            <span>{state.label}</span>
            {lead.inbox > 0 && (
              <span className="bf-inbox">
                <Mail aria-hidden="true" />
                <b>{lead.inbox}</b>
              </span>
            )}
          </button>
        );
        return lead.title ? (
          <Tip key={lead.session_id} content={lead.title}>
            {button}
          </Tip>
        ) : (
          button
        );
      })}
    </div>
  );
}

/** Keeps the last non-empty value, so a strip folding away still shows what it held. */
function useKept<T>(value: T | null): T | null {
  const [kept, setKept] = useState(value);
  if (value !== null && value !== kept) setKept(value);
  return value ?? kept;
}

/** A strip that folds open and shut with its height. */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <Collapsible.Root className="bf-fold" open={open}>
      <Collapsible.Panel className="bf-foldp">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** The card props of one item of the strip: who waits, its session, its task and the task's lead, its milestone and its proposal. */
export function needContext(
  item: BoardNeed,
  model: BoardModel,
  sessions: readonly SnapshotSession[],
  stored: readonly SnapshotMilestone[],
  improvements: readonly Improvement[] | null,
): Pick<RequestCardProps, 'who' | 'session' | 'lead' | 'task' | 'milestone' | 'improvement'> {
  const session = sessions.find((s) => s.id === needSession(item));
  const lead = session?.task && sessions.find((s) => s.id === session.task!.lead_session_id);
  const task =
    session?.task &&
    model.tasks.find((t) => t.id === `${session.task!.lead_session_id}:${session.task!.id}`);
  const milestone =
    item.source.table === 'milestones'
      ? model.milestones?.find((m) => m.id === item.source.id)
      : undefined;
  return {
    who: needWho(item, model, sessions),
    session,
    lead: lead || undefined,
    task: task ? task.title : undefined,
    milestone: milestone && {
      milestone,
      stored: stored.find((m) => m.id === milestone.id),
      cells: model.tasks.filter((t) => t.milestone_id === milestone.id),
      evidence: acceptEvidence(milestone, model, sessions),
    },
    improvement:
      item.source.table === 'improvements'
        ? improvements?.find((i) => i.id === item.source.id)
        : undefined,
  };
}

const FOLDED = 3;
const NO_MILESTONES: readonly SnapshotMilestone[] = [];

/** The proposals the needs-you items point at, read only while the strip holds one. */
export function useNeedImprovements(model: BoardModel | null) {
  // Kept as the strip keeps its items, so a strip folding away still finds its proposals.
  const needs = useKept(model?.needs?.length ? model.needs : null);
  return useImprovements(
    needs?.find((item) => item.source.table === 'improvements')?.project_id ?? null,
  );
}

/** The items waiting on the user, those unblocking the most tasks first. */
export function NeedsStrip({
  model,
  sessions,
  run,
  onOpenSession,
  stale,
  improvements,
}: {
  model: BoardModel;
  sessions: readonly SnapshotSession[];
  run: RunBoardCommand;
  onOpenSession: (sessionId: string) => void;
  stale?: boolean;
  /** The read of `useNeedImprovements`. */
  improvements?: readonly Improvement[] | null;
}) {
  // useKept compares by identity.
  const listed = useMemo(() => boardNeeds(model), [model.needs]);
  const needs = useKept(listed.length ? listed : null);
  const stored = useBoard((s) => s.board?.milestones) ?? NO_MILESTONES;
  const [all, setAll] = useState(false);
  const shown = useMemo(() => needs && (all ? needs : needs.slice(0, FOLDED)), [needs, all]);
  useEffect(() => {
    useShell.setState({ boardWaits: new Set(shown?.flatMap((item) => needsKey(item) ?? [])) });
  }, [shown]);
  // The wait a notice card opened: unfolded to, scrolled into view and its first answer focused.
  const asked = useShell((s) => s.askedNeed);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const at = asked === null ? -1 : (needs?.findIndex((item) => needsKey(item) === asked) ?? -1);
    if (at < 0) return;
    if (at >= FOLDED && !all) return setAll(true);
    const card = list.current?.children[at] as HTMLElement | undefined;
    card?.scrollIntoView({ block: 'nearest' });
    card?.querySelector('button')?.focus();
    useShell.setState({ askedNeed: null });
  }, [asked, shown]);
  return (
    <Fold open={listed.length > 0}>
      <section
        className="bf-strip"
        aria-label={t({ id: 'board.frame.needs', defaultMessage: 'Needs you' })}
      >
        <ul ref={list} className="bf-needs">
          {shown?.map((item) => (
            <li key={needKey(item)} className="bf-need">
              <RequestCard
                item={item}
                size="compact"
                now={model.now}
                run={run}
                onOpenSession={onOpenSession}
                stale={stale}
                {...needContext(item, model, sessions, stored, improvements ?? null)}
              />
            </li>
          ))}
        </ul>
        {needs && needs.length > FOLDED && (
          <button
            type="button"
            className="bd-lnk bf-more"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all
              ? t({ id: 'board.frame.needs.less', defaultMessage: 'Show less' })
              : t(
                  { id: 'board.frame.needs.more', defaultMessage: '{count} more' },
                  { count: needs.length - FOLDED },
                )}
          </button>
        )}
      </section>
    </Fold>
  );
}

const SEEN_KEY = 'pantheon.board-seen.v2';

function readSeen(projectId: string): SeenBoard | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, SeenBoard>;
    return all[projectId];
  } catch {
    return undefined;
  }
}

function writeSeen(projectId: string, seen: SeenBoard) {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, SeenBoard>;
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...all, [projectId]: seen }));
  } catch {
    // The strip then shows changes since this visit until the app closes.
  }
}

const SINCE: { key: keyof SinceLast; label: (count: number) => string }[] = [
  {
    key: 'merged',
    label: (count) =>
      t({ id: 'board.frame.since.mergedCount', defaultMessage: 'Merged {count}' }, { count }),
  },
  {
    key: 'failed',
    label: (count) =>
      t({ id: 'board.frame.since.failedCount', defaultMessage: 'Failed {count}' }, { count }),
  },
  {
    key: 'questions',
    label: (count) =>
      t({ id: 'board.frame.since.questions', defaultMessage: 'Questions {count}' }, { count }),
  },
];

/**
 * How long the user was away and what changed on the board since they last marked it read; the
 * first visit only remembers it.
 */
export function SinceStrip({ projectId, model }: { projectId: string; model: BoardModel }) {
  const [seen, setSeen] = useState<{ projectId: string; board: SeenBoard } | null>(null);
  useEffect(() => {
    if (seen?.projectId === projectId) return;
    let board = readSeen(projectId);
    if (!board) {
      board = seenOf(model);
      writeSeen(projectId, board);
    }
    setSeen({ projectId, board });
  }, [projectId, model, seen]);
  const current = useMemo(
    () => (seen?.projectId === projectId ? sinceLast(seen.board, model) : null),
    [seen, projectId, model],
  );
  if (!current || !seen) return null;
  const read = () => {
    const board = seenOf(model);
    writeSeen(projectId, board);
    setSeen({ projectId, board });
  };
  return (
    <div
      className="bf-since"
      role="group"
      aria-label={t({ id: 'board.frame.since.label', defaultMessage: 'Since last visit' })}
    >
      <span className="bf-away">
        {t(
          { id: 'board.frame.since.away', defaultMessage: 'Away {duration}' },
          { duration: durationText(model.now - seen.board.at) },
        )}
      </span>
      {SINCE.filter((s) => current[s.key] > 0).map((s) => (
        <span key={s.key} className="bf-sc" data-kind={s.key}>
          {s.label(current[s.key])}
        </span>
      ))}
      <button type="button" className="btn bf-read" onClick={read}>
        {t({ id: 'board.frame.since.read', defaultMessage: 'Mark as read' })}
      </button>
    </div>
  );
}
