import type { BoardActivity, BoardModel } from '@pantheon/protocol';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { useNow } from '../../data/needs-you';
import { needsKey } from '../../data/notice-tiers';
import { useRuntimeModels } from '../../data/runtime-models';
import { useSessionList } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { EFFORT_LABEL } from '../sessions/model';
import { agoText, PHASE, toolText } from './activity';
import { ContextRing } from './FlowNode';
import { leadState, type BoardLead } from './frame-model';
import { stateParts } from './MilestoneCard';
import type { RunBoardCommand, SnapshotSession } from './panels-model';
import { modelName, TaskStateIcon, taskStateLabel } from './status';
import './overview.css';

type Task = BoardModel['tasks'][number];

/** A task still in an agent's hands: neither merged nor discarded. */
const inHand = (task: Task) =>
  task.state !== 'merged' && task.status !== 'done' && task.status !== 'discarded';

/** What a lead is doing, in a few words. */
function doing(a: BoardActivity): string {
  if (a.phase === 'tool' && a.tool) return toolText(a.tool);
  return a.waiting?.summary || PHASE[a.phase];
}

/** The sentence a lead's line says: the status line it set, else what it is doing, else its state. */
export const leadLine = (lead: BoardLead): string =>
  lead.status_line?.text ?? (lead.activity ? doing(lead.activity) : leadState(lead).label);

/** How long ago the lead set its status line, kept current. */
function Ago({ at, floor }: { at: number; floor: number }) {
  const now = Math.max(floor, useNow(15_000));
  return <span className="bld-ago">{agoText(at, now)}</span>;
}

/** The project's open resident sessions that are not leads of the board, one per agent: the one not handing over. */
export function residentSessions(
  sessions: readonly SnapshotSession[],
  projectId: string | undefined,
  model: Pick<BoardModel, 'leads'>,
): SnapshotSession[] {
  const leads = new Set((model.leads ?? []).map((lead) => lead.session_id));
  const seen = new Set<string>();
  return sessions
    .filter(
      (s) =>
        s.resident &&
        s.project_id === projectId &&
        s.state !== 'closed' &&
        !s.archived_at &&
        !leads.has(s.id),
    )
    .sort((a, b) => Number(!!a.rotation) - Number(!!b.rotation))
    .filter((s) => {
      const agent = s.resident!.agent_id ?? s.id;
      if (seen.has(agent)) return false;
      seen.add(agent);
      return true;
    });
}

/** A resident session's state as a lead's. */
const residentState = (s: SnapshotSession) =>
  leadState({ state: s.state === 'running' ? 'running' : 'idle' });

/** One tile per task the agent has in hand, its state in the icon and in its name; the count beside. */
function Workers({ tasks, onOpenTask }: { tasks: Task[]; onOpenTask: (taskId: string) => void }) {
  return (
    <span className="bld-w">
      <span
        className="bld-ws"
        role="group"
        aria-label={t(
          {
            id: 'board.lead.workers',
            defaultMessage:
              '{count, plural, =0 {No workers} one {# worker: {parts}} other {# workers: {parts}}}',
          },
          { count: tasks.length, parts: stateParts(tasks) },
        )}
      >
        {tasks.map((task) => {
          const label = t(
            { id: 'board.task.link.label', defaultMessage: '{title}, {status}' },
            { title: task.title, status: taskStateLabel(task) },
          );
          return (
            <Tip key={task.id} content={label}>
              <button
                type="button"
                className="bld-wt"
                aria-label={label}
                onClick={() => onOpenTask(task.id)}
              >
                <TaskStateIcon task={task} />
              </button>
            </Tip>
          );
        })}
      </span>
      {tasks.length > 0 && (
        <span className="bld-n" aria-hidden="true">
          {tasks.length}
        </span>
      )}
    </span>
  );
}

/**
 * From the project's session list: the session's model by its name in the runtime's list with its
 * effort, and with `withContext` the context it has used.
 */
function AgentFacts({
  projectId,
  sessionId,
  withContext,
}: {
  projectId: string | null;
  sessionId: string;
  withContext: boolean;
}) {
  const session = useSessionList(projectId).data?.find((s) => s.id === sessionId);
  const runtime = session?.runtime ?? '';
  const models = useRuntimeModels(projectId, runtime ? [runtime] : [])[runtime];
  if (!session) return null;
  const model =
    session.model && modelName(models?.state === 'ready' ? models.models : [], session.model);
  return (
    <>
      {model && (
        <span className="chip bld-mc">
          {session.effort
            ? t(
                { id: 'board.lead.model', defaultMessage: '{model} {effort}' },
                { model, effort: EFFORT_LABEL[session.effort] },
              )
            : model}
        </span>
      )}
      {withContext && session.context && <AgentContext context={session.context} />}
    </>
  );
}

/** The share of the context window used, as a ring and its percent. */
function AgentContext({ context }: { context: NonNullable<BoardLead['context']> }) {
  const percent = Math.min(100, Math.round((context.used_tokens / context.window_tokens) * 100));
  return (
    <span className="bld-cx">
      <ContextRing context={context} />
      <span aria-hidden="true">{`${percent}%`}</span>
    </span>
  );
}

/**
 * Each lead on one line, then each resident: its runtime, its name opening its session, its state,
 * a tile per task it has in hand, what it is doing, its model and the context it has used; while a
 * question of a lead, relayed ones included, waits on the user, what it is doing jumps to that
 * question in the needs-you strip; below, the tasks each lead planned onto another device.
 */
export function LeadPanel({
  model,
  sessions,
  projectId,
  onOpenSession,
  onOpenTask,
  run,
}: {
  model: BoardModel;
  sessions: readonly SnapshotSession[];
  /** The board's project, whose residents get a line each; without it only the leads do. */
  projectId?: string;
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
  /** Present while the needs-you strip beside answers the questions; without it no line jumps there. */
  run?: RunBoardCommand;
}) {
  const sent = model.tasks.filter((task) => {
    const device = task.planned?.device;
    return device && device !== 'local';
  });
  const owners = [...new Set(sent.map((task) => task.owner_session_id))];
  const held = (sessionId: string) =>
    model.tasks.filter((task) => task.owner_session_id === sessionId && inHand(task));
  const openLabel = (name: string, state: string) =>
    t(
      { id: 'board.frame.lead.label', defaultMessage: '{name} {state}, open session' },
      { name, state },
    );
  return (
    <section className="bld" aria-label="lead" data-debug-region="board.lead">
      <ul className="bld-l">
        {(model.leads ?? []).map((lead) => {
          // A question the lead asked on the board leaves its session idle until the user answers.
          const asked =
            lead.state === 'idle'
              ? model.needs?.find(
                  (n) => n.kind === 'lead.question' && n.session_id === lead.session_id,
                )?.question
              : undefined;
          const shown = asked ? { ...lead, state: 'waiting' as const } : lead;
          const state = leadState(shown);
          const session = sessions.find((s) => s.id === lead.session_id);
          const name = lead.title || t({ id: 'board.lead.untitled', defaultMessage: 'Lead' });
          const status = asked ? undefined : lead.status_line;
          const line = asked?.question ?? status?.text ?? (lead.activity && doing(lead.activity));
          const question = run
            ? model.needs?.find(
                (n) => n.kind === 'lead.question' && n.session_id === lead.session_id,
              )
            : undefined;
          const questionKey = question && needsKey(question);
          return (
            <li key={lead.session_id} className="bld-i">
              <span className="bld-rt">
                {session && <RuntimeGlyph runtime={session.runtime} />}
              </span>
              <button
                type="button"
                className="bld-t"
                title={name}
                aria-label={openLabel(name, state.label)}
                onClick={() => onOpenSession(lead.session_id)}
              >
                {name}
              </button>
              <span className="bld-st">
                <StateGlyph name={state.glyph} />
              </span>
              <Workers tasks={held(lead.session_id)} onOpenTask={onOpenTask} />
              <span className="bld-m">
                {line && questionKey ? (
                  <button
                    type="button"
                    className="bd-lnk bld-do"
                    title={line}
                    aria-label={t(
                      {
                        id: 'board.lead.line.toQuestion',
                        defaultMessage: 'Jump to this question in Needs you: {question}',
                      },
                      { question: question.question?.question ?? line },
                    )}
                    onClick={() => useShell.setState({ askedNeed: questionKey })}
                  >
                    {line}
                  </button>
                ) : (
                  line && (
                    <span className="bld-do" title={line}>
                      {line}
                      {status && (
                        <>
                          {' '}
                          <Ago at={status.at} floor={model.now} />
                        </>
                      )}
                    </span>
                  )
                )}
              </span>
              <AgentFacts
                projectId={projectId ?? null}
                sessionId={lead.session_id}
                withContext={!lead.context}
              />
              {lead.context && <AgentContext context={lead.context} />}
            </li>
          );
        })}
        {residentSessions(sessions, projectId, model).map((session) => {
          const name = session.title || t({ id: 'board.lead.untitled', defaultMessage: 'Lead' });
          const state = residentState(session);
          return (
            <li key={session.id} className="bld-i">
              <span className="bld-rt">
                <RuntimeGlyph runtime={session.runtime} />
              </span>
              <button
                type="button"
                className="bld-t"
                title={name}
                aria-label={openLabel(name, state.label)}
                onClick={() => onOpenSession(session.id)}
              >
                {name}
              </button>
              <span className="bld-st">
                <StateGlyph name={state.glyph} />
              </span>
              <Workers tasks={held(session.id)} onOpenTask={onOpenTask} />
              <AgentFacts projectId={projectId ?? null} sessionId={session.id} withContext />
            </li>
          );
        })}
      </ul>
      {owners.map((owner) => {
        const tasks = sent.filter((task) => task.owner_session_id === owner);
        const sender = sessions.find((s) => s.id === owner)?.runtime;
        return (
          <div key={owner ?? ''} className="bld-dn">
            <div className="bld-dh">
              {sender && <RuntimeGlyph runtime={sender} />}
              <b>
                {t(
                  {
                    id: 'board.lead.dispatch.title',
                    defaultMessage:
                      '{count, plural, one {lead sent # task to another device} other {lead sent # tasks to other devices}}',
                  },
                  { count: tasks.length },
                )}
              </b>
            </div>
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className="bld-dr"
                onClick={() => onOpenTask(task.id)}
              >
                <span className="chip mono">{task.planned!.device}</span>
                <span className="bld-dt">{task.title}</span>
                {task.planned!.device_reason && (
                  <span className="bld-dw">{task.planned!.device_reason}</span>
                )}
              </button>
            ))}
          </div>
        );
      })}
    </section>
  );
}
