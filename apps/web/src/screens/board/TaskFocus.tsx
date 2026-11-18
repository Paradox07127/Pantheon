import type { BoardModel } from '@pantheon/protocol';
import { ReviewCoverage } from '../../components/ReviewCoverage';
import { currentLocale, t } from '../../i18n';
import { blockerTexts } from '../../lib/daemon-text';
import { StatusBadge } from './status';
import { taskFocus } from './task-focus';
import './task-focus.css';

export type EvidenceTab = 'checks' | 'review' | 'story';
const GATE = {
  get passed() {
    return t({ id: 'board.task.focus.gatePassed', defaultMessage: 'Gates passed' });
  },
  get failed() {
    return t({ id: 'board.task.focus.gateFailed', defaultMessage: 'Gates failed' });
  },
  get running() {
    return t({ id: 'board.task.focus.gateRunning', defaultMessage: 'Gates running' });
  },
  get cancelling() {
    return t({ id: 'board.task.focus.gateCancelling', defaultMessage: 'Cancelling gates' });
  },
  get cancelled() {
    return t({ id: 'board.task.focus.gateCancelled', defaultMessage: 'Gates cancelled' });
  },
  get stale() {
    return t({ id: 'board.task.focus.gateStale', defaultMessage: 'Gates out of date' });
  },
};

export function TaskFocus({
  model,
  onSelect,
  onOpenSession,
  onOpenEvidence,
  onStartTask,
}: {
  model: BoardModel;
  onSelect: (id: string | null) => void;
  onOpenSession: (id: string) => void;
  onOpenEvidence?: (id: string, tab: EvidenceTab) => void;
  onStartTask?: (task: BoardModel['tasks'][number]) => void;
}) {
  const focus = taskFocus(model);
  if (!focus) return null;
  const { task, upstream, sessionId, reason, next } = focus;
  const gate = task.evidence?.gate;
  const review = task.evidence?.review;
  const merge = sessionId && model.merges.find((merge) => merge.session_id === sessionId);
  const open = (tab: EvidenceTab) =>
    sessionId && (onOpenEvidence ? onOpenEvidence(sessionId, tab) : onOpenSession(sessionId));
  const action = upstream[0]
    ? 'upstream'
    : !sessionId && task.status === 'todo' && task.activity?.phase !== 'queued' && onStartTask
      ? 'start'
      : (sessionId || task.owner_session_id) && 'session';
  // The status's own next step goes unsaid when the button says it.
  const restated = action === 'start' || (action === 'session' && task.status === 'waiting');
  const diff = !!merge || task.additions != null || task.deletions != null;
  return (
    <section
      className="bd-focus"
      aria-label={t({ id: 'board.task.focus.label', defaultMessage: 'Current task' })}
    >
      <div className="bd-focus-h">
        <button type="button" className="bd-lnk" onClick={() => onSelect(task.id)}>
          {task.title}
        </button>
        <StatusBadge status={task.status} />
      </div>
      <dl>
        <div>
          <dt>{t({ id: 'board.task.focus.reason', defaultMessage: "What's blocking it" })}</dt>
          <dd>{reason}</dd>
          {blockerTexts(task)
            .filter((blocker) => blocker !== reason)
            .map((blocker) => (
              <dd key={blocker}>{blocker}</dd>
            ))}
        </div>
        <div>
          <dt>{t({ id: 'board.task.focus.next', defaultMessage: 'Next step' })}</dt>
          {!restated && <dd>{next}</dd>}
          <dd className="bd-focus-actions">
            {action === 'upstream' ? (
              <button type="button" className="btn" onClick={() => onSelect(upstream[0]!.id)}>
                {t({ id: 'board.task.focus.openUpstream', defaultMessage: 'Handle dependency' })}
              </button>
            ) : action === 'start' ? (
              <button type="button" className="btn" onClick={() => onStartTask!(task)}>
                {t({ id: 'board.task.focus.nextStart', defaultMessage: 'Start the task' })}
              </button>
            ) : (
              action === 'session' && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    task.status === 'ready' && sessionId
                      ? open('checks')
                      : onOpenSession(sessionId ?? task.owner_session_id!)
                  }
                >
                  {t({ id: 'board.task.focus.openSession', defaultMessage: 'Handle in session' })}
                </button>
              )
            )}
          </dd>
        </div>
        <div>
          <dt>{t({ id: 'board.task.focus.evidence', defaultMessage: 'Evidence' })}</dt>
          <dd>
            <p>
              {gate
                ? GATE[gate.state]
                : task.checks === 'running'
                  ? GATE.running
                  : task.checks === 'fail'
                    ? GATE.failed
                    : task.checks === 'pass'
                      ? t({
                          id: 'board.task.focus.gateSummaryPassed',
                          defaultMessage: 'Gate summary passed',
                        })
                      : t({ id: 'board.task.focus.noGate', defaultMessage: 'No gate results yet' })}
            </p>
            {gate?.finished_at && (
              <time dateTime={gate.finished_at}>
                {t(
                  { id: 'board.task.focus.checkedAt', defaultMessage: 'Checked {time}' },
                  {
                    time: new Date(gate.finished_at).toLocaleString(currentLocale(), {
                      hour12: false,
                    }),
                  },
                )}
              </time>
            )}
            {review ? (
              <ReviewCoverage review={review} compact />
            ) : (
              <p>
                {t({ id: 'board.task.focus.noReview', defaultMessage: 'No review results yet' })}
              </p>
            )}
            {merge && (
              <p className="mono" title={merge.sha}>
                {t(
                  { id: 'board.task.focus.mergedSha', defaultMessage: 'Merged {sha}' },
                  { sha: merge.sha.slice(0, 8) },
                )}
              </p>
            )}
            {sessionId && (gate || task.checks !== 'none' || review || diff) && (
              <div className="bd-focus-actions">
                {(gate || task.checks !== 'none') && (
                  <button type="button" className="bd-lnk" onClick={() => open('checks')}>
                    {t({ id: 'board.task.focus.viewGates', defaultMessage: 'View gates' })}
                  </button>
                )}
                {review && (
                  <button type="button" className="bd-lnk" onClick={() => open('review')}>
                    {t({ id: 'board.task.focus.viewReview', defaultMessage: 'View review' })}
                  </button>
                )}
                {diff && (
                  <button type="button" className="bd-lnk" onClick={() => open('story')}>
                    {t({
                      id: 'board.task.focus.viewStory',
                      defaultMessage: 'View change evidence',
                    })}
                  </button>
                )}
              </div>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
