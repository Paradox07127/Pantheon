import { useEffect, useState } from 'react';
import { LoadError } from '../../components/LoadError';
import { create } from 'zustand';
import type { BoardSnapshot } from '@pantheon/protocol';
import {
  isPolicy,
  PARAM_LABEL,
  setPolicy,
  useWorkflowPolicy,
  type PolicyPatch,
  type WorkflowPolicy,
} from '../../data/workflow-policy';
import { t } from '../../i18n';
import { Loading } from './ProjectSettingsScreen';
import './usage-page.css';

type Project = BoardSnapshot['projects'][number];

const useUsageSave = create<{
  /** The policy a command returned, shown until a read reaches its version. */
  saved: WorkflowPolicy | null;
  pending: boolean;
  failure: { project_id: string; text: string } | null;
  /** Counts the saves that went through, so the page reads the policy again after each. */
  saves: number;
}>(() => ({
  saved: null,
  pending: false,
  failure: null,
  saves: 0,
}));

async function savePolicy(policy: WorkflowPolicy, patch: PolicyPatch) {
  if (useUsageSave.getState().pending) return false;
  useUsageSave.setState({ pending: true, failure: null });
  const result = await setPolicy(policy, patch);
  const s = useUsageSave.getState();
  useUsageSave.setState(
    result.ok
      ? {
          pending: false,
          saved: isPolicy(result.value) ? result.value : s.saved,
          saves: s.saves + 1,
        }
      : { pending: false, failure: { project_id: policy.project_id, text: result.error } },
  );
  return result.ok;
}

/** The project's input token budget. */
export function UsagePage({ project }: { project: Project }) {
  const read = useWorkflowPolicy(project.id);
  const savedPolicy = useUsageSave((s) => s.saved);
  const busy = useUsageSave((s) => s.pending);
  const savedFailure = useUsageSave((s) => s.failure);
  const saves = useUsageSave((s) => s.saves);
  const [budget, setBudget] = useState<string | null>(null);

  const saved = savedPolicy?.project_id === project.id ? savedPolicy : null;
  const policy =
    saved && (!read.read || read.read.policy_version < saved.policy_version) ? saved : read.read;
  const failure = savedFailure?.project_id === project.id ? savedFailure : null;

  useEffect(() => {
    if (saves > 0) read.reload();
  }, [saves]);

  if (!policy)
    return read.error ? <LoadError message={read.error} onRetry={read.reload} /> : <Loading />;

  const commitBudget = async () => {
    if (budget === null || read.stale) return;
    const typed = budget.trim();
    const to = typed === '' ? null : Number(typed);
    if (to !== null && !(Number.isInteger(to) && to > 0)) {
      useUsageSave.setState({
        failure: {
          project_id: project.id,
          text: t(
            {
              id: 'settings.usage.positive',
              defaultMessage: '{param} must be a positive whole number',
            },
            { param: PARAM_LABEL.project_budget },
          ),
        },
      });
      return;
    }
    if (
      to === (policy.project_budget?.input_tokens ?? null) ||
      (await savePolicy(policy, { project_budget: to === null ? null : { input_tokens: to } }))
    )
      setBudget(null);
  };

  const name = t({ id: 'settings.usage.projectBudget', defaultMessage: 'Project budget' });
  return (
    <div className="ps-rows">
      <div
        role="group"
        aria-label={name}
        aria-busy={busy || undefined}
        className="ps-row us-pr"
        data-setting-id="project.budget"
      >
        <span className="us-nm">{name}</span>
        <span className="us-ct">
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
          />
          <span className="mu us-unit">
            {t({ id: 'settings.usage.tokens', defaultMessage: 'tokens' })}
          </span>
        </span>
        {failure && (
          <div className="ps-err us-err" role="alert">
            {failure.text}
          </div>
        )}
      </div>
    </div>
  );
}
