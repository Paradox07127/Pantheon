import { useState, type ReactNode } from 'react';
import { LoadError } from '../../components/LoadError';
import { Dialog } from '@base-ui/react/dialog';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { ChangeStory, Review, ReviewFinding } from '@pantheon/domain';
import type {
  BridgeResult,
  SessionDiff,
  SessionGates,
  SessionGatesHistory,
  SessionPreflight,
  WorkbenchSession,
} from '@pantheon/protocol';
import { Check, ChevronRight, FolderOpen, MapPinOff, Minus, Timer, X } from 'lucide-react';
import { RunningFor, RUNNING } from '../../components/RunningFor';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { Skeleton } from '../../components/Skeleton';
import { GateMark } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import type { DiffFile } from '../../data/patch';
import { useBoard } from '../../data/board';
import { useChangeStories, useChangeStoryDiff } from '../../data/change-story';
import { runCommand } from '../../data/commands';
import { useFeedback, withFeedback, type FeedbackItem } from '../../data/feedback';
import { shortId } from '../../data/format';
import { ageText, failureText, reasonText } from '../../data/needs-you';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import { listText } from '../../lib/list-text';
import { ageParts } from '../../lib/time-text';
import { scrimFlag } from '../../lib/root-flag';
import { useShell } from '../../store';
import { GateTracker } from './GateTracker';
import { GATE_STATES, gateState } from '../../lib/gate-model';
import {
  anchorFinding,
  findingItem,
  findingOpen,
  findingState,
  gateFailing,
  gateOutcome,
  gatesFailed,
  gateSummary,
  messageCommand,
  reviewFindings,
  reviewRuntime,
  sessionRow,
  sessionStory,
  worktreeReason,
} from './model';
import {
  FINDING_OUTCOMES,
  findingOutcomeLabel,
  findingOutcomeName,
  type FindingOutcome,
} from './inspector-model';
import { commentSent } from './compose';
import { GateResults } from './GateResults';
import { DiscardDialog } from './parts';
import type { LandedPoint } from './story/model';
import { StoryView } from './story/StoryView';
import './panel.css';
import './merge-bar.css';
import { ReadStatus } from '../../components/ReadStatus';
import { ReviewCoverage } from '../../components/ReviewCoverage';
import { t } from '../../i18n';
import { EmptyState } from '../../components/EmptyState';

interface Read<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
  stale?: boolean;
  loading?: boolean;
  readAt?: number | null;
}

const fail = (reason: unknown): BridgeResult<unknown> => ({
  ok: false,
  error: { code: 'ipc_failed', message: String(reason) },
});

function ReadFailed({ read }: { read: Read<unknown> }) {
  return <LoadError message={read.error!} onRetry={read.reload} />;
}

function Loading() {
  return (
    <div aria-busy="true">
      <Skeleton style={{ display: 'block', height: 10, width: '70%' }} />
    </div>
  );
}

const OUTCOME_ICON = {
  passed: <Check aria-hidden="true" />,
  failed: <X aria-hidden="true" />,
  timed_out: <Timer aria-hidden="true" />,
} as const;

const REVIEW_STATE: Record<Review['state'], () => string> = {
  running: () => t({ id: 'sessions.panel.review.reviewing', defaultMessage: 'Reviewing' }),
  completed: () => t({ id: 'sessions.panel.checks.reviewDone', defaultMessage: 'Review done' }),
  failed: () => t({ id: 'sessions.panel.checks.reviewFailed', defaultMessage: 'Review failed' }),
};

/** The command receipt acknowledges intent; the daemon's operation state confirms completion. */
export function CancelOperation(props: {
  kind: 'gates' | 'merge';
  sessionId: string;
  revision: number | null;
  cancelling?: boolean;
  onAccepted?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = pending || accepted || props.cancelling;
  const cancel = async () => {
    if (waiting) return;
    setPending(true);
    setError(null);
    const result = await runCommand(
      props.kind === 'gates' ? 'session.gates.cancel' : 'session.merge.cancel',
      { session_id: props.sessionId },
      props.revision,
    );
    setPending(false);
    if (result.ok) {
      setAccepted(true);
      props.onAccepted?.();
    } else setError(failureText(result.error));
  };
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={!!waiting || props.revision === null}
        aria-busy={waiting || undefined}
        onClick={() => void cancel()}
      >
        {waiting
          ? t({ id: 'sessions.panel.cancel.cancelling', defaultMessage: 'Cancelling' })
          : props.kind === 'gates'
            ? t({ id: 'sessions.panel.cancel.checks', defaultMessage: 'Cancel checks' })
            : t({ id: 'sessions.panel.cancel.merge', defaultMessage: 'Cancel merge' })}
      </button>
      {error && (
        <span className="ss-cerr" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * The history of the session's gate runs, the newest gate result per command, a rerun button and
 * the empty state without gate commands; an older run picked in the history is shown read-only.
 */
export function ChecksTab(props: {
  sessionId?: string;
  revision?: number | null;
  gates: Read<SessionGates>;
  /** The session's recorded gate runs, newest first. */
  history?: Read<SessionGatesHistory>;
  readOnly: boolean;
  merging: boolean;
  busy: boolean;
  /** Ids of the items the next message carries. */
  attached: ReadonlySet<string>;
  onAttach: (item: FeedbackItem) => void;
  /** Sends the output of the failed commands to the session. */
  onFix?: (items: FeedbackItem[]) => void;
  onRun: () => void;
  onSettings: () => void;
  /** The session's counts of the newest gate run, which split the bar while it runs. */
  gate?: WorkbenchSession['gate'];
  /** The session's reviews, oldest first; the newest gets a row after the steps. */
  reviews?: Review[] | null;
  /** Opens the review in the changes panel. */
  onReview?: () => void;
}) {
  const asked = useShell((s) => s.sessionRun);
  const [picked, setPicked] = useState<string | null>(asked);
  const [retrying, setRetrying] = useState(false);
  /** The gates read when the daemon accepted a rerun of the failed, until a new read replaces it. */
  const [retriedFrom, setRetriedFrom] = useState<SessionGates | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const { gates } = props;
  if (!gates.data) return gates.error ? <ReadFailed read={gates} /> : <Loading />;
  const { configured, running, last } = gates.data;
  const review = props.reviews?.at(-1);
  const reviewRow = review && (
    <button type="button" className="ss-ckr" onClick={props.onReview}>
      <span
        className={`ss-ck ${review.state === 'completed' ? 'passed' : review.state}`}
        role="img"
        aria-label={REVIEW_STATE[review.state]()}
      >
        {review.state === 'running' ? (
          <span className="ss-st" data-step="in_progress" aria-hidden="true" />
        ) : (
          OUTCOME_ICON[review.state === 'completed' ? 'passed' : 'failed']
        )}
      </span>
      <span className="ss-ckn">
        {t({ id: 'sessions.panel.checks.externalReview', defaultMessage: 'External review' })}
      </span>
      <span className="ss-ckm">{listText(...review.runtimes.map(runtimeName))}</span>
    </button>
  );
  if (
    !configured &&
    !last &&
    !running &&
    !['cancelled', 'failed'].includes(gates.data.operation?.state ?? '')
  )
    return (
      <>
        <div className="empty">
          {t({
            id: 'sessions.panel.checks.noGates',
            defaultMessage: 'The project has no gate commands',
          })}
          {!props.readOnly && (
            <button type="button" className="btn" onClick={props.onSettings}>
              {t({ id: 'sessions.panel.checks.openSettings', defaultMessage: 'Open settings' })}
            </button>
          )}
        </div>
        {reviewRow}
      </>
    );
  const working = running || props.busy;
  const runs = props.history?.data?.runs ?? [];
  // The recorded run of the listed results; the history and the results are read apart.
  const listedRun =
    last &&
    runs.find((r) => r.commit === last.commit && Date.parse(r.finished_at) === last.checked_at);
  const older = picked === listedRun?.run_id ? undefined : runs.find((r) => r.run_id === picked);
  const passed = last?.results.filter((result) => gateOutcome(result) === 'passed').length ?? 0;
  const failed = last?.results.filter(gateFailing).length ?? 0;
  const failing = failed > 0;
  // Commands the listed run never reached after a failure; until the history is read, the
  // session's count of the same run.
  const notRun = last
    ? listedRun
      ? listedRun.results.slice(last.results.length).filter((r) => r.skipped).length
      : props.gate &&
          !props.gate.running &&
          props.gate.finished_at &&
          Date.parse(props.gate.finished_at) === last.checked_at
        ? (props.gate.not_run ?? 0)
        : 0
    : 0;
  const total = (last?.results.length ?? 0) + notRun;
  const live = running && props.gate?.running ? props.gate : null;
  // A rerun reports no command until it ends, so without the session's counts all of them run.
  const bar = !running
    ? { passed, failed, skipped: total - notRun - passed - failed, running: 0, notRun }
    : live
      ? {
          passed: live.passed,
          failed: live.failed,
          skipped: live.skipped ?? 0,
          running: live.running,
          notRun: 0,
        }
      : { passed: 0, failed: 0, skipped: 0, running: total, notRun: 0 };
  const barText = t(
    {
      id: 'sessions.panel.checks.bar',
      defaultMessage: '{passed} passed, {failed} failed, {running} running',
    },
    { passed: bar.passed, failed: bar.failed, running: bar.running },
  );
  const rerunFailed = async () => {
    if (!props.sessionId || retrying || retriedFrom === gates.data) return;
    setRetrying(true);
    setRetryError(null);
    const result = await runCommand(
      'session.gates.run',
      { session_id: props.sessionId, only_failed: true },
      props.revision ?? null,
    ).catch(fail);
    setRetrying(false);
    if (result.ok) {
      setRetriedFrom(gates.data);
      gates.reload();
    } else setRetryError(failureText(result.error));
  };
  return (
    <>
      {!older && ((last && last.results.length > 0) || live) && (
        <div className="ss-ptop">
          <span
            className="ss-pseg"
            role="img"
            aria-label={listText(
              barText,
              bar.skipped > 0 &&
                t(
                  { id: 'sessions.mergeBar.skipped', defaultMessage: '{count} skipped' },
                  { count: bar.skipped },
                ),
              bar.notRun > 0 &&
                t(
                  { id: 'sessions.panel.checks.notRun', defaultMessage: '{count} not run' },
                  { count: bar.notRun },
                ),
            )}
          >
            {bar.passed > 0 && <i data-tone="ok" style={{ flexGrow: bar.passed }} />}
            {bar.failed > 0 && <i data-tone="bad" style={{ flexGrow: bar.failed }} />}
            {bar.skipped > 0 && <i data-tone="idle" style={{ flexGrow: bar.skipped }} />}
            {bar.running > 0 && <i data-tone="run" style={{ flexGrow: bar.running }} />}
            {bar.notRun > 0 && <i data-tone="none" style={{ flexGrow: bar.notRun }} />}
          </span>
          <span className="ss-ptn">
            {live
              ? t(
                  {
                    id: 'sessions.panel.checks.live',
                    defaultMessage: '{passed} passed, {running} running, {skipped} skipped',
                  },
                  { passed: bar.passed, running: bar.running, skipped: bar.skipped },
                )
              : t(
                  {
                    id: 'sessions.panel.dock.checksPassed',
                    defaultMessage: '{passed} / {total} passed',
                  },
                  { passed, total },
                )}
          </span>
        </div>
      )}
      {!older && gates.data.operation?.state === 'cancelled' && (
        <div className="ss-pacts" role="status">
          {t({ id: 'sessions.panel.checks.cancelled', defaultMessage: 'Checks cancelled' })}
        </div>
      )}
      {!older && gates.data.operation?.state === 'failed' && (
        <div className="ss-cerr" role="alert">
          {gates.data.operation.error === 'daemon_restart'
            ? t({
                id: 'sessions.panel.checks.restartInterrupted',
                defaultMessage: 'A restart interrupted the checks. Run them again.',
              })
            : (gates.data.operation.error ??
              t({
                id: 'sessions.panel.checks.unfinished',
                defaultMessage: 'Checks did not finish',
              }))}
        </div>
      )}
      {props.history?.error && <ReadFailed read={props.history} />}
      {runs.length >= 2 && (
        <div
          className="ss-ckh"
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || !older) return;
            e.stopPropagation();
            setPicked(null);
          }}
        >
          <GateTracker
            runs={runs}
            selected={(older ?? listedRun)?.run_id}
            onRun={(run) => setPicked(run.run_id)}
          />
        </div>
      )}
      {older ? (
        <ul className="ss-checks">
          {older.results.map((result, i) => {
            const state = gateState(result);
            return (
              <li key={`${i}-${result.name}`}>
                <div className="ss-ckr">
                  <span
                    className={`ss-ck ${state}`}
                    role="img"
                    aria-label={GATE_STATES[state].label}
                  >
                    {state === 'skipped' ? <Minus aria-hidden="true" /> : OUTCOME_ICON[state]}
                  </span>
                  <span className="ss-ckn mono" title={result.name}>
                    {result.name}
                  </span>
                  <span className="ss-ckm mono" title={older.commit}>
                    {shortId(older.commit)}
                  </span>
                  <span className="ss-ckm">
                    {ageText(Date.parse(older.finished_at), Date.now())}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        (last || gates.data.commands) && (
          <GateResults
            last={last}
            run={listedRun || undefined}
            planned={gates.data.commands}
            running={running}
            readOnly={props.readOnly}
            busy={props.busy}
            attached={props.attached}
            onAttach={props.onAttach}
            onFix={props.readOnly || props.merging ? undefined : props.onFix}
          />
        )
      )}
      {reviewRow}
      {!props.readOnly && (configured || running) && !older && (
        <div className="ss-pacts">
          <button
            type="button"
            className="btn"
            disabled={working || props.merging}
            aria-busy={working || undefined}
            onClick={props.onRun}
          >
            {working
              ? t({ id: 'sessions.panel.checks.running', defaultMessage: 'Running' })
              : last
                ? t({ id: 'sessions.panel.checks.rerun', defaultMessage: 'Rerun' })
                : t({ id: 'sessions.panel.checks.run', defaultMessage: 'Run' })}
          </button>
          {failing && props.sessionId && (
            <button
              type="button"
              className="btn"
              disabled={working || props.merging || retrying || retriedFrom === gates.data}
              aria-busy={retrying || retriedFrom === gates.data || undefined}
              onClick={() => void rerunFailed()}
            >
              {t({
                id: 'sessions.panel.checks.rerunFailed',
                defaultMessage: 'Rerun only the failed',
              })}
            </button>
          )}
          {running && !props.merging && props.sessionId && props.revision !== undefined && (
            <CancelOperation
              key={gates.data.operation?.id ?? props.sessionId}
              kind="gates"
              sessionId={props.sessionId}
              revision={props.revision}
              cancelling={gates.data.operation?.state === 'cancelling'}
              onAccepted={gates.reload}
            />
          )}
        </div>
      )}
      {retryError && !older && (
        <div className="ss-cerr" role="alert">
          {retryError}
        </div>
      )}
    </>
  );
}

// Labels are getters, so each is read in the language loaded by then.
const STEP = {
  completed: {
    get label() {
      return t({ id: 'sessions.panel.dock.stepDone', defaultMessage: 'Done' });
    },
  },
  in_progress: {
    get label() {
      return t({ id: 'sessions.panel.dock.stepNow', defaultMessage: 'In progress' });
    },
  },
  pending: {
    get label() {
      return t({ id: 'sessions.panel.dock.stepLater', defaultMessage: 'Not started' });
    },
  },
} as const;

/** The session's plan: the steps done of all its steps, then each step and where it stands. */
export function PlanTab(props: {
  /** The main agent's newest todo list; null without one. */
  steps: readonly { status: keyof typeof STEP; title: string }[] | null;
  /** The session waits for the user, so its current step does too. */
  waiting: boolean;
}) {
  const { steps } = props;
  if (!steps)
    return (
      <EmptyState
        inline
        title={t({ id: 'sessions.panel.dock.noPlan', defaultMessage: 'No plan yet' })}
      />
    );
  const done = steps.filter((step) => step.status === 'completed').length;
  return (
    <>
      <div className="ss-ptop">
        <span className="ss-meter" aria-hidden="true">
          <i style={{ transform: `scaleX(${done / steps.length})` }} />
        </span>
        <span className="ss-ptn">
          {done} / {steps.length}
        </span>
      </div>
      <ol className="ss-steps">
        {steps.map((step, i) => (
          <li key={i} className="ss-step" data-step={step.status}>
            <span
              className="ss-st"
              data-step={step.status}
              data-wait={(props.waiting && step.status === 'in_progress') || undefined}
              role="img"
              aria-label={STEP[step.status].label}
            />
            <span className="ss-stt">{step.title}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

/** Who interpreted the story and how long ago. */
export const storyByText = (story: ChangeStory, now: number) =>
  t(
    {
      id: 'repo.changes.storyBy',
      defaultMessage:
        '{runtime} interpreted {unit, select, now {just now} minute {{count, plural, one {# minute} other {# minutes}} ago} hour {{count, plural, one {# hour} other {# hours}} ago} other {{count, plural, one {# day} other {# days}} ago}}',
    },
    { runtime: runtimeName(story.runtime ?? null), ...ageParts(now - story.created_at) },
  );

/** The session's newest interpretation, or the button that starts one; both once HEAD moved past it. */
export function StoryTab(props: {
  sessionId: string;
  projectId: string | null;
  listed: WorkbenchSession | null;
  diff: SessionDiff | null;
  findings: readonly ReviewFinding[];
}) {
  const stories = useChangeStories(props.projectId);
  const [busy, setBusy] = useState(false);
  /** The refusal, with the head it was given for. */
  const [refused, setRefused] = useState<{ text: string; head: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const story = stories.read ? sessionStory(stories.read, props.sessionId) : null;
  const storyDiff = useChangeStoryDiff(story?.state === 'ready' ? story : null);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'change_story.start',
      { session_id: props.sessionId },
      null,
    ).catch(fail);
    setBusy(false);
    if (result.ok) stories.reload();
    else if (result.error.code === 'invalid_state')
      setRefused({ text: failureText(result.error), head: props.diff?.head_sha ?? null });
    else setError(failureText(result.error));
  }

  const failed = stories.error && (
    <ReadFailed read={{ data: null, error: stories.error, reload: stories.reload }} />
  );
  if (!stories.read) return failed || <Loading />;
  const shown = (body: ReactNode) => (
    <>
      {failed}
      {storyDiff.error && <ReadFailed read={storyDiff} />}
      {body}
    </>
  );
  const ready = story?.state === 'ready' && story.result ? story : null;
  const view = ready && (
    <>
      <p className="ss-sby">
        {ready.runtime && <RuntimeGlyph runtime={ready.runtime} size={14} />}
        {storyByText(ready, Date.now())}
      </p>
      <StoryView
        point={storyPoint(ready, props.listed)}
        story={ready}
        result={ready.result!}
        diff={storyDiff.data}
        findings={props.findings}
      />
    </>
  );
  const stale =
    ready !== null &&
    (ready.outdated === true ||
      (props.listed?.state !== 'merged' &&
        props.diff !== null &&
        ready.to_sha !== props.diff.head_sha));
  if (ready && !stale) return shown(view);
  if (busy || story?.state === 'running')
    return shown(
      <div className="empty" aria-busy="true">
        <RunningFor
          label={RUNNING.writing}
          since={story?.state === 'running' ? story.created_at : null}
        />
      </div>,
    );
  const uncommitted =
    props.listed?.state !== 'merged' &&
    props.diff !== null &&
    props.diff.head_sha === props.diff.base_sha;
  const reason =
    (props.listed && worktreeReason(props.listed)) ??
    (refused && refused.head === (props.diff?.head_sha ?? null) ? refused.text : null) ??
    (uncommitted
      ? t({ id: 'sessions.panel.story.noCommits', defaultMessage: 'No commits' })
      : null);
  const button = (
    <button
      type="button"
      className="btn"
      aria-disabled={reason !== null || undefined}
      onClick={reason ? undefined : () => void start()}
    >
      {t({ id: 'sessions.panel.story.generate', defaultMessage: 'Generate change story' })}
    </button>
  );
  if (view)
    return shown(
      <>
        {stale && (
          <p role="status">
            {t({
              id: 'sessions.panel.story.stale',
              defaultMessage:
                'This change story is out of date; it shows the evidence of an earlier commit',
            })}
          </p>
        )}
        {view}
        <div className="ss-pacts">{reason ? <Tip content={reason}>{button}</Tip> : button}</div>
        {error && (
          <span className="tr-err" role="alert">
            {error}
          </span>
        )}
      </>,
    );
  return shown(
    <div className="empty">
      {story?.state === 'failed' && (
        <span className="tr-err">{reasonText(story.reason ?? 'failed')}</span>
      )}
      {reason ? <Tip content={reason}>{button}</Tip> : button}
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
    </div>,
  );
}

function storyPoint(story: ChangeStory, listed: WorkbenchSession | null): LandedPoint {
  return {
    kind: 'landed',
    workspace_id: listed?.workspace_id ?? '',
    task_goal: listed ? sessionRow(listed).title : null,
    source: story.source,
    branch: null,
    from_sha: story.from_sha,
    to_sha: story.to_sha,
    at: story.created_at,
  };
}

/** The session's review findings with a request for the other vendor's review. */
export function ReviewTab(props: {
  sessionId: string;
  runtime: string;
  reviews: Read<Review[]>;
  /** Files of the shown diff; null when no diff is shown. */
  files: readonly DiffFile[] | null;
  readOnly: boolean;
  /** Ids of the items the next message carries. */
  attached: ReadonlySet<string>;
  onAttach: (item: FeedbackItem) => void;
}) {
  const [busy, setBusy] = useState(false);
  /** The review the daemon accepted, until the reviews read holds it. */
  const [accepted, setAccepted] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  /** The review the daemon resolved a finding of, until the reviews read holds a newer revision. */
  const [resolved, setResolved] = useState<{ id: string; revision: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const { read, runtimes, unavailable } = useRuntimeStatus('reviewer');
  const other = reviewRuntime(props.runtime);
  const usable = runtimes.filter((r) => !unavailable[r]);
  const reviewer = picked ?? (usable.length === 0 || usable.includes(other) ? other : usable[0]!);
  const why = unavailable[reviewer];
  const offered = offeredRuntimes(read, [reviewer]);
  const reviews = props.reviews.data;
  const reviewing = !!reviews?.some((review) => review.state === 'running');
  const newest = reviews?.at(-1);
  const pending = busy || (accepted !== null && !reviews?.some((r) => r.id === accepted));
  const holding =
    resolving ||
    (resolved !== null &&
      reviews?.find((r) => r.id === resolved.id)?.revision === resolved.revision);

  async function request() {
    if (pending || !reviews || props.reviews.stale || why !== undefined) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'review.request',
      { session_id: props.sessionId, runtimes: [reviewer] },
      null,
    ).catch(fail);
    setBusy(false);
    if (result.ok) {
      setAccepted((result.value as { review_id?: string } | null)?.review_id ?? null);
      props.reviews.reload();
    } else setError(failureText(result.error));
  }

  async function resolve(finding: ReviewFinding, outcome: FindingOutcome) {
    const review = reviews?.find((r) => r.id === finding.review_id);
    if (holding || !review || props.reviews.stale) return;
    setResolving(true);
    setError(null);
    const result = await runCommand(
      'review.finding.resolve',
      { review_id: review.id, finding_id: finding.id, outcome },
      review.revision,
    ).catch(fail);
    setResolving(false);
    if (result.ok) {
      setResolved({ id: review.id, revision: review.revision });
      props.reviews.reload();
    } else setError(failureText(result.error));
  }

  const findings = reviews ? reviewFindings(reviews) : [];
  const requestButton = (
    <button
      type="button"
      className="btn"
      disabled={!reviews || pending || reviewing || !!props.reviews.stale || why !== undefined}
      aria-busy={pending || reviewing || undefined}
      onClick={() => void request()}
    >
      {reviewing
        ? t({ id: 'sessions.panel.review.reviewing', defaultMessage: 'Reviewing' })
        : t(
            {
              id: 'sessions.panel.review.request',
              defaultMessage: 'Ask {runtime} to review',
            },
            { runtime: runtimeName(reviewer) },
          )}
    </button>
  );
  return (
    <>
      {reviews && (
        <ReadStatus
          label={t({ id: 'sessions.panel.review.label', defaultMessage: 'Review' })}
          {...props.reviews}
        />
      )}
      {newest && <ReviewCoverage review={newest} />}
      {!reviews ? (
        props.reviews.error ? (
          <ReadFailed read={props.reviews} />
        ) : (
          <Loading />
        )
      ) : (
        findings.length > 0 && (
          <ul className="ss-reviews">
            {findings.map((finding) => {
              const open = findingOpen(finding) && !props.readOnly && !props.reviews.stale;
              const item = findingItem(finding);
              return (
                <li key={finding.id} className="ss-rv">
                  <div className="ss-rvh">
                    <span className={finding.blocking ? 'ss-sev blocker' : 'ss-sev minor'}>
                      <span className="ss-sevi" aria-hidden="true" />
                      {finding.blocking
                        ? t({ id: 'sessions.panel.review.blocking', defaultMessage: 'Blocker' })
                        : t({ id: 'sessions.panel.review.minor', defaultMessage: 'Minor' })}
                    </span>
                    {props.files &&
                      findingOpen(finding) &&
                      !anchorFinding(finding, props.files) && (
                        <MapPinOff
                          className="ic-sm"
                          style={{ color: 'var(--wait)' }}
                          role="img"
                          aria-label={t({
                            id: 'sessions.panel.review.locationLost',
                            defaultMessage: 'Location no longer found',
                          })}
                        />
                      )}
                    <span className="ss-rvl mono" title={finding.location}>
                      {finding.location}
                    </span>
                    <span className="ss-rvm">{runtimeName(finding.runtime)}</span>
                    <span className="ss-rvm">{findingState(finding)}</span>
                  </div>
                  <p>{finding.impact}</p>
                  <pre className="ss-rvq mono">{finding.quote}</pre>
                  <p className="ss-rve">{finding.evidence}</p>
                  {open && (
                    <div className="ss-rva">
                      {FINDING_OUTCOMES.map((outcome) => (
                        <button
                          key={outcome}
                          type="button"
                          className="btn"
                          aria-label={findingOutcomeLabel(finding, outcome)}
                          disabled={holding}
                          onClick={() => void resolve(finding, outcome)}
                        >
                          {findingOutcomeName(outcome)}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="btn"
                        aria-label={t(
                          {
                            id: 'sessions.panel.review.attachLabel',
                            defaultMessage: 'Attach: {impact}',
                          },
                          { impact: finding.impact },
                        )}
                        aria-pressed={props.attached.has(item.id)}
                        onClick={() => props.onAttach(item)}
                      >
                        {t({ id: 'sessions.panel.attach', defaultMessage: 'Attach' })}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )
      )}
      {!props.readOnly && (
        <div className="ss-pacts">
          {offered.length > 1 && (
            <RadioGroup<string>
              className="seg"
              aria-label={t({ id: 'sessions.panel.review.reviewer', defaultMessage: 'Reviewer' })}
              value={reviewer}
              disabled={pending || reviewing}
              onValueChange={setPicked}
            >
              {offered.map((r) => {
                const reason = unavailable[r];
                const radio = (
                  <Radio.Root key={r} value={r} disabled={reason !== undefined}>
                    <RuntimeGlyph runtime={r} size={14} />
                    {runtimeName(r)}
                  </Radio.Root>
                );
                return reason === undefined ? (
                  radio
                ) : (
                  <Tip key={r} content={reason}>
                    {radio}
                  </Tip>
                );
              })}
            </RadioGroup>
          )}
          {why ? <Tip content={why}>{requestButton}</Tip> : requestButton}
        </div>
      )}
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

const BLOCKED: Record<string, string> = {
  get no_changes() {
    return t({ id: 'sessions.panel.blocked.noChanges', defaultMessage: 'No new commits' });
  },
  get uncommitted_changes() {
    return t({
      id: 'sessions.panel.blocked.uncommitted',
      defaultMessage: 'The worktree has uncommitted changes',
    });
  },
  get unresolved_conflicts() {
    return t({
      id: 'sessions.panel.blocked.unresolved',
      defaultMessage: 'The worktree has unresolved conflicts',
    });
  },
  get source_dirty() {
    return t({
      id: 'sessions.panel.blocked.sourceDirty',
      defaultMessage: 'The source folder has uncommitted changes',
    });
  },
  get source_detached() {
    return t({
      id: 'sessions.panel.blocked.sourceDetached',
      defaultMessage: 'The source repository is on a detached HEAD',
    });
  },
  get resource_busy() {
    return t({ id: 'sessions.panel.blocked.busy', defaultMessage: 'Running or merging' });
  },
  get invalid_state() {
    return t({ id: 'sessions.panel.blocked.notReady', defaultMessage: 'The session is not ready' });
  },
};
export const blockedText = (reason: string | undefined): string =>
  reason ? (BLOCKED[reason] ?? reason) : BLOCKED.invalid_state!;

export const GATE = {
  running: {
    get word() {
      return t({ id: 'sessions.panel.gate.running', defaultMessage: 'Gates running' });
    },
    icon: <GateMark state="running" />,
  },
  cancelling: {
    get word() {
      return t({ id: 'sessions.panel.gate.cancelling', defaultMessage: 'Cancelling gates' });
    },
    icon: <GateMark state="cancelling" />,
  },
  cancelled: {
    get word() {
      return t({ id: 'sessions.panel.gate.cancelled', defaultMessage: 'Gates cancelled' });
    },
    icon: <GateMark state="cancelled" />,
  },
  passed: {
    get word() {
      return t({ id: 'sessions.panel.gate.passed', defaultMessage: 'Gates passed' });
    },
    icon: <GateMark state="passed" />,
  },
  failed: {
    get word() {
      return t({ id: 'sessions.panel.gate.failed', defaultMessage: 'Gates failed' });
    },
    icon: <GateMark state="failed" />,
  },
  stale: {
    get word() {
      return t({ id: 'sessions.panel.gate.stale', defaultMessage: 'Gates out of date' });
    },
    icon: <GateMark state="stale" />,
  },
  none: {
    get word() {
      return t({ id: 'sessions.panel.gate.none', defaultMessage: 'Gates not run' });
    },
    icon: <GateMark state="none" />,
  },
} as const;

const LAST_GATE = {
  get none() {
    return t({ id: 'sessions.panel.lastGate.none', defaultMessage: 'Not run' });
  },
  get passed() {
    return t({ id: 'sessions.panel.lastGate.passed', defaultMessage: 'Passed' });
  },
  get failed() {
    return t({ id: 'sessions.panel.lastGate.failed', defaultMessage: 'Failed last time' });
  },
  get stale() {
    return t({ id: 'sessions.panel.lastGate.stale', defaultMessage: 'Out of date' });
  },
} as const;

/**
 * The gate state the inspector shows, with the passed commands of the last run out of those
 * configured; while a run goes, the session's live counts of it.
 */
export function gateCount(
  preflight: SessionPreflight | null,
  gates: SessionGates | null,
  listed?: WorkbenchSession['gate'],
) {
  const summary = gateSummary(gates);
  if (summary === 'running' && listed?.state === 'running') {
    const skipped = listed.skipped ?? 0;
    return {
      gate: summary,
      passed: listed.passed,
      failed: listed.failed,
      skipped,
      running: listed.running,
      total: listed.passed + listed.failed + skipped + listed.running,
    };
  }
  const gate = ['running', 'cancelling', 'cancelled'].includes(summary)
    ? summary
    : (preflight?.gate.last ?? summary);
  // The configured commands are the last run's own only while the preflight finds it current.
  const current = preflight?.gate.last === 'passed' || preflight?.gate.last === 'failed';
  // Results whose outcome differs from the current run's come from another run.
  const last =
    current && gates?.last && gatesFailed(gates) !== (preflight.gate.last === 'failed')
      ? null
      : (gates?.last ?? null);
  const results = last?.results ?? [];
  // Commands the listed run never reached after a failure, while the session counts that run.
  const notRun =
    last && listed?.finished_at && Date.parse(listed.finished_at) === last.checked_at
      ? (listed.not_run ?? 0)
      : 0;
  const total =
    current || (preflight && !last) ? preflight.gate.configured_total : results.length + notRun;
  // Until its results are read, a current passed run passed every configured command.
  const passed =
    summary === 'cancelled' || summary === 'cancelling'
      ? 0
      : !last && preflight?.gate.last === 'passed'
        ? total
        : results.filter((result) => gateOutcome(result) === 'passed').length;
  const failed =
    summary === 'cancelled' || summary === 'cancelling' ? 0 : results.filter(gateFailing).length;
  // Commands skipped after failing, and those a failed run did not reach.
  const skipped =
    ['passed', 'failed', 'stale'].includes(gate) && last ? Math.max(0, total - passed - failed) : 0;
  return { gate, passed, failed, skipped, running: null, total };
}

const mergingText = () => t({ id: 'sessions.panel.merge.merging', defaultMessage: 'Merging' });
const conflictsText = () => t({ id: 'sessions.mergeBar.conflicts', defaultMessage: 'Conflicts' });

const NO_ITEMS: readonly FeedbackItem[] = [];

/** Sends the items to the session as one message, then takes them off its next message. */
export async function askFix(
  sessionId: string,
  state: string | undefined,
  revision: number | null,
  items: readonly FeedbackItem[],
  attachments?: readonly string[],
): Promise<BridgeResult<unknown>> {
  // A running turn that asks the user lists as waiting, yet still takes a steer.
  const raw = useBoard.getState().board?.sessions.find((s) => s.id === sessionId)?.state;
  const result = await runCommand(
    messageCommand(raw ?? state),
    {
      session_id: sessionId,
      input: withFeedback('', items),
      ...(attachments?.length ? { attachments: [...attachments] } : {}),
    },
    revision,
  ).catch(fail);
  if (result.ok) {
    useFeedback.getState().clear(
      sessionId,
      items.map((item) => item.id),
    );
    for (const item of items) if (item.comment) void commentSent(item.comment);
  }
  return result;
}

/** The inspector's merge readiness: distance from the target, gate counts, and a live session's merge. */
export function MergeBar(props: {
  sessionId: string;
  revision: number | null;
  live: boolean;
  merging: boolean;
  cancelling?: boolean;
  preflight: SessionPreflight | null;
  /** Why the last preflight read failed. */
  preflightError?: string | null;
  /** Reads the preflight again. */
  onPreflight: () => void;
  gates: SessionGates | null;
  /** The source branch as last measured, named until the preflight is read. */
  branch: string | null;
  source: string;
  onChecks: () => void;
  listed?: WorkbenchSession | null;
  /** The worktree's current commit, once its diff was read. */
  head?: string | null;
  /** The items the next message of the session carries. */
  feedback?: readonly FeedbackItem[];
  /** A lead works on a task of its own plan, whose merge keeps the session and its worktree. */
  direct?: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [busy, setBusy] = useState<'gates' | 'fix' | null>(null);
  /** The gates read when the daemon accepted a rerun, until a new read replaces it. */
  const [rerunFrom, setRerunFrom] = useState<SessionGates | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const items = props.feedback ?? NO_ITEMS;
  const { preflight, gates, listed } = props;
  const head = props.head ?? null;
  const { gate, passed, failed, skipped, running, total } = gateCount(
    preflight,
    gates,
    listed?.gate,
  );
  const ran = gates?.last && !gates.running ? gates.last.commit : null;
  // Commands changed since the run also make it stale; only a moved HEAD turns merge off.
  const earlier = !!ran && !!head && ran !== head && preflight?.gate.last === 'stale';
  const current =
    !!ran &&
    (head ? ran === head : preflight?.gate.last === 'passed' || preflight?.gate.last === 'failed');
  const blocked = preflight && !preflight.can_merge ? blockedText(preflight.blocked_reason) : null;
  const earlierText = t({
    id: 'sessions.mergeBar.earlierCommit',
    defaultMessage: 'The gates ran on an earlier commit',
  });
  const reason = blocked ?? (earlier ? earlierText : null);
  const target = preflight ? preflight.target_branch : props.branch;
  const label = props.merging
    ? mergingText()
    : props.listed?.lands
      ? t({ id: 'sessions.panel.merge.land', defaultMessage: 'Land…' })
      : target
        ? t(
            { id: 'sessions.panel.merge.mergeInto', defaultMessage: 'Merge into {target}…' },
            { target },
          )
        : t({ id: 'sessions.panel.merge.merge', defaultMessage: 'Merge…' });
  const reasonId = `merge-blocked-${props.sessionId}`;
  const openSource = t({
    id: 'sessions.panel.merge.openSource',
    defaultMessage: 'Open the source folder',
  });
  const skippedText = () =>
    t({ id: 'sessions.mergeBar.skipped', defaultMessage: '{count} skipped' }, { count: skipped });
  const counted =
    running !== null
      ? listText(
          t(
            { id: 'sessions.mergeBar.passed', defaultMessage: '{count} passed' },
            { count: passed },
          ),
          t(
            { id: 'sessions.mergeBar.running', defaultMessage: '{count} running' },
            { count: running },
          ),
          failed > 0 &&
            t(
              { id: 'sessions.mergeBar.failed', defaultMessage: '{count} failed' },
              { count: failed },
            ),
          skippedText(),
        )
      : ['passed', 'failed', 'stale'].includes(gate)
        ? listText(
            t(
              { id: 'sessions.mergeBar.passed', defaultMessage: '{count} passed' },
              { count: passed },
            ),
            failed > 0 &&
              t(
                { id: 'sessions.mergeBar.failed', defaultMessage: '{count} failed' },
                { count: failed },
              ),
            skipped > 0 && skippedText(),
          )
        : GATE[gate].word;
  const reveal = async (path: string) => {
    const bridge = window.pantheon;
    if (!bridge) return;
    setError(null);
    const result = await bridge.revealPath(path).catch(fail);
    if (!result.ok) setError(failureText(result.error));
  };
  const rerun = async () => {
    if (busy || rerunFrom === gates) return;
    setBusy('gates');
    setError(null);
    const result = await runCommand(
      'session.gates.run',
      { session_id: props.sessionId },
      props.revision,
    ).catch(fail);
    setBusy(null);
    if (result.ok) {
      setRerunFrom(gates);
      props.onPreflight();
    } else setError(failureText(result.error));
  };
  const fix = async () => {
    if (busy || items.length === 0) return;
    setBusy('fix');
    setError(null);
    const result = await askFix(props.sessionId, listed?.state, props.revision, items);
    setBusy(null);
    if (!result.ok) setError(failureText(result.error));
  };
  const merge = (
    <button
      type="button"
      className="btn pri"
      disabled={!preflight || props.merging}
      aria-disabled={reason ? true : undefined}
      aria-describedby={reason ? reasonId : undefined}
      aria-busy={props.merging || undefined}
      onClick={
        reason || !preflight || props.merging
          ? undefined
          : () => {
              props.onPreflight();
              setConfirm(true);
            }
      }
    >
      {label}
    </button>
  );
  return (
    <div className="ss-mb">
      {error && (
        <div className="ss-cerr" role="alert">
          {error}
        </div>
      )}
      {target && listed?.ahead !== undefined && listed.behind !== undefined && (
        <span className="ss-mb-far">
          {t(
            {
              id: 'sessions.mergeBar.distance',
              defaultMessage: '{ahead} ahead of {target}, {behind} behind',
            },
            { target, ahead: listed.ahead, behind: listed.behind },
          )}
        </span>
      )}
      {preflight?.conflicts.state === 'none' && (
        <div className="ss-mb-cf">
          <span>{conflictsText()}</span>
          <span>{t({ id: 'sessions.mergeBar.conflictsNone', defaultMessage: 'None' })}</span>
        </div>
      )}
      {preflight?.conflicts.state === 'conflicts' && (
        <>
          <button
            type="button"
            className="ss-gate ss-mb-cf"
            aria-expanded={conflictsOpen}
            onClick={() => setConflictsOpen(!conflictsOpen)}
          >
            <span>{conflictsText()}</span>
            <span>
              {t(
                {
                  id: 'sessions.mergeBar.conflictFiles',
                  defaultMessage: '{count, plural, one {# file} other {# files}}',
                },
                { count: preflight.conflicts.files?.length ?? 0 },
              )}
            </span>
            <ChevronRight className="ss-gch" aria-hidden="true" />
          </button>
          {conflictsOpen && (
            <ul className="ss-mb-cfl">
              {(preflight.conflicts.files ?? []).map((file) => (
                <li key={file} className="mono" title={file}>
                  {file}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {preflight?.open_comments !== undefined && (
        <div className="ss-mb-cf">
          <span>{t({ id: 'sessions.mergeBar.comments', defaultMessage: 'Comments' })}</span>
          <span>
            {t(
              {
                id: 'sessions.mergeBar.openComments',
                defaultMessage: '{count, plural, one {# open} other {# open}}',
              },
              { count: preflight.open_comments },
            )}
          </span>
        </div>
      )}
      {(props.live || gate !== 'none') && (
        <button
          type="button"
          className="ss-gate ss-mb-gate"
          aria-label={t(
            {
              id: 'sessions.panel.merge.checkStatus',
              defaultMessage: 'Check status {gate} {passed}/{total}',
            },
            { gate: GATE[gate].word, passed, total },
          )}
          onClick={props.onChecks}
        >
          {GATE[gate].icon}
          <span className="ss-pseg" aria-hidden="true">
            {passed > 0 && <i data-tone="ok" style={{ flexGrow: passed }} />}
            {failed > 0 && <i data-tone="bad" style={{ flexGrow: failed }} />}
            {!!running && <i data-tone="run" style={{ flexGrow: running }} />}
            {total - passed - failed - (running ?? 0) > 0 && (
              <i data-tone="idle" style={{ flexGrow: total - passed - failed - (running ?? 0) }} />
            )}
          </span>
          <span>{counted}</span>
          <ChevronRight className="ss-gch" aria-hidden="true" />
        </button>
      )}
      {ran && (current || earlier) && (
        <div className="ss-mb-at">
          {earlier ? <GateMark state="stale" /> : <Check aria-hidden="true" />}
          <span id={earlier && !blocked ? reasonId : undefined}>
            {earlier
              ? earlierText
              : t({
                  id: 'sessions.mergeBar.currentCommit',
                  defaultMessage: 'The gates ran on the current commit',
                })}
          </span>
          <span className="mono" title={ran}>
            {shortId(ran)}
          </span>
          {earlier && props.live && !props.merging && (
            <button
              type="button"
              className="btn sm"
              disabled={busy !== null || rerunFrom === gates}
              aria-busy={busy === 'gates' || rerunFrom === gates || undefined}
              onClick={() => void rerun()}
            >
              {t({ id: 'sessions.mergeBar.rerun', defaultMessage: 'Rerun gates' })}
            </button>
          )}
        </div>
      )}
      {props.live && !props.merging && preflight?.blocked_reason !== 'no_changes' && (
        <span className="ss-mb-then">
          {props.direct
            ? t({
                id: 'sessions.mergeBar.directConsequence',
                defaultMessage: 'Merging keeps the session and its worktree.',
              })
            : t({
                id: 'sessions.mergeBar.consequence',
                defaultMessage: 'Merging ends the session and removes its worktree.',
              })}
        </span>
      )}
      {props.live && blocked && (
        <span id={reasonId} className="ss-mb-why">
          {blocked}
        </span>
      )}
      <div className="ss-cacts">
        {props.live && (
          <>
            {preflight && !preflight.source_clean && (
              <Tip content={openSource}>
                <button
                  type="button"
                  className="ib"
                  aria-label={openSource}
                  onClick={() => void reveal(preflight.source_root)}
                >
                  <FolderOpen aria-hidden="true" />
                </button>
              </Tip>
            )}
            {merge}
            {props.merging && (
              <CancelOperation
                kind="merge"
                sessionId={props.sessionId}
                revision={props.revision}
                cancelling={props.cancelling}
                onAccepted={props.onPreflight}
              />
            )}
            {(preflight || confirm) && (
              <MergeDialog
                open={confirm}
                sessionId={props.sessionId}
                revision={props.revision}
                preflight={preflight}
                error={props.preflightError}
                source={props.source}
                lands={!!props.listed?.lands}
                onClose={() => setConfirm(false)}
              />
            )}
          </>
        )}
      </div>
      {props.live && !props.merging && (
        <div className="ss-mb-acts">
          {items.length > 0 && (
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              aria-busy={busy === 'fix' || undefined}
              onClick={() => void fix()}
            >
              {t(
                {
                  id: 'sessions.mergeBar.fix',
                  defaultMessage:
                    'Ask the agent to fix {count, plural, one {# item} other {# items}}',
                },
                { count: items.length },
              )}
            </button>
          )}
          <button type="button" className="btn ghost dng" onClick={() => setDiscarding(true)}>
            {t({ id: 'sessions.mergeBar.discard', defaultMessage: 'Discard…' })}
          </button>
          <DiscardDialog
            open={discarding}
            title={props.source}
            sessionId={props.sessionId}
            revision={props.revision}
            listed={props.listed}
            onClose={() => setDiscarding(false)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Confirms a merge with its route, size and last gate result, then sends it. Merge waits for the
 * preflight read after opening, which the dialog then shows; a later read that differs turns merge off.
 */
export function MergeDialog(props: {
  open: boolean;
  sessionId: string;
  revision: number | null;
  /** null after a failed read. */
  preflight: SessionPreflight | null;
  /** Why the last preflight read failed. */
  error?: string | null;
  /** The worktree being merged. */
  source: string;
  /** The session lands on the project folder's branch instead of merging a worktree. */
  lands?: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{
    opened: SessionPreflight;
    read: SessionPreflight | null;
  } | null>(null);
  if (props.open && !review && props.preflight) setReview({ opened: props.preflight, read: null });
  if (!props.open && review) setReview(null);
  if (review && !review.read && props.preflight && props.preflight !== review.opened)
    setReview({ ...review, read: props.preflight });
  const failed = !props.preflight;
  const reading = !review?.read;
  // The preflight names no HEAD, so its counts and checks stand for the state reviewed.
  const changed =
    !!review?.read &&
    !!props.preflight &&
    JSON.stringify(review.read) !== JSON.stringify(props.preflight);
  const blocked = !!review?.read && !review.read.can_merge;
  const preflight = review?.read ?? props.preflight ?? review?.opened;
  if (!preflight) return null;
  const target = preflight.target_branch ?? '—';
  const loading = reading && !failed;
  const value = (shown: ReactNode) =>
    loading ? (
      <dd>
        <Skeleton style={{ width: 48 }} />
      </dd>
    ) : (
      <dd>{shown}</dd>
    );

  const merge = async () => {
    if (busy || reading || changed || blocked || failed) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'session.merge',
      { session_id: props.sessionId },
      props.revision,
    ).catch(fail);
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result.error));
      return;
    }
    props.onClose();
  };

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(next) => {
        if (next || busy) return;
        setError(null);
        props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
        <Dialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <Dialog.Title className="pj-dt">
              {props.lands
                ? t(
                    {
                      id: 'sessions.panel.mergeDialog.landTitle',
                      defaultMessage: 'Land on {target}',
                    },
                    { target },
                  )
                : t(
                    {
                      id: 'sessions.panel.mergeDialog.title',
                      defaultMessage: 'Merge into {target}',
                    },
                    { target },
                  )}
            </Dialog.Title>
          </div>
          <div className="pj-rm-body">
            <div className="ss-mgr mono">
              <span title={props.source}>{props.source}</span>
              {' → '}
              <span>{target}</span>
            </div>
            <dl className="ss-mgf" aria-busy={loading || undefined}>
              <dt>{t({ id: 'sessions.panel.mergeDialog.commits', defaultMessage: 'Commits' })}</dt>
              {value(preflight.commit_count)}
              <dt>
                {t({ id: 'sessions.panel.mergeDialog.files', defaultMessage: 'Files changed' })}
              </dt>
              {value(preflight.files_changed)}
              <dt>{t({ id: 'sessions.panel.mergeDialog.gates', defaultMessage: 'Gates' })}</dt>
              {value(LAST_GATE[preflight.gate.last])}
            </dl>
            {preflight.gate.configured_total > 0 && !props.lands && (
              <Dialog.Description className="ss-mgd">
                {t({
                  id: 'sessions.panel.mergeDialog.gatesRerun',
                  defaultMessage: 'The gates run again before the merge',
                })}
              </Dialog.Description>
            )}
          </div>
          {(error || failed || changed || blocked) && (
            <div className="pj-err" role="alert">
              <b>
                {error ??
                  (failed
                    ? (props.error ??
                      t({
                        id: 'sessions.panel.mergeDialog.readFailed',
                        defaultMessage: 'The merge conditions could not be read.',
                      }))
                    : changed
                      ? t({
                          id: 'sessions.panel.mergeDialog.changed',
                          defaultMessage: 'The merge conditions changed. Open this again.',
                        })
                      : blockedText(preflight.blocked_reason))}
              </b>
            </div>
          )}
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <Dialog.Close className="btn ghost" disabled={busy}>
              {t({ id: 'sessions.panel.mergeDialog.cancel', defaultMessage: 'Cancel' })}
            </Dialog.Close>
            <button
              type="button"
              className="btn pri"
              disabled={busy || reading || changed || blocked || failed}
              aria-busy={busy || loading || undefined}
              onClick={() => void merge()}
            >
              {props.lands
                ? t({ id: 'sessions.panel.mergeDialog.land', defaultMessage: 'Land' })
                : t({ id: 'sessions.panel.mergeDialog.merge', defaultMessage: 'Merge' })}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
