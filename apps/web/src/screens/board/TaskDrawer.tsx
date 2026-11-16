import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { BackendSummary, BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import { DiffCounts } from '../../components/DiffCounts';
import { Menu, MenuItem } from '../../components/Menu';
import { PathText } from '../../components/PathText';
import { ModelMark } from '../../components/RuntimeGlyph';
import { Select } from '../../components/Select';
import { Splitter } from '../../components/Splitter';
import { useBackends } from '../../data/backends';
import { useDevices } from '../../data/devices';
import { focusRequest } from '../../data/focus-request';
import {
  DRAWER,
  drawerMax,
  saveLayout,
  setLayout,
  useFolds,
  useLayout,
  useViewportWidth,
} from '../../data/layout';
import { useNow } from '../../data/needs-you';
import { needsKey } from '../../data/notice-tiers';
import { useRuntimeModels, type ModelsState } from '../../data/runtime-models';
import { useRuntimeStatus } from '../../data/runtime-status';
import {
  connectRefusal,
  editPlan,
  editTarget,
  planVersion,
  withDependency,
  withoutDependency,
  type EditTarget,
  type PlanOp,
} from '../../data/plan-edit';
import { planTaskIds } from '../../data/task-trace';
import { composeState } from '../../data/transcript';
import { t } from '../../i18n';
import { reducedMotion } from '../../lib/motion';
import { useShell } from '../../store';
import { useQueued } from '../sessions/compose';
import { messageCommand } from '../sessions/model';
import { defaultModel } from '../sessions/thread-model';
import { openBoardTab } from '../settings/settings-jump';
import { quotaResetsAt, resumesText, taskBadges, taskTokens } from './activity';
import { DeviceDot, DeviceFacts, DeviceState, ResourceMeter } from './BoardDevices';
import { requestNeed } from './frame-model';
import { PlanEdit } from './PlanEdit';
import { PlanList } from './PlanList';
import { dayText } from '../../lib/time-text';
import {
  durationText,
  tellLeadDraft,
  tokenText,
  type RunBoardCommand,
  type SnapshotSession,
} from './panels-model';
import { STATUS, StatusIcon, TaskBadges, TaskRoute, TaskStateBadge, runtimeName } from './status';
import { TaskTimeline } from './TaskTimeline';
import { TellLead, TellLeadBox, useDialogContent } from './TellLead';
import { isPlanTask } from './view-rules';
import './flow.css';
import './drawer.css';

type Task = BoardModel['tasks'][number];

const noneText = () => t({ id: 'board.task.drawer.none', defaultMessage: 'None' });
const listSeparator = () => t({ id: 'board.task.segment.separator', defaultMessage: ', ' });

const CHECKS: Record<Task['checks'], { icon: BoardTaskStatus | null; label: string }> = {
  pass: {
    icon: 'done',
    get label() {
      return t({ id: 'board.task.checks.pass', defaultMessage: 'Passed' });
    },
  },
  fail: {
    icon: 'failed',
    get label() {
      return t({ id: 'board.task.checks.fail', defaultMessage: 'Failed' });
    },
  },
  running: {
    icon: 'running',
    get label() {
      return t({ id: 'board.task.checks.running', defaultMessage: 'Running' });
    },
  },
  none: {
    icon: null,
    get label() {
      return noneText();
    },
  },
};

/** The longest the drawer waits for its exit transition before it unmounts anyway. */
const EXIT_MS = 400;

/** The task's newest session has not ended it, so the lead can be handed the task back. */
export const hasOpenSession = (task: Pick<Task, 'claim' | 'state'>) =>
  !!task.claim && task.state !== 'merged' && task.state !== 'failed';

/** The lead works on the task itself, so it has no session of its own to hand back or add to. */
const leadClaimed = (task: Task) => !!task.claim && task.claim.session_id === task.owner_session_id;

/** The waits under which the daemon opens no session the user asks for on the task. */
const STARTS_HELD = new Set<Task['dispatch_wait']>(['upstream', 'scope', 'answer', 'step']);

/** The daemon would open a session the user asks for on the task now. */
const startable = (task: Task) =>
  !hasOpenSession(task) &&
  !leadClaimed(task) &&
  !task.blocked_since &&
  !STARTS_HELD.has(task.dispatch_wait);

const handBackText = () =>
  t({ id: 'board.task.handback.open', defaultMessage: 'Hand back to lead' });

function HandBackDialog({
  task,
  run,
  onSent,
}: {
  task: Task;
  run: RunBoardCommand;
  onSent: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = reason.trim();
  const send = async () => {
    if (busy || !text || !task.owner_session_id) return;
    setBusy(true);
    setError(null);
    const failure = await run(
      'task.handback',
      {
        lead_session_id: task.owner_session_id,
        task_id: planTaskIds(task.id).task,
        reason: text,
      },
      null,
    );
    setBusy(false);
    if (failure) setError(failure);
    else onSent();
  };
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="pj-scrim" />
      <Dialog.Popup className="pj-dlg pj-rm pop">
        <div className="pj-dh">
          <Dialog.Title className="pj-dt">{handBackText()}</Dialog.Title>
        </div>
        <div className="bp-dlb">
          <input
            className="bd-fsel"
            aria-label={t({ id: 'board.task.handback.reason', defaultMessage: 'Reason' })}
            required
            value={reason}
            readOnly={busy}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send();
            }}
          />
        </div>
        {error && (
          <div className="pj-err" role="alert">
            <b>{error}</b>
          </div>
        )}
        <div className="pj-df">
          <span style={{ flex: 1 }} />
          <Dialog.Close className="btn ghost">
            {t({ id: 'board.task.handback.cancel', defaultMessage: 'Cancel' })}
          </Dialog.Close>
          <button
            type="button"
            className="btn pri"
            aria-busy={busy || undefined}
            disabled={busy || !text}
            onClick={() => void send()}
          >
            {t({ id: 'board.task.handback.send', defaultMessage: 'Hand back' })}
          </button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

/** Hands the task back to its lead with the user's reason, while a session of it is unfinished. */
function HandBack({ task, run }: { task: Task; run: RunBoardCommand }) {
  const dialog = useDialogContent<number>();
  const openings = useRef(0);
  return (
    <>
      <button type="button" className="btn" onClick={() => dialog.show(++openings.current)}>
        {handBackText()}
      </button>
      <Dialog.Root {...dialog.root}>
        {dialog.content !== null && (
          <HandBackDialog key={dialog.content} task={task} run={run} onSent={dialog.close} />
        )}
      </Dialog.Root>
    </>
  );
}

const cancelText = () => t({ id: 'board.task.cancel.open', defaultMessage: 'Cancel task' });

function CancelDialog({
  target,
  run,
  onSent,
}: {
  target: EditTarget;
  run: RunBoardCommand;
  onSent: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = reason.trim();
  const send = async () => {
    if (busy || !text) return;
    setBusy(true);
    setError(null);
    const failure = await run(
      'task.stop',
      {
        project_id: target.projectId,
        lead_session_id: target.leadId,
        task_id: target.planId,
        reason: text,
      },
      null,
    );
    setBusy(false);
    if (failure) setError(failure);
    else onSent();
  };
  return (
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="pj-scrim" />
      <AlertDialog.Popup className="pj-dlg pj-rm pop">
        <div className="pj-dh">
          <AlertDialog.Title className="pj-dt">{cancelText()}</AlertDialog.Title>
        </div>
        <div className="bp-dlb">
          <input
            className="bd-fsel"
            aria-label={t({ id: 'board.task.cancel.reason', defaultMessage: 'Reason' })}
            required
            value={reason}
            readOnly={busy}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send();
            }}
          />
        </div>
        {error && (
          <div className="pj-err" role="alert">
            <b>{error}</b>
          </div>
        )}
        <div className="pj-df">
          <span style={{ flex: 1 }} />
          <AlertDialog.Close className="btn ghost">
            {t({ id: 'board.task.cancel.keep', defaultMessage: 'Keep task' })}
          </AlertDialog.Close>
          <button
            type="button"
            className="btn dng"
            aria-busy={busy || undefined}
            disabled={busy || !text}
            onClick={() => void send()}
          >
            {cancelText()}
          </button>
        </div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  );
}

/** Stops the task in its lead's plan with the user's reason: drops its start request and discards its open sessions. */
function CancelTask({ target, run }: { target: EditTarget; run: RunBoardCommand }) {
  const dialog = useDialogContent<number>();
  const openings = useRef(0);
  return (
    <>
      <button type="button" className="btn ghost" onClick={() => dialog.show(++openings.current)}>
        {cancelText()}
      </button>
      <AlertDialog.Root {...dialog.root}>
        {dialog.content !== null && (
          <CancelDialog key={dialog.content} target={target} run={run} onSent={dialog.close} />
        )}
      </AlertDialog.Root>
    </>
  );
}

// Sent to the model, so it stays in one language.
const REDO_PROMPT = 'Redo this task from the start.';

/** The task's session can take a new backend and a message now. */
const redoable = (session: SnapshotSession) =>
  !!session.workspace_id &&
  !session.outcome &&
  messageCommand(session.state) === 'session.send' &&
  composeState(session).send.enabled;

interface RedoChoice {
  backend: string | null;
  label: string;
  model?: string | undefined;
}

/** The backends the session could move to; none when it cannot take a message now. */
function redoChoices(
  session: SnapshotSession | undefined,
  backends: readonly BackendSummary[],
): RedoChoice[] {
  if (!session || !redoable(session)) return [];
  return [
    ...(session.backend_id
      ? [
          {
            backend: null,
            label: t(
              { id: 'sessions.composer.runtimeEndpoint', defaultMessage: '{runtime} default' },
              { runtime: runtimeName(session.runtime) },
            ),
          },
        ]
      : []),
    ...backends
      .filter(
        (b) =>
          b.runtimes.includes(session.runtime) &&
          b.id !== session.backend_id &&
          !(b.key_present === false && 'env' in b.key),
      )
      .map((b) => ({
        backend: b.id,
        label: b.id,
        // A backend that lists its models runs one of them.
        model:
          b.models.length && !b.models.includes(session.requested_model ?? '')
            ? b.models[0]
            : undefined,
      })),
  ];
}

/** The runtime's default model when the session's model is not one the runtime serves itself. */
function ownModel(session: SnapshotSession, read: ModelsState | undefined): string | undefined {
  const own = read?.state === 'ready' ? read.models : [];
  const requested = session.requested_model;
  if (!requested || own.some((m) => m.id === requested || m.resolved === requested))
    return undefined;
  return defaultModel(own)?.id;
}

/** Moves the task's session to another backend of its runtime, then asks it to start the task over. */
function Redo({
  session,
  choices,
  run,
}: {
  session: SnapshotSession;
  choices: RedoChoice[];
  run: RunBoardCommand;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = useRuntimeModels(session.project_id, [session.runtime])[session.runtime];
  const redo = async ({ backend, model: listed }: RedoChoice) => {
    // A model only the left backend serves gives way to the runtime's default.
    const model = backend === null ? ownModel(session, own) : listed;
    setBusy(true);
    setError(null);
    const failure = await run(
      'session.setBackend',
      { session_id: session.id, backend, ...(model ? { model } : {}) },
      session.revision,
    );
    // Closing the idle process can move the revision again; the queue sends at the one it reaches.
    if (!failure)
      useQueued.getState().add(session.id, { text: REDO_PROMPT, attachments: [], skills: [] });
    setBusy(false);
    setError(failure);
  };
  return (
    <>
      <Menu
        label={t({ id: 'board.drawer.redo.menu', defaultMessage: 'Redo on' })}
        trigger={
          <button type="button" className="btn" aria-busy={busy || undefined} disabled={busy}>
            {t({ id: 'board.drawer.redo.open', defaultMessage: 'Redo on another backend' })}
          </button>
        }
      >
        {choices.map((choice) => (
          <MenuItem key={choice.backend ?? ''} onClick={() => void redo(choice)}>
            {choice.label}
          </MenuItem>
        ))}
      </Menu>
      {error && (
        <span className="bd-derr" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

export interface TaskDrawerProps {
  model: BoardModel;
  /** The task to show; null closes the drawer, which unmounts once its exit transition ends. */
  taskId: string | null;
  onSelect: (taskId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  /** Opens the change story of a merged session. */
  onOpenStory: (sessionId: string) => void;
  /** Opens the new-session composer bound to a task of a lead's plan. */
  onStartTask?: (task: Task) => void;
  /** Snapshot sessions and the command runner behind the message to a task's lead. */
  tell?: { sessions: readonly SnapshotSession[]; run: RunBoardCommand };
}

function TaskLinks({
  tasks,
  onSelect,
  remove,
}: {
  tasks: Task[];
  onSelect: (id: string) => void;
  /** Takes the dependency on a listed task out of the plan. */
  remove?: { label: (t: Task) => string; onRemove: (t: Task) => void };
}) {
  if (!tasks.length) return <div className="mu">{noneText()}</div>;
  return (
    <ul className="bd-dl">
      {tasks.map((linked) => (
        <li key={linked.id} className={remove ? 'bd-dlr' : undefined}>
          <button
            type="button"
            className="bd-dbtn dep"
            aria-label={t(
              { id: 'board.task.link.label', defaultMessage: '{title}, {status}' },
              { title: linked.title, status: STATUS[linked.status].label },
            )}
            onClick={() => onSelect(linked.id)}
          >
            <StatusIcon status={linked.status} />
            <span className="nm">{linked.title}</span>
          </button>
          {remove && (
            <button
              type="button"
              className="ib"
              aria-label={remove.label(linked)}
              onClick={() => remove.onRemove(linked)}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The parts of a parallel task in plan order; a dispatched part opens its session. */
function ParallelParts({
  parts,
  onOpenSession,
}: {
  parts: NonNullable<Task['parallel']>;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <section className="bd-dsec">
      <h3>{t({ id: 'board.task.drawer.parts', defaultMessage: 'Parallel parts' })}</h3>
      <ul className="bd-dl">
        {parts.map((part, i) => {
          const status = part.status ?? 'todo';
          const sessionId = part.session_id;
          return (
            <li key={i}>
              {sessionId ? (
                <button
                  type="button"
                  className="bd-dbtn dep"
                  aria-label={t(
                    { id: 'board.task.link.label', defaultMessage: '{title}, {status}' },
                    { title: part.title, status: STATUS[status].label },
                  )}
                  onClick={() => onOpenSession(sessionId)}
                >
                  <StatusIcon status={status} />
                  <span className="nm">{part.title}</span>
                </button>
              ) : (
                <div className="bd-dpart">
                  <span role="img" aria-label={STATUS[status].label}>
                    <StatusIcon status={status} />
                  </span>
                  <span className="nm">{part.title}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Task details sliding in from the right, sized by the box it is placed in; Esc or a click outside
 * closes it. Closing from inside the drawer puts focus back on the card or node that opened it.
 */
export function TaskDrawer({
  model,
  taskId,
  onSelect,
  onOpenSession,
  onOpenStory,
  onStartTask,
  tell,
}: TaskDrawerProps) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(taskId);
  if (taskId !== null && taskId !== shown) setShown(taskId);
  const open = taskId !== null;
  const leaving = !open && shown !== null;
  const task = model.tasks.find((t) => t.id === shown);
  // A running task's time keeps growing between board reads.
  const now = Math.max(model.now, useNow(15_000));
  const max = drawerMax(useViewportWidth());
  const width = Math.min(max, useLayout().drawer);
  const folds = useFolds();
  const seenFolds = useRef(folds);
  const backends = useBackends();
  const { read: deviceRead, reload: reloadDevices } = useDevices();
  const status = useRuntimeStatus().read;
  const routeRuntime = (task?.claim ?? task?.planned)?.runtime ?? null;
  const routeProject =
    tell?.sessions.find((s) => s.id === (task?.owner_session_id ?? task?.id))?.project_id ?? null;
  const routeModels = useRuntimeModels(routeProject, routeRuntime ? [routeRuntime] : [])[
    routeRuntime ?? ''
  ];

  // Each task opened reads the devices again, so their state and load are current.
  useEffect(() => {
    if (taskId !== null) void reloadDevices(false);
  }, [taskId, reloadDevices]);

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (taskId !== null && active instanceof HTMLElement && !ref.current?.contains(active)) {
      opener.current = active;
      close.current?.focus({ preventScroll: true });
    }
  }, [taskId]);

  useEffect(() => {
    if (!leaving) return;
    const el = ref.current;
    if (el?.contains(document.activeElement) && opener.current?.isConnected)
      opener.current.focus({ preventScroll: true });
    // Inert only after focus has left, so the drawer's controls drop out of the tab order.
    if (el) el.inert = true;
    let done = false;
    const finish = () => {
      if (!done) setShown(null);
      done = true;
    };
    if (!el || reducedMotion()) {
      finish();
      return;
    }
    const timer = setTimeout(finish, EXIT_MS);
    // Before the exit transition starts there is nothing to wait on; the timer ends it then.
    const animations = el.getAnimations();
    if (animations.length > 0)
      void Promise.allSettled(animations.map((a) => a.finished)).then(finish);
    return () => {
      done = true;
      clearTimeout(timer);
      el.inert = false;
    };
  }, [leaving]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc inside a dialog, menu or select list the drawer opened closes only that one.
      if (e.key === 'Escape' && !(e.target as Element).closest?.('.pj-dlg, .mn')) onSelect(null);
    };
    // A click on another flow node or task card switches the drawer instead of closing it.
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (
        !ref.current?.contains(target) &&
        !target.closest?.('.react-flow__node, [data-task-card], .pj-dlg, .pj-scrim, .mn')
      )
        onSelect(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [onSelect, open]);

  useEffect(() => {
    if (seenFolds.current === folds) return;
    seenFolds.current = folds;
    if (open) onSelect(null);
  }, [folds]);

  if (!task) return null;
  const lane = model.lanes.find((l) => l.id === task.lane_id);
  const byId = new Map(model.tasks.map((t) => [t.id, t]));
  const ups = model.edges.filter((e) => e.to === task.id).map((e) => byId.get(e.from));
  const downs = model.edges.filter((e) => e.from === task.id).map((e) => byId.get(e.to));
  const done = task.segments.filter((s) => s.status === 'done').length;
  const check = CHECKS[task.checks];
  const device = task.planned?.device;
  const needs = task.planned?.needs ?? [];
  const uses = Object.entries(task.planned?.uses ?? {});
  const placed =
    deviceRead.state === 'ready' ? deviceRead.devices.find((d) => d.id === device) : undefined;
  // Cards show these as icons with the label on hover only.
  // The state badge already names an approval wait; a question wait has no state of its own.
  const badges = taskBadges(task).filter(
    (b) => !(b.waits === 'approval' && task.state === 'waiting_approval'),
  );
  // A plan task's merges show in its timeline; a session without a task has no timeline.
  const plan = isPlanTask(task);
  const merges = model.merges.filter((m) =>
    task.segments.some((s) => s.session_id === m.session_id),
  );
  const target = plan && tell ? editTarget(task, tell.sessions) : null;
  const relink = (op: PlanOp) => {
    if (target) void editPlan(target, [op], planVersion(model, target.leadId));
  };
  const candidates = target
    ? model.tasks.filter(
        (t) =>
          t.owner_session_id === task.owner_session_id &&
          connectRefusal(model, t.id, task.id) === null,
      )
    : [];
  const resumes = quotaResetsAt(task, status.state === 'ready' ? status.statuses : [], now);
  const acceptance = task.acceptance_checks ?? [];
  const waiting = task.activity?.waiting;
  // A session row's activity is its own; a plan task's is its newest session's.
  const approvalIn =
    waiting?.kind === 'approval' ? (task.claim?.session_id ?? (plan ? null : task.id)) : null;
  // A question opens its card, on the lead's board when the lead relays it.
  const question =
    waiting?.kind === 'input' ? requestNeed(model.needs ?? [], waiting.approval_id) : undefined;
  const questionKey = question && needsKey(question);
  const worker =
    task.owner_session_id && task.claim
      ? tell?.sessions.find((s) => s.id === task.claim!.session_id)
      : undefined;
  const redo = redoChoices(worker, backends);
  const leadId = plan ? task.owner_session_id : undefined;
  const reassign =
    tell && target && device && device !== 'local' && task.state !== 'merged' ? target : null;
  // task.stop needs a start request or an unfinished session to stop.
  const stoppable =
    tell && target && (task.dispatch_wait !== undefined || hasOpenSession(task)) ? target : null;
  const start = !!onStartTask && !!task.owner_session_id && startable(task);
  // task.handback finds only the task's own sessions, never its lead's.
  const handBack = !!tell && !!task.owner_session_id && hasOpenSession(task) && !leadClaimed(task);
  return (
    <aside
      ref={ref}
      className="bd-drw"
      style={{ width }}
      data-ending-style={leaving || undefined}
      aria-labelledby="bd-drw-title"
    >
      <Splitter
        label={t({ id: 'board.task.drawer.resize', defaultMessage: 'Resize drawer' })}
        value={width}
        min={DRAWER.min}
        max={max}
        edge="left"
        onSize={(next) => setLayout({ drawer: Math.min(max, Math.max(DRAWER.min, next)) })}
        onCommit={saveLayout}
        onReset={() => {
          setLayout({ drawer: DRAWER.initial });
          saveLayout();
        }}
      />
      <div className="bd-dh">
        <h2 id="bd-drw-title">{task.title}</h2>
        <button
          ref={close}
          type="button"
          className="ib"
          aria-label={t({ id: 'board.task.drawer.close', defaultMessage: 'Close details' })}
          onClick={() => onSelect(null)}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="bd-dbody">
        <div className="bd-ddet">
          {task.goal.trim() && task.goal.trim() !== task.title.trim() && (
            <p className="bd-goal">{task.goal}</p>
          )}
          <div className="bd-dmeta">
            <TaskStateBadge task={task} />
            <TaskRoute
              task={task}
              className="bd-stc mu"
              models={routeModels?.state === 'ready' ? routeModels.models : []}
            />
            {lane && <span className="mu">{lane.title}</span>}
            {task.started_at !== null && (
              <span className="mu">
                {t(
                  { id: 'board.task.drawer.elapsed', defaultMessage: 'Elapsed {duration}' },
                  { duration: durationText((task.ended_at ?? now) - task.started_at) },
                )}
              </span>
            )}
            {task.token_budget !== undefined ? (
              <span className="bd-dbud">
                <span
                  className="meter"
                  aria-hidden="true"
                  data-over={taskTokens(task) > task.token_budget || undefined}
                  style={
                    {
                      '--v': `${Math.min(100, (taskTokens(task) / task.token_budget) * 100)}%`,
                    } as CSSProperties
                  }
                >
                  <i />
                </span>
                <span className="mono mu">
                  {t(
                    { id: 'board.task.drawer.budget', defaultMessage: '{used} / {budget} tokens' },
                    { used: tokenText(taskTokens(task)), budget: tokenText(task.token_budget) },
                  )}
                </span>
              </span>
            ) : (
              taskTokens(task) > 0 && (
                <span className="mu">{tokenText(taskTokens(task))} tokens</span>
              )
            )}
          </div>
          {badges.length > 0 && (
            <ul className="bd-dbdl">
              {badges.map((badge) => (
                <li key={badge.kind}>
                  <span aria-hidden="true">
                    <TaskBadges badges={[badge]} />
                  </span>
                  <span>{badge.label}</span>
                  {(badge.kind === 'upstream' || badge.kind === 'blocked') && resumes !== null && (
                    <>
                      <span className="mu">{resumesText(resumes, now)}</span>
                      <button
                        type="button"
                        className="bd-lnk"
                        aria-label={t({
                          id: 'board.task.quota.usageLabel',
                          defaultMessage: 'Open usage on the engineering board',
                        })}
                        onClick={() => openBoardTab('usage')}
                      >
                        {t({ id: 'board.sections.usage', defaultMessage: 'Usage' })}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {acceptance.length > 0 && (
            <section className="bd-dsec">
              <h3>{t({ id: 'board.drawer.acceptance', defaultMessage: 'Acceptance' })}</h3>
              <ul className="bd-dl">
                {acceptance.map((check, i) => (
                  <li key={i}>
                    <label className="bd-dck" data-met={check.state === 'passed' || undefined}>
                      <input type="checkbox" checked={check.state === 'passed'} readOnly disabled />
                      <span>{check.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {device && device !== 'local' && (
            <section className="bd-dsec">
              <h3>{t({ id: 'board.task.drawer.device', defaultMessage: 'Device' })}</h3>
              <div className="bd-ddev">
                {placed && <DeviceState device={placed} />}
                <span className="chip mono">{device}</span>
                {placed && <DeviceFacts device={placed} />}
              </div>
              {task.planned?.device_reason && (
                <p className="bd-dwhy">{task.planned.device_reason}</p>
              )}
            </section>
          )}
          {needs.length > 0 && (
            <section className="bd-dsec">
              <h3>{t({ id: 'board.task.drawer.needs', defaultMessage: 'Needs' })}</h3>
              <div className="bd-dtags">
                {needs.map((label) => (
                  <span key={label} className="chip">
                    {placed && (
                      <DeviceDot
                        ok={placed.labels.includes(label)}
                        label={
                          placed.labels.includes(label)
                            ? t({
                                id: 'board.task.drawer.needMet',
                                defaultMessage: 'On the device',
                              })
                            : t({
                                id: 'board.task.drawer.needMissing',
                                defaultMessage: 'Not on the device',
                              })
                        }
                      />
                    )}
                    {label}
                  </span>
                ))}
              </div>
            </section>
          )}
          {uses.length > 0 && (
            <section className="bd-dsec">
              <h3>{t({ id: 'board.task.drawer.uses', defaultMessage: 'Uses' })}</h3>
              <ul className="bd-dl">
                {uses.map(([resource, count]) => (
                  <Fragment key={resource}>
                    <li className="bd-duse">
                      <span className="mono">{resource}</span>
                      <span className="bd-dnum">{count}</span>
                      {placed && resource in placed.resources && (
                        <ResourceMeter device={placed} resource={resource} />
                      )}
                    </li>
                    {placed?.load.active_sessions
                      .filter((s) => placed.load.resource_sessions?.[resource]?.includes(s.id))
                      .map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            className="bd-dbtn bd-docc"
                            onClick={() => onOpenSession(s.id)}
                          >
                            <StatusIcon status="running" />
                            <span className="nm">{s.title}</span>
                            <span className="mu">
                              {t(
                                {
                                  id: 'board.task.drawer.inUse',
                                  defaultMessage: 'In use for {duration}',
                                },
                                { duration: durationText(now - Date.parse(s.started_at)) },
                              )}
                            </span>
                          </button>
                        </li>
                      ))}
                  </Fragment>
                ))}
              </ul>
            </section>
          )}
          {target && tell && (
            <PlanEdit
              model={model}
              task={task}
              target={target}
              lead={tell.sessions.find((s) => s.id === target.leadId)}
              run={tell.run}
              onClose={() => onSelect(null)}
            />
          )}
          {plan && (
            <TaskTimeline
              model={model}
              task={task}
              onOpenSession={onOpenSession}
              onOpenStory={onOpenStory}
            />
          )}
          {task.parallel && task.parallel.length > 0 && (
            <ParallelParts parts={task.parallel} onOpenSession={onOpenSession} />
          )}
          <section className="bd-dsec">
            <h3>
              <span>{t({ id: 'board.task.drawer.segments', defaultMessage: 'Subtasks' })}</span>
              <span>
                {done}/{task.segments.length}
              </span>
            </h3>
            <ul className="bd-dl">
              {task.segments.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="bd-dbtn bd-dseg"
                    disabled={s.session_id === null}
                    onClick={() => s.session_id && onOpenSession(s.session_id)}
                  >
                    <StatusIcon status={s.status} />
                    <span className="bd-stw">{STATUS[s.status].label}</span>
                    <i className="bd-rt" data-rt={s.runtime ?? undefined} />
                    <span className="nm">
                      {s.title}
                      {listSeparator()}
                      {runtimeName(s.runtime)}
                      {listSeparator()}
                      <ModelMark model={s.model} beside={s.runtime} size={14} />
                      {s.model ??
                        t({
                          id: 'board.task.segment.unknownModel',
                          defaultMessage: 'Unknown model',
                        })}
                    </span>
                    {s.additions !== undefined && (
                      <span className="bd-dfx">
                        <DiffCounts additions={s.additions} deletions={s.deletions} />
                      </span>
                    )}
                    {s.started_at !== null && (
                      <span className="bd-dtook">
                        {durationText((s.ended_at ?? now) - s.started_at)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {task.scope.length > 0 && (
            <section className="bd-dsec">
              <h3>{t({ id: 'board.task.drawer.scope', defaultMessage: 'Allowed files' })}</h3>
              <ul className="bd-dl bd-dscope">
                {task.scope.map((path) => (
                  <li key={path}>
                    <PathText path={path} className="mono" />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="bd-dsec">
            <h3>{t({ id: 'board.task.drawer.changes', defaultMessage: 'Changes' })}</h3>
            {task.additions === null ? (
              // Null also means the changes could not be read, which only a task with no session rules out.
              <div className="mu">
                {task.segments.length
                  ? t({ id: 'board.task.drawer.changesUnknown', defaultMessage: 'Unknown' })
                  : t({ id: 'board.task.drawer.noChanges', defaultMessage: 'No changes' })}
              </div>
            ) : (
              <span className="bd-dfx">
                <DiffCounts additions={task.additions} deletions={task.deletions} />
              </span>
            )}
          </section>
          <section className="bd-dsec">
            <h3>{t({ id: 'board.task.drawer.checks', defaultMessage: 'Checks' })}</h3>
            <span className="bd-dchk">
              {check.icon ? (
                <StatusIcon status={check.icon} />
              ) : (
                <span className="mu" aria-hidden="true">
                  —
                </span>
              )}
              <span>{check.label}</span>
            </span>
          </section>
          {!plan && (
            <section className="bd-dsec">
              <h3>{t({ id: 'board.task.drawer.merge', defaultMessage: 'Merge' })}</h3>
              {merges.length === 0 ? (
                <div className="mu">
                  {t({ id: 'board.task.drawer.notMerged', defaultMessage: 'Not merged' })}
                </div>
              ) : (
                merges.map((m) => (
                  <div className="bd-dmg" key={`${m.session_id}-${m.sha}`}>
                    <span>{dayText(m.merged_at, model.now, { time: true })}</span>
                    <span className="sha">
                      {m.from_sha
                        ? `${m.from_sha.slice(0, 7)}..${m.sha.slice(0, 7)}`
                        : m.sha.slice(0, 7)}
                    </span>
                    <span className="bd-dfx">
                      <DiffCounts additions={m.additions} deletions={m.deletions} />
                    </span>
                    {m.story_id && (
                      <button
                        type="button"
                        className="bd-lnk"
                        aria-label={t(
                          {
                            id: 'board.task.story.openLabel',
                            defaultMessage: 'Open change story {title}',
                          },
                          { title: m.title },
                        )}
                        onClick={() => onOpenStory(m.session_id)}
                      >
                        {t({ id: 'board.task.story.open', defaultMessage: 'Change story' })}
                      </button>
                    )}
                  </div>
                ))
              )}
            </section>
          )}
          <section className="bd-dsec">
            <h3>{t({ id: 'board.task.drawer.upstream', defaultMessage: 'Dependencies' })}</h3>
            <TaskLinks
              tasks={ups.filter((up) => up !== undefined)}
              onSelect={onSelect}
              {...(target && {
                remove: {
                  label: (up: Task) =>
                    t(
                      {
                        id: 'board.task.dependency.remove',
                        defaultMessage: 'Remove dependency: {from} to {to}',
                      },
                      { from: up.title, to: task.title },
                    ),
                  onRemove: (up: Task) => relink(withoutDependency(model, up.id, task.id)),
                },
              })}
            />
            {candidates.length > 0 && (
              <Select
                aria-label={t({
                  id: 'board.task.dependency.add',
                  defaultMessage: 'Add dependency',
                })}
                value=""
                onChange={(next) => next && relink(withDependency(model, next, task.id))}
                options={[
                  {
                    value: '',
                    label: t({ id: 'board.task.dependency.add', defaultMessage: 'Add dependency' }),
                  },
                  ...candidates.map((t) => ({ value: t.id, label: t.title })),
                ]}
              />
            )}
          </section>
          <section className="bd-dsec">
            <h3>{t({ id: 'board.task.drawer.downstream', defaultMessage: 'Downstream' })}</h3>
            <TaskLinks tasks={downs.filter((down) => down !== undefined)} onSelect={onSelect} />
          </section>
        </div>
        {leadId && (
          <div className="bd-dplan">
            <PlanList
              model={model}
              leadId={leadId}
              currentId={task.id}
              onSelect={onSelect}
              {...(target && { projectId: target.projectId })}
            />
            {tell && (
              <TellLeadBox
                key={task.id}
                lead={tell.sessions.find((s) => s.id === leadId)}
                taskId={task.id}
                draft={tellLeadDraft('task', task.title, task.id)}
                run={tell.run}
              />
            )}
          </div>
        )}
      </div>
      {(approvalIn ||
        questionKey ||
        redo.length > 0 ||
        reassign ||
        stoppable ||
        start ||
        handBack) && (
        <div className="bd-dstart">
          {approvalIn && waiting && (
            <button
              type="button"
              className="btn pri bd-dgo"
              onClick={() => {
                focusRequest(waiting.approval_id);
                onOpenSession(approvalIn);
              }}
            >
              {t({ id: 'board.drawer.approve', defaultMessage: 'Go to approval' })}
            </button>
          )}
          {question && questionKey && (
            <button
              type="button"
              className="btn pri bd-dgo"
              onClick={() => useShell.getState().openProjectNeed(question.project_id, questionKey)}
            >
              {t({ id: 'board.drawer.answer', defaultMessage: 'Answer the question' })}
            </button>
          )}
          {worker && tell && redo.length > 0 && (
            <Redo session={worker} choices={redo} run={tell.run} />
          )}
          {start && (
            <button
              type="button"
              className="btn"
              aria-label={t(
                {
                  id: 'board.task.drawer.startLabel',
                  defaultMessage: 'Start a session for {title}',
                },
                { title: task.title },
              )}
              onClick={() => onStartTask?.(task)}
            >
              {t({ id: 'board.task.drawer.start', defaultMessage: 'Start a session' })}
            </button>
          )}
          {tell && handBack && <HandBack task={task} run={tell.run} />}
          {tell && reassign && (
            <TellLead
              lead={tell.sessions.find((s) => s.id === reassign.leadId)}
              draft={tellLeadDraft('task', task.title, task.id)}
              label={task.title}
              run={tell.run}
              text={t({
                id: 'board.task.drawer.reassign',
                defaultMessage: 'Have the lead reassign',
              })}
            />
          )}
          {tell && stoppable && <CancelTask target={stoppable} run={tell.run} />}
        </div>
      )}
    </aside>
  );
}
