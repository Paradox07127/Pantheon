import { useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import {
  BellRing,
  Circle,
  CircleCheckBig,
  Columns3,
  Ellipsis,
  Eye,
  FlaskConical,
  GitMerge,
  Hammer,
  ListTodo,
  MessageSquareText,
  Minus,
  Plus,
  Repeat,
  ScanEye,
  ScanSearch,
  ShieldCheck,
  Split,
  SquareTerminal,
  Star,
  Undo2,
  UserCheck,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { FlowPath, TaskKind } from '@pantheon/domain';
import type {
  BoardModel,
  BoardTaskState,
  EffortLevel,
  WorkflowDefinitionView,
  WorkflowStepResult,
} from '@pantheon/protocol';
import { Menu as BarMenu, MenuCheckboxItem, MenuItem } from '../../components/Menu';
import {
  compareRuntimes,
  KNOWN_RUNTIMES,
  RuntimeGlyph,
  runtimeName,
} from '../../components/RuntimeGlyph';
import { Select } from '../../components/Select';
import { StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { setAutoMerge } from '../../data/auto-merge';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { useRuntimeModels } from '../../data/runtime-models';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import {
  DEFAULT_QUOTA_THRESHOLD,
  DOMAIN_LABEL,
  PARAM_LABEL,
  PATH_LABEL,
  tierText,
  useRoutingTable,
  useWorkflowPolicy,
  WAKE_LABEL,
  type WorkflowPolicy,
} from '../../data/workflow-policy';
import {
  chartItems,
  GROUP_KINDS,
  moveStep,
  placeStep,
  removeStep,
  replaceStep,
  saveDefinition,
  saveWorkflowAs,
  setDefaultWorkflow,
  slotOf,
  SLOTS,
  STEP_KINDS,
  useSkillChoices,
  useWorkflowDefinition,
  useWorkflowList,
  type LeafKind,
  type Slot,
  type StepKind,
  type TurnSkill,
  type WorkflowDefinition,
  type WorkflowLeafStep,
  type WorkflowStep,
} from '../../data/workflow-definition';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { Failure, Skeleton } from '../board/BoardScreen';
import { durationText } from '../board/panels-model';
import {
  DEFAULT_TIMEOUT_SECONDS,
  gateSetRequest,
  joinArgv,
  splitArgv,
  type GateCommand,
} from '../settings/gate';
import { EFFORT_LABEL, defaultModel } from '../sessions/thread-model';
import { openSettingsPage } from '../settings/settings-jump';
import { BarSlot } from './BarSlot';
import './workflow.css';

type Tier = TaskKind['tier'];
type Domain = TaskKind['domain'];

const TIERS: readonly Tier[] = ['t1', 't2', 't3'];
const DOMAINS = Object.keys(DOMAIN_LABEL) as Domain[];
const MAX_ROUNDS = 5;
const MAX_PATHS = 16;
const MAX_PARTS = 4;
const MAX_LOOP = 5;
const MAX_TRIAL = 20;
const TRIAL_TASKS = 5;

// Labels are getters, so each is read in the language loaded by then.
const FIXED_LABEL: Record<string, string> = {
  get plan() {
    return t({ id: 'insights.workflow.fixed.plan', defaultMessage: 'Plan' });
  },
  get plan_review() {
    return t({ id: 'insights.workflow.fixed.planReview', defaultMessage: 'Plan review' });
  },
  get dispatch() {
    return t({ id: 'insights.workflow.fixed.dispatch', defaultMessage: 'Dispatch' });
  },
  get build() {
    return t({ id: 'insights.workflow.fixed.build', defaultMessage: 'Build' });
  },
  get gate() {
    return t({ id: 'insights.workflow.fixed.gate', defaultMessage: 'Gate' });
  },
  get merge() {
    return t({ id: 'insights.workflow.fixed.merge', defaultMessage: 'Merge' });
  },
  get handback() {
    return t({ id: 'insights.workflow.fixed.handback', defaultMessage: 'Hand back' });
  },
  get wake() {
    return t({ id: 'insights.workflow.fixed.wake', defaultMessage: 'Wake the lead' });
  },
  get review() {
    return t({ id: 'insights.workflow.fixed.review', defaultMessage: 'Code review' });
  },
  get acceptance() {
    return t({ id: 'insights.workflow.fixed.acceptance', defaultMessage: 'Acceptance' });
  },
};

const FIXED_ICON: Record<string, LucideIcon> = {
  plan: ListTodo,
  plan_review: Eye,
  dispatch: Split,
  build: Hammer,
  gate: ShieldCheck,
  merge: GitMerge,
  handback: Undo2,
  wake: BellRing,
  review: ScanEye,
  acceptance: CircleCheckBig,
};

const KIND_LABEL: Record<StepKind, string> = {
  get command() {
    return t({ id: 'insights.workflow.kind.command', defaultMessage: 'Command' });
  },
  get approval() {
    return t({ id: 'insights.workflow.kind.approval', defaultMessage: 'Approval' });
  },
  get prompt() {
    return t({ id: 'insights.workflow.kind.prompt', defaultMessage: 'Prompt' });
  },
  get review() {
    return t({ id: 'insights.workflow.kind.review', defaultMessage: 'Review' });
  },
  get parallel() {
    return t({ id: 'insights.workflow.kind.parallel', defaultMessage: 'Parallel' });
  },
  get loop() {
    return t({ id: 'insights.workflow.kind.loop', defaultMessage: 'Loop' });
  },
};

const KIND_ICON: Record<StepKind, LucideIcon> = {
  command: SquareTerminal,
  approval: UserCheck,
  prompt: MessageSquareText,
  review: ScanSearch,
  parallel: Columns3,
  loop: Repeat,
};

const SLOT_LABEL: Record<Slot, string> = {
  get before_dispatch() {
    return t({ id: 'insights.workflow.slot.beforeDispatch', defaultMessage: 'Before dispatch' });
  },
  get before_merge() {
    return t({ id: 'insights.workflow.slot.beforeMerge', defaultMessage: 'Before merge' });
  },
  get after_merge() {
    return t({ id: 'insights.workflow.slot.afterMerge', defaultMessage: 'After merge' });
  },
};

const TARGET_LABEL: Record<'task' | 'lead', string> = {
  get task() {
    return t({ id: 'insights.workflow.target.task', defaultMessage: 'Task session' });
  },
  get lead() {
    return t({ id: 'insights.workflow.target.lead', defaultMessage: 'Lead' });
  },
};

type StepRun = NonNullable<BoardModel['tasks'][number]['step_runs']>[number];

const RUN_STATE_LABEL: Record<Exclude<StepRun['state'], 'passed' | 'pending'>, string> = {
  get running() {
    return t({ id: 'insights.workflow.run.running', defaultMessage: 'Running' });
  },
  get waiting() {
    return t({ id: 'insights.workflow.run.waiting', defaultMessage: 'Waiting' });
  },
  get inconclusive() {
    return t({ id: 'insights.workflow.run.inconclusive', defaultMessage: 'Inconclusive' });
  },
  get failed() {
    return t({ id: 'insights.workflow.run.failed', defaultMessage: 'Failed' });
  },
  get rejected() {
    return t({ id: 'insights.workflow.run.rejected', defaultMessage: 'Rejected' });
  },
  get skipped() {
    return t({ id: 'insights.workflow.run.skipped', defaultMessage: 'Skipped' });
  },
};

const fixedLabel = (id: string) => (id in FIXED_LABEL ? FIXED_LABEL[id]! : id);
const roundsLabel = () =>
  t({ id: 'insights.workflow.maxRounds', defaultMessage: 'Most code review rounds' });

/** One plain step as typed: the step itself, or one step of a parallel group or loop. */
interface LeafForm {
  /** Absent for a new step. */
  id: string | null;
  kind: LeafKind;
  title: string;
  command: string;
  timeout: string;
  prompt: string;
  target: 'task' | 'lead';
  skill: TurnSkill | null;
  runtime: string;
  /** Null leaves the review's model or effort to the session defaults. */
  model: string | null;
  effort: EffortLevel | null;
  blocking: boolean;
  /** A saved step's tiers, domains and paths, which the form does not show for a group's step. */
  scope?: Pick<WorkflowLeafStep, 'applies_to' | 'when'>;
}

/** The step being added or edited, as typed. */
interface StepForm extends Omit<LeafForm, 'kind'> {
  slot: Slot;
  /** Where a new step goes in its slot; absent puts it last. */
  at?: number;
  kind: StepKind;
  tiers: Tier[];
  domains: Domain[];
  /** Changed-path globs, one a line; none runs the step whatever changed. */
  paths: string;
  /** The steps of a parallel group; a loop's step is the first. */
  parts: LeafForm[];
  /** The most runs of a loop. */
  max: number;
}

/** A new plain step; a prompt goes to the task session only in the slot that has one, before merge. */
const blankLeaf = (slot: Slot): LeafForm => ({
  id: null,
  kind: 'command',
  title: '',
  command: '',
  timeout: '300',
  prompt: '',
  target: slot === 'before_merge' ? 'task' : 'lead',
  skill: null,
  runtime: KNOWN_RUNTIMES[0] ?? '',
  model: null,
  effort: null,
  blocking: false,
});

const blankForm = (slot: Slot): StepForm => ({
  ...blankLeaf(slot),
  slot,
  tiers: [],
  domains: [],
  paths: '',
  parts: [],
  max: 3,
});

/** The form switched to a kind; a parallel group starts with two steps, a loop with one. */
const withKind = (form: StepForm, kind: StepKind): StepForm => {
  const least = kind === 'parallel' ? 2 : kind === 'loop' ? 1 : 0;
  return {
    ...form,
    kind,
    parts: [
      ...form.parts,
      ...Array.from({ length: Math.max(0, least - form.parts.length) }, () => blankLeaf(form.slot)),
    ],
  };
};

const isGroup = (kind: StepKind) => (GROUP_KINDS as readonly StepKind[]).includes(kind);

/** The form fields of a plain step's kind. */
function kindFields(kind: WorkflowLeafStep['kind']): Partial<LeafForm> & { kind: LeafKind } {
  if (kind.type === 'command')
    return { kind: 'command', command: kind.command, timeout: String(kind.timeout_seconds) };
  if (kind.type === 'prompt')
    return {
      kind: 'prompt',
      prompt: kind.prompt,
      target: kind.target ?? 'task',
      skill: kind.skill ?? null,
    };
  if (kind.type === 'review')
    return {
      kind: 'review',
      runtime: kind.runtime ?? KNOWN_RUNTIMES[0] ?? '',
      model: kind.model ?? null,
      effort: kind.effort ?? null,
      blocking: !!kind.blocking,
    };
  return { kind: kind.type };
}

const partOf =
  (slot: Slot) =>
  ({ id, title, kind, ...scope }: WorkflowLeafStep): LeafForm => ({
    ...blankLeaf(slot),
    id,
    title,
    scope,
    ...kindFields(kind),
  });

function formOf(slot: Slot, step: WorkflowStep): StepForm {
  const form: StepForm = {
    ...blankForm(slot),
    id: step.id,
    title: step.title,
    tiers: step.applies_to?.tiers ?? [],
    domains: step.applies_to?.domains ?? [],
    paths: step.when?.changed_paths.join('\n') ?? '',
  };
  const kind = step.kind;
  if (kind.type === 'parallel')
    return { ...form, kind: 'parallel', parts: kind.steps.map(partOf(slot)) };
  if (kind.type === 'loop')
    return { ...form, kind: 'loop', parts: [partOf(slot)(kind.step)], max: kind.max };
  return { ...form, ...kindFields(kind) };
}

/** A plain step's kind as typed; null while a field it needs is empty or out of range. */
function leafKindOf(form: LeafForm): WorkflowLeafStep['kind'] | null {
  switch (form.kind) {
    case 'command': {
      const command = form.command.trim();
      const timeout_seconds = Number(form.timeout);
      if (!command || !(timeout_seconds > 0)) return null;
      return { type: 'command', command, timeout_seconds };
    }
    case 'approval':
      return { type: 'approval' };
    case 'prompt': {
      const prompt = form.prompt.trim();
      if (!prompt) return null;
      return {
        type: 'prompt',
        prompt,
        target: form.target,
        ...(form.skill && { skill: form.skill }),
      };
    }
    case 'review':
      if (!form.runtime) return null;
      return {
        type: 'review',
        runtime: form.runtime,
        ...(form.model && { model: form.model }),
        ...(form.effort && { effort: form.effort }),
        blocking: form.blocking,
      };
  }
}

function leafOf(form: LeafForm, id: string): WorkflowLeafStep | null {
  const title = form.title.trim();
  const kind = leafKindOf(form);
  return title && kind ? { id, title, ...form.scope, kind } : null;
}

/** Whether the daemon runs a plain step in the slot; a review and a task-session prompt need the task's session. */
const fits = (slot: Slot, kind: StepKind, target?: 'task' | 'lead') =>
  !(kind === 'review' && slot === 'before_dispatch') &&
  !(kind === 'prompt' && target !== 'lead' && slot !== 'before_merge');

const leavesOf = (step: WorkflowStep): WorkflowLeafStep[] => {
  const kind = step.kind;
  if (kind.type === 'parallel') return kind.steps;
  if (kind.type === 'loop') return [kind.step];
  return [{ ...step, kind }];
};

/** Whether the step can run in the slot; before dispatch there is no diff for a path condition. */
const stepFits = (slot: Slot, step: WorkflowStep) =>
  [step, ...leavesOf(step)].every((s) => slot !== 'before_dispatch' || !s.when) &&
  leavesOf(step).every((leaf) =>
    fits(slot, leaf.kind.type, leaf.kind.type === 'prompt' ? leaf.kind.target : undefined),
  );

const pathsOf = (form: StepForm) =>
  form.paths
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** The step the form describes; null while a field it needs is empty or out of range. */
function stepOf(form: StepForm, id: string, newId: () => string): WorkflowStep | null {
  const title = form.title.trim();
  const changed_paths = pathsOf(form);
  if (!title || changed_paths.length > MAX_PATHS) return null;
  let kind: WorkflowStep['kind'] | null;
  if (form.kind === 'parallel') {
    const steps = form.parts.map((part) => leafOf(part, part.id ?? newId()));
    kind =
      steps.length >= 2 && steps.length <= MAX_PARTS && steps.every((step) => step !== null)
        ? { type: 'parallel', steps: steps as WorkflowLeafStep[] }
        : null;
  } else if (form.kind === 'loop') {
    const first = form.parts[0];
    const step = first ? leafOf(first, first.id ?? newId()) : null;
    kind = step ? { type: 'loop', step, max: form.max, until: 'passes' } : null;
  } else kind = leafKindOf({ ...form, kind: form.kind });
  if (!kind) return null;
  const applies_to = {
    ...(form.tiers.length > 0 ? { tiers: form.tiers } : {}),
    ...(form.domains.length > 0 ? { domains: form.domains } : {}),
  };
  const step: WorkflowStep = {
    id,
    title,
    ...(Object.keys(applies_to).length > 0 && { applies_to }),
    ...(changed_paths.length > 0 && { when: { changed_paths } }),
    kind,
  };
  return stepFits(form.slot, step) ? step : null;
}

/** The list with the value added or taken out, in the order of all. */
const toggled = <T,>(all: readonly T[], list: readonly T[], value: T): T[] =>
  all.filter((v) => (v === value ? !list.includes(v) : list.includes(v)));

function chips<T extends string>(
  label: string,
  all: readonly T[],
  on: readonly T[],
  name: (value: T) => string,
  onToggle: (value: T) => void,
) {
  return (
    <span className="wfl-chips" role="group" aria-label={label}>
      {all.map((value) => (
        <button
          key={value}
          type="button"
          className="wfl-chip"
          aria-label={name(value)}
          aria-pressed={on.includes(value)}
          onClick={() => onToggle(value)}
        >
          {name(value)}
        </button>
      ))}
    </span>
  );
}

function stepper(
  label: string,
  value: number,
  [low, high]: [number, number],
  disabled: boolean,
  onSet: (value: number) => void,
) {
  return (
    <span className="wfl-lim">
      <button
        type="button"
        className="ib"
        aria-label={t(
          { id: 'settings.workflow.decrease', defaultMessage: 'Decrease {param}' },
          { param: label },
        )}
        disabled={disabled || value - 1 < low}
        onClick={() => onSet(value - 1)}
      >
        <Minus aria-hidden="true" />
      </button>
      <output>{value}</output>
      <button
        type="button"
        className="ib"
        aria-label={t(
          { id: 'settings.workflow.increase', defaultMessage: 'Increase {param}' },
          { param: label },
        )}
        disabled={disabled || value + 1 > high}
        onClick={() => onSet(value + 1)}
      >
        <Plus aria-hidden="true" />
      </button>
    </span>
  );
}

const row = (label: string, control: ReactNode) => (
  <div className="wfl-row" key={label}>
    <span className="wfl-rl">{label}</span>
    <span className="wfl-rc">{control}</span>
  </div>
);

function choice<T extends string>(
  label: string,
  value: T | undefined,
  labels: Partial<Record<T, string>>,
  disabled: boolean,
  onPick: (value: T) => void,
) {
  return (
    <RadioGroup<T | null>
      className="seg"
      aria-label={label}
      value={value ?? null}
      disabled={disabled}
      onValueChange={(next) => {
        if (next) onPick(next);
      }}
    >
      {(Object.keys(labels) as T[]).map((v) => (
        <Radio.Root key={v} value={v}>
          {labels[v]}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

const POLICY_STEPS: readonly string[] = ['dispatch', 'gate', 'handback', 'wake'];

const MODES: readonly FlowPath[] = ['dispatch', 'review_loop', 'direct'];

const MODE_PATH: Record<FlowPath, string> = {
  dispatch: 'M4 12H10M10 12C14 12 14 5 18 5M10 12H18M10 12C14 12 14 19 18 19',
  review_loop: 'M4 12H20M16 12C16 20 8 20 8 12',
  direct: 'M4 12H20',
  parallel: 'M4 12H8M8 12C11 12 11 6 14 6H20M8 12H20M8 12C11 12 11 18 14 18H20',
};

/** The ways a task can run, each with the tiers that take it; they are changed in the settings. */
export function ModeList({ projectId }: { projectId: string }) {
  const { read: policy, error } = useWorkflowPolicy(projectId);
  const label = t({ id: 'insights.workflow.modes', defaultMessage: 'Orchestration' });
  return (
    <aside className="wfl-modes" aria-label={label}>
      <h3 className="wfl-cap">{label}</h3>
      {policy && (
        <ul className="wfl-ml">
          {MODES.map((mode) => {
            const tiers = TIERS.filter((tier) => policy.path[tier] === mode);
            return (
              <li key={mode} className="wfl-mode" data-off={tiers.length === 0 || undefined}>
                <svg className="wfl-mi" viewBox="0 0 24 24" aria-hidden="true">
                  <path d={MODE_PATH[mode]} />
                </svg>
                <span className="wfl-mt">
                  <span className="wfl-mn">{PATH_LABEL[mode]}</span>
                  {tiers.length > 0 && (
                    <span className="wfl-ms">{listText(...tiers.map(tierText))}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {!policy && error && (
        <p className="bd-perr" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn ghost sm wfl-mset"
        onClick={() => openSettingsPage(projectId, 'workflow')}
      >
        {t({ id: 'insights.workflow.editInSettings', defaultMessage: 'Change in settings' })}
      </button>
    </aside>
  );
}

export interface WorkflowBarProps {
  /** Unfinished plan tasks that the workflow runs. */
  inUse: number;
  version: number;
  dirty: boolean;
  busy: boolean;
  /** The read shown is an earlier mount's, not confirmed yet; saving waits for it. */
  stale: boolean;
  /** The saved workflow's running trial; the daemon changes no definition until it is decided. */
  trial?: { tasks: number; done: number };
  /** How many next tasks try the change on save; null lets every task take it. */
  trialTasks: number | null;
  onTrialTasks: (tasks: number | null) => void;
  onDiscard: () => void;
  onSaveAs: () => void;
  onSave: () => void;
}

/** The workflow's tasks in use, its version, and discarding or saving the unsaved changes. */
export function WorkflowBar({
  inUse,
  version,
  dirty,
  busy,
  stale,
  trial,
  trialTasks,
  onTrialTasks,
  onDiscard,
  onSaveAs,
  onSave,
}: WorkflowBarProps) {
  const tryLabel = t({
    id: 'insights.workflow.trial.try',
    defaultMessage: 'Try on the next tasks first',
  });
  const tasksLabel = t({
    id: 'insights.workflow.trial.tasks',
    defaultMessage: 'Tasks that try it',
  });
  const discardLabel = t({ id: 'insights.workflow.discard', defaultMessage: 'Discard' });
  const saveAsLabel = t({ id: 'insights.workflow.saveAs', defaultMessage: 'Save as' });
  const moreLabel = t({ id: 'insights.workflow.more', defaultMessage: 'More' });
  const onTry = (on: boolean) => onTrialTasks(on ? TRIAL_TASKS : null);
  return (
    <span className="wfl-bar">
      <span className="chip">
        {inUse > 0 && <StateGlyph name="running" />}
        {t(
          {
            id: 'insights.workflow.inUse',
            defaultMessage: '{count, plural, one {# task uses it} other {# tasks use it}}',
          },
          { count: inUse },
        )}
      </span>
      {trial && (
        <span
          className="chip"
          role="img"
          aria-label={t(
            {
              id: 'insights.workflow.trial.progress',
              defaultMessage: 'Trial: {done} of {tasks} tasks done',
            },
            trial,
          )}
        >
          <FlaskConical className="ic-sm" aria-hidden="true" />
          {t({ id: 'insights.workflow.trial.count', defaultMessage: '{done} / {tasks}' }, trial)}
        </span>
      )}
      {version > 0 && (
        <span className="wfl-ver">
          {t({ id: 'insights.workflow.version', defaultMessage: 'Version {version}' }, { version })}
        </span>
      )}
      {dirty && !trial && (
        <label className="wfl-try wfl-wide">
          <input
            type="checkbox"
            className="ps-sw"
            aria-label={tryLabel}
            checked={trialTasks !== null}
            disabled={busy}
            onChange={(e) => onTry(e.target.checked)}
          />
          {tryLabel}
        </label>
      )}
      {dirty && !trial && trialTasks !== null && (
        <span role="group" aria-label={tasksLabel}>
          {stepper(tasksLabel, trialTasks, [1, MAX_TRIAL], busy, onTrialTasks)}
        </span>
      )}
      {dirty && (
        <button type="button" className="btn ghost wfl-wide" disabled={busy} onClick={onDiscard}>
          {discardLabel}
        </button>
      )}
      <button
        type="button"
        className="btn ghost wfl-wide"
        disabled={busy || stale}
        aria-busy={stale || undefined}
        onClick={onSaveAs}
      >
        {saveAsLabel}
      </button>
      <BarMenu
        label={moreLabel}
        align="end"
        trigger={
          <button type="button" className="ib wfl-more" aria-label={moreLabel}>
            <Ellipsis aria-hidden="true" />
          </button>
        }
      >
        {dirty && !trial && (
          <MenuCheckboxItem checked={trialTasks !== null} disabled={busy} onChange={onTry}>
            {tryLabel}
          </MenuCheckboxItem>
        )}
        {dirty && (
          <MenuItem disabled={busy} onClick={onDiscard}>
            {discardLabel}
          </MenuItem>
        )}
        <MenuItem disabled={busy || stale} onClick={onSaveAs}>
          {saveAsLabel}
        </MenuItem>
      </BarMenu>
      <button
        type="button"
        className="btn pri"
        disabled={!dirty || busy || stale || !!trial}
        aria-busy={busy || stale || undefined}
        onClick={onSave}
      >
        {t({ id: 'insights.workflow.saveToProject', defaultMessage: 'Save to project' })}
      </button>
    </span>
  );
}

/** The workflow policy parameters that govern a fixed step; they are changed in the settings. */
export function PolicyFields({ projectId, step }: { projectId: string; step: string }) {
  const { read: policy, error } = useWorkflowPolicy(projectId);
  if (!POLICY_STEPS.includes(step)) return null;
  if (!policy)
    return error ? (
      <p className="bd-perr" role="alert">
        {error}
      </p>
    ) : null;

  const noLimit = t({ id: 'settings.common.noLimit', defaultMessage: 'No limit' });
  const value = (param: keyof typeof PARAM_LABEL, shown: string | number) =>
    row(PARAM_LABEL[param], <span className="wfl-pv">{shown}</span>);
  const limits = Object.keys(policy.runtime_parallel ?? {})
    .sort(compareRuntimes)
    .flatMap((runtime) => {
      const limit = policy.runtime_parallel?.[runtime];
      return limit === undefined ? [] : [`${runtimeName(runtime)} ${limit}`];
    });
  const link = (page: 'workflow' | 'usage' | 'gates', label: string) => (
    <button
      key={page}
      type="button"
      className="btn ghost sm"
      onClick={() => openSettingsPage(projectId, page)}
    >
      {label}
    </button>
  );

  let rows: ReactNode[] = [];
  let links: ReactNode[] = [
    link(
      'workflow',
      t({ id: 'insights.workflow.editInSettings', defaultMessage: 'Change in settings' }),
    ),
  ];
  if (step === 'dispatch') {
    rows = [
      value('max_parallel', policy.max_parallel),
      value('runtime_parallel', limits.length > 0 ? listText(...limits) : noLimit),
      value(
        'dispatch_paused',
        policy.dispatch_paused
          ? t({ id: 'insights.workflow.on', defaultMessage: 'On' })
          : t({ id: 'insights.workflow.off', defaultMessage: 'Off' }),
      ),
      value('runtime_quota_threshold', policy.runtime_quota_threshold ?? DEFAULT_QUOTA_THRESHOLD),
      value('project_budget', policy.project_budget?.input_tokens ?? noLimit),
    ];
    links = [
      link(
        'workflow',
        t({ id: 'insights.workflow.workflowSettings', defaultMessage: 'Workflow settings' }),
      ),
      link('usage', t({ id: 'insights.workflow.usageSettings', defaultMessage: 'Usage settings' })),
    ];
  }
  if (step === 'handback' || step === 'gate') {
    rows = [value('handback_limit', policy.handback_limit)];
    links = [
      link(
        'gates',
        t({ id: 'insights.workflow.editInSettings', defaultMessage: 'Change in settings' }),
      ),
    ];
  }
  if (step === 'wake') rows = [value('acceptance_wake', WAKE_LABEL[policy.acceptance_wake])];
  return (
    <div className="wfl-rows">
      {rows}
      <div className="wfl-set">{links}</div>
    </div>
  );
}

type Selected = { type: 'fixed'; id: string } | { type: 'form'; form: StepForm } | null;

const STEP_DRAG = 'text/plain';
const KIND_DRAG = 'application/x-pantheon-step-kind';
// A skill step is a prompt step that runs a skill.
type PaletteItem = StepKind | 'skill';
const PALETTE: readonly PaletteItem[] = [
  'prompt',
  'command',
  'review',
  'approval',
  'skill',
  'parallel',
  'loop',
];
const paletteKind = (item: PaletteItem): StepKind => (item === 'skill' ? 'prompt' : item);

/** The task states a build step counts, in the order its bar draws them. */
const BUILD_STATES: {
  key: string;
  states: readonly BoardTaskState[];
  text: (count: number) => string;
}[] = [
  {
    key: 'running',
    states: ['claimed', 'running'],
    text: (count) =>
      t({ id: 'insights.workflow.build.running', defaultMessage: '{count} running' }, { count }),
  },
  {
    key: 'waiting',
    states: ['waiting_approval'],
    text: (count) =>
      t(
        { id: 'insights.workflow.build.waiting', defaultMessage: '{count} waiting for you' },
        { count },
      ),
  },
  {
    key: 'blocked',
    states: ['blocked'],
    text: (count) =>
      t({ id: 'insights.workflow.build.blocked', defaultMessage: '{count} blocked' }, { count }),
  },
];

/** A step's first-run passes over the last 30 days, with a bar per five days. */
const stepResults = (result: WorkflowStepResult) => (
  <div className="wfl-res">
    <div className="wfl-rh">
      <h4 className="wfl-cap">
        {t({ id: 'insights.workflow.result.title', defaultMessage: "This step's results" })}
      </h4>
      <span className="wfl-rm">
        {t({ id: 'insights.workflow.result.range', defaultMessage: 'Last 30 days' })}
      </span>
    </div>
    <div className="wfl-rh">
      <b className="wfl-pct">
        {t(
          { id: 'insights.workflow.result.percent', defaultMessage: '{percent}%' },
          { percent: Math.round((result.passed / result.tasks) * 100) },
        )}
      </b>
      <span
        className="wfl-bars"
        role="img"
        aria-label={t(
          {
            id: 'insights.workflow.result.bars',
            defaultMessage:
              '{passed} of {tasks, plural, one {# task} other {# tasks}} passed at the first run in the last 30 days',
          },
          { passed: result.passed, tasks: result.tasks },
        )}
      >
        {result.buckets.map((b, i) => (
          <i
            key={i}
            data-empty={b.tasks === 0 || undefined}
            data-failed={(b.tasks > 0 && b.passed === 0) || undefined}
            style={{ '--v': `${b.tasks ? (b.passed / b.tasks) * 100 : 0}%` } as CSSProperties}
          />
        ))}
      </span>
      <span className="wfl-rm">
        {t({ id: 'insights.workflow.result.firstRun', defaultMessage: 'First-run pass' })}
      </span>
    </div>
  </div>
);

/** The project's workflow as a step chart; custom steps are added, edited and ordered here and saved together. */
export function WorkflowTab({
  projectId,
  model,
  onOpenSession,
  bar,
}: {
  projectId: string;
  model: BoardModel;
  onOpenSession: (sessionId: string) => void;
  /** The top bar's place for the save bar, once it is in. */
  bar?: HTMLElement | null;
}) {
  // The project the state below belongs to; another one starts over.
  const [owner, setOwner] = useState(projectId);
  const shownProject = useRef(projectId);
  shownProject.current = projectId;
  // The workflow edited: the one picked, or the default one once a change is made to it.
  const [workflowId, setWorkflowId] = useState<string | undefined>(undefined);
  const read = useWorkflowDefinition(projectId, owner === projectId ? workflowId : undefined);
  const list = useWorkflowList(projectId);
  // The name typed for a copy; null while none is being made.
  const [naming, setNaming] = useState<string | null>(null);
  const [trialTasks, setTrialTasks] = useState<number | null>(null);
  // The definition a save returned, shown until a read reaches its version.
  const [saved, setSaved] = useState<Pick<
    WorkflowDefinitionView,
    'definition' | 'definition_version'
  > | null>(null);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const latest = useRef(draft);
  latest.current = draft;
  const [selected, setSelected] = useState<Selected>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sending = useRef(false);
  const project = useBoard((s) => s.board?.projects.find((p) => p.id === projectId));
  const [merging, setMerging] = useState(false);
  const [mergeFailure, setMergeFailure] = useState<string | null>(null);
  const switching = useRef(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [gateFailure, setGateFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ root: string; line: string } | null>(null);
  const gating = useRef(false);
  const routing = useRoutingTable(projectId);
  const runtimeStatus = useRuntimeStatus().read;
  const form = selected?.type === 'form' ? selected.form : null;
  const leaves = form ? (isGroup(form.kind) ? form.parts : [form]) : [];
  const skills = useSkillChoices(leaves.some((leaf) => leaf.kind === 'prompt') ? projectId : null);
  const reviewModels = useRuntimeModels(projectId, [
    ...new Set(leaves.filter((leaf) => leaf.kind === 'review').map((leaf) => leaf.runtime)),
  ]);
  if (owner !== projectId) {
    setOwner(projectId);
    setWorkflowId(undefined);
    setNaming(null);
    setTrialTasks(null);
    setSaved(null);
    setDraft(null);
    setSelected(null);
    setFailure(null);
    setMergeFailure(null);
    setGateFailure(null);
    setAdding(null);
  }

  const heading = t({ id: 'insights.sections.workflow', defaultMessage: 'Workflow' });
  const base =
    saved && (!read.read || read.read.definition_version < saved.definition_version)
      ? saved
      : read.read;
  // A read of the workflow edited before the pick is not shown as the picked one.
  if (!base || !read.read || (workflowId !== undefined && read.read.id !== workflowId))
    return (
      <section className="wfl" aria-label={heading}>
        {read.error ? <Failure error={read.error} onRetry={read.reload} /> : <Skeleton />}
      </section>
    );

  const definition = draft ?? base.definition;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(base.definition);
  const shownId = read.read.id;
  // A change binds the editor to the workflow shown, so a new default elsewhere does not take it.
  const change = (next: WorkflowDefinition) => {
    setDraft(next);
    setWorkflowId((id) => id ?? shownId);
  };
  const setForm = (patch: Partial<StepForm> | ((form: StepForm) => Partial<StepForm>)) =>
    setSelected((s) =>
      s?.type === 'form'
        ? {
            type: 'form',
            form: { ...s.form, ...(typeof patch === 'function' ? patch(s.form) : patch) },
          }
        : s,
    );

  const save = async () => {
    if (!draft || read.stale || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const sent = draft;
    const result = await saveDefinition(projectId, sent, base.definition_version, {
      id: workflowId,
      trial_tasks: trialTasks ?? undefined,
    });
    sending.current = false;
    setBusy(false);
    if (shownProject.current !== projectId) return;
    if (!result.ok) {
      setFailure(
        result.conflict
          ? t({
              id: 'insights.workflow.conflict',
              defaultMessage:
                'The workflow changed elsewhere and was read again; your changes are kept. Save again.',
            })
          : result.error,
      );
      if (result.conflict) read.reload();
      return;
    }
    // An edit made while the save was out stays unsaved.
    setDraft((now) => (now === sent ? null : now));
    setTrialTasks(null);
    setSaved(result.saved);
    read.reload();
    list.reload();
  };
  const workflows = list.read ?? [];
  const current = workflows.find((w) => (workflowId ? w.id === workflowId : w.is_default));
  const pick = (id: string) => {
    setWorkflowId(id);
    setSaved(null);
    setDraft(null);
    setSelected(null);
    setFailure(null);
    setTrialTasks(null);
  };
  // The copy takes the unsaved changes too, saved onto it as its next version.
  const saveAs = async () => {
    const name = naming?.trim();
    if (!name || read.stale || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const copy = await saveWorkflowAs(projectId, workflowId ?? shownId, name);
    const changes =
      copy.ok && copy.view && draft && dirty
        ? await saveDefinition(projectId, draft, copy.view.definition_version, {
            id: copy.view.id,
          })
        : null;
    sending.current = false;
    setBusy(false);
    if (shownProject.current !== projectId) return;
    if (!copy.ok) return setFailure(copy.error);
    setNaming(null);
    list.reload();
    if (copy.view) {
      // An edit made while the copy was being saved goes on as the copy's unsaved change.
      const kept =
        latest.current !== draft ? latest.current : changes && !changes.ok ? draft : null;
      setWorkflowId(copy.view.id);
      setSaved(null);
      setTrialTasks(null);
      setDraft(kept);
    }
    if (changes && !changes.ok) setFailure(changes.error);
  };
  const makeDefault = async () => {
    if (!current || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const error = await setDefaultWorkflow(projectId, current.id);
    sending.current = false;
    setBusy(false);
    if (shownProject.current !== projectId) return;
    if (error) return setFailure(error);
    list.reload();
    read.reload();
  };
  const toggleAutoMerge = async (enabled: boolean) => {
    if (!project || switching.current) return;
    switching.current = true;
    setMerging(true);
    setMergeFailure(null);
    const result = await setAutoMerge(project, enabled);
    switching.current = false;
    setMerging(false);
    if (shownProject.current !== projectId) return;
    if (!result.ok) return setMergeFailure(failureText(result.error));
    read.reload();
  };
  const policyOf = (id: string) => read.read!.fixed_steps.find((s) => s.id === id)?.policy ?? {};
  // The board's project, so a change is built from the commands of the revision it is sent at.
  const gates: Record<string, GateCommand[]> = project?.gates ?? {};
  const setGate = async (root: string, commands: GateCommand[]) => {
    if (!project || gating.current) return false;
    gating.current = true;
    setGateBusy(true);
    setGateFailure(null);
    const request = gateSetRequest(project, root, commands);
    const result = await runCommand(request.type, request.input, request.expected_revision);
    gating.current = false;
    setGateBusy(false);
    if (shownProject.current !== projectId) return false;
    if (!result.ok) {
      setGateFailure(failureText(result.error));
      return false;
    }
    read.reload();
    return true;
  };
  const addGate = async () => {
    if (!adding) return;
    const split = splitArgv(adding.line);
    if (!split.ok) return setGateFailure(split.error);
    if (split.argv.length === 0) return;
    const command = { name: adding.line.trim(), argv: split.argv };
    if (await setGate(adding.root, [...(gates[adding.root] ?? []), command])) setAdding(null);
  };
  const discard = () => {
    setDraft(null);
    setFailure(null);
    if (selected?.type === 'form') setSelected(null);
  };
  const submit = () => {
    if (!form) return;
    const step = stepOf(form, form.id ?? crypto.randomUUID(), () => crypto.randomUUID());
    if (!step) return;
    change(
      form.id
        ? replaceStep(definition, step)
        : placeStep(definition, step, form.slot, form.at ?? definition.slots[form.slot].length),
    );
    setSelected(null);
  };
  const dropAt = (slot: Slot, index: number) => (e: DragEvent) => {
    e.preventDefault();
    const item = PALETTE.find((k) => k === e.dataTransfer.getData(KIND_DRAG));
    if (item) {
      if (fits(slot, paletteKind(item), 'lead'))
        setSelected({
          type: 'form',
          form: { ...withKind(blankForm(slot), paletteKind(item)), at: index },
        });
      return;
    }
    const id = e.dataTransfer.getData(STEP_DRAG);
    const from = slotOf(definition, id);
    const step = from && definition.slots[from].find((s) => s.id === id);
    if (step && stepFits(slot, step)) change(placeStep(definition, step, slot, index));
  };
  const dragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(KIND_DRAG) ? 'copy' : 'move';
  };

  const tasks = model.tasks.filter((task) => task.workflow_id === shownId);
  const here = new Map<string, number>();
  const runs: { run: StepRun; task: string; state: string; session?: string }[] = [];
  for (const task of model.tasks)
    for (const run of task.step_runs ?? []) {
      if (run.workflow_id !== shownId) continue;
      if (run.state === 'waiting' || run.state === 'running')
        here.set(run.step_id, (here.get(run.step_id) ?? 0) + 1);
      if (run.state !== 'passed' && run.state !== 'pending')
        runs.push({
          run,
          task: task.title,
          state: RUN_STATE_LABEL[run.state],
          session: run.session_id ?? task.claim?.session_id,
        });
    }
  runs.sort((a, b) => b.run.created_at - a.run.created_at);
  const inUse = tasks.filter(
    (task) => task.path && task.state !== 'merged' && task.state !== 'failed',
  ).length;
  const building = BUILD_STATES.map((group) => ({
    ...group,
    count: tasks.filter((task) => task.state && group.states.includes(task.state)).length,
  }));
  const built = building.reduce((sum, group) => sum + group.count, 0);

  const gateCommands = Object.values(gates).flat();
  const line = (content: ReactNode) => <span className="wfl-ns">{content}</span>;
  const fixedSub = (id: string): ReactNode => {
    const policy = policyOf(id);
    switch (id) {
      case 'plan_review':
        return line(
          definition.plan_review.tiers.length > 0
            ? listText(...definition.plan_review.tiers.map(tierText))
            : t({ id: 'insights.workflow.sub.off', defaultMessage: 'Off' }),
        );
      case 'dispatch':
        return (
          policy.dispatch_paused === true &&
          line(t({ id: 'insights.workflow.sub.paused', defaultMessage: 'Paused' }))
        );
      case 'build': {
        const runtimes = [
          ...new Set(
            (routing.read?.cells ?? []).flatMap((cell) => (cell.first ? [cell.first.runtime] : [])),
          ),
        ].sort(compareRuntimes);
        const slots = model.slots;
        return (
          <>
            {line(
              <>
                {runtimes.length > 0 && (
                  <span
                    className="wfl-rts"
                    role="img"
                    aria-label={listText(...runtimes.map(runtimeName))}
                  >
                    {runtimes.map((runtime) => (
                      <RuntimeGlyph key={runtime} runtime={runtime} size={12} />
                    ))}
                  </span>
                )}
                <span>
                  {t(
                    {
                      id: 'insights.workflow.sub.parallel',
                      defaultMessage:
                        '{count, plural, one {Up to # at once} other {Up to # at once}}',
                    },
                    { count: policyOf('dispatch').max_parallel as number },
                  )}
                </span>
              </>,
            )}
            {(slots || built > 0) &&
              line(
                <>
                  <span
                    className="wfl-meter"
                    role="img"
                    aria-label={listText(
                      slots &&
                        t(
                          {
                            id: 'insights.workflow.sub.slots',
                            defaultMessage: '{used} of {limit} slots in use',
                          },
                          { used: slots.used, limit: slots.limit },
                        ),
                      ...building.map((group) => group.count > 0 && group.text(group.count)),
                    )}
                  >
                    {building.map(
                      (group) =>
                        group.count > 0 && (
                          <i
                            key={group.key}
                            data-state={group.key}
                            style={{ flexGrow: group.count }}
                          />
                        ),
                    )}
                    {slots && slots.limit > slots.used && (
                      <i style={{ flexGrow: slots.limit - slots.used }} />
                    )}
                  </span>
                  <span>
                    {t(
                      {
                        id: 'insights.workflow.here',
                        defaultMessage: '{count, plural, one {# here now} other {# here now}}',
                      },
                      { count: built },
                    )}
                  </span>
                </>,
              )}
          </>
        );
      }
      case 'gate':
        return line(
          t(
            {
              id: 'insights.workflow.sub.commands',
              defaultMessage: '{count, plural, one {# command} other {# commands}}',
            },
            { count: gateCommands.length },
          ),
        );
      case 'merge':
        return line(
          policy.auto_merge === true
            ? t({ id: 'insights.workflow.sub.autoMerge', defaultMessage: 'Automatic' })
            : t({ id: 'insights.workflow.sub.manualMerge', defaultMessage: 'You merge' }),
        );
      case 'handback':
        return line(
          policy.handback_limit === 0
            ? t({ id: 'settings.gate.fixOff', defaultMessage: "Don't fix" })
            : t(
                {
                  id: 'insights.workflow.sub.times',
                  defaultMessage: '{count, plural, one {Up to # time} other {Up to # times}}',
                },
                { count: policy.handback_limit as number },
              ),
        );
      case 'wake':
        return line(WAKE_LABEL[policy.acceptance_wake as WorkflowPolicy['acceptance_wake']]);
      case 'review':
        return line(
          t(
            {
              id: 'insights.workflow.sub.rounds',
              defaultMessage: '{count, plural, one {Up to # round} other {Up to # rounds}}',
            },
            { count: definition.review.max_rounds },
          ),
        );
    }
    return null;
  };

  const fixedNode = (id: string) => {
    const Icon = FIXED_ICON[id] ?? Circle;
    const on = selected?.type === 'fixed' && selected.id === id;
    return (
      <button
        type="button"
        className="wfl-nd"
        data-step={id}
        aria-pressed={on}
        onClick={() => setSelected(on ? null : { type: 'fixed', id })}
      >
        <span className="wfl-nh">
          <Icon aria-hidden="true" />
          <span className="wfl-ct">{fixedLabel(id)}</span>
        </span>
        {fixedSub(id)}
      </button>
    );
  };

  const customNode = (slot: Slot, step: WorkflowStep, index: number, count: number) => {
    const Icon = KIND_ICON[step.kind.type];
    const on = form?.id === step.id;
    const edit = () => setSelected({ type: 'form', form: formOf(slot, step) });
    return (
      <span className="wfl-cs" role="group" aria-label={step.title} data-selected={on || undefined}>
        <button
          type="button"
          className="wfl-cb"
          data-step={step.id}
          data-custom="true"
          data-kind={step.kind.type}
          aria-pressed={on}
          draggable
          onClick={edit}
          onDragStart={(e) => {
            e.dataTransfer.setData(STEP_DRAG, step.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={dragOver}
          onDrop={dropAt(slot, index)}
        >
          <Icon aria-label={KIND_LABEL[step.kind.type]} role="img" />
          <span className="wfl-ct">{step.title}</span>
          {step.kind.type === 'parallel' && (
            <span className="wfl-par">
              {step.kind.steps.map((part) => {
                const PartIcon = KIND_ICON[part.kind.type];
                return (
                  <span key={part.id} className="wfl-pp" data-part={part.id}>
                    <PartIcon aria-hidden="true" />
                    <span className="wfl-ct">{part.title}</span>
                  </span>
                );
              })}
            </span>
          )}
          {here.has(step.id) && (
            <span className="wfl-cn">
              {t(
                {
                  id: 'insights.workflow.here',
                  defaultMessage: '{count, plural, one {# here now} other {# here now}}',
                },
                { count: here.get(step.id)! },
              )}
            </span>
          )}
        </button>
        <Menu.Root>
          <Menu.Trigger
            className="ib"
            aria-label={t(
              { id: 'insights.workflow.stepMenu', defaultMessage: 'Actions for “{title}”' },
              { title: step.title },
            )}
          >
            <Ellipsis aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
              <Menu.Popup className="wmenu pop">
                <Menu.Item onClick={edit}>
                  {t({ id: 'insights.workflow.edit', defaultMessage: 'Edit' })}
                </Menu.Item>
                <Menu.Item
                  disabled={index === 0}
                  onClick={() => change(moveStep(definition, step.id, -1))}
                >
                  {t({ id: 'insights.workflow.moveUp', defaultMessage: 'Move up' })}
                </Menu.Item>
                <Menu.Item
                  disabled={index === count - 1}
                  onClick={() => change(moveStep(definition, step.id, 1))}
                >
                  {t({ id: 'insights.workflow.moveDown', defaultMessage: 'Move down' })}
                </Menu.Item>
                <Menu.Separator className="pjm-sep" />
                <Menu.Item
                  className="pj-danger"
                  onClick={() => {
                    change(removeStep(definition, step.id));
                    if (on) setSelected(null);
                  }}
                >
                  {t({ id: 'insights.workflow.delete', defaultMessage: 'Delete' })}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {step.kind.type === 'loop' && (
          <span
            className="wfl-self"
            role="img"
            aria-label={t(
              {
                id: 'insights.workflow.loop.self',
                defaultMessage:
                  '{count, plural, one {Runs again until it passes, at most # time} other {Runs again until it passes, at most # times}}',
              },
              { count: step.kind.max },
            )}
          />
        )}
      </span>
    );
  };

  const slotNode = (slot: Slot) => {
    const steps = definition.slots[slot];
    const adding = form && !form.id && form.slot === slot;
    return (
      <ol className="wfl-slot" aria-label={SLOT_LABEL[slot]} data-slot={slot}>
        {steps.map((step, i) => (
          <li key={step.id} className="wfl-it">
            {customNode(slot, step, i, steps.length)}
          </li>
        ))}
        <li className="wfl-it">
          <button
            type="button"
            className="wfl-add"
            aria-label={t(
              { id: 'insights.workflow.addTo', defaultMessage: 'Add a step {slot}' },
              { slot: SLOT_LABEL[slot].toLowerCase() },
            )}
            aria-pressed={!!adding}
            onClick={() => setSelected(adding ? null : { type: 'form', form: blankForm(slot) })}
            onDragOver={dragOver}
            onDrop={dropAt(slot, steps.length)}
          >
            <Plus className="ic-sm" aria-hidden="true" />
          </button>
        </li>
      </ol>
    );
  };

  const gatePanel = () => {
    const roots = [...new Set([...(project?.roots ?? []), ...Object.keys(gates)])];
    const many = roots.length > 1;
    const commandLabel = t({ id: 'insights.workflow.command', defaultMessage: 'Command line' });
    const runLabel = t({ id: 'insights.workflow.gate.commands', defaultMessage: 'Run in order' });
    return (
      <div className="wfl-gate" role="group" aria-label={runLabel}>
        <span className="wfl-cap" aria-hidden="true">
          {runLabel}
        </span>
        {roots.map((root) => (
          <div
            key={root}
            className="wfl-gr"
            role={many ? 'group' : undefined}
            aria-label={many ? root : undefined}
          >
            {many && <code className="wfl-gp">{root}</code>}
            <ul className="wfl-gates">
              {(gates[root] ?? []).map((gate, i) => {
                const text = joinArgv(gate.argv);
                return (
                  <li key={i}>
                    <SquareTerminal className="ic-sm" aria-hidden="true" />
                    <Tip content={gate.name === text ? text : listText(gate.name, text)}>
                      <code tabIndex={0}>{text}</code>
                    </Tip>
                    <button
                      type="button"
                      className="ib"
                      aria-label={t(
                        { id: 'insights.workflow.gate.remove', defaultMessage: 'Remove {command}' },
                        { command: text },
                      )}
                      disabled={!project || gateBusy}
                      onClick={() =>
                        void setGate(
                          root,
                          gates[root]!.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <X aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {adding?.root === root ? (
              <span className="wfl-gadd">
                <input
                  className="bd-fsel wfl-inp"
                  aria-label={commandLabel}
                  spellCheck={false}
                  value={adding.line}
                  onChange={(e) => setAdding({ root, line: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void addGate();
                  }}
                />
                <button
                  type="button"
                  className="btn pri"
                  disabled={!adding.line.trim() || gateBusy}
                  aria-busy={gateBusy || undefined}
                  onClick={() => void addGate()}
                >
                  {t({ id: 'insights.workflow.add', defaultMessage: 'Add' })}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn ghost"
                disabled={!project || gateBusy}
                onClick={() => setAdding({ root, line: '' })}
              >
                <Plus className="ic-sm" aria-hidden="true" />
                {t({ id: 'insights.workflow.gate.add', defaultMessage: 'Add a command' })}
              </button>
            )}
          </div>
        ))}
        {gateFailure && (
          <p className="bd-perr" role="alert">
            {gateFailure}
          </p>
        )}
      </div>
    );
  };

  const fixedPanel = (id: string) => {
    const policy = policyOf(id);
    const timeouts = [
      ...new Set(gateCommands.map((c) => c.timeout_ms ?? DEFAULT_TIMEOUT_SECONDS * 1000)),
    ];
    return (
      <>
        {id === 'plan_review' &&
          row(
            t({ id: 'insights.workflow.tiers', defaultMessage: 'Tiers' }),
            chips(
              t({
                id: 'insights.workflow.planReviewTiersOf',
                defaultMessage: 'Plan review tiers',
              }),
              TIERS,
              definition.plan_review.tiers,
              tierText,
              (tier) =>
                change({
                  ...definition,
                  plan_review: { tiers: toggled(TIERS, definition.plan_review.tiers, tier) },
                }),
            ),
          )}
        {id === 'review' &&
          row(
            roundsLabel(),
            stepper(
              roundsLabel(),
              definition.review.max_rounds,
              [1, MAX_ROUNDS],
              false,
              (max_rounds) => change({ ...definition, review: { max_rounds } }),
            ),
          )}
        {id === 'gate' && gatePanel()}
        {id === 'merge' &&
          row(
            t({ id: 'insights.workflow.autoMerge', defaultMessage: 'Merge automatically' }),
            <>
              <input
                type="checkbox"
                className="ps-sw"
                aria-label={t({
                  id: 'insights.workflow.autoMerge',
                  defaultMessage: 'Merge automatically',
                })}
                checked={policy.auto_merge === true}
                disabled={!project || merging}
                onChange={(e) => void toggleAutoMerge(e.target.checked)}
              />
              {mergeFailure && (
                <span className="wfl-err" role="alert">
                  {mergeFailure}
                </span>
              )}
            </>,
          )}
        <PolicyFields projectId={projectId} step={id} />
        {id === 'gate' &&
          timeouts.length > 0 &&
          row(
            t({ id: 'insights.workflow.gate.timeout', defaultMessage: 'Timeout' }),
            <span className="wfl-val">{listText(...timeouts.map(durationText))}</span>,
          )}
      </>
    );
  };

  const formPanel = (form: StepForm) => {
    const ready = stepOf(form, form.id ?? '', () => '') !== null;
    const field = (label: string, control: ReactNode) => (
      <label className="wfl-row" key={label}>
        <span className="wfl-rl">{label}</span>
        <span className="wfl-rc">{control}</span>
      </label>
    );
    const titleLabel = t({ id: 'insights.workflow.title', defaultMessage: 'Title' });
    const commandLabel = t({ id: 'insights.workflow.command', defaultMessage: 'Command line' });
    const timeoutLabel = t({
      id: 'insights.workflow.timeout',
      defaultMessage: 'Timeout (seconds)',
    });
    const promptLabel = t({ id: 'insights.workflow.prompt', defaultMessage: 'Prompt text' });
    const targetLabel = t({ id: 'insights.workflow.target', defaultMessage: 'Send to' });
    const skillLabel = t({ id: 'insights.workflow.skill', defaultMessage: 'Skill' });
    const runtimeLabel = t({ id: 'insights.workflow.runtime', defaultMessage: 'Runtime' });
    const modelLabel = t({ id: 'insights.workflow.model', defaultMessage: 'Model' });
    const effortLabel = t({ id: 'insights.workflow.effort', defaultMessage: 'Effort' });
    const byDefault = t({ id: 'insights.workflow.byDefault', defaultMessage: 'Default' });
    const blockingLabel = t({
      id: 'insights.workflow.blocking',
      defaultMessage: 'Fail on blocking findings',
    });
    const tiersLabel = t({ id: 'insights.workflow.tiers', defaultMessage: 'Tiers' });
    const domainsLabel = t({ id: 'insights.workflow.domains', defaultMessage: 'Domains' });
    const kindLabel = t({ id: 'insights.workflow.kind', defaultMessage: 'Kind' });
    const pathsLabel = t({
      id: 'insights.workflow.when',
      defaultMessage: 'Only when these paths change',
    });
    const maxLabel = t({ id: 'insights.workflow.loop.max', defaultMessage: 'Most runs' });
    const kinds = <K extends StepKind>(list: readonly K[], value: K, onPick: (kind: K) => void) => (
      <RadioGroup<K>
        className="seg wfl-kinds"
        aria-label={kindLabel}
        value={value}
        onValueChange={onPick}
      >
        {list.map((kind) => {
          const Icon: LucideIcon = KIND_ICON[kind];
          return (
            <Radio.Root key={kind} value={kind}>
              <Icon className="ic-sm" aria-hidden="true" />
              {KIND_LABEL[kind]}
            </Radio.Root>
          );
        })}
      </RadioGroup>
    );
    const titleField = (value: string, onTitle: (title: string) => void) =>
      field(
        titleLabel,
        <input
          className="bd-fsel wfl-inp"
          aria-label={titleLabel}
          value={value}
          onChange={(e) => onTitle(e.target.value)}
        />,
      );
    const setPart = (i: number, patch: Partial<LeafForm>) =>
      setForm((now) => ({
        parts: now.parts.map((part, j) => (j === i ? { ...part, ...patch } : part)),
      }));
    const shownParts = form.kind === 'loop' ? form.parts.slice(0, 1) : form.parts;
    const partLabel = (number: number) =>
      t({ id: 'insights.workflow.part', defaultMessage: 'Step {number} of the group' }, { number });
    // The fields of a plain step's kind, for the step itself or one step of a group.
    const leafFields = (leaf: LeafForm, set: (patch: Partial<LeafForm>) => void) => {
      const skillChoices =
        leaf.skill && !skills.some((s) => s.path === leaf.skill!.path)
          ? [leaf.skill, ...skills]
          : skills;
      const listed = reviewModels[leaf.runtime],
        models = listed?.state === 'ready' ? listed.models : [],
        entry = models.find((m) => m.id === leaf.model || m.resolved === leaf.model);
      // Without a model the review runs on the runtime's default one.
      const efforts = (leaf.model === null ? defaultModel(models) : entry)?.efforts ?? [];
      return (
        <>
          {leaf.kind === 'command' && (
            <>
              {field(
                commandLabel,
                <input
                  className="bd-fsel wfl-inp"
                  aria-label={commandLabel}
                  spellCheck={false}
                  value={leaf.command}
                  onChange={(e) => set({ command: e.target.value })}
                />,
              )}
              {field(
                timeoutLabel,
                <input
                  className="bd-fsel wfl-num"
                  inputMode="numeric"
                  aria-label={timeoutLabel}
                  aria-invalid={!(Number(leaf.timeout) > 0) || undefined}
                  value={leaf.timeout}
                  onChange={(e) => set({ timeout: e.target.value })}
                />,
              )}
            </>
          )}
          {leaf.kind === 'prompt' && (
            <>
              {field(
                promptLabel,
                <textarea
                  className="bd-fsel wfl-ta"
                  aria-label={promptLabel}
                  rows={3}
                  value={leaf.prompt}
                  onChange={(e) => set({ prompt: e.target.value })}
                />,
              )}
              {row(
                targetLabel,
                choice(
                  targetLabel,
                  leaf.target,
                  form.slot === 'before_merge' ? TARGET_LABEL : { lead: TARGET_LABEL.lead },
                  false,
                  (target) => set({ target }),
                ),
              )}
              {field(
                skillLabel,
                <Select
                  aria-label={skillLabel}
                  value={leaf.skill?.path ?? ''}
                  onChange={(path) =>
                    set({
                      skill: skillChoices.find((s) => s.path === path) ?? null,
                    })
                  }
                  options={[
                    {
                      value: '',
                      label: t({ id: 'insights.workflow.noSkill', defaultMessage: 'No skill' }),
                    },
                    ...skillChoices.map((skill) => ({ value: skill.path, label: skill.name })),
                  ]}
                />,
              )}
            </>
          )}
          {leaf.kind === 'review' && (
            <>
              {field(
                runtimeLabel,
                <Select
                  aria-label={runtimeLabel}
                  value={leaf.runtime}
                  onChange={(runtime) => set({ runtime, model: null, effort: null })}
                  options={offeredRuntimes(runtimeStatus, [leaf.runtime]).map((runtime) => ({
                    value: runtime,
                    label: runtimeName(runtime),
                  }))}
                />,
              )}
              {field(
                modelLabel,
                <Select
                  aria-label={modelLabel}
                  value={leaf.model ?? ''}
                  onChange={(id) => {
                    const efforts = models.find((m) => m.id === id)?.efforts ?? [];
                    set({
                      model: id || null,
                      ...(leaf.effort && !efforts.includes(leaf.effort) && { effort: null }),
                    });
                  }}
                  options={[
                    { value: '', label: byDefault },
                    ...(leaf.model !== null && !entry
                      ? [{ value: leaf.model, label: leaf.model }]
                      : []),
                    ...models.map((m) => ({ value: m.id, label: m.label })),
                  ]}
                />,
              )}
              {field(
                effortLabel,
                <Select
                  aria-label={effortLabel}
                  value={leaf.effort ?? ''}
                  onChange={(effort) => set({ effort: (effort as EffortLevel) || null })}
                  options={[
                    { value: '', label: byDefault },
                    ...[
                      ...(leaf.effort !== null && !efforts.includes(leaf.effort)
                        ? [leaf.effort]
                        : []),
                      ...efforts,
                    ].map((level) => ({ value: level, label: EFFORT_LABEL[level] })),
                  ]}
                />,
              )}
              {field(
                blockingLabel,
                <input
                  type="checkbox"
                  className="ps-sw"
                  aria-label={blockingLabel}
                  checked={leaf.blocking}
                  onChange={(e) => set({ blocking: e.target.checked })}
                />,
              )}
            </>
          )}
        </>
      );
    };
    return (
      <div className="wfl-rows">
        {kinds(
          [...STEP_KINDS, ...GROUP_KINDS].filter((kind) => fits(form.slot, kind, 'lead')),
          form.kind,
          (kind) => setForm((now) => withKind(now, kind)),
        )}
        {titleField(form.title, (title) => setForm({ title }))}
        {form.kind !== 'parallel' &&
          form.kind !== 'loop' &&
          leafFields({ ...form, kind: form.kind }, setForm)}
        {isGroup(form.kind) &&
          shownParts.map((part, i) => (
            <div key={i} className="wfl-part" role="group" aria-label={partLabel(i + 1)}>
              <div className="wfl-ph">
                {kinds(
                  STEP_KINDS.filter((kind) => fits(form.slot, kind, 'lead')),
                  part.kind,
                  (kind) => setPart(i, { kind }),
                )}
                {form.kind === 'parallel' && form.parts.length > 2 && (
                  <button
                    type="button"
                    className="ib"
                    aria-label={t(
                      {
                        id: 'insights.workflow.part.remove',
                        defaultMessage: 'Remove step {number} of the group',
                      },
                      { number: i + 1 },
                    )}
                    onClick={() =>
                      setForm((now) => ({ parts: now.parts.filter((_, j) => j !== i) }))
                    }
                  >
                    <X aria-hidden="true" />
                  </button>
                )}
              </div>
              {titleField(part.title, (title) => setPart(i, { title }))}
              {leafFields(part, (patch) => setPart(i, patch))}
            </div>
          ))}
        {form.kind === 'parallel' && form.parts.length < MAX_PARTS && (
          <button
            type="button"
            className="btn ghost wfl-padd"
            onClick={() => setForm((now) => ({ parts: [...now.parts, blankLeaf(now.slot)] }))}
          >
            <Plus className="ic-sm" aria-hidden="true" />
            {t({ id: 'insights.workflow.part.add', defaultMessage: 'Add a parallel step' })}
          </button>
        )}
        {form.kind === 'loop' &&
          row(
            maxLabel,
            stepper(maxLabel, form.max, [1, MAX_LOOP], false, (max) => setForm({ max })),
          )}
        {/* Before dispatch there is no diff; the field stays only to clear paths already set. */}
        {(form.slot !== 'before_dispatch' || form.paths !== '') &&
          field(
            pathsLabel,
            <textarea
              className="bd-fsel wfl-ta"
              aria-label={pathsLabel}
              aria-invalid={
                pathsOf(form).length > (form.slot === 'before_dispatch' ? 0 : MAX_PATHS) ||
                undefined
              }
              rows={2}
              spellCheck={false}
              value={form.paths}
              onChange={(e) => setForm({ paths: e.target.value })}
            />,
          )}
        {row(
          tiersLabel,
          chips(tiersLabel, TIERS, form.tiers, tierText, (tier) =>
            setForm({ tiers: toggled(TIERS, form.tiers, tier) }),
          ),
        )}
        {row(
          domainsLabel,
          chips(
            domainsLabel,
            DOMAINS,
            form.domains,
            (domain) => DOMAIN_LABEL[domain],
            (domain) => setForm({ domains: toggled(DOMAINS, form.domains, domain) }),
          ),
        )}
        <div className="wfl-acts">
          <button type="button" className="btn ghost" onClick={() => setSelected(null)}>
            {t({ id: 'insights.workflow.cancel', defaultMessage: 'Cancel' })}
          </button>
          <button type="button" className="btn pri" disabled={!ready} onClick={submit}>
            {form.id
              ? t({ id: 'insights.workflow.apply', defaultMessage: 'Apply' })
              : t({ id: 'insights.workflow.add', defaultMessage: 'Add' })}
          </button>
        </div>
      </div>
    );
  };

  let side: { title: string; icon: LucideIcon | null; body: ReactNode } | null = null;
  if (selected?.type === 'fixed')
    side = {
      title: fixedLabel(selected.id),
      icon: FIXED_ICON[selected.id] ?? Circle,
      body: fixedPanel(selected.id),
    };
  if (form)
    side = {
      title: form.id ? form.title || SLOT_LABEL[form.slot] : SLOT_LABEL[form.slot],
      icon: form.id ? KIND_ICON[form.kind] : Plus,
      body: formPanel(form),
    };
  const SideIcon = side?.icon;

  const items = chartItems(read.read.fixed_steps);
  const at = (id: string) => items.findIndex((item) => item.type === 'fixed' && item.id === id);
  // Each fixed step that sends a task back when it does not pass, drawn only where it points back up.
  const loops = [
    {
      from: 'plan_review',
      to: 'plan',
      side: 'end',
      text: t({ id: 'insights.workflow.loop.replan', defaultMessage: 'Not passed: plan again' }),
    },
    {
      from: 'gate',
      to: 'build',
      side: 'end',
      text: t(
        {
          id: 'insights.workflow.loop.handback',
          defaultMessage:
            '{count, plural, one {Failed: hand back at most # time} other {Failed: hand back at most # times}}',
        },
        { count: policyOf('handback').handback_limit as number },
      ),
    },
    {
      from: 'review',
      to: 'build',
      side: 'start',
      text: t(
        {
          id: 'insights.workflow.loop.review',
          defaultMessage:
            '{count, plural, one {Sent back: at most # round} other {Sent back: at most # rounds}}',
        },
        { count: definition.review.max_rounds },
      ),
    },
  ].filter(
    (loop) =>
      at(loop.to) >= 0 &&
      at(loop.to) < at(loop.from) &&
      // A hand-back limit of 0 sends nothing back.
      !(loop.from === 'gate' && policyOf('handback').handback_limit === 0),
  );

  // Step numbers count the fixed steps and the custom steps, in chart order.
  const order = items.flatMap((item) =>
    item.type === 'fixed' ? [item.id] : definition.slots[item.slot].map((step) => step.id),
  );
  const stepId = selected?.type === 'fixed' ? selected.id : form?.id;
  const number = stepId ? order.indexOf(stepId) + 1 : 0;
  const result =
    selected?.type === 'fixed'
      ? read.read.fixed_steps.find((s) => s.id === selected.id)?.result
      : form?.id
        ? read.read.step_results?.[form.id]
        : undefined;

  return (
    <section className="wfl" aria-label={heading}>
      <BarSlot bar={bar}>
        <WorkflowBar
          inUse={inUse}
          version={base.definition_version}
          dirty={dirty}
          busy={busy}
          stale={read.stale}
          trial={read.read.trial}
          trialTasks={trialTasks}
          onTrialTasks={setTrialTasks}
          onDiscard={discard}
          onSaveAs={() => setNaming((typed) => typed ?? '')}
          onSave={() => void save()}
        />
      </BarSlot>
      {failure && (
        <p className="bd-perr" role="alert">
          {failure}
        </p>
      )}
      <div
        className="wfl-defs"
        role="group"
        aria-label={t({ id: 'insights.workflow.workflows', defaultMessage: 'Project workflows' })}
      >
        {workflows.map((w) => (
          <button
            key={w.id}
            type="button"
            className="wfl-chip"
            aria-pressed={w.id === current?.id}
            // Picking another workflow would drop the unsaved changes.
            disabled={busy || dirty}
            onClick={() => pick(w.id)}
          >
            {w.name}
            {w.is_default && (
              <Star
                className="ic-sm wfl-def"
                role="img"
                aria-label={t({ id: 'insights.workflow.isDefault', defaultMessage: 'Default' })}
              />
            )}
          </button>
        ))}
        {current && !current.is_default && (
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={() => void makeDefault()}
          >
            {t({ id: 'insights.workflow.setDefault', defaultMessage: 'Set as default' })}
          </button>
        )}
        {naming !== null && (
          <span className="wfl-gadd">
            <input
              className="bd-fsel wfl-inp"
              aria-label={t({
                id: 'insights.workflow.saveAs.name',
                defaultMessage: 'New workflow name',
              })}
              maxLength={60}
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void saveAs();
                if (e.key === 'Escape') setNaming(null);
              }}
            />
            <button
              type="button"
              className="btn pri"
              disabled={!naming.trim() || busy || read.stale}
              aria-busy={busy || read.stale || undefined}
              onClick={() => void saveAs()}
            >
              {t({ id: 'insights.workflow.saveAs.save', defaultMessage: 'Save' })}
            </button>
            <button type="button" className="btn ghost" onClick={() => setNaming(null)}>
              {t({ id: 'insights.workflow.cancel', defaultMessage: 'Cancel' })}
            </button>
          </span>
        )}
      </div>
      <div className="wfl-body">
        <ModeList projectId={projectId} />
        <div className="wfl-main">
          <div className="wfl-scroll">
            <div className="wfl-graph">
              <ol
                className="wfl-chart"
                aria-label={t({ id: 'insights.workflow.chart', defaultMessage: 'Steps' })}
                style={{ gridRow: `1 / span ${items.length}` }}
              >
                {items.map((item) => (
                  <li key={item.type === 'fixed' ? item.id : item.slot} className="wfl-it">
                    {item.type === 'fixed' ? fixedNode(item.id) : slotNode(item.slot)}
                  </li>
                ))}
              </ol>
              {loops.map((loop) => (
                <span
                  key={loop.from}
                  className="wfl-loop"
                  data-side={loop.side}
                  role="img"
                  aria-label={t(
                    {
                      id: 'insights.workflow.loop',
                      defaultMessage: '{label}: from {from} back to {to}',
                    },
                    { label: loop.text, from: fixedLabel(loop.from), to: fixedLabel(loop.to) },
                  )}
                  style={{ gridRow: `${at(loop.to) + 1} / ${at(loop.from) + 1}` }}
                >
                  <i />
                  <span>{loop.text}</span>
                </span>
              ))}
            </div>
          </div>
          <div
            className="wfl-pal"
            role="toolbar"
            aria-label={t({ id: 'insights.workflow.palette', defaultMessage: 'Add a step' })}
          >
            {PALETTE.map((item) => {
              const Icon = item === 'skill' ? Zap : KIND_ICON[item];
              const label =
                item === 'skill'
                  ? t({ id: 'insights.workflow.skill', defaultMessage: 'Skill' })
                  : KIND_LABEL[item];
              const kind = paletteKind(item);
              return (
                <Menu.Root key={item}>
                  <Menu.Trigger
                    className="btn ghost"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(KIND_DRAG, item);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                  >
                    <Icon className="ic-sm" aria-hidden="true" />
                    {label}
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Positioner side="top" sideOffset={4} style={{ zIndex: 40 }}>
                      <Menu.Popup className="wmenu pop" aria-label={label}>
                        {SLOTS.filter((slot) => fits(slot, kind, 'lead')).map((slot) => (
                          <Menu.Item
                            key={slot}
                            onClick={() =>
                              setSelected({ type: 'form', form: withKind(blankForm(slot), kind) })
                            }
                          >
                            {SLOT_LABEL[slot]}
                          </Menu.Item>
                        ))}
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
              );
            })}
          </div>
        </div>
        {side && (
          <aside className="wfl-side" aria-label={side.title}>
            <div className="wfl-sh">
              {SideIcon && <SideIcon aria-hidden="true" />}
              <h3>{side.title}</h3>
              {number > 0 && (
                <span className="wfl-sn">
                  {t(
                    { id: 'insights.workflow.stepNumber', defaultMessage: 'Step {number}' },
                    { number },
                  )}
                </span>
              )}
              <button
                type="button"
                className="ib"
                aria-label={t({ id: 'insights.workflow.close', defaultMessage: 'Close' })}
                onClick={() => setSelected(null)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            {side.body}
            {result && stepResults(result)}
          </aside>
        )}
      </div>
      {runs.length > 0 && (
        <table
          className="wfl-tbl"
          aria-label={t({ id: 'insights.workflow.runs', defaultMessage: 'Step runs' })}
        >
          <thead>
            <tr>
              <th scope="col">
                {t({ id: 'insights.workflow.runs.task', defaultMessage: 'Task' })}
              </th>
              <th scope="col">
                {t({ id: 'insights.workflow.runs.step', defaultMessage: 'Step' })}
              </th>
              <th scope="col">
                {t({ id: 'insights.workflow.runs.state', defaultMessage: 'State' })}
              </th>
              <th scope="col">
                {t({ id: 'insights.workflow.runs.reason', defaultMessage: 'Reason' })}
              </th>
              <th scope="col" className="wfl-n">
                {t({ id: 'insights.workflow.runs.age', defaultMessage: 'For' })}
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map(({ run, task, state, session }) => (
              <tr
                key={run.id}
                data-run={run.id}
                data-state={run.state}
                onClick={session ? () => onOpenSession(session) : undefined}
              >
                <td>
                  {session ? (
                    <button
                      type="button"
                      className="wfl-open"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenSession(session);
                      }}
                    >
                      {task}
                    </button>
                  ) : (
                    task
                  )}
                </td>
                <td>{run.title}</td>
                <td>{state}</td>
                <td>{run.reason}</td>
                <td className="wfl-n">{durationText(model.now - run.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
