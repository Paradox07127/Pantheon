import { useState } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { Failure } from '../../components/PanelBoundary';
import { Skeleton } from '../../components/Skeleton';
import { shortId } from '../../data/format';
import { ageText, useNow } from '../../data/needs-you';
import { sendProjectCommand } from '../../data/project-read';
import type { ProjectResident } from '../../data/project-resident';
import { t } from '../../i18n';
import { tokenText } from '../../lib/number-text';
import { dayText } from '../../lib/time-text';
import { useShell } from '../../store';
import { sessionRow } from '../sessions/model';

/** How many wakes show before the list is expanded. */
export const SHOWN_WAKES = 5;

type Wake = ProjectResident['wakes'][number];

const wakeText = (wake: Wake) =>
  wake.kind === 'woken'
    ? t({ id: 'project.resident.woken', defaultMessage: 'Woken' })
    : wake.reason === 'budget'
      ? t({ id: 'project.resident.skippedBudget', defaultMessage: 'Not woken: budget used up' })
      : t({
          id: 'project.resident.skippedNotAccepting',
          defaultMessage: 'Not woken: session not accepting',
        });

/** The budget line: used against the limit, or that it ran out and stops the wakes. */
export function budgetText(budget: ProjectResident['budget']): string {
  if (!budget) return t({ id: 'project.resident.noBudget', defaultMessage: 'No limit' });
  if (budget.reached_at !== undefined)
    return t({
      id: 'project.resident.budgetReached',
      defaultMessage: 'Budget used up, Pantheon no longer wakes it',
    });
  return t(
    { id: 'project.resident.budgetUse', defaultMessage: '{used} / {limit}' },
    { used: tokenText(budget.used_input_tokens), limit: tokenText(budget.input_tokens) },
  );
}

/** The project's resident main agent: who it is, the turns Pantheon and the user started, its budget and wakes. */
export function ResidentCard({
  projectId,
  main,
  sessions,
  resident,
}: {
  projectId: string;
  main: WorkbenchSession;
  sessions: readonly WorkbenchSession[] | null;
  resident: {
    read: ProjectResident | null;
    error: string | null;
    loading: boolean;
    reload: () => void;
  };
}) {
  const now = useNow(60_000);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const read = resident.read;
  const set = async (session_id: string | null) => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    const result = await sendProjectCommand(
      'project.resident.set',
      { project_id: projectId, session_id },
      null,
    );
    setBusy(false);
    if (!result.ok) setFailed(result.error);
    else resident.reload();
  };
  const title = t({ id: 'project.resident.title', defaultMessage: 'Resident' });
  const residentId = read?.session_id ?? null;
  const session = residentId ? sessions?.find((s) => s.id === residentId) : undefined;
  const wakes = read?.wakes ?? [];
  const shown = expanded ? wakes : wakes.slice(0, SHOWN_WAKES);
  return (
    <section className="pj-card" aria-label={title} aria-busy={resident.loading || undefined}>
      <div className="pj-ch">
        <h2 className="pj-h2">{title}</h2>
        {residentId && (
          <button
            type="button"
            className="btn ghost sm pj-end"
            disabled={busy}
            onClick={() => void set(null)}
          >
            {t({ id: 'project.resident.unset', defaultMessage: 'Stop resident' })}
          </button>
        )}
      </div>
      {resident.error && <Failure error={resident.error} onRetry={resident.reload} />}
      {failed && (
        <div className="pj-cerr" role="alert">
          {failed}
        </div>
      )}
      {!read && resident.loading && <Skeleton style={{ height: 9, width: 180 }} />}
      {read && !residentId && (
        <div className="pj-rnone">
          <p className="pj-intro">
            {t({ id: 'project.resident.none', defaultMessage: 'No resident main agent yet' })}
          </p>
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => void set(main.id)}
          >
            {t(
              { id: 'project.resident.set', defaultMessage: 'Make {title} resident' },
              { title: sessionRow(main).title },
            )}
          </button>
        </div>
      )}
      {read && residentId && (
        <>
          <button
            type="button"
            className="pj-ag pj-rwho"
            onClick={() => useShell.getState().openSession(residentId)}
          >
            <span className="pj-at">
              <Clip text={session ? sessionRow(session).title : shortId(residentId)} />
              {read.since !== null && (
                <span className="pj-sub">
                  {t(
                    { id: 'project.resident.since', defaultMessage: 'Since {time}' },
                    { time: dayText(read.since, now, { time: true }) },
                  )}
                </span>
              )}
            </span>
          </button>
          <div className="pj-rk">
            <div className="pj-rkc">
              <span className="cap">
                {t({
                  id: 'project.resident.pantheonTurns',
                  defaultMessage: 'Turns Pantheon started',
                })}
              </span>
              <span className="kpi">{read.turns.pantheon}</span>
            </div>
            <div className="pj-rkc">
              <span className="cap">
                {t({ id: 'project.resident.userTurns', defaultMessage: 'Turns you started' })}
              </span>
              <span className="kpi">{read.turns.user}</span>
            </div>
          </div>
          <div className="pj-rb">
            <span className="cap">
              {t({ id: 'project.resident.budget', defaultMessage: 'Budget' })}
            </span>
            <span className="pj-rbv">{budgetText(read.budget)}</span>
          </div>
          {wakes.length === 0 ? (
            <p className="pj-sub">
              {t({ id: 'project.resident.noWakes', defaultMessage: 'Not woken yet' })}
            </p>
          ) : (
            <ul
              className="pj-rws"
              aria-label={t({ id: 'project.resident.wakes', defaultMessage: 'Recent wakes' })}
            >
              {shown.map((wake, i) => (
                <li key={`${wake.at} ${i}`} className="pj-rw">
                  <span className="pj-dl">{ageText(wake.at, now)}</span>
                  <span className="pj-rws-st">{wakeText(wake)}</span>
                  {wake.kind === 'woken' && wake.preview && (
                    <Clip text={wake.preview} className="pj-sub" />
                  )}
                </li>
              ))}
            </ul>
          )}
          {wakes.length > SHOWN_WAKES && (
            <button
              type="button"
              className="btn ghost sm pj-rmore"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded
                ? t({ id: 'project.resident.fewer', defaultMessage: 'Fewer' })
                : t({ id: 'project.resident.more', defaultMessage: 'More' })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
