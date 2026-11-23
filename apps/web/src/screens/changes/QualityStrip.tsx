import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { useGateHistory, useReviewMetrics } from '../../data/quality';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { GateTracker } from '../sessions/GateTracker';
import { gateQuality, reviewMatrix } from './quality-model';
import './quality-strip.css';

const percent = (share: number | null) => (share === null ? '—' : `${Math.round(share * 100)}%`);

/**
 * The project's gate and review quality above the changes: the first-pass rate, the flaky steps,
 * the gate history and each reviewer's adoption rate.
 */
export function QualityStrip({
  projectId,
  onOpenLanding,
  landingIds,
}: {
  projectId: string | null;
  /** Opens the change of a branch landing whose gate run was chosen. */
  onOpenLanding: (landingId: string) => void;
  /** Landings the changes list still shows; older ones have no row to open. */
  landingIds: ReadonlySet<string>;
}) {
  const history = useGateHistory(projectId);
  const metrics = useReviewMetrics(projectId);
  const openSession = useShell((s) => s.openSession);
  const runs = history.read?.runs ?? null;
  const quality = runs && gateQuality(runs);
  const matrix = metrics.read && reviewMatrix(metrics.read);
  const firstPass = quality?.firstPass;
  const firstPassName = t({
    id: 'changes.quality.firstPass',
    defaultMessage: 'Gates passed first time',
  });
  const flakyName = t({ id: 'changes.quality.flaky', defaultMessage: 'Flaky steps' });
  const historyName = t({ id: 'changes.quality.history', defaultMessage: 'Gate history' });
  const adoptionName = t({
    id: 'changes.quality.adoption',
    defaultMessage: 'Adoption by reviewer',
  });
  return (
    <section
      className="cq"
      aria-label={t({ id: 'changes.quality.label', defaultMessage: 'Quality' })}
      aria-busy={history.loading || metrics.loading || undefined}
    >
      <div className="cq-part" role="group" aria-label={firstPassName}>
        <span className="cq-k">{firstPassName}</span>
        <span className="cq-v">
          <b>{percent(firstPass?.total ? firstPass.passed / firstPass.total : null)}</b>
          {firstPass && firstPass.total > 0 && (
            <span className="cq-n">
              {t(
                {
                  id: 'changes.quality.firstPassCount',
                  defaultMessage: '{passed} of {total}',
                },
                { passed: firstPass.passed, total: firstPass.total },
              )}
            </span>
          )}
        </span>
      </div>
      <div className="cq-part" role="group" aria-label={flakyName}>
        <span className="cq-k">{flakyName}</span>
        <span className="cq-v">
          <b>{quality ? quality.flaky.length : '—'}</b>
          {quality && quality.flaky.length > 0 && (
            <ul className="cq-flaky">
              {quality.flaky.map((step) => (
                <li key={step.key} className="chip mono">
                  {step.name}
                </li>
              ))}
            </ul>
          )}
        </span>
      </div>
      {runs && runs.length > 0 && (
        <div className="cq-part cq-hist" role="group" aria-label={historyName}>
          <span className="cq-k">{historyName}</span>
          <GateTracker
            runs={runs}
            openable={(column) => !column.landing_id || landingIds.has(column.landing_id)}
            onRun={(column) => {
              if (column.landing_id) onOpenLanding(column.landing_id);
              else if (column.session_id) openSession(column.session_id, 'checks', column.run_id);
            }}
          />
        </div>
      )}
      <div className="cq-part" role="group" aria-label={adoptionName}>
        <span className="cq-k">{adoptionName}</span>
        {matrix && matrix.length > 0 ? (
          <ul className="cq-rev">
            {matrix.map((row) => {
              const name = runtimeName(row.runtime);
              return (
                <li key={row.runtime} className="cq-rr">
                  <span className="cq-glyph" role="img" aria-label={name}>
                    <RuntimeGlyph runtime={row.runtime} />
                  </span>
                  <span
                    className="cq-bar"
                    role="img"
                    aria-label={t(
                      {
                        id: 'changes.quality.outcomes',
                        defaultMessage:
                          '{runtime}: {findings, plural, one {# finding} other {# findings}}, {adopted} adopted, {dismissed} dismissed, {unresolved} unresolved, {invalid} invalid',
                      },
                      {
                        runtime: name,
                        findings: row.findings,
                        ...Object.fromEntries(row.cells.map((c) => [c.key, c.count])),
                      },
                    )}
                  >
                    {row.cells.map((c) => (
                      <i
                        key={c.key}
                        style={{ width: `${c.share * 100}%`, backgroundColor: c.color }}
                      />
                    ))}
                  </span>
                  <b>{percent(row.adoption)}</b>
                </li>
              );
            })}
          </ul>
        ) : (
          <span className="cq-v">
            <b>—</b>
          </span>
        )}
      </div>
    </section>
  );
}
