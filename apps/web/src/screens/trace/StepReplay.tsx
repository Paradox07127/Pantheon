import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LoadError } from '../../components/LoadError';
import { Pause, Play, Undo2 } from 'lucide-react';
import { DiffFiles } from '../../components/DiffReview';
import { SessionStateIcon } from '../../components/SessionStateIcon';
import { Skeleton } from '../../components/Skeleton';
import {
  replayClock,
  replaySteps,
  stepMoment,
  useStepDiff,
  type StepKind,
  type StepMoment,
} from '../../data/step-replay';
import { useSessionTrace } from '../../data/trace';
import { useSessionList } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { listedTitle } from '../../lib/daemon-text';
import { shortcutKeys, shortcutMatches } from '../../lib/shortcuts';
import { ContextRing } from '../board/FlowNode';
import { tokenText } from '../board/panels-model';
import type { ReplaySpeed, TraceSpan } from './model';
import { ReplayKeys, useReplayKeys } from './Replay';
import { EmptyState } from '../../components/EmptyState';
import './step-replay.css';

export interface StepReplayProps {
  /** A Pantheon session; its id is its trace lane's key. */
  sessionId: string;
  projectId: string;
  /** The timeline's replay speed; 1x without one. */
  speed?: ReplaySpeed;
}

const KIND_TEXT: Record<Exclude<StepKind, 'other'>, () => string> = {
  read: () => t({ id: 'trace.stepReplay.kind.read', defaultMessage: 'Read' }),
  search: () => t({ id: 'trace.stepReplay.kind.search', defaultMessage: 'Search' }),
  edit: () => t({ id: 'trace.stepReplay.kind.edit', defaultMessage: 'Edit' }),
  run: () => t({ id: 'trace.stepReplay.kind.run', defaultMessage: 'Run' }),
};

const TESTS_TEXT: Record<StepMoment['tests'], () => string> = {
  passed: () => t({ id: 'trace.stepReplay.tests.passed', defaultMessage: 'Passed' }),
  failed: () => t({ id: 'trace.stepReplay.tests.failed', defaultMessage: 'Failed' }),
  none: () => t({ id: 'trace.stepReplay.tests.none', defaultMessage: 'Not run yet' }),
};

const NO_SPANS: TraceSpan[] = [];
/** How long playing stays on a step at 1x. */
const STEP_MS = 1000;

/** One session's tool calls one at a time: the list, the step's diff and the session as it stood then. */
export function StepReplay({ sessionId, projectId, speed = 1 }: StepReplayProps) {
  const trace = useSessionTrace(projectId, sessionId);
  const listed = useSessionList(projectId).data?.find((s) => s.id === sessionId) ?? null;
  const spans = trace.data?.spans ?? NO_SPANS;
  const { steps, total } = useMemo(() => replaySteps(spans), [spans]);
  // Held by span id, so a refreshed trace keeps the step.
  const [picked, setPicked] = useState<string | null>(null);
  const index = Math.max(
    0,
    steps.findIndex((s) => s.span.id === picked),
  );
  const step = steps[index] ?? null;
  const diff = useStepDiff(sessionId, step && { turn: step.span.turn, id: step.span.id });
  const moment = useMemo(
    () => (steps[index] ? stepMoment(spans, steps, index) : null),
    [spans, steps, index],
  );
  const rows = useRef(new Map<number, HTMLElement>());
  useEffect(() => rows.current.get(index)?.scrollIntoView({ block: 'nearest' }), [index]);

  const go = (to: number) => {
    const next = steps[Math.min(Math.max(to, 0), steps.length - 1)];
    if (next) setPicked(next.span.id);
  };
  const [playing, setPlaying] = useState(false);
  const last = index >= steps.length - 1;
  const toggle = () => {
    if (!playing && last) go(0);
    setPlaying(!playing);
  };
  useEffect(() => {
    if (!playing) return;
    if (last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setPicked(steps[index + 1]!.span.id), STEP_MS / speed);
    return () => clearTimeout(timer);
  }, [playing, last, index, steps, speed]);
  useReplayKeys((delta) => go(index + delta), toggle);
  const seek = (value: number) => {
    let to = 0;
    steps.forEach((s, i) => {
      if (s.at <= value) to = i;
    });
    go(to);
  };
  const optionId = (i: number) => `srp-${sessionId}-${i}`;
  const title = listed ? listedTitle(listed) : trace.data?.lane.title;
  const share = (at: number) => (total > 0 ? (at / total) * 100 : 0);

  const cell = (label: string, value: ReactNode) => (
    <div className="cell">
      <span className="cap">{label}</span>
      <span className="srp-num">{value}</span>
    </div>
  );

  return (
    <div className="srp">
      <div className="srp-bar">
        <span className="chip srp-chip">
          {listed && <SessionStateIcon session={listed} place="list" />}
          <span className="srp-name">{title}</span>
        </span>
      </div>
      <div className="srp-cols">
        <section
          className="srp-steps"
          aria-label={t({ id: 'trace.stepReplay.steps', defaultMessage: 'Steps' })}
        >
          {trace.data === null && trace.error ? (
            <LoadError message={trace.error} onRetry={trace.reload} />
          ) : trace.data === null ? (
            <Skeleton className="srp-skel" />
          ) : steps.length === 0 ? (
            <EmptyState
              inline
              title={t({ id: 'trace.stepReplay.empty', defaultMessage: 'No tool calls recorded' })}
            />
          ) : (
            <div
              className="srp-list"
              role="listbox"
              tabIndex={0}
              aria-label={t({ id: 'trace.stepReplay.steps', defaultMessage: 'Steps' })}
              aria-activedescendant={optionId(index)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || shortcutMatches('list-up', e)) go(index - 1);
                else if (e.key === 'ArrowRight' || shortcutMatches('list-down', e)) go(index + 1);
                else return;
                e.preventDefault();
              }}
            >
              {steps.map((s, i) => (
                <div
                  key={s.span.id}
                  id={optionId(i)}
                  ref={(el) => {
                    if (el) rows.current.set(i, el);
                    else rows.current.delete(i);
                  }}
                  className="srp-row"
                  role="option"
                  aria-selected={i === index}
                  onClick={() => go(i)}
                >
                  <span className="srp-kind">
                    {s.kind === 'other' ? s.span.name : KIND_TEXT[s.kind]()}
                  </span>
                  <span className="srp-subj">{s.subject}</span>
                  <span className="srp-t">{replayClock(s.at)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section
          className="srp-diff"
          aria-label={t({ id: 'trace.stepReplay.diff', defaultMessage: 'What this step changed' })}
        >
          {step && (
            <>
              <div className="srp-head">
                <span className="srp-subj">{step.subject}</span>
                <span className="srp-of">
                  {t(
                    { id: 'trace.stepReplay.position', defaultMessage: 'Step {n} of {total}' },
                    { n: index + 1, total: steps.length },
                  )}
                </span>
              </div>
              {diff.data?.files.length === 0 ? (
                <EmptyState
                  inline
                  title={t({
                    id: 'trace.stepReplay.noChanges',
                    defaultMessage: 'This step changed no files',
                  })}
                />
              ) : (
                <DiffFiles diff={diff} />
              )}
            </>
          )}
        </section>
        <aside
          className="srp-now"
          aria-label={t({ id: 'trace.stepReplay.moment', defaultMessage: 'State at this step' })}
        >
          <span className="cap">
            {t({ id: 'trace.stepReplay.momentTitle', defaultMessage: 'At this moment' })}
          </span>
          {moment && (
            <div className="panel srp-cells">
              {cell(
                t({ id: 'trace.stepReplay.context', defaultMessage: 'Context' }),
                moment.context ? (
                  <>
                    <ContextRing context={moment.context} />
                    {`${Math.min(100, Math.round((moment.context.used_tokens / moment.context.window_tokens) * 100))}%`}
                  </>
                ) : (
                  '—'
                ),
              )}
              {cell(
                t({ id: 'trace.stepReplay.tokens', defaultMessage: 'Tokens used' }),
                tokenText(moment.tokens),
              )}
              {cell(
                t({ id: 'trace.stepReplay.files', defaultMessage: 'Files changed' }),
                moment.files,
              )}
              {cell(
                t({ id: 'trace.stepReplay.tests', defaultMessage: 'Tests' }),
                TESTS_TEXT[moment.tests](),
              )}
            </div>
          )}
        </aside>
      </div>
      <footer className="srp-foot">
        <button
          type="button"
          className="ib"
          aria-label={t({ id: 'trace.stepReplay.previous', defaultMessage: 'Previous step' })}
          disabled={index === 0}
          onClick={() => go(index - 1)}
        >
          <Undo2 aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ib"
          aria-label={
            playing
              ? t({ id: 'trace.replay.pause', defaultMessage: 'Pause' })
              : t({ id: 'trace.replay.play', defaultMessage: 'Play' })
          }
          aria-keyshortcuts={shortcutKeys('replay-play') || undefined}
          disabled={!step}
          onClick={toggle}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <span className="srp-at">{replayClock(step?.at ?? 0)}</span>
        <div className="srp-scrub">
          <span className="srp-fill" style={{ width: `${share(step?.at ?? 0)}%` }} />
          {steps.map((s, i) => (
            <i
              key={s.span.id}
              className="srp-mk"
              data-on={i === index || undefined}
              data-error={s.span.status === 'error' || undefined}
              style={{ left: `${share(s.at)}%` }}
            />
          ))}
          <input
            type="range"
            className="srp-range"
            aria-label={t({ id: 'trace.stepReplay.slider', defaultMessage: 'Replay position' })}
            aria-valuetext={replayClock(step?.at ?? 0)}
            min={0}
            max={total}
            step={1}
            value={step?.at ?? 0}
            disabled={!step}
            onChange={(e) => seek(Number(e.target.value))}
          />
        </div>
        <span className="srp-total">{replayClock(total)}</span>
        <ReplayKeys />
      </footer>
    </div>
  );
}
