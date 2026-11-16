import { useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import type { RepoLane, SessionGateRunResult } from '@pantheon/protocol';
import { Check, Minus, X } from 'lucide-react';
import { RuntimeGlyph, runtimeColor, runtimeName } from '../../../components/RuntimeGlyph';
import { SessionStateIcon } from '../../../components/SessionStateIcon';
import { useBoard } from '../../../data/board';
import { useChangeStories, useChangeStoryDiff } from '../../../data/change-story';
import { runCommand } from '../../../data/commands';
import { useFeedback } from '../../../data/feedback';
import { failureText, useNow } from '../../../data/needs-you';
import { useGithubPulls, useRepoTimeline } from '../../../data/repo';
import { offeredRuntimes, useRuntimeStatus } from '../../../data/runtime-status';
import { useSessionComments } from '../../../data/session-comments';
import { useSessionGatesHistory, useSessionReviews } from '../../../data/session-panel';
import { useSessionList } from '../../../data/workbench-sessions';
import { currentLocale, t } from '../../../i18n';
import { listText } from '../../../lib/list-text';
import { useShell } from '../../../store';
import { Failure, Skeleton } from '../../board/BoardScreen';
import { Empty } from '../../board/Charts';
import { gateSummary, sessionStory } from '../../sessions/model';
import { MergeBar } from '../../sessions/panel';
import { useSessionCard } from '../../sessions/SessionCard';
import { NO_FEEDBACK, readFailed } from '../../sessions/shared';
import { shortSha } from '../history/CommitGraph';
import { openRepoView } from '../route';
import './passage.css';

type StepState = 'passed' | 'failed' | 'skipped' | 'not_run';

const STEP_ICON: Record<Exclude<StepState, 'not_run'>, ReactElement> = {
  passed: <Check aria-hidden="true" />,
  failed: <X aria-hidden="true" />,
  skipped: <Minus aria-hidden="true" />,
};

const stepLabel = (state: StepState): string =>
  state === 'passed'
    ? t({ id: 'repo.passage.step.passed', defaultMessage: 'Passed' })
    : state === 'failed'
      ? t({ id: 'repo.passage.step.failed', defaultMessage: 'Failed' })
      : state === 'skipped'
        ? t({ id: 'repo.passage.step.skipped', defaultMessage: 'Skipped' })
        : t({ id: 'repo.passage.step.notRun', defaultMessage: 'Not run' });

/** A step a run never reached, or that is absent from it, did not run; skipped is its own outcome. */
const stepState = (result: SessionGateRunResult | undefined): StepState =>
  result?.state ??
  (!result || result.skipped
    ? 'not_run'
    : !result.timed_out && result.exit_code === 0
      ? 'passed'
      : 'failed');

const DAY = 24 * 60 * 60_000;
const TICKS = [0, 0.25, 0.5, 0.75];
const NO_TURNS: readonly { id: string; input: string }[] = [];

/** One session's branch: its turns, commits, gates, reviews and pull request. */
export function SessionPassage({
  projectId,
  sessionId,
  onOpenSession,
}: {
  projectId: string;
  sessionId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const sessions = useSessionList(projectId);
  const listed = sessions.data?.find((s) => s.id === sessionId) ?? null;
  const session = useBoard((s) => s.board?.sessions.find((k) => k.id === sessionId) ?? null);
  const boardTurns = useBoard((s) => s.board?.session_turns ?? NO_TURNS);
  const {
    worktree,
    mergeable,
    live,
    diff,
    gates,
    preflight,
    branch,
    totals,
    block,
    merging,
    title,
  } = useSessionCard(sessionId, listed, session);
  const feedback = useFeedback((s) => s.items[sessionId]) ?? NO_FEEDBACK;
  const openSession = useShell((s) => s.openSession);
  const now = useNow(60_000);
  const from = listed ? Date.parse(listed.created_at) : now;
  const timeline = useRepoTimeline(listed ? projectId : null, from, now, 'branch');
  const history = useSessionGatesHistory(mergeable ? sessionId : null);
  const reviews = useSessionReviews(worktree ? sessionId : null);
  const comments = useSessionComments(worktree ? sessionId : null);
  const pulls = useGithubPulls(projectId);
  const stories = useChangeStories(projectId);
  const story = stories.read ? sessionStory(stories.read, sessionId) : null;
  const ready = story?.state === 'ready' && story.result ? story : null;
  const storyDiff = useChangeStoryDiff(ready);

  if (!listed)
    return (
      <div className="bd-s12">
        {sessions.error ? (
          <Failure error={sessions.error} onRetry={sessions.reload} />
        ) : sessions.data ? (
          <Empty
            text={t({ id: 'repo.passage.missing', defaultMessage: 'This session is not listed' })}
          />
        ) : (
          <Skeleton />
        )}
      </div>
    );

  const span = Math.max(1, now - from);
  const x = (at: number) => Math.min(100, Math.max(0, ((at - from) / span) * 100));
  const place = (start: number, end: number): CSSProperties => ({
    left: `${x(start)}%`,
    width: `${x(end) - x(start)}%`,
  });
  const clock = new Intl.DateTimeFormat(currentLocale(), {
    ...(span > DAY ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  // Past the lane limit the session's lane is folded into another, so read every lane.
  const timelineLanes = timeline.read?.lanes ?? [];
  const own = <T extends { session_id?: string }>(of: (l: RepoLane) => T[]) =>
    timelineLanes.flatMap(of).filter((item) => item.session_id === sessionId);
  const turns = own((l) => l.turns ?? []);
  const inputs = new Map(boardTurns.map((turn) => [turn.id, turn.input]));
  const shas = new Set<string>();
  const commits = own((l) => l.points ?? [])
    .filter((point) => !shas.has(point.sha) && !!shas.add(point.sha))
    .sort((a, b) => a.at - b.at);
  const gateRuns = own((l) => l.gates);
  // A lane with too many commits to list counts them per bin instead.
  const lane = timelineLanes.find((l) => l.key === sessionId);
  const bins = lane && !lane.points ? (lane.bins ?? []).filter((bin) => bin.commits > 0) : [];
  const binMs = timeline.read?.bin_ms ?? 0;
  const busiest = Math.max(1, ...bins.map((bin) => bin.commits));
  const reviewRuns = (reviews.data ?? []).filter((review) => review.started_at !== undefined);
  const pull = pulls.read?.items.find((p) => p.session_id === sessionId) ?? null;

  const lanes: { name: string; label: string; marks: ReactNode }[] = [
    {
      name: t({ id: 'repo.passage.lane.turns', defaultMessage: 'Turns' }),
      label: t(
        {
          id: 'repo.passage.lane.turnsLabel',
          defaultMessage: '{count, plural, one {# turn} other {# turns}}',
        },
        { count: turns.length },
      ),
      marks: turns.map((turn, i) => (
        <span
          key={turn.turn_id}
          className="rps-ev"
          style={{
            ...place(turn.at, turns[i + 1]?.at ?? now),
            ['--rps-c' as string]: runtimeColor(listed.runtime),
          }}
        >
          {`${i + 1} ${inputs.get(turn.turn_id)?.split('\n')[0] ?? ''}`.trim()}
        </span>
      )),
    },
    {
      name: t({ id: 'repo.passage.lane.commits', defaultMessage: 'Commits' }),
      label: t(
        {
          id: 'repo.passage.lane.commitsLabel',
          defaultMessage: '{count, plural, one {# commit} other {# commits}}',
        },
        { count: bins.length > 0 ? bins.reduce((n, bin) => n + bin.commits, 0) : commits.length },
      ),
      marks:
        bins.length > 0
          ? bins.map((bin) => (
              <span
                key={bin.start}
                className="rps-bar"
                style={{
                  ...place(bin.start, bin.start + binMs),
                  height: `${Math.max(2, (20 * bin.commits) / busiest)}px`,
                }}
              />
            ))
          : commits.map((point, i) => (
              <span
                key={point.sha}
                className="rps-pt"
                data-kind="commit"
                style={{ left: `${x(point.at)}%` }}
              >
                {(i === 0 || i === commits.length - 1) && (
                  <span className="rps-lab mono">{shortSha(point.sha)}</span>
                )}
              </span>
            )),
    },
    {
      name: t({ id: 'repo.passage.lane.gates', defaultMessage: 'Gates' }),
      label: t(
        {
          id: 'repo.passage.lane.gatesLabel',
          defaultMessage: '{count, plural, one {# gate run} other {# gate runs}}, {failed} failed',
        },
        { count: gateRuns.length, failed: gateRuns.filter((g) => !g.passed).length },
      ),
      marks: gateRuns.map((gate) => (
        <span
          key={gate.at}
          className="rps-pt"
          data-kind="gate"
          data-state={gate.passed ? 'passed' : 'failed'}
          style={{ left: `${x(gate.at)}%` }}
        />
      )),
    },
    {
      name: t({ id: 'repo.passage.lane.reviews', defaultMessage: 'Reviews' }),
      label:
        reviewRuns.length > 0
          ? t(
              {
                id: 'repo.passage.lane.reviewsLabel',
                defaultMessage: '{count, plural, one {# review} other {# reviews}}',
              },
              { count: reviewRuns.length },
            )
          : t({ id: 'repo.passage.lane.noReview', defaultMessage: 'No cross review yet' }),
      marks:
        reviewRuns.length > 0 ? (
          reviewRuns.map((review) => (
            <span
              key={review.id}
              className="rps-ev"
              style={{
                ...place(review.started_at!, review.ended_at ?? now),
                ['--rps-c' as string]: runtimeColor(review.runtimes[0] ?? null),
              }}
            >
              {listText(...review.runtimes.map(runtimeName))}
            </span>
          ))
        ) : (
          <span className="rps-lab">
            {t({ id: 'repo.passage.lane.noReview', defaultMessage: 'No cross review yet' })}
          </span>
        ),
    },
    {
      name: t({ id: 'repo.passage.lane.pull', defaultMessage: 'PR' }),
      label: pull
        ? t(
            { id: 'repo.passage.lane.pullLabel', defaultMessage: 'Pull request #{number}' },
            { number: pull.number },
          )
        : t({ id: 'repo.passage.lane.noPull', defaultMessage: 'No pull request' }),
      marks: pull ? (
        <span
          className="rps-pt"
          data-kind="pull"
          style={{ left: `${x(Date.parse(pull.updated_at))}%` }}
        >
          <span className="rps-lab mono">#{pull.number}</span>
        </span>
      ) : (
        <span className="rps-lab">
          {t({ id: 'repo.passage.lane.noPull', defaultMessage: 'No pull request' })}
        </span>
      ),
    },
  ];

  // The newest run of each commit, newest commit first.
  const seen = new Set<string>();
  const runs = (history.data?.runs ?? []).filter(
    (run) => !seen.has(run.commit) && !!seen.add(run.commit),
  );
  const steps = [...new Set(runs.flatMap((run) => run.results.map((r) => r.name)))];
  const head = diff.data?.head_sha ?? null;

  const hunkFile = new Map((storyDiff.data?.hunks ?? []).map((h) => [h.id, h.file]));
  const cards = ready?.result?.cards ?? [];
  const files = diff.data?.files ?? [];
  const merge = mergeable && (live || block !== null || gateSummary(gates.data) !== 'none');

  return (
    <div className="bd-s12 rps">
      <header className="rps-head">
        <SessionStateIcon session={listed} place="header" />
        <h2 className="rps-title">{title}</h2>
        {listed.branch && <span className="chip mono">{listed.branch}</span>}
        {totals && (
          <span className="rps-n mono">
            <span className="df-add" data-zero={!totals.additions || undefined}>
              +{totals.additions}
            </span>
            <span className="df-del" data-zero={!totals.deletions || undefined}>
              −{totals.deletions}
            </span>
          </span>
        )}
        <button type="button" className="btn sm rps-open" onClick={() => onOpenSession(sessionId)}>
          {t({ id: 'repo.passage.openSession', defaultMessage: 'Open session' })}
        </button>
      </header>
      <div className="rps-main">
        <section className="rps-sec" aria-labelledby={`${sessionId}-passage`}>
          <h3 id={`${sessionId}-passage`}>
            {t({ id: 'repo.passage.passage', defaultMessage: 'Branch passage' })}
          </h3>
          {timeline.error && <Failure error={timeline.error} onRetry={timeline.reload} />}
          <div className="rps-lanes" aria-busy={!timeline.read || undefined}>
            <span />
            <div className="rps-axis" aria-hidden="true">
              {TICKS.map((at) => (
                <span key={at} className="rps-tk" style={{ left: `${at * 100}%` }}>
                  {clock.format(from + at * span)}
                </span>
              ))}
            </div>
            {lanes.map((row) => (
              <div key={row.name} className="rps-row">
                <span className="rps-k">{row.name}</span>
                <div className="rps-t" role="img" aria-label={row.label}>
                  {row.marks}
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="rps-sec" aria-labelledby={`${sessionId}-gates`}>
          <h3 id={`${sessionId}-gates`}>
            {t({ id: 'repo.passage.gates', defaultMessage: 'Gates by commit' })}
          </h3>
          {history.error ? (
            readFailed(history)
          ) : !history.data && history.loading ? (
            <Skeleton />
          ) : runs.length === 0 ? (
            <Empty text={t({ id: 'repo.passage.noGates', defaultMessage: 'No gate runs yet' })} />
          ) : (
            <table
              className="rps-tbl"
              aria-label={t({
                id: 'repo.passage.gatesTable',
                defaultMessage: 'Gate steps each commit ran',
              })}
            >
              <thead>
                <tr>
                  <th scope="col">{t({ id: 'repo.passage.commit', defaultMessage: 'Commit' })}</th>
                  {steps.map((name) => (
                    <th key={name} scope="col" className="rps-c">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.run_id}>
                    <th scope="row">
                      <span className="rps-sha">
                        <span className="mono">{shortSha(run.commit)}</span>
                        {head === run.commit && (
                          <span className="chip">
                            {t({ id: 'repo.passage.head', defaultMessage: 'HEAD' })}
                          </span>
                        )}
                      </span>
                    </th>
                    {steps.map((name) => {
                      const state = stepState(run.results.find((r) => r.name === name));
                      return (
                        <td key={name} className="rps-c">
                          {state === 'not_run' ? (
                            <span className="rps-nr">{stepLabel(state)}</span>
                          ) : (
                            <span
                              className="rps-st"
                              data-state={state}
                              role="img"
                              aria-label={stepLabel(state)}
                            >
                              {STEP_ICON[state]}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="rps-sec" aria-labelledby={`${sessionId}-files`}>
          <h3 id={`${sessionId}-files`}>
            {t({ id: 'repo.passage.files', defaultMessage: 'Files' })}
          </h3>
          {diff.error ? (
            readFailed(diff)
          ) : !diff.data && diff.loading ? (
            <Skeleton />
          ) : files.length === 0 ? (
            <Empty
              text={t({ id: 'repo.passage.noFiles', defaultMessage: 'No changed files yet' })}
            />
          ) : (
            <table
              className="rps-tbl"
              aria-label={t({ id: 'repo.passage.filesTable', defaultMessage: 'Changed files' })}
            >
              <thead>
                <tr>
                  <th scope="col">{t({ id: 'repo.passage.file', defaultMessage: 'File' })}</th>
                  <th scope="col">{t({ id: 'repo.passage.change', defaultMessage: 'Change' })}</th>
                  <th scope="col">{t({ id: 'repo.passage.story', defaultMessage: 'Story' })}</th>
                  <th scope="col">{t({ id: 'repo.passage.tests', defaultMessage: 'Tests' })}</th>
                  <th scope="col">
                    {t({ id: 'repo.passage.comments', defaultMessage: 'Comments' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => {
                  const own = cards.filter((c) =>
                    c.hunks.some((h) => hunkFile.get(h) === file.path),
                  );
                  const tests = [
                    ...new Set(own.flatMap((c) => c.tests.flatMap((h) => hunkFile.get(h) ?? []))),
                  ].filter((path) => path !== file.path);
                  const noted = (comments.data ?? []).filter((c) => c.path === file.path).length;
                  return (
                    <tr key={file.path}>
                      <th scope="row">
                        <button
                          type="button"
                          className="rps-path mono"
                          onClick={() => openRepoView(projectId, { kind: 'file', path: file.path })}
                        >
                          {file.path}
                        </button>
                      </th>
                      <td className="rps-n mono">
                        <span className="df-add" data-zero={!file.additions || undefined}>
                          +{file.additions ?? 0}
                        </span>
                        <span className="df-del" data-zero={!file.deletions || undefined}>
                          −{file.deletions ?? 0}
                        </span>
                      </td>
                      <td className="rps-cut">{listText(...own.map((c) => c.title))}</td>
                      <td className="rps-cut mono">
                        {listText(...tests.map((path) => path.split('/').at(-1)))}
                      </td>
                      <td className="rps-num" data-zero={noted === 0 || undefined}>
                        {noted}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
      <aside className="rps-aside">
        {merge && (
          <section className="rps-sec" aria-labelledby={`${sessionId}-merge`}>
            <h3 id={`${sessionId}-merge`}>
              {t({ id: 'repo.passage.merge', defaultMessage: 'Merge readiness' })}
            </h3>
            {block && (
              <div className="ss-cerr" role="alert">
                {block.text}
              </div>
            )}
            {readFailed(preflight)}
            <MergeBar
              sessionId={sessionId}
              revision={session?.revision ?? null}
              live={live}
              merging={merging}
              cancelling={listed.merge?.cancel_requested}
              preflight={preflight.data}
              onPreflight={preflight.reload}
              gates={gates.data}
              branch={branch}
              source={title}
              onChecks={() => openSession(sessionId, 'checks')}
              listed={listed}
              head={head}
              feedback={feedback}
              direct={!!session?.direct_task}
            />
          </section>
        )}
        <CrossReview sessionId={sessionId} runtime={listed.runtime} onRequested={reviews.reload} />
      </aside>
    </div>
  );
}

/** Runtimes to review the branch, the ones other than its author's picked first, and the request. */
function CrossReview({
  sessionId,
  runtime,
  onRequested,
}: {
  sessionId: string;
  runtime: string;
  onRequested: () => void;
}) {
  const { read, unavailable } = useRuntimeStatus('reviewer');
  const runtimes = offeredRuntimes(read, []);
  const [picked, setPicked] = useState<readonly string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = picked ?? runtimes.filter((r) => r !== runtime && unavailable[r] === undefined);
  const toggle = (r: string) =>
    setPicked(runtimes.filter((k) => (k === r ? !chosen.includes(k) : chosen.includes(k))));

  async function request() {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'review.request',
      { session_id: sessionId, runtimes: [...chosen] },
      null,
    );
    setBusy(false);
    if (result.ok) onRequested();
    else setError(failureText(result.error));
  }

  return (
    <section className="rps-sec" aria-labelledby={`${sessionId}-review`}>
      <h3 id={`${sessionId}-review`}>
        {t({ id: 'repo.passage.review', defaultMessage: 'Cross review' })}
      </h3>
      <div
        className="rps-rts"
        role="group"
        aria-label={t({ id: 'repo.passage.reviewers', defaultMessage: 'Reviewing runtimes' })}
      >
        {runtimes.map((r) => (
          <button
            key={r}
            type="button"
            className="rps-rt"
            aria-pressed={chosen.includes(r)}
            disabled={unavailable[r] !== undefined}
            title={unavailable[r]}
            onClick={() => toggle(r)}
          >
            <RuntimeGlyph runtime={r} size={14} />
            {runtimeName(r)}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn"
        disabled={busy || chosen.length === 0}
        aria-busy={busy || undefined}
        onClick={() => void request()}
      >
        {t({ id: 'repo.passage.requestReview', defaultMessage: 'Start review' })}
      </button>
      {error && (
        <div className="ss-cerr" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
