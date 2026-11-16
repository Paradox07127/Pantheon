import type { Review } from '@pantheon/domain';
import { t } from '../i18n';
import { runtimeName } from './RuntimeGlyph';
import './review-coverage.css';

// Getters, so each state is read in the language loaded by then.
const STATES = {
  get queued() {
    return t({ id: 'components.reviewCoverage.queued', defaultMessage: 'Queued' });
  },
  get running() {
    return t({ id: 'components.reviewCoverage.running', defaultMessage: 'Reviewing' });
  },
  get completed() {
    return t({ id: 'components.reviewCoverage.completed', defaultMessage: 'Done' });
  },
  get failed() {
    return t({ id: 'components.reviewCoverage.failed', defaultMessage: 'Failed' });
  },
  get cancelled() {
    return t({ id: 'components.reviewCoverage.cancelled', defaultMessage: 'Cancelled' });
  },
  get unknown() {
    return t({ id: 'components.reviewCoverage.unknown', defaultMessage: 'State unknown' });
  },
};

export function reviewCoverage(review: Pick<Review, 'state' | 'executions'>) {
  const executions = review.executions ?? [];
  const completed = executions.filter((item) => item.state === 'completed').length;
  const failed = executions.filter(
    (item) => item.state === 'failed' || item.state === 'cancelled',
  ).length;
  const unknown = executions.filter((item) => item.state === 'unknown').length;
  const label = failed
    ? completed
      ? t({ id: 'components.reviewCoverage.partlyFailed', defaultMessage: 'Review partly failed' })
      : t({ id: 'components.reviewCoverage.reviewFailed', defaultMessage: 'Review failed' })
    : review.state === 'failed'
      ? t({ id: 'components.reviewCoverage.reviewFailed', defaultMessage: 'Review failed' })
      : unknown
        ? t({
            id: 'components.reviewCoverage.incomplete',
            defaultMessage: 'Review coverage incomplete',
          })
        : review.state === 'running'
          ? t({ id: 'components.reviewCoverage.reviewing', defaultMessage: 'Reviewing' })
          : t({ id: 'components.reviewCoverage.ended', defaultMessage: 'Review ended' });
  return { completed, failed, unknown, total: executions.length, label };
}

/** Aggregate settlement and individual reviewer coverage are separate facts. */
export function ReviewCoverage({
  review,
  compact = false,
}: {
  review: Pick<Review, 'id' | 'state' | 'executions' | 'range'>;
  compact?: boolean;
}) {
  const coverage = reviewCoverage(review);
  return (
    <div
      className="review-coverage"
      aria-label={t({ id: 'components.reviewCoverage.label', defaultMessage: 'Review results' })}
    >
      <p role="status">
        <span>{coverage.label}</span>
        {coverage.total > 0 && (
          <span>
            {t(
              {
                id: 'components.reviewCoverage.count',
                defaultMessage: '{completed} of {total} done',
              },
              { completed: coverage.completed, total: coverage.total },
            )}
          </span>
        )}
      </p>
      {!review.executions?.length && (
        <p>
          {t({
            id: 'components.reviewCoverage.noExecutions',
            defaultMessage: 'No reviewer details recorded',
          })}
        </p>
      )}
      {!compact && !!review.executions?.length && (
        <ul>
          {review.executions.map((execution) => (
            <li key={execution.runtime}>
              <span>{runtimeName(execution.runtime)}</span>
              <span>{STATES[execution.state]}</span>
              {execution.error && <span className="review-execution-error">{execution.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {(coverage.failed > 0 || coverage.unknown > 0) && (
        <p>
          {t({
            id: 'components.reviewCoverage.unfinishedNote',
            defaultMessage: "A review that didn't finish doesn't mean there are no problems",
          })}
        </p>
      )}
      {review.range && (
        <p className="mono" title={`${review.range.from_sha}..${review.range.to_sha}`}>
          {t(
            { id: 'components.reviewCoverage.range', defaultMessage: 'Reviewed {from}…{to}' },
            { from: review.range.from_sha.slice(0, 8), to: review.range.to_sha.slice(0, 8) },
          )}
        </p>
      )}
    </div>
  );
}
