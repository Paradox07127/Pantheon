import { useId, useState, type FormEvent, type Ref } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Plus, X } from 'lucide-react';
import type { FlowPath } from '@pantheon/domain';
import type { BoardModel } from '@pantheon/protocol';
import { Menu, MenuItem } from '../../components/Menu';
import { Select } from '../../components/Select';
import { Tip } from '../../components/Tip';
import { useDraftEdits } from '../../data/plan-draft';
import { parseTokenBudget, type PlanOp } from '../../data/plan-edit';
import { planTaskIds } from '../../data/task-trace';
import { t } from '../../i18n';
import {
  budgetField,
  pathField,
  PLAN_TITLE_MAX,
  priorityField,
  typeField,
  useRouteFields,
  type Route,
} from './PlanEdit';
import type { TaskType } from './status';
import './edits.css';

type AddTask = Extract<PlanOp, { type: 'add_task' }>;
type PlanTask = AddTask['task'];

// The protocol's limits on a plan task.
const GOAL_MAX = 400;
const MAX_DEPENDENCIES = 16;
const SCOPE_MAX = 200;
const MAX_SCOPE = 16;
const ACCEPTANCE_MAX = 400;
const MAX_ACCEPTANCE = 8;
const ID_MAX = 40;

/** What the user typed into the new task form. */
export interface NewTaskDraft {
  title: string;
  goal: string;
  /** A lane id of the lead's plan. */
  lane: string;
  /** Plan ids of the tasks it waits for. */
  dependsOn: string[];
  /** One repository path per line. */
  scope: string;
  /** One shell command per line. */
  acceptance: string;
  priority: NonNullable<PlanTask['priority']>;
  doneWhen: NonNullable<PlanTask['done_when']>;
  route: Route;
  /** Null follows the tier's flow path. */
  path: FlowPath | null;
  /** An iteration id of the lead's plan; null outside every iteration. */
  iteration: string | null;
  /** Null leaves the task without a type. */
  taskType: TaskType | null;
  /** Tokens as typed; blank sets no budget. */
  budget: string;
}

export type DraftProblem =
  'title' | 'goal' | 'lane' | 'dependencies' | 'scope' | 'acceptance' | 'budget';

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** A plan id from the title, lower-case letters, digits and hyphens, that no taken id has. */
export function newTaskId(title: string, taken: ReadonlySet<string>): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, ID_MAX - 3)
      .replace(/-+$/, '') || 'task';
  let id = slug;
  for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
  return id;
}

/** The add_task op of a draft, or the first field the protocol would refuse. */
export function newTaskOp(
  draft: NewTaskDraft,
  taken: ReadonlySet<string>,
): { op: AddTask } | { problem: DraftProblem } {
  const title = draft.title.trim();
  const goal = draft.goal.trim();
  const scope = lines(draft.scope);
  const acceptance = lines(draft.acceptance);
  const merged = draft.doneWhen === 'merged';
  if (!title || title.length > PLAN_TITLE_MAX) return { problem: 'title' };
  if (!goal || goal.length > GOAL_MAX) return { problem: 'goal' };
  if (!draft.lane) return { problem: 'lane' };
  if (draft.dependsOn.length > MAX_DEPENDENCIES) return { problem: 'dependencies' };
  if (
    (merged && !scope.length) ||
    scope.length > MAX_SCOPE ||
    scope.some((s) => s.length > SCOPE_MAX)
  )
    return { problem: 'scope' };
  if (
    (merged && !acceptance.length) ||
    acceptance.length > MAX_ACCEPTANCE ||
    acceptance.some((a) => a.length > ACCEPTANCE_MAX)
  )
    return { problem: 'acceptance' };
  const budget = parseTokenBudget(draft.budget);
  if (budget === 'invalid') return { problem: 'budget' };
  const { runtime, model, effort } = draft.route;
  return {
    op: {
      type: 'add_task',
      task: {
        id: newTaskId(title, taken),
        title,
        goal,
        lane: draft.lane,
        depends_on: draft.dependsOn,
        // The user's own words stand for the source quote.
        source: [goal],
        scope,
        acceptance,
        priority: draft.priority,
        done_when: draft.doneWhen,
        ...(runtime ? { runtime } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(draft.iteration ? { iteration: draft.iteration } : {}),
        ...(draft.taskType ? { task_type: draft.taskType } : {}),
        ...(budget !== null ? { token_budget: budget } : {}),
        // The daemon fills in flow_reason only for a set_task.
        ...(draft.path ? { path: draft.path, flow_reason: 'Chosen by the user' } : {}),
      },
    },
  };
}

/** The lead whose plan a new task joins: the one that changed its plan last. */
export function planLead(model: Pick<BoardModel, 'leads'>): string | null {
  const newest = model.leads?.reduce<NonNullable<BoardModel['leads']>[number] | undefined>(
    (latest, lead) => (!latest || lead.updated_at > latest.updated_at ? lead : latest),
    undefined,
  );
  return newest?.session_id ?? null;
}

const PROBLEM: Record<DraftProblem, () => string> = {
  title: () =>
    t(
      { id: 'board.newTask.problem.title', defaultMessage: 'Title: 1 to {max} characters' },
      { max: PLAN_TITLE_MAX },
    ),
  goal: () =>
    t(
      { id: 'board.newTask.problem.goal', defaultMessage: 'Goal: 1 to {max} characters' },
      { max: GOAL_MAX },
    ),
  lane: () => t({ id: 'board.newTask.problem.lane', defaultMessage: 'Pick a lane' }),
  dependencies: () =>
    t(
      {
        id: 'board.newTask.problem.dependencies',
        defaultMessage: 'At most {max} dependencies',
      },
      { max: MAX_DEPENDENCIES },
    ),
  scope: () =>
    t(
      {
        id: 'board.newTask.problem.scope',
        defaultMessage: 'Scope: 1 to {count} paths of at most {max} characters',
      },
      { count: MAX_SCOPE, max: SCOPE_MAX },
    ),
  acceptance: () =>
    t(
      {
        id: 'board.newTask.problem.acceptance',
        defaultMessage: 'Acceptance: 1 to {count} commands of at most {max} characters',
      },
      { count: MAX_ACCEPTANCE, max: ACCEPTANCE_MAX },
    ),
  budget: () =>
    t({
      id: 'board.newTask.problem.budget',
      defaultMessage: 'Budget: a whole number of tokens above 0',
    }),
};

const titleText = () => t({ id: 'board.newTask.title', defaultMessage: 'New task' });

/** Whether the lead schedules the new task or it starts as soon as it is in the plan. */
export type StartMode = 'lead' | 'now';

export interface NewTaskFormProps {
  model: BoardModel;
  projectId: string;
  leadId: string;
  /** Takes the task's add_task op and whether to start it once sent; resolves to why not, or null. */
  onSubmit: (op: AddTask, start: boolean) => Promise<string | null>;
  submitText: string;
  titleRef?: Ref<HTMLInputElement>;
}

/** The new task's fields, on their own so a dialog or a side panel can hold them. */
export function NewTaskForm({
  model,
  projectId,
  leadId,
  onSubmit,
  submitText,
  titleRef,
}: NewTaskFormProps) {
  const prefix = `${leadId}:`;
  const lanes = model.lanes.filter((l) => l.id.startsWith(prefix));
  const iterations = (model.iterations ?? []).filter((i) => i.id.startsWith(prefix));
  const tasks = model.tasks.filter((task) => task.owner_session_id === leadId);
  const [start, setStart] = useState<StartMode>('lead');
  const [draft, setDraft] = useState<NewTaskDraft>({
    title: '',
    goal: '',
    lane: lanes[0]?.id.slice(prefix.length) ?? '',
    dependsOn: [],
    scope: '',
    acceptance: '',
    priority: 'normal',
    doneWhen: 'merged',
    route: { runtime: null, model: null, effort: null },
    path: null,
    iteration: null,
    taskType: null,
    budget: '',
  });
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = (next: Partial<NewTaskDraft>) => setDraft((d) => ({ ...d, ...next }));
  const route = useRouteFields(projectId, draft.route, busy, (patch) =>
    setDraft((d) => ({ ...d, route: { ...d.route, ...patch } })),
  );
  const drafted = useDraftEdits(projectId).flatMap((d) =>
    d.target.leadId === leadId
      ? d.ops.flatMap((op) => (op.type === 'add_task' ? [op.task.id] : []))
      : [],
  );
  const taken = new Set([
    ...tasks.flatMap((task) => [planTaskIds(task.id).task, ...(task.depends_on ?? [])]),
    ...drafted,
  ]);
  const submit = async () => {
    if (busy) return;
    const built = newTaskOp(draft, taken);
    if ('problem' in built) return setProblem(built.problem);
    setProblem(null);
    setFailure(null);
    setBusy(true);
    const why = await onSubmit(built.op, start === 'now');
    setBusy(false);
    setFailure(why);
  };
  const title = (planId: string) =>
    tasks.find((task) => planTaskIds(task.id).task === planId)?.title ?? planId;
  const upstreamLeft = tasks.filter((task) => !draft.dependsOn.includes(planTaskIds(task.id).task));
  const invalid = (field: DraftProblem) => (problem === field ? true : undefined);
  const label = (text: string) => (
    <span className="bd-new-l" aria-hidden="true">
      {text}
    </span>
  );
  const laneText = t({ id: 'board.plan.field.lane', defaultMessage: 'Lane' });
  const goalText = t({ id: 'board.newTask.goal', defaultMessage: 'Goal' });
  const dependsText = t({ id: 'board.newTask.dependencies', defaultMessage: 'Depends on' });
  const scopeText = t({ id: 'board.newTask.scope', defaultMessage: 'Scope paths' });
  const acceptanceText = t({
    id: 'board.newTask.acceptance',
    defaultMessage: 'Acceptance commands',
  });
  const doneText = t({ id: 'board.newTask.doneWhen', defaultMessage: 'Done when' });
  const routeText = t({ id: 'board.newTask.route', defaultMessage: 'Routing' });
  const pathText = t({ id: 'board.plan.field.path', defaultMessage: 'Flow path' });
  const iterationText = t({ id: 'board.plan.field.iteration', defaultMessage: 'Iteration' });
  const addUpstreamText = t({ id: 'board.newTask.upstreamAdd', defaultMessage: 'Add upstream' });
  const startText = t({ id: 'board.newTask.start', defaultMessage: 'Start' });
  const typeText = t({ id: 'board.plan.field.taskType', defaultMessage: 'Type' });
  const budgetText = t({ id: 'board.plan.field.tokenBudget', defaultMessage: 'Budget' });
  return (
    <form
      className="bd-new-f"
      aria-label={titleText()}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="bp-dlb">
        <input
          ref={titleRef}
          className="bd-new-title"
          aria-label={t({ id: 'board.plan.field.title', defaultMessage: 'Title' })}
          aria-invalid={invalid('title')}
          value={draft.title}
          maxLength={PLAN_TITLE_MAX}
          readOnly={busy}
          onChange={(e) => change({ title: e.target.value })}
        />
        <div className="bd-new">
          {label(typeText)}
          {typeField(draft.taskType, busy, (taskType) => change({ taskType }))}
          {label(goalText)}
          <textarea
            className="bp-ta"
            rows={3}
            spellCheck
            aria-label={goalText}
            aria-invalid={invalid('goal')}
            value={draft.goal}
            maxLength={GOAL_MAX}
            readOnly={busy}
            onChange={(e) => change({ goal: e.target.value })}
          />
          {label(laneText)}
          <div className="bd-new-row">
            <Select
              aria-label={laneText}
              aria-invalid={invalid('lane')}
              value={draft.lane}
              disabled={busy}
              onChange={(next) => change({ lane: next })}
              options={lanes.map((l) => ({
                value: l.id.slice(prefix.length),
                label: l.title,
              }))}
            />
            {iterations.length > 0 && (
              <Select
                aria-label={iterationText}
                value={draft.iteration ?? ''}
                disabled={busy}
                onChange={(next) => change({ iteration: next || null })}
                options={[
                  {
                    value: '',
                    label: t({ id: 'board.plan.field.noIteration', defaultMessage: 'None' }),
                  },
                  ...iterations.map((i) => ({
                    value: i.id.slice(prefix.length),
                    label: i.title,
                  })),
                ]}
              />
            )}
            {priorityField(draft.priority, busy, (priority) => change({ priority }))}
          </div>
          {label(dependsText)}
          <div
            className="bd-new-ups"
            role="group"
            aria-label={dependsText}
            aria-invalid={invalid('dependencies')}
          >
            {draft.dependsOn.map((id) => (
              <span key={id} className="chip">
                {title(id)}
                <button
                  type="button"
                  className="ib"
                  aria-label={t(
                    {
                      id: 'board.newTask.upstreamRemove',
                      defaultMessage: 'Remove upstream {title}',
                    },
                    { title: title(id) },
                  )}
                  disabled={busy}
                  onClick={() => change({ dependsOn: draft.dependsOn.filter((d) => d !== id) })}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
            {upstreamLeft.length > 0 && (
              <Menu
                label={addUpstreamText}
                trigger={
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-label={addUpstreamText}
                    disabled={busy}
                  >
                    <Plus className="ic-sm" aria-hidden="true" />
                  </button>
                }
              >
                {upstreamLeft.map((task) => {
                  const id = planTaskIds(task.id).task;
                  return (
                    <MenuItem
                      key={task.id}
                      data-pick={id}
                      onClick={() => change({ dependsOn: [...draft.dependsOn, id] })}
                    >
                      {task.title}
                    </MenuItem>
                  );
                })}
              </Menu>
            )}
          </div>
          {label(doneText)}
          <RadioGroup
            className="seg bd-new-seg"
            aria-label={doneText}
            value={draft.doneWhen}
            disabled={busy}
            onValueChange={(next) => change({ doneWhen: next as NewTaskDraft['doneWhen'] })}
          >
            <Radio.Root value="merged">
              {t({ id: 'board.newTask.doneWhen.merged', defaultMessage: 'Merge' })}
            </Radio.Root>
            <Radio.Root value="report">
              {t({ id: 'board.newTask.doneWhen.report', defaultMessage: 'Report' })}
            </Radio.Root>
          </RadioGroup>
          {label(pathText)}
          {pathField(draft.path, busy || draft.doneWhen === 'report', 'seg bd-new-seg', (path) =>
            change({ path }),
          )}
          {label(scopeText)}
          <textarea
            className="bp-ta bd-new-mono"
            rows={3}
            aria-label={scopeText}
            aria-invalid={invalid('scope')}
            value={draft.scope}
            readOnly={busy}
            onChange={(e) => change({ scope: e.target.value })}
          />
          {label(acceptanceText)}
          <textarea
            className="bp-ta bd-new-mono"
            rows={3}
            aria-label={acceptanceText}
            aria-invalid={invalid('acceptance')}
            value={draft.acceptance}
            readOnly={busy}
            onChange={(e) => change({ acceptance: e.target.value })}
          />
          {label(routeText)}
          <div className="bd-new-row" role="group" aria-label={routeText}>
            {route}
          </div>
          {label(budgetText)}
          {budgetField({
            text: draft.budget,
            used: 0,
            disabled: busy,
            invalid: invalid('budget'),
            onText: (budget) => change({ budget }),
          })}
          {label(startText)}
          <RadioGroup
            className="seg bd-new-seg"
            aria-label={t({ id: 'board.newTask.startMode', defaultMessage: 'How it starts' })}
            value={start}
            disabled={busy}
            onValueChange={(next) => setStart(next as StartMode)}
          >
            <Radio.Root value="lead">
              {t({ id: 'board.newTask.start.lead', defaultMessage: 'Leave it to the lead' })}
            </Radio.Root>
            <Radio.Root value="now">
              {t({ id: 'board.newTask.start.now', defaultMessage: 'Start once sent' })}
            </Radio.Root>
          </RadioGroup>
        </div>
      </div>
      {(problem || failure) && (
        <div className="pj-err" role="alert">
          <b>{problem ? PROBLEM[problem]() : failure}</b>
        </div>
      )}
      <div className="pj-df">
        <span style={{ flex: 1 }} />
        <button type="submit" className="btn pri" aria-busy={busy || undefined} disabled={busy}>
          {submitText}
        </button>
      </div>
    </form>
  );
}

/** The board's new task button; the task joins the plan of the lead that changed its plan last. */
export function NewTask({
  model,
  disabled,
  onNew,
}: {
  model: BoardModel | null;
  /** Set while the board read is out of date. */
  disabled: boolean;
  /** Opens the new task form. */
  onNew: () => void;
}) {
  const why = useId();
  const leadId = model && planLead(model);
  const reason = disabled
    ? t({ id: 'board.newTask.stale', defaultMessage: 'The board is out of date' })
    : !leadId
      ? t({ id: 'board.newTask.noPlan', defaultMessage: 'No lead plan yet' })
      : null;
  const button = (
    <button
      type="button"
      className="btn"
      aria-disabled={reason ? true : undefined}
      aria-describedby={reason ? why : undefined}
      aria-label={titleText()}
      title={titleText()}
      onClick={() => {
        if (!reason) onNew();
      }}
    >
      <Plus className="ic-sm" aria-hidden="true" />
      <span className="tb-lbl">{titleText()}</span>
    </button>
  );
  return (
    <>
      {reason ? <Tip content={reason}>{button}</Tip> : button}
      {reason && (
        <span id={why} className="bd-vh">
          {reason}
        </span>
      )}
    </>
  );
}
