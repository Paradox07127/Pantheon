import { useId, useState, type CSSProperties } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Dialog } from '@base-ui/react/dialog';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown, Clock, Flag, SquareTerminal, TriangleAlert } from 'lucide-react';
import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { Tip } from '../../components/Tip';
import { ageText, useNow } from '../../data/needs-you';
import { milestoneDueOp, planVersion } from '../../data/plan-edit';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { AcceptDialog, acceptEvidence, type MilestoneActions } from './Charts';
import {
  durationText,
  milestoneCounts,
  milestoneFinished,
  tellLeadDraft,
  type BoardMilestone,
  type SnapshotMilestone,
} from './panels-model';
import { StateIcon, StatusIcon, taskStateLabel } from './status';
import { TellLead, useDialogContent } from './TellLead';
import './overview.css';

/** The first milestone not yet accepted; null when there is none. */
export const currentMilestone = (milestones: readonly BoardMilestone[]): BoardMilestone | null =>
  milestones.find((m) => !milestoneFinished(m)) ?? null;

/** Calendar days from the local day of `now` to the due day `dueOn`; negative once it has passed. */
export function daysLeft(dueOn: string, now: number): number {
  const [year, month, day] = dueOn.split('-').map(Number) as [number, number, number];
  const today = new Date(now);
  const from = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.UTC(year, month - 1, day) - from) / 86_400_000);
}

export function dueText(days: number): string {
  if (days > 0)
    return t(
      {
        id: 'board.plan.milestone.daysLeft',
        defaultMessage: '{count, plural, one {# day left} other {# days left}}',
      },
      { count: days },
    );
  if (days === 0) return t({ id: 'board.plan.milestone.dueToday', defaultMessage: 'Due today' });
  return t(
    {
      id: 'board.plan.milestone.overdue',
      defaultMessage: '{count, plural, one {# day overdue} other {# days overdue}}',
    },
    { count: -days },
  );
}

type Totals = BoardModel['task_progress']['totals'];

const TOTAL: Record<BoardTaskStatus, keyof Totals> = {
  done: 'done',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  ready: 'ready',
  failed: 'failed',
  todo: 'not_started',
  discarded: 'discarded',
};

/** The milestone's tasks by state; merged is its own count, which holds tasks merged before the board's window. */
function milestoneTotals(done: number, cells: BoardModel['tasks']): Totals {
  const totals: Totals = {
    done,
    running: 0,
    waiting: 0,
    idle: 0,
    ready: 0,
    failed: 0,
    discarded: 0,
    not_started: 0,
  };
  for (const cell of cells) if (cell.status !== 'done') totals[TOTAL[cell.status]]++;
  return totals;
}

// Functions, so each label is read in the language loaded by then.
const PARTS: {
  key: string;
  count: (totals: Totals) => number;
  label: (count: number) => string;
}[] = [
  {
    key: 'merged',
    count: (x) => x.done,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.merged', defaultMessage: '{count} merged' }, { count }),
  },
  {
    key: 'running',
    count: (x) => x.running,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.running', defaultMessage: '{count} running' }, { count }),
  },
  {
    key: 'waiting',
    count: (x) => x.waiting,
    label: (count) =>
      t(
        { id: 'board.plan.milestone.bar.waiting', defaultMessage: '{count} waiting on you' },
        { count },
      ),
  },
  {
    key: 'review',
    count: (x) => x.ready,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.review', defaultMessage: '{count} to review' }, { count }),
  },
  {
    key: 'failed',
    count: (x) => x.failed,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.failed', defaultMessage: '{count} failed' }, { count }),
  },
  {
    key: 'queued',
    count: (x) => x.not_started + x.idle,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.queued', defaultMessage: '{count} queued' }, { count }),
  },
  {
    key: 'discarded',
    count: (x) => x.discarded,
    label: (count) =>
      t(
        { id: 'board.plan.milestone.bar.discarded', defaultMessage: '{count} discarded' },
        { count },
      ),
  },
];

type Verification = NonNullable<BoardMilestone['verification']>;

// Each reason code in words; a failed check is listed instead, and a verifier's failing gives its own words.
const VERIFY_REASONS: Record<
  Exclude<NonNullable<Verification['reason_code']>, 'checks_failed' | 'verifier_failed'>,
  () => string
> = {
  checks_environment: () =>
    t({
      id: 'board.verify.reason.checksEnvironment',
      defaultMessage: 'A check failed for a reason outside the code',
    }),
  check_error: () =>
    t({
      id: 'board.verify.reason.checkError',
      defaultMessage: 'Pantheon could not run the checks',
    }),
  no_verifier_runtime: () =>
    t({ id: 'board.verify.reason.noRuntime', defaultMessage: 'No runtime could verify it' }),
  review_not_started: () =>
    t({
      id: 'board.verify.reason.reviewNotStarted',
      defaultMessage: "The verifier's review could not start",
    }),
  review_failed: () =>
    t({ id: 'board.verify.reason.reviewFailed', defaultMessage: "The verifier's review failed" }),
  review_incomplete: () =>
    t({
      id: 'board.verify.reason.reviewIncomplete',
      defaultMessage: 'The verifier stopped before finishing its review',
    }),
  no_verdict: () =>
    t({
      id: 'board.verify.reason.noVerdict',
      defaultMessage: 'The verifier handed in no verdict',
    }),
  daemon_restart: () =>
    t({
      id: 'board.verify.reason.daemonRestart',
      defaultMessage: 'Pantheon restarted while the checks ran',
    }),
};

/** The verification's state in words, as its badge shows them. */
export function verifyText(verification: Verification, now: number): string {
  if (verification.state === 'pending' || verification.state === 'running')
    return t(
      { id: 'board.verify.badge.running', defaultMessage: 'Verifying {elapsed}' },
      { elapsed: durationText(now - verification.started_at) },
    );
  if (verification.state === 'passed')
    return t({ id: 'board.verify.badge.passed', defaultMessage: 'Verified' });
  if (verification.state === 'failed')
    return t({ id: 'board.verify.badge.failed', defaultMessage: 'Verification failed' });
  return t({ id: 'board.verify.badge.inconclusive', defaultMessage: 'Not verified' });
}

/**
 * The verification's glyph and words; `glyphOnly` keeps just the glyph, named by the words, with the
 * words in a tooltip. Nothing for a skipped run.
 */
export function VerifyBadge({
  verification,
  now,
  glyphOnly = false,
}: {
  verification: Verification;
  now: number;
  glyphOnly?: boolean;
}) {
  if (verification.state === 'skipped') return null;
  const words = verifyText(verification, now);
  const glyph =
    verification.state === 'pending' || verification.state === 'running' ? (
      <StatusIcon status="running" />
    ) : verification.state === 'passed' ? (
      <StatusIcon status="done" />
    ) : verification.state === 'failed' ? (
      <StatusIcon status="failed" />
    ) : (
      <StateIcon state="waiting_upstream" />
    );
  if (glyphOnly)
    return (
      <Tip content={words}>
        <span className="bms-vf" role="img" aria-label={words}>
          {glyph}
        </span>
      </Tip>
    );
  return (
    <span className="bms-vf">
      {glyph}
      {words}
      {verification.state === 'passed' && verification.runtime && (
        <span role="img" aria-label={runtimeName(verification.runtime)}>
          <RuntimeGlyph runtime={verification.runtime} size={12} />
        </span>
      )}
    </span>
  );
}

/**
 * The current milestone on one line: merged over planned tasks, the milestone's tasks by state and
 * the days left; its acceptance, criteria, task cells and due day open from the button that ends it.
 */
export function MilestoneCard({
  model,
  milestone,
  actions,
  onOpenTask,
}: {
  model: BoardModel;
  milestone: BoardMilestone;
  actions?: MilestoneActions;
  onOpenTask: (taskId: string) => void;
}) {
  const id = useId();
  const accepting = useDialogContent<{ stored: SnapshotMilestone }>();
  const { done, total } = milestoneCounts(milestone);
  const cells = model.tasks.filter((t) => t.milestone_id === milestone.id);
  const stored = actions?.milestones.find((m) => m.id === milestone.id);
  const ready = !!stored && milestone.status === 'ready_for_acceptance';
  const [failure, setFailure] = useState<string | null>(null);
  const verification = milestone.verification;
  const verifying = verification?.state === 'pending' || verification?.state === 'running';
  const now = Math.max(model.now, useNow(verifying ? 1000 : 60_000));
  const failedChecks = verification?.commands.filter((c) => c.exit_code !== 0).length ?? 0;
  // A failed verification lists only the commands that failed.
  const listed =
    verification?.commands.filter((c) => verification.state !== 'failed' || c.exit_code !== 0) ??
    [];
  const code = verification?.reason_code;
  const reason =
    !code || code === 'checks_failed'
      ? null
      : code === 'verifier_failed'
        ? verification.reason
        : VERIFY_REASONS[code]();
  // Only a lead's milestone has a plan key to edit it by.
  const lead = stored?.owner_session_id;
  const key = stored?.key;
  const setDue = async (dueOn: string | null) => {
    if (!actions || !lead || !key) return;
    setFailure(null);
    setFailure(
      await actions.run(
        'board.plan.edit',
        {
          project_id: actions.projectId,
          lead_session_id: lead,
          base_version: planVersion(model, lead),
          ops: [milestoneDueOp(key, dueOn)],
        },
        null,
      ),
    );
  };
  const days = milestone.due_on === undefined ? null : daysLeft(milestone.due_on, model.now);
  const totals = milestoneTotals(done, cells);
  const parts = PARTS.map((p) => ({ ...p, n: p.count(totals) })).filter((p) => p.n > 0);
  return (
    <section className="bms" aria-labelledby={id} data-debug-region="board.milestone">
      <div className="bms-ln">
        <Flag className="bms-ic" aria-hidden="true" />
        <h2 id={id} className="bms-h" title={milestone.title}>
          {milestone.title}
        </h2>
        {verification && <VerifyBadge verification={verification} now={now} />}
        <span
          className="bms-frac"
          role="img"
          aria-label={t(
            {
              id: 'board.plan.milestone.merged',
              defaultMessage:
                '{total, plural, one {{done} of # planned task merged} other {{done} of # planned tasks merged}}',
            },
            { done, total },
          )}
        >
          {done} / {total}
        </span>
        {parts.length > 0 && (
          <span
            className="bms-bar"
            data-debug-region="board.progress"
            role="img"
            aria-label={t(
              {
                id: 'board.plan.milestone.bar',
                defaultMessage: '{count, plural, one {# task} other {# tasks}}: {parts}',
              },
              {
                count: parts.reduce((sum, p) => sum + p.n, 0),
                parts: listText(...parts.map((p) => p.label(p.n))),
              },
            )}
          >
            {parts.map((p) => (
              <i key={p.key} data-part={p.key} style={{ flexGrow: p.n }} />
            ))}
          </span>
        )}
        {days !== null && (
          <span className="bms-due" data-late={days < 0 || undefined}>
            <Clock aria-hidden="true" />
            {dueText(days)}
          </span>
        )}
        <Popover.Root>
          <Popover.Trigger
            className="ib bms-more"
            aria-label={t({
              id: 'board.plan.milestone.details',
              defaultMessage: 'Milestone details',
            })}
          >
            <ChevronDown aria-hidden="true" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
              <Popover.Popup className="pop bms-pop">
                <div className="bms-hd">
                  <Popover.Title className="bms-pt">{milestone.title}</Popover.Title>
                  {actions && (
                    <button
                      type="button"
                      className="btn"
                      aria-label={t(
                        {
                          id: 'board.plan.milestone.acceptLabel',
                          defaultMessage: 'Accept {title}',
                        },
                        { title: milestone.title },
                      )}
                      disabled={!ready}
                      onClick={() => stored && accepting.show({ stored })}
                    >
                      {t({ id: 'board.plan.milestone.accept', defaultMessage: 'Accept' })}
                    </button>
                  )}
                </div>
                <div className="bms-pb">
                  {milestone.criteria.length > 0 && (
                    <ul
                      className="bms-crit"
                      aria-label={t({
                        id: 'board.plan.milestone.criteria',
                        defaultMessage: 'Acceptance criteria',
                      })}
                    >
                      {milestone.criteria.map((criterion, index) => (
                        <li key={index}>
                          <Clip text={criterion.text} lines={2} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {cells.length > 0 && (
                    <div className="bms-cells" style={{ '--n': cells.length } as CSSProperties}>
                      {cells.map((cell) => (
                        <Tip key={cell.id} content={cell.title}>
                          <button
                            type="button"
                            className="bms-cell"
                            data-state={cell.state ?? cell.status}
                            aria-label={t(
                              { id: 'board.task.link.label', defaultMessage: '{title}, {status}' },
                              { title: cell.title, status: taskStateLabel(cell) },
                            )}
                            onClick={() => onOpenTask(cell.id)}
                          />
                        </Tip>
                      ))}
                    </div>
                  )}
                  {lead && key && (
                    <input
                      type="date"
                      className="bd-fsel bms-date"
                      aria-label={t({
                        id: 'board.plan.milestone.dueOn',
                        defaultMessage: 'Due date',
                      })}
                      value={milestone.due_on ?? ''}
                      onChange={(e) => void setDue(e.target.value || null)}
                    />
                  )}
                  {failure && (
                    <div className="tr-fail" role="alert">
                      <span title={failure}>{failure}</span>
                    </div>
                  )}
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {verification && !verifying && verification.state !== 'skipped' && (
        <Collapsible.Root
          key={verification.id}
          className="bms-vc"
          defaultOpen={verification.state === 'failed'}
          render={<section />}
          aria-label={t(
            { id: 'board.verify.card.label', defaultMessage: 'Verification of {title}' },
            { title: milestone.title },
          )}
        >
          <Collapsible.Trigger className="bms-vh">
            {verification.state === 'passed' ? (
              <StatusIcon status="done" />
            ) : verification.state === 'failed' ? (
              <StatusIcon status="failed" />
            ) : (
              <StateIcon state="waiting_upstream" />
            )}
            <span className="bms-vt">
              {verification.state === 'passed'
                ? t({ id: 'board.verify.badge.passed', defaultMessage: 'Verified' })
                : verification.state !== 'failed'
                  ? t({ id: 'board.verify.badge.inconclusive', defaultMessage: 'Not verified' })
                  : failedChecks
                    ? t(
                        {
                          id: 'board.verify.card.checksFailed',
                          defaultMessage:
                            '{count, plural, one {# check failed} other {# checks failed}}',
                        },
                        { count: failedChecks },
                      )
                    : t({
                        id: 'board.verify.card.verifierFailed',
                        defaultMessage: 'Verifier failed it',
                      })}
            </span>
            {verification.finished_at !== undefined && (
              <span className="bms-va">{ageText(verification.finished_at, now)}</span>
            )}
            <ChevronDown className="bms-vch" aria-hidden="true" />
          </Collapsible.Trigger>
          <Collapsible.Panel className="bms-vp">
            <div className="bms-vb">
              {listed.length > 0 && (
                <ul className="bms-vl">
                  {listed.map((command, index) => {
                    const output =
                      command.exit_code !== 0
                        ? verification.failed.find((f) => f.name === command.name)?.output_tail
                        : undefined;
                    return (
                      <li key={index}>
                        <span
                          role="img"
                          aria-label={
                            command.exit_code === 0
                              ? t({ id: 'board.verify.check.passed', defaultMessage: 'Passed' })
                              : t({ id: 'board.verify.check.failed', defaultMessage: 'Failed' })
                          }
                        >
                          <StatusIcon status={command.exit_code === 0 ? 'done' : 'failed'} />
                        </span>
                        <SquareTerminal aria-hidden="true" />
                        <span className="bms-vn">{command.name}</span>
                        {output && <pre className="bms-vo">{output}</pre>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {verification.runtime && (
                <div className="bms-vr">
                  <span className="bms-vw">
                    <RuntimeGlyph runtime={verification.runtime} size={14} />
                    {runtimeName(verification.runtime)}
                  </span>
                  {verification.independence === 'same_runtime' ? (
                    <span className="bms-vs">
                      <TriangleAlert aria-hidden="true" />
                      {t({
                        id: 'board.verify.independence.sameRuntime',
                        defaultMessage: "The writers' own runtime",
                      })}
                    </span>
                  ) : verification.independence === 'other_vendor' ? (
                    <span className="chip">
                      {t({
                        id: 'board.verify.independence.otherVendor',
                        defaultMessage: 'Another vendor than the writers',
                      })}
                    </span>
                  ) : verification.independence === 'other_runtime' ? (
                    <span className="chip">
                      {t({
                        id: 'board.verify.independence.otherRuntime',
                        defaultMessage: 'Another runtime, vendor unknown',
                      })}
                    </span>
                  ) : null}
                </div>
              )}
              {reason && <p className="bms-vwhy">{reason}</p>}
              {actions && lead && verification.state !== 'passed' && (
                <div className="bms-vact">
                  <TellLead
                    className="btn ghost"
                    lead={actions.sessions.find((s) => s.id === lead)}
                    draft={tellLeadDraft('milestone', milestone.title, key ?? milestone.id)}
                    label={milestone.title}
                    run={actions.run}
                    text={t({ id: 'board.verify.card.tellLead', defaultMessage: 'Tell lead' })}
                  />
                </div>
              )}
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
      {actions && (
        <Dialog.Root {...accepting.root}>
          {accepting.content && (
            <AcceptDialog
              key={accepting.content.stored.id}
              // A dialog stays open across snapshot refreshes; it gets the row as it is now.
              stored={
                stored?.id === accepting.content.stored.id ? stored : accepting.content.stored
              }
              evidence={acceptEvidence(milestone, model, actions.sessions)}
              run={actions.run}
              onClose={accepting.close}
            />
          )}
        </Dialog.Root>
      )}
    </section>
  );
}
