import { useState, type ReactElement } from 'react';
import type { GithubReviewDecision, WorkbenchSession } from '@pantheon/protocol';
import { ArrowUpRight, Check, CircleDot, GitPullRequest, Minus, User, X } from 'lucide-react';
import { Clip } from '../../components/Clip';
import { DiffCounts } from '../../components/DiffCounts';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { SessionStateIcon } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { useGithubPullDetail, type GithubPullDetail } from '../../data/github-pulls';
import { failureText } from '../../data/needs-you';
import { elapsedText } from '../../data/transcript';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { useShell } from '../../store';
import { sessionRow } from '../sessions/session-groups';
import { fail } from '../sessions/shared';
import { tellState } from './tell-model';

type Check = GithubPullDetail['checks'][number];
type Thread = GithubPullDetail['threads'][number];

const REVIEW_TONE: Record<GithubReviewDecision, string | undefined> = {
  approved: 'ok',
  changes_requested: 'wait',
  review_required: undefined,
};

function reviewText(decision: GithubReviewDecision): string {
  if (decision === 'approved')
    return t({ id: 'changes.pulls.review.approved', defaultMessage: 'Approved' });
  if (decision === 'changes_requested')
    return t({ id: 'changes.pulls.review.changesRequested', defaultMessage: 'Changes requested' });
  return t({ id: 'changes.pulls.review.required', defaultMessage: 'Review required' });
}

/** The review decision as a status chip. */
export const reviewChip = (decision: GithubReviewDecision) => (
  <span className="chip chg-chip" data-tone={REVIEW_TONE[decision]}>
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
  if (state === 'failed') return t({ id: 'changes.pulls.check.failed', defaultMessage: 'Failed' });
  if (state === 'running')
    return t({ id: 'changes.pulls.check.running', defaultMessage: 'Running' });
  if (state === 'passed') return t({ id: 'changes.pulls.check.passed', defaultMessage: 'Passed' });
  return t({ id: 'changes.pulls.check.skipped', defaultMessage: 'Skipped' });
}

function checkCountText(state: Check['state'], count: number): string {
  if (state === 'failed')
    return t(
      { id: 'changes.pulls.checkCount.failed', defaultMessage: '{count} failed' },
      { count },
    );
  if (state === 'running')
    return t(
      { id: 'changes.pulls.checkCount.running', defaultMessage: '{count} running' },
      { count },
    );
  if (state === 'passed')
    return t(
      { id: 'changes.pulls.checkCount.passed', defaultMessage: '{count} passed' },
      { count },
    );
  return t(
    { id: 'changes.pulls.checkCount.skipped', defaultMessage: '{count} skipped' },
    { count },
  );
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
    <li className="cpr-rv">
      <div className="cpr-rvh">
        <User className="ic-sm cpr-mu" aria-hidden="true" />
        <span className="cpr-b">{thread.author}</span>
        <Clip text={where(thread)} className="mono cpr-mu cpr-where" />
      </div>
      <p className="cpr-body">{thread.body}</p>
    </li>
  );
}

/** One pull request beside the list: its facts, checks and review comments, and handing them to its session. */
export function PullRequestDetail({
  projectId,
  number,
  sessions,
  onClose,
}: {
  projectId: string | null;
  number: number;
  sessions: readonly WorkbenchSession[] | null;
  onClose: () => void;
}) {
  const detail = useGithubPullDetail(projectId, number);
  const pull = detail.read?.number === number ? detail.read : null;
  const target = useBoard((s) =>
    pull?.session_id ? s.board?.sessions.find((x) => x.id === pull.session_id) : undefined,
  );
  const [sending, setSending] = useState(false);
  const label = t(
    { id: 'changes.pulls.detail', defaultMessage: 'Pull request #{number}' },
    { number },
  );
  const head = (
    <div className="chg-insp-h">
      <GitPullRequest className="ic-sm" aria-hidden="true" />
      <h2>
        <Clip text={pull ? `#${number} ${pull.title}` : `#${number}`} />
      </h2>
      <button
        type="button"
        className="ib"
        aria-label={t({ id: 'changes.inspector.close', defaultMessage: 'Close' })}
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
  if (!pull)
    return (
      <aside className="chg-insp" aria-label={label}>
        {head}
        <div className="chg-insp-b">
          {detail.error ? <Failure error={detail.error} onRetry={detail.reload} /> : <Skeleton />}
        </div>
      </aside>
    );

  const session = pull.session_id ? sessions?.find((s) => s.id === pull.session_id) : undefined;
  const checks = orderedChecks(pull.checks);
  const open = pull.threads.filter((thread) => !thread.resolved);
  const resolved = pull.threads.filter((thread) => thread.resolved);
  const count = (state: Check['state']) => pull.checks.filter((c) => c.state === state).length;
  const state = tellState(target);

  const handOff = async (to: WorkbenchSession) => {
    if (sending || !target || !state.enabled) return;
    setSending(true);
    const result = await runCommand(
      state.type,
      { session_id: to.id, input: reviewPrompt(pull, open) },
      target.revision,
    );
    setSending(false);
    toast(
      result.ok
        ? {
            title: t(
              {
                id: 'changes.pulls.handedOff',
                defaultMessage:
                  'Sent {count, plural, one {# comment} other {# comments}} to {session}',
              },
              { count: open.length, session: sessionRow(to).title },
            ),
          }
        : { title: failureText(result.error), kind: 'failure' },
    );
  };
  const handButton = session && (
    <button
      type="button"
      className="btn pri"
      disabled={sending}
      aria-busy={sending || undefined}
      aria-disabled={!state.enabled || undefined}
      onClick={() => void handOff(session)}
    >
      {t(
        {
          id: 'changes.pulls.handOff',
          defaultMessage:
            'Have {session} address {count, plural, one {# comment} other {# comments}}',
        },
        { session: sessionRow(session).title, count: open.length },
      )}
    </button>
  );

  return (
    <aside className="chg-insp" aria-label={label}>
      {head}
      <div className="chg-insp-b">
        {pull.review_decision && <div className="chg-h">{reviewChip(pull.review_decision)}</div>}
        <dl className="cpr-kv">
          <dt>{t({ id: 'changes.pulls.branch', defaultMessage: 'Branch' })}</dt>
          <dd className="mono">
            {pull.head} → {pull.base}
          </dd>
          {session && (
            <>
              <dt>{t({ id: 'changes.pulls.session', defaultMessage: 'Session' })}</dt>
              <dd>
                <button
                  type="button"
                  className="cpr-link"
                  onClick={() => useShell.getState().openSession(session.id)}
                >
                  <SessionStateIcon session={session} place="card" />
                  <Clip text={sessionRow(session).title} />
                </button>
              </dd>
            </>
          )}
          <dt>{t({ id: 'changes.pulls.changes', defaultMessage: 'Changes' })}</dt>
          <dd className="mono cpr-n">
            <DiffCounts additions={pull.additions} deletions={pull.deletions} />
          </dd>
        </dl>

        {checks.length > 0 && (
          <section className="cpr-grp" aria-labelledby={`pull-${number}-checks`}>
            <div className="cpr-gh">
              <h3 id={`pull-${number}-checks`}>
                {t({ id: 'changes.pulls.checks', defaultMessage: 'Checks' })}
              </h3>
              <span className="cpr-mu cpr-n cpr-end">
                {listText(
                  ...CHECK_ORDER.map((state) =>
                    count(state) > 0 ? checkCountText(state, count(state)) : null,
                  ),
                )}
              </span>
            </div>
            <ul className="cpr-checklist">
              {checks.map((check, i) => (
                <li key={i} className="cpr-check">
                  <span
                    className="cpr-st"
                    data-state={check.state}
                    role="img"
                    aria-label={checkText(check.state)}
                  >
                    {CHECK_ICON[check.state]}
                  </span>
                  <Clip text={check.name} className="mono cpr-name" />
                  {check.url && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      aria-label={t(
                        {
                          id: 'changes.pulls.checkLogLabel',
                          defaultMessage: 'View log of {name}',
                        },
                        { name: check.name },
                      )}
                      onClick={() => openLink(check.url!)}
                    >
                      {t({ id: 'changes.pulls.checkLog', defaultMessage: 'View log' })}
                    </button>
                  )}
                  <span className="mono cpr-mu cpr-n cpr-took">
                    {check.duration_ms === null ? '' : elapsedText(check.duration_ms)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {pull.threads.length > 0 && (
          <section className="cpr-grp" aria-labelledby={`pull-${number}-reviews`}>
            <div className="cpr-gh">
              <h3 id={`pull-${number}-reviews`}>
                {t({ id: 'changes.pulls.reviews', defaultMessage: 'Review comments' })}
              </h3>
              {open.length > 0 && (
                <span className="cpr-mu cpr-n cpr-end">
                  {t(
                    {
                      id: 'changes.pulls.unresolved',
                      defaultMessage: '{count, plural, other {# unresolved}}',
                    },
                    { count: open.length },
                  )}
                </span>
              )}
            </div>
            {open.length > 0 && (
              <ul className="cpr-threads">
                {open.map((thread, i) => (
                  <ThreadCard key={i} thread={thread} />
                ))}
              </ul>
            )}
            {resolved.length > 0 && (
              <details className="cpr-done">
                <summary>
                  {t(
                    {
                      id: 'changes.pulls.resolved',
                      defaultMessage: '{count, plural, other {# resolved}}',
                    },
                    { count: resolved.length },
                  )}
                </summary>
                <ul className="cpr-threads">
                  {resolved.map((thread, i) => (
                    <ThreadCard key={i} thread={thread} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
      </div>
      <div className="chg-foot">
        {handButton &&
          open.length > 0 &&
          (state.reason ? <Tip content={state.reason}>{handButton}</Tip> : handButton)}
        <button type="button" className="btn" onClick={() => openLink(pull.url)}>
          <ArrowUpRight className="ic-sm" aria-hidden="true" />
          {t({ id: 'changes.pulls.openOnGithub', defaultMessage: 'Open on GitHub' })}
        </button>
      </div>
    </aside>
  );
}
