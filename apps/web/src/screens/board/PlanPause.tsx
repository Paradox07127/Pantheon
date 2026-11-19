import { useState, type ReactNode } from 'react';
import { Pause, Play } from 'lucide-react';
import { RunningFor } from '../../components/RunningFor';
import { usePlanPause } from '../../data/plan-pause';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import type { RunBoardCommand } from './panels-model';

/**
 * The bar's Pause or Resume of the lead's plan, then the plan's version: `children` while it runs,
 * when it was paused while it is paused. Without `run` the board is read only and shows no button.
 */
export function PlanPause({
  projectId,
  leadId,
  version,
  now,
  run,
  stale,
  children,
}: {
  projectId: string | null;
  leadId: string;
  version: number;
  now: number;
  run?: RunBoardCommand;
  stale?: boolean;
  children: ReactNode;
}) {
  const { paused, reassessment } = usePlanPause(projectId, leadId);
  // The state the user asked for; the button stays busy until the read shows it.
  const [wanted, setWanted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (wanted !== null && wanted === !!paused) setWanted(null);
  const busy = wanted !== null && wanted !== !!paused;
  const toggle = async () => {
    if (busy || stale || !run || !projectId) return;
    const pausing = !paused;
    setWanted(pausing);
    setError(null);
    const failure = await run(
      pausing ? 'board.plan.pause' : 'board.plan.resume',
      { project_id: projectId, lead_session_id: leadId },
      null,
    );
    if (!failure) return;
    setWanted(null);
    setError(
      pausing
        ? t(
            { id: 'board.bar.pauseFailed', defaultMessage: "Couldn't pause: {error}" },
            { error: failure },
          )
        : t(
            { id: 'board.bar.resumeFailed', defaultMessage: "Couldn't resume: {error}" },
            { error: failure },
          ),
    );
  };
  const label = paused
    ? t({ id: 'board.bar.resumePlan', defaultMessage: 'Resume plan' })
    : t({ id: 'board.bar.pausePlan', defaultMessage: 'Pause plan' });
  return (
    <>
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
      {paused && (!reassessment || reassessment.at < paused.at) && (
        <RunningFor
          label={t({ id: 'board.bar.reassessing', defaultMessage: 'Lead is reassessing' })}
          since={paused.at}
        />
      )}
      {run && projectId && (
        <button
          type="button"
          className="btn"
          aria-label={label}
          title={label}
          aria-disabled={busy || stale || undefined}
          aria-busy={busy || undefined}
          onClick={() => void toggle()}
        >
          {paused ? (
            <Play className="ic-sm" aria-hidden="true" />
          ) : (
            <Pause className="ic-sm" aria-hidden="true" />
          )}
          <span className="tb-lbl">
            {paused
              ? t({ id: 'board.bar.resume', defaultMessage: 'Resume' })
              : t({ id: 'board.bar.pause', defaultMessage: 'Pause' })}
          </span>
        </button>
      )}
      {paused ? (
        <span className="gm-pv">
          {t(
            { id: 'board.bar.planPaused', defaultMessage: 'Plan v{version}, paused {time}' },
            { version, time: dayText(paused.at, now, { time: true }) },
          )}
        </span>
      ) : (
        children
      )}
    </>
  );
}
