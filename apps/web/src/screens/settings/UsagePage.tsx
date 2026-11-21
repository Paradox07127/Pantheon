import { useEffect, useState, type ReactNode } from 'react';
import { LoadError } from '../../components/LoadError';
import { Pin } from 'lucide-react';
import { create } from 'zustand';
import type { BoardSnapshot, BridgeResult } from '@pantheon/protocol';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { runCommand } from '../../data/commands';
import {
  globalPolicy,
  patchedPolicy,
  setGlobal,
  settingOf,
  useProjectDefaults,
} from '../../data/project-defaults';
import {
  DEFAULT_QUOTA_THRESHOLD,
  isPolicy,
  PARAM_LABEL,
  setPolicy,
  togglePin,
  useWorkflowPolicy,
  type PolicyPatch,
  type WorkflowPolicy,
} from '../../data/workflow-policy';
import { sendProjectCommand } from '../../data/project-read';
import { t } from '../../i18n';
import { parseUsageTarget, RING_RUNTIMES, type UsageTargets } from '../../lib/usage-quota';
import { Overrides } from './Overrides';
import { failureText, Loading, Section } from './ProjectSettingsScreen';
import './usage-page.css';

type Project = BoardSnapshot['projects'][number];
type UsageRow = 'project_budget' | 'runtime_quota_threshold' | `target:${string}`;
type SavedTargets = { project_id: string; revision: number; targets: UsageTargets };

const useUsageSave = create<{
  /** The policy a command returned, shown until a read reaches its version. */
  saved: WorkflowPolicy | null;
  /** The token targets a save left, shown until the board's project reaches its revision. */
  savedTargets: SavedTargets | null;
  pending: UsageRow | null;
  failure: { project_id: string; row: UsageRow; text: string } | null;
  /** Counts the saves that went through, so the page reads the policy again after each. */
  saves: number;
}>(() => ({
  saved: null,
  savedTargets: null,
  pending: null,
  failure: null,
  saves: 0,
}));

/** The project's token targets and its revision, counting a save the board has not shown yet. */
function projectTargets(project: Project, saved: SavedTargets | null) {
  return saved?.project_id === project.id && project.revision < saved.revision
    ? saved
    : { project_id: project.id, revision: project.revision, targets: project.usage_targets ?? {} };
}

async function saveTargets(
  project: Project,
  row: UsageRow,
  targets: Record<string, number | null>,
) {
  if (useUsageSave.getState().pending) return false;
  const from = projectTargets(project, useUsageSave.getState().savedTargets);
  useUsageSave.setState({ pending: row, failure: null });
  const result = await sendProjectCommand(
    'project.usageTargets.set',
    { project_id: project.id, targets },
    from.revision,
  );
  const next = { ...from.targets };
  for (const [runtime, target] of Object.entries(targets))
    if (target === null) delete next[runtime];
    else next[runtime] = target;
  useUsageSave.setState(
    result.ok
      ? {
          pending: null,
          savedTargets: { project_id: project.id, revision: from.revision + 1, targets: next },
        }
      : { pending: null, failure: { project_id: project.id, row, text: result.error } },
  );
  return result.ok;
}

async function savePolicy(policy: WorkflowPolicy, row: UsageRow, patch: PolicyPatch) {
  if (useUsageSave.getState().pending) return false;
  useUsageSave.setState({ pending: row, failure: null });
  const result = await setPolicy(policy, patch);
  const s = useUsageSave.getState();
  useUsageSave.setState(
    result.ok
      ? {
          pending: null,
          saved: isPolicy(result.value) ? result.value : s.saved,
          saves: s.saves + 1,
        }
      : { pending: null, failure: { project_id: policy.project_id, row, text: result.error } },
  );
  return result.ok;
}

/** A save of a value every project follows; its failure is kept under no project. */
async function saveGlobal(row: UsageRow, command: () => Promise<BridgeResult<unknown>>) {
  if (useUsageSave.getState().pending) return false;
  useUsageSave.setState({ pending: row, failure: null });
  const result = await command();
  useUsageSave.setState(
    result.ok
      ? { pending: null }
      : { pending: null, failure: { project_id: '', row, text: failureText(result.error) } },
  );
  return result.ok;
}

/** The token targets and quota threshold every project follows, or with a project its own and its budget; `only` shows one row. */
export function UsagePage({ project, only }: { project: Project | null; only?: UsageRow }) {
  const read = useWorkflowPolicy(project?.id ?? null);
  const defaults = useProjectDefaults();
  const savedPolicy = useUsageSave((s) => s.saved);
  const pending = useUsageSave((s) => s.pending);
  const savedFailure = useUsageSave((s) => s.failure);
  const saves = useUsageSave((s) => s.saves);
  const savedTargets = useUsageSave((s) => s.savedTargets);
  const policySetting = settingOf(defaults.data, 'workflow_policy');
  const globalTargets = settingOf(defaults.data, 'usage_targets')?.global ?? {};
  const stored = project ? projectTargets(project, savedTargets).targets : globalTargets;
  /** Token targets as typed, by runtime. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [budget, setBudget] = useState<string | null>(null);
  const [quota, setQuota] = useState<string | null>(null);

  const saved = project && savedPolicy?.project_id === project.id ? savedPolicy : null;
  const policy = !project
    ? policySetting?.builtin
      ? globalPolicy(policySetting)
      : null
    : saved && (!read.read || read.read.policy_version < saved.policy_version)
      ? saved
      : read.read;
  const source = project ? read : { error: defaults.error, stale: false, reload: defaults.reload };
  const failure = savedFailure?.project_id === (project?.id ?? '') ? savedFailure : null;
  const busy = pending !== null;

  useEffect(() => {
    if (saves > 0) read.reload();
  }, [saves]);

  const error = (row: UsageRow) =>
    failure?.row === row && (
      <div className="ps-err us-err" role="alert">
        {failure.text}
      </div>
    );

  const commitTarget = async (runtime: string) => {
    const text = typed[runtime];
    if (text === undefined) return;
    const to = parseUsageTarget(text);
    if (to === undefined) return;
    if (
      to === (stored[runtime] ?? null) ||
      (await (project
        ? saveTargets(project, `target:${runtime}`, { [runtime]: to })
        : saveGlobal(`target:${runtime}`, () =>
            setGlobal('usage_targets', withTarget(runtime, to)),
          )))
    )
      setTyped(({ [runtime]: _, ...rest }) => rest);
  };
  const withTarget = (runtime: string, to: number | null) => {
    const { [runtime]: _, ...rest } = globalTargets;
    return to === null ? rest : { ...rest, [runtime]: to };
  };

  const tokens = t({ id: 'settings.usage.tokens', defaultMessage: 'tokens' });
  const targetRow = (runtime: string) => {
    const name = runtimeName(runtime);
    const target = stored[runtime];
    const text = typed[runtime] ?? (target == null ? '' : String(target));
    const inherited = project ? globalTargets[runtime] : undefined;
    return (
      <div
        key={runtime}
        role="group"
        aria-label={name}
        aria-busy={pending === `target:${runtime}` || undefined}
        className="ps-row us-pr"
      >
        <span className="us-rt">
          <RuntimeGlyph runtime={runtime} />
          <span className="us-nm">{name}</span>
        </span>
        <span className="us-ct">
          <input
            className="inp mono us-num us-tok"
            inputMode="numeric"
            aria-label={t(
              { id: 'settings.usage.targetField', defaultMessage: '{runtime} token target' },
              { runtime: name },
            )}
            placeholder={
              inherited === undefined
                ? t({ id: 'settings.usage.noTarget', defaultMessage: 'Not set' })
                : String(inherited)
            }
            disabled={busy}
            value={text}
            aria-invalid={parseUsageTarget(text) === undefined || undefined}
            onChange={(e) => setTyped((all) => ({ ...all, [runtime]: e.target.value }))}
            onBlur={() => void commitTarget(runtime)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitTarget(runtime);
            }}
          />
          <span className="mu us-unit">{tokens}</span>
        </span>
        {project ? (
          <span />
        ) : (
          <Overrides
            name={t(
              { id: 'settings.usage.targetField', defaultMessage: '{runtime} token target' },
              { runtime: name },
            )}
            setting="usage_targets"
            sets={(value) => value[runtime] !== undefined}
            valueText={(value) => String(value[runtime])}
            clear={(p) =>
              runCommand(
                'project.usageTargets.set',
                { project_id: p.id, targets: { [runtime]: null } },
                p.revision,
              )
            }
            clearGlobal={
              globalTargets[runtime] === undefined
                ? undefined
                : () => setGlobal('usage_targets', withTarget(runtime, null))
            }
            editor={(p) => <UsagePage project={p} only={`target:${runtime}`} />}
          />
        )}
        {error(`target:${runtime}`)}
      </div>
    );
  };
  if (only?.startsWith('target:'))
    return <div className="ps-rows">{targetRow(only.slice('target:'.length))}</div>;

  const targets = (
    <Section
      title={t({ id: 'settings.usage.targets', defaultMessage: 'Token targets' })}
      settingId="usage.targets"
    >
      <div className="ps-rows">{RING_RUNTIMES.map(targetRow)}</div>
    </Section>
  );
  const budgetTitle = t({
    id: 'settings.usage.budgetAndQuota',
    defaultMessage: 'Budget and quota',
  });

  if (!policy)
    return (
      <>
        {only === undefined && targets}
        <Section title={budgetTitle}>
          {source.error ? (
            <LoadError message={source.error} onRetry={source.reload} />
          ) : (
            <Loading />
          )}
        </Section>
      </>
    );

  const fail = (row: UsageRow, text: string) =>
    useUsageSave.setState({ failure: { project_id: project?.id ?? '', row, text } });
  const save = (row: UsageRow, patch: PolicyPatch) =>
    project
      ? savePolicy(policy, row, patch)
      : saveGlobal(row, () =>
          setGlobal('workflow_policy', patchedPolicy(policySetting?.global, policy, patch)),
        );

  const commitBudget = async () => {
    if (budget === null || source.stale) return;
    const typed = budget.trim();
    const to = typed === '' ? null : Number(typed);
    if (to !== null && !(Number.isInteger(to) && to > 0)) {
      fail(
        'project_budget',
        t(
          {
            id: 'settings.usage.positive',
            defaultMessage: '{param} must be a positive whole number',
          },
          { param: PARAM_LABEL.project_budget },
        ),
      );
      return;
    }
    if (
      to === (policy.project_budget?.input_tokens ?? null) ||
      (await save('project_budget', {
        project_budget: to === null ? null : { input_tokens: to },
      }))
    )
      setBudget(null);
  };

  const commitQuota = async () => {
    if (quota === null || source.stale) return;
    const typed = quota.trim();
    const to = Number(typed);
    if (typed === '' || !Number.isFinite(to) || to < 0 || to > 100) {
      fail(
        'runtime_quota_threshold',
        t(
          { id: 'settings.usage.percent', defaultMessage: '{param} must be from 0 to 100' },
          { param: PARAM_LABEL.runtime_quota_threshold },
        ),
      );
      return;
    }
    if (
      to === (policy.runtime_quota_threshold ?? DEFAULT_QUOTA_THRESHOLD) ||
      (await save('runtime_quota_threshold', { runtime_quota_threshold: to }))
    )
      setQuota(null);
  };

  /** A setting's row: name, the control with its unit, the pin or an empty cell. */
  const row = (key: UsageRow, name: string, control: ReactNode, unit: string, pin?: ReactNode) => (
    <div
      role="group"
      aria-label={name}
      aria-busy={pending === key || undefined}
      className="ps-row us-pr"
      data-setting-id={key === 'project_budget' ? 'project.budget' : 'usage.runtimeQuotaThreshold'}
    >
      <span className="us-nm">{name}</span>
      <span className="us-ct">
        {control}
        <span className="mu us-unit">{unit}</span>
      </span>
      {pin ?? <span />}
      {error(key)}
    </div>
  );

  const quotaName = t({
    id: 'settings.usage.quotaThreshold',
    defaultMessage: 'Runtime quota threshold',
  });
  const pinned = policy.pinned.includes('runtime_quota_threshold');
  const pin = (
    <button
      type="button"
      className="ib us-pin"
      aria-pressed={pinned}
      aria-label={t(
        { id: 'settings.usage.pin', defaultMessage: 'Pin {param}' },
        { param: quotaName },
      )}
      disabled={busy}
      onClick={
        busy || source.stale
          ? undefined
          : () =>
              void save('runtime_quota_threshold', {
                pinned: togglePin(policy, 'runtime_quota_threshold'),
              })
      }
    >
      <Pin aria-hidden="true" />
    </button>
  );
  const budgetRow = row(
    'project_budget',
    t({ id: 'settings.usage.projectBudget', defaultMessage: 'Project budget' }),
    <input
      className="inp mono us-num us-tok"
      inputMode="numeric"
      aria-label={PARAM_LABEL.project_budget}
      placeholder={t({ id: 'settings.common.noLimit', defaultMessage: 'No limit' })}
      disabled={busy}
      value={budget ?? policy.project_budget?.input_tokens.toString() ?? ''}
      onChange={(e) => setBudget(e.target.value)}
      onBlur={() => void commitBudget()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commitBudget();
      }}
    />,
    tokens,
  );
  const quotaRow = row(
    'runtime_quota_threshold',
    quotaName,
    <input
      className="inp mono us-num us-pct"
      inputMode="decimal"
      aria-label={PARAM_LABEL.runtime_quota_threshold}
      disabled={busy}
      value={quota ?? String(policy.runtime_quota_threshold ?? DEFAULT_QUOTA_THRESHOLD)}
      onChange={(e) => setQuota(e.target.value)}
      onBlur={() => void commitQuota()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commitQuota();
      }}
    />,
    '%',
    project ? (
      pin
    ) : (
      <span className="us-end">
        <Overrides
          name={quotaName}
          setting="workflow_policy"
          sets={(value) => value.runtime_quota_threshold !== undefined}
          valueText={(value) => `${value.runtime_quota_threshold}%`}
          clearGlobal={
            policySetting?.global?.runtime_quota_threshold === undefined
              ? undefined
              : () => {
                  const { runtime_quota_threshold: _, ...rest } = policySetting.global!;
                  return setGlobal('workflow_policy', rest);
                }
          }
          editor={(p) => <UsagePage project={p} only="runtime_quota_threshold" />}
        />
        {pin}
      </span>
    ),
  );
  if (only === 'project_budget') return <div className="ps-rows">{budgetRow}</div>;
  if (only === 'runtime_quota_threshold') return <div className="ps-rows">{quotaRow}</div>;

  return (
    <>
      {targets}
      <Section title={budgetTitle}>
        <div className="ps-rows">
          {project && budgetRow}
          {quotaRow}
        </div>
      </Section>
    </>
  );
}
