import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Radio } from '@base-ui/react/radio';
import { ArrowRight, Plus, RotateCcw, Square, Trash, X } from 'lucide-react';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { FlowPath, TaskKind } from '@pantheon/domain';
import type { BoardModel, EffortLevel, RuntimeModel } from '@pantheon/protocol';
import { ModelMark, RuntimeGlyph } from '../../components/RuntimeGlyph';
import { Select } from '../../components/Select';
import { Tip } from '../../components/Tip';
import { ageText } from '../../data/needs-you';
import {
  clearPlanEdit,
  contractPatch,
  contractProblem,
  DONE_WHEN,
  editTiming,
  opChanges,
  parseTokenBudget,
  planVersion,
  PRIORITY,
  releasePlanEdit,
  taskActions,
  tokenBudgetText,
  usePlanContract,
  usePlanEdit,
  type Change,
  type Contract,
  type EditOutcome,
  type EditTarget,
  type PlanOp,
} from '../../data/plan-edit';
import { CHOSEN_PATHS, DOMAIN_LABEL, PATH_LABEL, tierText } from '../../data/workflow-policy';
import { useRuntimeModels } from '../../data/runtime-models';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import { useWorkflowList } from '../../data/workflow-definition';
import { t } from '../../i18n';
import { EFFORT_LABEL, defaultModel } from '../sessions/model';
import { taskTokens } from './activity';
import { tellLeadDraft, type RunBoardCommand, type SnapshotSession } from './panels-model';
import { runtimeName, TASK_TYPE, type TaskType } from './status';
import { TellLead, useDialogContent } from './TellLead';
import './edits.css';

type Task = BoardModel['tasks'][number];
type Patch = Extract<PlanOp, { type: 'set_task' }>['patch'];
type Priority = NonNullable<Patch['priority']>;

/** The protocol's longest plan task title. */
export const PLAN_TITLE_MAX = 80;
const PRIORITIES: Priority[] = ['high', 'normal', 'low'];
const TASK_DOMAINS = Object.keys(DOMAIN_LABEL) as TaskKind['domain'][];
const TASK_TIERS: TaskKind['tier'][] = ['t1', 't2', 't3'];
const DONE_WHENS = Object.keys(DONE_WHEN) as Contract['done_when'][];
// One blank entry per list, as a task done by merging has at least one.
const EMPTY_CONTRACT: Contract = {
  goal: '',
  scope: [''],
  acceptance: [''],
  done_when: 'merged',
  milestone: null,
  path: null,
};
// The protocol's limits on a plan task's contract.
const GOAL_MAX = 400;
type ListKey = 'scope' | 'acceptance';
const LISTS: Record<
  ListKey,
  {
    count: number;
    length: number;
    label: () => string;
    item: (n: number) => string;
    remove: (n: number) => string;
    add: () => string;
    empty: () => string;
  }
> = {
  scope: {
    count: 16,
    length: 200,
    label: () => t({ id: 'board.plan.field.scope', defaultMessage: 'Scope paths' }),
    item: (n) =>
      t({ id: 'board.plan.contract.scopeItem', defaultMessage: 'Scope path {n}' }, { n }),
    remove: (n) =>
      t({ id: 'board.plan.contract.scopeRemove', defaultMessage: 'Remove scope path {n}' }, { n }),
    add: () => t({ id: 'board.plan.contract.scopeAdd', defaultMessage: 'Add scope path' }),
    empty: () =>
      t({
        id: 'board.plan.contract.scopeEmpty',
        defaultMessage: 'A task done by merging needs a scope path',
      }),
  },
  acceptance: {
    count: 8,
    length: 400,
    label: () => t({ id: 'board.plan.field.acceptance', defaultMessage: 'Acceptance criteria' }),
    item: (n) =>
      t(
        { id: 'board.plan.contract.acceptanceItem', defaultMessage: 'Acceptance criterion {n}' },
        { n },
      ),
    remove: (n) =>
      t(
        {
          id: 'board.plan.contract.acceptanceRemove',
          defaultMessage: 'Remove acceptance criterion {n}',
        },
        { n },
      ),
    add: () =>
      t({ id: 'board.plan.contract.acceptanceAdd', defaultMessage: 'Add acceptance criterion' }),
    empty: () =>
      t({
        id: 'board.plan.contract.acceptanceEmpty',
        defaultMessage: 'A task done by merging needs an acceptance criterion',
      }),
  },
};

export function priorityField(value: Priority, disabled: boolean, onPick: (p: Priority) => void) {
  return (
    <RadioGroup
      className="seg"
      aria-label={t({ id: 'board.plan.field.priority', defaultMessage: 'Priority' })}
      value={value}
      disabled={disabled}
      onValueChange={(next) => onPick(next as Priority)}
    >
      {PRIORITIES.map((p) => (
        <Radio.Root key={p} value={p}>
          {PRIORITY[p]}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

/** The task type as icon radios; picking the checked type again hands `onPick` null. */
export function typeField(
  value: TaskType | null,
  disabled: boolean,
  onPick: (type: TaskType | null) => void,
) {
  return (
    <RadioGroup
      className="seg bd-type"
      aria-label={t({ id: 'board.plan.field.taskType', defaultMessage: 'Type' })}
      value={value ?? ''}
      disabled={disabled}
      onValueChange={(next) => onPick(next as TaskType)}
    >
      {(Object.keys(TASK_TYPE) as TaskType[]).map((type) => {
        const { label, icon: Icon } = TASK_TYPE[type];
        return (
          <Tip key={type} content={label}>
            <Radio.Root
              value={type}
              aria-label={label}
              onClick={() => {
                if (!disabled && type === value) onPick(null);
              }}
            >
              <Icon className="ic-sm" aria-hidden="true" />
            </Radio.Root>
          </Tip>
        );
      })}
    </RadioGroup>
  );
}

/** The token budget as typed, its short form, and a meter of the tokens used against it. */
export function budgetField({
  text,
  used,
  disabled,
  invalid,
  onText,
  onCommit,
}: {
  text: string;
  used: number;
  disabled: boolean;
  invalid?: boolean;
  onText: (text: string) => void;
  onCommit?: () => void;
}) {
  const label = t({ id: 'board.plan.field.tokenBudget', defaultMessage: 'Budget' });
  const budget = parseTokenBudget(text);
  const amount = typeof budget === 'number' ? budget : null;
  return (
    <div className="bd-bud">
      <div className="bd-bud-row">
        <input
          type="number"
          className="bd-fsel bd-bud-in"
          inputMode="numeric"
          min={1}
          step={1}
          aria-label={label}
          placeholder={t({
            id: 'board.plan.field.tokenBudgetPlaceholder',
            defaultMessage: 'Token budget',
          })}
          aria-invalid={invalid || budget === 'invalid' || undefined}
          value={text}
          disabled={disabled}
          onChange={(e) => onText(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) onCommit?.();
          }}
        />
        {amount !== null && <span className="bd-bud-n">{tokenBudgetText(amount)}</span>}
      </div>
      {amount !== null && (
        <div
          className="meter"
          role="meter"
          aria-label={label}
          aria-valuenow={Math.min(used, amount)}
          aria-valuemin={0}
          aria-valuemax={amount}
          style={{ '--v': `${Math.min(100, (used / amount) * 100)}%` } as CSSProperties}
        >
          <i />
        </div>
      )}
    </div>
  );
}

/** The task's own flow path, the empty value following its tier's. */
export function pathField(
  value: FlowPath | null,
  disabled: boolean,
  className: string,
  onPick: (path: FlowPath | null) => void,
) {
  return (
    <RadioGroup
      className={className}
      aria-label={t({ id: 'board.plan.field.path', defaultMessage: 'Flow path' })}
      value={value ?? ''}
      disabled={disabled}
      onValueChange={(next) => onPick((next as FlowPath | '') || null)}
    >
      <Radio.Root value="">
        {t({ id: 'board.plan.field.pathDefault', defaultMessage: 'Follow the default' })}
      </Radio.Root>
      {CHOSEN_PATHS.map((path) => (
        <Radio.Root key={path} value={path}>
          {PATH_LABEL[path]}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

/** The runtime, model and effort a task's session opens with; null leaves it to the routing table. */
export interface Route {
  runtime: string | null;
  model: string | null;
  effort: EffortLevel | null;
}

/** Runtime, model and effort pickers; a new runtime or model moves the others to values it takes. */
export function useRouteFields(
  projectId: string,
  route: Route,
  disabled: boolean,
  set: (patch: Patch) => void,
): ReactNode {
  const { runtime, model: current } = route;
  const runtimes = offeredRuntimes(useRuntimeStatus().read, [runtime]);
  const listed = useRuntimeModels(projectId, runtimes);
  const modelsOf = (name: string | null) => {
    const state = name ? listed[name] : undefined;
    return state?.state === 'ready' ? state.models : [];
  };
  const models = modelsOf(runtime);
  const entry = models.find((m) => m.id === current || m.resolved === current);
  // Without a model the session runs on the runtime's default one.
  const efforts = (current === null ? defaultModel(models) : entry)?.efforts ?? [];
  // A session does not start with an effort its model does not take.
  const fitEffort = (to: RuntimeModel): Patch => {
    if (route.effort && to.efforts.length === 0) return { effort: null };
    const fits = !route.effort || to.efforts.includes(route.effort);
    const effort = fits ? undefined : (to.default_effort ?? to.efforts[0]);
    return effort ? { effort } : {};
  };
  const setRuntime = (next: string) => {
    const kept = modelsOf(next).find((m) => m.id === current);
    const to = kept ?? defaultModel(modelsOf(next));
    set({
      runtime: next,
      ...(to && !kept ? { model: to.id } : {}),
      ...(to ? fitEffort(to) : {}),
    });
  };
  const setModel = (id: string) => {
    const to = models.find((m) => m.id === id);
    set({ model: id, ...(to ? fitEffort(to) : {}) });
  };
  return (
    <>
      <RadioGroup
        className="seg"
        aria-label={t({ id: 'board.plan.field.runtime', defaultMessage: 'Runtime' })}
        value={runtime ?? ''}
        disabled={disabled}
        onValueChange={(next) => setRuntime(next as string)}
      >
        {runtimes.map((name) => (
          <Radio.Root key={name} value={name} disabled={listed[name]?.state !== 'ready'}>
            <RuntimeGlyph runtime={name} size={14} />
            {runtimeName(name)}
          </Radio.Root>
        ))}
      </RadioGroup>
      <ModelMark model={current} />
      <Select
        aria-label={t({ id: 'board.plan.field.model', defaultMessage: 'Model' })}
        value={current ?? ''}
        disabled={disabled}
        onChange={(next) => (next ? setModel(next) : set({ model: null, effort: null }))}
        options={[
          {
            value: '',
            label: t({ id: 'board.plan.field.defaultModel', defaultMessage: 'Default' }),
          },
          ...(current !== null && !entry ? [{ value: current, label: current }] : []),
          ...models.map((m) => ({ value: m.id, label: m.label })),
        ]}
      />
      {efforts.length > 0 && (
        <RadioGroup
          className="seg"
          aria-label={t({ id: 'board.plan.field.effort', defaultMessage: 'Effort' })}
          value={route.effort ?? ''}
          disabled={disabled}
          onValueChange={(next) => set({ effort: next as EffortLevel })}
        >
          {efforts.map((level) => (
            <Radio.Root key={level} value={level}>
              {EFFORT_LABEL[level]}
            </Radio.Root>
          ))}
        </RadioGroup>
      )}
    </>
  );
}

/** Each change as `<s>old</s> → new`; a rejected edit strikes only the values it asked for. */
export function changeList(changes: Change[], rejected = false) {
  return (
    <ul className="bd-bn-ch">
      {changes.map((c, i) => (
        <li key={i} className="bd-diff">
          <span className="bd-vh">
            {t({ id: 'board.plan.change.field', defaultMessage: '{field}:' }, { field: c.field })}
          </span>
          {rejected ? (
            <s>{c.after ?? c.before}</s>
          ) : (
            <>
              {c.before !== null && <s>{c.before}</s>}
              {c.before !== null && c.after !== null && (
                <>
                  <span className="bd-vh">
                    {t({ id: 'board.plan.change.to', defaultMessage: 'changed to' })}
                  </span>
                  <ArrowRight aria-hidden="true" />
                </>
              )}
              {c.after === null ? (
                <span className="bd-vh">
                  {t({ id: 'board.plan.change.removed', defaultMessage: 'removed' })}
                </span>
              ) : (
                <span>{c.after}</span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface ContractFieldsProps {
  model: BoardModel;
  target: EditTarget;
  busy: boolean;
  /** Sends the patch on the plan version the contract was read at. */
  send: (patch: Patch, base: number) => Promise<EditOutcome>;
}

/** Goal, scope, acceptance, done-when, flow path and milestone, sent together as one set_task patch. */
export function ContractFields({ model, target, busy: sending, send }: ContractFieldsProps) {
  const { contract: read, version, milestones, stale, error, reload } = usePlanContract(target);
  const workflows = useWorkflowList(target.projectId).read ?? [];
  const owner = `${target.projectId}\n${target.taskId}\n`;
  const current = useRef(owner);
  current.current = owner;
  const seen = read && owner + JSON.stringify(read);
  const [shown, setShown] = useState(seen);
  const [edited, setDraft] = useState(read);
  // Another task or a new plan replaces the draft; a read of the same plan keeps what the user typed.
  if (shown !== seen) {
    setShown(seen);
    setDraft(read);
  }
  // Until the read lands the rows stand empty and disabled; its values then fill in place.
  const loading = !read || !edited;
  // A read cached by an earlier mount, one whose re-read failed, or one of another plan version
  // than the board's may not be the plan the edit lands on.
  const unsure = stale || error !== null || version !== planVersion(model, target.leadId);
  const contract = read ?? EMPTY_CONTRACT;
  const draft = edited ?? EMPTY_CONTRACT;
  const busy = sending || loading || unsure;
  const patch = contractPatch(contract, draft);
  const problems = loading ? [] : contractProblem(draft);
  const held =
    editTiming(model, target.leadId, [
      { type: 'set_task', task_id: target.planId, patch: { goal: contract.goal } },
    ]) === 'lead';
  const change = (next: Partial<Contract>) => setDraft({ ...draft, ...next });
  const submit = async () => {
    if (busy || problems.length || !Object.keys(patch).length || version === null) return;
    // A held edit shows in its banner; the fields go back to the plan as it is.
    const sent = await send(patch, version);
    if (sent.kind === 'pending' && current.current === owner) setDraft(contract);
  };
  const label = (text: string) => (
    <span className="bd-ct-l" aria-hidden="true">
      {text}
    </span>
  );
  const list = (key: ListKey) => {
    const spec = LISTS[key];
    const items = draft[key];
    const setItems = (next: string[]) =>
      change(key === 'scope' ? { scope: next } : { acceptance: next });
    const invalid = problems.includes(key) || undefined;
    const problemId = `${target.taskId}-${key}-problem`;
    return (
      <>
        {label(spec.label())}
        <div
          className="bd-ct-list"
          role="group"
          aria-label={spec.label()}
          aria-invalid={invalid}
          aria-describedby={invalid && problemId}
        >
          {items.map((item, i) => (
            <div key={i} className="bd-ct-row">
              <input
                className="bd-fsel bd-ct-in"
                aria-label={spec.item(i + 1)}
                value={item}
                maxLength={spec.length}
                disabled={busy}
                onChange={(e) => setItems(items.map((s, j) => (j === i ? e.target.value : s)))}
              />
              <button
                type="button"
                className="ib"
                aria-label={spec.remove(i + 1)}
                disabled={busy}
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
          {items.length < spec.count && (
            <button
              type="button"
              className="btn ghost bd-ct-add"
              aria-label={spec.add()}
              disabled={busy}
              onClick={() => setItems([...items, ''])}
            >
              <Plus className="ic-sm" aria-hidden="true" />
              {t({ id: 'board.plan.contract.add', defaultMessage: 'Add' })}
            </button>
          )}
          {invalid && (
            <p id={problemId} className="bd-ct-err">
              {spec.empty()}
            </p>
          )}
        </div>
      </>
    );
  };
  const goalText = t({ id: 'board.plan.field.goal', defaultMessage: 'Goal' });
  const doneText = t({ id: 'board.plan.field.doneWhen', defaultMessage: 'Done when' });
  const milestoneText = t({ id: 'board.plan.field.milestone', defaultMessage: 'Milestone' });
  const pathText = t({ id: 'board.plan.field.path', defaultMessage: 'Flow path' });
  const workflowText = t({ id: 'board.plan.field.workflow', defaultMessage: 'Workflow' });
  return (
    <div
      className="bd-ct"
      role="group"
      aria-label={t({ id: 'board.plan.contract.label', defaultMessage: 'Task contract' })}
      aria-busy={loading || undefined}
    >
      {error && (
        <div className="tr-fail bd-fail" role="alert">
          <span title={error}>{error}</span>
          <button type="button" className="btn" onClick={reload}>
            {t({ id: 'board.query.retry', defaultMessage: 'Retry' })}
          </button>
        </div>
      )}
      {held && (
        <span className="bd-pchip" data-dot="wait">
          {t({
            id: 'board.plan.contract.held',
            defaultMessage: 'Takes effect once the lead agrees',
          })}
        </span>
      )}
      {label(goalText)}
      <textarea
        className="bp-ta"
        rows={3}
        aria-label={goalText}
        value={draft.goal}
        maxLength={GOAL_MAX}
        disabled={busy}
        onChange={(e) => change({ goal: e.target.value })}
      />
      {list('scope')}
      {list('acceptance')}
      {label(doneText)}
      <div className="bd-ct-row bd-ct-seg">
        <RadioGroup
          className="seg"
          aria-label={doneText}
          value={draft.done_when}
          disabled={busy}
          onValueChange={(next) => change({ done_when: next as Contract['done_when'] })}
        >
          {DONE_WHENS.map((value) => (
            <Radio.Root key={value} value={value}>
              {DONE_WHEN[value]}
            </Radio.Root>
          ))}
        </RadioGroup>
        {/* A task done by a report always takes the dispatch path. */}
        <Select<FlowPath | ''>
          aria-label={pathText}
          value={draft.path ?? ''}
          disabled={busy || draft.done_when === 'report'}
          onChange={(next) => change({ path: next || null })}
          options={[
            {
              value: '',
              label: t({
                id: 'board.plan.field.pathDefault',
                defaultMessage: 'Follow the default',
              }),
            },
            ...CHOSEN_PATHS.map((path) => ({
              value: path,
              label: PATH_LABEL[path],
            })),
          ]}
        />
      </div>
      {label(workflowText)}
      <Select
        aria-label={workflowText}
        value={draft.workflow_id ?? ''}
        disabled={busy}
        onChange={(next) => change({ workflow_id: next || undefined })}
        options={[
          {
            value: '',
            label: t({ id: 'board.plan.field.pathDefault', defaultMessage: 'Follow the default' }),
          },
          ...(draft.workflow_id && !workflows.some((w) => w.id === draft.workflow_id)
            ? [{ value: draft.workflow_id, label: draft.workflow_id }]
            : []),
          ...workflows.map((w) => ({ value: w.id, label: w.name })),
        ]}
      />
      {label(milestoneText)}
      <Select
        aria-label={milestoneText}
        value={draft.milestone ?? ''}
        disabled={busy}
        onChange={(next) => change({ milestone: next || null })}
        options={[
          { value: '', label: t({ id: 'board.plan.field.noMilestone', defaultMessage: 'None' }) },
          ...(draft.milestone !== null && !milestones.some((m) => m.id === draft.milestone)
            ? [{ value: draft.milestone, label: draft.milestone }]
            : []),
          ...milestones.map((m) => ({ value: m.id, label: m.title })),
        ]}
      />
      <div className="bd-ct-acts">
        <button
          type="button"
          className="btn pri"
          disabled={busy || problems.length > 0 || !Object.keys(patch).length}
          onClick={() => void submit()}
        >
          {t({ id: 'board.plan.contract.save', defaultMessage: 'Save contract' })}
        </button>
      </div>
    </div>
  );
}

const stopText = () => t({ id: 'board.plan.task.stop', defaultMessage: 'Stop' });

/** Asks before a stop, which discards the task's unfinished sessions and their worktrees. */
function StopDialog({ onStop }: { onStop: () => void }) {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="pj-scrim" />
      <Dialog.Popup className="pj-dlg pj-rm pop">
        <div className="pj-dh">
          <Dialog.Title className="pj-dt">
            {t({
              id: 'board.plan.task.stopConfirm',
              defaultMessage: 'Stop this task and discard its unfinished sessions?',
            })}
          </Dialog.Title>
        </div>
        <div className="pj-df">
          <span style={{ flex: 1 }} />
          <Dialog.Close className="btn ghost">
            {t({ id: 'board.task.cancel.keep', defaultMessage: 'Keep task' })}
          </Dialog.Close>
          <button type="button" className="btn dng" onClick={onStop}>
            {stopText()}
          </button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

export interface PlanEditProps {
  model: BoardModel;
  task: Task;
  target: EditTarget;
  lead: SnapshotSession | undefined;
  run: RunBoardCommand;
  /** Closes the drawer once the task left the plan. */
  onClose: () => void;
}

/** The plan task's routing, its commands and where the user's edits of it stand. */
export function PlanEdit({ model, task, target, lead, run, onClose }: PlanEditProps) {
  const edit = usePlanEdit(model, target);
  useEffect(() => () => releasePlanEdit(target.taskId), [target.taskId]);
  const row = model.leads?.find((l) => l.session_id === target.leadId);
  const version = row?.plan_version ?? 0;
  const pending = (row?.pending_edits ?? []).filter((e) => e.task_ids.includes(target.planId));
  const rejected = row?.rejected_edits?.find((e) => e.task_ids.includes(target.planId));
  const { outcome } = edit;
  // Once the board lists the edit its banner stands for it, and the edit leaving the board ends it.
  const onBoard = outcome?.kind === 'pending' && pending.some((e) => e.id === outcome.editId);
  useEffect(() => {
    if (onBoard) clearPlanEdit(target.taskId);
  }, [onBoard, target.taskId]);
  const busy = outcome?.kind === 'sending';
  const actions = taskActions(task);
  const planned = task.planned ?? {};
  const changes = (ops: readonly PlanOp[]) =>
    ops.flatMap((op) => opChanges(model, target.leadId, op));
  const set = (patch: Patch) => {
    if (!busy) void edit.edit([{ type: 'set_task', task_id: target.planId, patch }]);
  };
  const route = useRouteFields(
    target.projectId,
    {
      runtime: planned.runtime ?? task.claim?.runtime ?? null,
      model: planned.model ?? null,
      effort: planned.effort ?? null,
    },
    busy,
    set,
  );
  // A draft is of one task: opening another task drops it even where the values match.
  const owner = `${target.projectId}\n${target.taskId}\n`;
  const current = useRef(owner);
  current.current = owner;
  const [title, setTitle] = useState(task.title);
  const [shownTitle, setShownTitle] = useState(owner + task.title);
  if (shownTitle !== owner + task.title) {
    setShownTitle(owner + task.title);
    setTitle(task.title);
  }
  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== task.title) set({ title: next });
    else setTitle(task.title);
  };
  const budgetNow = task.token_budget === undefined ? '' : String(task.token_budget);
  const [budget, setBudget] = useState(budgetNow);
  const [shownBudget, setShownBudget] = useState(owner + budgetNow);
  if (shownBudget !== owner + budgetNow) {
    setShownBudget(owner + budgetNow);
    setBudget(budgetNow);
  }
  const commitBudget = () => {
    const next = parseTokenBudget(budget);
    if (next === 'invalid') setBudget(budgetNow);
    else if (next !== (task.token_budget ?? null)) set({ token_budget: next });
  };
  const lanePrefix = `${target.leadId}:`;
  const lanes = model.lanes.filter((l) => l.id.startsWith(lanePrefix));
  const lane = task.lane_id?.startsWith(lanePrefix) ? task.lane_id.slice(lanePrefix.length) : '';
  const iterations = (model.iterations ?? []).filter((i) => i.id.startsWith(lanePrefix));
  const iteration = task.iteration_id?.startsWith(lanePrefix)
    ? task.iteration_id.slice(lanePrefix.length)
    : '';
  const kind = planned.kind;
  const act = (run: () => Promise<unknown>) => () => {
    if (!busy) void run();
  };
  const stopping = useDialogContent<true>();
  const remove = async () => {
    const done = await edit.edit([{ type: 'remove_task', task_id: target.planId }]);
    if (done.kind === 'applied' && current.current === owner) onClose();
  };

  return (
    <>
      {outcome?.kind === 'conflict' && (
        <div className="bd-bn" role="status">
          <div className="bd-bn-h">
            <span className="bd-pchip" data-dot="chg">
              {t({ id: 'board.plan.edit.conflict', defaultMessage: 'Plan updated' })}
            </span>
            <span className="bd-diff">
              v{outcome.base}
              <ArrowRight aria-hidden="true" />v{version}
            </span>
          </div>
          {changeList(changes(outcome.ops))}
          <div className="bd-dacts">
            <button type="button" className="btn pri" onClick={edit.retry}>
              {t(
                { id: 'board.plan.edit.retry', defaultMessage: 'Resend on v{version}' },
                { version },
              )}
            </button>
            <button type="button" className="btn" onClick={edit.discard}>
              {t({ id: 'board.plan.edit.discard', defaultMessage: 'Discard changes' })}
            </button>
          </div>
        </div>
      )}
      {rejected && (
        <div className="bd-bn" role="status">
          <div className="bd-bn-h">
            <span className="bd-pchip" data-dot="bad">
              {t({ id: 'board.plan.edit.rejected', defaultMessage: 'Lead declined' })}
            </span>
            <span className="bd-bn-at">{ageText(rejected.resolved_at, model.now)}</span>
          </div>
          {changeList(changes(rejected.ops), true)}
          {rejected.reason && <p className="bd-bn-why">{rejected.reason}</p>}
          <div className="bd-dacts">
            <TellLead
              lead={lead}
              draft={tellLeadDraft('task', task.title, task.id)}
              label={task.title}
              run={run}
              className="btn ghost"
              text={t({ id: 'board.plan.edit.reply', defaultMessage: 'Reply to lead' })}
            />
          </div>
        </div>
      )}
      {actions.edit && (
        <div className="bd-fields">
          <input
            className="bd-fsel bd-ftitle"
            aria-label={t({ id: 'board.plan.field.title', defaultMessage: 'Title' })}
            value={title}
            maxLength={PLAN_TITLE_MAX}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitTitle();
            }}
          />
          <Select
            aria-label={t({ id: 'board.plan.field.lane', defaultMessage: 'Lane' })}
            value={lane}
            disabled={busy}
            onChange={(next) => next && set({ lane: next })}
            options={[
              ...(!lanes.some((l) => l.id === lanePrefix + lane)
                ? [{ value: lane, label: lane }]
                : []),
              ...lanes.map((l) => ({ value: l.id.slice(lanePrefix.length), label: l.title })),
            ]}
          />
          {(iterations.length > 0 || iteration) && (
            <Select
              aria-label={t({ id: 'board.plan.field.iteration', defaultMessage: 'Iteration' })}
              value={iteration}
              disabled={busy}
              onChange={(next) => set({ iteration: next || null })}
              options={[
                {
                  value: '',
                  label: t({ id: 'board.plan.field.noIteration', defaultMessage: 'None' }),
                },
                ...(iteration && !iterations.some((i) => i.id === lanePrefix + iteration)
                  ? [{ value: iteration, label: iteration }]
                  : []),
                ...iterations.map((i) => ({
                  value: i.id.slice(lanePrefix.length),
                  label: i.title,
                })),
              ]}
            />
          )}
          {priorityField(planned.priority ?? 'normal', busy, (priority) => set({ priority }))}
          <Select<TaskKind['domain'] | ''>
            aria-label={t({ id: 'board.plan.field.domain', defaultMessage: 'Kind' })}
            value={kind?.domain ?? ''}
            disabled={busy}
            onChange={(next) =>
              next &&
              set({
                kind: {
                  domain: next,
                  tier: kind?.tier ?? 't1',
                },
              })
            }
            options={[
              ...(!kind ? [{ value: '' as const, label: '' }] : []),
              ...TASK_DOMAINS.map((domain) => ({ value: domain, label: DOMAIN_LABEL[domain] })),
            ]}
          />
          <RadioGroup
            className="seg"
            aria-label={t({ id: 'board.plan.field.tier', defaultMessage: 'Tier' })}
            value={kind?.tier ?? ''}
            disabled={busy || !kind}
            onValueChange={(tier) =>
              kind && set({ kind: { domain: kind.domain, tier: tier as TaskKind['tier'] } })
            }
          >
            {TASK_TIERS.map((tier) => (
              <Radio.Root key={tier} value={tier}>
                {tierText(tier)}
              </Radio.Root>
            ))}
          </RadioGroup>
          {typeField(task.task_type ?? null, busy, (type) => set({ task_type: type }))}
        </div>
      )}
      {actions.edit && (
        <div className="bd-fields">
          {route}
          {budgetField({
            text: budget,
            used: taskTokens(task),
            disabled: busy,
            onText: setBudget,
            onCommit: commitBudget,
          })}
          {outcome?.kind === 'applied' && (
            <span className="bd-pchip" data-dot="ok" role="status">
              {t({ id: 'board.plan.edit.applied', defaultMessage: 'Applied' })}
            </span>
          )}
          {outcome?.kind === 'pending' && !onBoard && (
            <span className="bd-pchip" data-dot="wait" role="status">
              {t({ id: 'board.plan.edit.pending', defaultMessage: 'Waiting for the lead' })}
            </span>
          )}
        </div>
      )}
      {actions.edit && (
        <ContractFields
          model={model}
          target={target}
          busy={busy}
          send={(patch, base) =>
            edit.edit([{ type: 'set_task', task_id: target.planId, patch }], base)
          }
        />
      )}
      {outcome?.kind === 'failed' && (
        <p className="bd-perr" role="alert">
          {outcome.text}
        </p>
      )}
      {pending.map((e) => (
        <div key={e.id} className="bd-bn" role="status">
          <div className="bd-bn-h">
            <span className="bd-pchip" data-dot="wait">
              {t({ id: 'board.plan.edit.pending', defaultMessage: 'Waiting for the lead' })}
            </span>
            {e.created_at !== undefined && (
              <span className="bd-bn-at">{ageText(e.created_at, model.now)}</span>
            )}
            <button
              type="button"
              className="btn ghost"
              aria-label={t({
                id: 'board.plan.edit.withdrawLabel',
                defaultMessage: 'Withdraw edit',
              })}
              aria-disabled={busy || undefined}
              onClick={act(() => edit.withdraw(e.id))}
            >
              {t({ id: 'board.plan.edit.withdraw', defaultMessage: 'Withdraw' })}
            </button>
          </div>
          {changeList(changes(e.ops ?? []))}
        </div>
      ))}
      {(actions.stop || actions.restart || actions.remove) && (
        <div className="bd-dacts">
          {actions.stop && (
            <button
              type="button"
              className="btn"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) stopping.show(true);
              }}
            >
              <Square className="ic-sm" aria-hidden="true" />
              {stopText()}
            </button>
          )}
          <Dialog.Root {...stopping.root}>
            {stopping.content && (
              <StopDialog
                onStop={() => {
                  stopping.close();
                  act(edit.stop)();
                }}
              />
            )}
          </Dialog.Root>
          {actions.restart && (
            <button
              type="button"
              className="btn"
              aria-disabled={busy || undefined}
              onClick={act(edit.restart)}
            >
              <RotateCcw className="ic-sm" aria-hidden="true" />
              {t({ id: 'board.plan.task.restart', defaultMessage: 'Redispatch' })}
            </button>
          )}
          {actions.remove && (
            <button
              type="button"
              className="btn dng"
              aria-disabled={busy || undefined}
              onClick={act(remove)}
            >
              <Trash className="ic-sm" aria-hidden="true" />
              {t({ id: 'board.plan.task.remove', defaultMessage: 'Delete' })}
            </button>
          )}
        </div>
      )}
    </>
  );
}
