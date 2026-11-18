import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Mail } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { RequestCard, type RequestCardProps } from '../../components/RequestCard';
import { StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { nextKey } from '../../data/attention';
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
  type BoardLead,
  type BoardNeed,
} from './frame-model';
import type { RunBoardCommand, SnapshotMilestone, SnapshotSession } from './panels-model';
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
): Pick<
  RequestCardProps,
  'who' | 'session' | 'lead' | 'task' | 'rung' | 'milestone' | 'improvement'
> {
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
    rung: task ? task.rung?.rung : undefined,
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
    useShell.setState({ stripWaits: new Set(shown?.flatMap((item) => needsKey(item) ?? [])) });
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
  // The row the user is on: the first until they settle one, then the one after it.
  const [current, setCurrent] = useState<string | null>(null);
  const on = needs?.some((item) => needKey(item) === current)
    ? current
    : needs?.[0] && needKey(needs[0]);
  const advancing = useRef(false);
  const primaries = useRef(new Map<string, HTMLButtonElement>());
  const advance = (acted: string) => {
    advancing.current = true;
    setCurrent(nextKey(needs?.map(needKey) ?? [], acted));
  };
  useEffect(() => {
    if (!advancing.current) return;
    const at = needs?.findIndex((item) => needKey(item) === current) ?? -1;
    if (at >= FOLDED && !all) return setAll(true);
    advancing.current = false;
    const card = list.current?.children[at] as HTMLElement | undefined;
    card?.scrollIntoView({ block: 'nearest' });
    (primaries.current.get(current ?? '') ?? card?.querySelector('button'))?.focus();
  }, [current, shown]);
  return (
    <Fold open={listed.length > 0}>
      <section
        className="bf-strip"
        aria-label={t({ id: 'board.frame.needs', defaultMessage: 'Needs you' })}
      >
        <div className="bf-strip-h">
          <span className="ss-dot waiting" aria-hidden="true" />
          <b>{t({ id: 'board.frame.needs', defaultMessage: 'Needs you' })}</b>
          <span className="bf-strip-n">{needs?.length}</span>
        </div>
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
                selected={needKey(item) === on}
                onActed={() => advance(needKey(item))}
                primaryRef={(el) => {
                  if (el) primaries.current.set(needKey(item), el);
                  else primaries.current.delete(needKey(item));
                }}
                {...needContext(item, model, sessions, stored, improvements ?? null)}
              />
            </li>
          ))}
        </ul>
        {needs && needs.length > FOLDED && !all && (
          <button
            type="button"
            className="bd-lnk bf-more"
            aria-expanded={false}
            onClick={() => setAll(true)}
          >
            {t(
              { id: 'board.frame.needs.more', defaultMessage: '{count} more' },
              { count: needs.length - FOLDED },
            )}
          </button>
        )}
      </section>
    </Fold>
  );
}
