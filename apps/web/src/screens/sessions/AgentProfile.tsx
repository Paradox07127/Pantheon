import { Fragment, useState, type ReactNode } from 'react';
import { Bot, Pencil, Plus, X } from 'lucide-react';
import { Clip } from '../../components/Clip';
import { toast } from '../../components/Toast';
import { agentName, templateName, useAgents } from '../../data/agents';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import {
  FIELD_KEYS,
  agentFieldRows,
  changedFields,
  draftOf,
  refusalOf,
  type AgentDraft,
  type FieldKey,
  type Refusal,
} from './AgentForm';
import './agents.css';

// The profile edits the user's instructions in a section of their own.
const PROFILE_FIELDS: ReadonlySet<FieldKey> = new Set(
  FIELD_KEYS.filter((key) => key !== 'instructions'),
);

/** An agent's profile in a column beside the conversation; it edits the profile in place. */
export function AgentProfilePanel({
  projectId,
  agentId,
  onClose,
}: {
  projectId: string;
  agentId: string;
  onClose: () => void;
}) {
  const agents = useAgents(projectId);
  const profile = agents?.find((agent) => agent.id === agentId);
  // Edits keep the revision they started from, so a change made meanwhile is not overwritten.
  const [edit, setEdit] = useState<{ revision: number; draft: AgentDraft } | null>(null);
  const [instructions, setInstructions] = useState<{ revision: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  if (!profile) return null;
  const base = draftOf({
    ...profile,
    tools: profile.effective_tools,
    listens: profile.effective_listens,
  });
  const draft = edit?.draft ?? base;
  const changed = edit ? changedFields(edit.draft, base) : {};
  const dirty = Object.keys(changed).length > 0;
  const set = (patch: Partial<AgentDraft>) =>
    setEdit((now) => ({
      revision: now?.revision ?? profile.revision,
      draft: { ...(now?.draft ?? base), ...patch },
    }));
  const cancel = () => {
    setEdit(null);
    setError(null);
  };
  const save = async () => {
    if (!edit || !dirty || busy) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'agent.update',
      { agent_id: profile.id, revision: edit.revision, ...changed },
      null,
    );
    setBusy(false);
    if (result.ok) setEdit(null);
    else setError(refusalOf(result.error));
  };
  const saveInstructions = async () => {
    const text = instructions?.text.trim();
    if (!instructions || !text || busy) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'agent.update',
      { agent_id: profile.id, revision: instructions.revision, instructions: text },
      null,
    );
    setBusy(false);
    if (result.ok) setInstructions(null);
    else setError(refusalOf(result.error));
  };
  const ownLabel = t({
    id: 'sessions.agents.field.instructions',
    defaultMessage: 'Your instructions',
  });
  const archive = async () => {
    if (busy) return;
    setBusy(true);
    const result = await runCommand('agent.archive', { agent_id: profile.id }, null);
    setBusy(false);
    if (!result.ok) return toast({ title: failureText(result.error), kind: 'failure' });
    toast({
      title: t(
        { id: 'sessions.agents.archived', defaultMessage: '{name} archived' },
        { name: agentName(profile) },
      ),
      kind: 'result',
      action: {
        label: t({ id: 'sessions.agents.undo', defaultMessage: 'Undo' }),
        run: () =>
          void runCommand('agent.unarchive', { agent_id: profile.id }, null).then(
            (undone) => undone.ok || toast({ title: failureText(undone.error), kind: 'failure' }),
          ),
      },
    });
    onClose();
  };
  const fields = (
    <>
      <div className="ag-form ag-pform">
        <span className="ag-lb">
          {t({ id: 'sessions.agents.field.template', defaultMessage: 'Template' })}
        </span>
        <span className="ag-tv">{templateName(profile.template)}</span>
        {agentFieldRows({
          draft,
          set,
          id: `ag-${profile.id}`,
          projectId,
          fields: PROFILE_FIELDS,
          error,
          disabled: busy,
        })}
        {error && !error.field && (
          <p className="ag-err ag-wide" role="alert">
            {error.text}
          </p>
        )}
      </div>
      {dirty && (
        <div className="ag-acts">
          <button type="button" className="btn" disabled={busy} onClick={cancel}>
            {t({ id: 'sessions.agents.cancel', defaultMessage: 'Cancel' })}
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void save()}
          >
            {t({ id: 'sessions.agents.save', defaultMessage: 'Save' })}
          </button>
        </div>
      )}
      {/* A custom agent has no built-in role prompt. */}
      {profile.template !== 'custom' && (
        <section className="ag-sec" aria-labelledby={`ag-${profile.id}-builtin`}>
          <div className="ag-sh">
            <span className="cap" id={`ag-${profile.id}-builtin`}>
              {t({ id: 'sessions.agents.builtin', defaultMessage: 'Built-in role' })}
            </span>
          </div>
          <Clip as="div" className="ag-rp" text={profile.role_prompt} lines={3} />
        </section>
      )}
      <section className="ag-sec" aria-labelledby={`ag-${profile.id}-own`}>
        <div className="ag-sh">
          {instructions ? (
            <label className="cap" id={`ag-${profile.id}-own`} htmlFor={`ag-${profile.id}-ta`}>
              {ownLabel}
            </label>
          ) : (
            <span className="cap" id={`ag-${profile.id}-own`}>
              {ownLabel}
            </span>
          )}
          {!instructions && profile.instructions && (
            <button
              type="button"
              className="ib ag-end"
              aria-label={t({
                id: 'sessions.agents.instructions.edit',
                defaultMessage: 'Edit instructions',
              })}
              disabled={busy}
              onClick={() =>
                setInstructions({ revision: profile.revision, text: profile.instructions! })
              }
            >
              <Pencil aria-hidden="true" />
            </button>
          )}
        </div>
        {instructions ? (
          <>
            <textarea
              id={`ag-${profile.id}-ta`}
              className="ag-ta"
              rows={9}
              maxLength={20000}
              value={instructions.text}
              disabled={busy}
              aria-invalid={error?.field === 'instructions' || undefined}
              onChange={(e) => setInstructions({ ...instructions, text: e.target.value })}
            />
            {error?.field === 'instructions' && (
              <span className="ag-err" role="alert">
                {error.text}
              </span>
            )}
            <div className="ag-sa">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setInstructions(null);
                  setError(null);
                }}
              >
                {t({ id: 'sessions.agents.cancel', defaultMessage: 'Cancel' })}
              </button>
              <button
                type="button"
                className="btn pri"
                disabled={
                  busy ||
                  !instructions.text.trim() ||
                  instructions.text.trim() === (profile.instructions ?? '')
                }
                aria-busy={busy || undefined}
                onClick={() => void saveInstructions()}
              >
                {t({ id: 'sessions.agents.save', defaultMessage: 'Save' })}
              </button>
            </div>
          </>
        ) : profile.instructions ? (
          <p className="ag-ui">{profile.instructions}</p>
        ) : (
          <button
            type="button"
            className="btn sm ag-add"
            disabled={busy}
            onClick={() => setInstructions({ revision: profile.revision, text: '' })}
          >
            <Plus aria-hidden="true" />
            {t({ id: 'sessions.agents.instructions.add', defaultMessage: 'Add instructions' })}
          </button>
        )}
      </section>
    </>
  );
  // Sections show in this order, above the archive button.
  const sections: readonly { key: string; body: ReactNode }[] = [{ key: 'fields', body: fields }];
  return (
    <aside
      className="ag-insp"
      aria-label={t(
        { id: 'sessions.agents.profile.label', defaultMessage: '{name} profile' },
        { name: agentName(profile) },
      )}
    >
      <div className="ag-ih">
        <Bot aria-hidden="true" />
        <h2>{agentName(profile)}</h2>
        <span className="chip">{profile.role}</span>
        <button
          type="button"
          className="ib ag-end"
          aria-label={t({ id: 'sessions.agents.profile.close', defaultMessage: 'Close profile' })}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="ag-ib">
        {sections.map((section) => (
          <Fragment key={section.key}>{section.body}</Fragment>
        ))}
        {profile.template !== 'assistant' && (
          <div className="ag-acts ag-arch">
            <button type="button" className="btn" disabled={busy} onClick={() => void archive()}>
              {t({ id: 'sessions.agents.archive', defaultMessage: 'Archive' })}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
