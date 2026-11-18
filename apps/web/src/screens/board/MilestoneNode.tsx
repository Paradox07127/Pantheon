import { useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Flag } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { t } from '../../i18n';
import type { FlowOverlay } from './FlowOverlays';
import { placeholder } from './MergedStack';
import { daysLeft, dueText, VerifyBadge } from './MilestoneCard';
import { milestoneCounts, type BoardMilestone } from './panels-model';

type Task = BoardModel['tasks'][number];

/**
 * The milestone after the last of its tasks on the chart, in the band of the first of them; the
 * chart stays as it is when none of its tasks is on it. `at` maps a task to the node it is drawn in.
 */
export function withMilestone(
  model: BoardModel,
  tasks: readonly Task[],
  milestone: BoardMilestone | null,
  at: (taskId: string) => string,
): { model: BoardModel; overlays: Map<string, FlowOverlay> } {
  const overlays = new Map<string, FlowOverlay>();
  if (!milestone) return { model, overlays };
  const drawn = new Map(model.tasks.map((t) => [t.id, t]));
  const members = new Set(
    tasks
      .filter((t) => t.milestone_id === milestone.id)
      .map((t) => at(t.id))
      .filter((id) => drawn.has(id)),
  );
  const last = [...members].filter(
    (id) => !model.edges.some((e) => e.from === id && e.to !== id && members.has(e.to)),
  );
  if (!last.length) return { model, overlays };
  const id = `milestone:${milestone.id}`;
  overlays.set(id, { kind: 'milestone', milestone });
  const merged = (from: Task) => (from.state ? from.state === 'merged' : from.status === 'done');
  return {
    model: {
      ...model,
      tasks: [...model.tasks, placeholder(id, drawn.get(last[0]!)!)],
      edges: [
        ...model.edges,
        ...last.map((from) => ({
          from,
          to: id,
          state: merged(drawn.get(from)!) ? ('met' as const) : ('pending' as const),
        })),
      ],
    },
    overlays,
  };
}

export type MilestoneFlowNode = Node<
  {
    milestone: BoardMilestone;
    now: number;
    /** The milestone's task to start next; null when none is ready. */
    next: Task | null;
    /** Starts `next`; resolves to why it did not start, or null. Absent on a read-only chart. */
    onStart?: () => Promise<string | null>;
  },
  'milestone'
>;

/** Progress, days left and acceptance of the current milestone, and the task to start next. */
export function MilestoneNode({ data }: NodeProps<MilestoneFlowNode>) {
  const { milestone, now, next, onStart } = data;
  const [refused, setRefused] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const { done, total } = milestoneCounts(milestone);
  const percent = total ? Math.round((done / total) * 100) : 0;
  const accepted = milestone.criteria.filter((c) => c.accepted).length;
  const start = async () => {
    setStarting(true);
    setRefused(await onStart!());
    setStarting(false);
  };
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="bd-nd bd-ms">
        <div className="bd-nrow bd-nh">
          <Flag className="bd-ms-ic" aria-hidden="true" />
          <Clip className="bd-nt" text={milestone.title} />
          {milestone.verification && (
            <VerifyBadge verification={milestone.verification} now={now} glyphOnly />
          )}
        </div>
        <div className="bd-ms-p">
          <svg
            className="bd-ms-ring"
            width="32"
            height="32"
            viewBox="0 0 32 32"
            role="img"
            aria-label={t(
              { id: 'board.flow.milestone.done', defaultMessage: '{done} of {total} tasks done' },
              { done, total },
            )}
          >
            <circle cx="16" cy="16" r="13" pathLength={100} />
            <circle
              cx="16"
              cy="16"
              r="13"
              pathLength={100}
              strokeDasharray={`${percent} 100`}
              transform="rotate(-90 16 16)"
            />
          </svg>
          <span className="bd-ms-v">
            <span className="bd-ms-n">
              {done} / {total}
            </span>
            {milestone.due_on !== undefined && (
              <span className="bd-na">{dueText(daysLeft(milestone.due_on, now))}</span>
            )}
          </span>
        </div>
        {milestone.criteria.length > 0 && (
          <div className="bd-nrow bd-ms-acc">
            <span
              className="bd-nacc"
              role="img"
              aria-label={t(
                {
                  id: 'board.flow.milestone.criteriaLabel',
                  defaultMessage: 'Acceptance criteria: {accepted} of {count} met',
                },
                { accepted, count: milestone.criteria.length },
              )}
            >
              {milestone.criteria.map((c, i) => (
                <i key={i} data-state={c.accepted ? 'passed' : undefined} />
              ))}
            </span>
            <span aria-hidden="true">
              {t(
                {
                  id: 'board.flow.milestone.criteria',
                  defaultMessage: 'Acceptance {accepted} / {count}',
                },
                { accepted, count: milestone.criteria.length },
              )}
            </span>
          </div>
        )}
        {next && (
          <div className="bd-nrow bd-ms-next">
            <span className="bd-ms-k">
              {t({ id: 'board.flow.milestone.next', defaultMessage: 'Next' })}
            </span>
            <span className="bd-na" title={next.title}>
              {next.title}
            </span>
            {onStart && next.dispatch_wait !== 'plan_approval' && (
              <button
                type="button"
                className="btn sm nodrag nopan"
                disabled={starting}
                aria-label={t(
                  { id: 'board.flow.milestone.startLabel', defaultMessage: 'Start {task}' },
                  { task: next.title },
                )}
                onClick={() => void start()}
              >
                {t({ id: 'board.flow.milestone.start', defaultMessage: 'Start' })}
              </button>
            )}
          </div>
        )}
        {refused && (
          <p className="bd-ms-err" role="alert">
            {refused}
          </p>
        )}
      </div>
    </>
  );
}
