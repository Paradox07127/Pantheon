import type { BoardActivity, BoardModel } from '@pantheon/protocol';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { StateGlyph } from '../../components/SessionStateIcon';
import { needsKey } from '../../data/notice-tiers';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { PHASE, toolText } from './activity';
import { leadState, type BoardLead } from './frame-model';
import type { RunBoardCommand, SnapshotSession } from './panels-model';
import './overview.css';

/** What a lead is doing, in a few words. */
function doing(a: BoardActivity): string {
  if (a.phase === 'tool' && a.tool) return toolText(a.tool);
  return a.waiting?.summary || PHASE[a.phase];
}

/** The sentence a lead's line says: what it is doing, else its state. */
export const leadLine = (lead: BoardLead): string =>
  lead.activity ? doing(lead.activity) : leadState(lead).label;

/**
 * Each lead on one line: its runtime, its state, with several leads its plan title, what it is
 * doing and a button opening its session; while a question of it, relayed ones included, waits on
 * the user, what it is doing jumps to that question in the needs-you strip; below, the tasks each
 * lead planned onto another device.
 */
export function LeadPanel({
  model,
  sessions,
  onOpenSession,
  onOpenTask,
  run,
}: {
  model: BoardModel;
  sessions: readonly SnapshotSession[];
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
  // With one lead the board is its plan; with several each row names whose plan it is.
  const titled = (model.leads ?? []).length > 1;
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
          const line = asked?.question ?? leadLine(lead);
          const question = run
            ? model.needs?.find(
                (n) => n.kind === 'lead.question' && n.session_id === lead.session_id,
              )
            : undefined;
          const questionKey = question && needsKey(question);
          return (
            <li key={lead.session_id} className="bld-i">
              {session && <RuntimeGlyph runtime={session.runtime} />}
              <StateGlyph name={state.glyph} />
              {titled && (
                <span className="bld-t" title={name}>
                  {name}
                </span>
              )}
              {questionKey ? (
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
                <span className="bld-do" title={line}>
                  {line}
                </span>
              )}
              <button
                type="button"
                className="btn bld-r"
                aria-label={t(
                  {
                    id: 'board.frame.lead.label',
                    defaultMessage: '{name} {state}, open session',
                  },
                  { name, state: state.label },
                )}
                onClick={() => onOpenSession(lead.session_id)}
              >
                {t({ id: 'board.lead.line.open', defaultMessage: 'Open lead' })}
              </button>
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
