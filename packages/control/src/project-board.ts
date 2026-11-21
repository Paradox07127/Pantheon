import {
  TASK_TIERS,
  canonical,
  credentialRole,
  hash,
  requireThat,
  type BoardPlan,
  type ExternalEvent,
  type LeadNote,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
  type TaskKind,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import {
  ownEntry,
  projectAccess,
  sessionWorkspaceKind,
  sessionAdapter,
  type ControlContext,
  type Handlers,
} from './context.js';
import { sessionDefaults } from './user-config.js';
import { runtime } from './admission.js';
import { planUnfinished, planViews, retiredBinding } from './board-plan.js';
import { deviceHasLabel, listDevices } from './devices.js';
import { INBOX_HEADER, noteOtherPlan } from './lead-inbox.js';
import { revokeLeadTurnWrites, taskPath, taskRuntime } from './task-dispatch.js';
import { kindOfPaths, risky, scopeTierReason } from './task-kind.js';
import { workflowPolicy } from './workflow-policy.js';

/** The longest iteration in days, so a mistyped year cannot make the board count each day of centuries. */
export const ITERATION_DAYS = 366;

type PlanInput = Omit<
  ReturnType<(typeof inputSchemas)['board.plan.update']['parse']>,
  'base_version' | 'trigger_event'
> & { order_lock?: string[] };
type PlanTask = Omit<PlanInput['tasks'][number], 'workflow_id'>;

type TaskTier = TaskKind['tier'];

const repeated = (ids: string[]) => ids.find((value, index) => ids.indexOf(value) !== index);

function planProblem(input: PlanInput): string | null {
  const lanes = input.lanes.map((lane) => lane.id),
    tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const lane = repeated(lanes);
  if (lane) return `lanes: lane id ${lane} is repeated`;
  const task = repeated(input.tasks.map((task) => task.id));
  if (task) return `tasks: task id ${task} is repeated`;
  for (const task of input.tasks) {
    if (!lanes.includes(task.lane)) return `tasks: task ${task.id} names unknown lane ${task.lane}`;
    if (task.runtime === 'fixture')
      return `tasks: task ${task.id} names runtime fixture, which only tests and acceptance runs use`;
    const climbing = task.scope.find((entry) => entry.split('/').includes('..'));
    if (climbing) return `tasks: task ${task.id} scope ${climbing} contains a .. segment`;
    for (const upstream of task.depends_on) {
      if (upstream === task.id) return `tasks: task ${task.id} depends on itself`;
      if (!tasks.has(upstream)) return `tasks: task ${task.id} depends on unknown task ${upstream}`;
    }
  }
  const assumptionIds = input.assumptions.flatMap((assumption) =>
    assumption.id ? [assumption.id] : [],
  );
  const assumption = repeated(assumptionIds);
  if (assumption) return `assumptions: assumption id ${assumption} is repeated`;
  for (const [index, assumption] of input.assumptions.entries()) {
    const named = assumption.id ?? `${index + 1} (${assumption.text.slice(0, 60)})`;
    const unknown = assumption.affects?.find((taskId) => !tasks.has(taskId));
    if (unknown) return `assumptions: assumption ${named} affects unknown task ${unknown}`;
  }
  const risk = repeated(input.risks.flatMap((risk) => (risk.id ? [risk.id] : [])));
  if (risk) return `risks: risk id ${risk} is repeated`;
  const cycle = dependencyCycle(input.tasks);
  if (cycle) return `tasks: tasks ${cycle.join(' -> ')} form a dependency cycle`;
  return null;
}

/** A source quote that no user turn of a lead in the project or user plan edit contains, or null. */
export function sourceProblem(ctx: ControlContext, input: PlanInput): string | null {
  // Any lead counts, since board.sync hands an ended lead's plan to a new one.
  const leads = new Set(
    ctx.store
      .list<Session>('sessions')
      .filter(
        (session) =>
          session.project_id === input.project_id &&
          credentialRole(session, sessionWorkspaceKind(ctx, session)) === 'lead',
      )
      .map((session) => session.id),
  );
  const said = [
    ...ctx.store
      .list<SessionTurn>('session_turns')
      // The confirmed baseline restates what the user confirmed.
      .filter((turn) => (!turn.origin || turn.origin === 'baseline') && leads.has(turn.session_id))
      // The worker reports queueInput appends are not the user's words.
      .map((turn) => turn.input.split(`\n\n${INBOX_HEADER}`)[0]!),
    ...ctx.store
      .kindEvents(input.project_id, ['lead.note_added'])
      .map((event) => event.payload as LeadNote)
      // A decision the personal agent made for the user is not the user's words.
      .filter((note) => note.kind === 'user_edit' && !note.via)
      .map((note) => note.text),
  ];
  // What the user wrote in an external event counts as the user's words; other people's text does not.
  const external = ctx.store
    .list<ExternalEvent>('external_events')
    .filter((event) => event.project_id === input.project_id)
    .flatMap((event) => event.texts);
  said.push(...external.filter((text) => text.own).map((text) => text.text));
  for (const task of input.tasks) {
    if (!task.source.length && !task.external_source?.length)
      return `tasks: task ${task.id} has no source; quote the user's messages in source, or other people's text of an external request in external_source`;
    for (const quote of task.source)
      if (!said.some((text) => text.includes(quote)))
        return `tasks: task ${task.id} quotes "${quote}", which no user message to a lead contains; source must be verbatim excerpts of the user's messages`;
    for (const quote of task.external_source ?? [])
      if (!external.some((text) => text.text.includes(quote)))
        return `tasks: task ${task.id} quotes "${quote}" in external_source, which no external request of this project contains`;
  }
  return null;
}

/** One dependency cycle as task ids from its first task back to it, or null. */
function dependencyCycle(tasks: PlanInput['tasks']): string[] | null {
  const upstream = new Map(tasks.map((task) => [task.id, task.depends_on]));
  const done = new Set<string>();
  const visit = (taskId: string, path: string[]): string[] | null => {
    const start = path.indexOf(taskId);
    if (start >= 0) return [...path.slice(start), taskId];
    if (done.has(taskId)) return null;
    for (const next of upstream.get(taskId) ?? []) {
      const cycle = visit(next, [...path, taskId]);
      if (cycle) return cycle;
    }
    done.add(taskId);
    return null;
  };
  for (const task of tasks) {
    const cycle = visit(task.id, []);
    if (cycle) return cycle;
  }
  return null;
}

function refuseInvalid(ctx: ControlContext, input: PlanInput): void {
  // An edited plan must stay one the lead can send whole again.
  const { order_lock: _, ...whole } = input;
  const parsed = inputSchemas['board.plan.update'].safeParse({ ...whole, base_version: 0 });
  requireThat(
    parsed.success,
    'invalid_input',
    parsed.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') ??
      '',
  );
  const problem = planProblem(input);
  requireThat(!problem, 'invalid_input', problem ?? '');
  const unquoted = sourceProblem(ctx, input);
  requireThat(!unquoted, 'invalid_input', unquoted ?? '');
  for (const iteration of input.iterations ?? [])
    requireThat(
      Date.parse(iteration.ends_on) - Date.parse(iteration.starts_on) <
        ITERATION_DAYS * 24 * 60 * 60 * 1000,
      'invalid_input',
      `iterations: iteration ${iteration.id} spans more than ${ITERATION_DAYS} days`,
    );
  for (const task of input.tasks) {
    requireThat(
      taskPath(ctx, input.project_id, task) !== 'parallel' || task.parallel,
      'invalid_input',
      `tasks: task ${task.id} takes the parallel path, which needs two to four lead-defined parts`,
    );
  }
}

/** The task with the kind its scope gives; a kind it names keeps its domain and takes the higher tier. */
function withScopeKind(task: PlanTask): PlanTask {
  const found = kindOfPaths(task.scope);
  // A task whose goal names a risk takes tier t3.
  const scoped = found && risky(task.goal) ? { ...found, tier: 't3' as const } : found;
  if (!scoped) return task;
  if (!task.kind) return { ...task, kind: scoped };
  return TASK_TIERS.indexOf(scoped.tier) > TASK_TIERS.indexOf(task.kind.tier)
    ? { ...task, kind: { ...task.kind, tier: scoped.tier } }
    : task;
}

/**
 * Refuses a lead's task that names a runtime the daemon cannot open it on, names another device
 * unknown or without device_reason, needs labels or uses resources its device lacks, or leaves the
 * project's writer or the workflow policy's path without saying why, listing every problem in
 * one refusal; a task is checked only when it is new or the write changes the fields a check reads.
 * writtenTiers holds the tier the lead wrote, or undefined for no kind, for tasks it wrote a kind of.
 */
function refuseUnexplained(
  ctx: ControlContext,
  leadId: string,
  current: BoardPlan | undefined,
  input: PlanInput,
  taskIds: Set<string>,
  writtenTiers: Map<string, TaskTier | undefined> = new Map(),
): void {
  const policy = workflowPolicy(ctx, input.project_id),
    defaults = sessionDefaults(ctx, ctx.store.must<Project>('projects', input.project_id));
  let devices: ReturnType<typeof listDevices> | undefined;
  const problems: string[] = [];
  const check = (ok: unknown, problem: string) => {
    if (!ok) problems.push(problem);
  };
  for (const task of input.tasks) {
    if (!taskIds.has(task.id)) continue;
    const old = current?.tasks.find((entry) => entry.id === task.id);
    const changed = (fields: (keyof PlanTask)[]) =>
      !old || fields.some((field) => canonical(old[field]) !== canonical(task[field]));
    if (task.runtime && changed(['runtime'])) {
      let unavailable = '';
      try {
        runtime(ctx, task.runtime, 'writer');
      } catch (error) {
        unavailable = (error as Error).message;
      }
      check(
        !unavailable,
        `tasks: task ${task.id} names runtime ${task.runtime}, which cannot open its session: ${unavailable}`,
      );
    }
    if (
      (task.device || task.needs?.length || task.uses) &&
      changed(['device', 'needs', 'uses', 'runtime'])
    ) {
      const deviceId = task.device ?? 'local',
        needs = task.needs ?? [];
      devices ??= listDevices(ctx);
      const device = devices.find((entry) => entry.id === deviceId);
      check(
        device,
        `tasks: task ${task.id} names device ${deviceId}, which is not configured; the devices are ${devices.map((entry) => entry.id).join(', ')}`,
      );
      check(
        deviceId === 'local' || task.device_reason,
        `tasks: task ${task.id} runs on device ${deviceId}; write device_reason to say why`,
      );
      // An offline device's probe is not known, so its labels and runtimes are not checked.
      if (device?.online) {
        const missing = needs.filter((label) => !deviceHasLabel(device, label));
        check(
          !missing.length,
          `tasks: task ${task.id} needs ${missing.join(', ')}, which device ${deviceId} does not have; the devices with all of its needs are ${
            devices
              .filter((entry) => needs.every((label) => deviceHasLabel(entry, label)))
              .map((entry) => entry.id)
              .join(', ') || 'none'
          }`,
        );
        const runtimeName = taskRuntime(
          ctx,
          current ?? ({ id: leadId, project_id: input.project_id } as BoardPlan),
          task,
        );
        check(
          deviceId === 'local' || device.runtimes[runtimeName],
          `tasks: task ${task.id} runs on runtime ${runtimeName}, which device ${deviceId} does not have; it has ${Object.keys(device.runtimes).join(', ') || 'none'}`,
        );
      }
      if (device)
        for (const [name, amount] of Object.entries(task.uses ?? {}))
          check(
            (device.resources[name] ?? 0) >= amount,
            `tasks: task ${task.id} uses ${amount} of resource ${name}, but device ${deviceId} has ${device.resources[name] ?? 0}`,
          );
    }
    const routed = (['runtime', 'model', 'effort'] as const).filter((field) => task[field]);
    if (defaults?.single_model && !defaults.writer && !task.route_reason) {
      const off = routed.filter((field) => task[field] !== defaults[field]);
      check(
        !off.length || !changed(['runtime', 'model', 'effort', 'route_reason']),
        `tasks: task ${task.id} names ${off.map((field) => `${field} ${task[field]}`).join(', ')}, but the project runs tasks on its default runtime ${defaults.runtime}, model ${defaults.model} and effort ${defaults.effort ?? 'unset'} only; write route_reason to say why`,
      );
    }
    const writer = defaults?.writer;
    if (
      writer &&
      task.kind &&
      routed.length &&
      !task.route_reason &&
      changed(['runtime', 'model', 'effort', 'kind', 'route_reason'])
    )
      check(
        routed.every((field) => task[field] === writer[field]),
        `tasks: task ${task.id} differs from the project's writer (runtime ${writer.runtime}, model ${writer.model}, effort ${writer.effort ?? 'unset'}); write route_reason to say why`,
      );
    if (task.kind && task.path && !task.flow_reason && changed(['path', 'kind', 'flow_reason'])) {
      const given = policy.path[task.kind.tier],
        written = writtenTiers.get(task.id);
      // A tier the scope raised says why, since the lead's own tier would have passed.
      const raised =
        writtenTiers.has(task.id) &&
        (!written || TASK_TIERS.indexOf(written) < TASK_TIERS.indexOf(task.kind.tier)) &&
        scopeTierReason(task.scope, task.goal);
      check(
        task.path === given,
        raised
          ? `tasks: task ${task.id} is tier ${task.kind.tier}${written ? `, not the ${written} you wrote,` : ''} because ${raised}; the workflow policy gives ${task.kind.tier} tasks path ${given}; narrow the scope or write flow_reason to say why`
          : `tasks: task ${task.id} takes path ${task.path}, but the workflow policy gives ${task.kind.tier} tasks path ${given}; write flow_reason to say why`,
      );
    }
  }
  requireThat(!problems.length, 'invalid_input', problems.join('\n'));
}

/** The lead's plan as a whole plan input; a plan's milestones are not kept. */
function planContent(ctx: ControlContext, plan: BoardPlan): PlanInput {
  return {
    project_id: plan.project_id,
    // A resident's plan starts without a headline; its first change names it after the session.
    headline:
      plan.headline || (ctx.store.get<Session>('sessions', plan.id)?.title ?? plan.id).slice(0, 80),
    lanes: plan.lanes,
    iterations: plan.iterations ?? [],
    order_lock: plan.order_lock,
    tasks: plan.tasks,
    milestones: [],
    risks: plan.risks,
    assumptions: plan.assumptions,
  };
}

const contentKey = (input: PlanInput) =>
  canonical({
    headline: input.headline,
    lanes: input.lanes,
    iterations: input.iterations,
    order_lock: input.order_lock,
    tasks: input.tasks,
    risks: input.risks,
    assumptions: input.assumptions,
  });

function requireVersion(plan: BoardPlan | undefined, baseVersion: number): void {
  const version = plan?.plan_version ?? 0;
  requireThat(
    baseVersion === version,
    'revision_conflict',
    `The plan is at version ${version}; read it and send base_version ${version}`,
  );
}

/**
 * Validates and stores the lead's whole plan, starting a task's next generation when its contract
 * changes; the plan version rises only when the plan's content changes.
 */
function storePlan(
  ctx: ControlContext,
  p: Principal,
  leadId: string,
  input: PlanInput,
  commandId: string,
  options: {
    leadTasks?: Set<string>;
    writtenTiers?: Map<string, TaskTier | undefined>;
    /** The board.replan_triggered event the change answers; history reads it off the plan_updated event. */
    triggerEvent?: string;
  } = {},
): BoardPlan {
  // A retired workflow_id on a task is accepted and not stored.
  input = { ...input, tasks: input.tasks.map(({ workflow_id: _, ...task }) => task) };
  refuseInvalid(ctx, input);
  const current = ctx.store.get<BoardPlan>('board_plans', leadId);
  const orderLock = Object.hasOwn(input, 'order_lock') ? input.order_lock : current?.order_lock;
  if (orderLock) {
    const retained = orderLock.filter((id) => input.tasks.some((task) => task.id === id));
    requireThat(
      canonical(
        input.tasks.filter((task) => orderLock.includes(task.id)).map((task) => task.id),
      ) === canonical(retained),
      'invalid_input',
      `Task order lock (${orderLock.join(', ')}) prevents changing their relative order; unlock_order first`,
    );
  }
  input = { ...input, order_lock: orderLock };
  if (options.leadTasks)
    refuseUnexplained(ctx, leadId, current, input, options.leadTasks, options.writtenTiers);
  const contract = (task: BoardPlan['tasks'][number]) =>
    canonical({
      title: task.title,
      goal: task.goal,
      brief: task.brief,
      source: task.source,
      external_source: task.external_source,
      scope: task.scope,
      acceptance: task.acceptance,
      parallel: task.parallel,
      done_when: task.done_when,
      model: task.model,
      effort: task.effort,
      // The runtime the task opens on, so naming the default runtime is no change.
      runtime: current && taskRuntime(ctx, current, task),
    });
  const changed = new Set(
    (current?.tasks ?? [])
      .filter((old) => {
        const task = input.tasks.find((candidate) => candidate.id === old.id);
        return (
          !task ||
          contract(task) !== contract(old) ||
          // Naming a runtime ends Pantheon's switch, which the runtime above still follows.
          (!!ownEntry(current!.runtime_switches, old.id) && task.runtime !== old.runtime)
        );
      })
      .map((old) => old.id),
  );
  // A session moves to the changed contract's generation once the change reaches it.
  const told = ctx.store
    .list<Session>('sessions')
    .filter(
      (session) =>
        session.task?.lead_session_id === leadId &&
        changed.has(session.task.id) &&
        !session.outcome &&
        session.state !== 'closed' &&
        !retiredBinding(current, session),
    )
    .map((session) => session.id);
  const contractHash = (task: BoardPlan['tasks'][number]) =>
    hash({
      goal: task.goal,
      ...(task.brief ? { brief: task.brief } : {}),
      scope: task.scope,
      acceptance: task.acceptance,
      parallel: task.parallel,
      done_when: task.done_when ?? 'merged',
    });
  const kept = (taskId: string) => {
    const old = current?.tasks.find((task) => task.id === taskId);
    return (
      old &&
      (ownEntry(current!.generations, taskId) ?? { generation: 1, contract: contractHash(old) })
    );
  };
  const generations = Object.fromEntries(
    input.tasks.map((task) => {
      const was = kept(task.id),
        contract = contractHash(task);
      // A hash stored before the upgrade counted the retired `workflow_id`.
      const workflowId = (
        current?.tasks.find((old) => old.id === task.id) as { workflow_id?: string } | undefined
      )?.workflow_id;
      const generation = !was
        ? (ownEntry(current?.retired, task.id) ?? 0) + 1
        : was.contract === contract ||
            (workflowId !== undefined &&
              was.contract ===
                hash({
                  goal: task.goal,
                  ...(task.brief ? { brief: task.brief } : {}),
                  scope: task.scope,
                  acceptance: task.acceptance,
                  workflow_id: workflowId,
                  parallel: task.parallel,
                  done_when: task.done_when ?? 'merged',
                }))
          ? was.generation
          : was.generation + 1;
      return [task.id, { generation, contract }];
    }),
  );
  const retired = Object.fromEntries([
    ...Object.entries(current?.retired ?? {}),
    ...(current?.tasks ?? [])
      .filter((old) => !input.tasks.some((task) => task.id === old.id))
      .map((old) => [old.id, kept(old.id)!.generation] as const),
  ]);
  const planVersion =
    (current?.plan_version ?? 0) +
    (current && contentKey(planContent(ctx, current)) === contentKey(input) ? 0 : 1);
  const value: BoardPlan = {
    id: leadId,
    revision: 1,
    project_id: input.project_id,
    headline: input.headline,
    lanes: input.lanes,
    iterations: input.iterations,
    order_lock: orderLock,
    tasks: input.tasks,
    plan_version: planVersion,
    ...(current?.questions ? { questions: current.questions } : {}),
    risks: input.risks,
    assumptions: input.assumptions,
    ...(current?.dispatch
      ? {
          dispatch: Object.fromEntries(
            Object.entries(current.dispatch).filter(([taskId]) =>
              input.tasks.some((task) => task.id === taskId),
            ),
          ),
        }
      : {}),
    inbox: current?.inbox ?? [],
    notified: current?.notified ?? {},
    ...(current?.wake_failed ? { wake_failed: current.wake_failed } : {}),
    ...(current?.external_holds ? { external_holds: current.external_holds } : {}),
    ...(current?.paused ? { paused: current.paused } : {}),
    ...(current?.reassessment ? { reassessment: current.reassessment } : {}),
    ...(current?.last_told ? { last_told: current.last_told } : {}),
    contract_changed: [...new Set([...(current?.contract_changed ?? []), ...told])],
    ...(current?.handed_back ? { handed_back: current.handed_back } : {}),
    ...(current?.runtime_switches
      ? {
          runtime_switches: Object.fromEntries(
            Object.entries(current.runtime_switches).filter(([taskId, switched]) => {
              const old = current.tasks.find((task) => task.id === taskId),
                task = input.tasks.find((candidate) => candidate.id === taskId);
              return (
                !!old &&
                !!task &&
                task.runtime === old.runtime &&
                task.model === old.model &&
                task.effort === old.effort &&
                ownEntry(generations, taskId)?.generation === switched.generation
              );
            }),
          ),
        }
      : {}),
    ...(current?.alerted ? { alerted: current.alerted } : {}),
    ...(current?.accepted
      ? {
          accepted: Object.fromEntries(
            Object.entries(current.accepted).filter(([taskId]) =>
              input.tasks.some((task) => task.id === taskId),
            ),
          ),
        }
      : {}),
    ...(current?.direct_merged ? { direct_merged: current.direct_merged } : {}),
    generations,
    retired,
    updated_at: ctx.store.now(),
  };
  const next = current
    ? ctx.store.update('board_plans', value, current.revision)
    : ctx.store.insert('board_plans', value);
  ctx.store.event(
    'board.plan_updated',
    next,
    input.project_id,
    options.triggerEvent ? { ...next, trigger_event: options.triggerEvent } : next,
    commandId,
  );
  noteOtherPlan(ctx, next, commandId);
  const lead = ctx.store.must<Session>('sessions', leadId),
    claimed = lead.direct_task?.id;
  // A running merge checks the generation itself, so its claim stays until that check.
  const released =
    claimed &&
    (!input.tasks.some((task) => task.id === claimed) ||
      (lead.merge?.state !== 'running' &&
        ownEntry(generations, claimed)?.generation !== lead.direct_task!.generation));
  if (released)
    ctx.store.event(
      'task.released',
      ctx.store.update('sessions', { ...lead, direct_task: undefined }, lead.revision),
      input.project_id,
      { task_id: claimed },
      commandId,
    );
  // A running lead turn took its read-only flag when it began.
  const handle = [...ctx.handles.values()].find((h) => h.platform_session_id === leadId);
  if (released && planUnfinished(ctx, leadId)) revokeLeadTurnWrites(ctx, leadId, commandId);
  else if (
    handle &&
    !ctx.store.must<Session>('sessions', leadId).direct_task &&
    planUnfinished(ctx, leadId)
  ) {
    const adapter = sessionAdapter(ctx, ctx.store.must<Session>('sessions', leadId));
    let rolledBack = false;
    ctx.rollback?.push(() => (rolledBack = true));
    queueMicrotask(() => {
      if (!rolledBack) adapter?.setTurnReadOnly?.(handle, true);
    });
  }
  return next;
}

const planView = (ctx: ControlContext, projectId: string, leadId: string) =>
  planViews(ctx, projectId).find((view) => view.lead_session_id === leadId)!;

export const projectBoardHandlers: Handlers = {
  // Each lead owns its own plan row; base_version guards it against a write it has not read.
  'board.plan.update': (ctx, p, c) => {
    const { base_version, trigger_event, ...input } = inputSchemas['board.plan.update'].parse(
      c.input,
    );
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    ctx.store.must<Project>('projects', input.project_id);
    requireVersion(ctx.store.get<BoardPlan>('board_plans', p.session_id!), base_version);
    storePlan(
      ctx,
      p,
      p.session_id!,
      { ...input, tasks: input.tasks.map(withScopeKind) },
      c.command_id,
      {
        leadTasks: new Set(input.tasks.map((task) => task.id)),
        writtenTiers: new Map(input.tasks.map((task) => [task.id, task.kind?.tier])),
        triggerEvent: trigger_event,
      },
    );
    return planView(ctx, input.project_id, p.session_id!);
  },
};
