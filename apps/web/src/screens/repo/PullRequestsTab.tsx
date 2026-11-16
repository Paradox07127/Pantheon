import { useState } from 'react';
import { GitPullRequest } from 'lucide-react';
import { SessionStateIcon } from '../../components/SessionStateIcon';
import { ageText, useNow } from '../../data/needs-you';
import { useGithubPulls, type GithubItems } from '../../data/repo';
import { useConnectionsStatus } from '../../data/runtime-status';
import { useSessionList } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { Empty } from '../board/Charts';
import { Failure, Skeleton } from '../board/BoardScreen';
import { GateSeg } from '../sessions/SessionHeader';
import { sessionName } from './history/CommitGraph';
import { PullDetail, reviewChip } from './pulls/PullDetail';
import './pulls/pulls.css';

type Pull = GithubItems['items'][number];

/** The checks of a listed pull request; the summary tells what the ones not passed are doing. */
function pullChecks(pull: Pull) {
  const total = pull.checks_total ?? 0;
  const passed = pull.checks_passed ?? 0;
  const rest = total - passed;
  return (
    <span className="rpr-checks">
      <span
        role="img"
        aria-label={t(
          {
            id: 'repo.pulls.checksLabel',
            defaultMessage:
              '{total, plural, one {# check} other {# checks}}, {passed, plural, other {# passed}}',
          },
          { total, passed },
        )}
      >
        <GateSeg
          passed={passed}
          failed={pull.checks === 'failing' ? rest : 0}
          running={pull.checks === 'pending' ? rest : 0}
          skipped={pull.checks === 'passing' ? rest : 0}
        />
      </span>
      <span className="rpr-n">
        {passed} / {total}
      </span>
    </span>
  );
}

export function PullRequestsTab({
  projectId,
  onOpenSession,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const pulls = useGithubPulls(projectId);
  const github = useConnectionsStatus().read;
  const sessions = useSessionList(projectId).data ?? [];
  const now = useNow(60_000);
  const [picked, setPicked] = useState<number | null>(null);

  const empty = (text: string) => (
    <div className="bd-s12">
      <Empty text={text} />
    </div>
  );
  if (github.state === 'ready' && github.github.state !== 'signed_in')
    return empty(t({ id: 'repo.pulls.notConnected', defaultMessage: 'GitHub is not connected' }));
  const read = pulls.read;
  if (!read)
    return (
      <div className="bd-s12">
        {pulls.error ? <Failure error={pulls.error} onRetry={pulls.reload} /> : <Skeleton />}
      </div>
    );
  if (read.repo === null)
    return empty(
      t({ id: 'repo.pulls.noRepo', defaultMessage: 'This project has no GitHub repository' }),
    );
  if (read.items.length === 0)
    return empty(t({ id: 'repo.pulls.empty', defaultMessage: 'No pull requests yet' }));

  const shown = read.items.find((p) => p.number === picked) ?? read.items[0]!;
  const sessionOf = (id: string | undefined) =>
    id === undefined ? undefined : sessions.find((s) => s.id === id);
  return (
    <div className="bd-s12 rpr">
      <ul
        className="rpr-list"
        aria-label={t({ id: 'repo.pulls.list', defaultMessage: 'Open pull requests' })}
      >
        {read.items.map((pull) => {
          const session = sessionOf(pull.session_id);
          const updated = Date.parse(pull.updated_at);
          return (
            <li key={pull.number}>
              <button
                type="button"
                className="rpr-row"
                aria-pressed={pull.number === shown.number}
                onClick={() => setPicked(pull.number)}
              >
                <GitPullRequest className="ic-sm rpr-mu" aria-hidden="true" />
                <span className="rpr-head">
                  <span className="mono rpr-mu">#{pull.number}</span>
                  <span className="rpr-cut rpr-b">{pull.title}</span>
                </span>
                {pull.checks_total ? pullChecks(pull) : <span />}
                <span className="rpr-meta">
                  {session && (
                    <span className="rpr-ses">
                      <SessionStateIcon session={session} place="list" />
                      <span className="rpr-cut">{sessionName(session)}</span>
                    </span>
                  )}
                  {pull.head && <span className="mono rpr-cut">{pull.head}</span>}
                  <span className="rpr-end">
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
      <PullDetail
        key={shown.number}
        projectId={projectId}
        number={shown.number}
        sessions={sessions}
        onOpenSession={onOpenSession}
      />
    </div>
  );
}
