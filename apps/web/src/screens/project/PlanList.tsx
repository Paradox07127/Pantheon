import { useEffect, useMemo, type CSSProperties } from 'react';
import type { ProjectOverlap, ProjectPlanView, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { DiffCounts } from '../../components/DiffCounts';
import { StateGlyph } from '../../components/SessionStateIcon';
import { GraphDiagram } from '../../components/visual/GraphDiagram';
import { useBoard } from '../../data/board';
import { useNow } from '../../data/needs-you';
import { t } from '../../i18n';
import { durationText } from '../../lib/time-text';
import { useShell } from '../../store';
import { RowMark } from '../changes/ChangesScreen';
import { EvidenceMark } from './EvidenceMark';
import { livePending, planContent } from './plan-edit';
import { flowEdgeNames, itemNode, nodeItem, planFlow } from './plan-flow';
import { PlanEditor, startPlanEdit } from './PlanEditor';
import {
  forYouText,
  gateRunsLabel,
  milestoneCount,
  overlapText,
  overlapsOf,
  planGlyph,
  planGroups,
  planReason,
  planStage,
  type PlanGroup,
  type PlanReason,
  type ShownPlanItem,
} from './project-model';

const openSession = (sessionId: string) => useShell.getState().openSession(sessionId);

/** A milestone's title, a bar of its items by state and how many of them landed. */
export function MilestoneHead({ group }: { group: PlanGroup }) {
  const count = milestoneCount(group.items);
  return (
    <div className="pj-mh">
      <h3 className="pj-mt">
        <Clip text={group.title} />
      </h3>
      <span className="pj-seg" role="img" aria-label={count.label}>
        {count.parts.map((part) => (
          <i
            key={part.bucket}
            data-tone={part.bucket}
            style={{ '--n': part.count } as CSSProperties}
          />
        ))}
      </span>
      <span className="pj-n">
        {t(
          { id: 'project.plan.landedOfTotal', defaultMessage: '{landed} / {total}' },
          { landed: count.landed, total: count.total },
        )}
      </span>
    </div>
  );
}

/** The line under an item's title; a wait on the user offers to open its session. */
export function ReasonLine({ reason, now }: { reason: PlanReason; now: number }) {
  const stuckSince =
    reason.kind === 'failure' || reason.kind === 'stuck' ? reason.stuckSince : null;
  return (
    <span className="pj-why">
      {reason.kind !== 'stuck' && <Clip text={reason.text} />}
      {reason.kind === 'failure' && (
        <span className="chip">
          {reason.handledBy === 'main_agent'
            ? t({ id: 'project.plan.mainAgentKnows', defaultMessage: 'Main agent knows' })
            : forYouText()}
        </span>
      )}
      {stuckSince && (
        <span className="chip pj-stuck">
          {t(
            { id: 'project.plan.stuck', defaultMessage: 'Stuck {duration}' },
            { duration: durationText(now - Date.parse(stuckSince)) },
          )}
        </span>
      )}
      {reason.kind === 'needs_you' && (
        <button
          type="button"
          className="btn sm pj-act"
          onClick={(e) => {
            e.stopPropagation();
            openSession(reason.sessionId);
          }}
        >
          {t({ id: 'project.plan.handle', defaultMessage: 'Handle' })}
        </button>
      )}
    </span>
  );
}

/** One plan item: state, title and reason, stage, runtime, diff size, gate runs and evidence. */
export function PlanRow({
  item,
  reason,
  shared = null,
  pending = false,
  now,
  selected,
  onSelect,
}: {
  item: ShownPlanItem;
  reason: PlanReason | null;
  /** Which other open session changed a file of this item's session; left out under a failure. */
  shared?: string | null;
  /** Edits sent to the main agent name the item and it has not written them yet. */
  pending?: boolean;
  now: number;
  selected: boolean;
  /** Absent for a row that does not open. */
  onSelect?: () => void;
}) {
  const stage = planStage(item);
  return (
    // The title button is the keyboard path; a click elsewhere on the row selects the same item.
    <li className="pj-it" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      <StateGlyph name={planGlyph(item)} />
      <span className="pj-t">
        {onSelect ? (
          <button type="button" className="pj-open" onClick={onSelect}>
            <Clip text={item.title} />
          </button>
        ) : (
          <Clip text={item.title} />
        )}
        {reason && <ReasonLine reason={reason} now={now} />}
        {shared && reason?.kind !== 'failure' && (
          <span className="pj-why">
            <Clip text={shared} />
          </span>
        )}
      </span>
      <span className="pj-stg">
        <span className="pj-pips" role="img" aria-label={stage.label}>
          {stage.cells.map((cell, k) => (
            <i key={k} data-cell={cell} data-tone={cell === 'current' ? item.status : undefined} />
          ))}
        </span>
        <Clip text={stage.name} />
      </span>
      <span className="pj-rtm">{item.change && <RowMark row={item.change} />}</span>
      <span className="pj-diff">
        {item.diff ? (
          <DiffCounts additions={item.diff.additions} deletions={item.diff.deletions} />
        ) : (
          '—'
        )}
      </span>
      {item.gate_runs.length > 0 ? (
        <span className="pj-gc" role="img" aria-label={gateRunsLabel(item.gate_runs)}>
          {item.gate_runs.map((run, k) => (
            <i key={k} data-run={run} />
          ))}
        </span>
      ) : (
        <span className="pj-dash">—</span>
      )}
      <EvidenceMark evidence={item.evidence} />
      {pending && pendingMark()}
    </li>
  );
}

const pendingMark = () => (
  <i
    className="pj-mk"
    role="img"
    aria-label={t({ id: 'project.plan.pending', defaultMessage: 'Pending' })}
  />
);

const FLOW_HEIGHT = 440;

/** The main agent's plan by milestone, as rows or as a graph of what waits for what; nothing while the project has no plan. */
export function PlanList({
  plan,
  sessions,
  selected,
  onSelect,
  view = 'list',
  overlap = null,
  projectId = null,
  main = null,
}: {
  plan: ProjectPlanView['plan'] | undefined;
  sessions: readonly WorkbenchSession[] | null;
  /** The item whose details are open. */
  selected: string | null;
  /** null once the graph lets the item go. */
  onSelect: (itemId: string | null) => void;
  view?: 'list' | 'flow';
  /** null while the overlap is unread or its read failed. */
  overlap?: ProjectOverlap | null;
  projectId?: string | null;
  /** The main agent the list's edits go to; none offers no edit. */
  main?: WorkbenchSession | null;
}) {
  const now = useNow(60_000);
  const draft = useShell((s) => (projectId ? s.planDrafts[projectId] : undefined));
  const sent = useShell((s) => (projectId ? s.planPending[projectId] : undefined));
  const target = useBoard((s) => s.board?.sessions.find((x) => x.id === sent?.sessionId));
  // The graph lays out again for a new spec, so it changes only with the plan.
  const flow = useMemo(() => (plan && view === 'flow' ? planFlow(plan) : null), [plan, view]);
  // Once written, the sent edits are forgotten, so a later turn neither shows nor adds to them;
  // watchPlanTurns forgets them once their turn ended.
  useEffect(() => {
    if (!projectId || !sent || !plan || planContent(plan) === sent.content) return;
    useShell.setState((s) => {
      if (s.planPending[projectId] !== sent) return {};
      const { [projectId]: _over, ...rest } = s.planPending;
      return { planPending: rest };
    });
  }, [projectId, sent, plan]);
  if (!plan) return null;
  const editable = !!projectId && !!main && plan.conductor_open && view === 'list';
  if (editable && draft)
    return <PlanEditor plan={plan} projectId={projectId} main={main} draft={draft} />;
  const live = livePending(sent, plan, target);
  const pending = new Set(live?.items);
  const addedTo = (group: string | null) =>
    (live?.added ?? []).filter((add) => add.group === (group ?? ''));
  const groups = planGroups(plan, pending);
  // A milestone with nothing shown but a new item sent to it.
  const shownGroups = [...plan.milestones, null].flatMap((m): PlanGroup[] => {
    const id = m?.id ?? null;
    const group = groups.find((g) => g.id === id);
    if (group) return [group];
    if (addedTo(id).length === 0) return [];
    const other = t({ id: 'project.plan.other', defaultMessage: 'Other' });
    return [{ id, title: m?.title ?? other, items: [] }];
  });
  const title = t({ id: 'project.plan.title', defaultMessage: 'Plan' });
  return (
    <section className="pj-list" aria-label={title}>
      <div className="pj-lh">
        <h2 className="pj-h2">{title}</h2>
        {!plan.conductor_open && (
          <span className="pj-n">
            {t({ id: 'project.plan.closed', defaultMessage: 'Main agent closed' })}
          </span>
        )}
        {editable && (
          <button
            type="button"
            className="btn ghost sm pj-end"
            onClick={() => startPlanEdit(projectId)}
          >
            {t({ id: 'project.plan.edit', defaultMessage: 'Edit' })}
          </button>
        )}
      </div>
      {flow ? (
        <GraphDiagram
          spec={flow}
          height={FLOW_HEIGHT}
          grows
          selected={selected === null ? null : itemNode(selected)}
          onSelect={(nodeId) => onSelect(nodeId === undefined ? null : nodeItem(nodeId))}
          styleNames={flowEdgeNames()}
        />
      ) : (
        shownGroups.map((group) => (
          <div key={group.id ?? ''} role="group" aria-label={group.title}>
            <MilestoneHead group={group} />
            <ul className="pj-rows">
              {group.items.map((item) => (
                <PlanRow
                  key={item.id}
                  item={item}
                  // A dropped item shown only while its restore is pending has nothing to handle or open.
                  reason={item.dropped ? null : planReason(item, plan.items, sessions)}
                  shared={overlapText(overlapsOf(overlap, item.session_id), sessions)}
                  pending={pending.has(item.id)}
                  now={now}
                  selected={item.id === selected}
                  onSelect={item.dropped ? undefined : () => onSelect(item.id)}
                />
              ))}
              {addedTo(group.id).map((add, k) => (
                <li key={`added-${k}`} className="pj-it">
                  <span>{pendingMark()}</span>
                  <span className="pj-t">
                    <Clip text={add.title} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
