import {
  TASK_TIERS,
  canonical,
  credentialRole,
  hash,
  id,
  requireThat,
  type BoardPlan,
  type ExternalEvent,
  type LeadNote,
  type Milestone,
  type PendingPlanEdit,
  type PlanProposal,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import {
  projectAccess,
  sessionWorkspaceKind,
  userOnly,
  sessionAdapter,
  type ControlContext,
  type Handlers,
} from './context.js';
import { sessionDefaults } from './user-config.js';
import { runtime } from './admission.js';
import { ownEntry, planUnfinished, planViews, retiredBinding } from './board-plan.js';
import { deviceHasLabel, listDevices } from './devices.js';
import { history } from './project-facts.js';
import { INBOX_HEADER, appendNote } from './lead-inbox.js';
import { reviewPlan } from './review.js';
import { projectRoutingTable } from './routing-table.js';
import { placedTaskSessions, revokeLeadTurnWrites, taskRuntime } from './task-dispatch.js';
import { wakeLead } from './task-tracking.js';
import { kindOfPaths, risky } from './task-kind.js';
import { workflowPolicy } from './workflow-policy.js';

type PlanInput = Omit<
  ReturnType<(typeof inputSchemas)['board.plan.update']['parse']>,
  'base_version'
> & { order_lock?: string[] };
type PlanTask = PlanInput['tasks'][number];
type EditOp = ReturnType<(typeof inputSchemas)['board.plan.edit']['parse']>['ops'][number];
type PatchOp = Exclude<EditOp, { type: 'resolve_edit' }>;

/** Task fields a user edit changes at once even while the task has an unfinished session. */
const RECORD_FIELDS = [
  'title',
  'lane',
  'kind',
  'task_type',
  'token_budget',
  'priority',
  'milestone',
  'route_reason',
  'iteration',
  'estimate',
];

/** The flow_reason a user's path edit gets when it gives none. */
export const USER_FLOW_REASON = 'Chosen by the user';

const repeated = (ids: string[]) => ids.find((value, index) => ids.indexOf(value) !== index);

function planProblem(input: PlanInput): string | null {
  const lanes = input.lanes.map((lane) => lane.id),
    tasks = new Map(input.tasks.map((task) => [task.id, task])),
    milestones = new Map(input.milestones.map((milestone) => [milestone.id, milestone]));
  const lane = repeated(lanes);
  if (lane) return `lanes: lane id ${lane} is repeated`;
  const task = repeated(input.tasks.map((task) => task.id));
  if (task) return `tasks: task id ${task} is repeated`;
  const milestone = repeated(input.milestones.map((milestone) => milestone.id));
  if (milestone) return `milestones: milestone id ${milestone} is repeated`;
  for (const task of input.tasks) {
    if (!lanes.includes(task.lane)) return `tasks: task ${task.id} names unknown lane ${task.lane}`;
    if (task.runtime === 'fixture')
      return `tasks: task ${task.id} names runtime fixture, which only tests and acceptance runs use`;
    const climbing = task.scope.find((entry) => entry.split('/').includes('..'));
    if (climbing) return `tasks: task ${task.id} scope ${climbing} contains a .. segment`;
    if (task.milestone && !milestones.get(task.milestone)?.tasks.includes(task.id))
      return `tasks: task ${task.id} names milestone ${task.milestone}, which does not list it`;
    for (const upstream of task.depends_on) {
      if (upstream === task.id) return `tasks: task ${task.id} depends on itself`;
      if (!tasks.has(upstream)) return `tasks: task ${task.id} depends on unknown task ${upstream}`;
    }
  }
  for (const milestone of input.milestones) {
    const listed = repeated(milestone.tasks);
    if (listed) return `milestones: milestone ${milestone.id} lists task ${listed} twice`;
    for (const taskId of milestone.tasks)
      if (tasks.get(taskId)?.milestone !== milestone.id)
        return tasks.has(taskId)
          ? `milestones: milestone ${milestone.id} lists task ${taskId}, which names another milestone`
          : `milestones: milestone ${milestone.id} lists unknown task ${taskId}`;
  }
  const cycle = dependencyCycle(input.tasks);
  if (cycle) return `tasks: tasks ${cycle.join(' -> ')} form a dependency cycle`;
  return null;
}

/** A source quote that no user turn of a lead in the project, user plan edit or quoted text contains, or null. */
function sourceProblem(
  ctx: ControlContext,
  input: PlanInput,
  quoted: string[] = [],
): string | null {
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
      .filter((note) => note.kind === 'user_edit')
      .map((note) => note.text),
    ...quoted,
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

/** Upserts the lead's milestones by key; acceptance stays and its hash decides whether it holds. */
function writeLeadMilestones(
  ctx: ControlContext,
  p: Principal,
  leadId: string,
  projectId: string,
  milestones: PlanInput['milestones'],
  commandId: string,
): void {
  const rows = ctx.store
    .list<Milestone>('milestones')
    .filter((row) => row.owner_session_id === leadId);
  for (const input of milestones) {
    const fields = {
      title: input.title,
      criteria: input.criteria,
      task_ids: input.tasks,
      due_on: input.due_on,
    };
    const old = rows.find((row) => row.key === input.id);
    if (!old) {
      const milestone: Milestone = {
        ...fields,
        id: id(),
        revision: 1,
        project_id: projectId,
        required_sessions: [],
        owner_session_id: leadId,
        key: input.id,
        created_at: ctx.store.now(),
        updated_by: p.id,
      };
      ctx.store.insert('milestones', milestone);
      history(ctx, 'milestone', milestone, p.id);
      ctx.store.event('milestone.created', milestone, projectId, milestone, commandId);
      continue;
    }
    if (
      !old.removed_at &&
      canonical(fields) ===
        canonical({
          title: old.title,
          criteria: old.criteria,
          task_ids: old.task_ids,
          due_on: old.due_on,
        })
    )
      continue;
    const next = ctx.store.update(
      'milestones',
      { ...old, ...fields, removed_at: undefined, updated_by: p.id },
      old.revision,
    );
    history(ctx, 'milestone', next, p.id);
    ctx.store.event('milestone.revised', next, projectId, next, commandId);
  }
  for (const old of rows) {
    if (old.removed_at || milestones.some((input) => input.id === old.key)) continue;
    const next = ctx.store.update(
      'milestones',
      { ...old, removed_at: ctx.store.now(), updated_by: p.id },
      old.revision,
    );
    history(ctx, 'milestone', next, p.id);
    ctx.store.event('milestone.removed', next, projectId, next, commandId);
  }
}

function refuseInvalid(ctx: ControlContext, input: PlanInput, quoted: string[] = []): void {
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
  const unquoted = sourceProblem(ctx, input, quoted);
  requireThat(!unquoted, 'invalid_input', unquoted ?? '');
  for (const task of input.tasks) {
    if (task.workflow_id) {
      const workflow = ctx.store.get<import('@pantheon/domain').StoredWorkflowDefinition>(
        'workflow_definitions',
        task.workflow_id,
      );
      requireThat(
        (workflow && workflow.project_id === input.project_id) ||
          task.workflow_id === input.project_id,
        'invalid_input',
        `Task ${task.id} names no workflow in this project`,
      );
    }
  }
}

/** The task with the kind its scope gives; a kind it names keeps its domain and takes the higher tier. */
function withScopeKind(task: PlanTask): PlanTask {
  const found = kindOfPaths(task.scope);
  // A task whose goal names a risk gets plan review.
  const scoped = found && risky(task.goal) ? { ...found, tier: 't3' as const } : found;
  if (!scoped) return task;
  if (!task.kind) return { ...task, kind: scoped };
  return TASK_TIERS.indexOf(scoped.tier) > TASK_TIERS.indexOf(task.kind.tier)
    ? { ...task, kind: { ...task.kind, tier: scoped.tier } }
    : task;
}

/**
 * Refuses a lead's task that names a runtime the daemon cannot open it on, names another device
 * unknown or without device_reason, needs labels or uses resources its device lacks, or leaves the routing
 * table's first choice or the workflow policy's path without saying why; a task is checked only
 * when it is new or the write changes the fields a check reads.
 */
function refuseUnexplained(
  ctx: ControlContext,
  leadId: string,
  current: BoardPlan | undefined,
  input: PlanInput,
  taskIds: Set<string>,
): void {
  const policy = workflowPolicy(ctx, input.project_id),
    defaults = sessionDefaults(ctx, ctx.store.must<Project>('projects', input.project_id));
  let table: ReturnType<typeof projectRoutingTable> | undefined,
    devices: ReturnType<typeof listDevices> | undefined;
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
      requireThat(
        !unavailable,
        'invalid_input',
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
      requireThat(
        device,
        'invalid_input',
        `tasks: task ${task.id} names device ${deviceId}, which is not configured; the devices are ${devices.map((entry) => entry.id).join(', ')}`,
      );
      requireThat(
        deviceId === 'local' || task.device_reason,
        'invalid_input',
        `tasks: task ${task.id} runs on device ${deviceId}; write device_reason to say why`,
      );
      // An offline device's probe is not known, so its labels and runtimes are not checked.
      if (device.online) {
        const missing = needs.filter((label) => !deviceHasLabel(device, label));
        requireThat(
          !missing.length,
          'invalid_input',
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
        requireThat(
          deviceId === 'local' || device.runtimes[runtimeName],
          'invalid_input',
          `tasks: task ${task.id} runs on runtime ${runtimeName}, which device ${deviceId} does not have; it has ${Object.keys(device.runtimes).join(', ') || 'none'}`,
        );
      }
      for (const [name, amount] of Object.entries(task.uses ?? {}))
        requireThat(
          (device.resources[name] ?? 0) >= amount,
          'invalid_input',
          `tasks: task ${task.id} uses ${amount} of resource ${name}, but device ${deviceId} has ${device.resources[name] ?? 0}`,
        );
    }
    const routed = (['runtime', 'model', 'effort'] as const).filter((field) => task[field]);
    if (defaults?.single_model && !defaults.writer && !task.route_reason) {
      const off = routed.filter((field) => task[field] !== defaults[field]);
      requireThat(
        !off.length || !changed(['runtime', 'model', 'effort', 'route_reason']),
        'invalid_input',
        `tasks: task ${task.id} names ${off.map((field) => `${field} ${task[field]}`).join(', ')}, but the project runs tasks on its default runtime ${defaults.runtime}, model ${defaults.model} and effort ${defaults.effort ?? 'unset'} only; write route_reason to say why`,
      );
    }
    if (
      task.kind &&
      routed.length &&
      !task.route_reason &&
      changed(['runtime', 'model', 'effort', 'kind', 'route_reason'])
    ) {
      const { domain, tier } = task.kind;
      table ??= projectRoutingTable(ctx, input.project_id);
      const first =
        defaults?.writer ??
        table.cells.find((cell) => cell.domain === domain && cell.tier === tier)?.first;
      requireThat(
        !first || routed.every((field) => task[field] === first[field]),
        'invalid_input',
        `tasks: task ${task.id} differs from the routing table's first choice for ${domain} ${tier} (runtime ${first?.runtime}, model ${first?.model}, effort ${first?.effort ?? 'unset'}); write route_reason to say why`,
      );
    }
    if (task.kind && task.path && !task.flow_reason && changed(['path', 'kind', 'flow_reason'])) {
      const given = policy.path[task.kind.tier];
      requireThat(
        task.path === given,
        'invalid_input',
        `tasks: task ${task.id} takes path ${task.path}, but the workflow policy gives ${task.kind.tier} tasks path ${given}; write flow_reason to say why`,
      );
    }
  }
}

/** The lead's plan as a whole plan input, its milestones read from the lead's milestone rows. */
function planContent(ctx: ControlContext, plan: BoardPlan): PlanInput {
  return {
    project_id: plan.project_id,
    headline: plan.headline,
    lanes: plan.lanes,
    iterations: plan.iterations ?? [],
    order_lock: plan.order_lock,
    tasks: plan.tasks,
    milestones: ctx.store
      .list<Milestone>('milestones')
      .filter((row) => row.owner_session_id === plan.id && !row.removed_at)
      .map((row) => ({
        id: row.key!,
        title: row.title,
        criteria: row.criteria,
        tasks: row.task_ids ?? [],
        ...(row.due_on ? { due_on: row.due_on } : {}),
      })),
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
    milestones: [...input.milestones].sort((a, b) => a.id.localeCompare(b.id)),
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
    quoted?: string[];
    pendingEdits?: PendingPlanEdit[];
    leadTasks?: Set<string>;
    userEdits?: { edit_id: string; task_ids: string[] }[];
  } = {},
): BoardPlan {
  refuseInvalid(ctx, input, options.quoted);
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
  if (options.leadTasks) refuseUnexplained(ctx, leadId, current, input, options.leadTasks);
  const contract = (task: BoardPlan['tasks'][number]) =>
    canonical({
      title: task.title,
      goal: task.goal,
      source: task.source,
      external_source: task.external_source,
      scope: task.scope,
      acceptance: task.acceptance,
      workflow_id: task.workflow_id,
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
        return !task || contract(task) !== contract(old);
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
      scope: task.scope,
      acceptance: task.acceptance,
      workflow_id: task.workflow_id,
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
      const generation = !was
        ? (ownEntry(current?.retired, task.id) ?? 0) + 1
        : was.contract === contract
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
  const value: BoardPlan = {
    id: leadId,
    revision: 1,
    project_id: input.project_id,
    headline: input.headline,
    lanes: input.lanes,
    iterations: input.iterations,
    order_lock: orderLock,
    tasks: input.tasks,
    plan_version:
      (current?.plan_version ?? 0) +
      (current && contentKey(planContent(ctx, current)) === contentKey(input) ? 0 : 1),
    pending_edits: options.pendingEdits ?? current?.pending_edits ?? [],
    pending_proposals: current?.pending_proposals ?? [],
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
    contract_changed: [...new Set([...(current?.contract_changed ?? []), ...told])],
    ...(current?.handed_back ? { handed_back: current.handed_back } : {}),
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
  writeLeadMilestones(ctx, p, leadId, input.project_id, input.milestones, commandId);
  ctx.store.event('board.plan_updated', next, input.project_id, next, commandId);
  for (const edit of options.userEdits ?? [])
    ctx.store.event(
      'board.user_edit_applied',
      next,
      input.project_id,
      {
        edit_id: edit.edit_id,
        session_ids: told.filter((sessionId) =>
          edit.task_ids.includes(ctx.store.must<Session>('sessions', sessionId).task!.id),
        ),
      },
      commandId,
    );
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

/** The plan with the ops applied in order; a task removed leaves the milestones and the dependencies that list it. */
function applyOps(plan: PlanInput, ops: PatchOp[]): PlanInput {
  let { tasks, milestones, iterations, order_lock } = plan;
  for (const op of ops) {
    if (op.type === 'lock_order') {
      requireThat(
        op.task_ids.every((id) => tasks.some((task) => task.id === id)),
        'invalid_input',
        'Order lock must name tasks in the plan',
      );
      order_lock = tasks.filter((task) => op.task_ids.includes(task.id)).map((task) => task.id);
      continue;
    }
    if (op.type === 'unlock_order') {
      order_lock = undefined;
      continue;
    }
    if (op.type === 'set_iterations') {
      iterations = op.iterations;
      tasks = tasks.map((task) =>
        task.iteration !== undefined &&
        !iterations.some((iteration) => iteration.id === task.iteration)
          ? { ...task, iteration: undefined }
          : task,
      );
      continue;
    }
    if (op.type === 'add_task') {
      tasks = [...tasks, withScopeKind(op.task)];
      milestones = milestones.map((milestone) =>
        milestone.id === op.task.milestone
          ? { ...milestone, tasks: [...milestone.tasks, op.task.id] }
          : milestone,
      );
      continue;
    }
    if (op.type === 'set_milestone') {
      requireThat(
        milestones.some((milestone) => milestone.id === op.milestone_id),
        'invalid_input',
        `Milestone ${op.milestone_id} is not in the plan`,
      );
      milestones = milestones.map((milestone) =>
        milestone.id !== op.milestone_id
          ? milestone
          : {
              ...milestone,
              title: op.patch.title ?? milestone.title,
              due_on: op.patch.due_on === null ? undefined : (op.patch.due_on ?? milestone.due_on),
            },
      );
      continue;
    }
    requireThat(
      tasks.some((task) => task.id === op.task_id),
      'not_found',
      `Not found: task ${op.task_id} in the plan`,
    );
    if (op.type === 'remove_task') {
      tasks = tasks
        .filter((task) => task.id !== op.task_id)
        .map((task) => ({
          ...task,
          depends_on: task.depends_on.filter((taskId) => taskId !== op.task_id),
        }));
      // A milestone left without tasks goes with its last one.
      milestones = milestones
        .map((milestone) => ({
          ...milestone,
          tasks: milestone.tasks.filter((taskId) => taskId !== op.task_id),
        }))
        .filter((milestone) => milestone.tasks.length);
    } else if (op.type === 'move_task') {
      if (op.before === op.task_id) continue;
      requireThat(
        op.before === null || tasks.some((task) => task.id === op.before),
        'not_found',
        `Not found: task ${op.before} in the plan`,
      );
      const moved = tasks.find((task) => task.id === op.task_id)!;
      tasks = tasks.filter((task) => task.id !== op.task_id);
      const index =
        op.before === null ? tasks.length : tasks.findIndex((task) => task.id === op.before);
      tasks.splice(index, 0, moved);
    } else {
      if (op.type === 'set_task' && op.patch.milestone !== undefined)
        milestones = milestones
          .map((milestone) => ({
            ...milestone,
            tasks:
              milestone.id === op.patch.milestone
                ? milestone.tasks.includes(op.task_id)
                  ? milestone.tasks
                  : [...milestone.tasks, op.task_id]
                : milestone.tasks.filter((taskId) => taskId !== op.task_id),
          }))
          .filter((milestone) => milestone.tasks.length);
      tasks = tasks.map((task) =>
        task.id !== op.task_id
          ? task
          : op.type === 'set_task'
            ? withScopeKind(
                inputSchemas['board.plan.update'].shape.tasks.element.parse({
                  ...task,
                  ...op.patch,
                  iteration:
                    op.patch.iteration === null
                      ? undefined
                      : (op.patch.iteration ?? task.iteration),
                  milestone:
                    op.patch.milestone === null
                      ? undefined
                      : (op.patch.milestone ?? task.milestone),
                  workflow_id:
                    op.patch.workflow_id === null
                      ? undefined
                      : (op.patch.workflow_id ?? task.workflow_id),
                  path: op.patch.path === null ? undefined : (op.patch.path ?? task.path),
                  model: op.patch.model === null ? undefined : (op.patch.model ?? task.model),
                  effort: op.patch.effort === null ? undefined : (op.patch.effort ?? task.effort),
                  task_type:
                    op.patch.task_type === null
                      ? undefined
                      : (op.patch.task_type ?? task.task_type),
                  token_budget:
                    op.patch.token_budget === null
                      ? undefined
                      : (op.patch.token_budget ?? task.token_budget),
                  flow_reason:
                    op.patch.path === null ? undefined : (op.patch.flow_reason ?? task.flow_reason),
                }),
              )
            : { ...task, depends_on: op.depends_on },
      );
    }
  }
  requireThat(
    tasks.every(
      (task) =>
        task.iteration === undefined ||
        iterations.some((iteration) => iteration.id === task.iteration),
    ),
    'invalid_input',
    'Task iteration must name an iteration in the plan',
  );
  return { ...plan, tasks, milestones, iterations, order_lock };
}

const opTaskIds = (op: PatchOp): string[] =>
  op.type === 'lock_order'
    ? op.task_ids
    : op.type === 'unlock_order' || op.type === 'set_iterations' || op.type === 'set_milestone'
      ? []
      : [op.type === 'add_task' ? op.task.id : op.task_id];

function opText(op: PatchOp): string {
  switch (op.type) {
    case 'lock_order':
      return `lock order of tasks ${op.task_ids.join(', ')}`;
    case 'unlock_order':
      return 'unlock task order';
    case 'set_iterations':
      return `set iterations ${op.iterations.map((iteration) => iteration.id).join(', ')}`;
    case 'add_task':
      return `add task ${op.task.id} "${op.task.title}", quoting: ${op.task.source.join(' / ')}`;
    case 'move_task':
      return `move task ${op.task_id} ${op.before === null ? 'to the end' : `before ${op.before}`}`;
    case 'remove_task':
      return `remove task ${op.task_id}`;
    case 'set_task':
      return `set ${Object.entries(op.patch)
        .map(
          ([key, value]) => `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`,
        )
        .join(', ')} of task ${op.task_id}`;
    case 'set_dependencies':
      return `make task ${op.task_id} depend on ${op.depends_on.join(', ') || 'nothing'}`;
    case 'set_milestone':
      return `set ${Object.entries(op.patch)
        .map(([key, value]) => `${key} ${value ?? 'none'}`)
        .join(', ')} of milestone ${op.milestone_id}`;
  }
}

/** Applies the lead's ops and the user edits it applies, and records the user edits it resolves. */
function leadEdit(
  ctx: ControlContext,
  p: Principal,
  plan: BoardPlan,
  ops: EditOp[],
  commandId: string,
): BoardPlan {
  requireThat(
    p.role === 'user' || ops.every((op) => op.type !== 'lock_order' && op.type !== 'unlock_order'),
    'permission_denied',
    'Only the user may lock or unlock task order',
  );
  const pending = [...plan.pending_edits],
    patches: PatchOp[] = [];
  for (const op of ops) {
    if (op.type !== 'resolve_edit') {
      patches.push(op);
      continue;
    }
    const index = pending.findIndex(
      (edit) => edit.edit_id === op.edit_id && edit.status === 'pending',
    );
    requireThat(index >= 0, 'not_found', `Not found: pending user edit ${op.edit_id}`);
    const edit = pending[index]!;
    if (op.decision === 'apply') patches.push(...edit.ops);
    pending[index] = {
      ...edit,
      status: op.decision === 'apply' ? 'applied' : 'rejected',
      ...(op.reason ? { reason: op.reason } : {}),
      resolved_at: ctx.store.now(),
    };
  }
  // A user edit the lead applies stays unchecked, as it is when the user's edit applies at once.
  const leadTasks = new Set(ops.flatMap((op) => (op.type === 'resolve_edit' ? [] : opTaskIds(op))));
  return storePlan(ctx, p, plan.id, applyOps(planContent(ctx, plan), patches), commandId, {
    pendingEdits: pending,
    leadTasks,
    userEdits: pending
      .filter(
        (edit) =>
          edit.status === 'applied' &&
          plan.pending_edits.some(
            (old) => old.edit_id === edit.edit_id && old.status === 'pending',
          ),
      )
      .map((edit) => ({ edit_id: edit.edit_id, task_ids: edit.task_ids })),
  });
}

/**
 * Applies a user edit that touches no unfinished task session, or only renames, moves or retypes
 * a task; holds any other edit whole for the lead. Either way the lead gets a note of it.
 */
function userEdit(
  ctx: ControlContext,
  p: Principal,
  plan: BoardPlan,
  ops: EditOp[],
  baseVersion: number,
  commandId: string,
): { edit_id: string; applied: boolean } {
  // Without a reason, the lead's next write to the task is refused when the path is not its tier's.
  const patches = ops
    .filter((op): op is PatchOp => op.type !== 'resolve_edit')
    .map((op) =>
      op.type === 'set_task' && op.patch.path && !op.patch.flow_reason
        ? { ...op, patch: { ...op.patch, flow_reason: USER_FLOW_REASON } }
        : op,
    );
  requireThat(
    patches.length === ops.length,
    'permission_denied',
    'Only the lead resolves a pending edit',
  );
  // The user writes the source of a task the user adds.
  const quoted = patches.flatMap((op) => (op.type === 'add_task' ? op.task.source : []));
  const edited = applyOps(planContent(ctx, plan), patches);
  refuseInvalid(ctx, edited, quoted);
  const claimed = ctx.store.get<Session>('sessions', plan.id)?.direct_task?.id;
  const unfinished = new Set([
    ...placedTaskSessions(ctx, plan.project_id)
      .filter((session) => session.task!.lead_session_id === plan.id)
      .map((session) => session.task!.id),
    // A session waiting for workflow approval holds no place, yet its task is not done.
    ...ctx.store
      .list<Session>('sessions')
      .filter(
        (session) =>
          session.task?.lead_session_id === plan.id &&
          !session.outcome &&
          session.state !== 'closed' &&
          session.merge?.reason === 'workflow_approval',
      )
      .map((session) => session.task!.id),
    ...(claimed ? [claimed] : []),
  ]);
  const applied = !patches.some(
    (op) =>
      op.type !== 'add_task' &&
      op.type !== 'move_task' &&
      op.type !== 'lock_order' &&
      op.type !== 'unlock_order' &&
      op.type !== 'set_iterations' &&
      op.type !== 'set_milestone' &&
      unfinished.has(op.task_id) &&
      (op.type !== 'set_task' || Object.keys(op.patch).some((key) => !RECORD_FIELDS.includes(key))),
  );
  const editId = id(),
    taskIds = [...new Set(patches.flatMap(opTaskIds))];
  const lines = patches.map((op) => `- ${opText(op)}`).join('\n');
  const note: LeadNote = {
    at: ctx.store.now(),
    session_id: '',
    task_id: taskIds[0] ?? '',
    kind: 'user_edit',
    text: applied
      ? `The user changed your plan:\n${lines}`
      : `The user asks to change tasks that have unfinished sessions; apply or reject it with edit_board resolve_edit, edit_id ${editId}:\n${lines}`,
    edit: {
      edit_id: editId,
      ops: patches,
      base_version: baseVersion,
      applied,
      wake:
        !applied ||
        patches.some(
          (op) =>
            op.type === 'add_task' ||
            op.type === 'remove_task' ||
            op.type === 'set_dependencies' ||
            (op.type === 'set_task' &&
              (
                [
                  'goal',
                  'scope',
                  'acceptance',
                  'done_when',
                  'runtime',
                  'model',
                  'effort',
                  'path',
                  'workflow_id',
                  'parallel',
                ] as const
              ).some(
                (field) =>
                  Object.hasOwn(op.patch, field) &&
                  canonical(plan.tasks.find((task) => task.id === op.task_id)?.[field]) !==
                    canonical(edited.tasks.find((task) => task.id === op.task_id)?.[field]),
              )),
        ),
    },
  };
  if (applied) {
    appendNote(
      ctx,
      storePlan(ctx, p, plan.id, edited, commandId, {
        quoted,
        userEdits: [{ edit_id: editId, task_ids: taskIds }],
      }),
      note,
      commandId,
    );
    return { edit_id: editId, applied };
  }
  requireThat(
    ctx.store.get<Session>('sessions', plan.id)?.state !== 'closed',
    'lead_unavailable',
    `The lead session ${plan.id} has closed, so no one can apply an edit of tasks with unfinished sessions`,
  );
  if (patches.some((op) => op.type === 'lock_order' || op.type === 'unlock_order'))
    plan = storePlan(
      ctx,
      p,
      plan.id,
      { ...planContent(ctx, plan), order_lock: edited.order_lock },
      commandId,
    );
  const heldOps = patches.filter((op) => op.type !== 'lock_order' && op.type !== 'unlock_order');
  const held: PendingPlanEdit = {
    edit_id: editId,
    ops: heldOps,
    base_version: baseVersion,
    task_ids: [...new Set(heldOps.flatMap(opTaskIds))],
    created_at: ctx.store.now(),
    status: 'pending',
  };
  appendNote(ctx, { ...plan, pending_edits: [...plan.pending_edits, held] }, note, commandId);
  return { edit_id: editId, applied };
}

/** Marks a user edit that waits for the lead withdrawn and tells the lead, without waking it. */
function withdrawEdit(
  ctx: ControlContext,
  plan: BoardPlan,
  editId: string,
  commandId: string,
): void {
  const index = plan.pending_edits.findIndex((edit) => edit.edit_id === editId);
  // An edit that took effect at once is recorded only in the lead's notes.
  const inEffect =
    index < 0 &&
    ctx.store
      .kindEvents(plan.project_id, ['lead.note_added'])
      .some((event) => (event.payload as LeadNote).edit?.edit_id === editId);
  requireThat(index >= 0 || inEffect, 'not_found', `Not found: user edit ${editId}`);
  const edit = plan.pending_edits[index];
  requireThat(
    edit?.status === 'pending',
    'invalid_state',
    `User edit ${editId} is ${edit?.status ?? 'applied'}, so it no longer waits for the lead`,
  );
  const pending = [...plan.pending_edits];
  pending[index] = { ...edit, status: 'withdrawn', resolved_at: ctx.store.now() };
  const note: LeadNote = {
    at: ctx.store.now(),
    session_id: '',
    task_id: edit.task_ids[0]!,
    kind: 'user_edit',
    text: `The user withdrew edit ${editId}, so your plan stays as it is; it no longer waits for you, so do not call edit_board resolve_edit for it:\n${edit.ops.map((op) => `- ${opText(op)}`).join('\n')}`,
  };
  appendNote(ctx, { ...plan, pending_edits: pending }, note, commandId);
}

const planView = (ctx: ControlContext, projectId: string, leadId: string) =>
  planViews(ctx, projectId).find((view) => view.lead_session_id === leadId)!;

export const projectBoardHandlers: Handlers = {
  // Each lead owns its own plan row; base_version guards it against a write it has not read.
  'board.plan.update': (ctx, p, c) => {
    const { base_version, ...input } = inputSchemas['board.plan.update'].parse(c.input);
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
      { leadTasks: new Set(input.tasks.map((task) => task.id)) },
    );
    reviewPlan(ctx, ctx.store.must<BoardPlan>('board_plans', p.session_id!), c.command_id);
    return planView(ctx, input.project_id, p.session_id!);
  },
  'board.plan.edit': (ctx, p, c) => {
    const input = inputSchemas['board.plan.edit'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    if (p.role !== 'lead') userOnly(p);
    const leadId = p.role === 'lead' ? p.session_id! : input.lead_session_id;
    requireThat(leadId, 'invalid_input', 'lead_session_id: name the lead whose plan you edit');
    requireThat(
      !input.lead_session_id || input.lead_session_id === leadId,
      'permission_denied',
      'A lead edits only its own plan',
    );
    const plan = ctx.store.get<BoardPlan>('board_plans', leadId);
    requireThat(
      plan?.project_id === input.project_id,
      'not_found',
      `Not found: board plan ${leadId}; write a plan with update_board first`,
    );
    requireVersion(plan, input.base_version);
    if (p.role === 'lead') {
      leadEdit(ctx, p, plan, input.ops, c.command_id);
      reviewPlan(ctx, ctx.store.must<BoardPlan>('board_plans', leadId), c.command_id);
      return planView(ctx, input.project_id, leadId);
    }
    const edit = userEdit(ctx, p, plan, input.ops, input.base_version, c.command_id);
    reviewPlan(ctx, ctx.store.must<BoardPlan>('board_plans', leadId), c.command_id);
    const { plan_version, ...view } = planView(ctx, input.project_id, leadId);
    return { ...view, ...edit, ...(edit.applied ? { plan_version } : {}) };
  },
  'board.plan.propose': (ctx, p, c) => {
    const input = inputSchemas['board.plan.propose'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    const plan = ctx.store.get<BoardPlan>('board_plans', p.session_id!);
    requireThat(
      plan?.project_id === input.project_id,
      'not_found',
      `Not found: board plan ${p.session_id}; write a plan with update_board first`,
    );
    requireVersion(plan, input.base_version);
    const proposals = plan.pending_proposals ?? [];
    requireThat(
      proposals.filter((proposal) => proposal.status === 'pending').length < 8,
      'invalid_input',
      'A lead may have at most 8 pending proposals in one plan',
    );
    const edited = applyOps(planContent(ctx, plan), input.ops);
    refuseInvalid(ctx, edited);
    refuseUnexplained(ctx, plan.id, plan, edited, new Set(input.ops.flatMap(opTaskIds)));
    const proposal: PlanProposal = {
      proposal_id: id(),
      ops: input.ops,
      reason: input.reason,
      base_version: input.base_version,
      created_at: ctx.store.now(),
      status: 'pending',
    };
    const next = ctx.store.update(
      'board_plans',
      { ...plan, pending_proposals: [...proposals, proposal] },
      plan.revision,
    );
    ctx.store.event('board.plan_proposed', next, input.project_id, proposal, c.command_id);
    return { ...planView(ctx, input.project_id, plan.id), proposal_id: proposal.proposal_id };
  },
  'board.plan.proposal.withdraw': (ctx, p, c) => {
    const input = inputSchemas['board.plan.proposal.withdraw'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    const plan = ctx.store.get<BoardPlan>('board_plans', p.session_id!);
    requireThat(
      plan?.project_id === input.project_id,
      'not_found',
      `Not found: board plan ${p.session_id}`,
    );
    const proposals = plan.pending_proposals ?? [];
    const proposal = proposals.find(
      (entry) => entry.proposal_id === input.proposal_id && entry.status === 'pending',
    );
    requireThat(proposal, 'not_found', `Not found: pending plan proposal ${input.proposal_id}`);
    const resolved: PlanProposal = {
      ...proposal,
      status: 'withdrawn',
      resolved_at: ctx.store.now(),
    };
    const next = ctx.store.update(
      'board_plans',
      {
        ...plan,
        pending_proposals: proposals.map((entry) => (entry === proposal ? resolved : entry)),
      },
      plan.revision,
    );
    ctx.store.event(
      'board.plan_proposal_withdrawn',
      next,
      input.project_id,
      resolved,
      c.command_id,
    );
    return planView(ctx, input.project_id, plan.id);
  },
  'board.plan.proposal.resolve': (ctx, p, c) => {
    const input = inputSchemas['board.plan.proposal.resolve'].parse(c.input);
    userOnly(p);
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(
      input.decision !== 'reject' || !input.ops,
      'invalid_input',
      'ops cannot accompany a rejection',
    );
    const plan = ctx.store.get<BoardPlan>('board_plans', input.lead_session_id);
    requireThat(
      plan?.project_id === input.project_id,
      'not_found',
      `Not found: board plan ${input.lead_session_id}`,
    );
    const proposals = plan.pending_proposals ?? [];
    const proposal = proposals.find(
      (entry) => entry.proposal_id === input.proposal_id && entry.status === 'pending',
    );
    requireThat(proposal, 'not_found', `Not found: pending plan proposal ${input.proposal_id}`);
    const ops = input.ops ?? proposal.ops;
    // Ops the user wrote at acceptance are checked as a user edit is.
    const applied =
      input.decision !== 'accept'
        ? plan
        : input.ops
          ? storePlan(ctx, p, plan.id, applyOps(planContent(ctx, plan), input.ops), c.command_id, {
              quoted: input.ops.flatMap((op) => (op.type === 'add_task' ? op.task.source : [])),
            })
          : leadEdit(ctx, p, plan, ops, c.command_id);
    const resolved: PlanProposal = {
      ...proposal,
      status: input.decision === 'accept' ? 'accepted' : 'rejected',
      ...(input.reason ? { resolution_reason: input.reason } : {}),
      resolved_at: ctx.store.now(),
    };
    const next = appendNote(
      ctx,
      {
        ...applied,
        pending_proposals: proposals.map((entry) => (entry === proposal ? resolved : entry)),
      },
      {
        at: ctx.store.now(),
        session_id: '',
        task_id: ops.flatMap(opTaskIds)[0] ?? '',
        kind: 'user_edit',
        text: `The user chose to ${input.decision} plan proposal ${proposal.proposal_id}${input.reason ? `: ${input.reason}` : ''}${input.decision === 'accept' && input.ops ? `\nThe user changed the ops that applied:\n${ops.map((op) => `- ${opText(op)}`).join('\n')}` : ''}`,
      },
      c.command_id,
    );
    ctx.store.event('board.plan_proposal_resolved', next, input.project_id, resolved, c.command_id);
    if (input.decision === 'accept') reviewPlan(ctx, next, c.command_id);
    // The lead waits on its proposal, and only the lead starts a task it adds.
    wakeLead(ctx, ctx.store.must<BoardPlan>('board_plans', plan.id), c.command_id);
    return planView(ctx, input.project_id, plan.id);
  },
  'board.plan.edit.withdraw': (ctx, p, c) => {
    const input = inputSchemas['board.plan.edit.withdraw'].parse(c.input);
    userOnly(p);
    projectAccess(ctx, p, input.project_id, c.type);
    const plan = ctx.store.get<BoardPlan>('board_plans', input.lead_session_id);
    requireThat(
      plan?.project_id === input.project_id,
      'not_found',
      `Not found: board plan ${input.lead_session_id}`,
    );
    withdrawEdit(ctx, plan, input.edit_id, c.command_id);
    return planView(ctx, input.project_id, input.lead_session_id);
  },
};
