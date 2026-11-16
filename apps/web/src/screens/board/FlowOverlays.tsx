import {
  Handle,
  Position,
  getBezierPath,
  type ConnectionLineComponentProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { ChevronDown } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { Tip } from '../../components/Tip';
import type { DraftEdit } from '../../data/plan-draft';
import type { PlanOp } from '../../data/plan-edit';
import { t } from '../../i18n';
import type { FlowGroup } from './flow-layout';
import { placeholder, stackMerged, stackTitle } from './MergedStack';
import { withMilestone } from './MilestoneNode';
import type { BoardMilestone } from './panels-model';
import { StateIcon } from './status';
import './flow-overlays.css';

export type DraftTask = Extract<PlanOp, { type: 'add_task' }>['task'];

/** A node of the chart that stands for something other than one task of the board. */
export type FlowOverlay =
  | { kind: 'stack'; members: string[] }
  | { kind: 'milestone'; milestone: BoardMilestone }
  | { kind: 'draft'; task: DraftTask };

/** The project the chart's plans belong to; null when no lead or task session is known. */
export function chartProject(
  model: Pick<BoardModel, 'tasks' | 'leads'>,
  sessions: readonly { id: string; project_id: string }[],
): string | null {
  const owners = new Set([
    ...(model.leads ?? []).map((l) => l.session_id),
    ...model.tasks.flatMap((t) => (t.owner_session_id ? [t.owner_session_id] : [])),
  ]);
  return sessions.find((s) => owners.has(s.id))?.project_id ?? null;
}

/**
 * The board as it stands once the drafted dependency changes are sent: each drafted list replaces
 * its task's dependencies and edges. `added` holds the ids of the edges only the draft draws.
 */
export function withDrafts(
  model: BoardModel,
  drafts: readonly DraftEdit[],
): { model: BoardModel; added: Set<string>; tasks: { leadId: string; task: DraftTask }[] } {
  const lists = new Map<string, string[]>();
  const tasks: { leadId: string; task: DraftTask }[] = [];
  for (const d of drafts)
    for (const op of d.ops) {
      if (op.type === 'set_dependencies')
        lists.set(`${d.target.leadId}:${op.task_id}`, op.depends_on);
      if (op.type === 'add_task') tasks.push({ leadId: d.target.leadId, task: op.task });
    }
  const ids = new Set(model.tasks.map((t) => t.id));
  const changed = [...lists.keys()].filter((id) => ids.has(id));
  if (!changed.length) return { model, added: new Set(), tasks };
  const owner = new Map(model.tasks.map((t) => [t.id, t.owner_session_id]));
  const before = new Set(model.edges.map((e) => `${e.from}->${e.to}`));
  const edges = [
    ...model.edges.filter((e) => !lists.has(e.to) || !ids.has(e.to)),
    ...changed.flatMap((to) =>
      lists
        .get(to)!
        .map((dep) => `${owner.get(to)}:${dep}`)
        .filter((from) => ids.has(from))
        .map((from) => ({ from, to, state: 'pending' as const })),
    ),
  ];
  return {
    model: {
      ...model,
      tasks: model.tasks.map((t) => (lists.has(t.id) ? { ...t, depends_on: lists.get(t.id)! } : t)),
      edges,
    },
    added: new Set(edges.map((e) => `${e.from}->${e.to}`).filter((id) => !before.has(id))),
    tasks,
  };
}

/**
 * What the layout places: the merged tasks of each band as one stack, the drafted new tasks after
 * their upstream tasks and the current milestone after its last tasks.
 */
export function flowGraph(
  model: BoardModel,
  group: FlowGroup,
  drafts: readonly { leadId: string; task: DraftTask }[],
  milestone: BoardMilestone | null,
): { model: BoardModel; overlays: Map<string, FlowOverlay> } {
  const stacked = stackMerged(model, group);
  const overlays = new Map<string, FlowOverlay>(stacked.overlays);
  const at = (id: string) => stacked.stackOf.get(id) ?? id;
  const tasks = [...stacked.model.tasks];
  const edges = [...stacked.model.edges];
  const known = new Set(tasks.map((t) => t.id));
  for (const { leadId, task } of drafts) {
    const id = `${leadId}:${task.id}`;
    if (known.has(id)) continue;
    known.add(id);
    overlays.set(id, { kind: 'draft', task });
    tasks.push(
      placeholder(id, {
        lane_id: `${leadId}:${task.lane}`,
        kind: task.kind,
        state: 'todo',
        planned: { runtime: task.runtime, model: task.model },
      }),
    );
    for (const dep of task.depends_on) {
      const from = at(`${leadId}:${dep}`);
      if (known.has(from) && !edges.some((e) => e.from === from && e.to === id))
        edges.push({ from, to: id, state: 'pending' });
    }
  }
  const drawn = withMilestone({ ...stacked.model, tasks, edges }, model.tasks, milestone, at);
  for (const [id, overlay] of drawn.overlays) overlays.set(id, overlay);
  return { model: drawn.model, overlays };
}

/** What an overlay node is called in the names of its edges. */
export function overlayTitle(overlay: FlowOverlay): string {
  switch (overlay.kind) {
    case 'stack':
      return stackTitle(overlay.members.length);
    case 'milestone':
      return overlay.milestone.title;
    case 'draft':
      return overlay.task.title;
  }
}

export const draftText = () =>
  t({ id: 'board.flow.draft.unsent', defaultMessage: 'Draft, not sent yet' });

/** The waiting task to jump to after `last`, in the order of `waiting`; the first after the end. */
export function nextWaiting(waiting: readonly string[], last: string | null): string | undefined {
  return waiting[(waiting.indexOf(last ?? '') + 1) % waiting.length];
}

/** How many items wait for the user, with a button that brings the next waiting task into view. */
export function NeedsCount({ count, onNext }: { count: number; onNext?: () => void }) {
  const nextText = t({
    id: 'board.flow.needs.next',
    defaultMessage: 'Jump to the next task waiting for you',
  });
  return (
    <div className="bd-fo bd-fo-needs">
      <span className="bd-fo-dot" data-c="wait" aria-hidden="true" />
      <span>{t({ id: 'board.flow.needs.label', defaultMessage: 'Needs you' })}</span>
      <span className="bd-fo-n">{count}</span>
      <Tip content={nextText}>
        <button
          type="button"
          className="ib"
          aria-label={nextText}
          disabled={!onNext}
          onClick={onNext}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}

const LEGEND: { c: string; text: () => string }[] = [
  { c: 'ok', text: () => t({ id: 'board.flow.legend.merged', defaultMessage: 'Merged' }) },
  { c: 'run', text: () => t({ id: 'board.flow.legend.running', defaultMessage: 'Running' }) },
  {
    c: 'wait',
    text: () => t({ id: 'board.flow.legend.waiting', defaultMessage: 'Waiting for you' }),
  },
  {
    c: 'review',
    text: () => t({ id: 'board.flow.legend.review', defaultMessage: 'To accept or merge' }),
  },
  {
    c: 'bad',
    text: () => t({ id: 'board.flow.legend.failed', defaultMessage: 'Blocked or failed' }),
  },
];

/** What each node colour means. */
export function FlowLegend() {
  return (
    <div
      className="bd-fo bd-fo-lg"
      role="group"
      aria-label={t({ id: 'board.flow.legend.label', defaultMessage: 'Legend' })}
    >
      <div className="legend">
        {LEGEND.map((item) => (
          <span key={item.c}>
            <span className="bd-fo-dot" data-c={item.c} aria-hidden="true" />
            {item.text()}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The dependency being dragged: a dashed line ending in a dot under the pointer. */
export function ConnectionLine({
  fromX,
  fromY,
  fromPosition,
  toX,
  toY,
  toPosition,
}: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  return (
    <g>
      <path className="react-flow__connection-path" d={path} />
      <circle className="bd-fo-end" cx={toX} cy={toY} r={4} />
    </g>
  );
}

export type DraftNode = Node<{ task: DraftTask }, 'draft'>;

/** A new task drafted on this window and not sent to its lead yet. */
export function DraftCard({ data }: NodeProps<DraftNode>) {
  const { task } = data;
  const fixed = { isConnectable: false };
  return (
    <>
      <Handle type="target" position={Position.Left} {...fixed} />
      <div className="bd-nd bd-fo-draft" data-look="queue">
        <div className="bd-nrow bd-nh">
          <StateIcon state="todo" />
          <span className="bd-nt">{task.title}</span>
        </div>
        <div className="bd-nrow bd-nw">
          {task.runtime && <RuntimeGlyph runtime={task.runtime} size={16} />}
          <span className="bd-na">{draftText()}</span>
        </div>
        {task.acceptance.length > 0 && (
          <div className="bd-nrow">
            <span className="bd-nacc" aria-hidden="true">
              {task.acceptance.map((_, i) => (
                <i key={i} />
              ))}
            </span>
            <span className="bd-na">
              {t(
                {
                  id: 'board.flow.draft.acceptance',
                  defaultMessage:
                    '{count, plural, one {# acceptance check} other {# acceptance checks}}',
                },
                { count: task.acceptance.length },
              )}
            </span>
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} {...fixed} />
    </>
  );
}
