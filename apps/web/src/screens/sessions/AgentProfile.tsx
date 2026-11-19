import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Bot,
  Circle,
  CircleDashed,
  Hourglass,
  Loader,
  MessageSquare,
  Pencil,
  Plus,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { ROUTINE_TEMPLATES } from '@pantheon/protocol/routine-catalog';
import { ChangeOutcomeCard, changeOutcomeTitle } from '../../components/ChangeOutcomeCard';
import { Clip } from '../../components/Clip';
import { LoadError } from '../../components/LoadError';
import { Skeleton } from '../../components/Skeleton';
import { toast } from '../../components/Toast';
import {
  agentName,
  templateName,
  useAgentLedger,
  useAgentRoutines,
  useAgentWakes,
  useAgents,
  type AgentListed,
  type AgentWake,
} from '../../data/agents';
import { useChangeOutcomes } from '../../data/change-outcomes';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { dayText } from '../../lib/time-text';
import { useShell } from '../../store';
import { tokenText } from '../board/panels-model';
import {
  FIELD_KEYS,
  ROUTINE_TEMPLATE_NAMES,
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
  const sections: readonly { key: string; body: ReactNode }[] = [
    { key: 'fields', body: fields },
    { key: 'contract', body: <AgentContract profile={profile} /> },
    { key: 'wakes', body: <RecentWakes profile={profile} /> },
    { key: 'runs', body: <RoutineRuns profile={profile} /> },
    { key: 'week', body: <WeekLedger profile={profile} /> },
    { key: 'outcomes', body: <AgentOutcomes profile={profile} /> },
  ];
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

type Contract = NonNullable<AgentListed['contract']>;
type Loudest = NonNullable<Contract['loudest']>;
type Hours = NonNullable<Contract['quiet_hours']>;

const LOUDEST: readonly { value: Loudest; label: () => string }[] = [
  {
    value: 'feed',
    label: () => t({ id: 'sessions.agents.contract.feed', defaultMessage: 'Feed' }),
  },
  {
    value: 'notify',
    label: () => t({ id: 'sessions.agents.contract.notify', defaultMessage: 'Notify' }),
  },
  {
    value: 'ask',
    label: () => t({ id: 'sessions.agents.contract.ask', defaultMessage: 'Ask' }),
  },
];

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** A section of the profile under its caption, with what goes at the end of its head. */
const section = (id: string, title: string, body: ReactNode, end?: ReactNode) => (
  <section className="ag-sec" aria-labelledby={id}>
    <div className="ag-sh">
      <span className="cap" id={id}>
        {title}
      </span>
      {end}
    </div>
    {body}
  </section>
);

/** Rows of Skeleton bars while a section's first read is out. */
const loadingRows = (widths: readonly string[]) => (
  <div className="ag-skl" aria-busy="true">
    {widths.map((width, i) => (
      <Skeleton key={i} style={{ height: 8, width }} />
    ))}
  </div>
);

/** The agent's weekly budget, the loudest way it may reach the user and its quiet hours; each saves by itself. */
function AgentContract({ profile }: { profile: AgentListed }) {
  const contract: Contract = profile.contract ?? {};
  const week = useAgentLedger(profile.project_id, profile.id);
  // What the user changed at this revision; a saved change bumps the revision and the profile shows it.
  const [draft, setDraft] = useState<{
    revision: number;
    budget?: string;
    loudest?: Loudest;
    quiet?: Hours | null;
  } | null>(null);
  const [refusal, setRefusal] = useState<{
    field: 'budget' | 'loudest' | 'quiet';
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = draft?.revision === profile.revision ? draft : null;
  const budget = live?.budget ?? String(contract.weekly_input_tokens ?? '');
  const loudest = live?.loudest ?? contract.loudest;
  const quiet = live && 'quiet' in live ? live.quiet! : (contract.quiet_hours ?? null);
  const set = (patch: Omit<NonNullable<typeof draft>, 'revision'>) =>
    setDraft((now) => ({
      ...(now?.revision === profile.revision ? now : {}),
      revision: profile.revision,
      ...patch,
    }));
  const save = async (
    field: 'budget' | 'loudest' | 'quiet',
    next: { budget?: string; loudest?: Loudest; quiet?: Hours | null },
  ) => {
    const shown = { budget, loudest, quiet, ...next };
    setBusy(true);
    setRefusal(null);
    const result = await runCommand(
      'agent.update',
      {
        agent_id: profile.id,
        revision: profile.revision,
        contract: {
          ...(shown.budget.trim() && { weekly_input_tokens: Number(shown.budget) }),
          ...(shown.loudest && { loudest: shown.loudest }),
          ...(shown.quiet && { quiet_hours: shown.quiet }),
        },
      },
      null,
    );
    setBusy(false);
    if (!result.ok) setRefusal({ field, text: failureText(result.error) });
  };
  const refused = (field: 'budget' | 'loudest' | 'quiet') =>
    refusal?.field === field && (
      <span className="ag-err" role="alert">
        {refusal.text}
      </span>
    );
  const cap = contract.weekly_input_tokens;
  const spent = week.data?.input_tokens;
  const now = new Date();
  const at = now.getHours() * 60 + now.getMinutes();
  const [from, to] = quiet ? [minutesOf(quiet.from), minutesOf(quiet.to)] : [0, 0];
  const quietNow = !!quiet && (from <= to ? at >= from && at < to : at >= from || at < to);
  const id = `ag-${profile.id}-contract`;
  return section(
    id,
    t({ id: 'sessions.agents.contract.title', defaultMessage: 'Contract' }),
    <div className="ag-form ag-cf">
      <label className="ag-lb" htmlFor={`${id}-budget`}>
        {t({ id: 'sessions.agents.contract.budget', defaultMessage: 'Weekly budget' })}
      </label>
      <div className="ag-fc">
        <input
          id={`${id}-budget`}
          className="inp ag-num"
          inputMode="numeric"
          placeholder={t({ id: 'sessions.agents.contract.noLimit', defaultMessage: 'No limit' })}
          value={budget}
          aria-invalid={refusal?.field === 'budget' || undefined}
          onChange={(e) => set({ budget: e.target.value })}
          onBlur={() => {
            if (budget !== String(contract.weekly_input_tokens ?? '')) void save('budget', {});
          }}
        />
        {refused('budget')}
      </div>
      <span className="ag-lb">
        {t({ id: 'sessions.agents.contract.spent', defaultMessage: 'Spent this week' })}
      </span>
      <div className="ag-fc">
        {week.error ? (
          <LoadError message={week.error} onRetry={week.reload} />
        ) : spent === undefined ? (
          loadingRows(['100%'])
        ) : (
          <div className="ag-sp">
            {cap !== undefined && (
              <span
                className="meter ag-meter"
                role="img"
                aria-label={t(
                  {
                    id: 'sessions.agents.contract.spentMeter',
                    defaultMessage: '{percent}% of the weekly budget spent',
                  },
                  { percent: Math.min(100, Math.round((spent / cap) * 100)) },
                )}
                style={{ '--v': `${Math.min(100, (spent / cap) * 100)}%` } as CSSProperties}
              >
                <i />
              </span>
            )}
            <span className="ag-num">{tokenText(spent)}</span>
            {cap !== undefined && (
              <span className="ag-num ag-mu">
                {t(
                  { id: 'sessions.agents.contract.ofBudget', defaultMessage: 'of {budget}' },
                  { budget: tokenText(cap) },
                )}
              </span>
            )}
          </div>
        )}
      </div>
      <span className="ag-lb" id={`${id}-loudest`}>
        {t({ id: 'sessions.agents.contract.loudest', defaultMessage: 'Loudest' })}
      </span>
      <div className="ag-fc">
        <div className="seg ag-seg" role="radiogroup" aria-labelledby={`${id}-loudest`}>
          {LOUDEST.map(({ value, label }) => {
            const checked = (loudest ?? 'ask') === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={checked}
                data-checked={checked || undefined}
                disabled={busy}
                onClick={() => {
                  if (checked) return;
                  set({ loudest: value });
                  void save('loudest', { loudest: value });
                }}
              >
                {label()}
              </button>
            );
          })}
        </div>
        {refused('loudest')}
      </div>
      <span className="ag-lb" id={`${id}-quiet`}>
        {t({ id: 'sessions.agents.contract.quiet', defaultMessage: 'Quiet hours' })}
      </span>
      <div className="ag-fc">
        <div className="ag-rr" role="group" aria-labelledby={`${id}-quiet`}>
          <input
            type="checkbox"
            className="ps-sw"
            aria-label={t({
              id: 'sessions.agents.contract.quiet',
              defaultMessage: 'Quiet hours',
            })}
            checked={!!quiet}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.checked
                ? (contract.quiet_hours ?? { from: '22:00', to: '08:00' })
                : null;
              set({ quiet: next });
              void save('quiet', { quiet: next });
            }}
          />
          {quiet && (
            <>
              {(['from', 'to'] as const).map((end) => (
                <input
                  key={end}
                  className="inp ag-tm"
                  aria-label={
                    end === 'from'
                      ? t({
                          id: 'sessions.agents.contract.quietFrom',
                          defaultMessage: 'Quiet from',
                        })
                      : t({
                          id: 'sessions.agents.contract.quietUntil',
                          defaultMessage: 'Quiet until',
                        })
                  }
                  inputMode="numeric"
                  maxLength={5}
                  value={quiet[end]}
                  aria-invalid={refusal?.field === 'quiet' || undefined}
                  onChange={(e) => set({ quiet: { ...quiet, [end]: e.target.value } })}
                  onBlur={() => {
                    if (JSON.stringify(quiet) !== JSON.stringify(contract.quiet_hours ?? null))
                      void save('quiet', {});
                  }}
                />
              ))}
              {quietNow && (
                <span className="chip ag-hold" data-tone="idle">
                  {t({ id: 'sessions.agents.contract.quietNow', defaultMessage: 'Quiet now' })}
                </span>
              )}
            </>
          )}
        </div>
        {refused('quiet')}
      </div>
    </div>,
    cap !== undefined && spent !== undefined && spent >= cap && (
      <span className="chip ag-hold ag-end">
        {t({ id: 'sessions.agents.contract.held', defaultMessage: 'Wakes held' })}
      </span>
    ),
  );
}

/** The interface words for what woke an agent; another kind shows its name. */
function causeName(kind: AgentWake['causes'][number]): string {
  switch (kind) {
    case 'routine':
      return t({ id: 'sessions.agents.cause.routine', defaultMessage: 'Routine' });
    case 'signal':
      return t({ id: 'sessions.agents.cause.signal', defaultMessage: 'Signal' });
    case 'user_message':
      return t({ id: 'sessions.agents.cause.userMessage', defaultMessage: 'Your message' });
    case 'agent_report':
      return t({ id: 'sessions.agents.cause.agentReport', defaultMessage: 'Agent report' });
    case 'external':
      return t({ id: 'sessions.agents.cause.external', defaultMessage: 'External request' });
    case 'follow_up':
      return t({ id: 'sessions.agents.cause.followUp', defaultMessage: 'Follow-up' });
    case 'answer':
      return t({ id: 'sessions.agents.cause.answer', defaultMessage: 'Your answer' });
    default:
      return kind.replaceAll('_', ' ');
  }
}

/** A routine's catalog name when it is a template's, else the first line of its prompt. */
function routineTitle(prompt: string): string {
  const template = ROUTINE_TEMPLATES.find((each) => each.prompt === prompt);
  return template
    ? (ROUTINE_TEMPLATE_NAMES[template.id]?.() ?? template.title)
    : prompt.split('\n')[0]!;
}

type WakeEnd = Pick<AgentWake, 'state' | 'outcome'>;

/** What a wake came to once its turn completed, else where its turn is. */
function wakeWord({ state, outcome }: WakeEnd): string {
  if (state === 'completed')
    return outcome === 'acted'
      ? t({ id: 'sessions.agents.outcome.acted', defaultMessage: 'Acted' })
      : outcome === 'told_user'
        ? t({ id: 'sessions.agents.outcome.toldUser', defaultMessage: 'Told you' })
        : outcome === 'asked'
          ? t({ id: 'sessions.agents.outcome.asked', defaultMessage: 'Asked you' })
          : t({ id: 'sessions.agents.outcome.nothing', defaultMessage: 'Nothing' });
  return state === 'queued'
    ? t({ id: 'sessions.agents.wakeState.queued', defaultMessage: 'Queued' })
    : state === 'running'
      ? t({ id: 'sessions.agents.wakeState.running', defaultMessage: 'Running' })
      : state === 'failed'
        ? t({ id: 'sessions.agents.wakeState.failed', defaultMessage: 'Failed' })
        : t({ id: 'sessions.agents.wakeState.cancelled', defaultMessage: 'Cancelled' });
}

/** The outcome or state of a wake as a glyph named by its word. */
function wakeGlyph(end: WakeEnd) {
  const { state, outcome } = end;
  const [Icon, tone]: [LucideIcon, string | undefined] =
    state === 'completed'
      ? outcome === 'acted'
        ? [Zap, undefined]
        : outcome === 'told_user'
          ? [MessageSquare, undefined]
          : outcome === 'asked'
            ? [Hourglass, 'wait']
            : [Circle, undefined]
      : state === 'queued'
        ? [CircleDashed, undefined]
        : state === 'running'
          ? [Loader, 'run']
          : state === 'failed'
            ? [X, 'bad']
            : [Circle, undefined];
  return (
    <span className="ag-wg" role="img" aria-label={wakeWord(end)} data-tone={tone}>
      <Icon aria-hidden="true" />
    </span>
  );
}

/** The agent's last five wakes, newest first; each opens its session. */
function RecentWakes({ profile }: { profile: AgentListed }) {
  const wakes = useAgentWakes(profile.project_id, profile.id, 5);
  const now = Date.now();
  return section(
    `ag-${profile.id}-wakes`,
    t({ id: 'sessions.agents.wakes.title', defaultMessage: 'Recent wakes' }),
    <>
      {wakes.error ? (
        <LoadError message={wakes.error} onRetry={wakes.reload} />
      ) : !wakes.data ? (
        loadingRows(['60%', '40%', '54%', '36%'])
      ) : wakes.data.length === 0 ? (
        <p className="ag-none">
          {t({ id: 'sessions.agents.wakes.empty', defaultMessage: 'No wakes yet' })}
        </p>
      ) : (
        <div className="ag-wks">
          {wakes.data.map((wake) => {
            const time = dayText(wake.at, now, { time: true });
            const said = (wake.questions[0] ?? wake.messages[0])?.text;
            const causes = wake.causes.map((kind) =>
              kind === 'routine'
                ? listText(
                    causeName(kind),
                    ...(wake.routine_ids ?? []).map((routineId) => {
                      const routine = profile.routines.find((each) => each.id === routineId);
                      return routine && routineTitle(routine.prompt);
                    }),
                  )
                : causeName(kind),
            );
            return (
              <button
                key={wake.turn_id}
                type="button"
                className="ag-wk"
                aria-label={t(
                  { id: 'sessions.agents.wakes.open', defaultMessage: 'Open the wake of {time}' },
                  { time },
                )}
                onClick={() => useShell.getState().openSession(wake.session_id)}
              >
                {wakeGlyph(wake)}
                <span className="ag-wc">{listText(...causes)}</span>
                <span className="ag-wt">{time}</span>
                <span className="ag-w2">
                  <span>{wakeWord(wake)}</span>
                  {wake.actions > 0 && (
                    <span>
                      {t(
                        {
                          id: 'sessions.agents.wakes.actions',
                          defaultMessage: '{count, plural, one {# action} other {# actions}}',
                        },
                        { count: wake.actions },
                      )}
                    </span>
                  )}
                  {wake.usage && (
                    <span className="ag-wn">{tokenText(wake.usage.input_tokens)}</span>
                  )}
                </span>
                {said && <span className="ag-w3">{said}</span>}
              </button>
            );
          })}
        </div>
      )}
    </>,
  );
}

/** How often a routine runs, in words. */
function scheduleText(routine: { every_ms?: number; at?: string }): string {
  if (routine.at !== undefined)
    return t(
      { id: 'sessions.agents.runs.daily', defaultMessage: 'Daily at {time}' },
      { time: routine.at },
    );
  const minutes = Math.round((routine.every_ms ?? 0) / 60_000);
  if (minutes % 1440 === 0)
    return t(
      {
        id: 'sessions.agents.runs.everyDays',
        defaultMessage: 'Every {count, plural, one {day} other {# days}}',
      },
      { count: minutes / 1440 },
    );
  if (minutes % 60 === 0)
    return t(
      {
        id: 'sessions.agents.runs.everyHours',
        defaultMessage: 'Every {count, plural, one {hour} other {# hours}}',
      },
      { count: minutes / 60 },
    );
  return t(
    {
      id: 'sessions.agents.runs.everyMinutes',
      defaultMessage: 'Every {count, plural, one {minute} other {# minutes}}',
    },
    { count: minutes },
  );
}

/** Each routine of the agent with its next and last run, and a button that runs it now. */
function RoutineRuns({ profile }: { profile: AgentListed }) {
  const runs = useAgentRoutines(profile.project_id, profile.id);
  const [starting, setStarting] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ routine: string; text: string } | null>(null);
  const run = async (routine: string) => {
    setStarting(routine);
    setRefused(null);
    const result = await runCommand(
      'agent.routine.run',
      { agent_id: profile.id, routine_id: routine },
      null,
    );
    setStarting(null);
    if (!result.ok) setRefused({ routine, text: failureText(result.error) });
  };
  const now = Date.now();
  return section(
    `ag-${profile.id}-runs`,
    t({ id: 'sessions.agents.runs.title', defaultMessage: 'Routine runs' }),
    <>
      {runs.error ? (
        <LoadError message={runs.error} onRetry={runs.reload} />
      ) : !runs.data ? (
        loadingRows(['30%', '66%'])
      ) : runs.data.length === 0 ? (
        <p className="ag-none">
          {t({ id: 'sessions.agents.runs.empty', defaultMessage: 'No routines' })}
        </p>
      ) : (
        <div className="ag-wks">
          {runs.data.map(({ routine, next_run_at, last_run }) => {
            const title = routineTitle(routine.prompt);
            return (
              <div
                key={routine.id}
                className="ag-rn"
                role="group"
                aria-label={title}
                data-off={!routine.enabled || undefined}
              >
                <span className="ag-rnt">{title}</span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={
                    !routine.enabled ||
                    starting === routine.id ||
                    last_run?.state === 'queued' ||
                    last_run?.state === 'running'
                  }
                  onClick={() => void run(routine.id)}
                >
                  {t({ id: 'sessions.agents.runs.runNow', defaultMessage: 'Run now' })}
                </button>
                <span className="ag-w2">
                  <span>{scheduleText(routine)}</span>
                  {!routine.enabled ? (
                    <span>
                      {t({ id: 'sessions.agents.runs.paused', defaultMessage: 'Paused' })}
                    </span>
                  ) : (
                    next_run_at !== undefined && (
                      <span>
                        {t(
                          { id: 'sessions.agents.runs.next', defaultMessage: 'Next {time}' },
                          { time: dayText(next_run_at, now, { time: true }) },
                        )}
                      </span>
                    )
                  )}
                  {last_run && (
                    <span className="ag-wn">
                      {wakeGlyph(last_run)}
                      <span>{wakeWord(last_run)}</span>
                      <span>{dayText(last_run.at, now, { time: true })}</span>
                    </span>
                  )}
                </span>
                {refused?.routine === routine.id && (
                  <span className="ag-err ag-wide" role="alert">
                    {refused.text}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>,
  );
}

/** One number of the week's ledger over what it counts. */
const cell = (key: string, count: ReactNode, label: string) => (
  <div key={key} className="cell">
    <span className="ag-big">{count}</span>
    <span className="cap">{label}</span>
  </div>
);

/** What the agent did in the last seven days: its wakes by cause and what they came to, tasks and tokens. */
function WeekLedger({ profile }: { profile: AgentListed }) {
  const week = useAgentLedger(profile.project_id, profile.id);
  const data = week.data;
  const causes = data
    ? (Object.entries(data.causes) as [AgentWake['causes'][number], number][]).sort(
        (a, b) => b[1] - a[1],
      )
    : [];
  const other = causes.slice(3).reduce((sum, [, n]) => sum + n, 0);
  return section(
    `ag-${profile.id}-week`,
    t({ id: 'sessions.agents.week.title', defaultMessage: 'This week' }),
    <>
      {week.error ? (
        <LoadError message={week.error} onRetry={week.reload} />
      ) : !data ? (
        loadingRows(['50%', '80%'])
      ) : data.wakes === 0 ? (
        <p className="ag-none">
          {t({ id: 'sessions.agents.week.empty', defaultMessage: 'No wakes this week' })}
        </p>
      ) : (
        <div className="panel ag-lg">
          <div className="cell ag-lw">
            <span className="ag-lwn">
              <span className="ag-big">{data.wakes}</span>
              <span className="cap">
                {t(
                  {
                    id: 'sessions.agents.week.wakes',
                    defaultMessage: '{count, plural, one {wake} other {wakes}}',
                  },
                  { count: data.wakes },
                )}
              </span>
            </span>
            <span className="ag-lc">
              {causes.slice(0, 3).map(([kind, n]) => (
                <span key={kind}>
                  {causeName(kind)}
                  <span className="ag-num">{n}</span>
                </span>
              ))}
              {other > 0 && (
                <span>
                  {t({ id: 'sessions.agents.week.other', defaultMessage: 'Other' })}
                  <span className="ag-num">{other}</span>
                </span>
              )}
            </span>
          </div>
          {cell(
            'nothing',
            data.outcomes.nothing,
            wakeWord({ state: 'completed', outcome: 'nothing' }),
          )}
          {cell('acted', data.outcomes.acted, wakeWord({ state: 'completed', outcome: 'acted' }))}
          {cell(
            'told',
            data.outcomes.told_user,
            wakeWord({ state: 'completed', outcome: 'told_user' }),
          )}
          {cell('asked', data.outcomes.asked, wakeWord({ state: 'completed', outcome: 'asked' }))}
          {cell(
            'started',
            data.tasks_started,
            t(
              {
                id: 'sessions.agents.week.started',
                defaultMessage: '{count, plural, one {task started} other {tasks started}}',
              },
              { count: data.tasks_started },
            ),
          )}
          {cell(
            'merged',
            data.tasks_merged,
            t({ id: 'sessions.agents.week.merged', defaultMessage: 'merged' }),
          )}
          {cell(
            'tokens',
            tokenText(data.input_tokens),
            t({ id: 'sessions.agents.week.tokens', defaultMessage: 'input tokens' }),
          )}
          {cell(
            'approved',
            data.prompts_auto_approved,
            t(
              {
                id: 'sessions.agents.week.approved',
                defaultMessage:
                  '{count, plural, one {prompt approved for you} other {prompts approved for you}}',
              },
              { count: data.prompts_auto_approved },
            ),
          )}
        </div>
      )}
    </>,
  );
}

/** What creating the agent and turning on its routines did to the tasks after, newest first; none once read draws nothing. */
function AgentOutcomes({ profile }: { profile: AgentListed }) {
  const outcomes = useChangeOutcomes(profile.project_id);
  const own = (outcomes.read ?? []).filter(
    (outcome) =>
      outcome.agent_id === profile.id &&
      (outcome.kind === 'agent_created' || outcome.kind === 'routine_enabled'),
  );
  if (outcomes.unavailable || (!outcomes.error && outcomes.read && own.length === 0)) return null;
  return section(
    `ag-${profile.id}-outcomes`,
    changeOutcomeTitle(),
    outcomes.error ? (
      <ChangeOutcomeCard outcome={null} error={outcomes.error} onRetry={outcomes.reload} />
    ) : !outcomes.read ? (
      <ChangeOutcomeCard outcome={null} />
    ) : (
      own.map((outcome) => (
        <ChangeOutcomeCard
          key={outcome.event_id}
          outcome={outcome}
          title={
            outcome.kind === 'agent_created'
              ? t(
                  { id: 'sessions.agents.outcomes.created', defaultMessage: '{name} created' },
                  { name: agentName(profile) },
                )
              : t(
                  {
                    id: 'sessions.agents.outcomes.turnedOn',
                    defaultMessage: '{routines} turned on',
                  },
                  {
                    routines: listText(
                      ...(outcome.routine_ids ?? []).map((routineId) => {
                        const routine = profile.routines.find((each) => each.id === routineId);
                        return routine && routineTitle(routine.prompt);
                      }),
                    ),
                  },
                )
          }
        />
      ))
    ),
  );
}
