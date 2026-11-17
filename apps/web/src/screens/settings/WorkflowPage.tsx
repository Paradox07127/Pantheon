import { Fragment, useRef, useState, type ReactNode } from 'react';
import { LoadError } from '../../components/LoadError';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Pin } from 'lucide-react';
import type { Improvement } from '@pantheon/domain';
import type { BoardSnapshot } from '@pantheon/protocol';
import { runtimeName } from '../../components/RuntimeGlyph';
import { useCurrentProject } from '../../data/current-project';
import {
  clearGlobal,
  clearOverride,
  globalPolicy,
  patchedPolicy,
  setGlobal,
  settingOf,
  useProjectDefaults,
  type PolicySettings,
  type SettingOverview,
} from '../../data/project-defaults';
import { useRuntimeStatus } from '../../data/runtime-status';
import {
  changedParams,
  countRange,
  isPolicy,
  PARAM_LABEL,
  CHOSEN_PATHS,
  PATH_LABEL,
  IMPROVEMENT_MODE_LABEL,
  PLAN_CHANGES_LABEL,
  setPolicy,
  STATUS_LABEL,
  tierText,
  togglePin,
  useImprovements,
  useWorkflowPolicy,
  WAKE_LABEL,
  type CountParam,
  type PolicyPatch,
  type WorkflowParam,
  type WorkflowPolicy,
} from '../../data/workflow-policy';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { useShell } from '../../store';
import { Overrides } from './Overrides';
import { policyStepper, runtimeLimits } from './PolicyStepper';
import { failureText, Loading, Row, Section, type Failure } from './ProjectSettingsScreen';
import { AutoMergeSwitch } from './WorktreesPage';
import { useSettingsView } from './view';
import './workflow-page.css';

type Project = BoardSnapshot['projects'][number];
type RowKey = keyof typeof PARAM_LABEL;

const TIERS = ['t1', 't2', 't3'] as const;
const WAYS = ['direct', 'dispatch', 'review_loop'] as const;
const FIELDS = ['input_tokens', 'wall_ms'] as const;
type Field = (typeof FIELDS)[number];

const FIELD_LABEL: Record<Field, string> = {
  get input_tokens() {
    return t({ id: 'settings.workflow.budgetTokens', defaultMessage: 'Input tokens' });
  },
  get wall_ms() {
    return t({ id: 'settings.workflow.budgetMinutes', defaultMessage: 'Minutes' });
  },
};

const ON_FAIL_LABEL: Record<NonNullable<WorkflowPolicy['gate_on_fail']>, string> = {
  get handback() {
    return t({ id: 'settings.gate.onFail.handback', defaultMessage: 'Hand back to fix' });
  },
  get retry() {
    return t({ id: 'settings.gate.onFail.retry', defaultMessage: 'Rerun once first' });
  },
  get stop() {
    return t({ id: 'settings.gate.onFail.stop', defaultMessage: 'Stop for me' });
  },
};

const minutesText = (ms: number) => String(Math.round(ms / 600) / 100);

const positive = (param: string) =>
  t(
    { id: 'settings.workflow.positive', defaultMessage: '{param} must be a positive whole number' },
    { param },
  );

export const onOff = (on: boolean) =>
  on
    ? t({ id: 'settings.workflow.on', defaultMessage: 'On' })
    : t({ id: 'settings.workflow.off', defaultMessage: 'Off' });

/** A parameter's value as a project sets it, in a few words. */
function paramText(key: RowKey, value: unknown): string {
  if (typeof value === 'boolean') return onOff(value);
  const record = (value ?? {}) as Record<string, unknown>;
  if (key === 'path')
    return listText(
      ...TIERS.map((tier) => {
        const way = record[tier] as (typeof WAYS)[number] | undefined;
        return way && `${tierText(tier)} ${PATH_LABEL[way]}`;
      }),
    );
  if (key === 'runtime_parallel')
    return listText(...Object.entries(record).map(([r, n]) => `${runtimeName(r)} ${String(n)}`));
  if (key === 'budget')
    return listText(
      ...TIERS.flatMap((tier) =>
        Object.keys(record[tier] ?? {}).map(
          (way) => `${tierText(tier)} ${PATH_LABEL[way as (typeof WAYS)[number]]}`,
        ),
      ),
    );
  if (key === 'acceptance_wake') return WAKE_LABEL[value as WorkflowPolicy['acceptance_wake']];
  if (key === 'improvement_mode')
    return IMPROVEMENT_MODE_LABEL[value as WorkflowPolicy['improvement_mode']];
  if (key === 'plan_changes') return PLAN_CHANGES_LABEL[value as WorkflowPolicy['plan_changes']];
  if (key === 'gate_on_fail')
    return ON_FAIL_LABEL[value as NonNullable<WorkflowPolicy['gate_on_fail']>];
  return String(value);
}

function openLearned(projectId: string) {
  useSettingsView.getState().close();
  useCurrentProject.getState().choose(projectId);
  const shell = useShell.getState();
  shell.setMemoryTab('learned');
  shell.setScreen('memory');
}

/** The chip beside a parameter's name that an improvement on trial or in effect changed. */
export const improvementChip = (status: Improvement['status'], projectId: string) => (
  <button
    type="button"
    className="chip wf-imp"
    data-s={status}
    onClick={() => openLearned(projectId)}
  >
    {t(
      { id: 'settings.workflow.improvement', defaultMessage: 'Improvement {status}' },
      { status: STATUS_LABEL[status] },
    )}
  </button>
);

/** A parameter's pin, which keeps improvements from changing it. */
export const pinButton = (props: {
  param: string;
  pinned: boolean;
  disabled: boolean;
  onPin: () => void;
}) => (
  <button
    type="button"
    className="ib wf-pin"
    aria-pressed={props.pinned}
    aria-label={t(
      { id: 'settings.workflow.pin', defaultMessage: 'Pin {param}' },
      { param: props.param },
    )}
    disabled={props.disabled}
    onClick={props.disabled ? undefined : props.onPin}
  >
    <Pin aria-hidden="true" />
  </button>
);

/** The workflow settings every project follows, or with a project its own, each parameter changed with workflow.policy.set; `only` shows one parameter's row. */
export function WorkflowPage({ project, only }: { project: Project | null; only?: RowKey }) {
  const read = useWorkflowPolicy(project?.id ?? null);
  const defaults = useProjectDefaults();
  const improvements = useImprovements(project?.id ?? null);
  const runtimeStatus = useRuntimeStatus().read;
  const setting = settingOf(defaults.data, 'workflow_policy');
  const autoMerge = settingOf(defaults.data, 'auto_merge');
  const global = project === null;
  const source = global
    ? { error: defaults.error, stale: defaults.stale === true, reload: defaults.reload }
    : read;
  // The policy a command returned, shown until a read reaches its version.
  const [saved, setSaved] = useState<WorkflowPolicy | null>(null);
  const [pending, setPending] = useState<RowKey | null>(null);
  const [failure, setFailure] = useState<{ row: RowKey; text: string } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  /** Task budget cells as typed, by tier:way:field, minutes for wall_ms. */
  const [cells, setCells] = useState<Record<string, string>>({});
  /** Stepper inputs as typed, by count parameter or runtime. */
  const [drafts, setDrafts] = useState<Record<string, string | undefined>>({});
  const sending = useRef(false);

  const policy = global
    ? setting?.builtin
      ? globalPolicy(setting)
      : null
    : saved && (!read.read || read.read.policy_version < saved.policy_version)
      ? saved
      : read.read;

  const title = t({ id: 'settings.workflow.title', defaultMessage: 'Workflow settings' });
  if (!policy)
    return (
      <Section title={title}>
        {source.error ? <LoadError message={source.error} onRetry={source.reload} /> : <Loading />}
      </Section>
    );

  const send = async (row: RowKey, patch: PolicyPatch) => {
    if (sending.current || source.stale) return false;
    sending.current = true;
    setPending(row);
    setFailure(null);
    if (global) {
      const result = await setGlobal(
        'workflow_policy',
        patchedPolicy(setting?.global, policy, patch),
      );
      sending.current = false;
      setPending(null);
      if (!result.ok) setFailure({ row, text: failureText(result.error) });
      return result.ok;
    }
    const result = await setPolicy(policy, patch);
    sending.current = false;
    setPending(null);
    if (!result.ok) {
      setFailure({ row, text: result.error });
      return false;
    }
    if (isPolicy(result.value)) setSaved(result.value);
    read.reload();
    return true;
  };
  const busy = pending !== null || source.stale;
  const changed = changedParams(improvements.read ?? []);

  const draftOf = (key: string) => ({
    draft: drafts[key] ?? null,
    onDraft: (draft: string | null) =>
      setDrafts((typed) => ({ ...typed, [key]: draft ?? undefined })),
  });

  const stepper = (param: CountParam) => {
    const [low, high] = countRange(policy, param);
    return policyStepper({
      label: PARAM_LABEL[param],
      value: policy[param],
      low,
      high,
      disabled: busy,
      ...draftOf(param),
      onSet: (to) => send(param, { [param]: to }),
      onInvalid: (text) => setFailure({ row: param, text }),
    });
  };

  const commitHint = async () => {
    if (hint === null) return;
    const typed = hint.trim();
    const to = typed === '' ? null : Number(typed);
    if (to !== null && !(Number.isInteger(to) && to > 0)) {
      setFailure({ row: 'task_size_hint', text: positive(PARAM_LABEL.task_size_hint) });
      return;
    }
    if (
      to === (policy.task_size_hint ?? null) ||
      (await send('task_size_hint', { task_size_hint: to }))
    )
      setHint(null);
  };

  const cellKey = (tier: string, way: string, field: Field) => `${tier}:${way}:${field}`;
  const cellText = (tier: (typeof TIERS)[number], way: (typeof WAYS)[number], field: Field) => {
    const current = policy.budget[tier]?.[way];
    return (
      cells[cellKey(tier, way, field)] ??
      (current
        ? field === 'wall_ms'
          ? minutesText(current.wall_ms)
          : String(current.input_tokens)
        : '')
    );
  };

  // A cell with one field empty waits for the other; untyped fields keep their stored value.
  const commitCells = async () => {
    const patch: NonNullable<PolicyPatch['budget']> = {};
    const done: string[] = [];
    for (const tier of TIERS)
      for (const way of WAYS) {
        const [tokens, minutes] = FIELDS.map((f) => cells[cellKey(tier, way, f)]?.trim());
        if (tokens === undefined && minutes === undefined) continue;
        const current = policy.budget[tier]?.[way];
        const input_tokens =
          tokens === undefined ? (current?.input_tokens ?? null) : tokens ? Number(tokens) : null;
        const wall_ms =
          minutes === undefined
            ? (current?.wall_ms ?? null)
            : minutes
              ? Math.round(Number(minutes) * 60_000)
              : null;
        if ((input_tokens === null) !== (wall_ms === null)) continue;
        let to: { input_tokens: number; wall_ms: number } | null = null;
        if (input_tokens !== null && wall_ms !== null) {
          to = { input_tokens, wall_ms };
          if (![to.input_tokens, to.wall_ms].every((v) => Number.isInteger(v) && v > 0)) {
            setFailure({
              row: 'budget',
              text: t(
                {
                  id: 'settings.workflow.budgetPositive',
                  defaultMessage: '{param} must be positive',
                },
                { param: PARAM_LABEL.budget },
              ),
            });
            return;
          }
        }
        done.push(...FIELDS.map((f) => cellKey(tier, way, f)));
        const same = to
          ? to.input_tokens === current?.input_tokens && to.wall_ms === current.wall_ms
          : !current;
        if (!same) (patch[tier] ??= {})[way] = to;
      }
    if (done.length === 0) return;
    if (Object.keys(patch).length === 0 || (await send('budget', { budget: patch })))
      setCells((typed) =>
        Object.fromEntries(Object.entries(typed).filter(([k]) => !done.includes(k))),
      );
  };

  /** The projects with their own value of the parameter, on the page every project follows. */
  const overrides = (key: RowKey) =>
    global && (
      <Overrides
        name={PARAM_LABEL[key]}
        setting="workflow_policy"
        sets={(value) => (value as Record<string, unknown>)[key] !== undefined}
        valueText={(value) => paramText(key, (value as Record<string, unknown>)[key])}
        clear={(p) => clearOverride(p, 'workflow_policy', key as keyof PolicySettings)}
        clearGlobal={
          setting?.global && key in setting.global
            ? () => {
                const { [key as keyof PolicySettings]: _, ...rest } = setting.global!;
                return setGlobal('workflow_policy', rest);
              }
            : undefined
        }
        editor={(p) => <WorkflowPage project={p} only={key} />}
      />
    );

  /** A parameter's row: name, control and pin, then `wide` across the whole row. */
  const row = (key: RowKey, control: ReactNode, pin?: WorkflowParam, wide?: ReactNode) => {
    const by = pin && changed.get(pin);
    const pinned = !!pin && policy.pinned.includes(pin);
    const pinCell = pin ? (
      pinButton({
        param: PARAM_LABEL[key],
        pinned,
        disabled: busy,
        onPin: () => void send(key, { pinned: togglePin(policy, pin) }),
      })
    ) : (
      <span />
    );
    return (
      <div
        key={key}
        role="group"
        aria-label={PARAM_LABEL[key]}
        aria-busy={pending === key || undefined}
        className="ps-row wf-pr"
        data-setting-id={`workflow.${key.replace(/_(.)/g, (_, c: string) => c.toUpperCase())}`}
      >
        <span className="wf-nm">
          <span>{PARAM_LABEL[key]}</span>
          {by && project && improvementChip(by.status, project.id)}
        </span>
        {control}
        {global ? (
          <span className="wf-end">
            {overrides(key)}
            {pinCell}
          </span>
        ) : (
          pinCell
        )}
        {wide}
        {failure?.row === key && (
          <div className="ps-err wf-err" role="alert">
            {failure.text}
          </div>
        )}
      </div>
    );
  };

  const choice = <T extends string>(
    key: RowKey,
    label: string,
    value: T | undefined,
    labels: Record<T, string>,
    patch: (value: T) => PolicyPatch,
  ) => (
    <RadioGroup<T | null>
      key={label}
      className="seg"
      aria-label={label}
      value={value ?? null}
      disabled={busy}
      onValueChange={(next) => {
        if (next) void send(key, patch(next));
      }}
    >
      {(Object.keys(labels) as T[]).map((v) => (
        <Radio.Root key={v} value={v}>
          {labels[v]}
        </Radio.Root>
      ))}
    </RadioGroup>
  );

  const budgetTable = (
    <div className="wf-bud">
      <span />
      {WAYS.map((way) => (
        <span key={way} className="cap wf-bud-p">
          {PATH_LABEL[way]}
        </span>
      ))}
      <span />
      {WAYS.map((way) =>
        FIELDS.map((field) => (
          <span key={`${way}:${field}`} className="wf-sub">
            {FIELD_LABEL[field]}
          </span>
        )),
      )}
      {TIERS.map((tier) => (
        <Fragment key={tier}>
          <span className="mono wf-sub">{tierText(tier)}</span>
          {WAYS.map((way) =>
            FIELDS.map((field) => (
              <input
                key={cellKey(tier, way, field)}
                className="inp mono"
                inputMode={field === 'wall_ms' ? 'decimal' : 'numeric'}
                aria-label={t(
                  {
                    id: 'settings.workflow.budgetCell',
                    defaultMessage: '{tier} {path} {field}',
                  },
                  {
                    tier: tierText(tier),
                    path: PATH_LABEL[way],
                    field: FIELD_LABEL[field],
                  },
                )}
                placeholder={t({ id: 'settings.common.noLimit', defaultMessage: 'No limit' })}
                disabled={busy}
                value={cellText(tier, way, field)}
                onChange={(e) =>
                  setCells((typed) => ({
                    ...typed,
                    [cellKey(tier, way, field)]: e.target.value,
                  }))
                }
                onBlur={() => void commitCells()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitCells();
                }}
              />
            )),
          )}
        </Fragment>
      ))}
    </div>
  );

  const rows = {
    max_parallel: row('max_parallel', stepper('max_parallel'), 'max_parallel'),
    max_parallel_limit: row('max_parallel_limit', stepper('max_parallel_limit')),
    runtime_parallel: row(
      'runtime_parallel',
      runtimeLimits({
        limits: policy.runtime_parallel,
        status: runtimeStatus,
        disabled: busy,
        draftOf: (runtime) => draftOf(`runtime:${runtime}`),
        onSet: (runtime_parallel) => send('runtime_parallel', { runtime_parallel }),
        onInvalid: (text) => setFailure({ row: 'runtime_parallel', text }),
      }),
    ),
    dispatch_paused: row(
      'dispatch_paused',
      <input
        type="checkbox"
        className="ps-sw"
        aria-label={PARAM_LABEL.dispatch_paused}
        checked={!!policy.dispatch_paused}
        disabled={busy}
        onChange={(e) => void send('dispatch_paused', { dispatch_paused: e.target.checked })}
      />,
    ),
    path: row(
      'path',
      <span className="wf-tiers">
        {TIERS.map((tier) => (
          <span key={tier} className="wf-tier">
            <span className="mono wf-sub">{tierText(tier)}</span>
            {choice(
              'path',
              `${PARAM_LABEL.path} ${tierText(tier)}`,
              policy.path[tier],
              Object.fromEntries(CHOSEN_PATHS.map((way) => [way, PATH_LABEL[way]])) as Record<
                (typeof CHOSEN_PATHS)[number],
                string
              >,
              (way) => ({ path: { [tier]: way } }),
            )}
          </span>
        ))}
      </span>,
      'path',
    ),
    task_size_hint: row(
      'task_size_hint',
      <input
        className="inp mono wf-num"
        inputMode="numeric"
        aria-label={PARAM_LABEL.task_size_hint}
        placeholder={t({ id: 'settings.common.noLimit', defaultMessage: 'No limit' })}
        disabled={busy}
        value={hint ?? policy.task_size_hint?.toString() ?? ''}
        onChange={(e) => setHint(e.target.value)}
        onBlur={() => void commitHint()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitHint();
        }}
      />,
      'task_size_hint',
    ),
    budget: row('budget', <span />, 'budget', budgetTable),
    gate_on_fail: row(
      'gate_on_fail',
      choice(
        'gate_on_fail',
        PARAM_LABEL.gate_on_fail,
        policy.gate_on_fail ?? 'handback',
        ON_FAIL_LABEL,
        (gate_on_fail) => ({ gate_on_fail }),
      ),
    ),
    handback_limit: row('handback_limit', stepper('handback_limit'), 'handback_limit'),
    acceptance_wake: row(
      'acceptance_wake',
      choice(
        'acceptance_wake',
        PARAM_LABEL.acceptance_wake,
        policy.acceptance_wake,
        WAKE_LABEL,
        (acceptance_wake) => ({ acceptance_wake }),
      ),
      'acceptance_wake',
    ),
    improvement_mode: row(
      'improvement_mode',
      choice(
        'improvement_mode',
        PARAM_LABEL.improvement_mode,
        policy.improvement_mode,
        IMPROVEMENT_MODE_LABEL,
        (improvement_mode) => ({
          improvement_mode,
        }),
      ),
    ),
    plan_changes: row(
      'plan_changes',
      choice(
        'plan_changes',
        PARAM_LABEL.plan_changes,
        policy.plan_changes,
        PLAN_CHANGES_LABEL,
        (plan_changes) => ({ plan_changes }),
      ),
    ),
  } satisfies Partial<Record<RowKey, ReactNode>>;
  if (only) return <div className="ps-rows">{rows[only as keyof typeof rows]}</div>;

  return (
    <>
      {source.error && (
        <LoadError message={source.error} onRetry={source.stale ? source.reload : undefined} />
      )}
      <Section title={t({ id: 'settings.workflow.dispatch', defaultMessage: 'Dispatch' })}>
        <div className="ps-rows">
          {rows.max_parallel}
          {rows.max_parallel_limit}
          {rows.runtime_parallel}
          {rows.dispatch_paused}
        </div>
      </Section>
      <Section title={t({ id: 'settings.workflow.tasks', defaultMessage: 'Tasks' })}>
        <div className="ps-rows">
          {rows.path}
          {rows.task_size_hint}
          {rows.budget}
        </div>
      </Section>
      <Section title={t({ id: 'settings.workflow.acceptance', defaultMessage: 'Acceptance' })}>
        <div className="ps-rows">{rows.acceptance_wake}</div>
      </Section>
      {global && (
        <Section title={t({ id: 'settings.pages.gates', defaultMessage: 'Gates' })}>
          <div className="ps-rows">
            {rows.gate_on_fail}
            {rows.handback_limit}
          </div>
        </Section>
      )}
      {global && autoMerge && <GlobalAutoMerge setting={autoMerge} />}
      <div className="ps-grp">
        <div className="ps-rows">
          {rows.plan_changes}
          {rows.improvement_mode}
        </div>
      </div>
    </>
  );
}

/** Whether every project without its own choice merges once its gates pass. */
function GlobalAutoMerge({ setting }: { setting: SettingOverview<'auto_merge'> }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const label = t({
    id: 'settings.autoMerge.toggle',
    defaultMessage: 'Merge automatically once gates pass',
  });
  const save = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await setGlobal('auto_merge', enabled);
    setBusy(false);
    if (!result.ok) setFailure(result.error);
  };
  return (
    <Section title={t({ id: 'settings.worktrees.merging', defaultMessage: 'Merging' })}>
      <div className="ps-rows">
        <Row label={label} settingId="workflow.autoMerge">
          <input
            type="checkbox"
            className="ps-sw"
            aria-label={label}
            checked={setting.global ?? setting.builtin ?? false}
            disabled={busy}
            onChange={(e) => void save(e.target.checked)}
          />
          <Overrides
            name={label}
            setting="auto_merge"
            valueText={onOff}
            clearGlobal={setting.global !== undefined ? () => clearGlobal('auto_merge') : undefined}
            editor={(p) => <AutoMergeSwitch project={p} />}
          />
        </Row>
        {failure && (
          <div className="ps-err" role="alert">
            {failureText(failure)}
          </div>
        )}
      </div>
    </Section>
  );
}
