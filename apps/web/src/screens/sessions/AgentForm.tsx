import { useState, type FormEvent, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Bot, Plus, X } from 'lucide-react';
import type { AgentRoutineInput } from '@pantheon/protocol';
import { Select } from '../../components/Select';
import { toast } from '../../components/Toast';
import {
  OFFERED_LISTENS,
  OFFERED_TOOLS,
  agentName,
  useAgents,
  templateName,
  useAgentTemplates,
  type AgentProfile,
  type AgentToolGroup,
  type CreatedTemplate,
  type EventSource,
} from '../../data/agents';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { useRuntimeModels } from '../../data/runtime-models';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import { t } from '../../i18n';
import { ModelMenu, type ModelChoice } from './ModelMenu';
import './agents.css';

type Unit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

/** A routine as the form edits it: an interval in a unit, or a daily time. */
export interface RoutineDraft {
  id?: string;
  prompt: string;
  daily: boolean;
  amount: string;
  unit: Unit;
  at: string;
  active: boolean;
  from: string;
  to: string;
  enabled: boolean;
}

/** A stored routine, with every_ms, or one as agent.create takes it, with every_minutes. */
type RoutineSource = Omit<AgentRoutineInput, 'id'> & { id?: string; every_ms?: number };

export function routineDraft(routine: RoutineSource): RoutineDraft {
  const minutes =
    routine.every_minutes ??
    (routine.every_ms === undefined ? UNIT_MINUTES.days : Math.round(routine.every_ms / 60_000));
  const unit: Unit =
    minutes % UNIT_MINUTES.days === 0
      ? 'days'
      : minutes % UNIT_MINUTES.hours === 0
        ? 'hours'
        : 'minutes';
  return {
    ...(routine.id !== undefined && { id: routine.id }),
    prompt: routine.prompt,
    daily: routine.at !== undefined,
    amount: String(minutes / UNIT_MINUTES[unit]),
    unit,
    at: routine.at ?? '09:00',
    active: routine.active_hours !== undefined,
    from: routine.active_hours?.from ?? '09:00',
    to: routine.active_hours?.to ?? '18:00',
    enabled: routine.enabled,
  };
}

export function routineInput(draft: RoutineDraft): AgentRoutineInput {
  return {
    ...(draft.id !== undefined && { id: draft.id }),
    prompt: draft.prompt.trim(),
    ...(draft.daily
      ? { at: draft.at }
      : { every_minutes: Math.round(Number(draft.amount) * UNIT_MINUTES[draft.unit]) }),
    ...(draft.active && { active_hours: { from: draft.from, to: draft.to } }),
    enabled: draft.enabled,
  };
}

const NEW_ROUTINE: RoutineDraft = {
  prompt: '',
  daily: false,
  amount: '1',
  unit: 'days',
  at: '09:00',
  active: false,
  from: '09:00',
  to: '18:00',
  enabled: true,
};

/** The fields as the form edits them; null tools or listens are not known and not sent. */
export interface AgentDraft {
  name: string;
  role: string;
  instructions: string;
  brief: string;
  tools: AgentToolGroup[] | null;
  listens: EventSource[] | null;
  /** null keeps the runtime and model the agent has. */
  model: ModelChoice | null;
  routines: RoutineDraft[];
}

export type FieldKey =
  'name' | 'role' | 'instructions' | 'brief' | 'tools' | 'listens' | 'model' | 'routines';

export const FIELD_KEYS: readonly FieldKey[] = [
  'name',
  'role',
  'instructions',
  'tools',
  'listens',
  'model',
  'brief',
  'routines',
];

export function draftOf(source: {
  name?: string;
  role?: string;
  instructions?: string;
  brief?: string;
  tools?: AgentToolGroup[];
  listens?: EventSource[];
  runtime?: string;
  model?: string;
  effort?: AgentProfile['effort'];
  routines?: RoutineSource[];
}): AgentDraft {
  return {
    name: source.name ?? '',
    role: source.role ?? '',
    instructions: source.instructions ?? '',
    brief: source.brief ?? '',
    tools: source.tools ?? null,
    listens: source.listens ?? null,
    model:
      source.runtime || source.model
        ? {
            runtime: source.runtime ?? '',
            backend: null,
            model: source.model ?? null,
            effort: source.effort ?? null,
          }
        : null,
    routines: (source.routines ?? []).map(routineDraft),
  };
}

const modelFields = (model: ModelChoice) => ({
  ...(model.runtime && { runtime: model.runtime }),
  ...(model.model && { model: model.model }),
  ...(model.effort && { effort: model.effort }),
});
const sameList = (a: readonly string[] | null, b: readonly string[] | null) =>
  [...(a ?? [])].sort().join() === [...(b ?? [])].sort().join();

/** The agent.create fields of the draft. */
export function createFields(draft: AgentDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    role: draft.role.trim(),
    instructions: draft.instructions.trim(),
    ...(draft.brief.trim() && { brief: draft.brief.trim() }),
    ...(draft.tools && { tools: draft.tools }),
    ...(draft.listens && { listens: draft.listens }),
    ...(draft.model && modelFields(draft.model)),
    routines: draft.routines.map(routineInput),
  };
}

/** The fields the draft changed from base, as agent.update and a proposal's decision take them. */
export function changedFields(draft: AgentDraft, base: AgentDraft): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of ['name', 'role', 'instructions', 'brief'] as const) {
    const value = draft[key].trim();
    if (value && value !== base[key].trim()) changed[key] = value;
  }
  if (draft.tools && !sameList(draft.tools, base.tools)) changed.tools = draft.tools;
  if (draft.listens && !sameList(draft.listens, base.listens)) changed.listens = draft.listens;
  if (draft.model && JSON.stringify(draft.model) !== JSON.stringify(base.model))
    Object.assign(changed, modelFields(draft.model));
  const routines = draft.routines.map(routineInput);
  if (JSON.stringify(routines) !== JSON.stringify(base.routines.map(routineInput)))
    changed.routines = routines;
  return changed;
}

/** A refusal and the field it names; null field: it shows under the form. */
export interface Refusal {
  field: FieldKey | null;
  text: string;
}

/** The field a refusal of agent.create, agent.update or a proposal's decision names. */
export function refusalOf(error: { code: string; message: string }): Refusal {
  const { message } = error;
  const path =
    /^(?:input\.)?(?:fields\.)?(name|role|instructions|brief|tools|listens|runtime|model|effort|routines)\b/m.exec(
      message,
    )?.[1];
  const field: FieldKey | null = path
    ? path === 'runtime' || path === 'effort'
      ? 'model'
      : (path as FieldKey)
    : /\bnamed\b/.test(message)
      ? 'name'
      : /routine/i.test(message)
        ? 'routines'
        : /\btools\b/.test(message)
          ? 'tools'
          : /runtime/i.test(message)
            ? 'model'
            : null;
  return { field, text: failureText(error) };
}

/** The runtime, model and effort of an agent, through the model menu. */
function AgentModel(props: {
  projectId: string;
  value: ModelChoice | null;
  onChange: (next: ModelChoice) => void;
  disabled?: boolean;
}) {
  const { read, unavailable, disconnected } = useRuntimeStatus('reviewer');
  const offered = offeredRuntimes(read, [props.value?.runtime]);
  const models = useRuntimeModels(props.projectId, offered);
  const runtime = props.value?.runtime || offered[0];
  if (!runtime) return <span className="ag-busy" aria-busy="true" />;
  return (
    <ModelMenu
      runtimes={offered}
      models={models}
      value={props.value ?? { runtime, backend: null, model: null, effort: null }}
      onChange={(next) => props.onChange({ ...next, backend: null })}
      unavailable={unavailable}
      disconnected={disconnected}
      keys={false}
      disabled={props.disabled}
    />
  );
}

const UNITS: { value: Unit; readonly label: string }[] = [
  {
    value: 'minutes',
    get label() {
      return t({ id: 'sessions.agents.routine.minutes', defaultMessage: 'minutes' });
    },
  },
  {
    value: 'hours',
    get label() {
      return t({ id: 'sessions.agents.routine.hours', defaultMessage: 'hours' });
    },
  },
  {
    value: 'days',
    get label() {
      return t({ id: 'sessions.agents.routine.days', defaultMessage: 'days' });
    },
  },
];

/** A radio button of a `.seg` group. */
function segment(key: string, checked: boolean, label: string, pick: () => void, off?: boolean) {
  return (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={checked}
      data-checked={checked || undefined}
      disabled={off}
      onClick={pick}
    >
      {label}
    </button>
  );
}

/**
 * The label and control of each field, in the order of a two-column grid, with a refusal under
 * the field it names. `id` keeps the ids of two forms apart; `fields` limits the fields shown.
 */
export function agentFieldRows(props: {
  draft: AgentDraft;
  set: (patch: Partial<AgentDraft>) => void;
  id: string;
  projectId: string;
  fields?: ReadonlySet<FieldKey>;
  error?: Refusal | null;
  disabled?: boolean;
}): ReactNode[] {
  const { draft, set, id, disabled } = props;
  const shown = (key: FieldKey) => !props.fields || props.fields.has(key);
  const refusal = (key: FieldKey) =>
    props.error?.field === key && (
      <span className="ag-err" role="alert">
        {props.error.text}
      </span>
    );
  const invalid = (key: FieldKey) => props.error?.field === key || undefined;
  const text = (
    key: 'name' | 'role' | 'instructions' | 'brief',
    label: string,
    max: number,
    rows?: number,
  ) => [
    <label key={`${key}-l`} className="ag-lb" htmlFor={`${id}-${key}`}>
      {label}
    </label>,
    <div key={key} className="ag-fc">
      {rows ? (
        <textarea
          id={`${id}-${key}`}
          className="ag-ta"
          rows={rows}
          maxLength={max}
          value={draft[key]}
          disabled={disabled}
          aria-invalid={invalid(key)}
          onChange={(e) => set({ [key]: e.target.value })}
        />
      ) : (
        <input
          id={`${id}-${key}`}
          className={key === 'role' ? 'inp ag-role' : 'inp'}
          maxLength={max}
          value={draft[key]}
          disabled={disabled}
          aria-invalid={invalid(key)}
          onChange={(e) => set({ [key]: e.target.value })}
        />
      )}
      {refusal(key)}
    </div>,
  ];
  const checks = <V extends string>(
    key: 'tools' | 'listens',
    label: string,
    offered: readonly V[],
    picked: V[] | null,
    name: (value: V) => ReactNode,
  ) =>
    picked && [
      <span key={`${key}-l`} className="ag-lb" id={`${id}-${key}`}>
        {label}
      </span>,
      <div key={key} className="ag-fc">
        <div className="ag-tg" role="group" aria-labelledby={`${id}-${key}`}>
          {offered.map((value) => (
            <label key={value}>
              <input
                type="checkbox"
                className="ps-sw"
                checked={picked.includes(value)}
                disabled={disabled}
                onChange={(e) =>
                  set({
                    [key]: e.target.checked
                      ? [...picked, value]
                      : picked.filter((each) => each !== value),
                  })
                }
              />
              {name(value)}
            </label>
          ))}
        </div>
        {refusal(key)}
      </div>,
    ];
  const routine = (r: RoutineDraft, at: number) => {
    const patch = (change: Partial<RoutineDraft>) =>
      set({
        routines: draft.routines.map((each, i) => (i === at ? { ...each, ...change } : each)),
      });
    return (
      <div
        key={at}
        className="ag-rtn"
        role="group"
        aria-label={t(
          { id: 'sessions.agents.routine.label', defaultMessage: 'Routine {number}' },
          { number: at + 1 },
        )}
      >
        <div className="ag-rr">
          <div
            className="seg"
            role="radiogroup"
            aria-label={t({ id: 'sessions.agents.routine.schedule', defaultMessage: 'Schedule' })}
          >
            {segment(
              'every',
              !r.daily,
              t({ id: 'sessions.agents.routine.every', defaultMessage: 'Every' }),
              () => patch({ daily: false }),
              disabled,
            )}
            {segment(
              'daily',
              r.daily,
              t({ id: 'sessions.agents.routine.daily', defaultMessage: 'Daily at' }),
              () => patch({ daily: true }),
              disabled,
            )}
          </div>
          {r.daily ? (
            <input
              className="inp ag-tm"
              aria-label={t({ id: 'sessions.agents.routine.at', defaultMessage: 'Time' })}
              inputMode="numeric"
              maxLength={5}
              value={r.at}
              disabled={disabled}
              onChange={(e) => patch({ at: e.target.value })}
            />
          ) : (
            <>
              <input
                className="inp ag-n"
                aria-label={t({
                  id: 'sessions.agents.routine.interval',
                  defaultMessage: 'Interval',
                })}
                inputMode="numeric"
                value={r.amount}
                disabled={disabled}
                onChange={(e) => patch({ amount: e.target.value.replace(/\D/g, '') })}
              />
              <Select<Unit>
                aria-label={t({ id: 'sessions.agents.routine.unit', defaultMessage: 'Unit' })}
                value={r.unit}
                options={UNITS.map((unit) => ({ value: unit.value, label: unit.label }))}
                disabled={disabled}
                onChange={(unit) => patch({ unit })}
              />
            </>
          )}
          <input
            type="checkbox"
            className="ps-sw ag-end"
            aria-label={t({ id: 'sessions.agents.routine.enabled', defaultMessage: 'On' })}
            checked={r.enabled}
            disabled={disabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <button
            type="button"
            className="ib"
            aria-label={t({
              id: 'sessions.agents.routine.remove',
              defaultMessage: 'Remove routine',
            })}
            disabled={disabled}
            onClick={() => set({ routines: draft.routines.filter((_, i) => i !== at) })}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <input
          className="inp"
          aria-label={t({ id: 'sessions.agents.routine.prompt', defaultMessage: 'Routine prompt' })}
          maxLength={2000}
          value={r.prompt}
          disabled={disabled}
          onChange={(e) => patch({ prompt: e.target.value })}
        />
        <div className="ag-rr">
          <label className="ag-ck">
            <input
              type="checkbox"
              className="ps-sw"
              checked={r.active}
              disabled={disabled}
              onChange={(e) => patch({ active: e.target.checked })}
            />
            {t({ id: 'sessions.agents.routine.activeHours', defaultMessage: 'Active hours' })}
          </label>
          {r.active && (
            <>
              <input
                className="inp ag-tm"
                aria-label={t({
                  id: 'sessions.agents.routine.from',
                  defaultMessage: 'Active from',
                })}
                inputMode="numeric"
                maxLength={5}
                value={r.from}
                disabled={disabled}
                onChange={(e) => patch({ from: e.target.value })}
              />
              <input
                className="inp ag-tm"
                aria-label={t({
                  id: 'sessions.agents.routine.until',
                  defaultMessage: 'Active until',
                })}
                inputMode="numeric"
                maxLength={5}
                value={r.to}
                disabled={disabled}
                onChange={(e) => patch({ to: e.target.value })}
              />
            </>
          )}
        </div>
      </div>
    );
  };
  return [
    shown('name') &&
      text('name', t({ id: 'sessions.agents.field.name', defaultMessage: 'Name' }), 80),
    shown('role') &&
      text('role', t({ id: 'sessions.agents.field.role', defaultMessage: 'Role' }), 24),
    shown('instructions') &&
      text(
        'instructions',
        t({ id: 'sessions.agents.field.instructions', defaultMessage: 'Role prompt' }),
        20000,
        7,
      ),
    shown('tools') &&
      checks(
        'tools',
        t({ id: 'sessions.agents.field.tools', defaultMessage: 'Tools' }),
        OFFERED_TOOLS,
        draft.tools,
        (tool) => <span className="mono">{tool}</span>,
      ),
    shown('listens') &&
      checks(
        'listens',
        t({ id: 'sessions.agents.field.listens', defaultMessage: 'Listens' }),
        OFFERED_LISTENS,
        draft.listens,
        () => t({ id: 'sessions.agents.listen.github', defaultMessage: 'GitHub' }),
      ),
    shown('model') && [
      <span key="model-l" className="ag-lb">
        {t({ id: 'sessions.agents.field.model', defaultMessage: 'Model' })}
      </span>,
      <div key="model" className="ag-fc">
        <AgentModel
          projectId={props.projectId}
          value={draft.model}
          onChange={(model) => set({ model })}
          disabled={disabled}
        />
        {refusal('model')}
      </div>,
    ],
    shown('brief') &&
      text('brief', t({ id: 'sessions.agents.field.brief', defaultMessage: 'Brief' }), 4000, 2),
    shown('routines') && [
      <span key="routines-l" className="ag-lb" id={`${id}-routines`}>
        {t({ id: 'sessions.agents.field.routines', defaultMessage: 'Routines' })}
      </span>,
      <div key="routines" className="ag-fc" role="group" aria-labelledby={`${id}-routines`}>
        {draft.routines.map(routine)}
        <button
          type="button"
          className="btn sm ghost ag-add"
          disabled={disabled || draft.routines.length >= 10}
          onClick={() => set({ routines: [...draft.routines, NEW_ROUTINE] })}
        >
          <Plus aria-hidden="true" />
          {t({ id: 'sessions.agents.routine.add', defaultMessage: 'Add routine' })}
        </button>
        {refusal('routines')}
      </div>,
    ],
  ].flat();
}

const CREATED: readonly CreatedTemplate[] = ['ideas', 'goals', 'custom'];
const EMPTY = draftOf({});
const ready = (draft: AgentDraft | null) =>
  !!draft && !!draft.name.trim() && !!draft.role.trim() && !!draft.instructions.trim();

/** The form that creates an agent from a template, over the window. */
export function NewAgentDialog({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const templates = useAgentTemplates();
  const [template, setTemplate] = useState<CreatedTemplate>('ideas');
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  const defaults = (name: CreatedTemplate) => templates?.find((each) => each.template === name);
  const prefill = defaults(template);
  if (!draft && prefill) setDraft(draftOf(prefill));
  const pick = (name: CreatedTemplate) => {
    const next = defaults(name);
    setTemplate(name);
    setDraft(next ? draftOf(next) : null);
    setError(null);
  };
  const close = () => {
    setTemplate('ideas');
    setDraft(null);
    setError(null);
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || !ready(draft) || busy) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'agent.create',
      { project_id: projectId, template, ...createFields(draft) },
      null,
    );
    setBusy(false);
    if (result.ok) close();
    else setError(refusalOf(result.error));
  };
  const title = t({ id: 'sessions.agents.new.title', defaultMessage: 'New agent' });
  return (
    <Dialog.Root open={open} onOpenChange={(next) => next || close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" />
        <Dialog.Popup className="pj-dlg ag-dlg" aria-label={title}>
          <form
            className="ag-dform"
            aria-busy={!draft || undefined}
            onSubmit={(e) => void submit(e)}
          >
            <div className="pj-dh ag-dh">
              <Dialog.Title className="pj-dt">{title}</Dialog.Title>
              <Dialog.Close
                className="ib ag-end"
                aria-label={t({ id: 'sessions.agents.close', defaultMessage: 'Close' })}
              >
                <X aria-hidden="true" />
              </Dialog.Close>
            </div>
            <div className="ag-form ag-db">
              <span className="ag-lb" id="ag-new-template">
                {t({ id: 'sessions.agents.field.template', defaultMessage: 'Template' })}
              </span>
              <div className="ag-fc">
                <div className="seg ag-seg" role="radiogroup" aria-labelledby="ag-new-template">
                  {CREATED.map((name) =>
                    segment(name, template === name, templateName(name), () => pick(name), busy),
                  )}
                </div>
              </div>
              {agentFieldRows({
                draft: draft ?? EMPTY,
                set: (patch) => setDraft((now) => now && { ...now, ...patch }),
                id: 'ag-new',
                projectId,
                error,
                disabled: !draft || busy,
              })}
              {error && !error.field && (
                <p className="ag-err ag-wide" role="alert">
                  {error.text}
                </p>
              )}
            </div>
            <div className="pj-df">
              <button type="button" className="btn" onClick={close}>
                {t({ id: 'sessions.agents.cancel', defaultMessage: 'Cancel' })}
              </button>
              <button
                type="submit"
                className="btn pri"
                disabled={!ready(draft) || busy}
                aria-busy={busy || undefined}
              >
                {t({ id: 'sessions.agents.create', defaultMessage: 'Create' })}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

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
  const templates = useAgentTemplates();
  const profile = agents?.find((agent) => agent.id === agentId);
  // Edits keep the revision they started from, so a change made meanwhile is not overwritten.
  const [edit, setEdit] = useState<{ revision: number; draft: AgentDraft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  if (!profile) return null;
  const defaults = templates?.find((each) => each.template === profile.template);
  const base = draftOf({
    ...profile,
    tools: profile.tools ?? defaults?.tools,
    listens: profile.listens ?? defaults?.listens,
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
