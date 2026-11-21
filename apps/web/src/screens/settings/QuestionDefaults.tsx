import { useRef, useState } from 'react';
import type { BoardSnapshot } from '@pantheon/protocol';
import { LoadError } from '../../components/LoadError';
import {
  isPolicy,
  PARAM_LABEL,
  setPolicy,
  useWorkflowPolicy,
  type PolicyPatch,
  type WorkflowPolicy,
} from '../../data/workflow-policy';
import { t } from '../../i18n';
import { policyStepper } from './PolicyStepper';
import { Loading } from './ProjectSettingsScreen';
import './policy-rows.css';

type Project = BoardSnapshot['projects'][number];

/** The project's question deadline, set with workflow.policy.set. */
export function QuestionDefaults({ project }: { project: Project }) {
  const read = useWorkflowPolicy(project.id);
  // The policy a command returned, shown until a read reaches its version.
  const [saved, setSaved] = useState<WorkflowPolicy | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const sending = useRef(false);

  const policy =
    saved && (!read.read || read.read.policy_version < saved.policy_version) ? saved : read.read;
  if (!policy)
    return read.error ? <LoadError message={read.error} onRetry={read.reload} /> : <Loading />;

  const send = async (patch: PolicyPatch) => {
    if (sending.current || read.stale) return false;
    sending.current = true;
    setPending(true);
    setFailure(null);
    const result = await setPolicy(policy, patch);
    sending.current = false;
    setPending(false);
    if (!result.ok) {
      setFailure(result.error);
      return false;
    }
    if (isPolicy(result.value)) setSaved(result.value);
    read.reload();
    return true;
  };
  const busy = pending || read.stale;

  return (
    <div className="ps-rows">
      <div
        role="group"
        aria-label={PARAM_LABEL.question_defaults}
        aria-busy={pending || undefined}
        className="ps-row wf-pr"
        data-setting-id="workflow.questionDefaults"
      >
        <span className="wf-nm">
          <span>{PARAM_LABEL.question_defaults}</span>
        </span>
        <span className="wf-qd">
          <input
            type="checkbox"
            className="ps-sw"
            aria-label={PARAM_LABEL.question_defaults}
            checked={!!policy.question_defaults}
            disabled={busy}
            onChange={(e) =>
              void send({ question_defaults: e.target.checked ? { after_hours: 24 } : null })
            }
          />
          {policy.question_defaults &&
            policyStepper({
              label: t({
                id: 'settings.workflow.questionDefaultsHours',
                defaultMessage: 'Hours',
              }),
              value: policy.question_defaults.after_hours,
              low: 1,
              high: 168,
              disabled: busy,
              draft,
              onDraft: setDraft,
              onSet: (to) => send({ question_defaults: { after_hours: to! } }),
              onInvalid: setFailure,
            })}
        </span>
        <span />
        {failure && (
          <div className="ps-err wf-err" role="alert">
            {failure}
          </div>
        )}
      </div>
    </div>
  );
}
