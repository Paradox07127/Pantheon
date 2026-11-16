import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, Pin, Play, Undo2, X } from 'lucide-react';
import type { Improvement, Retrospective, ImprovementSignal } from '@pantheon/domain';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { SessionStateIcon } from '../../components/SessionStateIcon';
import { useBoard } from '../../data/board';
import { shortId } from '../../data/format';
import { useProjectRetrospectives } from '../../data/retrospective-read';
import { useSessionList } from '../../data/workbench-sessions';
import {
  decideImprovement,
  DOMAIN_LABEL,
  PARAM_LABEL,
  scopeText,
  tierText,
  useImprovementSessions,
  type Decision,
  type ImprovementListItem,
} from '../../data/workflow-policy';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { durationText, tokenText } from '../board/panels-model';
import { changeValueText, learnedEffect } from './learned-effect';
import { userRejectText } from './learned-model';
import '../../components/button-busy.css';
import './memory-learned-detail.css';

export interface LearnedDetailProps {
  projectId: string;
  item: ImprovementListItem;
  onClose: () => void;
  onOpenRetro: (retrospectiveId: string) => void;
}

type Tone = 'wait' | 'rev' | 'ok' | 'idle' | 'bad';

const STATUS: Record<Improvement['status'], { tone: Tone; label: () => string }> = {
  candidate: {
    tone: 'wait',
    label: () => t({ id: 'memory.learnedDetail.status.candidate', defaultMessage: 'Awaiting you' }),
  },
  trial: {
    tone: 'rev',
    label: () => t({ id: 'memory.learnedDetail.status.trial', defaultMessage: 'On trial' }),
  },
  active: {
    tone: 'ok',
    label: () => t({ id: 'memory.learnedDetail.status.active', defaultMessage: 'In effect' }),
  },
  reverted: {
    tone: 'idle',
    label: () => t({ id: 'memory.learnedDetail.status.reverted', defaultMessage: 'Reverted' }),
  },
  rejected: {
    tone: 'idle',
    label: () => t({ id: 'memory.learnedDetail.status.rejected', defaultMessage: 'Rejected' }),
  },
};

// The same texts as the experience settings page.
const SIGNAL_TEXT: Record<ImprovementSignal, () => string> = {
  always_approved_command: () =>
    t({
      id: 'data.workflowPolicy.signal.alwaysApprovedCommand',
      defaultMessage: 'Always-approved command',
    }),
  late_gate_failure: () =>
    t({ id: 'data.workflowPolicy.signal.lateGateFailure', defaultMessage: 'Late gate failure' }),
  dispatch_overhead: () =>
    t({
      id: 'data.workflowPolicy.signal.dispatchOverhead',
      defaultMessage: 'High dispatch overhead',
    }),
  direct_rework: () =>
    t({
      id: 'data.workflowPolicy.signal.directRework',
      defaultMessage: 'Rework after doing it directly',
    }),
  idle_wakeups: () =>
    t({ id: 'data.workflowPolicy.signal.idleWakeups', defaultMessage: 'Idle wake-ups' }),
  queue_wait: () =>
    t({ id: 'data.workflowPolicy.signal.queueWait', defaultMessage: 'Queue waits' }),
  merge_conflicts: () =>
    t({ id: 'data.workflowPolicy.signal.mergeConflicts', defaultMessage: 'Merge conflicts' }),
  over_budget: () =>
    t({ id: 'data.workflowPolicy.signal.overBudget', defaultMessage: 'Over budget' }),
  repeat_gate_failure: () =>
    t({
      id: 'data.workflowPolicy.signal.repeatGateFailure',
      defaultMessage: 'Gates failing repeatedly',
    }),
  repeat_turn_failure: () =>
    t({
      id: 'data.workflowPolicy.signal.repeatTurnFailure',
      defaultMessage: 'Turns failing repeatedly',
    }),
  handback_loop: () =>
    t({ id: 'data.workflowPolicy.signal.handbackLoop', defaultMessage: 'Repeated handbacks' }),
};

const FAILED: Record<Decision, (error: string) => string> = {
  confirm: (error) =>
    t(
      {
        id: 'memory.learnedDetail.failed.confirm',
        defaultMessage: 'Couldn’t start the trial: {error}',
      },
      { error },
    ),
  reject: (error) =>
    t(
      { id: 'memory.learnedDetail.failed.reject', defaultMessage: 'Couldn’t reject: {error}' },
      { error },
    ),
  pin: (error) =>
    t(
      { id: 'memory.learnedDetail.failed.pin', defaultMessage: 'Couldn’t pin: {error}' },
      { error },
    ),
  revert: (error) =>
    t(
      { id: 'memory.learnedDetail.failed.revert', defaultMessage: 'Couldn’t revert: {error}' },
      { error },
    ),
};

type Trial = NonNullable<ImprovementListItem['trial']>;
type Metric = Trial['metrics'][number];

const METRIC_TEXT: Record<string, () => string> = {
  first_pass: () =>
    t({ id: 'memory.learnedDetail.metric.firstPass', defaultMessage: 'First-pass gate' }),
  input_tokens: () =>
    t({ id: 'memory.learnedDetail.metric.inputTokens', defaultMessage: 'Input tokens' }),
  wall_ms: () => t({ id: 'memory.learnedDetail.metric.wall', defaultMessage: 'Time' }),
  wait_and_execution_ms: () =>
    t({ id: 'memory.learnedDetail.metric.waitAndExecution', defaultMessage: 'Wait and run' }),
  wakes_without_decision_per_task: () =>
    t({ id: 'memory.learnedDetail.metric.idleWakes', defaultMessage: 'Idle wakes' }),
  signal_findings: () =>
    t({ id: 'memory.learnedDetail.metric.findings', defaultMessage: 'Findings' }),
  first_pass_without_findings: () =>
    t({ id: 'memory.learnedDetail.metric.cleanFirstPass', defaultMessage: 'Clean first pass' }),
};

/** A count against its tasks, or a value per task as the trial evaluation compares it. */
function metricValue(metric: Metric, value: number, tasks: number): string {
  if (metric.unit === 'tasks') return `${value} / ${tasks}`;
  // A metric named per task already is one.
  const each = metric.name.endsWith('_per_task') ? value : value / tasks;
  if (metric.unit === 'tokens') return tokenText(each);
  if (metric.unit === 'milliseconds') return durationText(each);
  return each.toFixed(1);
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (d: Date) => d.toDateString();

function dateText(d: Date, today: Date) {
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() === today.getFullYear()
    ? t({ id: 'memory.learnedDetail.date', defaultMessage: '{month}/{day}' }, { month, day })
    : t(
        { id: 'memory.learnedDetail.dateYear', defaultMessage: '{year}/{month}/{day}' },
        { year: d.getFullYear(), month, day },
      );
}

/** Today and yesterday with the time; other days by date, with the time when `time` is set. */
function whenText(ms: number, time: boolean) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayOf(d) === dayOf(today))
    return t({ id: 'memory.learnedDetail.today', defaultMessage: 'today {time}' }, { time: clock });
  if (dayOf(d) === dayOf(yesterday))
    return time
      ? t(
          { id: 'memory.learnedDetail.yesterdayAt', defaultMessage: 'yesterday {time}' },
          { time: clock },
        )
      : t({ id: 'memory.learnedDetail.yesterday', defaultMessage: 'yesterday' });
  const date = dateText(d, today);
  return time
    ? t(
        { id: 'memory.learnedDetail.dateAt', defaultMessage: '{date} {time}' },
        { date, time: clock },
      )
    : date;
}

function headTime(item: Improvement): string | null {
  if (item.status === 'candidate')
    return t(
      { id: 'memory.learnedDetail.proposedAt', defaultMessage: 'Proposed {when}' },
      { when: whenText(item.proposed_at, true) },
    );
  if (item.status === 'trial')
    return t(
      { id: 'memory.learnedDetail.startedAt', defaultMessage: 'Started {when}' },
      { when: whenText(item.trial_started_at ?? item.proposed_at, true) },
    );
  if (item.decided_at === undefined) return null;
  const when = whenText(item.decided_at, true);
  if (item.status === 'active')
    return t(
      { id: 'memory.learnedDetail.activeAt', defaultMessage: 'In effect since {when}' },
      { when },
    );
  if (item.status === 'reverted')
    return t(
      { id: 'memory.learnedDetail.revertedAt', defaultMessage: 'Reverted {when}' },
      { when },
    );
  return t({ id: 'memory.learnedDetail.rejectedAt', defaultMessage: 'Rejected {when}' }, { when });
}

const Glyph = ({ tone }: { tone: Tone }) => (
  <span className="mld-st" data-st={tone} aria-hidden="true" />
);

/** Backticked spans of a procedure drawn as inline code. */
const codeParts = (text: string): ReactNode[] =>
  text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      <span key={i} className="mld-inl">
        {part}
      </span>
    ) : (
      part
    ),
  );

const MARK = { what: '\u0001', from: '\u0002', to: '\u0003' };

/** A policy change as its sentence, with numeric values set in mono. */
function policyRule(
  change: Extract<Improvement['change'], { type: 'policy_change' }>,
): ReactNode[] {
  const value = (v: unknown, key: string) => {
    const text = changeValueText(change.param, v);
    return typeof v === 'number' ? (
      <span key={key} className="mld-mono">
        {text}
      </span>
    ) : (
      text
    );
  };
  const what = change.tier
    ? `${PARAM_LABEL.path} ${tierText(change.tier)}`
    : PARAM_LABEL[change.param];
  return t({ id: 'data.workflowPolicy.change', defaultMessage: '{what} from {from} to {to}' }, MARK)
    .split(/([\u0001-\u0003])/)
    .map((part, i) =>
      part === MARK.what
        ? what
        : part === MARK.from
          ? value(change.from, `f${i}`)
          : part === MARK.to
            ? value(change.to, `t${i}`)
            : part,
    );
}

function metricText(signal: ImprovementSignal | undefined, r: Retrospective): string | null {
  if (signal === 'repeat_gate_failure') {
    if (r.gate_passed_on_attempt !== undefined)
      return t(
        { id: 'memory.learnedDetail.gatePassed', defaultMessage: 'Passed the gate on try {n}' },
        { n: r.gate_passed_on_attempt },
      );
    if (r.gate_failures?.length)
      return t({
        id: 'memory.learnedDetail.gateNotPassed',
        defaultMessage: 'Never passed the gate',
      });
  }
  if (signal === 'queue_wait' && r.stage_ms?.dispatch_wait !== undefined)
    return t(
      { id: 'memory.learnedDetail.queued', defaultMessage: 'Queued {minutes} min' },
      { minutes: Math.round(r.stage_ms.dispatch_wait / 60_000) },
    );
  return null;
}

export function LearnedDetail({ projectId, item, onClose, onOpenRetro }: LearnedDetailProps) {
  const retrospectives = useProjectRetrospectives(projectId);
  const sessions = useBoard((s) => s.board?.sessions);
  const [pending, setPending] = useState<{ id: string; decision: Decision } | null>(null);
  const [failure, setFailure] = useState<{ id: string; decision: Decision; text: string } | null>(
    null,
  );
  const sending = useRef(false);

  const decide = async (
    decision: Decision,
    rejectReason?: NonNullable<Improvement['reject_reason']>,
  ) => {
    if (sending.current) return;
    sending.current = true;
    setPending({ id: item.id, decision });
    setFailure(null);
    const result = await decideImprovement(item, decision, rejectReason);
    sending.current = false;
    setPending(null);
    if (!result.ok) setFailure({ id: item.id, decision, text: result.error });
  };

  const status = STATUS[item.status];
  const time = headTime(item);
  const change = item.change;
  const effect = learnedEffect(item);
  const trial = item.trial;
  const injected =
    change.type === 'experience' && (item.status === 'trial' || item.status === 'active');
  const used = useImprovementSessions(projectId, injected ? item.id : null);
  const listed = useSessionList(injected ? projectId : null);

  const cells: { cap: string; value: ReactNode }[] = [];
  if (change.type === 'experience') {
    if (change.domain)
      cells.push({
        cap: t({ id: 'memory.learnedDetail.domain', defaultMessage: 'Domain' }),
        value: DOMAIN_LABEL[change.domain],
      });
    if (change.tier)
      cells.push({
        cap: t({ id: 'memory.learnedDetail.tier', defaultMessage: 'Tier' }),
        value: <span className="mld-mono">{tierText(change.tier)}</span>,
      });
    if (change.runtime)
      cells.push({
        cap: t({ id: 'memory.learnedDetail.runtime', defaultMessage: 'runtime' }),
        value: (
          <span className="mld-rt">
            <RuntimeGlyph runtime={change.runtime} size={14} />
            {runtimeName(change.runtime)}
          </span>
        ),
      });
  }
  if (cells.length === 0)
    cells.push({
      cap: t({ id: 'memory.learnedDetail.scope', defaultMessage: 'Scope' }),
      value: scopeText(change),
    });
  if (item.status === 'trial' && item.trial_started_at !== undefined)
    cells.push({
      cap: t({ id: 'memory.learnedDetail.triedFor', defaultMessage: 'On trial for' }),
      value: (
        <span className="mld-num">
          {t(
            {
              id: 'memory.learnedDetail.days',
              defaultMessage: '{count, plural, one {# day} other {# days}}',
            },
            { count: Math.max(1, Math.ceil((Date.now() - item.trial_started_at) / DAY)) },
          )}
        </span>
      ),
    });
  if (item.status === 'trial' && change.type === 'policy_change' && trial)
    cells.push({
      cap: t({ id: 'memory.learnedDetail.trialTasks', defaultMessage: 'Tasks' }),
      value: (
        <span className="mld-mono mld-num">
          {trial.tasks_seen} / {trial.tasks_required}
        </span>
      ),
    });
  const compared =
    trial && trial.status_reason !== 'no_baseline'
      ? trial.metrics.filter((m) => m.baseline !== undefined && m.trial !== undefined)
      : [];

  const byId = new Map((retrospectives.read ?? []).map((r) => [r.id, r]));
  const rows = item.retrospective_ids.flatMap((id) => byId.get(id) ?? []);
  const taskName = (r: Retrospective) =>
    sessions?.find((s) => s.task?.id === r.task_id && s.task.lead_session_id === r.lead_session_id)
      ?.title ?? r.task_id;
  const firstChecks = rows.map((r) => r.gate_failed_checks?.[0]);
  const sharedCheck =
    item.signal === 'repeat_gate_failure' &&
    rows.length > 1 &&
    firstChecks[0] !== undefined &&
    firstChecks.every((c) => c === firstChecks[0])
      ? firstChecks[0]
      : null;
  const leadRuntime =
    item.source === 'lead'
      ? sessions?.find((s) => s.id === item.lead_session_id)?.runtime
      : undefined;

  const failed = failure?.id === item.id ? failure : null;
  const busy = pending?.id === item.id ? pending.decision : null;
  const action = (decision: Decision, kind: string, icon: ReactNode, label: string) => (
    <button
      key={decision}
      type="button"
      className={busy === decision ? `${kind} btn-busy` : kind}
      aria-busy={busy === decision || undefined}
      aria-disabled={busy !== null || undefined}
      onClick={() => void decide(decision)}
    >
      {busy !== decision && icon}
      {label}
    </button>
  );
  const actions: ReactNode[] = [];
  if (item.status === 'candidate')
    actions.push(
      action(
        'confirm',
        'btn pri',
        <Play aria-hidden="true" />,
        t({ id: 'memory.learnedDetail.confirm', defaultMessage: 'Start trial' }),
      ),
      <Menu
        key="reject"
        label={t({ id: 'memory.learnedDetail.rejectMenu', defaultMessage: 'Reason for rejecting' })}
        side="top"
        trigger={
          <button
            type="button"
            className={busy === 'reject' ? 'btn ghost btn-busy' : 'btn ghost'}
            aria-busy={busy === 'reject' || undefined}
            aria-disabled={busy !== null || undefined}
          >
            {t({ id: 'memory.learnedDetail.reject', defaultMessage: 'Reject' })}
            {busy !== 'reject' && <ChevronDown className="mld-down" aria-hidden="true" />}
          </button>
        }
      >
        <MenuItem onClick={() => void decide('reject', 'duplicate')}>
          {t({
            id: 'memory.learnedDetail.rejectDuplicate',
            defaultMessage: 'Duplicates an existing rule',
          })}
        </MenuItem>
        <MenuItem onClick={() => void decide('reject', 'not_useful')}>
          {t({ id: 'memory.learnedDetail.rejectNotUseful', defaultMessage: 'Not useful' })}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void decide('reject')}>
          <span className="mld-tx2">
            {t({ id: 'memory.learnedDetail.rejectNoReason', defaultMessage: 'No reason' })}
          </span>
        </MenuItem>
      </Menu>,
    );
  if (item.status === 'trial' || item.status === 'active') {
    if (change.type === 'policy_change')
      actions.push(
        action(
          'pin',
          'btn',
          <Pin aria-hidden="true" />,
          t({ id: 'memory.learnedDetail.pin', defaultMessage: 'Pin' }),
        ),
      );
    actions.push(
      action(
        'revert',
        'btn ghost',
        <Undo2 aria-hidden="true" />,
        t({ id: 'memory.learnedDetail.revert', defaultMessage: 'Revert' }),
      ),
    );
  }

  return (
    <aside
      className="mld"
      aria-label={t({ id: 'memory.learnedDetail.label', defaultMessage: 'Experience details' })}
    >
      <div className="mld-head">
        <Glyph tone={status.tone} />
        <span className="mld-status">
          {(item.status === 'rejected' && userRejectText(item)) || status.label()}
        </span>
        {time && <span className="mld-time">{time}</span>}
        <button
          type="button"
          className="ib mld-x"
          aria-label={t({ id: 'memory.learnedDetail.close', defaultMessage: 'Close details' })}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <p className="mld-rule">
        {change.type === 'experience' ? codeParts(change.procedure) : policyRule(change)}
      </p>

      {change.type === 'experience' && change.countercondition && (
        <div className="mld-sec">
          <span className="cap">
            {t({ id: 'memory.learnedDetail.countercondition', defaultMessage: 'Does not apply' })}
          </span>
          <p className="mld-sub mld-sel">{change.countercondition}</p>
        </div>
      )}

      <div
        className="panel mld-cells"
        style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
      >
        {cells.map((c) => (
          <div key={c.cap} className="cell mld-cell">
            <span className="cap">{c.cap}</span>
            <span className="mld-cv">{c.value}</span>
          </div>
        ))}
      </div>

      {item.status === 'trial' && change.type === 'experience' && trial && (
        <div className="mld-sec">
          <div className="mld-eh">
            <span className="cap">
              {t({ id: 'memory.learnedDetail.progress', defaultMessage: 'Trial progress' })}
            </span>
            <span className="mld-end">
              <span className="mld-mono mld-num">
                {trial.tasks_seen} / {trial.tasks_required}
              </span>
              <span className="mld-meta">
                {t(
                  {
                    id: 'memory.learnedDetail.progressTasks',
                    defaultMessage: '{count, plural, one {task} other {tasks}}',
                  },
                  { count: trial.tasks_required },
                )}
              </span>
            </span>
          </div>
          <div
            className="meter"
            style={
              {
                '--v': `${Math.min(100, (trial.tasks_seen / trial.tasks_required) * 100)}%`,
              } as CSSProperties
            }
            role="img"
            aria-label={t(
              {
                id: 'memory.learnedDetail.progressLabel',
                defaultMessage: 'Trial progress: {seen} of {required} tasks done',
              },
              { seen: trial.tasks_seen, required: trial.tasks_required },
            )}
          >
            <i />
          </div>
        </div>
      )}

      {item.status === 'trial' && trial?.status_reason === 'no_baseline' && (
        <div className="mld-note">
          <Glyph tone="idle" />
          <span>
            {t({
              id: 'memory.learnedDetail.noBaseline',
              defaultMessage:
                'Too few similar tasks before the trial to compare against yet; the trial goes on',
            })}
          </span>
        </div>
      )}

      {trial && compared.length > 0 && (
        <div className="mld-cmps">
          <div className="mld-cmp mld-cmph">
            <span>{t({ id: 'memory.learnedDetail.compare', defaultMessage: 'Comparison' })}</span>
            <span>
              {t({ id: 'memory.learnedDetail.compare.before', defaultMessage: 'Before' })}
            </span>
            <span>
              {t({ id: 'memory.learnedDetail.compare.trial', defaultMessage: 'On trial' })}
            </span>
          </div>
          {compared.map((m) => (
            <div key={m.name} className="mld-cmp">
              <span className="mld-cut">{METRIC_TEXT[m.name]?.() ?? m.name}</span>
              <span className="mld-mono mld-num">
                {metricValue(m, m.baseline!, trial.baseline_tasks)}
              </span>
              <span className="mld-mono mld-num mld-now">
                {metricValue(m, m.trial!, trial.tasks_seen)}
              </span>
            </div>
          ))}
        </div>
      )}

      {(used.error || (used.data?.length ?? 0) > 0) && (
        <div className="mld-sec">
          <div className="mld-eh">
            <span className="cap">
              {t({ id: 'memory.learnedDetail.usedIn', defaultMessage: 'Used in these sessions' })}
            </span>
            {used.data && (
              <span className="mld-end mld-mono mld-num mld-meta">{used.data.length}</span>
            )}
          </div>
          {used.error ? (
            <div className="mld-err" role="alert">
              <Glyph tone="bad" />
              <span>
                {t(
                  {
                    id: 'memory.learnedDetail.usedIn.failed',
                    defaultMessage: 'Couldn’t read the sessions: {error}',
                  },
                  { error: used.error },
                )}
              </span>
            </div>
          ) : (
            <div className="mld-rows">
              {used.data!.map((u) => {
                const session = listed.data?.find((s) => s.id === u.session_id);
                return (
                  <button
                    key={u.session_id}
                    type="button"
                    className="mld-rr"
                    onClick={() => useShell.getState().openSession(u.session_id)}
                  >
                    <span className="mld-sn">
                      {session && <SessionStateIcon session={session} place="list" />}
                      <span className="mld-cut">
                        {u.title ||
                          t(
                            { id: 'sessions.model.row.untitled', defaultMessage: 'Session {id}' },
                            { id: shortId(u.session_id) },
                          )}
                      </span>
                    </span>
                    <span />
                    <span className="mld-meta">
                      {u.delivered
                        ? t({
                            id: 'memory.learnedDetail.usedIn.delivered',
                            defaultMessage: 'Included',
                          })
                        : t({
                            id: 'memory.learnedDetail.usedIn.pending',
                            defaultMessage: 'Next turn',
                          })}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="mld-sec">
        <span className="cap">{effect.label}</span>
        <p className="mld-sub">{effect.text}</p>
      </div>

      <div className="mld-sec">
        <div className="mld-eh">
          <span className="cap">
            {t({ id: 'memory.learnedDetail.evidence', defaultMessage: 'Evidence' })}
          </span>
          <span className="mld-chips">
            <span className="chip">
              {leadRuntime && <RuntimeGlyph runtime={leadRuntime} size={12} />}
              {item.source === 'lead'
                ? t({
                    id: 'data.workflowPolicy.source.lead',
                    defaultMessage: 'Proposed by the lead',
                  })
                : t({
                    id: 'data.workflowPolicy.source.retrospective',
                    defaultMessage: 'Proposed by a retrospective',
                  })}
            </span>
            {item.signal && <span className="chip">{SIGNAL_TEXT[item.signal]()}</span>}
          </span>
        </div>
        {rows.length > 0 && (
          <div className="mld-rows">
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className="mld-rr"
                data-id={r.id}
                onClick={() => onOpenRetro(r.id)}
              >
                <span className="mld-cut">{taskName(r)}</span>
                <span className="mld-meta">{metricText(item.signal, r)}</span>
                <span className="mld-meta">{whenText(r.recorded_at, false)}</span>
              </button>
            ))}
          </div>
        )}
        {sharedCheck && (
          <span className="mld-check">
            <span>
              {t(
                {
                  id: 'memory.learnedDetail.sharedCheck',
                  defaultMessage: 'All {count} first failed on',
                },
                { count: rows.length },
              )}
            </span>
            <span className="mld-inl">{sharedCheck}</span>
          </span>
        )}
      </div>

      {actions.length > 0 && (
        <div className="mld-foot">
          {failed && (
            <div className="mld-err" role="alert">
              <Glyph tone="bad" />
              <span>{FAILED[failed.decision](failed.text)}</span>
            </div>
          )}
          <div className="mld-acts">{actions}</div>
        </div>
      )}
    </aside>
  );
}
