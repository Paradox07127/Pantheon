import type { ComponentType, CSSProperties } from 'react';
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react';
import {
  Bot,
  Check,
  CircleDashed,
  CirclePlay,
  CornerDownRight,
  Eye,
  FileText,
  PanelsTopLeft,
  Pencil,
  Repeat,
  RotateCcw,
  Server,
  Split,
  TriangleAlert,
  Wrench,
  X,
  type LucideProps,
  Columns3,
} from 'lucide-react';
import type { FlowPath, TaskKind } from '@pantheon/domain';
import type { BoardModel } from '@pantheon/protocol';
import { DiffCounts } from '../../components/DiffCounts';
import { ModelMark, RuntimeGlyph } from '../../components/RuntimeGlyph';
import { Tip } from '../../components/Tip';
import { useRuntimeStatus } from '../../data/runtime-status';
import { DOMAIN_LABEL, PATH_LABEL } from '../../data/workflow-policy';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import {
  PHASE,
  displayStatus,
  nodeReason,
  phaseText,
  quotaLine,
  repeatsState,
  taskBadges,
  type NodeReason,
} from './activity';
import { COMPACT_ZOOM, DOT_ZOOM } from './flow-layout';
import { NodeActions, type NodeActionContext } from './NodeActions';
import { durationText } from './panels-model';
import {
  STATUS,
  StateIcon,
  StatusIcon,
  TASK_STATE_TONE,
  TASK_STATUS_TONE,
  TASK_TYPE,
  TaskBadges,
  runtimeName,
  taskStateLabel,
} from './status';
import { BudgetShare, RungLabel } from './TaskRecovery';
import './node.css';

type Task = BoardModel['tasks'][number];
export type TaskNode = Node<
  {
    task: Task;
    selected: boolean;
    now: number;
    critical: boolean;
    ready: boolean;
    line: string | null;
    /** Its handles start and take new dependencies. */
    editable?: boolean;
    /**
     * The card's height in flow px. Zoomed out, the node keeps it, so the layout that follows the
     * measured heights does not move when a card turns into a pill.
     */
    tall?: number;
    /** What the node's buttons act with; a node without it has none. */
    actions?: NodeActionContext;
    /** What the unsent draft changes: the acceptance count by this much, the upstream tasks. */
    drafted?: { acceptance?: number; upstream?: true };
  },
  'task'
>;

/** How a node looks: one colour per status, a dashed border while queued. */
export type NodeLook =
  'queue' | 'run' | 'approval' | 'answer' | 'review' | 'failed' | 'stuck' | 'done';

export function nodeLook(task: Task): NodeLook {
  const phase = task.activity?.phase;
  if (phase === 'waiting_approval' || task.state === 'waiting_approval') return 'approval';
  if (phase === 'waiting_input' || task.dispatch_wait === 'answer') return 'answer';
  switch (task.state) {
    case 'merged':
      return 'done';
    case 'failed':
      return 'failed';
    case 'blocked':
    case 'needs_attention':
      return 'stuck';
    case 'awaiting_acceptance':
    case 'awaiting_merge':
      return 'review';
    case 'claimed':
    case 'running':
    case 'gating':
      return 'run';
    case 'todo':
    case 'waiting_upstream':
      return task.checks === 'running' ? 'run' : 'queue';
  }
  switch (displayStatus(task)) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'ready':
      return 'review';
    case 'running':
      return 'run';
    case 'waiting':
      return 'approval';
    case 'idle':
    case 'discarded':
      return 'stuck';
    case 'todo':
      return task.checks === 'running' ? 'run' : 'queue';
  }
}

/**
 * The node's colour, from the table its state icon reads; a task waiting on the user or on its
 * checks takes that colour.
 */
function nodeTone(task: Task, look: NodeLook): string {
  if (look === 'approval' || look === 'answer') return TASK_STATE_TONE.waiting_approval;
  if (look === 'run' && task.checks === 'running') return TASK_STATE_TONE.gating;
  return task.state ? TASK_STATE_TONE[task.state] : TASK_STATUS_TONE[displayStatus(task)];
}

const STAGES = ['plan', 'build', 'gate', 'review', 'merge'] as const;
type Stage = (typeof STAGES)[number];
const STAGE_NAME: Record<Stage, () => string> = {
  plan: () => t({ id: 'board.plan.flow.stage.plan', defaultMessage: 'Plan' }),
  build: () => t({ id: 'board.plan.flow.stage.build', defaultMessage: 'Build' }),
  gate: () => t({ id: 'board.plan.flow.stage.gate', defaultMessage: 'Checks' }),
  review: () => t({ id: 'board.plan.flow.stage.review', defaultMessage: 'Review' }),
  merge: () => t({ id: 'board.plan.flow.stage.merge', defaultMessage: 'Merge' }),
};

/** The plan stage the task's state stands in; null when the state does not say which. */
function stageOf(task: Task): { at: number; done: boolean } | null {
  switch (task.state) {
    case 'todo':
    case 'waiting_upstream':
      return { at: 0, done: false };
    case 'claimed':
    case 'running':
    case 'waiting_approval':
    case 'blocked':
    case 'needs_attention':
      return { at: 1, done: false };
    case 'gating':
      return { at: 2, done: false };
    case 'awaiting_acceptance':
      return { at: 3, done: false };
    case 'awaiting_merge':
      return { at: 4, done: false };
    case 'merged':
      return { at: 4, done: true };
    case 'failed':
      return task.checks === 'fail' ? { at: 2, done: false } : null;
    default:
      return null;
  }
}

const KIND_ICON: Record<TaskKind['domain'], ComponentType<LucideProps>> = {
  review: Eye,
  'frontend-ui': PanelsTopLeft,
  'script-infra': Wrench,
  'backend-logic': Server,
  'docs-chore': FileText,
};

// The default direct path goes unmarked.
const PATH_ICON: Record<Exclude<FlowPath, 'direct'>, ComponentType<LucideProps>> = {
  dispatch: Split,
  parallel: Columns3,
  review_loop: Repeat,
};

function StageBar({ task }: { task: Task }) {
  const stage = stageOf(task);
  if (!stage) return null;
  const name = STAGE_NAME[STAGES[stage.at]!]();
  return (
    <div className="bd-nrow">
      <span
        className="bd-nstg"
        role="img"
        aria-label={t(
          {
            id: 'board.plan.flow.stage.label',
            defaultMessage: 'Stage: {stage}, step {step} of {count}',
          },
          { stage: name, step: stage.at + 1, count: STAGES.length },
        )}
      >
        {STAGES.map((s, i) => (
          <i
            key={s}
            data-at={i < stage.at || stage.done ? 'done' : i === stage.at ? 'now' : undefined}
          />
        ))}
      </span>
      <span className="bd-nstn">{name}</span>
    </div>
  );
}

const CHECKS_LABEL: Record<Exclude<Task['checks'], 'none'>, () => string> = {
  pass: () => t({ id: 'board.plan.flow.checks.pass', defaultMessage: 'Checks passed' }),
  fail: () => t({ id: 'board.plan.flow.checks.fail', defaultMessage: 'Checks failed' }),
  running: () => t({ id: 'board.plan.flow.checks.running', defaultMessage: 'Checks running' }),
};

/** The share of the context window used; warns past 80%. */
export function ContextRing({ context }: { context: NonNullable<Task['context']> }) {
  const percent = Math.min(100, Math.round((context.used_tokens / context.window_tokens) * 100));
  return (
    <svg
      className="bd-nctx"
      data-high={percent > 80 || undefined}
      width="16"
      height="16"
      viewBox="0 0 32 32"
      role="img"
      aria-label={t(
        { id: 'board.plan.flow.context', defaultMessage: 'Context {percent}% used' },
        { percent },
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
  );
}

function AcceptanceChecks({ checks }: { checks: NonNullable<Task['acceptance_checks']> }) {
  const shown = checks.length > 8 ? checks.slice(0, 7) : checks;
  return (
    <span
      className="bd-nacc"
      role="img"
      aria-label={t(
        {
          id: 'board.plan.flow.acceptance',
          defaultMessage: 'Acceptance checks: {passed} of {count} met',
        },
        { passed: checks.filter((c) => c.state === 'passed').length, count: checks.length },
      )}
    >
      {shown.map((check, i) => (
        <i key={i} data-state={check.state} />
      ))}
      {shown.length < checks.length && `+${checks.length - shown.length}`}
    </span>
  );
}

function Amounts({ task, line }: { task: Task; line: string | null }) {
  const checks = task.checks === 'none' ? null : task.checks;
  const steps = task.gate_steps?.length ? task.gate_steps : null;
  const passed = steps?.filter((s) => s.state === 'passed').length ?? 0;
  // The merged task's line already names its commit and diff.
  const diff =
    (task.additions !== null || task.deletions !== null) && !(task.state === 'merged' && line);
  const subagents = task.subagents ? task.subagents : null;
  const successors = task.successors ? task.successors : null;
  const acceptance = task.acceptance_checks?.length ? task.acceptance_checks : null;
  if (!checks && !steps && !diff && !subagents && !successors && !acceptance) return null;
  return (
    <div className="bd-nrow bd-nq">
      {steps ? (
        <>
          <span
            className="bd-ngate"
            role="img"
            aria-label={t(
              {
                id: 'board.plan.flow.gateSteps',
                defaultMessage: 'Checks: {passed} of {count} steps passed',
              },
              { passed, count: steps.length },
            )}
          >
            {steps.map((step, i) => (
              <i key={i} data-state={step.state} />
            ))}
          </span>
          <span className="bd-ngn">
            {passed}/{steps.length}
          </span>
        </>
      ) : (
        checks && (
          <span
            className="bd-ngate"
            data-checks={checks}
            role="img"
            aria-label={CHECKS_LABEL[checks]()}
          >
            <i />
          </span>
        )
      )}
      {diff && (
        <span className="bd-ndiff">
          <DiffCounts additions={task.additions} deletions={task.deletions} />
        </span>
      )}
      {subagents && (
        <span
          className="bd-nagents"
          role="img"
          aria-label={t(
            {
              id: 'board.plan.flow.subagents',
              defaultMessage: '{count, plural, one {# subagent} other {# subagents}}',
            },
            { count: subagents },
          )}
        >
          <Bot aria-hidden="true" />
          <span>{subagents}</span>
        </span>
      )}
      {successors && (
        <span
          className="bd-nsucc"
          role="img"
          aria-label={t(
            {
              id: 'board.plan.flow.successors',
              defaultMessage: '{count, plural, one {# follow-up task} other {# follow-up tasks}}',
            },
            { count: successors },
          )}
        >
          <CornerDownRight aria-hidden="true" />
          <span>{successors}</span>
        </span>
      )}
      {acceptance && (
        <span className="bd-nend">
          <AcceptanceChecks checks={acceptance} />
        </span>
      )}
    </div>
  );
}

const VERDICT: Record<
  NonNullable<Task['external_review']>['verdict'],
  { Icon: ComponentType<LucideProps>; label: () => string }
> = {
  pending: {
    Icon: CircleDashed,
    label: () => t({ id: 'board.plan.flow.review.pending', defaultMessage: 'Review not decided' }),
  },
  passed: {
    Icon: Check,
    label: () => t({ id: 'board.plan.flow.review.passed', defaultMessage: 'Review passed' }),
  },
  failed: {
    Icon: X,
    label: () => t({ id: 'board.plan.flow.review.failed', defaultMessage: 'Review failed' }),
  },
};

function ExternalReview({
  review,
  now,
}: {
  review: NonNullable<Task['external_review']>;
  now: number;
}) {
  const { Icon, label } = VERDICT[review.verdict];
  // A newer round keeps the end time of the round before it until it ends.
  const running = review.verdict === 'pending';
  return (
    <div className="bd-nrow bd-nrv">
      <span className="bd-nvd" data-verdict={review.verdict} role="img" aria-label={label()}>
        <Icon aria-hidden="true" />
      </span>
      {review.findings ? (
        <>
          <span>
            {t(
              {
                id: 'board.plan.flow.review.blocking',
                defaultMessage: 'External review {count} blocking',
              },
              { count: review.findings.blocking },
            )}
          </span>
          <span>
            {t(
              { id: 'board.plan.flow.review.other', defaultMessage: '{count} minor' },
              { count: review.findings.other },
            )}
          </span>
        </>
      ) : (
        <span>
          {t(
            {
              id: 'board.plan.flow.review.rounds',
              defaultMessage:
                '{rounds, plural, one {External review, # round} other {External review, # rounds}}',
            },
            { rounds: review.rounds },
          )}
        </span>
      )}
      {review.started_at !== undefined && (running || review.ended_at !== undefined) && (
        <span className="bd-ntm">
          {running
            ? t(
                { id: 'board.plan.flow.review.elapsed', defaultMessage: '{duration} so far' },
                { duration: durationText(now - review.started_at) },
              )
            : durationText(review.ended_at! - review.started_at)}
        </span>
      )}
    </div>
  );
}

/** The runtime glyph, and the model's maker when it differs, of the claim, else of the plan routing. */
function Route({ task }: { task: Task }) {
  const route = task.claim ?? task.planned;
  if (!route?.runtime && !route?.model) return null;
  return (
    <span
      className="bd-nrt"
      role="img"
      aria-label={listText(runtimeName(route.runtime ?? null), route.model)}
    >
      {route.runtime && <RuntimeGlyph runtime={route.runtime} size={16} />}
      <ModelMark model={route.model} beside={route.runtime} size={16} />
    </span>
  );
}

/** The flow path the task takes in effect. */
function PathMark({ path }: { path: Exclude<FlowPath, 'direct'> }) {
  const Icon = PATH_ICON[path];
  return (
    <span className="bd-npath" role="img" aria-label={PATH_LABEL[path]}>
      <Icon aria-hidden="true" />
    </span>
  );
}

/** One status glyph per part of a parallel task, in plan order; a part not dispatched is not started. */
function Parts({ parts }: { parts: NonNullable<Task['parallel']> }) {
  return (
    <div className="bd-nrow bd-nparts">
      {parts.map((part, i) => {
        const status = part.status ?? 'todo';
        return (
          <span
            key={i}
            role="img"
            data-status={status}
            aria-label={t(
              { id: 'board.plan.flow.part', defaultMessage: '{title}, {status}' },
              { title: part.title, status: STATUS[status].label },
            )}
          >
            <StatusIcon status={status} />
          </span>
        );
      })}
    </div>
  );
}

const REASON_ICON: Partial<Record<NodeReason['kind'], ComponentType<LucideProps>>> = {
  retried: RotateCcw,
  unattended: TriangleAlert,
  basis: Check,
};

/** The fifth layer: the question waiting, else the one fact to look at. */
function Reason({ reason }: { reason: NodeReason }) {
  if (reason.kind === 'question') return <p className="bd-nwhy bd-nask">{reason.text}</p>;
  const Icon = REASON_ICON[reason.kind]!;
  return (
    <div className="bd-nrow bd-nwhy">
      <Icon aria-hidden="true" />
      <span className="bd-na">{reason.text}</span>
    </div>
  );
}

/** A runtime quota wait by when the quota comes back, else by its line. */
function QuotaLine({ task, now, line }: { task: Task; now: number; line: string }) {
  const read = useRuntimeStatus().read;
  return quotaLine(task, read.state === 'ready' ? read.statuses : [], now) ?? line;
}

/** A plan task by its state; a session row without one by its status. */
export function TaskCard({ data }: NodeProps<TaskNode>) {
  const {
    task,
    selected,
    now,
    critical,
    ready,
    line,
    editable = false,
    tall,
    actions,
    drafted,
  } = data;
  // Zoomed out, the node keeps its screen size by the inverse of the zoom.
  const zoom = useStore((s) => (s.transform[2] < COMPACT_ZOOM ? s.transform[2] : 1));
  const shown = displayStatus(task);
  const look = nodeLook(task);
  const tone = { '--nd-c': `var(${nodeTone(task, look)})` } as CSSProperties;
  const since = task.started_at ?? task.activity?.since ?? null;
  const type = task.task_type && TASK_TYPE[task.task_type];
  const kind = task.planned?.kind?.domain;
  const Kind = kind && KIND_ICON[kind];
  const context = task.context?.window_tokens ? task.context : null;
  const open = selected || look === 'approval' || look === 'answer';
  const reason = open ? nodeReason(task, look) : null;
  // The line then says only the phase; the fifth layer or the needs-you strip holds what waits.
  const said =
    reason?.kind === 'command'
      ? PHASE.waiting_approval
      : reason?.kind === 'question'
        ? PHASE.waiting_input
        : line;
  const connectable = {
    isConnectable: editable,
    isConnectableStart: editable,
    isConnectableEnd: editable,
  };
  const glyph = task.state ? <StateIcon state={task.state} /> : <StatusIcon status={shown} />;
  const badges = taskBadges(task);
  const blocked = badges.find((b) => b.kind === 'blocked' && repeatsState(b, task.state ?? shown));
  if (zoom < COMPACT_ZOOM)
    return (
      <>
        <Handle type="target" position={Position.Left} {...connectable} />
        <div className="bd-nmini" style={{ '--bd-z': zoom, height: tall } as CSSProperties}>
          {zoom < DOT_ZOOM ? (
            <svg
              className="bd-ndot"
              data-look={look}
              style={tone}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="5" />
            </svg>
          ) : (
            <span className="bd-npill" data-look={look} data-sel={selected || undefined}>
              {glyph}
              <span className="bd-nt">{task.title}</span>
            </span>
          )}
        </div>
        <Handle type="source" position={Position.Right} {...connectable} />
      </>
    );
  return (
    <>
      <Handle type="target" position={Position.Left} {...connectable} />
      <div
        className={selected ? 'bd-nd sel' : 'bd-nd'}
        style={tone}
        data-look={look}
        data-status={shown}
        data-state={task.state}
        data-health={task.activity?.health}
        data-critical={critical || undefined}
        data-ready={ready || undefined}
        data-open={open || undefined}
      >
        {ready && (
          <span
            className="bd-nd-go"
            role="img"
            aria-label={t({ id: 'board.plan.flow.ready', defaultMessage: 'Ready to start' })}
          >
            <CirclePlay aria-hidden="true" />
          </span>
        )}
        <div className="bd-nrow bd-nh">
          {blocked ? (
            <Tip content={blocked.label}>
              <span className="bd-nst" role="img" aria-label={blocked.label}>
                {glyph}
              </span>
            </Tip>
          ) : (
            glyph
          )}
          <span className="bd-nt">{task.title}</span>
          <TaskBadges badges={badges.filter((b) => !repeatsState(b, task.state ?? shown))} />
          {task.pending_edit && (
            <span className="bd-pchip" data-dot="wait">
              {t({ id: 'board.plan.flow.pendingEdit', defaultMessage: 'Awaiting lead' })}
            </span>
          )}
          {context && <ContextRing context={context} />}
          {type ? (
            <span className="bd-nkind" role="img" aria-label={type.label}>
              <type.icon aria-hidden="true" />
            </span>
          ) : (
            Kind && (
              <span className="bd-nkind" role="img" aria-label={DOMAIN_LABEL[kind]}>
                <Kind aria-hidden="true" />
              </span>
            )
          )}
        </div>
        <div className="bd-nrow bd-nw">
          <Route task={task} />
          {task.path && task.path !== 'direct' && <PathMark path={task.path} />}
          <span className="bd-na" title={said ?? undefined}>
            {said !== null && task.dispatch_wait === 'runtime_limited' ? (
              <QuotaLine task={task} now={now} line={said} />
            ) : (
              (said ?? (task.state ? taskStateLabel(task) : phaseText(task, now)))
            )}
          </span>
          {since !== null && (
            <span className="bd-ntm">{durationText((task.ended_at ?? now) - since)}</span>
          )}
        </div>
        {task.parallel && task.parallel.length > 0 && <Parts parts={task.parallel} />}
        <StageBar task={task} />
        <Amounts task={task} line={line} />
        {task.external_review && <ExternalReview review={task.external_review} now={now} />}
        {/* The needs-you strip shows the command waiting for approval. */}
        {reason && reason.kind !== 'command' && <Reason reason={reason} />}
        {(task.budget || task.rung) && (
          <div className="bd-nrec">
            {task.budget && <BudgetShare budget={task.budget} />}
            {task.rung && <RungLabel rung={task.rung} />}
          </div>
        )}
        {open && actions && <NodeActions task={task} look={look} context={actions} />}
        {drafted && (
          <div className="bd-ntags">
            {drafted.acceptance !== undefined && (
              <span className="bd-ntag">
                <Pencil aria-hidden="true" />
                {t(
                  { id: 'board.plan.flow.draftAcceptance', defaultMessage: 'Acceptance {delta}' },
                  {
                    delta:
                      drafted.acceptance > 0 ? `+${drafted.acceptance}` : `−${-drafted.acceptance}`,
                  },
                )}
              </span>
            )}
            {drafted.upstream && (
              <span className="bd-ntag">
                <Pencil aria-hidden="true" />
                {t({ id: 'board.plan.flow.draftUpstream', defaultMessage: 'Upstream changed' })}
              </span>
            )}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} {...connectable} />
    </>
  );
}
