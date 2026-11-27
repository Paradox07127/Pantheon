import { useMemo, type CSSProperties } from 'react';
import type { ProjectOverlap, ProjectPlanView, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { DiffCounts } from '../../components/DiffCounts';
import { StateGlyph } from '../../components/SessionStateIcon';
import { GraphDiagram } from '../../components/visual/GraphDiagram';
import { useNow } from '../../data/needs-you';
import { t } from '../../i18n';
import { durationText } from '../../lib/time-text';
import { useShell } from '../../store';
import { RowMark } from '../changes/ChangesScreen';
import { EvidenceMark } from './EvidenceMark';
import { flowEdgeNames, itemNode, nodeItem, planFlow } from './plan-flow';
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
  now,
  selected,
  onSelect,
}: {
  item: ShownPlanItem;
  reason: PlanReason | null;
  /** Which other open session changed a file of this item's session; left out under a failure. */
  shared?: string | null;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const stage = planStage(item);
  return (
    // The title button is the keyboard path; a click elsewhere on the row selects the same item.
    <li className="pj-it" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      <StateGlyph name={planGlyph(item)} />
      <span className="pj-t">
        <button type="button" className="pj-open" onClick={onSelect}>
          <Clip text={item.title} />
        </button>
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
    </li>
  );
}

const FLOW_HEIGHT = 440;

/** The main agent's plan by milestone, as rows or as a graph of what waits for what; nothing while the project has no plan. */
export function PlanList({
  plan,
  sessions,
  selected,
  onSelect,
  view = 'list',
  overlap = null,
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
}) {
  const now = useNow(60_000);
  // The graph lays out again for a new spec, so it changes only with the plan.
  const flow = useMemo(() => (plan && view === 'flow' ? planFlow(plan) : null), [plan, view]);
  if (!plan) return null;
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
        planGroups(plan).map((group) => (
          <div key={group.id ?? ''} role="group" aria-label={group.title}>
            <MilestoneHead group={group} />
            <ul className="pj-rows">
              {group.items.map((item) => (
                <PlanRow
                  key={item.id}
                  item={item}
                  reason={planReason(item, plan.items, sessions)}
                  shared={overlapText(overlapsOf(overlap, item.session_id), sessions)}
                  now={now}
                  selected={item.id === selected}
                  onSelect={() => onSelect(item.id)}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
