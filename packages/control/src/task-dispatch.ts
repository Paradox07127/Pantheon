import {
  DomainError,
  requireThat,
  type BoardPlan,
  type FlowPath,
  type NeedsYouItem,
  type Principal,
  type Project,
  type RuntimeChoice,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import { inputSchemas, type DeviceListItem, type DeviceStatus } from '@pantheon/protocol';
import {
  projectAccess,
  userOnly,
  sessionAdapter,
  type ControlContext,
  type Handlers,
} from './context.js';
import { admitWriterChoice, runtime } from './admission.js';
import { projectRoutingTable } from './routing-table.js';
import {
  awaitingChange,
  boardTask,
  boardTaskId,
  currentAcceptance,
  currentBinding,
  currentDirectMerge,
  ownEntry,
  planUnfinished,
  retiredBinding,
  taskGeneration,
  taskSessions,
  taskState,
} from './board-plan.js';
import {
  checkPermissionMode,
  openWorktreeSession,
  stopWorktreeSession,
} from './workbench-session.js';
import { appendNote, recordNote } from './lead-inbox.js';
import { interruptSession, stopBackground } from './session.js';
import { queueTurn } from './task-tracking.js';
import { backgroundTasks, nextDepth } from './progress.js';
import { runningPlanReview } from './review.js';
import { projectOverBudget, workflowPolicy } from './workflow-policy.js';
import { slotWait, startSlot, taskWorkflow } from './workflow-engine.js';
import { listDevices } from './devices.js';
import { homeRuntime, readUserConfig, sessionDefaults } from './user-config.js';

/** Task sessions that may be under way in the project at a time, by its workflow policy. */
export function taskPlaces(ctx: ControlContext, projectId: string): number {
  return workflowPolicy(ctx, projectId).max_parallel;
}

type PlanTask = BoardPlan['tasks'][number];
export type DispatchWait =
  | 'upstream'
  | 'scope'
  | 'plan_review'
  | 'step'
  | 'retry'
  | 'budget'
  | 'capacity'
  | 'runtime_limited'
  | 'runtime_capacity'
  | 'device_offline'
  | 'device_capacity'
  | 'device_resource'
  | 'paused'
  | 'answer'
  | 'approval';

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 } as const;
const priorityOrder = (task: PlanTask) => PRIORITY_ORDER[task.priority ?? 'normal'];

/** When a task whose session failed to open may try again: 30 seconds, doubling, at most 10 minutes. */
const retryAt = (error: { at: number; attempts: number }) =>
  error.at + Math.min(30_000 * 2 ** (error.attempts - 1), 10 * 60_000);

export const segments = (target: string) =>
  target.split('/').filter((segment) => segment && segment !== '.');
/** True when one path equals the other or contains it, compared by path segment. */
export function overlaps(a: string, b: string): boolean {
  const left = segments(a),
    right = segments(b);
  return left
    .slice(0, Math.min(left.length, right.length))
    .every((segment, index) => segment === right[index]);
}

function taskChoice(ctx: ControlContext, plan: BoardPlan, task: PlanTask): RuntimeChoice {
  const defaults = sessionDefaults(ctx, ctx.store.must<Project>('projects', plan.project_id));
  const selected =
    defaults?.writer ??
    (task.kind
      ? projectRoutingTable(ctx, plan.project_id).cells.find(
          (cell) => cell.domain === task.kind!.domain && cell.tier === task.kind!.tier,
        )?.first
      : undefined) ??
    defaults;
  const choice: RuntimeChoice = {
    runtime:
      task.runtime ?? selected?.runtime ?? ctx.store.must<Session>('sessions', plan.id).runtime,
    model:
      task.model ??
      (task.runtime === undefined || task.runtime === selected?.runtime
        ? selected?.model
        : undefined),
    effort:
      task.effort ??
      (task.runtime === undefined || task.runtime === selected?.runtime
        ? selected?.effort
        : undefined),
  };
  const fallback = defaults?.fallbacks?.writer;
  if (
    task.runtime === undefined &&
    fallback &&
    ctx.runtimeStatus
      .get(choice.runtime)
      ?.quota?.windows.some(
        (window) =>
          window.used_percent >= workflowPolicy(ctx, plan.project_id).runtime_quota_threshold &&
          (window.resets_at === undefined || ctx.store.now() < window.resets_at),
      )
  )
    return fallback;
  // The runtime the later writer admission opens the session on.
  if (fallback && !admitted(ctx, choice.runtime) && admitted(ctx, fallback.runtime))
    return fallback;
  return choice;
}

function admitted(ctx: ControlContext, name: string): boolean {
  try {
    runtime(ctx, name, 'writer');
    return true;
  } catch (error) {
    if (error instanceof DomainError && error.code === 'unsupported_capability') return false;
    throw error;
  }
}

/** The named resources the device has too little of left for `count` sessions of the task. */
function shortResources(
  task: PlanTask,
  load: Pick<DeviceListItem['load'], 'uses'>,
  device: DeviceStatus | undefined,
  count: number,
): string[] {
  return Object.entries(task.uses ?? {})
    .filter(
      ([name, amount]) =>
        (ownEntry(load.uses, name) ?? 0) + amount * count >
        (ownEntry(device?.resources, name) ?? 0),
    )
    .map(([name]) => name);
}

export function taskRuntime(ctx: ControlContext, plan: BoardPlan, task: PlanTask): string {
  return taskChoice(ctx, plan, task).runtime;
}

/** The rows placedTaskSessions reads, for a caller that asks of several projects without writing between. */
export function placementRows(ctx: ControlContext) {
  return {
    plans: ctx.store.list<BoardPlan>('board_plans'),
    // The sessions with a queued or running turn.
    busy: new Set(
      (
        ctx.store.db
          .prepare(
            "SELECT json_extract(data,'$.session_id') AS id FROM session_turns WHERE json_extract(data,'$.state') IN ('queued','running')",
          )
          .all() as { id: string }[]
      ).map((row) => row.id),
    ),
    sessions: ctx.store.list<Session>('sessions'),
  };
}

/** The project's task sessions that hold one of its taskPlaces. */
export function placedTaskSessions(
  ctx: ControlContext,
  projectId: string,
  { plans: stored, busy, sessions } = placementRows(ctx),
): Session[] {
  const plans = stored.filter((plan) => plan.project_id === projectId);
  const leadPlan = (session: Session) =>
    plans.find((plan) => plan.id === session.task!.lead_session_id);
  // An accepted report task holds neither a place nor its scope while its session has no turn to run.
  return sessions.filter(
    (session) =>
      session.project_id === projectId &&
      session.workspace_id &&
      session.task &&
      !session.outcome &&
      session.state !== 'closed' &&
      !(session.merge?.reason === 'workflow_approval' && !busy.has(session.id)) &&
      !(
        currentBinding(leadPlan(session), session.task) &&
        currentAcceptance(leadPlan(session), session.task.id) &&
        !busy.has(session.id)
      ),
  );
}

/** The task sessions holding a place on each device, of every project, and the resources unfinished tasks use there. */
export function deviceLoads(
  ctx: ControlContext,
  rows = placementRows(ctx),
): Map<string, Pick<DeviceListItem['load'], 'sessions' | 'uses' | 'resource_sessions'>> {
  const loads = new Map<
      string,
      Pick<DeviceListItem['load'], 'sessions' | 'uses' | 'resource_sessions'>
    >(),
    placed = new Map<string, Set<string>>(),
    byTask = new Map<string, Session[]>();
  for (const session of rows.sessions) {
    if (!session.task) continue;
    const key = boardTaskId(session.task.lead_session_id, session.task.id),
      own = byTask.get(key);
    if (own) own.push(session);
    else byTask.set(key, [session]);
  }
  for (const plan of rows.plans) {
    if (!placed.has(plan.project_id))
      placed.set(
        plan.project_id,
        new Set(placedTaskSessions(ctx, plan.project_id, rows).map((session) => session.id)),
      );
    for (const task of plan.tasks)
      for (const session of taskSessions(
        ctx,
        plan.id,
        task.id,
        byTask.get(boardTaskId(plan.id, task.id)) ?? [],
        plan,
      )) {
        const running = placed.get(plan.project_id)!.has(session.id);
        // A session that waits for an approval before its merge runs nothing, yet its task is not over.
        const approval =
          !session.outcome &&
          session.state !== 'closed' &&
          session.merge?.reason === 'workflow_approval';
        if (!running && !approval) continue;
        const deviceId = session.device_id ?? 'local',
          load: Pick<DeviceListItem['load'], 'sessions' | 'uses' | 'resource_sessions'> = loads.get(
            deviceId,
          ) ?? { sessions: 0, uses: Object.create(null) as Record<string, number> };
        if (running) load.sessions++;
        // Resource names such as `constructor` or `__proto__` are plain keys of these records.
        for (const [name, amount] of Object.entries(task.uses ?? {})) {
          load.uses[name] = (load.uses[name] ?? 0) + amount;
          ((load.resource_sessions ??= Object.create(null) as Record<string, string[]>)[name] ??=
            []).push(session.id);
        }
        loads.set(deviceId, load);
      }
  }
  return loads;
}

/** The flow path the task takes: its own, else the workflow policy's for its tier, else dispatch. */
export function taskPath(ctx: ControlContext, projectId: string, task: PlanTask): FlowPath {
  // The lead's direct task ends with its merge, and a report task has no commits to merge.
  if (task.done_when === 'report') return 'dispatch';
  const path =
    task.path ?? (task.kind && workflowPolicy(ctx, projectId).path[task.kind.tier]) ?? 'dispatch';
  // The lead works in its own worktree, so it cannot do a task that names another device.
  return path === 'direct' && task.device !== undefined && task.device !== 'local'
    ? 'dispatch'
    : path;
}

/** The scopes the project's placed task sessions and the direct tasks of its leads hold, by task id. */
function heldScopes(
  ctx: ControlContext,
  projectId: string,
  rows = placementRows(ctx),
): { task_id: string; scope: string[] }[] {
  const plans = rows.plans.filter((plan) => plan.project_id === projectId);
  const leadPlan = (session: Session) =>
    plans.find((plan) => plan.id === session.task!.lead_session_id);
  // A removed task's session holds its place, but the scope its id names now is another task's.
  // A session yet to take its changed contract works in a scope the plan may no longer name, so it holds every path.
  const holders = new Map(
    [
      ...placedTaskSessions(ctx, projectId, rows),
      ...rows.sessions.filter(
        (s) =>
          s.project_id === projectId &&
          s.task &&
          !s.outcome &&
          s.state !== 'closed' &&
          s.merge?.reason === 'workflow_approval',
      ),
    ].map((s) => [s.id, s]),
  );
  const placed = [...holders.values()].map((session) => ({
    task_id: session.task!.id,
    scope: retiredBinding(leadPlan(session), session)
      ? []
      : awaitingChange(leadPlan(session), session)
        ? ['.']
        : (leadPlan(session)?.tasks.find((task) => task.id === session.task!.id)?.scope ?? []),
  }));
  const claimed = rows.sessions
    .filter(
      (session) =>
        session.project_id === projectId &&
        session.direct_task &&
        !session.outcome &&
        session.state !== 'closed',
    )
    .map((session) => ({
      task_id: session.direct_task!.id,
      scope:
        plans
          .find((plan) => plan.id === session.id)
          ?.tasks.find((task) => task.id === session.direct_task!.id)?.scope ?? [],
    }));
  return [...placed, ...claimed];
}

/** What keeps the task from opening now: its upstream tasks not done, else the held scopes that overlap its own. */
function taskWaits(
  ctx: ControlContext,
  plan: BoardPlan,
  task: PlanTask,
  held = heldScopes(ctx, plan.project_id),
): { wait: 'upstream' | 'scope' | 'answer'; task_ids: string[] } | undefined {
  if (plan.questions?.some((question) => !question.answer && question.blocks.includes(task.id)))
    return { wait: 'answer', task_ids: [] };
  const upstream = task.depends_on.filter(
    (id) => taskState(plan, id, taskSessions(ctx, plan.id, id)) !== 'done',
  );
  if (upstream.length) return { wait: 'upstream', task_ids: upstream };
  const holders = held
    .filter((each) => each.scope.some((a) => task.scope.some((b) => overlaps(a, b))))
    .map((each) => each.task_id);
  if (holders.length) return { wait: 'scope', task_ids: holders };
}

/**
 * The project's requested tasks without a session, higher priority first and then oldest request
 * first, each with what it waits for; a task without a wait opens on the next tick, taking its
 * place before the tasks after it.
 */
export function dispatchQueue(
  ctx: ControlContext,
  projectId: string,
): { plan: BoardPlan; task: PlanTask; wait?: DispatchWait }[] {
  const rows = placementRows(ctx),
    plans = rows.plans.filter((plan) => plan.project_id === projectId);
  const queued = plans
    .flatMap((plan) =>
      plan.tasks
        .filter(
          (task) =>
            ownEntry(plan.dispatch, task.id) &&
            !taskSessions(ctx, plan.id, task.id, rows.sessions, plan).length,
        )
        .map((task) => ({ plan, task, at: ownEntry(plan.dispatch, task.id)!.requested_at })),
    )
    .sort((a, b) => priorityOrder(a.task) - priorityOrder(b.task) || a.at - b.at);
  if (!queued.length) return [];
  // A lead's direct task holds its scope but no place.
  const held = heldScopes(ctx, projectId, rows);
  const placed = placedTaskSessions(ctx, projectId, rows),
    byRuntime = new Map<string, number>();
  for (const session of placed)
    byRuntime.set(session.runtime, (byRuntime.get(session.runtime) ?? 0) + 1);
  let running = placed.length;
  const places = taskPlaces(ctx, projectId),
    overBudget = projectOverBudget(ctx, projectId),
    policy = workflowPolicy(ctx, projectId),
    quotaThreshold = policy.runtime_quota_threshold;
  const loads = deviceLoads(ctx, rows),
    devices = listDevices(ctx),
    localLimit = readUserConfig(ctx.userConfigDir).local_device?.max_sessions;
  return queued.map(({ plan, task }) => {
    const count = taskPath(ctx, projectId, task) === 'parallel' ? task.parallel!.length : 1;
    const error = ownEntry(plan.dispatch, task.id)!.error,
      runtimeId = taskRuntime(ctx, plan, task),
      runtimeLimit = ownEntry(policy.runtime_parallel, runtimeId);
    const deviceId = task.device ?? 'local',
      device = devices.find((entry) => entry.id === deviceId),
      load = loads.get(deviceId) ?? {
        sessions: 0,
        uses: Object.create(null) as Record<string, number>,
      },
      sessionLimit = deviceId === 'local' ? localLimit : device?.max_sessions;
    const wait: DispatchWait | undefined =
      (policy.dispatch_paused ? 'paused' : undefined) ??
      (ctx.store.get<Session>('sessions', plan.id)?.external_hold ? 'approval' : undefined) ??
      taskWaits(ctx, plan, task, held)?.wait ??
      (task.kind &&
      taskWorkflow(ctx, plan, task.id).definition.plan_review.tiers.includes(task.kind.tier) &&
      runningPlanReview(ctx, plan, task.id)
        ? 'plan_review'
        : undefined) ??
      (slotWait(ctx, plan, task, 'before_dispatch') ? 'step' : undefined) ??
      (ctx.runtimeStatus
        .get(runtimeId)
        ?.quota?.windows.some(
          (window) =>
            window.used_percent >= quotaThreshold &&
            (window.resets_at === undefined || ctx.store.now() < window.resets_at),
        )
        ? 'runtime_limited'
        : undefined) ??
      (runtimeLimit !== undefined && (byRuntime.get(runtimeId) ?? 0) + count > runtimeLimit
        ? 'runtime_capacity'
        : undefined) ??
      (deviceId !== 'local' && !device?.online
        ? 'device_offline'
        : sessionLimit !== undefined && load.sessions + count > sessionLimit
          ? 'device_capacity'
          : shortResources(task, load, device, count).length
            ? 'device_resource'
            : undefined) ??
      (error && ctx.store.now() < retryAt(error)
        ? 'retry'
        : overBudget
          ? 'budget'
          : running + count > places
            ? 'capacity'
            : undefined);
    if (!wait) {
      held.push({ task_id: task.id, scope: task.scope });
      running += count;
      byRuntime.set(runtimeId, (byRuntime.get(runtimeId) ?? 0) + count);
      load.sessions += count;
      for (const [name, amount] of Object.entries(task.uses ?? {}))
        load.uses[name] = (load.uses[name] ?? 0) + amount * count;
      loads.set(deviceId, load);
    }
    return { plan, task, ...(wait ? { wait } : {}) };
  });
}

/** The task's sessions under its lead, oldest first, without those of a removed task under its id. */
function earlierSessions(ctx: ControlContext, plan: BoardPlan, taskId: string): Session[] {
  return ctx.store
    .list<Session>('sessions')
    .filter(
      (session) =>
        session.workspace_id &&
        session.task?.lead_session_id === plan.id &&
        session.task.id === taskId &&
        (session.task.generation ?? 1) > (ownEntry(plan.retired, taskId) ?? 0),
    );
}

/** How the session ended: who stopped it and why, and the reason it was last handed back. */
function endedText(plan: BoardPlan, session: Session): string {
  const stop = session.stop_requested,
    handedBack = ownEntry(plan.handed_back, session.id)?.at(-1);
  return [
    stop
      ? `was stopped by the ${stop.by}: ${stop.reason}`
      : session.outcome
        ? `ended ${session.outcome}`
        : `is ${session.state}`,
    ...(handedBack ? [`it was last handed back for ${handedBack}`] : []),
  ].join('; ');
}

/** Stops each open session whose task id left its lead's plan, as task.stop does, and tells the lead. */
function stopRemovedTasks(ctx: ControlContext): void {
  // The stored plans by id, read again after a stop writes.
  let plans: Map<string, BoardPlan> | undefined;
  for (const session of ctx.store.list<Session>('sessions')) {
    plans ??= new Map(ctx.store.list<BoardPlan>('board_plans').map((plan) => [plan.id, plan]));
    const plan = session.task && plans.get(session.task.lead_session_id);
    // The stop it is given marks it, so a session is stopped once; a running merge records its own result first.
    if (
      !plan ||
      !session.workspace_id ||
      session.outcome ||
      session.state === 'closed' ||
      session.stop_requested ||
      session.merge?.state === 'running' ||
      plan.tasks.some((task) => task.id === session.task!.id)
    )
      continue;
    plans = undefined;
    const reason = 'The task left the plan';
    ctx.store.event(
      'task.stop_requested',
      plan,
      plan.project_id,
      { task_id: session.task!.id, reason },
      '',
    );
    stopWorktreeSession(ctx, session, { reason, by: 'lead' }, '');
    appendNote(ctx, ctx.store.must<BoardPlan>('board_plans', plan.id), {
      at: ctx.store.now(),
      session_id: session.id,
      task_id: session.task!.id,
      kind: 'discarded',
      text: `Task ${session.task!.id} left the plan, so Pantheon stopped and discards its session ${session.id}.`,
    });
  }
}

/** What keeps the upstream task from getting done unless someone acts, or undefined while it may. */
export function stuckUpstream(
  ctx: ControlContext,
  plan: BoardPlan,
  upstreamId: string,
): { stuck: NonNullable<NeedsYouItem['upstream']>['stuck']; text: string } | undefined {
  if (ownEntry(plan.dispatch, upstreamId)) return;
  const sessions = taskSessions(ctx, plan.id, upstreamId);
  const state = taskState(plan, upstreamId, sessions, ctx.store.get<Session>('sessions', plan.id));
  // Active without a task session is the direct task the lead works on itself.
  if (state === 'done' || (state === 'active' && !sessions.length)) return;
  // The state the tracker last told the lead of.
  const blocked = sessions.find((session) => ownEntry(plan.notified, session.id) === 'blocked');
  if (blocked)
    return {
      stuck: 'merge_blocked',
      text: `whose session ${blocked.id} is blocked${blocked.merge?.reason ? `: ${blocked.merge.reason}` : ''}`,
    };
  if (sessions.some((session) => !session.stop_requested)) return;
  const last = earlierSessions(ctx, plan, upstreamId).at(-1);
  return last
    ? {
        stuck: 'stopped',
        text: `whose session ${last.id} ${endedText(plan, last)}, and it has no new start request`,
      }
    : { stuck: 'never_started', text: 'which was never started' };
}

/** Tells the lead of each upstream task that keeps the queued task waiting, once for each state of it. */
function tellStuckUpstream(ctx: ControlContext, planId: string, task: PlanTask): void {
  const plan = ctx.store.must<BoardPlan>('board_plans', planId);
  const texts = task.depends_on.flatMap((upstreamId) => {
    const stuck = stuckUpstream(ctx, plan, upstreamId);
    return stuck
      ? [
          `Task ${task.id} waits for its upstream task ${upstreamId}, ${stuck.text}. Start ${upstreamId} with start_task, change the dependencies of ${task.id}, or stop ${task.id}.`,
        ]
      : [];
  });
  if (!texts.length) return;
  const told = new Set(
    (
      ctx.store.db
        .prepare("SELECT payload FROM events WHERE aggregate_id=? AND kind='lead.note_added'")
        .all(plan.id) as { payload: string }[]
    )
      .map((row) => JSON.parse(row.payload) as { task_id: string; text: string })
      .filter((note) => note.task_id === task.id)
      .map((note) => note.text),
  );
  for (const text of texts) {
    if (told.has(text)) continue;
    appendNote(ctx, ctx.store.must<BoardPlan>('board_plans', plan.id), {
      at: ctx.store.now(),
      session_id: '',
      task_id: task.id,
      kind: 'blocked',
      text,
    });
  }
}

// Only transitions are written. On restart the first observation reestablishes the wait reason.
const dispatchObservations = new WeakMap<ControlContext, Map<string, string>>();

/** Opens the sessions of requested tasks that wait for nothing; a task that has a session loses its request. */
export function dispatchTasks(ctx: ControlContext): void {
  stopRemovedTasks(ctx);
  const plans = ctx.store
    .list<BoardPlan>('board_plans')
    .filter((plan) => Object.keys(plan.dispatch ?? {}).length);
  for (const plan of plans) {
    const dispatch = Object.fromEntries(
      Object.entries(plan.dispatch!).filter(
        ([taskId]) => !taskSessions(ctx, plan.id, taskId).length,
      ),
    );
    if (Object.keys(dispatch).length !== Object.keys(plan.dispatch!).length)
      ctx.store.update('board_plans', { ...plan, dispatch }, plan.revision);
  }
  const previous = dispatchObservations.get(ctx);
  const observations = new Map<string, string>();
  for (const projectId of new Set(plans.map((plan) => plan.project_id)))
    for (const { plan, task, wait } of dispatchQueue(ctx, projectId)) {
      if (wait) {
        const requested_at = ownEntry(plan.dispatch, task.id)!.requested_at;
        const key = JSON.stringify([plan.id, task.id, requested_at]);
        observations.set(key, wait);
        if (previous?.get(key) !== wait)
          ctx.store.event('task.dispatch_wait_changed', plan, projectId, {
            task_id: task.id,
            wait,
            requested_at,
          });
      }
      if (wait === 'upstream') tellStuckUpstream(ctx, plan.id, task);
      if (wait) continue;
      const earlier = earlierSessions(ctx, plan, task.id).at(-1);
      let sessions: Session[];
      try {
        const choice = taskChoice(ctx, plan, task);
        const parts = taskPath(ctx, projectId, task) === 'parallel' ? task.parallel! : [task];
        sessions = parts.map((part, index) => {
          const session = openWorktreeSession(
            ctx,
            {
              project_id: projectId,
              ...choice,
              permission_mode:
                ownEntry(plan.dispatch, task.id)!.permission_mode ??
                sessionDefaults(ctx, ctx.store.must<Project>('projects', projectId))
                  ?.permission_mode ??
                'ask',
              // The same first message as a session the user opens from the board task.
              input: `${part.title}\n\n${part.goal}${earlier ? `\n\n[Pantheon] The earlier session of this task ${endedText(plan, earlier)}.` : ''}`,
              task_id: boardTaskId(plan.id, task.id),
              device_id: task.device,
            },
            '',
            undefined,
            { role: ownEntry(plan.dispatch, task.id)!.permission_mode ? 'user' : 'lead' },
          );
          return parts.length === 1
            ? session
            : ctx.store.update(
                'sessions',
                {
                  ...session,
                  title: part.title,
                  task: { ...session.task!, parallel_index: index },
                },
                session.revision,
              );
        });
      } catch (error) {
        // A runtime that is no longer available leaves the task queued until a later try.
        if (!(error instanceof DomainError)) throw error;
        const current = ctx.store.must<BoardPlan>('board_plans', plan.id),
          entry = ownEntry(current.dispatch, task.id)!,
          failure = {
            code: error.code,
            message: error.message,
            at: ctx.store.now(),
            attempts: (entry.error?.attempts ?? 0) + 1,
          };
        const failed = ctx.store.update(
          'board_plans',
          {
            ...current,
            dispatch: { ...current.dispatch, [task.id]: { ...entry, error: failure } },
            // The lead hears of the first failure only; the retries keep the entry current.
            inbox:
              failure.attempts === 1
                ? [
                    ...current.inbox,
                    recordNote(ctx, current, {
                      at: failure.at,
                      session_id: '',
                      task_id: task.id,
                      kind: 'dispatch_failed' as const,
                      text: `The session of the task could not open (${error.code}): ${error.message}. Pantheon tries again with a growing backoff; change the task's runtime or tell the user.`,
                    }),
                  ]
                : current.inbox,
          },
          current.revision,
        );
        ctx.store.event('task.dispatch_failed', failed, projectId, { task_id: task.id }, '');
        continue;
      }
      for (let session of sessions) {
        session = ctx.store.update(
          'sessions',
          { ...session, task: { ...session.task!, generation: taskGeneration(plan, task.id) } },
          session.revision,
        );
        // The first turn follows from the lead turn that asked for the task to start.
        const opened = ctx.store
          .list<SessionTurn>('session_turns')
          .find((turn) => turn.session_id === session.id)!;
        ctx.store.update(
          'session_turns',
          {
            ...opened,
            causal_depth:
              ownEntry(plan.dispatch, task.id)!.causal_depth ??
              nextDepth(ctx, plan.id, session.task),
          },
          opened.revision,
        );
      }
      const current = ctx.store.must<BoardPlan>('board_plans', plan.id);
      const next = ctx.store.update(
        'board_plans',
        {
          ...current,
          dispatch: Object.fromEntries(
            Object.entries(current.dispatch ?? {}).filter(([taskId]) => taskId !== task.id),
          ),
        },
        current.revision,
      );
      ctx.store.event(
        'task.dispatched',
        next,
        projectId,
        {
          task_id: task.id,
          session_id: sessions[0]!.id,
          ...(sessions.length > 1 ? { session_ids: sessions.map((session) => session.id) } : {}),
        },
        '',
      );
    }
  dispatchObservations.set(ctx, observations);
}

export function userTaskChoice(
  ctx: ControlContext,
  input: ReturnType<(typeof inputSchemas)['session.create']['parse']>,
): RuntimeChoice {
  const { plan, task } = boardTask(ctx, input.project_id, input.task_id!);
  const families = readUserConfig(ctx.userConfigDir).model_families;
  const chosen =
    input.runtime ??
    (input.model === undefined ? undefined : homeRuntime(input.model, families)) ??
    task.runtime;
  // The task's model and effort go with the runtime they were chosen for.
  const taskHome =
    task.runtime ?? (task.model === undefined ? undefined : homeRuntime(task.model, families));
  const own = taskHome === undefined || chosen === undefined || chosen === taskHome;
  return taskChoice(ctx, plan, {
    ...task,
    runtime: chosen,
    model: input.model ?? (own ? task.model : undefined),
    effort: input.effort ?? (own ? task.effort : undefined),
  });
}

/**
 * Opens the session the user asks for on a board task, by the checks dispatch makes but the places;
 * the lead hears of it. A task whose sessions all merged takes another, for work that follows up.
 */
export function openUserTaskSession(
  ctx: ControlContext,
  input: ReturnType<(typeof inputSchemas)['session.create']['parse']>,
  cause: string,
): Session {
  const { plan, task } = boardTask(ctx, input.project_id, input.task_id!);
  const unfinished = taskSessions(ctx, plan.id, task.id).filter((session) => !session.outcome),
    lead = ctx.store.get<Session>('sessions', plan.id);
  requireThat(
    !unfinished.length,
    'invalid_state',
    `Task ${task.id} already has the unfinished session ${unfinished.map((session) => session.id).join(', ')}; merge or discard it before opening another`,
  );
  requireThat(
    !(
      lead?.direct_task?.id === task.id &&
      lead.direct_task.generation === taskGeneration(plan, task.id)
    ),
    'invalid_state',
    `Task ${task.id} is a direct task its lead ${plan.id} works on itself`,
  );
  const waits = taskWaits(ctx, plan, task);
  requireThat(
    waits?.wait !== 'answer',
    'invalid_state',
    `Task ${task.id} waits for a question to be answered`,
  );
  requireThat(
    waits?.wait !== 'upstream',
    'invalid_state',
    `Task ${task.id} depends on unfinished tasks ${waits?.task_ids.join(', ')}; open it after they are done`,
  );
  requireThat(
    !waits,
    'invalid_state',
    `The scope of task ${task.id} overlaps tasks ${waits?.task_ids.join(', ')}, which are under way; open it after they end`,
  );
  const step = slotWait(ctx, plan, task, 'before_dispatch');
  requireThat(
    !step,
    'invalid_state',
    `Task ${task.id} waits for workflow step ${step?.title}; start it through task.start first`,
  );
  const choice = userTaskChoice(ctx, input);
  const deviceId = input.device_id ?? task.device ?? 'local';
  const short = shortResources(
    task,
    deviceLoads(ctx).get(deviceId) ?? { uses: {} },
    listDevices(ctx).find((entry) => entry.id === deviceId),
    1,
  );
  requireThat(
    !short.length,
    'invalid_state',
    `Device ${deviceId} has too little ${short.join(', ')} free for task ${task.id}; open it after the tasks using it end`,
  );
  const session = openWorktreeSession(
    ctx,
    { ...input, ...choice, device_id: input.device_id ?? task.device },
    cause,
  );
  const current = ctx.store.must<BoardPlan>('board_plans', plan.id);
  // Else dispatch would open another session for the request.
  const next = ownEntry(current.dispatch, task.id)
    ? ctx.store.update(
        'board_plans',
        {
          ...current,
          dispatch: Object.fromEntries(
            Object.entries(current.dispatch!).filter(([taskId]) => taskId !== task.id),
          ),
        },
        current.revision,
      )
    : current;
  appendNote(
    ctx,
    next,
    {
      at: ctx.store.now(),
      session_id: '',
      task_id: task.id,
      kind: 'user_edit',
      text: `The user opened the session ${session.id} for task ${task.id} from the board; it works on the task now.`,
    },
    cause,
  );
  return session;
}

/** The calling lead's own plan, or for the user the plan of the lead it names. */
function actingPlan(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  leadId: string | undefined,
): BoardPlan {
  if (p.role === 'user') {
    userOnly(p);
    requireThat(leadId, 'permission_denied', 'Name the lead whose plan holds the task');
    const plan = ctx.store.get<BoardPlan>('board_plans', leadId);
    requireThat(
      plan && plan.project_id === projectId,
      'not_found',
      `Not found: board plan ${leadId}`,
    );
    return plan;
  }
  requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
  const plan = ctx.store.get<BoardPlan>('board_plans', p.session_id!);
  requireThat(plan, 'not_found', 'Write a plan with update_board first');
  return plan;
}

/** Sets whether the lead's running turn may write; a turn that starts later takes its flag then. */
function setLeadTurnReadOnly(ctx: ControlContext, leadId: string, readOnly: boolean): void {
  const handle = [...ctx.handles.values()].find((h) => h.platform_session_id === leadId);
  if (!handle) return;
  const adapter = sessionAdapter(ctx, ctx.store.must<Session>('sessions', leadId));
  let rolledBack = false;
  ctx.rollback?.push(() => (rolledBack = true));
  queueMicrotask(() => {
    if (!rolledBack) adapter?.setTurnReadOnly?.(handle, readOnly);
  });
}

/**
 * Takes write access from the lead's running turn once its direct task is released. A runtime that
 * fixes a turn's permissions when it starts keeps a writable turn so, so that turn is interrupted.
 */
export function revokeLeadTurnWrites(ctx: ControlContext, leadId: string, cause: string): void {
  setLeadTurnReadOnly(ctx, leadId, true);
  const adapter = sessionAdapter(ctx, ctx.store.must<Session>('sessions', leadId));
  if (
    adapter?.report.capabilities.turn_write_unlock?.status === 'supported' ||
    !ctx.store
      .list<SessionTurn>('session_turns')
      .some((turn) => turn.session_id === leadId && turn.state === 'running' && !turn.read_only)
  )
    return;
  let rolledBack = false;
  ctx.rollback?.push(() => (rolledBack = true));
  queueMicrotask(() => {
    if (rolledBack) return;
    try {
      ctx.store.transaction(() =>
        interruptSession(ctx, ctx.store.must<Session>('sessions', leadId), 'lead', cause),
      );
    } catch {
      // The turn ended first, or the runtime cannot interrupt one.
      return;
    }
    ctx.changed();
  });
}

/** The lead takes the direct task to work on itself in its own worktree, one at a time. */
function claimDirectTask(
  ctx: ControlContext,
  plan: BoardPlan,
  taskIds: string[],
  commandId: string,
):
  | { claimed: string; generation: number; note?: string }
  | { wait: 'step'; step: NonNullable<ReturnType<typeof slotWait>> } {
  requireThat(
    !workflowPolicy(ctx, plan.project_id).dispatch_paused,
    'resource_busy',
    'Task dispatch is paused',
  );
  requireThat(
    taskIds.length === 1,
    'invalid_input',
    'A direct task is one you work on yourself; start it on its own, without other tasks',
  );
  const task = plan.tasks.find((candidate) => candidate.id === taskIds[0])!;
  requireThat(
    !plan.questions?.some((question) => !question.answer && question.blocks.includes(task.id)),
    'invalid_state',
    `Task ${task.id} waits for a question to be answered`,
  );
  const lead = ctx.store.must<Session>('sessions', plan.id);
  requireThat(
    !lead.external_hold,
    'invalid_state',
    'This request waits for the user to approve it; you can start a task once the user approves',
  );
  requireThat(
    !lead.direct_task,
    'invalid_state',
    `You already work on task ${lead.direct_task?.id}; it stays yours until it merges or you stop it with stop_task`,
  );
  requireThat(
    !taskSessions(ctx, plan.id, task.id).length,
    'invalid_state',
    `Task ${task.id} already has a session`,
  );
  requireThat(
    !currentDirectMerge(plan, task.id),
    'invalid_state',
    `Task ${task.id} is done: you merged it`,
  );
  const review =
    task.kind &&
    taskWorkflow(ctx, plan, task.id).definition.plan_review.tiers.includes(task.kind.tier)
      ? runningPlanReview(ctx, plan, task.id)
      : undefined;
  requireThat(
    !review,
    'invalid_state',
    `Task ${task.id} waits for the plan review ${review?.id}; start it once the review ends`,
  );
  startSlot(ctx, plan, task, 'before_dispatch');
  const step = slotWait(ctx, plan, task, 'before_dispatch');
  if (step) {
    startSlot(ctx, plan, task, 'before_dispatch');
    return { wait: 'step', step };
  }
  const upstream = task.depends_on.find(
    (id) => taskState(plan, id, taskSessions(ctx, plan.id, id)) !== 'done',
  );
  requireThat(
    !upstream,
    'invalid_state',
    `Task ${task.id} depends on task ${upstream}, which is not done; start it after that task is done`,
  );
  const held = heldScopes(ctx, plan.project_id).find((each) =>
    each.scope.some((a) => task.scope.some((b) => overlaps(a, b))),
  );
  requireThat(
    !held,
    'resource_busy',
    `The scope of task ${task.id} overlaps task ${held?.task_id}, which is under way; start it after that task ends`,
  );
  const generation = taskGeneration(plan, task.id),
    workflow = taskWorkflow(ctx, plan, task.id);
  const next = ctx.store.update(
    'sessions',
    {
      ...lead,
      direct_task: {
        id: task.id,
        generation,
        definition_version: workflow.definition_version,
        ...(workflow.id !== plan.project_id ? { workflow_id: workflow.id } : {}),
      },
    },
    lead.revision,
  );
  ctx.store.event(
    'task.claimed',
    next,
    plan.project_id,
    { task_id: task.id, generation },
    commandId,
  );
  setLeadTurnReadOnly(ctx, plan.id, false);
  // A runtime that fixes a turn's permissions when it starts keeps a read-only turn so until it ends.
  const running = ctx.store
    .list<SessionTurn>('session_turns')
    .find((turn) => turn.session_id === plan.id && turn.state === 'running');
  if (
    !running?.read_only ||
    sessionAdapter(ctx, next)?.report.capabilities.turn_write_unlock?.status === 'supported'
  )
    return { claimed: task.id, generation };
  queueTurn(
    ctx,
    next,
    `[Pantheon] You claimed direct task ${task.id}; this turn can change and commit it, then call report with kind done.`,
    'continuation',
    commandId,
    { causal_depth: nextDepth(ctx, plan.id, { lead_session_id: plan.id, id: task.id }) },
  );
  return {
    claimed: task.id,
    generation,
    note: 'This turn started read-only and stays so; end this turn, and your next turn can write.',
  };
}

export const taskDispatchHandlers: Handlers = {
  // Each lead owns its own plan row, so requests take no expected revision.
  'task.start': (ctx, p, c) => {
    const input = inputSchemas['task.start'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    const plan = actingPlan(ctx, p, input.project_id, input.lead_session_id);
    // The user starting a direct task asks for a task session to do it now.
    if (
      p.role === 'lead' &&
      input.task_ids.some((taskId) => {
        const task = plan.tasks.find((candidate) => candidate.id === taskId);
        return task && taskPath(ctx, input.project_id, task) === 'direct';
      })
    )
      return claimDirectTask(ctx, plan, input.task_ids, c.command_id);
    const dispatch = { ...plan.dispatch };
    for (const taskId of input.task_ids) {
      const task = plan.tasks.find((candidate) => candidate.id === taskId);
      requireThat(task, 'not_found', `Not found: task ${taskId} in your plan`);
      requireThat(
        !taskSessions(ctx, plan.id, taskId).length,
        'invalid_state',
        p.role === 'user'
          ? `Task ${taskId} has a session; stop the task before starting it again`
          : `Task ${taskId} already has a session`,
      );
      requireThat(
        taskPath(ctx, plan.project_id, task) !== 'parallel' || task.parallel,
        'invalid_input',
        'A parallel task needs two to four lead-defined parts',
      );
      const defaults = sessionDefaults(ctx, ctx.store.must<Project>('projects', plan.project_id));
      const choice = admitWriterChoice(
        ctx,
        taskChoice(ctx, plan, task),
        defaults?.fallbacks?.writer,
      );
      const permissionMode = defaults?.permission_mode;
      checkPermissionMode(choice.runtime, permissionMode, p);
      if (!Object.hasOwn(dispatch, taskId))
        dispatch[taskId] = {
          requested_at: ctx.store.now(),
          causal_depth: nextDepth(ctx, plan.id, { lead_session_id: plan.id, id: taskId }),
          ...(permissionMode === 'auto' || permissionMode === 'full_access'
            ? { permission_mode: permissionMode }
            : {}),
        };
    }
    const next = ctx.store.update('board_plans', { ...plan, dispatch }, plan.revision);
    ctx.store.event(
      'task.start_requested',
      next,
      input.project_id,
      { task_ids: input.task_ids },
      c.command_id,
    );
    if (p.role === 'user')
      for (const taskId of input.task_ids)
        appendNote(
          ctx,
          ctx.store.must<BoardPlan>('board_plans', plan.id),
          {
            at: ctx.store.now(),
            session_id: '',
            task_id: taskId,
            kind: 'user_edit',
            text: `The user started task ${taskId}; it opens once nothing keeps it waiting.`,
          },
          c.command_id,
        );
    return { requested: Object.keys(dispatch) };
  },
  // A stopped session holds its place until its process stops, so the task restarts only then.
  'task.stop': (ctx, p, c) => {
    const input = inputSchemas['task.stop'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    const plan = actingPlan(ctx, p, input.project_id, input.lead_session_id);
    requireThat(
      plan.tasks.some((task) => task.id === input.task_id),
      'not_found',
      `Not found: task ${input.task_id} in your plan`,
    );
    // The sessions left from a removed task under this id are stopped with the task's own.
    const retired = ctx.store
      .list<Session>('sessions')
      .filter(
        (session) =>
          session.workspace_id &&
          session.task?.lead_session_id === plan.id &&
          session.task.id === input.task_id &&
          !session.outcome &&
          retiredBinding(plan, session),
      );
    const dequeued = !!ownEntry(plan.dispatch, input.task_id),
      open = [
        ...taskSessions(ctx, plan.id, input.task_id).filter((session) => !session.outcome),
        ...retired,
      ];
    const lead = ctx.store.get<Session>('sessions', plan.id),
      claimant = lead?.direct_task?.id === input.task_id ? lead : undefined;
    requireThat(
      dequeued || open.length || claimant,
      'invalid_state',
      `Task ${input.task_id} has no start request or open session to stop`,
    );
    // The stopped work is no evidence any more, so an acceptance of it is taken back.
    const accepted = ownEntry(plan.accepted, input.task_id) !== undefined;
    const next =
      dequeued || accepted
        ? ctx.store.update(
            'board_plans',
            {
              ...plan,
              ...(dequeued
                ? {
                    dispatch: Object.fromEntries(
                      Object.entries(plan.dispatch!).filter(([taskId]) => taskId !== input.task_id),
                    ),
                  }
                : {}),
              ...(accepted
                ? {
                    accepted: Object.fromEntries(
                      Object.entries(plan.accepted!).filter(([taskId]) => taskId !== input.task_id),
                    ),
                  }
                : {}),
            },
            plan.revision,
          )
        : plan;
    ctx.store.event(
      'task.stop_requested',
      next,
      input.project_id,
      { task_id: input.task_id, reason: input.reason },
      c.command_id,
    );
    if (claimant) {
      const released = ctx.store.update(
        'sessions',
        { ...claimant, direct_task: undefined },
        claimant.revision,
      );
      ctx.store.event(
        'task.released',
        released,
        input.project_id,
        { task_id: input.task_id },
        c.command_id,
      );
      if (planUnfinished(ctx, plan.id)) revokeLeadTurnWrites(ctx, plan.id, c.command_id);
    }
    const sessions = open.map((session) => {
      const stopped = stopWorktreeSession(
        ctx,
        session,
        { reason: input.reason, by: p.role === 'user' ? 'user' : 'lead' },
        c.command_id,
      );
      return { session_id: stopped.id, step: stopped.outcome ? 'discarded' : 'stopping' };
    });
    if (p.role === 'user')
      appendNote(
        ctx,
        ctx.store.must<BoardPlan>('board_plans', plan.id),
        {
          at: ctx.store.now(),
          session_id: '',
          task_id: input.task_id,
          kind: 'user_edit',
          text: `The user stopped task ${input.task_id}: ${input.reason}`,
        },
        c.command_id,
      );
    return {
      task_id: input.task_id,
      dequeued,
      ...(claimant ? { released: true } : {}),
      sessions,
      task_state: taskState(
        ctx.store.must<BoardPlan>('board_plans', plan.id),
        input.task_id,
        taskSessions(ctx, plan.id, input.task_id),
        ctx.store.get<Session>('sessions', plan.id),
      ),
    };
  },
  // The session, its worktree and its commits stay; queued lead messages run after the interrupt.
  'task.interrupt': (ctx, p, c) => {
    const input = inputSchemas['task.interrupt'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    const plan = actingPlan(ctx, p, input.project_id, input.lead_session_id);
    requireThat(
      plan.tasks.some((task) => task.id === input.task_id),
      'not_found',
      `Not found: task ${input.task_id} in your plan`,
    );
    const session = taskSessions(ctx, plan.id, input.task_id).find(
      (candidate) => !candidate.outcome && candidate.state === 'running',
    );
    requireThat(session, 'resource_busy', `Task ${input.task_id} has no running turn to interrupt`);
    interruptSession(ctx, session, p.role === 'user' ? 'user' : 'lead', c.command_id);
    return { task_id: input.task_id, session_id: session.id };
  },
  'task.background.stop': (ctx, p, c) => {
    const input = inputSchemas['task.background.stop'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    const plan = actingPlan(ctx, p, input.project_id, input.lead_session_id);
    const session = taskSessions(ctx, plan.id, input.task_id).find(
      (candidate) =>
        !candidate.outcome &&
        backgroundTasks(ctx, candidate.id).some((task) => task.id === input.background_id),
    );
    requireThat(
      session,
      'not_found',
      `Task ${input.task_id} has no background task ${input.background_id}`,
    );
    return {
      task_id: input.task_id,
      ...stopBackground(ctx, session, input.background_id, c.command_id),
    };
  },
};
