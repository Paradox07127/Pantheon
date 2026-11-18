import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, X } from 'lucide-react';
import { Clip } from '../../components/Clip';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import {
  noteProposalDecided,
  templateName,
  useAgentProposal,
  useAgents,
  useDecidedProposal,
  type AgentProposal,
} from '../../data/agents';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { focusRequest, useWantedRequest } from '../../data/focus-request';
import { receiptOf } from '../../data/tool-calls';
import type { ToolItem, ToolState } from '../../data/transcript';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { clockText } from '../../lib/time-text';
import {
  agentFieldRows,
  changedFields,
  draftOf,
  refusalOf,
  routineDraft,
  type AgentDraft,
  type FieldKey,
  type Refusal,
} from './AgentForm';
import { OrchestrationRow } from './orchestration';

/** A routine's schedule in one line. */
function scheduleText(draft: ReturnType<typeof routineDraft>): string {
  if (draft.daily)
    return t(
      { id: 'sessions.agents.routine.dailyAt', defaultMessage: 'Daily at {time}' },
      { time: draft.at },
    );
  const count = Number(draft.amount);
  return draft.unit === 'days'
    ? t(
        {
          id: 'sessions.agents.routine.everyDays',
          defaultMessage: '{count, plural, one {Every day} other {Every # days}}',
        },
        { count },
      )
    : draft.unit === 'hours'
      ? t(
          {
            id: 'sessions.agents.routine.everyHours',
            defaultMessage: '{count, plural, one {Every hour} other {Every # hours}}',
          },
          { count },
        )
      : t(
          {
            id: 'sessions.agents.routine.everyMinutes',
            defaultMessage: '{count, plural, one {Every minute} other {Every # minutes}}',
          },
          { count },
        );
}

/** The proposal a propose_agent call's receipt holds; null while it has none. */
function proposalOf(output: unknown): AgentProposal | null {
  const receipt = receiptOf(output);
  return receipt && typeof receipt.id === 'string' && receipt.fields && receipt.state
    ? (receipt as unknown as AgentProposal)
    : null;
}

/**
 * A propose_agent call: the proposal's card with Create, Edit and Decline while it waits, one line
 * once decided, and the plain call row while it has no proposal.
 */
export function AgentProposalCall(props: {
  item: ToolItem;
  state: ToolState;
  depth: number;
  open: boolean;
  enter: string;
  /** The session whose thread shows the call. */
  sessionId: string;
}) {
  const proposal = proposalOf(props.item.output);
  const id = proposal?.id ?? null;
  const projectId = useBoard(
    (s) => s.board?.sessions.find((each) => each.id === props.sessionId)?.project_id ?? null,
  );
  const agents = useAgents(projectId);
  const here = useDecidedProposal(id);
  const stored = useAgentProposal(id);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  const card = useRef<HTMLElement>(null);
  const wanted = useWantedRequest();
  useEffect(() => {
    if (!id || wanted !== id) return;
    focusRequest(null);
    card.current?.scrollIntoView({ block: 'center' });
    card.current?.querySelector<HTMLElement>('.ag-pcf button')?.focus();
  }, [wanted, id]);

  if (!proposal) return <OrchestrationRow {...props} />;
  const fields = proposal.fields;
  const target = proposal.agent_id ? agents?.find((agent) => agent.id === proposal.agent_id) : null;
  const name = fields.name ?? target?.name ?? '';
  const known = here && here.state !== 'pending' ? here : stored;

  if (known && known.state !== 'pending') {
    const { state, resolved_at: at } = known;
    const decided = known.edited_fields?.name ?? known.fields.name ?? target?.name ?? '';
    const line =
      state === 'created'
        ? t(
            { id: 'sessions.agents.proposal.created', defaultMessage: 'You created {name}' },
            { name: decided },
          )
        : state === 'changed'
          ? t(
              { id: 'sessions.agents.proposal.changed', defaultMessage: 'You changed {name}' },
              { name: decided },
            )
          : t(
              { id: 'sessions.agents.proposal.declined', defaultMessage: 'You declined {name}' },
              { name: decided },
            );
    return (
      <div className={`ag-ln${props.enter}`}>
        {state === 'declined' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
        <span>{line}</span>
        {typeof at === 'number' && <span className="ag-lt">{clockText(at)}</span>}
      </div>
    );
  }

  // A change shows only the fields it changes; a new agent all it was given.
  const shown = new Set<FieldKey>(
    Object.keys(fields).map((key) =>
      key === 'runtime' || key === 'effort' ? 'model' : (key as FieldKey),
    ),
  );
  const base = draftOf(fields);
  const decide = async (decision: 'create' | 'decline') => {
    if (busy) return;
    const changed = decision === 'create' && draft ? changedFields(draft, base) : {};
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'agent.proposal.resolve',
      {
        proposal_id: proposal.id,
        decision,
        ...(Object.keys(changed).length > 0 && { fields: changed }),
      },
      null,
    );
    if (result.ok) {
      const decided = result.value as Partial<AgentProposal> | null;
      if (decided?.id === proposal.id && decided.state)
        noteProposalDecided(decided as AgentProposal);
    } else setError(refusalOf(result.error));
    setBusy(false);
  };
  const routines = fields.routines?.map(routineDraft);
  const fact = (key: string, label: string, value: ReactNode) => [
    <dt key={`${key}-l`}>{label}</dt>,
    <dd key={key}>{value}</dd>,
  ];
  const chips = (values: readonly string[]) => (
    <span className="ag-chips">
      {values.map((value) => (
        <span key={value} className="chip mono">
          {value}
        </span>
      ))}
    </span>
  );
  return (
    <section
      ref={card}
      className={`ag-pc${props.enter}`}
      aria-label={t(
        { id: 'sessions.agents.proposal.label', defaultMessage: 'Agent proposal: {name}' },
        { name },
      )}
    >
      <div className="ag-pch">
        <Bot aria-hidden="true" />
        <b className="ag-pn">{name}</b>
        {fields.role && <span className="chip">{fields.role}</span>}
        <span
          className="ss-dot waiting ag-end"
          role="img"
          aria-label={t({ id: 'sessions.agents.proposal.waits', defaultMessage: 'Waits for you' })}
        />
      </div>
      {draft ? (
        <div className="ag-form ag-pform">
          {agentFieldRows({
            draft,
            // agent.proposal.resolve takes no precheck, so a routine added from a template drops its check.
            set: ({ routines, ...patch }) =>
              setDraft(
                (now) =>
                  now && {
                    ...now,
                    ...patch,
                    ...(routines && {
                      routines: routines.map(({ precheck: _check, ...routine }) => routine),
                    }),
                  },
              ),
            id: `ag-${proposal.id}`,
            projectId: proposal.project_id,
            fields: shown,
            error,
            disabled: busy,
          })}
        </div>
      ) : (
        <>
          <dl className="ag-kv">
            {fields.template &&
              fact(
                'template',
                t({ id: 'sessions.agents.field.template', defaultMessage: 'Template' }),
                templateName(fields.template),
              )}
            {(fields.runtime || fields.model) &&
              fact(
                'model',
                t({ id: 'sessions.agents.field.model', defaultMessage: 'Model' }),
                <span className="ag-chips">
                  {fields.runtime && <RuntimeGlyph runtime={fields.runtime} />}
                  <span className="mono">{listText(fields.model, fields.effort)}</span>
                </span>,
              )}
            {fields.tools &&
              fact(
                'tools',
                t({ id: 'sessions.agents.field.tools', defaultMessage: 'Tools' }),
                chips(fields.tools),
              )}
            {fields.listens &&
              fact(
                'listens',
                t({ id: 'sessions.agents.field.listens', defaultMessage: 'Listens' }),
                chips(fields.listens),
              )}
            {(routines || !proposal.agent_id) &&
              fact(
                'routines',
                t({ id: 'sessions.agents.field.routines', defaultMessage: 'Routines' }),
                routines?.length ? (
                  <span className="ag-rl">
                    {routines.map((routine, i) => (
                      <span key={i}>{listText(scheduleText(routine), routine.prompt)}</span>
                    ))}
                  </span>
                ) : (
                  <span className="ag-mu">
                    {t({ id: 'sessions.agents.proposal.none', defaultMessage: 'None' })}
                  </span>
                ),
              )}
            {fields.brief &&
              fact(
                'brief',
                t({ id: 'sessions.agents.field.brief', defaultMessage: 'Brief' }),
                fields.brief,
              )}
          </dl>
          {fields.instructions && (
            <div className="ag-pp">
              <span className="cap">
                {t({
                  id: 'sessions.agents.field.instructions',
                  defaultMessage: 'Your instructions',
                })}
              </span>
              <Clip as="div" className="ag-pt" text={fields.instructions} lines={3} />
            </div>
          )}
        </>
      )}
      {error && (!draft || !error.field) && (
        <p className="ag-err ag-pe" role="alert">
          {error.text}
        </p>
      )}
      <div className="ag-pcf">
        {draft ? (
          <button
            type="button"
            className="btn"
            disabled={busy || !known}
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            {t({ id: 'sessions.agents.cancel', defaultMessage: 'Cancel' })}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              disabled={busy || !known}
              onClick={() => void decide('decline')}
            >
              {t({ id: 'sessions.agents.proposal.decline', defaultMessage: 'Decline' })}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !known}
              onClick={() => {
                setError(null);
                setDraft(base);
              }}
            >
              {t({ id: 'sessions.agents.proposal.edit', defaultMessage: 'Edit' })}
            </button>
          </>
        )}
        <button
          type="button"
          className="btn pri"
          disabled={busy || !known}
          aria-busy={busy || undefined}
          onClick={() => void decide('create')}
        >
          {t({ id: 'sessions.agents.create', defaultMessage: 'Create' })}
        </button>
      </div>
    </section>
  );
}
