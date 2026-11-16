import { useState, type ReactElement } from 'react';
import type { GithubReviewDecision, WorkbenchSession } from '@pantheon/protocol';
import { ArrowUpRight, Check, CircleDot, GitPullRequest, Minus, User, X } from 'lucide-react';
import { SessionStateIcon } from '../../../components/SessionStateIcon';
import { toast } from '../../../components/Toast';
import { useBoard } from '../../../data/board';
import { runCommand } from '../../../data/commands';
import { failureText } from '../../../data/needs-you';
import { useGithubPullDetail, type GithubPullDetail } from '../../../data/repo';
import { elapsedText } from '../../../data/transcript';
import { t } from '../../../i18n';
import { listText } from '../../../lib/list-text';
import { Failure, Skeleton } from '../../board/BoardScreen';
import { fail } from '../../sessions/shared';
import { sessionName } from '../history/CommitGraph';

type Check = GithubPullDetail['checks'][number];
type Thread = GithubPullDetail['threads'][number];

const REVIEW_TONE: Record<GithubReviewDecision, string> = {
  approved: 'ok',
  changes_requested: 'wait',
  review_required: 'idle',
};

function reviewText(decision: GithubReviewDecision): string {
  if (decision === 'approved')
    return t({ id: 'repo.pulls.review.approved', defaultMessage: 'Approved' });
  if (decision === 'changes_requested')
    return t({ id: 'repo.pulls.review.changesRequested', defaultMessage: 'Changes requested' });
  return t({ id: 'repo.pulls.review.required', defaultMessage: 'Review required' });
}

/** The review decision as a status chip. */
export const reviewChip = (decision: GithubReviewDecision) => (
  <span className="chip rpr-chip" data-tone={REVIEW_TONE[decision]}>
    {reviewText(decision)}
  </span>
);

const CHECK_ORDER: Check['state'][] = ['failed', 'running', 'passed', 'skipped'];

const CHECK_ICON: Record<Check['state'], ReactElement> = {
  failed: <X aria-hidden="true" />,
  running: <CircleDot aria-hidden="true" />,
  passed: <Check aria-hidden="true" />,
  skipped: <Minus aria-hidden="true" />,
};

function checkText(state: Check['state']): string {
  if (state === 'failed') return t({ id: 'repo.pulls.check.failed', defaultMessage: 'Failed' });
  if (state === 'running') return t({ id: 'repo.pulls.check.running', defaultMessage: 'Running' });
  if (state === 'passed') return t({ id: 'repo.pulls.check.passed', defaultMessage: 'Passed' });
  return t({ id: 'repo.pulls.check.skipped', defaultMessage: 'Skipped' });
}

function checkCountText(state: Check['state'], count: number): string {
  if (state === 'failed')
    return t({ id: 'repo.pulls.checkCount.failed', defaultMessage: '{count} failed' }, { count });
  if (state === 'running')
    return t({ id: 'repo.pulls.checkCount.running', defaultMessage: '{count} running' }, { count });
  if (state === 'passed')
    return t({ id: 'repo.pulls.checkCount.passed', defaultMessage: '{count} passed' }, { count });
  return t({ id: 'repo.pulls.checkCount.skipped', defaultMessage: '{count} skipped' }, { count });
}

/** Failed checks first, then running, passed and skipped; GitHub's order within each. */
export const orderedChecks = (checks: readonly Check[]) =>
  CHECK_ORDER.flatMap((state) => checks.filter((c) => c.state === state));

const where = (thread: Thread) =>
  thread.line === null ? thread.path : `${thread.path}:${thread.line}`;

// Prompts stay in English whatever the interface language is.
export const reviewPrompt = (pull: GithubPullDetail, threads: readonly Thread[]) =>
  [
    `Address these unresolved review comments on pull request #${pull.number} (${pull.head} into ${pull.base}):`,
    ...threads.map(
      (thread) =>
        `- ${where(thread)} (${thread.author}):\n${thread.body
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')}`,
    ),
  ].join('\n');

const openLink = (url: string) => void window.pantheon?.openLink(url).catch(fail);

function ThreadCard({ thread }: { thread: Thread }) {
  return (
    <li className="rpr-rv">
      <div className="rpr-rvh">
        <User className="ic-sm rpr-mu" aria-hidden="true" />
        <span className="rpr-b">{thread.author}</span>
        <span className="mono rpr-mu rpr-cut rpr-end">{where(thread)}</span>
      </div>
      <p className="rpr-body">{thread.body}</p>
    </li>
  );
}

/** One pull request: its facts, its checks, its review comments, and handing them to its session. */
export function PullDetail({
  projectId,
  number,
  sessions,
  onOpenSession,
}: {
  projectId: string;
  number: number;
  sessions: readonly WorkbenchSession[];
  onOpenSession: (sessionId: string) => void;
}) {
  const detail = useGithubPullDetail(projectId, number);
  const [sending, setSending] = useState(false);
  const label = t(
    { id: 'repo.pulls.detail', defaultMessage: 'Pull request #{number}' },
    { number },
  );
  const pull = detail.read?.number === number ? detail.read : null;
  if (!pull)
    return (
      <section className="rpr-side" aria-label={label}>
        {detail.error ? <Failure error={detail.error} onRetry={detail.reload} /> : <Skeleton />}
      </section>
    );

  const session = pull.session_id ? sessions.find((s) => s.id === pull.session_id) : undefined;
  const checks = orderedChecks(pull.checks);
  const open = pull.threads.filter((thread) => !thread.resolved);
  const resolved = pull.threads.filter((thread) => thread.resolved);
  const count = (state: Check['state']) => pull.checks.filter((c) => c.state === state).length;

  const handOff = async (to: WorkbenchSession) => {
    setSending(true);
    const revision =
      useBoard.getState().board?.sessions.find((s) => s.id === to.id)?.revision ?? null;
    const result = await runCommand(
      'session.send',
      { session_id: to.id, input: reviewPrompt(pull, open) },
      revision,
    );
    setSending(false);
    toast(
      result.ok
        ? {
            title: t(
              {
                id: 'repo.pulls.handedOff',
                defaultMessage:
                  'Sent {count, plural, one {# comment} other {# comments}} to {session}',
              },
              { count: open.length, session: sessionName(to) },
            ),
          }
        : { title: failureText(result.error), kind: 'failure' },
    );
  };

  return (
    <section className="rpr-side" aria-label={label}>
      <div className="rpr-sh">
        <GitPullRequest className="ic-sm" aria-hidden="true" />
        <span className="mono rpr-b">#{pull.number}</span>
        {pull.review_decision && reviewChip(pull.review_decision)}
        <button type="button" className="btn ghost sm rpr-end" onClick={() => openLink(pull.url)}>
          <ArrowUpRight className="ic-sm" aria-hidden="true" />
          {t({ id: 'repo.pulls.openOnGithub', defaultMessage: 'Open on GitHub' })}
        </button>
      </div>
      <div className="rpr-sb">
        <h2 className="rpr-title">{pull.title}</h2>
        <dl className="rpr-kv">
          <dt>{t({ id: 'repo.pulls.branch', defaultMessage: 'Branch' })}</dt>
          <dd className="mono">
            {pull.head} → {pull.base}
          </dd>
          {session && (
            <>
              <dt>{t({ id: 'repo.pulls.session', defaultMessage: 'Session' })}</dt>
              <dd>
                <button
                  type="button"
                  className="rpr-link"
                  onClick={() => onOpenSession(session.id)}
                >
                  <SessionStateIcon session={session} place="card" />
                  <span className="rpr-cut">{sessionName(session)}</span>
                </button>
              </dd>
            </>
          )}
          <dt>{t({ id: 'repo.pulls.changes', defaultMessage: 'Changes' })}</dt>
          <dd className="mono rpr-n">
            <span className="df-add" data-zero={pull.additions === 0 || undefined}>
              +{pull.additions}
            </span>{' '}
            <span className="df-del" data-zero={pull.deletions === 0 || undefined}>
              −{pull.deletions}
            </span>
          </dd>
        </dl>

        {checks.length > 0 && (
          <section className="rpr-grp" aria-labelledby={`pull-${number}-checks`}>
            <div className="rpr-gh">
              <h3 id={`pull-${number}-checks`}>
                {t({ id: 'repo.pulls.checks', defaultMessage: 'Checks' })}
              </h3>
              <span className="rpr-mu rpr-n rpr-end">
                {listText(
                  ...CHECK_ORDER.map((state) =>
                    count(state) > 0 ? checkCountText(state, count(state)) : null,
                  ),
                )}
              </span>
            </div>
            <ul className="rpr-checklist">
              {checks.map((check, i) => (
                <li key={i} className="rpr-check">
                  <span
                    className="rpr-st"
                    data-state={check.state}
                    role="img"
                    aria-label={checkText(check.state)}
                  >
                    {CHECK_ICON[check.state]}
                  </span>
                  <span className="mono rpr-cut" title={check.name}>
                    {check.name}
                  </span>
                  {check.url && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      aria-label={t(
                        { id: 'repo.pulls.checkLogLabel', defaultMessage: 'View log of {name}' },
                        { name: check.name },
                      )}
                      onClick={() => openLink(check.url!)}
                    >
                      {t({ id: 'repo.pulls.checkLog', defaultMessage: 'View log' })}
                    </button>
                  )}
                  <span className="mono rpr-mu rpr-n rpr-took">
                    {check.duration_ms === null ? '' : elapsedText(check.duration_ms)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {pull.threads.length > 0 && (
          <section className="rpr-grp" aria-labelledby={`pull-${number}-reviews`}>
            <div className="rpr-gh">
              <h3 id={`pull-${number}-reviews`}>
                {t({ id: 'repo.pulls.reviews', defaultMessage: 'Review comments' })}
              </h3>
              {open.length > 0 && (
                <span className="rpr-mu rpr-n rpr-end">
                  {t(
                    {
                      id: 'repo.pulls.unresolved',
                      defaultMessage: '{count, plural, other {# unresolved}}',
                    },
                    { count: open.length },
                  )}
                </span>
              )}
            </div>
            {open.length > 0 && (
              <ul className="rpr-threads">
                {open.map((thread, i) => (
                  <ThreadCard key={i} thread={thread} />
                ))}
              </ul>
            )}
            {resolved.length > 0 && (
              <details className="rpr-done">
                <summary>
                  {t(
                    {
                      id: 'repo.pulls.resolved',
                      defaultMessage: '{count, plural, other {# resolved}}',
                    },
                    { count: resolved.length },
                  )}
                </summary>
                <ul className="rpr-threads">
                  {resolved.map((thread, i) => (
                    <ThreadCard key={i} thread={thread} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        {session && open.length > 0 && (
          <button
            type="button"
            className="btn pri rpr-hand"
            disabled={sending}
            aria-busy={sending || undefined}
            onClick={() => void handOff(session)}
          >
            {t(
              {
                id: 'repo.pulls.handOff',
                defaultMessage:
                  'Have {session} address {count, plural, one {# comment} other {# comments}}',
              },
              { session: sessionName(session), count: open.length },
            )}
          </button>
        )}
      </div>
    </section>
  );
}
