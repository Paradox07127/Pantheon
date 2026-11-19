import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Mail } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { RequestCard, type RequestCardProps } from '../../components/RequestCard';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { nextKey } from '../../data/attention';
import { useBoard } from '../../data/board';
import { needsKey } from '../../data/notice-tiers';
import { useImprovements, type Improvement } from '../../data/workflow-policy';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { acceptEvidence } from './Charts';
import { ProposalEdit } from './PlanProposals';
import {
  leadState,
  boardNeeds,
  needKey,
  needSession,
  needWho,
  type BoardLead,
  type BoardNeed,
} from './frame-model';
import {
  durationText,
  tokenText,
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
): Pick<
  RequestCardProps,
  | 'who'
  | 'session'
  | 'lead'
  | 'task'
  | 'rung'
  | 'milestone'
  | 'improvement'
  | 'taskMilestone'
  | 'proposal'
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
  const proposal =
    item.kind === 'board.plan.proposal'
      ? model.leads
          ?.find((l) => l.session_id === item.session_id)
          ?.pending_proposals?.find((p) => p.id === item.request_id)
      : undefined;
  return {
    taskMilestone: task
      ? model.milestones?.find((m) => m.id === task.milestone_id)?.title
      : undefined,
    proposal: proposal && {
      view: proposal,
      edit: (close) => (
        <ProposalEdit
          model={model}
          projectId={item.project_id}
          proposal={proposal}
          onCancel={close}
        />
      ),
    },
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

type Estimate = NonNullable<BoardModel['lanes'][number]['estimate']>;

const tasksText = (count: number) =>
  t(
    {
      id: 'board.needs.estimate.tasks',
      defaultMessage: '{count, plural, one {# task} other {# tasks}}',
    },
    { count },
  );

/** One amount of an estimate, Unknown without a value, and the tasks it covers. */
const amount = ({ value, source, tasks }: { value?: string; source?: string; tasks: number }) => (
  <span className="bf-el">
    <span className="bf-el-v" data-unknown={value === undefined || undefined}>
      {value ?? t({ id: 'board.needs.estimate.unknown', defaultMessage: 'Unknown' })}
    </span>
    {source && <span>{source}</span>}
    <span className="bf-el-n">{tasksText(tasks)}</span>
  </span>
);

/** What a lane held for plan approval is expected to take; amounts from different sources are never added up. */
function LaneEstimate({ lane, estimate }: { lane: string; estimate: Estimate }) {
  const parts = estimate.sessions.by_part;
  const { history, budget, unknown_tasks } = estimate.tokens;
  const timed = estimate.wall_ms?.tasks ?? 0;
  // Reviewer runtimes count the plan review sessions too, so they go only on the one row that has reviewers.
  const rows = [
    {
      count: parts.tasks,
      role: 'writer',
      label: t({ id: 'board.needs.estimate.writers', defaultMessage: 'Writers' }),
    },
    {
      count: parts.reviews,
      role: parts.plan_review ? null : 'reviewer',
      label: t({ id: 'board.needs.estimate.reviewers', defaultMessage: 'Reviewers' }),
    },
    {
      count: parts.plan_review,
      role: parts.reviews ? null : 'reviewer',
      label: t({ id: 'board.needs.estimate.planReview', defaultMessage: 'Plan review' }),
    },
    {
      count: parts.milestone_verify,
      role: 'verifier',
      label: t({ id: 'board.needs.estimate.verification', defaultMessage: 'Verification' }),
    },
  ].filter((row) => row.count > 0);
  return (
    <div
      className="bf-est"
      role="group"
      aria-label={t(
        { id: 'board.needs.estimate.label', defaultMessage: 'Estimate for {lane}' },
        { lane },
      )}
    >
      <div
        className="bf-es"
        role="group"
        aria-label={t(
          { id: 'board.needs.estimate.sessionsLabel', defaultMessage: 'Sessions: {count}' },
          { count: estimate.sessions.total },
        )}
      >
        <span className="cap">
          {t({ id: 'board.needs.estimate.sessions', defaultMessage: 'Sessions' })}
        </span>
        <span className="bf-es-t">{estimate.sessions.total}</span>
        {rows.map((row) => (
          <span key={row.label} className="bf-el">
            <span className="bf-el-v">{row.count}</span>
            <span>{row.label}</span>
            {row.role && (
              <span className="bf-el-rt">
                {estimate.runtimes
                  .filter((r) => r.role === row.role)
                  .map((r) => (
                    <span key={r.runtime} className="bf-el-r">
                      <span role="img" aria-label={runtimeName(r.runtime)}>
                        <RuntimeGlyph runtime={r.runtime} size={16} />
                      </span>
                      <span className="bf-el-n">{r.count}</span>
                    </span>
                  ))}
              </span>
            )}
          </span>
        ))}
      </div>
      <div
        className="bf-es"
        role="group"
        aria-label={t({ id: 'board.needs.estimate.tokens', defaultMessage: 'Tokens' })}
      >
        <span className="cap">
          {t({ id: 'board.needs.estimate.tokens', defaultMessage: 'Tokens' })}
        </span>
        {history.tasks > 0 &&
          amount({
            value: tokenText(history.total),
            source: t(
              {
                id: 'board.needs.estimate.history',
                defaultMessage:
                  '{runs, plural, one {In and out, from # past run} other {In and out, from # past runs}}',
              },
              { runs: history.min_n },
            ),
            tasks: history.tasks,
          })}
        {budget.tasks > 0 &&
          amount({
            value: tokenText(budget.total),
            source: t({
              id: 'board.needs.estimate.budgetTokens',
              defaultMessage: 'Input, from the budget',
            }),
            tasks: budget.tasks,
          })}
        {unknown_tasks > 0 && amount({ tasks: unknown_tasks })}
      </div>
      <div
        className="bf-es"
        role="group"
        aria-label={t({ id: 'board.needs.estimate.time', defaultMessage: 'Time' })}
      >
        <span className="cap">
          {t({ id: 'board.needs.estimate.time', defaultMessage: 'Time' })}
        </span>
        {estimate.wall_ms &&
          amount({
            value: durationText(estimate.wall_ms.total),
            source: t({ id: 'board.needs.estimate.budgetTime', defaultMessage: 'From the budget' }),
            tasks: estimate.wall_ms.tasks,
          })}
        {estimate.tasks > timed && amount({ tasks: estimate.tasks - timed })}
      </div>
    </div>
  );
}

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
  hidden,
  onShow,
  asked: stripAsked,
  onAsked,
}: {
  model: BoardModel;
  sessions: readonly SnapshotSession[];
  run: RunBoardCommand;
  onOpenSession: (sessionId: string) => void;
  stale?: boolean;
  /** The read of `useNeedImprovements`. */
  improvements?: readonly Improvement[] | null;
  /** Something else covers the strip; `onShow` uncovers it. */
  hidden?: boolean;
  onShow?: () => void;
  /** Focuses the first row once, then calls `onAsked`. */
  asked?: boolean;
  onAsked?: () => void;
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
  // The row the user is on: the first until they settle one, then the one after it.
  const [current, setCurrent] = useState<string | null>(null);
  // The wait a notice card or another part of the board asked for: unfolded to, made the current
  // row, scrolled into view and its primary button focused.
  const asked = useShell((s) => s.askedNeed);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const at = asked === null ? -1 : (needs?.findIndex((item) => needsKey(item) === asked) ?? -1);
    if (at < 0) return;
    if (hidden) return onShow?.();
    if (at >= FOLDED && !all) return setAll(true);
    const key = needKey(needs![at]!);
    setCurrent(key);
    const card = list.current?.children[at] as HTMLElement | undefined;
    card?.scrollIntoView({ block: 'nearest' });
    (primaries.current.get(key) ?? card?.querySelector('button'))?.focus();
    useShell.setState({ askedNeed: null });
  }, [asked, shown, hidden]);
  useEffect(() => {
    if (!stripAsked || !shown?.length) return;
    const card = list.current?.children[0] as HTMLElement | undefined;
    card?.scrollIntoView({ block: 'nearest' });
    (primaries.current.get(needKey(shown[0]!)) ?? card?.querySelector('button'))?.focus();
    onAsked?.();
  }, [stripAsked, shown]);
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
  // Every row's wait bar is on the scale of the longest wait, folded rows included.
  const longest = Math.max(0, ...(needs ?? []).map((item) => model.now - item.created_at));
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
          <span className="bf-strip-w">
            {t(
              { id: 'board.needs.longestWait', defaultMessage: 'Longest wait {duration}' },
              { duration: durationText(longest) },
            )}
          </span>
        </div>
        <ul ref={list} className="bf-needs">
          {shown?.map((item) => {
            // The board's lane ids are `<lead session id>:<lane id>`.
            const lane =
              item.kind === 'board.lane.approval'
                ? model.lanes.find((l) => l.id === `${item.session_id}:${item.request_id}`)
                : undefined;
            return (
              <li key={needKey(item)} className="bf-need">
                <RequestCard
                  item={item}
                  size="compact"
                  now={model.now}
                  waitScale={longest}
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
                  {...(lane?.estimate && {
                    sub: <LaneEstimate lane={lane.title} estimate={lane.estimate} />,
                  })}
                />
              </li>
            );
          })}
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
