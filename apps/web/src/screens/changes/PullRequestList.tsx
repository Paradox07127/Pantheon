import { useState, type ReactNode } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { GitPullRequest } from 'lucide-react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { EmptyState } from '../../components/EmptyState';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { SessionStateIcon } from '../../components/SessionStateIcon';
import { useGithubPulls, type GithubItem } from '../../data/github-pulls';
import { ageText, useNow } from '../../data/needs-you';
import { useConnectionsStatus } from '../../data/runtime-status';
import { t } from '../../i18n';
import { sessionRow } from '../sessions/session-groups';
import { GateSeg } from '../sessions/SessionHeader';
import { PullRequestDetail, reviewChip } from './PullRequestDetail';
import './pull-requests.css';

/**
 * The state every check not passed is in, when the summary allows only one: all skipped when
 * passing, and a lone one is what the summary names; otherwise the split is only in the detail.
 */
function restState(pull: GithubItem, rest: number) {
  if (pull.checks === 'passing') return 'skipped';
  if (rest !== 1) return 'unknown';
  return pull.checks === 'failing' ? 'failed' : 'running';
}

/** The checks of a listed pull request: passed, and the rest in one state when it is known. */
function pullChecks(pull: GithubItem) {
  const total = pull.checks_total ?? 0;
  const passed = pull.checks_passed ?? 0;
  const rest = total - passed;
  const state = restState(pull, rest);
  return (
    <span className="cpr-checks">
      <span
        role="img"
        aria-label={t(
          {
            id: 'changes.pulls.checksLabel',
            defaultMessage:
              '{total, plural, one {# check} other {# checks}}, {passed, plural, other {# passed}}{rest, plural, =0 {} other {, # {state, select, failed {failed} running {running} skipped {skipped} other {not passed}}}}',
          },
          { total, passed, rest, state },
        )}
      >
        <GateSeg
          passed={passed}
          failed={state === 'failed' ? rest : 0}
          running={state === 'running' ? rest : 0}
          skipped={state === 'skipped' ? rest : 0}
          notRun={state === 'unknown' ? rest : 0}
        />
      </span>
      <span className="cpr-n">
        {passed} / {total}
      </span>
    </span>
  );
}

/** The project's open pull requests; the opened one shows beside the list. */
export function PullRequestList({
  projectId,
  sessions,
}: {
  projectId: string | null;
  sessions: readonly WorkbenchSession[] | null;
}) {
  const pulls = useGithubPulls(projectId);
  const github = useConnectionsStatus().read;
  const now = useNow(60_000);
  const [open, setOpen] = useState<number | null>(null);
  const read = pulls.read;
  const opened = read?.items.find((p) => p.number === open) ?? null;

  const panel = (body: ReactNode) => (
    <Tabs.Panel className="chg" value="pulls" data-inspector={opened ? '' : undefined}>
      {body}
    </Tabs.Panel>
  );
  const empty = (title: string) =>
    panel(
      <div className="chg-main">
        <EmptyState inline title={title} />
      </div>,
    );
  if (github.state === 'ready' && github.github.state !== 'signed_in')
    return empty(
      t({ id: 'changes.pulls.notConnected', defaultMessage: 'GitHub is not connected' }),
    );
  if (!read)
    return panel(
      <div className="chg-main">
        {pulls.error ? <Failure error={pulls.error} onRetry={pulls.reload} /> : <Skeleton />}
      </div>,
    );
  if (read.repo === null)
    return empty(
      t({ id: 'changes.pulls.noRepo', defaultMessage: 'This project has no GitHub repository' }),
    );
  if (read.items.length === 0)
    return empty(t({ id: 'changes.pulls.empty', defaultMessage: 'No pull requests yet' }));

  const sessionOf = (id: string | undefined) =>
    id === undefined ? undefined : sessions?.find((s) => s.id === id);
  return panel(
    <>
      <div className="chg-main">
        <ul
          className="cpr-list"
          aria-label={t({ id: 'changes.pulls.list', defaultMessage: 'Open pull requests' })}
        >
          {read.items.map((pull) => {
            const session = sessionOf(pull.session_id);
            const updated = Date.parse(pull.updated_at);
            return (
              <li key={pull.number}>
                <button
                  type="button"
                  className="cpr-row"
                  aria-pressed={pull.number === open}
                  onClick={() => setOpen(pull.number)}
                >
                  <GitPullRequest className="ic-sm cpr-mu" aria-hidden="true" />
                  <span className="cpr-head">
                    <span className="mono cpr-mu">#{pull.number}</span>
                    <Clip text={pull.title} className="cpr-b" />
                  </span>
                  {pull.checks_total ? pullChecks(pull) : <span />}
                  <span className="cpr-meta">
                    {session && (
                      <span className="cpr-ses">
                        <SessionStateIcon session={session} place="list" />
                        <Clip text={sessionRow(session).title} />
                      </span>
                    )}
                    {pull.head && <Clip text={pull.head} className="mono" />}
                    <span className="cpr-end">
                      {pull.review_decision && reviewChip(pull.review_decision)}
                      {Number.isFinite(updated) && (
                        <time dateTime={pull.updated_at}>{ageText(updated, now)}</time>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {opened && (
        <PullRequestDetail
          key={opened.number}
          projectId={projectId}
          number={opened.number}
          sessions={sessions}
          onClose={() => setOpen(null)}
        />
      )}
    </>,
  );
}
