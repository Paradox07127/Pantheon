import type { ComponentType, ReactNode } from 'react';
import {
  Bug,
  CircleDashed,
  File,
  Hourglass,
  Lock,
  Repeat,
  RotateCcw,
  Search,
  Settings2,
  Undo2,
  Zap,
  type LucideProps,
} from 'lucide-react';
import type {
  BoardModel,
  BoardSegment,
  BoardTaskState,
  BoardTaskStatus,
  RuntimeModel,
} from '@pantheon/protocol';
import { ModelMark, RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { StateGlyph } from '../../components/SessionStateIcon';
import { toast } from '../../components/Toast';
import { Tip } from '../../components/Tip';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { modelLabel } from '../sessions/thread-model';
import type { TaskBadge } from './activity';
import './status.css';

export const STATUS: Record<BoardTaskStatus, { label: string }> = {
  running: {
    get label() {
      return t({ id: 'board.task.status.running', defaultMessage: 'In progress' });
    },
  },
  waiting: {
    get label() {
      return t({ id: 'board.task.status.waiting', defaultMessage: 'Waiting' });
    },
  },
  idle: {
    get label() {
      return t({ id: 'board.task.status.idle', defaultMessage: 'Idle' });
    },
  },
  ready: {
    get label() {
      return t({ id: 'board.task.status.ready', defaultMessage: 'Ready to merge' });
    },
  },
  done: {
    get label() {
      return t({ id: 'board.task.status.done', defaultMessage: 'Done' });
    },
  },
  failed: {
    get label() {
      return t({ id: 'board.task.status.failed', defaultMessage: 'Failed' });
    },
  },
  todo: {
    get label() {
      return t({ id: 'board.task.status.todo', defaultMessage: 'Not started' });
    },
  },
  discarded: {
    get label() {
      return t({ id: 'board.task.status.discarded', defaultMessage: 'Discarded' });
    },
  },
};

export const STATE: Record<BoardTaskState, { label: string }> = {
  todo: {
    get label() {
      return t({ id: 'board.task.state.todo', defaultMessage: 'To do' });
    },
  },
  waiting_upstream: {
    get label() {
      return t({
        id: 'board.task.state.waitingUpstream',
        defaultMessage: 'Waiting on dependencies',
      });
    },
  },
  claimed: {
    get label() {
      return t({ id: 'board.task.state.claimed', defaultMessage: 'Claimed' });
    },
  },
  running: {
    get label() {
      return t({ id: 'board.task.state.running', defaultMessage: 'Running' });
    },
  },
  waiting_approval: {
    get label() {
      return t({ id: 'board.task.state.waitingApproval', defaultMessage: 'Awaiting approval' });
    },
  },
  blocked: {
    get label() {
      return t({ id: 'board.task.state.blocked', defaultMessage: 'Blocked' });
    },
  },
  needs_attention: {
    get label() {
      return t({ id: 'board.task.state.needsAttention', defaultMessage: 'Needs attention' });
    },
  },
  gating: {
    get label() {
      return t({ id: 'board.task.state.gating', defaultMessage: 'Running checks' });
    },
  },
  awaiting_acceptance: {
    get label() {
      return t({
        id: 'board.task.state.awaitingAcceptance',
        defaultMessage: 'Awaiting acceptance',
      });
    },
  },
  awaiting_merge: {
    get label() {
      return t({ id: 'board.task.state.awaitingMerge', defaultMessage: 'Awaiting merge' });
    },
  },
  merged: {
    get label() {
      return t({ id: 'board.task.state.merged', defaultMessage: 'Merged' });
    },
  },
  failed: {
    get label() {
      return t({ id: 'board.task.state.failed', defaultMessage: 'Failed' });
    },
  },
};

export { runtimeName };

export type TaskType = NonNullable<BoardModel['tasks'][number]['task_type']>;

/** Each task type's name and icon, in the order the type picker lists them. */
export const TASK_TYPE: Record<TaskType, { label: string; icon: ComponentType<LucideProps> }> = {
  feature: {
    get label() {
      return t({ id: 'board.task.type.feature', defaultMessage: 'Feature' });
    },
    icon: Zap,
  },
  fix: {
    get label() {
      return t({ id: 'board.task.type.fix', defaultMessage: 'Fix' });
    },
    icon: Bug,
  },
  research: {
    get label() {
      return t({ id: 'board.task.type.research', defaultMessage: 'Research' });
    },
    icon: Search,
  },
  infra: {
    get label() {
      return t({ id: 'board.task.type.infra', defaultMessage: 'Infrastructure' });
    },
    icon: Settings2,
  },
  docs: {
    get label() {
      return t({ id: 'board.task.type.docs', defaultMessage: 'Docs' });
    },
    icon: File,
  },
};

/** Runtime, model and status of one segment, for its hover text. */
export const segmentText = (segment: BoardSegment): string =>
  t(
    { id: 'board.task.segment.summary', defaultMessage: '{runtime}, {model}, {status}' },
    {
      runtime: runtimeName(segment.runtime),
      model:
        segment.model ??
        t({ id: 'board.task.segment.unknownModel', defaultMessage: 'Unknown model' }),
      status: STATUS[segment.status].label,
    },
  );

/**
 * Each status's colour token: its icon and every bar, dot or node that stands for a task in that
 * status draw in it.
 */
export const TASK_STATUS_TONE: Record<BoardTaskStatus, string> = {
  running: '--run',
  waiting: '--wait',
  idle: '--idle',
  ready: '--ready',
  done: '--ok',
  failed: '--bad',
  todo: '--e-pend',
  discarded: '--mu',
};

/**
 * Each plan task state's colour token: its icon, the iteration and history bars and the flow node
 * draw in it. Gating is the colour of a session's running gates, blocked the colour of failed.
 */
export const TASK_STATE_TONE: Record<BoardTaskState, string> = {
  todo: '--e-pend',
  waiting_upstream: '--idle',
  claimed: '--run',
  running: '--run',
  waiting_approval: '--wait',
  blocked: '--bad',
  needs_attention: '--idle',
  gating: '--run',
  awaiting_acceptance: '--wait',
  awaiting_merge: '--ready',
  merged: '--ok',
  failed: '--bad',
};

// Drawn in currentColor on the 12 grid.
const blockedOctagon = (
  <>
    <path d="M4 1h4l3 3v4l-3 3H4L1 8V4z" fill="currentColor" />
    <path d="M6 3.6v2.8" style={{ stroke: 'var(--sf)' }} strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="6" cy="8.3" r=".8" style={{ fill: 'var(--sf)' }} />
  </>
);

function IconShape({
  status,
  tone = TASK_STATUS_TONE[status],
}: {
  status: BoardTaskStatus;
  tone?: string;
}) {
  const color = `var(${tone})`;
  switch (status) {
    case 'waiting':
      return <circle cx="6" cy="6" r="4" style={{ fill: color }} />;
    case 'idle':
      return (
        <circle cx="6" cy="6" r="3.6" fill="none" style={{ stroke: color }} strokeWidth="1.5" />
      );
    case 'ready':
      return (
        <path
          d="M6 1.3 10.7 6 6 10.7 1.3 6Z"
          fill="none"
          style={{ stroke: color }}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      );
    case 'todo':
      return (
        <circle cx="6" cy="6" r="3.6" fill="none" style={{ stroke: color }} strokeWidth="1.5" />
      );
    case 'discarded':
      return (
        <>
          <circle cx="6" cy="6" r="4" fill="none" style={{ stroke: color }} strokeWidth="1.3" />
          <path d="M3.3 8.7 8.7 3.3" style={{ stroke: color }} strokeWidth="1.3" />
        </>
      );
  }
}

// Statuses and states that mean what a session state means take its glyph, on the 14 grid.
const STATUS_GLYPH: Partial<Record<BoardTaskStatus, ReactNode>> = {
  running: <StateGlyph name="running" tone={TASK_STATUS_TONE.running} />,
  done: <StateGlyph name="done" tone={TASK_STATUS_TONE.done} />,
  failed: <StateGlyph name="failed" tone={TASK_STATUS_TONE.failed} />,
};

/** The status's 12px icon; always shown next to its label. */
export function StatusIcon({ status }: { status: BoardTaskStatus }) {
  const glyph = STATUS_GLYPH[status];
  return (
    <svg className="bd-sti" viewBox={glyph ? '0 0 14 14' : '0 0 12 12'} aria-hidden="true">
      {glyph ?? <IconShape status={status} />}
    </svg>
  );
}

/** Status-coloured icon with a neutral label. */
export function StatusBadge({ status }: { status: BoardTaskStatus }) {
  return (
    <span className="bd-stc">
      <StatusIcon status={status} />
      <span className="bd-stw">{STATUS[status].label}</span>
    </span>
  );
}

function StateShape({ state }: { state: BoardTaskState }) {
  const tone = TASK_STATE_TONE[state];
  const color = `var(${tone})`;
  switch (state) {
    case 'todo':
      return <IconShape status={state} tone={tone} />;
    case 'waiting_upstream':
      return (
        <circle
          cx="6"
          cy="6"
          r="4"
          fill="none"
          style={{ stroke: color }}
          strokeWidth="1.5"
          strokeDasharray="2.1 1.6"
        />
      );
    case 'claimed':
      return (
        <>
          <circle cx="6" cy="6" r="4" fill="none" style={{ stroke: color }} strokeWidth="1.5" />
          <circle cx="6" cy="6" r="1.6" style={{ fill: color }} />
        </>
      );
    case 'blocked':
      return <g style={{ color }}>{blockedOctagon}</g>;
    case 'awaiting_acceptance':
      return (
        <path
          d="M2.8 10.9V1.5M2.8 1.9h6.4L7.9 4.3l1.3 2.4H2.8"
          fill="none"
          style={{ stroke: color }}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'awaiting_merge':
      return <IconShape status="ready" tone={tone} />;
    case 'needs_attention':
      return <IconShape status="idle" tone={tone} />;
  }
}

/** A running gate: the session gate mark's shield and arc, in the gating state's colour. */
function GatingGlyph() {
  return (
    <svg
      className="si"
      data-shape="shield-arc"
      style={{ color: `var(${TASK_STATE_TONE.gating})` }}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 1.5 12 3.5V7c0 3-2.2 4.8-5 5.75C4.2 11.8 2 10 2 7V3.5Z" />
      <circle className="si-spin" cx="7" cy="6.75" r="2" pathLength={4} strokeDasharray="3 1" />
    </svg>
  );
}

const STATE_GLYPH: Partial<Record<BoardTaskState, ReactNode>> = {
  running: <StateGlyph name="running" tone={TASK_STATE_TONE.running} />,
  waiting_approval: <StateGlyph name="approval" tone={TASK_STATE_TONE.waiting_approval} />,
  gating: <GatingGlyph />,
  merged: <StateGlyph name="merged" tone={TASK_STATE_TONE.merged} />,
  failed: <StateGlyph name="failed" tone={TASK_STATE_TONE.failed} />,
};

/** The plan task state's 12px icon; always shown next to its label. */
export function StateIcon({ state }: { state: BoardTaskState }) {
  const glyph = STATE_GLYPH[state];
  return (
    <svg
      className="bd-sti"
      viewBox={glyph ? '0 0 14 14' : '0 0 12 12'}
      aria-hidden="true"
      data-state={state}
    >
      {glyph ?? <StateShape state={state} />}
    </svg>
  );
}

/** The plan task's state name; a session row without a state goes by its status. */
export const taskStateLabel = (task: Pick<BoardModel['tasks'][number], 'state' | 'status'>) =>
  task.state ? STATE[task.state].label : STATUS[task.status].label;

/** The task state's icon; a session row without a state shows its status. */
export function TaskStateIcon({ task }: { task: BoardModel['tasks'][number] }) {
  return task.state ? <StateIcon state={task.state} /> : <StatusIcon status={task.status} />;
}

/** The task state's icon and name; a session row without a state shows its status. */
export function TaskStateBadge({ task }: { task: BoardModel['tasks'][number] }) {
  if (!task.state) return <StatusBadge status={task.status} />;
  return (
    <span className="bd-stc">
      <StateIcon state={task.state} />
      <span className="bd-stw">{STATE[task.state].label}</span>
    </span>
  );
}

/** A model id by its name in the runtime's list; an id the list does not hold stays as it is. */
export function modelName(models: readonly RuntimeModel[], id: string): string {
  const entry =
    models.find((m) => m.id === id) ?? models.find((m) => m.id !== 'default' && m.resolved === id);
  return entry ? modelLabel(entry) : id;
}

/** The runtime glyph and model of the task's claim, else of its plan routing; nothing without either. */
export function TaskRoute({
  task,
  className,
  models = [],
}: {
  task: BoardModel['tasks'][number];
  className: string;
  /** The route runtime's models, which name the model. */
  models?: readonly RuntimeModel[];
}) {
  const route = task.claim ?? task.planned;
  if (!route?.runtime && !route?.model) return null;
  return (
    <span className={className}>
      {route.runtime && <RuntimeGlyph runtime={route.runtime} size={14} />}
      <ModelMark model={route.model} beside={route.runtime} size={14} />
      {route.model ? (
        <span className="bd-rtm">{modelName(models, route.model)}</span>
      ) : (
        <span className="bd-rtn">{runtimeName(route.runtime ?? null)}</span>
      )}
    </span>
  );
}

/** The octagon marking a blocked task. */
export function BlockedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" aria-hidden="true">
      {blockedOctagon}
    </svg>
  );
}

const BADGE_ICON: Record<
  Exclude<TaskBadge['kind'], 'blocked' | 'waiting'>,
  ComponentType<LucideProps>
> = {
  upstream: CircleDashed,
  stalled: Hourglass,
  looping: Repeat,
  attempt: RotateCcw,
  handed_back: Undo2,
};

function BadgeIcon({ badge }: { badge: TaskBadge }) {
  if (badge.kind === 'blocked') return <BlockedIcon />;
  if (badge.kind === 'waiting')
    return <StateGlyph name={badge.waits === 'approval' ? 'approval' : 'question'} />;
  const Icon = BADGE_ICON[badge.kind];
  return <Icon aria-hidden="true" />;
}

/** Marks a task whose order relative to the other locked tasks the user locked. */
export function OrderLockedMark() {
  return (
    <span
      className="bd-bdg"
      data-kind="locked"
      role="img"
      aria-label={t({ id: 'board.task.orderLocked', defaultMessage: 'Order locked' })}
    >
      <Lock aria-hidden="true" />
    </span>
  );
}

/** The task's pull request by number, opened in the browser rather than in the row it sits in. */
export function PullLink({ pr }: { pr: { number: number; url: string } }) {
  return (
    <a
      className="bd-pr"
      href={pr.url}
      aria-label={t(
        { id: 'board.task.pullRequest', defaultMessage: 'Pull request #{number}' },
        { number: pr.number },
      )}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void window.pantheon?.openLink(pr.url).then((result) => {
          if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
        });
      }}
    >
      {`#${pr.number}`}
    </a>
  );
}

/** A task's badges, each an icon with its count; the label is its hover text. */
export function TaskBadges({ badges }: { badges: TaskBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="bd-bdgs">
      {badges.map((badge) => (
        <Tip key={badge.kind} content={badge.label}>
          <span className="bd-bdg" data-kind={badge.kind} role="img" aria-label={badge.label}>
            <BadgeIcon badge={badge} />
            {badge.count != null && <span className="bd-bdg-n">{badge.count}</span>}
          </span>
        </Tip>
      ))}
    </span>
  );
}
