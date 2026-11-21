import { useSyncExternalStore } from 'react';
import type { FlowPath } from '@pantheon/domain';
import type { BoardModel, CommandType } from '@pantheon/protocol';
import { currentLocale, t } from '../i18n';
import { listText } from '../lib/list-text';
import { runtimeName, TASK_TYPE } from '../screens/board/status';
import { EFFORT_LABEL } from '../screens/sessions/model';
import { runCommand } from './commands';
import { failureText } from './needs-you';
import { useProjectQuery, type ProjectRead } from './project-read';
import { kindText, PATH_LABEL } from './workflow-policy';
import { planTaskIds } from './task-trace';

type Board = Pick<BoardModel, 'tasks' | 'edges'>;
type Task = BoardModel['tasks'][number];
type Lead = NonNullable<BoardModel['leads']>[number];
export type PlanOp = NonNullable<Lead['rejected_edits']>[number]['ops'][number];
type Patch = Extract<PlanOp, { type: 'set_task' }>['patch'];

/** The task.stop reason of a stop from the board. */
export const STOP_REASON = 'The user stopped this task from the board.';

/** Where a user's command about one plan task goes. */
export interface EditTarget {
  projectId: string;
  leadId: string;
  /** The task's id in the lead's plan. */
  planId: string;
  /** The task's board id. */
  taskId: string;
}

/** The target of a plan task whose lead session is known; null for any other row. */
export function editTarget(
  task: Pick<Task, 'id' | 'owner_session_id'>,
  sessions: readonly { id: string; project_id: string }[],
): EditTarget | null {
  const leadId = task.owner_session_id;
  const projectId = leadId && sessions.find((s) => s.id === leadId)?.project_id;
  if (!leadId || !projectId) return null;
  return { projectId, leadId, planId: planTaskIds(task.id).task, taskId: task.id };
}

export const planVersion = (model: Pick<BoardModel, 'leads'>, leadId: string): number =>
  model.leads?.find((l) => l.session_id === leadId)?.plan_version ?? 0;

/** Plan ids of the tasks the task depends on, in the plan's order. */
export const dependencies = (model: Pick<BoardModel, 'tasks'>, taskId: string): string[] =>
  model.tasks.find((t) => t.id === taskId)?.depends_on ?? [];

const setDependencies = (taskId: string, depends_on: string[]): PlanOp => ({
  type: 'set_dependencies',
  task_id: planTaskIds(taskId).task,
  depends_on,
});

export const withoutDependency = (model: Board, from: string, to: string): PlanOp =>
  setDependencies(
    to,
    dependencies(model, to).filter((id) => id !== planTaskIds(from).task),
  );

export const withDependency = (model: Board, from: string, to: string): PlanOp =>
  setDependencies(to, [...dependencies(model, to), planTaskIds(from).task]);

/** Why `to` cannot depend on `from`; null when it can. */
export function connectRefusal(
  model: Board,
  from: string,
  to: string,
): 'self' | 'other_plan' | 'exists' | 'cycle' | null {
  if (from === to) return 'self';
  const lead = (id: string) => model.tasks.find((t) => t.id === id)?.owner_session_id;
  if (!lead(from) || lead(from) !== lead(to)) return 'other_plan';
  if (model.edges.some((e) => e.from === from && e.to === to)) return 'exists';
  const seen = new Set([to]);
  for (const at of seen) {
    if (at === from) return 'cycle';
    for (const e of model.edges) if (e.from === at) seen.add(e.to);
  }
  return null;
}

export interface Change {
  field: string;
  /** Null when the field had no value, or the op adds the task. */
  before: string | null;
  /** Null when the op removes the task. */
  after: string | null;
}

// Labels are getters, so each is read in the language loaded by then.
export const PRIORITY: Record<'high' | 'normal' | 'low', string> = {
  get high() {
    return t({ id: 'data.planEdit.priority.high', defaultMessage: 'High' });
  },
  get normal() {
    return t({ id: 'data.planEdit.priority.normal', defaultMessage: 'Normal' });
  },
  get low() {
    return t({ id: 'data.planEdit.priority.low', defaultMessage: 'Low' });
  },
};
export const DONE_WHEN: Record<'merged' | 'report', string> = {
  get merged() {
    return t({ id: 'data.planEdit.doneWhen.merged', defaultMessage: 'Merge' });
  },
  get report() {
    return t({ id: 'data.planEdit.doneWhen.report', defaultMessage: 'Report' });
  },
};
const PATCH_FIELDS: { key: keyof Patch; field: string }[] = [
  {
    key: 'title',
    get field() {
      return t({ id: 'data.planEdit.field.title', defaultMessage: 'Title' });
    },
  },
  {
    key: 'runtime',
    get field() {
      return t({ id: 'data.planEdit.field.runtime', defaultMessage: 'Runtime' });
    },
  },
  {
    key: 'model',
    get field() {
      return t({ id: 'data.planEdit.field.model', defaultMessage: 'Model' });
    },
  },
  {
    key: 'effort',
    get field() {
      return t({ id: 'data.planEdit.field.effort', defaultMessage: 'Effort' });
    },
  },
  {
    key: 'lane',
    get field() {
      return t({ id: 'data.planEdit.field.lane', defaultMessage: 'Lane' });
    },
  },
  {
    key: 'priority',
    get field() {
      return t({ id: 'data.planEdit.field.priority', defaultMessage: 'Priority' });
    },
  },
  {
    key: 'kind',
    get field() {
      return t({ id: 'data.planEdit.field.kind', defaultMessage: 'Kind' });
    },
  },
  {
    key: 'task_type',
    get field() {
      return t({ id: 'data.planEdit.field.taskType', defaultMessage: 'Type' });
    },
  },
  {
    key: 'token_budget',
    get field() {
      return t({ id: 'data.planEdit.field.tokenBudget', defaultMessage: 'Budget' });
    },
  },
  {
    key: 'route_reason',
    get field() {
      return t({ id: 'data.planEdit.field.routeReason', defaultMessage: 'Routing reason' });
    },
  },
  {
    key: 'goal',
    get field() {
      return t({ id: 'data.planEdit.field.goal', defaultMessage: 'Goal' });
    },
  },
  {
    key: 'scope',
    get field() {
      return t({ id: 'data.planEdit.field.scope', defaultMessage: 'Scope' });
    },
  },
  {
    key: 'acceptance',
    get field() {
      return t({ id: 'data.planEdit.field.acceptance', defaultMessage: 'Acceptance' });
    },
  },
  {
    key: 'done_when',
    get field() {
      return t({ id: 'data.planEdit.field.doneWhen', defaultMessage: 'Done when' });
    },
  },
  {
    key: 'milestone',
    get field() {
      return t({ id: 'data.planEdit.field.milestone', defaultMessage: 'Milestone' });
    },
  },
  {
    key: 'path',
    get field() {
      return t({ id: 'data.planEdit.field.path', defaultMessage: 'Flow path' });
    },
  },
];
/** Fields an added task lists on lines of their own, so only a set_task change lists them here. */
const MORE_PATCH_FIELDS: { key: keyof Patch; field: string }[] = [
  {
    key: 'flow_reason',
    get field() {
      return t({ id: 'data.planEdit.field.flowReason', defaultMessage: 'Flow path reason' });
    },
  },
  {
    key: 'iteration',
    get field() {
      return t({ id: 'data.planEdit.field.iteration', defaultMessage: 'Iteration' });
    },
  },
  {
    key: 'estimate',
    get field() {
      return t({ id: 'data.planEdit.field.estimate', defaultMessage: 'Estimate' });
    },
  },
  {
    key: 'device',
    get field() {
      return t({ id: 'data.planEdit.field.device', defaultMessage: 'Device' });
    },
  },
  {
    key: 'device_reason',
    get field() {
      return t({ id: 'data.planEdit.field.deviceReason', defaultMessage: 'Device reason' });
    },
  },
  {
    key: 'needs',
    get field() {
      return t({ id: 'data.planEdit.field.needs', defaultMessage: 'Needs' });
    },
  },
  {
    key: 'uses',
    get field() {
      return t({ id: 'data.planEdit.field.uses', defaultMessage: 'Uses' });
    },
  },
  {
    key: 'parallel',
    get field() {
      return t({ id: 'data.planEdit.field.parts', defaultMessage: 'Parallel parts' });
    },
  },
];

/** A token budget in the locale's short form, such as 300K tokens. */
export const tokenBudgetText = (tokens: number): string =>
  t(
    { id: 'data.planEdit.tokenBudget', defaultMessage: '{amount} tokens' },
    {
      amount: new Intl.NumberFormat(currentLocale(), {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(tokens),
    },
  );

/** A typed token budget: null when blank, a positive whole number, or 'invalid'. */
export function parseTokenBudget(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tokens = Number(trimmed);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 'invalid';
}

/** The first entry is cut to this many characters in a change. */
const ENTRY_SUMMARY = 40;

const none = () => t({ id: 'data.planEdit.none', defaultMessage: 'None' });
const runtimeDefault = () =>
  t({ id: 'data.planEdit.runtimeDefault', defaultMessage: 'Runtime default' });

const entries = (items: string[] | undefined): string | null => {
  if (!items) return null;
  const first = items[0];
  if (first === undefined) return none();
  return t(
    {
      id: 'data.planEdit.entries',
      defaultMessage: '{count, plural, one {# entry} other {# entries}}: {first}',
    },
    {
      count: items.length,
      first: first.length > ENTRY_SUMMARY ? `${first.slice(0, ENTRY_SUMMARY - 1)}…` : first,
    },
  );
};

const estimateText = (points: number) =>
  t(
    {
      id: 'data.planEdit.estimate',
      defaultMessage: '{points, plural, one {# point} other {# points}}',
    },
    { points },
  );

const usesText = (uses: Record<string, number>) =>
  Object.entries(uses).map(([resource, count]) =>
    t({ id: 'data.planEdit.uses', defaultMessage: '{resource} × {count}' }, { resource, count }),
  );

/** A patch field's value as the change lists write it; null when the patch leaves it out. */
function patchValue(
  model: Pick<BoardModel, 'lanes'> & Partial<Pick<BoardModel, 'iterations'>>,
  leadId: string,
  key: keyof Patch,
  patch: Patch,
): string | null {
  switch (key) {
    case 'scope':
    case 'acceptance':
      return entries(patch[key]);
    case 'done_when':
      return patch.done_when ? DONE_WHEN[patch.done_when] : null;
    case 'milestone':
      return patch.milestone === null ? none() : (patch.milestone ?? null);
    case 'runtime':
      return patch.runtime ? runtimeName(patch.runtime) : null;
    case 'model':
      return patch.model === null ? runtimeDefault() : (patch.model ?? null);
    case 'effort':
      return patch.effort === null
        ? runtimeDefault()
        : patch.effort
          ? EFFORT_LABEL[patch.effort]
          : null;
    case 'lane':
      return patch.lane
        ? (model.lanes.find((l) => l.id === `${leadId}:${patch.lane}`)?.title ?? patch.lane)
        : null;
    case 'priority':
      return patch.priority ? PRIORITY[patch.priority] : null;
    case 'kind':
      return patch.kind ? kindText(patch.kind.domain, patch.kind.tier) : null;
    case 'task_type':
      return patch.task_type === null
        ? none()
        : patch.task_type
          ? TASK_TYPE[patch.task_type].label
          : null;
    case 'token_budget':
      return patch.token_budget === null
        ? none()
        : patch.token_budget
          ? tokenBudgetText(patch.token_budget)
          : null;
    case 'path':
      return patch.path === null
        ? t({ id: 'data.planEdit.path.default', defaultMessage: 'Follow the default' })
        : patch.path
          ? PATH_LABEL[patch.path]
          : null;
    case 'iteration':
      return patch.iteration === null
        ? none()
        : patch.iteration
          ? (model.iterations?.find((i) => i.id === `${leadId}:${patch.iteration}`)?.title ??
            patch.iteration)
          : null;
    case 'estimate':
      return patch.estimate === undefined ? null : estimateText(patch.estimate);
    case 'needs':
      return patch.needs ? (patch.needs.length ? listText(...patch.needs) : none()) : null;
    case 'uses':
      return patch.uses ? listText(...usesText(patch.uses)) || none() : null;
    case 'parallel':
      return patch.parallel ? listText(...patch.parallel.map((p) => p.title)) : null;
    default:
      return (patch[key] as string | undefined) ?? null;
  }
}

type Iteration = Extract<PlanOp, { type: 'set_iterations' }>['iterations'][number];
const iterationsText = (iterations: readonly Iteration[]) =>
  iterations.length
    ? listText(
        ...iterations.map((i) =>
          t(
            { id: 'data.planEdit.iteration.span', defaultMessage: '{title} {starts} – {ends}' },
            { title: i.title, starts: i.starts_on, ends: i.ends_on },
          ),
        ),
      )
    : none();

/** What an op changes, each value written against the task's current one. */
export function opChanges(
  model: Board & Pick<BoardModel, 'lanes'> & Partial<Pick<BoardModel, 'iterations'>>,
  leadId: string,
  op: PlanOp,
): Change[] {
  // The board names a lead milestone by its own id, not the plan key, so it gives no old value.
  if (op.type === 'set_milestone')
    return [
      ...(op.patch.title !== undefined
        ? [
            {
              field: t({ id: 'data.planEdit.field.title', defaultMessage: 'Title' }),
              before: null,
              after: op.patch.title,
            },
          ]
        : []),
      ...(op.patch.due_on !== undefined
        ? [
            {
              field: t({ id: 'data.planEdit.field.dueOn', defaultMessage: 'Due' }),
              before: null,
              after: op.patch.due_on ?? none(),
            },
          ]
        : []),
    ];
  if (op.type === 'set_iterations')
    return [
      {
        field: t({ id: 'data.planEdit.field.iterations', defaultMessage: 'Iterations' }),
        before: iterationsText(
          (model.iterations ?? []).filter((i) => i.id.startsWith(`${leadId}:`)),
        ),
        after: iterationsText(op.iterations),
      },
    ];
  if (op.type === 'add_task')
    return [
      {
        field: t({ id: 'data.planEdit.field.task', defaultMessage: 'Task' }),
        before: null,
        after: op.task.title,
      },
    ];
  const id = `${leadId}:${op.task_id}`;
  const task = model.tasks.find((t) => t.id === id);
  if (op.type === 'remove_task')
    return [
      {
        field: t({ id: 'data.planEdit.field.task', defaultMessage: 'Task' }),
        before: task?.title ?? op.task_id,
        after: null,
      },
    ];
  const title = (planId: string) =>
    model.tasks.find((t) => t.id === `${leadId}:${planId}`)?.title ?? planId;
  const titles = (ids: string[]) =>
    ids.length
      ? listText(...ids.map(title))
      : t({ id: 'data.planEdit.none', defaultMessage: 'None' });
  if (op.type === 'move_task')
    return [
      {
        field: t({ id: 'data.planEdit.field.order', defaultMessage: 'Order' }),
        before: null,
        after:
          op.before === null
            ? t({ id: 'data.planEdit.order.end', defaultMessage: 'Last' })
            : t(
                { id: 'data.planEdit.order.before', defaultMessage: 'Before {title}' },
                { title: title(op.before) },
              ),
      },
    ];
  if (op.type === 'set_dependencies')
    return [
      {
        field: t({ id: 'data.planEdit.field.dependencies', defaultMessage: 'Dependencies' }),
        before: titles(dependencies(model, id)),
        after: titles(op.depends_on),
      },
    ];
  // Scope, acceptance, done_when, the milestone key, the flow path reason and the parts
  // take no old value from the board here.
  const now: Patch = task
    ? {
        ...task.planned,
        task_type: task.task_type,
        token_budget: task.token_budget,
        title: task.title,
        goal: task.goal,
        lane: task.lane_id?.slice(leadId.length + 1),
        iteration: task.iteration_id?.slice(leadId.length + 1) ?? null,
        estimate: task.estimate,
      }
    : {};
  return [...PATCH_FIELDS, ...MORE_PATCH_FIELDS]
    .filter(({ key }) => op.patch[key] !== undefined)
    .map(({ key, field }) => ({
      field,
      before: patchValue(model, leadId, key, now),
      after: patchValue(model, leadId, key, op.patch),
    }));
}

/** One field of a task's contract with its values, each on its own line. */
export interface ContractField {
  field: string;
  values: string[];
}

const CONTRACT_FIRST: readonly (keyof Patch)[] = ['goal', 'scope', 'acceptance'];

/** The contract of a task an op adds, all but its title; fields the task leaves out are left out. */
export function addedTaskFields(
  model: Pick<BoardModel, 'lanes'> & Partial<Pick<BoardModel, 'iterations'>>,
  leadId: string,
  task: Extract<PlanOp, { type: 'add_task' }>['task'],
): ContractField[] {
  const own = [
    ...CONTRACT_FIRST.map((key) => PATCH_FIELDS.find((f) => f.key === key)!),
    ...PATCH_FIELDS.filter(({ key }) => key !== 'title' && !CONTRACT_FIRST.includes(key)),
  ].map(({ key, field }) => ({
    field,
    values:
      key === 'scope' || key === 'acceptance'
        ? task[key]
        : [patchValue(model, leadId, key, task)].filter((v): v is string => !!v),
  }));
  const iteration =
    task.iteration &&
    (model.iterations?.find((i) => i.id === `${leadId}:${task.iteration}`)?.title ??
      task.iteration);
  const more: ContractField[] = [
    {
      field: t({ id: 'data.planEdit.field.iteration', defaultMessage: 'Iteration' }),
      values: iteration ? [iteration] : [],
    },
    {
      field: t({ id: 'data.planEdit.field.estimate', defaultMessage: 'Estimate' }),
      values: task.estimate === undefined ? [] : [estimateText(task.estimate)],
    },
    {
      field: t({ id: 'data.planEdit.field.device', defaultMessage: 'Device' }),
      values: task.device ? [task.device, ...(task.device_reason ? [task.device_reason] : [])] : [],
    },
    {
      field: t({ id: 'data.planEdit.field.needs', defaultMessage: 'Needs' }),
      values: task.needs ?? [],
    },
    {
      field: t({ id: 'data.planEdit.field.uses', defaultMessage: 'Uses' }),
      values: usesText(task.uses ?? {}),
    },
    {
      field: t({ id: 'data.planEdit.field.parts', defaultMessage: 'Parallel parts' }),
      values: (task.parallel ?? []).map(({ title, goal }) =>
        t({ id: 'data.planEdit.part', defaultMessage: '{title}: {goal}' }, { title, goal }),
      ),
    },
  ];
  return [...own, ...more].filter((f) => f.values.length > 0);
}

/** Which of the board's task commands apply to the task now. */
export function taskActions(task: Pick<Task, 'state' | 'claim' | 'dispatch_wait'>) {
  const ended = task.state === 'merged' || task.state === 'failed';
  return {
    edit: task.state !== 'merged',
    // A start request waiting, or a session not discarded that has not ended the task.
    stop: !!task.dispatch_wait || (!!task.claim && !ended),
    restart: task.state === 'failed',
    remove: task.state !== 'merged',
  };
}

export type EditOutcome =
  | { kind: 'sending' }
  /** version: the plan's version after the edit, where the daemon's answer names it. */
  | { kind: 'applied'; version?: number }
  | { kind: 'pending'; editId: string }
  /** The plan moved past the version the edit was based on, so it was not sent. */
  | { kind: 'conflict'; ops: PlanOp[]; base: number }
  | { kind: 'failed'; text: string };

/** A command's last outcome; ops are set when the command was a plan edit. */
export interface SentEdit {
  target: EditTarget;
  outcome: EditOutcome;
  ops?: PlanOp[];
}

// The last command's outcome by board task id, shared by the chart, the drawer and the edit list.
const outcomes = new Map<string, SentEdit>();
let sentList: readonly SentEdit[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function settle(target: EditTarget | string, outcome: EditOutcome | null, ops?: PlanOp[]) {
  const taskId = typeof target === 'string' ? target : target.taskId;
  if (outcome && typeof target !== 'string')
    outcomes.set(taskId, { target, outcome, ...(ops ? { ops } : {}) });
  else outcomes.delete(taskId);
  sentList = [...outcomes.values()];
  listeners.forEach((listener) => listener());
}

export const clearPlanEdit = (taskId: string) => settle(taskId, null);

/** Forgets the task's last outcome unless it is a conflict, which waits for a resend or a discard. */
export function releasePlanEdit(taskId: string) {
  if (outcomes.get(taskId)?.outcome.kind !== 'conflict') clearPlanEdit(taskId);
}

/** Sends ops on the given plan version; whether they took effect is the daemon's answer. */
export async function editPlan(
  target: EditTarget,
  ops: PlanOp[],
  base: number,
): Promise<EditOutcome> {
  settle(target, { kind: 'sending' }, ops);
  const outcome = await sendPlanEdit(target, ops, base);
  settle(target, outcome, ops);
  return outcome;
}

/** The daemon's answer to ops sent on a plan version, kept out of the outcomes this window shows. */
export async function sendPlanEdit(
  target: EditTarget,
  ops: PlanOp[],
  base: number,
): Promise<Exclude<EditOutcome, { kind: 'sending' }>> {
  const result = await runCommand(
    'board.plan.edit',
    { project_id: target.projectId, lead_session_id: target.leadId, base_version: base, ops },
    null,
  );
  const value = result.ok
    ? (result.value as { applied?: boolean; edit_id?: string; plan_version?: number })
    : null;
  return result.ok
    ? value?.applied
      ? {
          kind: 'applied',
          ...(typeof value.plan_version === 'number' ? { version: value.plan_version } : {}),
        }
      : { kind: 'pending', editId: String(value?.edit_id) }
    : result.error.code === 'revision_conflict'
      ? { kind: 'conflict', ops, base }
      : { kind: 'failed', text: failureText(result.error) };
}

const leadCommand = async (target: EditTarget, type: CommandType, input: object) => {
  const result = await runCommand(
    type,
    { project_id: target.projectId, lead_session_id: target.leadId, ...input },
    null,
  );
  return result.ok ? null : failureText(result.error);
};

/** Resolves to why the daemon refused the command, or null. */
async function taskCommand(target: EditTarget, type: CommandType, input: object) {
  settle(target, { kind: 'sending' });
  const failure = await leadCommand(target, type, input);
  settle(target, failure === null ? null : { kind: 'failed', text: failure });
  return failure;
}

/** Takes back an edit that waits for the lead; resolves to why the daemon refused, or null. */
export async function withdrawPlanEdit(target: EditTarget, editId: string) {
  const sent = outcomes.get(target.taskId);
  if (sent?.outcome.kind !== 'pending' || sent.outcome.editId !== editId)
    return taskCommand(target, 'board.plan.edit.withdraw', { edit_id: editId });
  // The edit this window holds keeps its row, ops and id until the daemon has taken it back.
  const failure = await leadCommand(target, 'board.plan.edit.withdraw', { edit_id: editId });
  if (failure === null && outcomes.get(target.taskId) === sent) clearPlanEdit(target.taskId);
  return failure;
}

export type PlanProposal = NonNullable<Lead['pending_proposals']>[number];

/** The heading of a lead's plan proposal, by the lead session's title. */
export const proposalTitle = (lead: string) =>
  t({ id: 'board.plan.proposal.title', defaultMessage: '{lead} proposes a plan change' }, { lead });

/**
 * Accepts a lead's proposal, with ops in place of its own when given, or rejects it; the failure
 * text, or null once the daemon took the decision.
 */
export async function resolvePlanProposal(
  projectId: string,
  proposal: Pick<PlanProposal, 'id' | 'lead_session_id'>,
  decision: { decision: 'accept'; ops?: PlanOp[] } | { decision: 'reject'; reason?: string },
): Promise<string | null> {
  const result = await runCommand(
    'board.plan.proposal.resolve',
    {
      project_id: projectId,
      lead_session_id: proposal.lead_session_id,
      proposal_id: proposal.id,
      ...decision,
    },
    null,
  );
  return result.ok ? null : failureText(result.error);
}

/** The task's last command outcome and the commands the drawer sends for it. */
export function usePlanEdit(model: Pick<BoardModel, 'leads'>, target: EditTarget) {
  const outcome = useSyncExternalStore(
    subscribe,
    () => outcomes.get(target.taskId)?.outcome ?? null,
    () => null,
  );
  const base = () => planVersion(model, target.leadId);
  return {
    outcome,
    edit: (ops: PlanOp[], on = base()) => editPlan(target, ops, on),
    retry: () => {
      if (outcome?.kind === 'conflict') void editPlan(target, outcome.ops, base());
    },
    discard: () => clearPlanEdit(target.taskId),
    stop: () => taskCommand(target, 'task.stop', { task_id: target.planId, reason: STOP_REASON }),
    restart: () => taskCommand(target, 'task.start', { task_ids: [target.planId] }),
    withdraw: (editId: string) => withdrawPlanEdit(target, editId),
  };
}

/**
 * When an edit takes effect: now, or once the lead decides. The daemon applies at once an edit that
 * adds or moves tasks, only changes record fields, or touches no task with an unfinished session.
 */
export type EditTiming = 'now' | 'lead';

const RECORD_FIELDS: readonly string[] = [
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

export function editTiming(
  model: Pick<BoardModel, 'tasks'>,
  leadId: string,
  ops: readonly PlanOp[],
): EditTiming {
  const held = ops.some((op) => {
    if (
      op.type === 'add_task' ||
      op.type === 'move_task' ||
      op.type === 'set_iterations' ||
      op.type === 'set_milestone'
    )
      return false;
    if (op.type === 'set_task' && Object.keys(op.patch).every((k) => RECORD_FIELDS.includes(k)))
      return false;
    const task = model.tasks.find((t) => t.id === `${leadId}:${op.task_id}`);
    const ended = task?.state === 'merged' || task?.state === 'failed';
    return !!task?.claim && !ended;
  });
  return held ? 'lead' : 'now';
}

/** The set_milestone op that gives a lead milestone, by its plan key, a due day; null takes it away. */
export const milestoneDueOp = (milestoneKey: string, dueOn: string | null): PlanOp => ({
  type: 'set_milestone',
  milestone_id: milestoneKey,
  patch: { due_on: dueOn },
});

/** A plan task's contract as the drawer edits it. */
export interface Contract {
  goal: string;
  scope: string[];
  acceptance: string[];
  done_when: 'merged' | 'report';
  /** The lead's milestone id; null outside every milestone. */
  milestone: string | null;
  /** The flow path the task names; null follows its tier's. */
  path: FlowPath | null;
}

const entriesOf = (items: readonly string[]) => items.map((s) => s.trim()).filter(Boolean);
const sameEntries = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((s, i) => s === b[i]);

/** The set_task patch of the fields `after` changes, blank list entries left out. */
export function contractPatch(before: Contract, after: Contract): Patch {
  const goal = after.goal.trim();
  const scope = entriesOf(after.scope);
  const acceptance = entriesOf(after.acceptance);
  return {
    ...(goal !== before.goal ? { goal } : {}),
    ...(!sameEntries(scope, before.scope) ? { scope } : {}),
    ...(!sameEntries(acceptance, before.acceptance) ? { acceptance } : {}),
    ...(after.done_when !== before.done_when ? { done_when: after.done_when } : {}),
    ...(after.milestone !== before.milestone ? { milestone: after.milestone } : {}),
    ...(after.path !== before.path ? { path: after.path } : {}),
  };
}

/** The lists the protocol refuses empty: a task done by merging needs scope and acceptance. */
export function contractProblem(contract: Contract): ('scope' | 'acceptance')[] {
  if (contract.done_when !== 'merged') return [];
  return (['scope', 'acceptance'] as const).filter((key) => !entriesOf(contract[key]).length);
}

const isProjectRead = (value: unknown): boolean => {
  const read = value as Partial<ProjectRead> | null;
  return !!read && Array.isArray(read.plans) && Array.isArray(read.milestones);
};

/**
 * The task's contract and its lead's milestones, read from project.read since the board view has
 * no scope, acceptance, done_when or milestone id; null contract until the read lands. stale and
 * error are those of the read, which then may be older than the plan; version is the plan version
 * the read is of.
 */
export function usePlanContract(target: EditTarget): {
  contract: Contract | null;
  version: number | null;
  milestones: { id: string; title: string }[];
  stale: boolean;
  error: string | null;
  reload: () => void;
} {
  const { read, stale, error, reload } = useProjectQuery<ProjectRead>(
    'project.read',
    target.projectId,
    isProjectRead,
    undefined,
    { events: true },
  );
  const plan = read?.plans.find((p) => p.lead_session_id === target.leadId);
  const task = plan?.tasks.find((t) => t.id === target.planId);
  const milestones = (read?.milestones ?? []).flatMap(({ milestone: m }) =>
    m.owner_session_id === target.leadId && m.key ? [{ id: m.key, title: m.title }] : [],
  );
  return {
    contract: task
      ? {
          goal: task.goal,
          scope: task.scope,
          acceptance: task.acceptance,
          done_when: task.done_when ?? 'merged',
          milestone: task.milestone ?? null,
          path: task.path ?? null,
        }
      : null,
    version: plan?.plan_version ?? null,
    milestones,
    stale,
    error,
    reload,
  };
}

/** The lead's plan tasks on the board, in plan order. */
function planOrder(model: Pick<BoardModel, 'tasks'>, leadId: string) {
  return model.tasks
    .filter((t) => t.owner_session_id === leadId && t.order !== undefined)
    .sort((a, b) => a.order! - b.order!);
}

/**
 * The move_task op that puts a task where another task of the same lead is now: before it when
 * moving up, after it when moving down. Null when the move would change nothing or cross plans.
 */
export function moveTaskOp(
  model: Pick<BoardModel, 'tasks'>,
  taskId: string,
  toId: string,
): PlanOp | null {
  const leadId = model.tasks.find((t) => t.id === taskId)?.owner_session_id;
  if (!leadId || taskId === toId) return null;
  const order = planOrder(model, leadId);
  const from = order.findIndex((t) => t.id === taskId);
  const to = order.findIndex((t) => t.id === toId);
  if (from < 0 || to < 0) return null;
  const before = from > to ? order[to] : order[to + 1];
  return {
    type: 'move_task',
    task_id: planTaskIds(taskId).task,
    before: before ? planTaskIds(before.id).task : null,
  };
}

/** An edit of the project's plans that has not taken effect. */
export interface UnsentEdit {
  key: string;
  target: EditTarget;
  ops: PlanOp[];
  status: 'sending' | 'conflict' | 'failed' | 'pending';
  timing: EditTiming;
  /** The held edit's id, on a pending one. */
  editId?: string;
  /** When the board says the held edit was made, epoch milliseconds. */
  createdAt?: number;
  /** The daemon's failure, on a failed one. */
  text?: string;
}

/**
 * The project's plan edits sending, conflicting or failed, then those the board holds for the lead;
 * a pending one this window sent shows only while its lead's board row lists no held edits.
 */
export function unsentEdits(
  model: Pick<BoardModel, 'tasks' | 'leads'>,
  projectId: string,
  sent: readonly SentEdit[],
): UnsentEdit[] {
  const boardHolds = (leadId: string) =>
    model.leads?.find((l) => l.session_id === leadId)?.pending_edits !== undefined;
  const local = sent.flatMap(({ target, outcome, ops }): UnsentEdit[] => {
    if (!ops || target.projectId !== projectId) return [];
    if (outcome.kind === 'applied') return [];
    if (outcome.kind === 'pending' && boardHolds(target.leadId)) return [];
    return [
      {
        key: `sent:${target.taskId}`,
        target,
        ops,
        status: outcome.kind,
        timing: editTiming(model, target.leadId, ops),
        ...(outcome.kind === 'failed' ? { text: outcome.text } : {}),
        ...(outcome.kind === 'pending' ? { editId: outcome.editId } : {}),
      },
    ];
  });
  const held = (model.leads ?? []).flatMap((lead) =>
    (lead.pending_edits ?? []).map((e): UnsentEdit => {
      const planId = e.task_ids[0] ?? '';
      const ops = e.ops ?? [];
      return {
        key: `held:${e.id}`,
        target: {
          projectId,
          leadId: lead.session_id,
          planId,
          taskId: `${lead.session_id}:${planId}`,
        },
        ops,
        status: 'pending',
        timing: editTiming(model, lead.session_id, ops),
        editId: e.id,
        ...(e.created_at !== undefined ? { createdAt: e.created_at } : {}),
      };
    }),
  );
  return [...local, ...held];
}

/** The project's unsent plan edits, kept current with the commands sent from this window. */
export function useUnsentEdits(
  model: Pick<BoardModel, 'tasks' | 'leads'>,
  projectId: string,
): UnsentEdit[] {
  const sent = useSyncExternalStore(
    subscribe,
    () => sentList,
    () => sentList,
  );
  return unsentEdits(model, projectId, sent);
}
