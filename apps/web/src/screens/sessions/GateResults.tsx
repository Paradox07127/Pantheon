import { useState, type CSSProperties, type ReactElement } from 'react';
import type { SessionGateRun, SessionGates } from '@pantheon/protocol';
import { Bot, Check, Copy, Minus, Timer, X } from 'lucide-react';
import { Tip } from '../../components/Tip';
import type { FeedbackItem } from '../../data/feedback';
import { elapsedText } from '../../data/transcript';
import { t } from '../../i18n';
import { GATE_STATES } from '../board/quality-model';
import { checkItem, gateOutcome } from './model';
import './gate-results.css';

type GateResult = NonNullable<SessionGates['last']>['results'][number];
type StepState = 'passed' | 'failed' | 'timed_out' | 'skipped' | 'not_run';

export interface GateResultsProps {
  /** The newest gate result recorded for the session. */
  last: SessionGates['last'];
  /** The recorded run of `last`: each command's argv and duration, and those skipped after a failure. */
  run?: SessionGateRun;
  /** Names of the commands a run checks, listed as not run while there is no result. */
  planned?: string[];
  /** A gate run is in progress. */
  running: boolean;
  readOnly: boolean;
  /** A message to the session is on its way. */
  busy?: boolean;
  /** Ids of the items the next message carries. */
  attached?: ReadonlySet<string>;
  onAttach?: (item: FeedbackItem) => void;
  /** Sends the output of the failed commands to the agent. */
  onFix?: (items: FeedbackItem[]) => void;
}

interface Step {
  index: number;
  name: string;
  state: StepState;
  result?: GateResult;
  command?: string[];
  took?: number;
  tests?: GateResult['tests'];
  /** Not run this time; the result of the previous passing run stands. */
  carried?: boolean;
}

const ICON: Record<StepState, ReactElement> = {
  passed: <Check aria-hidden="true" />,
  failed: <X aria-hidden="true" />,
  timed_out: <Timer aria-hidden="true" />,
  skipped: <Minus aria-hidden="true" />,
  not_run: <Minus aria-hidden="true" />,
};

const notRunLabel = () => t({ id: 'sessions.gateResults.group.notRun', defaultMessage: 'Not run' });

// Labels are getters, so each is read in the language loaded by then.
const GROUPS: { has: (step: Step) => boolean; readonly label: string }[] = [
  {
    has: (s) => s.state === 'failed' || s.state === 'timed_out',
    get label() {
      return t({ id: 'sessions.gateResults.group.failed', defaultMessage: 'Failed' });
    },
  },
  {
    has: (s) => s.state === 'passed',
    get label() {
      return t({ id: 'sessions.gateResults.group.passed', defaultMessage: 'Passed' });
    },
  },
  {
    // Ran and failed, but the command may be skipped.
    has: (s) => s.state === 'skipped',
    get label() {
      return t({ id: 'sessions.gateResults.group.skipped', defaultMessage: 'Skipped' });
    },
  },
  {
    has: (s) => s.state === 'not_run',
    get label() {
      return notRunLabel();
    },
  },
];

/** Why a command that failed was skipped: how it ended, or the last line it printed. */
function skipReason(result: GateResult): string {
  if (result.timed_out || result.reason === 'timeout')
    return t({ id: 'sessions.gateResults.skip.timeout', defaultMessage: 'Timed out' });
  if (result.reason === 'cannot_start')
    return t({ id: 'sessions.gateResults.skip.cannotStart', defaultMessage: 'Could not start' });
  return (
    plain(result.reason ?? result.output_tail)
      .split('\n')
      .map((l) => l.trim())
      .findLast(Boolean) ?? ''
  );
}

/** The text without terminal colour codes. */
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** Lines of test, compiler and stack output that report a failure. */
const FAILURE =
  /^\s*(?:[\u2717\u2718\u00d7]|FAIL\b|not ok\b|ERR!|\w*Error\b)|\berror(?:\[\w+\])?:|\berror TS\d|^\s+at\s|panicked/;

/** The log as runs of lines, each run either reporting a failure or not. */
function segments(log: string): { text: string; failed: boolean }[] {
  const runs: { lines: string[]; failed: boolean }[] = [];
  for (const line of log.split('\n')) {
    const failed = FAILURE.test(line);
    const prev = runs.at(-1);
    if (prev?.failed === failed) prev.lines.push(line);
    else runs.push({ lines: [line], failed });
  }
  return runs.map((r) => ({ text: r.lines.join('\n'), failed: r.failed }));
}

/**
 * A gate result by outcome, failed commands first, each with its duration against the longest; a
 * command opens its log with the command line, exit code, the way to the other failures and a copy.
 */
export function GateResults(props: GateResultsProps) {
  const [open, setOpen] = useState<number | null>(null);
  const { last, run } = props;
  const recorded: Step[] = (last?.results ?? []).map((result, index) => {
    const at = run?.results[index]?.name === result.name ? run.results[index] : undefined;
    const carried = result.carried ?? at?.carried;
    return {
      index,
      name: result.name,
      state: gateOutcome(result),
      result,
      command: at?.command,
      // A carried step took its time in an earlier run.
      took: carried ? undefined : at?.duration_ms,
      tests: result.tests ?? at?.tests,
      carried,
    };
  });
  const notRun: Step[] = !last
    ? props.running
      ? []
      : (props.planned ?? []).map((name, index) => ({ index, name, state: 'not_run' }))
    : run
      ? run.results.slice(last.results.length).flatMap((r, i) =>
          r.skipped
            ? [
                {
                  index: last.results.length + i,
                  name: r.name,
                  state: 'not_run',
                  command: r.command,
                },
              ]
            : [],
        )
      : [];
  const steps = [...recorded, ...notRun];
  const longest = Math.max(0, ...steps.map((s) => s.took ?? 0));
  const failures = recorded.filter((s) => s.state === 'failed' || s.state === 'timed_out');
  const shown = recorded.find((s) => s.index === open);
  const at = shown ? failures.indexOf(shown) : -1;
  const fix = !props.readOnly && failures.length > 0 && props.onFix;
  return (
    <div className="gres">
      {props.running && (
        <div className="gres-run" role="status">
          {t({ id: 'sessions.gateResults.running', defaultMessage: 'Gates running' })}
        </div>
      )}
      {fix && (
        <div className="gres-acts">
          <button
            type="button"
            className="btn pri"
            disabled={props.running || props.busy}
            aria-busy={props.busy || undefined}
            onClick={() =>
              props.onFix!(failures.map((s) => checkItem(s.result!, last!.checked_at, s.index)))
            }
          >
            <Bot aria-hidden="true" />
            {t({ id: 'sessions.gateResults.fix', defaultMessage: 'Ask the agent to fix' })}
          </button>
        </div>
      )}
      {GROUPS.map((group) => {
        const members = steps.filter(group.has);
        if (members.length === 0) return null;
        return (
          <section key={group.label} className="gres-grp" aria-label={group.label}>
            <div className="gres-h">
              <span>{group.label}</span>
              <span className="gres-n">{members.length}</span>
            </div>
            <ul className="gres-list">
              {members.map((step) => {
                const row = (
                  <>
                    <span
                      className="gres-st"
                      data-state={step.state}
                      role="img"
                      aria-label={
                        step.state === 'not_run' ? notRunLabel() : GATE_STATES[step.state].label
                      }
                    >
                      {ICON[step.state]}
                    </span>
                    <span className="gres-nm mono" title={step.name}>
                      {step.name}
                    </span>
                    {step.state === 'skipped' && step.result ? (
                      <span className="gres-rs" title={skipReason(step.result)}>
                        {skipReason(step.result)}
                      </span>
                    ) : step.carried ? (
                      <span className="gres-cr">
                        {t({ id: 'sessions.gateResults.carried', defaultMessage: 'Carried over' })}
                      </span>
                    ) : (
                      step.tests && testCounts(step.tests)
                    )}
                    <span
                      className="meter"
                      aria-hidden="true"
                      style={
                        {
                          '--v': `${longest > 0 ? ((step.took ?? 0) / longest) * 100 : 0}%`,
                        } as CSSProperties
                      }
                    >
                      <i />
                    </span>
                    <span className="gres-t mono">
                      {step.took === undefined ? '' : elapsedText(step.took)}
                    </span>
                  </>
                );
                const expanded = open === step.index;
                return (
                  <li key={step.index}>
                    {step.result ? (
                      <button
                        type="button"
                        className="gres-row"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : step.index)}
                      >
                        {row}
                      </button>
                    ) : (
                      <div className="gres-row">{row}</div>
                    )}
                    {expanded && step.result && (
                      <Log
                        step={step}
                        checkedAt={last!.checked_at}
                        readOnly={props.readOnly}
                        attached={props.attached}
                        onAttach={props.onAttach}
                        previous={at > 0 ? () => setOpen(failures[at - 1]!.index) : undefined}
                        next={
                          at >= 0 && at < failures.length - 1
                            ? () => setOpen(failures[at + 1]!.index)
                            : undefined
                        }
                        between={at >= 0 && failures.length > 1}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function testCounts(tests: NonNullable<GateResult['tests']>) {
  return (
    <span className="gres-tc">
      {tests.failed > 0 && (
        <span className="gres-tf">
          {t(
            { id: 'sessions.gateResults.testsFailed', defaultMessage: '{count} failed' },
            { count: tests.failed },
          )}
        </span>
      )}
      <span>
        {t(
          { id: 'sessions.gateResults.testsPassed', defaultMessage: '{count} passed' },
          { count: tests.passed },
        )}
      </span>
      {tests.skipped > 0 && (
        <span>
          {t(
            { id: 'sessions.gateResults.testsSkipped', defaultMessage: '{count} skipped' },
            { count: tests.skipped },
          )}
        </span>
      )}
    </span>
  );
}

function Log(props: {
  step: Step;
  checkedAt: number;
  readOnly: boolean;
  attached?: ReadonlySet<string>;
  onAttach?: (item: FeedbackItem) => void;
  previous?: () => void;
  next?: () => void;
  /** The step is one of two or more failures. */
  between: boolean;
}) {
  const { step } = props;
  const result = step.result!;
  const copy = t({ id: 'sessions.gateResults.copy', defaultMessage: 'Copy log' });
  const item = step.state === 'passed' ? null : checkItem(result, props.checkedAt, step.index);
  return (
    <div className="gres-log">
      <div className="gres-lh">
        {step.command && <span className="gres-cmd mono">{step.command.join(' ')}</span>}
        {result.exit_code !== null && (
          <span className="gres-code">
            {t(
              { id: 'sessions.gateResults.exitCode', defaultMessage: 'Exit code {code}' },
              { code: result.exit_code },
            )}
          </span>
        )}
        <span className="gres-lacts">
          {props.between && (
            <>
              <button
                type="button"
                className="btn ghost sm"
                disabled={!props.previous}
                onClick={props.previous}
              >
                {t({ id: 'sessions.gateResults.previous', defaultMessage: 'Previous failure' })}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={!props.next}
                onClick={props.next}
              >
                {t({ id: 'sessions.gateResults.next', defaultMessage: 'Next failure' })}
              </button>
            </>
          )}
          {item && !props.readOnly && props.onAttach && (
            <button
              type="button"
              className="btn ghost sm"
              aria-label={t(
                {
                  id: 'sessions.panel.checks.attachOutput',
                  defaultMessage: 'Attach the output of {name}',
                },
                { name: step.name },
              )}
              aria-pressed={!!props.attached?.has(item.id)}
              onClick={() => props.onAttach!(item)}
            >
              {t({ id: 'sessions.panel.attach', defaultMessage: 'Attach' })}
            </button>
          )}
          <Tip content={copy}>
            <button
              type="button"
              className="ib"
              aria-label={copy}
              onClick={() => void navigator.clipboard.writeText(result.output_tail)}
            >
              <Copy aria-hidden="true" />
            </button>
          </Tip>
        </span>
      </div>
      <pre
        className="gres-out mono"
        aria-label={t(
          { id: 'sessions.gateResults.log', defaultMessage: 'Log of {name}' },
          { name: step.name },
        )}
      >
        {segments(plain(result.output_tail)).map((s, i) => (
          <span key={i} className={s.failed ? 'gres-bad' : 'gres-ok'}>
            {s.text}
          </span>
        ))}
      </pre>
    </div>
  );
}
