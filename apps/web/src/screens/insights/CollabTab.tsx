import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { Check, Crown, Minus, Pause, Play, Plus, Workflow } from 'lucide-react';
import type { BoardModel, BoardTaskStatus, CommandType } from '@pantheon/protocol';
import { ModelMark, RuntimeGlyph } from '../../components/RuntimeGlyph';
import { stateGlyphTone } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import {
  isPolicy,
  PATH_LABEL,
  setPolicy,
  useWorkflowPolicy,
  type PolicyPatch,
  type WorkflowPolicy,
} from '../../data/workflow-policy';
import { useRuntimeModels } from '../../data/runtime-models';
import { useRuntimeStatus } from '../../data/runtime-status';
import { planTaskIds, useTaskTrace } from '../../data/task-trace';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { activityNote } from '../board/activity';
import { runBoardCommand } from '../board/BoardScreen';
import { Empty } from '../board/Charts';
import { leadState } from '../board/frame-model';
import { dayText } from '../../lib/time-text';
import { scrimFlag } from '../../lib/root-flag';
import { durationText, tellLead } from '../board/panels-model';
import { runtimeName, StateIcon, StatusIcon, taskStateLabel, TaskStateIcon } from '../board/status';
import { hasOpenSession } from '../board/TaskDrawer';
import { KINDS as TRACE_KINDS } from '../board/TaskTimeline';
import { useDialogContent } from '../board/TellLead';
import { openSettingsPage } from '../settings/settings-jump';
import { BarSlot } from './BarSlot';
import { pickInsightsSection } from './InsightsScreen';
import './collab.css';

type Task = BoardModel['tasks'][number];
type Claimed = Task & { claim: NonNullable<Task['claim']> };
type Today = NonNullable<NonNullable<BoardModel['leads']>[number]['messages_today']>[number];
type Line = NonNullable<Today['in_flight']>[number];

/** The protocol's highest per-runtime limit. */
const RUNTIME_LIMIT_MAX = 8;

/** The runtime_parallel record with one runtime's limit set, or taken out for no limit. */
export function withRuntimeLimit(
  record: Record<string, number> | undefined,
  runtime: string,
  limit: number | null,
): Record<string, number> {
  const rest = Object.fromEntries(Object.entries(record ?? {}).filter(([r]) => r !== runtime));
  return limit === null ? rest : { ...rest, [runtime]: limit };
}

/** A runtime's limit stepper from 1 to 8, and a button that lifts a set limit; stepping down from no limit gives 8. */
export function runtimeLimit({
  runtime,
  limit,
  disabled,
  onSet,
}: {
  runtime: string;
  limit: number | undefined;
  disabled: boolean;
  onSet: (limit: number | null) => void;
}): ReactNode {
  const name = runtimeName(runtime);
  const down = limit === undefined ? RUNTIME_LIMIT_MAX : limit - 1;
  const noLimit = t({ id: 'insights.collab.noLimit', defaultMessage: 'No limit' });
  return (
    <span className="clb-lim">
      <button
        type="button"
        className="ib"
        aria-label={t(
          { id: 'insights.collab.limitDown', defaultMessage: 'Decrease {runtime} concurrency' },
          { runtime: name },
        )}
        disabled={disabled || down < 1}
        onClick={() => onSet(down)}
      >
        <Minus aria-hidden="true" />
      </button>
      <output>{limit ?? noLimit}</output>
      <button
        type="button"
        className="ib"
        aria-label={t(
          { id: 'insights.collab.limitUp', defaultMessage: 'Increase {runtime} concurrency' },
          { runtime: name },
        )}
        disabled={disabled || limit === undefined || limit >= RUNTIME_LIMIT_MAX}
        onClick={() => limit !== undefined && onSet(limit + 1)}
      >
        <Plus aria-hidden="true" />
      </button>
      {limit !== undefined && (
        <button type="button" className="btn ghost" disabled={disabled} onClick={() => onSet(null)}>
          {noLimit}
        </button>
      )}
    </span>
  );
}

/** Node box and spacing of the relation graph, in px. */
const NODE_W = 184;
const NODE_H = 52;
const PITCH = 68;
const COL = NODE_W + 96;

const percentOf = (used: number, window: number) =>
  Math.min(100, Math.round((used / window) * 100));

const contextLabel = (percent: number) =>
  t({ id: 'insights.collab.context', defaultMessage: 'Context {percent}% used' }, { percent });

/** The share of a context window used as a 16px ring; warns past 80%. */
const ring = (percent: number) => (
  <svg
    className="clb-ring"
    data-high={percent > 80 || undefined}
    width="16"
    height="16"
    viewBox="0 0 32 32"
    role="img"
    aria-label={contextLabel(percent)}
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

const meter = (percent: number) => (
  <span
    className="clb-meter"
    data-high={percent > 80 || undefined}
    role="img"
    aria-label={contextLabel(percent)}
  >
    <i style={{ transform: `scaleX(${percent / 100})` }} />
  </span>
);

/** A curve from the right edge of one node to the left edge of another, by their vertical centres. */
const edge = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
};

/** A count on the middle of a line; its title says what it counts. */
const edgeCount = (x: number, y: number, count: number, title: string) => (
  <g transform={`translate(${x} ${y})`} role="img" aria-label={title}>
    <title>{title}</title>
    <rect
      x={-(6 + 3.5 * String(count).length)}
      y="-8"
      width={12 + 7 * String(count).length}
      height="16"
      rx="8"
    />
    <text y="4" textAnchor="middle">
      {count}
    </text>
  </g>
);

/** What today's count on each line counts. */
const LINE_COUNT: Record<
  Line,
  { of: (today: Today) => number | undefined; title: (count: number) => string }
> = {
  lead: {
    of: (today) => today.lead,
    title: (count) =>
      t(
        {
          id: 'insights.collab.leadMessagesToday',
          defaultMessage: '{count, plural, one {# message today} other {# messages today}}',
        },
        { count },
      ),
  },
  subagent: {
    of: (today) => today.subagents,
    title: (count) =>
      t(
        {
          id: 'insights.collab.subagentCallsToday',
          defaultMessage:
            '{count, plural, one {# sub-agent call today} other {# sub-agent calls today}}',
        },
        { count },
      ),
  },
  review: {
    of: (today) => today.reviews,
    title: (count) =>
      t(
        {
          id: 'insights.collab.reviewRoundsToday',
          defaultMessage:
            '{count, plural, one {# review round today} other {# review rounds today}}',
        },
        { count },
      ),
  },
  gate: {
    of: (today) => today.gates,
    title: (count) =>
      t(
        {
          id: 'insights.collab.gateRunsToday',
          defaultMessage: '{count, plural, one {# gate run today} other {# gate runs today}}',
        },
        { count },
      ),
  },
};

/** The name of a node's role, drawn at the end of its second line. */
const roleName = (role: 'lead' | 'task' | 'review' | 'check') =>
  ({
    lead: () => t({ id: 'insights.collab.roleLead', defaultMessage: 'Orchestration' }),
    task: () => t({ id: 'insights.collab.roleTask', defaultMessage: 'Implementation' }),
    review: () => t({ id: 'insights.collab.roleReview', defaultMessage: 'Review' }),
    check: () => t({ id: 'insights.collab.roleCheck', defaultMessage: 'Check' }),
  })[role]();

/** The sub-agents, the external review and the checks of a task, which the graph draws to its right. */
function checkNodes(
  task: Task,
  today: Today | undefined,
): {
  line: Exclude<Line, 'lead'>;
  label: string;
  /** Left out where the label already names the role. */
  role?: string;
  status: BoardTaskStatus;
  text?: string;
}[] {
  const found: ReturnType<typeof checkNodes> = [];
  const calls = today?.subagents;
  const calling = !!today?.in_flight?.includes('subagent');
  if ((calls ?? 0) > 0 || calling)
    found.push({
      line: 'subagent',
      label: t({ id: 'insights.collab.subagents', defaultMessage: 'Sub-agents' }),
      status: calling ? 'running' : 'done',
      text:
        calls === undefined
          ? undefined
          : t(
              {
                id: 'insights.collab.subagentCalls',
                defaultMessage: '{count, plural, one {# call today} other {# calls today}}',
              },
              { count: calls },
            ),
    });
  const review = task.external_review;
  if (review)
    found.push({
      line: 'review',
      label: t({ id: 'insights.collab.review', defaultMessage: 'External review' }),
      role: roleName('review'),
      status: (
        { pending: 'running', passed: 'done', failed: 'failed' } as const satisfies Record<
          typeof review.verdict,
          BoardTaskStatus
        >
      )[review.verdict],
      text: t(
        { id: 'insights.collab.reviewRound', defaultMessage: 'Round {round}' },
        { round: review.rounds },
      ),
    });
  const steps = task.gate_steps ?? [];
  if (steps.length) {
    const failed = steps.find((s) => s.state === 'failed');
    const at = steps.findIndex((s) => s.state === 'running');
    const passed = steps.filter((s) => s.state === 'passed').length;
    // The daemon keeps steps pending until the gate's result lands.
    const running = at >= 0 || !!today?.in_flight?.includes('gate') || task.checks === 'running';
    found.push({
      line: 'gate',
      label: t({ id: 'insights.collab.gate', defaultMessage: 'Checks' }),
      role: roleName('check'),
      status: failed
        ? 'failed'
        : running
          ? 'running'
          : steps.every((s) => s.state === 'passed' || s.state === 'skipped')
            ? 'done'
            : 'todo',
      text: failed
        ? failed.name
        : at >= 0
          ? t(
              { id: 'insights.collab.gateStep', defaultMessage: 'Step {step} of {count}' },
              { step: at + 1, count: steps.length },
            )
          : t(
              {
                id: 'insights.collab.gatePassed',
                defaultMessage: '{passed} of {count} steps passed',
              },
              { passed, count: steps.length },
            ),
    });
  }
  return found;
}

/** The colour a slot takes from the status of the session holding it, in the order the bar fills. */
const SLOT_TONES: Partial<Record<BoardTaskStatus, 'run' | 'wait' | 'bad'>> = {
  running: 'run',
  waiting: 'wait',
  failed: 'bad',
};
const SLOT_ORDER = ['run', 'wait', 'bad', undefined];

/** The longest of the waits that started at the given times; null without one. */
const longest = (since: number[], now: number) =>
  since.length
    ? t(
        { id: 'insights.collab.longest', defaultMessage: 'longest {duration}' },
        { duration: durationText(now - Math.min(...since)) },
      )
    : null;

export interface CollabControlsProps {
  /** The project whose workflow policy is read and paused; absent, nothing is drawn. */
  projectId?: string;
}

/**
 * The flow paths, which open the workflow tab; the concurrency, read only beside a link to the
 * workflow settings; and pausing dispatch.
 */
export function CollabControls({ projectId }: CollabControlsProps) {
  const read = useWorkflowPolicy(projectId ?? null);
  // The policy a command returned, shown until a read reaches its version.
  const [saved, setSaved] = useState<WorkflowPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sending = useRef(false);
  const policy =
    saved && (!read.read || read.read.policy_version < saved.policy_version) ? saved : read.read;
  const send = async (patch: PolicyPatch) => {
    if (!policy || read.stale || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const result = await setPolicy(policy, patch);
    sending.current = false;
    setBusy(false);
    if (!result.ok) {
      setFailure(result.error);
      return;
    }
    if (isPolicy(result.value)) setSaved(result.value);
    read.reload();
  };
  if (!projectId) return null;
  const paused = !!policy?.dispatch_paused;
  const concurrency = t({ id: 'insights.collab.concurrency', defaultMessage: 'Concurrency' });

  return (
    <div className="clb-top">
      {policy && (
        <button
          type="button"
          className="clb-path"
          onClick={() => pickInsightsSection(projectId, 'workflow')}
        >
          <Workflow className="ic-sm" aria-hidden="true" />
          {listText(
            ...new Set(
              [policy.path.t1, policy.path.t2, policy.path.t3].flatMap((p) =>
                p ? [PATH_LABEL[p]] : [],
              ),
            ),
          )}
        </button>
      )}
      {policy && (
        <span className="clb-par" role="group" aria-label={concurrency}>
          {concurrency}
          <output>{policy.max_parallel}</output>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => openSettingsPage(projectId, 'projects')}
          >
            {t({ id: 'insights.collab.editConcurrency', defaultMessage: 'Change in settings' })}
          </button>
        </span>
      )}
      <button
        type="button"
        className="btn"
        disabled={!policy || busy}
        onClick={() => void send({ dispatch_paused: !paused })}
      >
        {paused ? (
          <Play className="ic-sm" aria-hidden="true" />
        ) : (
          <Pause className="ic-sm" aria-hidden="true" />
        )}
        {paused
          ? t({ id: 'insights.collab.resume', defaultMessage: 'Resume dispatch' })
          : t({ id: 'insights.collab.pause', defaultMessage: 'Pause dispatch' })}
      </button>
      {failure && (
        <p className="bd-perr clb-err" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * The lead and today's task sessions as a graph, the picked session beside it, the dispatch
 * controls above, and slots, handbacks, waits and the lead's context below.
 */
export function CollabTab({
  model,
  projectId,
  onOpenSession,
  bar,
  readOnly,
}: {
  model: BoardModel;
  /** Reads and writes the workflow policy and acts on task sessions; absent, all is read-only. */
  projectId?: string;
  onOpenSession: (sessionId: string) => void;
  /** The top bar's place for the dispatch controls, once it is in. */
  bar?: HTMLElement | null;
  /** The board shown is a retained read, so no session action is offered. */
  readOnly?: boolean;
}) {
  const policy = useWorkflowPolicy(projectId ?? null).read;
  const sending = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const dialog = useDialogContent<{ kind: 'message' | 'handback'; sessionId: string }>();
  const [draft, setDraft] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const sessions = useBoard((s) => s.board?.sessions) ?? [];

  const { slots, now } = model;
  const open = model.tasks.filter(hasOpenSession);
  const counts = new Map(
    (model.leads ?? []).flatMap((lead) =>
      (lead.messages_today ?? []).map((m) => [m.session_id, m]),
    ),
  );
  const rows = model.tasks.filter(
    (task): task is Claimed =>
      !!task.claim && (hasOpenSession(task) || counts.has(task.claim.session_id)),
  );
  const picked = rows.find((task) => task.claim.session_id === selected);
  const pickedSession = picked && sessions.find((s) => s.id === picked.claim.session_id);
  const models = useRuntimeModels(projectId ?? null, picked ? [picked.claim.runtime] : []);
  const runtimeStatus = useRuntimeStatus().read;
  const modelFixedInTurn =
    pickedSession?.state === 'running' &&
    runtimeStatus.state === 'ready' &&
    runtimeStatus.statuses.find((s) => s.runtime === picked?.claim.runtime)?.capabilities
      ?.turn_model_change?.status === 'unsupported';
  const trace = useTaskTrace(
    projectId && picked?.owner_session_id ? projectId : null,
    picked?.id ?? '',
    picked ? [picked.claim.session_id] : [],
  );
  const heading = t({ id: 'insights.sections.collab', defaultMessage: 'Collaboration' });

  const act = async (
    type: CommandType,
    input: Record<string, unknown>,
    revision: number | null,
  ) => {
    if (sending.current) return;
    sending.current = true;
    setActing(true);
    setActError(null);
    const refused = await runBoardCommand(type, input, revision);
    sending.current = false;
    setActing(false);
    setActError(refused);
  };

  // Leads with a task session today, each with its sessions in plan order; sessions of no listed lead last.
  const leads = (model.leads ?? []).filter((lead) =>
    rows.some((task) => task.owner_session_id === lead.session_id),
  );
  const ordered = [
    ...leads.flatMap((lead) => rows.filter((task) => task.owner_session_id === lead.session_id)),
    ...rows.filter((task) => !leads.some((lead) => lead.session_id === task.owner_session_id)),
  ];
  let y = 0;
  const placed = ordered.map((task) => {
    const today = counts.get(task.claim.session_id);
    const checks = checkNodes(task, today);
    const span = Math.max(1, checks.length);
    const row = {
      task,
      today,
      top: y + ((span - 1) * PITCH) / 2,
      checks: checks.map((check, i) => ({ ...check, top: y + i * PITCH })),
    };
    y += span * PITCH;
    return row;
  });
  const leadTop = new Map(
    leads.map((lead) => {
      const own = placed.filter((p) => p.task.owner_session_id === lead.session_id);
      return [lead.session_id, (own[0]!.top + own.at(-1)!.top) / 2];
    }),
  );
  const width = placed.some((p) => p.checks.length) ? 2 * COL + NODE_W : COL + NODE_W;
  const height = y - (PITCH - NODE_H);
  const mid = NODE_H / 2;
  const moving = (today: Today | undefined, line: Line) => !!today?.in_flight?.includes(line);
  const anyMoving = placed.some(
    ({ task, today, checks }) =>
      (leadTop.has(task.owner_session_id ?? '') && moving(today, 'lead')) ||
      checks.some((check) => moving(today, check.line)),
  );

  // A lead on its direct task shows the same request on its own row and on the task's.
  const waitsForYou = [
    ...new Map(
      [
        ...model.tasks.flatMap((task) => (task.activity?.waiting ? [task.activity.waiting] : [])),
        ...(model.leads ?? []).flatMap((lead) => (lead.waiting ? [lead.waiting] : [])),
      ].map((waiting) => [waiting.approval_id, waiting.since]),
    ).values(),
  ];
  const upstream = model.tasks.filter((task) => task.state === 'waiting_upstream');
  const upstreamSince = upstream.flatMap((task) =>
    task.blocked_since === null ? [] : [task.blocked_since],
  );
  const events = (model.leads ?? []).flatMap((lead) => lead.events_today ?? []);
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  // Where a time falls in the local day, as a percentage.
  const dayShare = (at: number) =>
    Math.round(
      Math.min(
        1,
        Math.max(0, (at - dayStart.getTime()) / (dayEnd.getTime() - dayStart.getTime())),
      ) * 10_000,
    ) / 100;
  // A direct task runs in its lead, which holds no slot; a parallel task holds one per open part.
  const held = open
    .flatMap((task) =>
      task.claim!.session_id === task.owner_session_id
        ? []
        : task.parallel
          ? task.parallel.flatMap((part) =>
              part.session_id && part.status && part.status !== 'done' ? [part.status] : [],
            )
          : [task.status],
    )
    .map((status) => SLOT_TONES[status])
    .sort((a, b) => SLOT_ORDER.indexOf(a) - SLOT_ORDER.indexOf(b));
  const heldCount = (tone: 'run' | 'wait' | 'bad') => held.filter((h) => h === tone).length;
  const leadContexts = (model.leads ?? []).flatMap((lead) => {
    const usage = sessions.find((s) => s.id === lead.session_id)?.usage;
    return usage?.context_tokens !== undefined && usage.context_window
      ? [{ lead, percent: percentOf(usage.context_tokens, usage.context_window) }]
      : [];
  });

  const target =
    dialog.content && rows.find((task) => task.claim.session_id === dialog.content!.sessionId);
  const targetSession = target ? sessions.find((s) => s.id === target.claim.session_id) : undefined;
  const showDialog = (kind: 'message' | 'handback', sessionId: string) => {
    setDraft('');
    setDialogError(null);
    dialog.show({ kind, sessionId });
  };
  const submit = async () => {
    const input = draft.trim();
    if (!target || !dialog.content || dialogBusy || !input) return;
    let type: CommandType = 'task.handback';
    let body: Record<string, unknown> = {
      lead_session_id: target.owner_session_id,
      task_id: planTaskIds(target.id).task,
      reason: input,
    };
    let revision: number | null = null;
    if (dialog.content.kind === 'message') {
      const state = tellLead(targetSession);
      if (!targetSession || !state.enabled) {
        setDialogError(state.reason);
        return;
      }
      type = state.type;
      body = { session_id: targetSession.id, input };
      revision = targetSession.revision;
    }
    setDialogBusy(true);
    setDialogError(null);
    const refused = await runBoardCommand(type, body, revision);
    setDialogBusy(false);
    if (refused) setDialogError(refused);
    else dialog.close();
  };

  const sidePanel = (task: Claimed) => {
    const sessionId = task.claim.session_id;
    const today = counts.get(sessionId);
    const approval = task.state === 'waiting_approval';
    const acts = !!projectId && !readOnly;
    const message = pickedSession && tellLead(pickedSession);
    const modelsRead = models[task.claim.runtime];
    const steps = (trace.data ?? []).filter(
      (entry) => !entry.session_id || entry.session_id === sessionId,
    );
    const eventsTitle = t({
      id: 'insights.collab.events',
      defaultMessage: 'What happened on this line',
    });
    const messageButton = message && (
      <button
        type="button"
        className="btn"
        aria-disabled={!message.enabled || undefined}
        onClick={() => message.enabled && showDialog('message', sessionId)}
      >
        {t({ id: 'insights.collab.message', defaultMessage: 'Send a message' })}
      </button>
    );
    return (
      <aside className="clb-side" aria-label={task.title}>
        <div className="clb-sh">
          <RuntimeGlyph runtime={task.claim.runtime} />
          <b className="clb-st">{task.title}</b>
          <ModelMark model={task.claim.model} beside={task.claim.runtime} size={14} />
          {task.claim.model && <span className="clb-mdl">{task.claim.model}</span>}
        </div>
        {task.context && (
          <div className="clb-ctx">
            {t({ id: 'insights.collab.contextLabel', defaultMessage: 'Context' })}
            {meter(percentOf(task.context.used_tokens, task.context.window_tokens))}
            <span className="clb-pct">
              {percentOf(task.context.used_tokens, task.context.window_tokens)}%
            </span>
          </div>
        )}
        {today && (
          <>
            <p className="clb-msg">
              {policy
                ? t(
                    {
                      id: 'insights.collab.withLeadLimit',
                      defaultMessage:
                        '{lead, plural, one {# message} other {# messages}} with the lead, {handbacks, plural, one {# handback} other {# handbacks}}, limit {limit}',
                    },
                    { lead: today.lead, handbacks: today.handbacks, limit: policy.handback_limit },
                  )
                : t(
                    {
                      id: 'insights.collab.withLead',
                      defaultMessage:
                        '{lead, plural, one {# message} other {# messages}} with the lead, {handbacks, plural, one {# handback} other {# handbacks}}',
                    },
                    { lead: today.lead, handbacks: today.handbacks },
                  )}
            </p>
            <p className="clb-msg">
              {t(
                {
                  id: 'insights.collab.trackerMessages',
                  defaultMessage:
                    '{count, plural, one {# message} other {# messages}} from the tracker',
                },
                { count: today.tracker },
              )}
            </p>
          </>
        )}
        <div className="clb-acts">
          <button
            type="button"
            className={approval ? 'btn pri' : 'btn'}
            onClick={() => onOpenSession(sessionId)}
          >
            {approval
              ? t({ id: 'insights.collab.approve', defaultMessage: 'Go to approval' })
              : t({ id: 'insights.collab.open', defaultMessage: 'Open session' })}
          </button>
          {acts &&
            message &&
            (message.reason ? <Tip content={message.reason}>{messageButton!}</Tip> : messageButton)}
          {acts && pickedSession && (
            <Menu.Root
              disabled={
                acting || !pickedSession.workspace_id || !!pickedSession.outcome || modelFixedInTurn
              }
            >
              <Menu.Trigger className="btn">
                {t({ id: 'insights.collab.model', defaultMessage: 'Change model' })}
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
                  <Menu.Popup className="wmenu pjm pop">
                    {modelsRead?.state === 'ready' && modelsRead.models.length > 0 ? (
                      <Menu.RadioGroup value={task.claim.model ?? ''}>
                        {modelsRead.models.map((m) => {
                          const effort =
                            task.claim.effort && m.efforts.includes(task.claim.effort)
                              ? task.claim.effort
                              : m.default_effort;
                          return (
                            <Menu.RadioItem
                              key={m.id}
                              value={m.id}
                              onClick={() =>
                                void act(
                                  'session.setModel',
                                  { session_id: sessionId, model: m.id, ...(effort && { effort }) },
                                  pickedSession.revision,
                                )
                              }
                            >
                              <span className="pjm-ck">
                                <Menu.RadioItemIndicator>
                                  <Check className="ic-sm" aria-hidden="true" />
                                </Menu.RadioItemIndicator>
                              </span>
                              {m.label}
                            </Menu.RadioItem>
                          );
                        })}
                      </Menu.RadioGroup>
                    ) : (
                      <p
                        className="clb-mnote"
                        role={modelsRead?.state === 'failed' ? 'alert' : undefined}
                      >
                        {modelsRead?.state === 'failed'
                          ? modelsRead.text
                          : modelsRead?.state === 'ready'
                            ? t({
                                id: 'insights.collab.noModels',
                                defaultMessage: 'No models listed',
                              })
                            : t({
                                id: 'insights.collab.modelsLoading',
                                defaultMessage: 'Loading models',
                              })}
                      </p>
                    )}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          )}
          {/* A direct task's session is its lead, which has nothing to hand back to. */}
          {acts &&
            task.owner_session_id &&
            task.owner_session_id !== sessionId &&
            hasOpenSession(task) && (
              <button
                type="button"
                className="btn"
                onClick={() => showDialog('handback', sessionId)}
              >
                {t({ id: 'insights.collab.handBack', defaultMessage: 'Hand back to lead' })}
              </button>
            )}
          {acts && pickedSession && (
            <button
              type="button"
              className="btn"
              aria-busy={acting || undefined}
              disabled={acting || pickedSession.state !== 'running'}
              onClick={() =>
                void act('session.interrupt', { session_id: sessionId }, pickedSession.revision)
              }
            >
              {t({ id: 'insights.collab.interrupt', defaultMessage: 'Interrupt' })}
            </button>
          )}
        </div>
        {actError && (
          <p className="bd-perr" role="alert">
            {actError}
          </p>
        )}
        {trace.error && (
          <p className="bd-perr" role="alert">
            {trace.error}
          </p>
        )}
        {steps.length > 0 && (
          <section className="clb-ev" aria-label={eventsTitle}>
            <span className="clb-cap" aria-hidden="true">
              {eventsTitle}
            </span>
            <ol className="clb-evl">
              {steps.map((entry, i) => {
                const kind = TRACE_KINDS[entry.kind];
                return (
                  <li key={`${entry.at}-${i}`} className="clb-evi">
                    <time className="clb-evt" dateTime={new Date(entry.at).toISOString()}>
                      {dayText(entry.at, now, { time: true })}
                    </time>
                    <span className="bd-tl-g" data-tone={kind.tone} aria-hidden="true">
                      {'icon' in kind ? (
                        kind.icon
                      ) : (
                        <svg viewBox="0 0 14 14" aria-hidden="true">
                          {kind.glyph}
                        </svg>
                      )}
                    </span>
                    <span className="clb-evx">
                      {kind.label}
                      {entry.text && <span className="clb-evd">{entry.text}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </aside>
    );
  };

  return (
    <section className="clb" aria-label={heading}>
      <BarSlot bar={bar}>
        <CollabControls projectId={projectId} />
      </BarSlot>
      {rows.length === 0 ? (
        <Empty
          text={t({ id: 'insights.collab.noSessions', defaultMessage: 'No task sessions today' })}
        />
      ) : (
        <div className="clb-main">
          <div
            className="clb-graph"
            role="group"
            aria-label={t({
              id: 'insights.collab.graph',
              defaultMessage: 'Relations between sessions',
            })}
          >
            <div className="clb-canvas" style={{ width, height }}>
              <svg className="clb-edges" width={width} height={height}>
                {placed.map(({ task, today, top, checks }) => {
                  const from = leadTop.get(task.owner_session_id ?? '');
                  const y1 = from === undefined ? null : from + mid;
                  const y2 = top + mid;
                  const count = (line: Line, x: number, y: number) => {
                    const n = today && LINE_COUNT[line].of(today);
                    return !!n && edgeCount(x, y, n, LINE_COUNT[line].title(n));
                  };
                  return (
                    <g key={task.claim.session_id}>
                      {y1 !== null && (
                        <path
                          className={moving(today, 'lead') ? 'live' : undefined}
                          d={edge(NODE_W, y1, COL, y2)}
                          aria-hidden="true"
                        />
                      )}
                      {y1 !== null && count('lead', (NODE_W + COL) / 2, (y1 + y2) / 2)}
                      {checks.map((check) => (
                        <g key={check.line}>
                          <path
                            className={moving(today, check.line) ? 'live' : undefined}
                            d={edge(COL + NODE_W, y2, 2 * COL, check.top + mid)}
                            aria-hidden="true"
                          />
                          {count(
                            check.line,
                            (COL + NODE_W + 2 * COL) / 2,
                            (y2 + check.top + mid) / 2,
                          )}
                        </g>
                      ))}
                    </g>
                  );
                })}
              </svg>
              {leads.map((lead) => {
                const leadSession = sessions.find((s) => s.id === lead.session_id);
                const state = leadState(lead);
                const name = lead.title || t({ id: 'board.lead.untitled', defaultMessage: 'Lead' });
                const context = leadContexts.find((c) => c.lead === lead);
                return (
                  <button
                    key={lead.session_id}
                    type="button"
                    className="clb-node"
                    style={{ left: 0, top: leadTop.get(lead.session_id) }}
                    aria-label={t(
                      { id: 'insights.collab.openLead', defaultMessage: 'Open {name} ({state})' },
                      { name, state: state.label },
                    )}
                    onClick={() => onOpenSession(lead.session_id)}
                  >
                    <span className="clb-nh">
                      {leadSession && <RuntimeGlyph runtime={leadSession.runtime} size={14} />}
                      <b className="clb-nt">{name}</b>
                      <Crown className="ic-sm" aria-hidden="true" />
                      {context && ring(context.percent)}
                    </span>
                    <span className="clb-ns">
                      <span
                        className="clb-ls"
                        style={{ '--c': `var(${stateGlyphTone(state.glyph)})` } as CSSProperties}
                      >
                        {state.label}
                      </span>
                      {lead.waiting && <span className="clb-nst">{lead.waiting.summary}</span>}
                      <span className="clb-nr">{roleName('lead')}</span>
                    </span>
                  </button>
                );
              })}
              {placed.map(({ task, top, checks }) => {
                const sessionId = task.claim.session_id;
                const count = counts.get(sessionId)?.lead;
                const state = taskStateLabel(task);
                const note = activityNote(task, now, model);
                return [
                  <button
                    key={sessionId}
                    type="button"
                    className="clb-node"
                    data-session={sessionId}
                    style={{ left: COL, top }}
                    aria-pressed={selected === sessionId}
                    aria-label={
                      count === undefined
                        ? t(
                            { id: 'insights.collab.node', defaultMessage: '{title}, {state}' },
                            { title: task.title, state },
                          )
                        : t(
                            {
                              id: 'insights.collab.nodeMessages',
                              defaultMessage:
                                '{title}, {state}, {count, plural, one {# message} other {# messages}} from the lead today',
                            },
                            { title: task.title, state, count },
                          )
                    }
                    onClick={() => {
                      setActError(null);
                      setSelected(selected === sessionId ? null : sessionId);
                    }}
                  >
                    <span className="clb-nh">
                      <RuntimeGlyph runtime={task.claim.runtime} size={14} />
                      <b className="clb-nt">{task.title}</b>
                      {task.context &&
                        ring(percentOf(task.context.used_tokens, task.context.window_tokens))}
                    </span>
                    <span className="clb-ns">
                      <TaskStateIcon task={task} />
                      <span className="clb-nst">
                        {note?.text ?? state}
                        {note?.ago && (
                          <>
                            {' '}
                            <span className="clb-nago">{note.ago}</span>
                          </>
                        )}
                      </span>
                      <span className="clb-nr">{roleName('task')}</span>
                    </span>
                  </button>,
                  ...checks.map((check) => (
                    <div
                      key={`${sessionId}:${check.line}`}
                      className="clb-node"
                      role="group"
                      aria-label={check.label}
                      style={{ left: 2 * COL, top: check.top }}
                    >
                      <span className="clb-nh">
                        <b className="clb-nt">{check.label}</b>
                      </span>
                      <span className="clb-ns">
                        <StatusIcon status={check.status} />
                        {check.text !== undefined && <span className="clb-nst">{check.text}</span>}
                        {check.role && <span className="clb-nr">{check.role}</span>}
                      </span>
                    </div>
                  )),
                ];
              })}
            </div>
            {anyMoving && (
              <div
                className="pop clb-lg"
                role="group"
                aria-label={t({ id: 'insights.collab.legend', defaultMessage: 'Legend' })}
              >
                <div className="legend">
                  <span>
                    <span className="bd-fo-dot" data-c="run" aria-hidden="true" />
                    {t({ id: 'insights.collab.moving', defaultMessage: 'Moving now' })}
                  </span>
                </div>
              </div>
            )}
          </div>
          {picked && sidePanel(picked)}
        </div>
      )}
      <div
        className="clb-sum"
        role="group"
        aria-label={t({ id: 'insights.collab.summary', defaultMessage: 'Collaboration summary' })}
      >
        {slots && (
          <div className="clb-sc">
            <span className="clb-cap">
              {t({ id: 'insights.collab.slotsTitle', defaultMessage: 'Slots' })}
            </span>
            <span className="clb-sr">
              <b className="clb-big" aria-hidden="true">
                {slots.used} / {slots.limit}
              </b>
              <span
                className="clb-bar"
                role="img"
                aria-label={
                  slots.used > slots.limit
                    ? t(
                        {
                          id: 'insights.collab.slotsOverByState',
                          defaultMessage:
                            'Slots {used}/{limit}, {over} over the limit: {running} running, {waiting} waiting, {failed} failed',
                        },
                        {
                          used: slots.used,
                          limit: slots.limit,
                          over: slots.used - slots.limit,
                          running: heldCount('run'),
                          waiting: heldCount('wait'),
                          failed: heldCount('bad'),
                        },
                      )
                    : t(
                        {
                          id: 'insights.collab.slotsByState',
                          defaultMessage:
                            'Slots {used}/{limit}: {running} running, {waiting} waiting, {failed} failed',
                        },
                        {
                          used: slots.used,
                          limit: slots.limit,
                          running: heldCount('run'),
                          waiting: heldCount('wait'),
                          failed: heldCount('bad'),
                        },
                      )
                }
              >
                {Array.from({ length: Math.max(slots.limit, slots.used) }, (_, i) => (
                  <i
                    key={i}
                    data-on={i < slots.used || undefined}
                    data-tone={i < slots.used ? held[i] : undefined}
                    data-over={i >= slots.limit || undefined}
                  />
                ))}
              </span>
              <span className="clb-num">
                {t(
                  { id: 'insights.collab.queued', defaultMessage: '{count} queued' },
                  { count: slots.queued },
                )}
              </span>
            </span>
          </div>
        )}
        <div className="clb-sc">
          <span className="clb-cap">
            {t({
              id: 'insights.collab.handbacksAndModels',
              defaultMessage: 'Handbacks and model changes',
            })}
          </span>
          <span className="clb-sr">
            <span className="clb-num">
              {t(
                { id: 'insights.collab.handbacksToday', defaultMessage: '{count} today' },
                { count: events.length },
              )}
            </span>
          </span>
          <svg
            className="clb-tl"
            width="100%"
            height="28"
            role="img"
            aria-label={t(
              {
                id: 'insights.collab.eventsLabel',
                defaultMessage:
                  '{handbacks, plural, one {# handback} other {# handbacks}} and {changes, plural, one {# model change} other {# model changes}} today',
              },
              {
                handbacks: events.filter((e) => e.kind === 'handback').length,
                changes: events.filter((e) => e.kind === 'model_change').length,
              },
            )}
          >
            <line x1="0" y1="14" x2="100%" y2="14" />
            {events.map((event, i) => (
              <svg
                key={`${event.at}-${i}`}
                className="clb-tp"
                data-kind={event.kind}
                x={`${dayShare(event.at)}%`}
                y="14"
              >
                <title>
                  {`${dayText(event.at, now, { time: true })} ${
                    event.kind === 'handback'
                      ? t({ id: 'insights.collab.handbackEvent', defaultMessage: 'Handback' })
                      : t({ id: 'insights.collab.modelEvent', defaultMessage: 'Model change' })
                  }`}
                </title>
                {event.kind === 'handback' ? (
                  <circle r="4" />
                ) : (
                  <rect x="-3" y="-3" width="6" height="6" transform="rotate(45)" />
                )}
              </svg>
            ))}
          </svg>
        </div>
        <div className="clb-sc">
          <span className="clb-cap">
            {t({ id: 'insights.collab.waiting', defaultMessage: 'Who waits for whom' })}
          </span>
          <span className="clb-sr">
            <StateIcon state="waiting_approval" />
            <span className="clb-wl">
              {t(
                {
                  id: 'insights.collab.waitingYou',
                  defaultMessage:
                    '{count, plural, one {# session waits for you} other {# sessions wait for you}}',
                },
                { count: waitsForYou.length },
              )}
            </span>
            <span className="clb-num">{longest(waitsForYou, now)}</span>
          </span>
          <span className="clb-sr">
            <StateIcon state="waiting_upstream" />
            <span className="clb-wl">
              {t(
                {
                  id: 'insights.collab.waitingUpstream',
                  defaultMessage:
                    '{count, plural, one {# task waits on upstream} other {# tasks wait on upstream}}',
                },
                { count: upstream.length },
              )}
            </span>
            <span className="clb-num">{longest(upstreamSince, now)}</span>
          </span>
        </div>
        {leadContexts.length > 0 && (
          <div className="clb-sc">
            <span className="clb-cap">
              {t({ id: 'insights.collab.leadContext', defaultMessage: 'Lead context' })}
            </span>
            {leadContexts.map(({ lead, percent }) => (
              <span key={lead.session_id} className="clb-sr">
                {leadContexts.length > 1 && <span className="clb-wl">{lead.title}</span>}
                {meter(percent)}
                <span className="clb-pct">{percent}%</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <Dialog.Root {...dialog.root}>
        {dialog.content && target && (
          <Dialog.Portal>
            <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
            <Dialog.Popup className="pj-dlg pj-rm pop">
              <div className="pj-dh">
                <Dialog.Title className="pj-dt">
                  {dialog.content.kind === 'message'
                    ? t({ id: 'insights.collab.message', defaultMessage: 'Send a message' })
                    : t({ id: 'insights.collab.handBack', defaultMessage: 'Hand back to lead' })}
                </Dialog.Title>
              </div>
              <div className="bp-dlb">
                {dialog.content.kind === 'message' ? (
                  <textarea
                    className="bp-ta"
                    rows={4}
                    aria-label={t({ id: 'insights.collab.messageText', defaultMessage: 'Message' })}
                    value={draft}
                    readOnly={dialogBusy}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                ) : (
                  <input
                    className="bd-fsel"
                    aria-label={t({
                      id: 'insights.collab.handBackReason',
                      defaultMessage: 'Reason',
                    })}
                    required
                    value={draft}
                    readOnly={dialogBusy}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit();
                    }}
                  />
                )}
              </div>
              {dialogError && (
                <div className="pj-err" role="alert">
                  <b>{dialogError}</b>
                </div>
              )}
              <div className="pj-df">
                <span style={{ flex: 1 }} />
                <Dialog.Close className="btn ghost">
                  {t({ id: 'insights.collab.cancel', defaultMessage: 'Cancel' })}
                </Dialog.Close>
                <button
                  type="button"
                  className="btn pri"
                  aria-busy={dialogBusy || undefined}
                  disabled={dialogBusy || !draft.trim()}
                  onClick={() => void submit()}
                >
                  {dialog.content.kind === 'message'
                    ? t({ id: 'insights.collab.send', defaultMessage: 'Send' })
                    : t({ id: 'insights.collab.handBackSend', defaultMessage: 'Hand back' })}
                </button>
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        )}
      </Dialog.Root>
    </section>
  );
}
