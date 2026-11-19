import { useState } from 'react';
import type { EnvironmentCheck as Check, ProjectBaseline } from '@pantheon/domain';
import {
  Check as Passed,
  ChevronDown,
  FileText,
  GitBranch,
  LoaderCircle,
  Minus,
  Play,
  RefreshCw,
  Settings,
  TriangleAlert,
  X,
} from 'lucide-react';
import { runCommand } from '../data/commands';
import { failureText, useNow } from '../data/needs-you';
import { useProjectQuery } from '../data/project-read';
import { t } from '../i18n';
import { dayText, durationText } from '../lib/time-text';
import { Clip } from './Clip';
import { PathText } from './PathText';
import './environment-check.css';

/** The commands a root's check runs, in run order. */
export type PlannedCommands = { root: string; commands: { name: string; argv: string[] }[] }[];

const CHECK_KINDS: ReadonlySet<string> = new Set([
  'environment.check_started',
  'environment.check_finished',
]);

type RowState = 'passed' | 'failed' | 'not_run';

const ICON = {
  passed: <Passed aria-hidden="true" />,
  failed: <X aria-hidden="true" />,
  not_run: <Minus aria-hidden="true" />,
  running: <LoaderCircle aria-hidden="true" />,
  inconclusive: <TriangleAlert aria-hidden="true" />,
};

const glyph = (state: keyof typeof ICON, label: string) => (
  <span className="evc-g" data-state={state} role="img" aria-label={label}>
    {ICON[state]}
  </span>
);

const passedText = () => t({ id: 'components.environment.passed', defaultMessage: 'Passed' });
const failedText = () => t({ id: 'components.environment.failed', defaultMessage: 'Failed' });
const notRunText = () => t({ id: 'components.environment.notRun', defaultMessage: 'Not run' });
const runningText = () => t({ id: 'components.environment.running', defaultMessage: 'Running' });
const inconclusiveText = () =>
  t({ id: 'components.environment.inconclusive', defaultMessage: 'Inconclusive' });

function stateText(check: Check | undefined): string {
  if (!check) return notRunText();
  if (check.state === 'running') return runningText();
  if (check.state === 'passed') return passedText();
  if (check.state === 'inconclusive') return inconclusiveText();
  return check.reason_code === 'setup_failed'
    ? t({ id: 'components.environment.setupFailed', defaultMessage: 'Setup failed' })
    : failedText();
}

function Elapsed({ from }: { from: number }) {
  const now = useNow();
  return <span className="evc-num">{durationText(now - from)}</span>;
}

/**
 * The newest environment check of each root: each command that ran, passed or failed, and the
 * log tail of the one that failed. With a baseline, the checks of its proposed commands.
 */
export function EnvironmentCheck({
  project_id,
  planned,
  baseline,
  onOpenSession,
}: {
  project_id: string;
  planned: PlannedCommands;
  baseline?: ProjectBaseline;
  /** Opens the baseline's conversation. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const read = useProjectQuery<Check[]>(
    'project.environment.checks',
    project_id,
    Array.isArray,
    baseline ? { baseline_id: baseline.id } : undefined,
    { kinds: CHECK_KINDS },
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<readonly string[]>([]);
  const checks = read.read ?? [];
  const now = Date.now();
  const latest = (root: string) => checks.find((check) => check.root === root);
  const roots = [
    ...planned.filter((entry) => entry.commands.length > 0 || latest(entry.root)),
    ...checks
      .filter(
        (check, i) =>
          !planned.some((entry) => entry.root === check.root) &&
          checks.findIndex((c) => c.root === check.root) === i,
      )
      .map((check) => ({ root: check.root, commands: [] })),
  ];
  const rank = (check: Check | undefined) =>
    check?.state === 'failed'
      ? 0
      : check?.state === 'inconclusive'
        ? 1
        : check?.state === 'passed'
          ? 3
          : 2;
  const cells = roots
    .map((entry) => ({ ...entry, check: latest(entry.root) }))
    .sort((a, b) => rank(a.check) - rank(b.check));
  const failed = cells.filter((cell) => cell.check?.state === 'failed').length;
  const running = checks.some((check) => check.state === 'running');
  const empty = !planned.some((entry) => entry.commands.length > 0);
  const scope = `evc-${baseline?.id ?? project_id}`;
  const whyId = `${scope}-why`,
    errorId = `${scope}-error`;

  const verify = async () => {
    setSending(true);
    const result = await runCommand(
      'project.environment.verify',
      { project_id, ...(baseline && { baseline_id: baseline.id }) },
      null,
    );
    setSending(false);
    setError(
      result.ok
        ? null
        : result.error.code === 'resource_busy'
          ? t({
              id: 'components.environment.busy',
              defaultMessage: 'A check of this project is already running.',
            })
          : failureText(result.error),
    );
    if (result.ok) read.reload();
  };

  const states = baseline?.environment?.commands ?? [];
  const attempt2 = checks.some(
    (check) => check.cause.kind === 'baseline' && check.cause.attempt === 2,
  );
  const fixed =
    !!baseline &&
    attempt2 &&
    cells.length > 0 &&
    cells.every((cell) => cell.check?.state === 'passed');
  const fixAt = baseline?.environment?.fix_requested_at;
  const fixing =
    fixAt !== undefined && !attempt2
      ? states.find((command) => command.state === 'failed')?.name
      : undefined;
  const conversation = onOpenSession && baseline?.session_id && (
    <button
      type="button"
      className="btn ghost sm"
      onClick={() => onOpenSession(baseline.session_id!)}
    >
      {t({ id: 'components.environment.viewConversation', defaultMessage: 'View conversation' })}
    </button>
  );
  const title = t({ id: 'components.environment.title', defaultMessage: 'Environment' });
  const Title = baseline ? 'span' : 'h3';

  return (
    <section className="evc" aria-label={title}>
      <div className="evc-h">
        <Title className="evc-t">{title}</Title>
        {baseline && checks[0] && (
          <>
            <span className="evc-at">
              {t({
                id: 'components.environment.fresh',
                defaultMessage: 'Ran in a fresh worktree',
              })}
            </span>
            <span className="evc-num">{dayText(checks[0].started_at, now, { time: true })}</span>
          </>
        )}
        {cells.length > 1 && failed > 0 && (
          <span className="evc-at">
            {t(
              {
                id: 'components.environment.rootsFailed',
                defaultMessage: '{failed} of {total} roots failed',
              },
              { failed, total: cells.length },
            )}
          </span>
        )}
        <span className="evc-end">
          {empty && (
            <span className="evc-why" id={whyId}>
              {t({
                id: 'components.environment.noCommands',
                defaultMessage: 'No gate commands to run',
              })}
            </span>
          )}
          <button
            type="button"
            className={baseline ? 'btn sm' : 'btn pri sm'}
            disabled={empty || running || sending || baseline?.state === 'running'}
            aria-describedby={empty ? whyId : error ? errorId : undefined}
            onClick={() => void verify()}
          >
            <Play aria-hidden="true" />
            {checks.length > 0
              ? t({ id: 'components.environment.again', defaultMessage: 'Run again' })
              : t({ id: 'components.environment.check', defaultMessage: 'Check environment' })}
          </button>
        </span>
      </div>
      {error && (
        <div className="evc-err" id={errorId} role="alert">
          <TriangleAlert aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {cells.length > 0 && (
        <div className="evc-roots">
          {cells.map(({ root, commands, check }) => {
            const word = stateText(check);
            const ran = check?.state === 'running' ? [] : (check?.commands ?? []);
            const rows: {
              name: string;
              argv: string[];
              state: RowState;
              run?: Check['commands'][number];
            }[] = [
              ...ran.map((run) => ({
                name: run.name,
                argv: run.argv,
                state: (run.exit_code === 0 ? 'passed' : 'failed') as RowState,
                run,
              })),
              ...commands
                .filter((command) => !ran.some((run) => run.name === command.name))
                .map((command) => ({ ...command, state: 'not_run' as RowState })),
            ].map((row) => ({
              ...row,
              state:
                states.find((command) => command.root === root && command.name === row.name)
                  ?.state ?? row.state,
            }));
            const folded = check?.state === 'passed' && !open.includes(root);
            const restarted = check?.reason_code === 'daemon_restart';
            return (
              <div
                key={root}
                className="evc-root"
                role="group"
                aria-label={t(
                  { id: 'components.environment.root', defaultMessage: '{root}, {state}' },
                  { root, state: word },
                )}
                aria-busy={check?.state === 'running' || undefined}
              >
                <div className="evc-rh">
                  {glyph(
                    !check
                      ? 'not_run'
                      : check.state === 'running' || check.state === 'inconclusive'
                        ? check.state
                        : check.state === 'passed'
                          ? 'passed'
                          : 'failed',
                    word,
                  )}
                  <PathText path={root} className="evc-path" />
                  <span className="evc-st">{word}</span>
                  {check && (
                    <span className="evc-meta">
                      {check.commit && (
                        <span className="evc-sha">
                          <GitBranch aria-hidden="true" />
                          <span className="evc-num">{check.commit.slice(0, 7)}</span>
                        </span>
                      )}
                      <span className="evc-at">
                        {dayText(check.started_at, now, { time: true })}
                      </span>
                      {check.state === 'running' ? (
                        <Elapsed from={check.started_at} />
                      ) : (
                        check.finished_at !== undefined && (
                          <span className="evc-num">
                            {durationText(check.finished_at - check.started_at)}
                          </span>
                        )
                      )}
                      {check.state === 'passed' && (
                        <button
                          type="button"
                          className="ib"
                          aria-expanded={!folded}
                          aria-label={t(
                            {
                              id: 'components.environment.show',
                              defaultMessage:
                                '{count, plural, one {Show # command of {root}, {passed} passed} other {Show # commands of {root}, {passed} passed}}',
                            },
                            {
                              count: rows.length,
                              root,
                              passed: rows.filter((row) => row.state === 'passed').length,
                            },
                          )}
                          onClick={() =>
                            setOpen((roots) =>
                              folded ? [...roots, root] : roots.filter((r) => r !== root),
                            )
                          }
                        >
                          <ChevronDown aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {restarted ? (
                  <div className="evc-note">
                    <RefreshCw aria-hidden="true" />
                    <span>
                      {t({
                        id: 'components.environment.restarted',
                        defaultMessage: 'Stopped when Pantheon restarted',
                      })}
                    </span>
                  </div>
                ) : (
                  !folded &&
                  check?.state !== 'running' &&
                  rows.length > 0 && (
                    <ul
                      className="evc-cmds"
                      aria-label={t({
                        id: 'components.environment.commands',
                        defaultMessage: 'Commands, in run order',
                      })}
                    >
                      {rows.map((row) => (
                        <li key={row.name} className="evc-item">
                          <span className="evc-cmd">
                            {glyph(
                              row.state,
                              row.state === 'passed'
                                ? passedText()
                                : row.state === 'failed'
                                  ? t(
                                      {
                                        id: 'components.environment.failedExit',
                                        defaultMessage: 'Failed, exit {code}',
                                      },
                                      { code: row.run?.exit_code ?? '' },
                                    )
                                  : notRunText(),
                            )}
                            <span className="evc-what">
                              <Clip text={row.name} className="evc-nm" />
                              <Clip text={row.argv.join(' ')} className="evc-argv" />
                            </span>
                            {row.state === 'failed' && row.run?.failure_class ? (
                              <span className="evc-class">
                                {row.run.failure_class === 'code' ? (
                                  <FileText aria-hidden="true" />
                                ) : (
                                  <Settings aria-hidden="true" />
                                )}
                                {row.run.failure_class === 'code'
                                  ? t({
                                      id: 'components.environment.failsOnCode',
                                      defaultMessage: 'Fails on the code',
                                    })
                                  : t({
                                      id: 'components.environment.failsOnMachine',
                                      defaultMessage: 'Fails on this machine',
                                    })}
                              </span>
                            ) : (
                              <span />
                            )}
                            {row.run && row.state !== 'not_run' ? (
                              <span className="evc-num">{durationText(row.run.duration_ms)}</span>
                            ) : (
                              <span className="evc-at">{notRunText()}</span>
                            )}
                          </span>
                          {row.state === 'failed' && row.run?.output_tail && (
                            <pre
                              className="evc-log"
                              tabIndex={0}
                              aria-label={t(
                                {
                                  id: 'components.environment.log',
                                  defaultMessage: 'Log of {name}, last lines',
                                },
                                { name: row.name },
                              )}
                            >
                              {row.run.output_tail}
                            </pre>
                          )}
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
      {fixing && fixAt !== undefined && (
        <div className="evc-note">
          {glyph('running', runningText())}
          <span>
            {t(
              {
                id: 'components.environment.fixing',
                defaultMessage: 'The baseline agent is fixing {name}',
              },
              { name: fixing },
            )}
          </span>
          <span className="evc-num">{dayText(fixAt, now, { time: true })}</span>
          {conversation}
        </div>
      )}
      {fixed && (
        <div className="evc-note">
          {glyph('passed', passedText())}
          <span>
            {t({
              id: 'components.environment.fixed',
              defaultMessage: 'Passed after one fix by the baseline agent',
            })}
          </span>
          {conversation}
        </div>
      )}
    </section>
  );
}
