import { Crown } from 'lucide-react';
import { SPAWNED_SESSION_LIMIT, type WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { ContextRing } from '../../components/ContextRing';
import { SessionStateIcon, lastTurnFailure } from '../../components/SessionStateIcon';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { sessionRow } from '../sessions/model';
import { conductorLabel } from '../sessions/session-groups';
import { agentRows, takingTurns } from './project-model';

/** The main agent and the sessions it spawned, one row each that opens it. */
export function AgentList({
  main,
  sessions,
}: {
  main: WorkbenchSession;
  sessions: readonly WorkbenchSession[] | null;
}) {
  const rows = agentRows(main, sessions);
  const running = takingTurns(rows.slice(1));
  const title = t({ id: 'project.agents.title', defaultMessage: 'Agent' });
  return (
    <section className="pj-card" aria-label={title}>
      <div className="pj-ch">
        <h2 className="pj-h2">{title}</h2>
        <span
          className="chip pj-end"
          role="img"
          aria-label={t(
            {
              id: 'project.agents.slotsLabel',
              defaultMessage:
                '{running, plural, one {# session} other {# sessions}} of the main agent running, at most {limit}',
            },
            { running, limit: SPAWNED_SESSION_LIMIT },
          )}
        >
          {t(
            { id: 'project.agents.slots', defaultMessage: '{running} / {limit}' },
            { running, limit: SPAWNED_SESSION_LIMIT },
          )}
        </span>
      </div>
      <ul className="pj-ags">
        {rows.map((s) => {
          const subtitle = lastTurnFailure(s) ?? s.recap?.headline;
          return (
            <li key={s.id}>
              <button
                type="button"
                className="pj-ag"
                onClick={() => useShell.getState().openSession(s.id)}
              >
                <SessionStateIcon session={s} place="list" />
                <span className="pj-at">
                  <span className="pj-atl">
                    <Clip text={sessionRow(s).title} />
                    {s === main && (
                      <Crown className="ic-sm mu" role="img" aria-label={conductorLabel()} />
                    )}
                  </span>
                  {subtitle && <Clip text={subtitle} className="pj-sub" />}
                </span>
                {s.context && <ContextRing context={s.context} />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
