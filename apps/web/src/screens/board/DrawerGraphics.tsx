import { useState, type CSSProperties } from 'react';
import { Flag, X } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { DiffCounts } from '../../components/DiffCounts';
import { PathText } from '../../components/PathText';
import { useSessionGatesHistory } from '../../data/session-panel';
import { useSessionDiff } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { useShell } from '../../store';
import { durationText, type RunBoardCommand } from './panels-model';
import { StateIcon, StatusIcon } from './status';
import './drawer-graphics.css';

type Task = BoardModel['tasks'][number];
type GateStep = NonNullable<Task['gate_steps']>[number];
type Rung = NonNullable<Task['rung']>;

const failedFirst = (steps: readonly GateStep[]) => [
  ...steps.filter((s) => s.state === 'failed'),
  ...steps.filter((s) => s.state !== 'failed'),
];

const testsFailedText = (count: number) =>
  t(
    {
      id: 'board.drawer.gate.testsFailed',
      defaultMessage: '{count, plural, one {# test failed} other {# tests failed}}',
    },
    { count },
  );

/** One block per gate step, failed first, each as wide as the step took; even widths without every step's time. */
function gatePipeline(steps: readonly GateStep[], durations: ReadonlyMap<string, number>) {
  const ordered = failedFirst(steps);
  const timed = ordered.every((s) => durations.has(s.name));
  const said = ordered.map((step) => {
    const ms = durations.get(step.name);
    return listText(
      t(
        {
          id: 'board.drawer.gate.step',
          defaultMessage:
            '{name}: {state, select, passed {passed} failed {failed} running {running} skipped {skipped} other {not run}}',
        },
        { name: step.name, state: step.state },
      ),
      step.state === 'failed' && !!step.tests?.failed && testsFailedText(step.tests.failed),
      ms !== undefined && durationText(ms),
    );
  });
  return (
    <div
      className="bd-gp"
      role="img"
      aria-label={t(
        {
          id: 'board.drawer.gate.label',
          defaultMessage: 'Checks, {count, plural, one {# step} other {# steps}}: {steps}',
        },
        { count: ordered.length, steps: listText(...said) },
      )}
    >
      {ordered.map((step, i) => {
        const ms = durations.get(step.name);
        return (
          <div
            key={i}
            className="bd-gp-s"
            data-state={step.state}
            style={{ flexGrow: timed ? Math.max(1, ms!) : 1 }}
          >
            <span className="bd-gp-b">
              {step.state === 'failed' &&
                !!step.tests?.failed &&
                testsFailedText(step.tests.failed)}
            </span>
            <span className="bd-gp-n">{step.name}</span>
            {ms !== undefined && <span className="bd-gp-t">{durationText(ms)}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** The checks section: the gate pipeline timed by the session's newest gate run, its log and a rerun of the failed steps. */
export function GateChecks({
  steps,
  sessionId,
  revision,
  run,
}: {
  steps: readonly GateStep[];
  sessionId: string | null;
  revision: number | null;
  run?: RunBoardCommand | undefined;
}) {
  const history = useSessionGatesHistory(sessionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const durations = new Map(
    (history.data?.runs[0]?.results ?? []).flatMap((r) =>
      r.duration_ms === undefined ? [] : [[r.name, r.duration_ms] as const],
    ),
  );
  const total = steps.every((s) => durations.has(s.name))
    ? steps.reduce((sum, s) => sum + durations.get(s.name)!, 0)
    : null;
  const rerun = async () => {
    if (!sessionId || !run || busy) return;
    setBusy(true);
    setError(null);
    const failure = await run(
      'session.gates.run',
      { session_id: sessionId, only_failed: true },
      revision,
    );
    setBusy(false);
    setError(failure);
  };
  return (
    <section className="bd-dsec" aria-labelledby="bd-dchecks">
      <div className="bd-dsh">
        <h3 id="bd-dchecks">{t({ id: 'board.task.drawer.checks', defaultMessage: 'Checks' })}</h3>
        {total !== null && <span className="bd-dsv">{durationText(total)}</span>}
      </div>
      {gatePipeline(steps, durations)}
      {sessionId && (
        <div className="bd-gpa">
          <button
            type="button"
            className="btn sm"
            onClick={() => useShell.getState().openSession(sessionId, 'checks')}
          >
            {t({ id: 'board.drawer.gate.log', defaultMessage: 'View log' })}
          </button>
          {run && steps.some((s) => s.state === 'failed') && (
            <button
              type="button"
              className="btn sm"
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={() => void rerun()}
            >
              {t({
                id: 'board.drawer.gate.rerunFailed',
                defaultMessage: 'Rerun only the failed steps',
              })}
            </button>
          )}
          {error && (
            <span className="bd-derr" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

interface EscalationStep {
  key: string;
  label: string;
  retry: boolean;
  at?: 'done' | 'now';
}

/** The rungs in order: a worker fix per retry the limit allows, another runtime while that is the rung, the lead, the user. */
function escalationSteps(rung: Rung): EscalationStep[] {
  const tries = Math.max(1, rung.limit ?? rung.used ?? 1);
  const steps: EscalationStep[] = [
    ...Array.from({ length: tries }, (_, i) => ({
      key: `retry-${i}`,
      label: t({ id: 'board.drawer.esc.retry', defaultMessage: 'Worker fix {n}' }, { n: i + 1 }),
      retry: true,
    })),
    ...(rung.rung === 'switch'
      ? [
          {
            key: 'switch',
            label: t({ id: 'board.recovery.step.switch', defaultMessage: 'Another runtime' }),
            retry: false,
          },
        ]
      : []),
    {
      key: 'lead',
      label: t({ id: 'board.drawer.esc.lead', defaultMessage: 'Lead reassigns' }),
      retry: false,
    },
    {
      key: 'user',
      label: t({ id: 'board.drawer.esc.user', defaultMessage: 'Handed to you' }),
      retry: false,
    },
  ];
  // The tries used count the fix under way.
  const at =
    rung.rung === 'retry'
      ? Math.min(tries, Math.max(1, rung.used ?? 1)) - 1
      : rung.rung === 'user'
        ? steps.length - 1
        : tries;
  return steps.map((step, i) =>
    i < at ? { ...step, at: 'done' } : i === at ? { ...step, at: 'now' } : step,
  );
}

const ESC_MARK = {
  failed: () => t({ id: 'board.task.step.failed', defaultMessage: 'Failed' }),
  done: () => t({ id: 'board.recovery.step.done', defaultMessage: 'Done' }),
  now: () => t({ id: 'board.recovery.step.current', defaultMessage: 'Current' }),
  ahead: () => t({ id: 'board.recovery.step.ahead', defaultMessage: 'Not reached' }),
};

/** Who acts next, as a track: passed rungs filled, a passed fix crossed out, the current one ringed. */
export function escalationTrack(rung: Rung) {
  const steps = escalationSteps(rung);
  const at = steps.findIndex((s) => s.at === 'now');
  return (
    <ol
      className="bd-esc"
      style={{ '--bd-esc-n': steps.length, '--bd-esc-at': at } as CSSProperties}
      aria-label={t(
        {
          id: 'board.drawer.esc.label',
          defaultMessage: '{count} steps, at step {step}: {current}',
        },
        { count: steps.length, step: at + 1, current: steps[at]!.label },
      )}
    >
      {steps.map((step) => (
        <li key={step.key} data-at={step.at} aria-current={step.at === 'now' ? 'step' : undefined}>
          <span
            className="bd-esc-k"
            data-failed={(step.at === 'done' && step.retry) || undefined}
            role="img"
            aria-label={
              step.at === 'done'
                ? step.retry
                  ? ESC_MARK.failed()
                  : ESC_MARK.done()
                : step.at === 'now'
                  ? ESC_MARK.now()
                  : ESC_MARK.ahead()
            }
          >
            {step.at === 'done' && step.retry && <X aria-hidden="true" />}
          </span>
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** A budget share as a ring, with its name, percent and amounts beside it. */
export function budgetRing({
  key,
  label,
  meter,
  share,
  used,
  limit,
  max,
}: {
  key: string;
  label: string;
  meter: string;
  share: number;
  used: string;
  limit: string;
  max?: true | undefined;
}) {
  const percent = Math.round(share * 100);
  return (
    <div key={key} className="bd-drg-r">
      <svg
        className="bd-drg-c"
        width="40"
        height="40"
        viewBox="0 0 32 32"
        role="img"
        aria-label={meter}
        data-max={max}
      >
        <circle cx="16" cy="16" r="13" pathLength={100} />
        <circle
          cx="16"
          cy="16"
          r="13"
          pathLength={100}
          strokeDasharray={`${Math.min(100, percent)} 100`}
          transform="rotate(-90 16 16)"
        />
      </svg>
      <div className="bd-drg-t">
        <span>
          {label} <b>{percent}%</b>
        </span>
        <span className="bd-drg-n">
          {t(
            { id: 'board.recovery.budget.amount', defaultMessage: '{used} / {limit}' },
            { used, limit },
          )}
        </span>
      </div>
    </div>
  );
}

/** Five cells split between added and removed lines. */
export function diffCells(additions: number, deletions: number) {
  const total = additions + deletions;
  if (!total) return null;
  const added = Math.round((additions / total) * 5);
  return (
    <span
      className="bd-dcells"
      role="img"
      aria-label={t(
        {
          id: 'board.drawer.changes.total',
          defaultMessage: '{additions} lines added, {deletions} removed',
        },
        { additions, deletions },
      )}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} data-k={i < added ? 'a' : 'd'} />
      ))}
    </span>
  );
}

type DiffFile = { path: string; additions: number | null; deletions: number | null };

/** One row per changed file, its bar scaled to the file with the most changed lines. */
function fileBars(files: readonly DiffFile[]) {
  if (!files.length) return null;
  const top = Math.max(1, ...files.map((f) => (f.additions ?? 0) + (f.deletions ?? 0)));
  return (
    <ul className="bd-dfl">
      {files.map((file) => {
        const added = file.additions ?? 0;
        const removed = file.deletions ?? 0;
        return (
          <li key={file.path}>
            <div className="bd-dfl-h">
              <PathText path={file.path} className="mono" />
              <span className="bd-dfx">
                <DiffCounts additions={file.additions} deletions={file.deletions} />
              </span>
            </div>
            <span
              className="bd-dfb"
              role="img"
              aria-label={t(
                {
                  id: 'board.drawer.changes.file',
                  defaultMessage: '{path}: {additions} lines added, {deletions} removed',
                },
                { path: file.path, additions: added, deletions: removed },
              )}
            >
              <i data-k="a" style={{ flexGrow: added }} />
              <i data-k="d" style={{ flexGrow: removed }} />
              <i style={{ flexGrow: top - added - removed }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The changed files of the task's session; nothing until they are read. */
export function ChangedFiles({ sessionId }: { sessionId: string }) {
  const diff = useSessionDiff(sessionId);
  return diff.data ? fileBars(diff.data.files) : null;
}

const BOX = 24;
const GAP = 8;
const LINK = 16;

/** The upstream tasks, the task and its milestone, joined by curves; a met dependency's curve is green. */
export function dependencyGraph({
  task,
  ups,
  milestone,
}: {
  task: Task;
  ups: readonly { task: Task; met: boolean }[];
  milestone: { title: string; done: number; total: number } | null;
}) {
  const column = ups.length * BOX + Math.max(0, ups.length - 1) * GAP;
  const height = Math.max(column, 40);
  const mid = height / 2;
  const glyph = (t: Task) =>
    t.state ? <StateIcon state={t.state} /> : <StatusIcon status={t.status} />;
  return (
    <div
      className="bd-dg"
      data-ups={ups.length > 0 || undefined}
      data-ms={milestone !== null || undefined}
      style={{ height }}
      role="img"
      aria-label={listText(
        ups.length > 0 &&
          t(
            {
              id: 'board.drawer.deps.upstream',
              defaultMessage:
                '{count, plural, one {# upstream task} other {# upstream tasks}}, {met} met: {titles}',
            },
            {
              count: ups.length,
              met: ups.filter((u) => u.met).length,
              titles: listText(...ups.map((u) => u.task.title)),
            },
          ),
        milestone &&
          t(
            {
              id: 'board.drawer.deps.milestone',
              defaultMessage: 'Milestone {title}, {done} / {total}',
            },
            milestone,
          ),
      )}
    >
      {ups.length > 0 && (
        <>
          <div className="bd-dg-c">
            {ups.map((up) => (
              <span key={up.task.id} className="bd-dg-n">
                {glyph(up.task)}
                <Clip text={up.task.title} />
              </span>
            ))}
          </div>
          <svg width={LINK} height={height} viewBox={`0 0 ${LINK} ${height}`} aria-hidden="true">
            {ups.map((up, i) => {
              const y = (height - column) / 2 + i * (BOX + GAP) + BOX / 2;
              return (
                <path
                  key={up.task.id}
                  data-met={up.met || undefined}
                  d={`M0 ${y} C${LINK / 2} ${y} ${LINK / 2} ${mid} ${LINK} ${mid}`}
                />
              );
            })}
          </svg>
        </>
      )}
      <span className="bd-dg-n bd-dg-me">
        {glyph(task)}
        <Clip text={task.title} />
      </span>
      {milestone && (
        <>
          <svg width={LINK} height={height} viewBox={`0 0 ${LINK} ${height}`} aria-hidden="true">
            <path data-met={task.state === 'merged' || undefined} d={`M0 ${mid} L${LINK} ${mid}`} />
          </svg>
          <span className="bd-dg-ms">
            <span className="bd-dg-mh">
              <Flag aria-hidden="true" />
              <span className="bd-dg-mn">
                {milestone.done} / {milestone.total}
              </span>
            </span>
            <Clip text={milestone.title} />
          </span>
        </>
      )}
    </div>
  );
}
