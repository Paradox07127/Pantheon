import { useState, type CSSProperties, type ReactNode } from 'react';
import { LoadError } from '../../components/LoadError';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, FileText, Flag } from 'lucide-react';
import type { ImprovementSignal } from '@pantheon/domain';
import type { BoardModel, BoardSessionTime } from '@pantheon/protocol';
import { Skeleton } from '../../components/Skeleton';
import { compareRuntimes, runtimeName, RuntimeGlyph } from '../../components/RuntimeGlyph';
import { noticeResult, toast } from '../../components/Toast';
import { addPermissionRule, removePermissionRule } from '../../data/permission-rules';
import {
  kindText,
  useImprovementSignals,
  type ImprovementFinding,
} from '../../data/workflow-policy';
import { currentLocale, t } from '../../i18n';
import { Empty } from '../board/Charts';
import { durationText } from '../board/panels-model';
import { localDay, previousText } from '../board/usage-model';
import { failureText, type Failure } from '../settings/ProjectSettingsScreen';
import { openRetrospective, openSettingsPage } from '../settings/settings-jump';
import './digest.css';

export interface DigestPanelProps {
  /** The board.view read of the week the digest covers; null until the first read lands. */
  model: BoardModel | null;
  projectId: string;
  /** The top bar's place for the week switch and the export button, once it is in. */
  bar: HTMLElement | null;
  /** Weeks back from the 7 days through today, which are week 0. */
  week: number;
  onWeek: (week: number) => void;
}

/** Below this many finished tasks the runtime comparison says its sample is small. */
const SMALL_SAMPLE = 30;

type Evidence = NonNullable<ImprovementFinding['evidence']>;

const SIGNAL_TEXT: Record<
  Exclude<ImprovementSignal, Evidence['kind']>,
  (count: number, kind: string) => string
> = {
  dispatch_overhead: (count, kind) =>
    t(
      {
        id: 'insights.digest.signal.dispatchOverhead',
        defaultMessage:
          '{count, plural, one {On the last # dispatched {kind} task the lead spent more input tokens than the task session, and its gates passed first time.} other {On the last # dispatched {kind} tasks the lead spent more input tokens than the task sessions, and every gate passed first time.}}',
      },
      { count, kind },
    ),
  direct_rework: (count, kind) =>
    t(
      {
        id: 'insights.digest.signal.directRework',
        defaultMessage:
          '{count, plural, one {The last {kind} task the lead did itself needed more than one gate run.} other {Several of the last # {kind} tasks the lead did itself needed more than one gate run.}}',
      },
      { count, kind },
    ),
  over_budget: (count, kind) =>
    t(
      {
        id: 'insights.digest.signal.overBudget',
        defaultMessage:
          '{count, plural, one {The last {kind} task went over its budget.} other {Most of the last # {kind} tasks went over their budget.}}',
      },
      { count, kind },
    ),
  idle_wakeups: (count) =>
    t(
      {
        id: 'insights.digest.signal.idleWakeups',
        defaultMessage:
          '{count, plural, one {Over the last task, most wake-ups of the lead ended without a decision.} other {Over the last # tasks, most wake-ups of the lead ended without a decision.}}',
      },
      { count },
    ),
  queue_wait: (count) =>
    t(
      {
        id: 'insights.digest.signal.queueWait',
        defaultMessage:
          '{count, plural, one {The last task waited for a free place longer than half its run time.} other {Over the last # tasks, waiting for a free place took more than half of the run time.}}',
      },
      { count },
    ),
  merge_conflicts: (count) =>
    t(
      {
        id: 'insights.digest.signal.mergeConflicts',
        defaultMessage:
          '{count, plural, one {The last task was handed back for a rebase conflict.} other {Several of the last # tasks were handed back for a rebase conflict.}}',
      },
      { count },
    ),
  repeat_gate_failure: (count) =>
    t(
      {
        id: 'insights.digest.signal.repeatGateFailure',
        defaultMessage:
          '{count, plural, one {The same gate check failed in # retrospective.} other {The same gate check failed in # retrospectives.}}',
      },
      { count },
    ),
  repeat_turn_failure: (count) =>
    t(
      {
        id: 'insights.digest.signal.repeatTurnFailure',
        defaultMessage:
          '{count, plural, one {Turns failed with the same error in # retrospective.} other {Turns failed with the same error in # retrospectives.}}',
      },
      { count },
    ),
  handback_loop: () =>
    t({
      id: 'insights.digest.signal.handbackLoop',
      defaultMessage: 'A task was handed back for the same reason as often as the handback limit.',
    }),
};

/** A finding's text; for an always-approved command, the text after the command. */
const findingText = (finding: ImprovementFinding) => {
  const { evidence } = finding;
  if (evidence?.kind === 'always_approved_command')
    return t(
      {
        id: 'insights.digest.rule.alwaysApproved',
        defaultMessage:
          'approved {approvals, plural, one {# time} other {# times}} this week, never refused.',
      },
      { approvals: evidence.approvals },
    );
  if (evidence?.kind === 'late_gate_failure')
    return t(
      {
        id: 'insights.digest.rule.lateGateFailure',
        defaultMessage:
          '{name} failed {runs, plural, one {# time} other {# times}}, each time after {duration} of earlier steps.',
      },
      {
        name: evidence.name,
        runs: evidence.runs,
        duration: durationText(evidence.median_prior_ms),
      },
    );
  // The signals over events always come with their evidence and rest on no retrospective.
  return SIGNAL_TEXT[finding.signal as keyof typeof SIGNAL_TEXT](
    finding.retrospective_ids.length,
    finding.cell ? kindText(finding.cell.domain, finding.cell.tier) : '',
  );
};

/**
 * The findings that rest on a retrospective of the range and still suggest something, after
 * this week's findings over the last 7 days of events.
 */
export function digestFindings(
  model: BoardModel,
  findings: readonly ImprovementFinding[],
  week: number,
): ImprovementFinding[] {
  const inRange = new Set(
    model.tasks.flatMap(({ retrospective }) =>
      retrospective?.id && recordedInWeek(model, retrospective) ? retrospective.id : [],
    ),
  );
  const kept = findings.filter((f) => !f.withheld);
  return [
    ...(week === 0 ? kept.filter((f) => f.evidence) : []),
    ...kept.filter((f) => !f.evidence && f.retrospective_ids.some((id) => inRange.has(id))),
  ];
}

interface MergeGroup {
  key: string;
  title: string | null;
  tasks: number;
  completed: boolean;
}

/** The merged tasks by milestone, in the board's milestone order, those outside any milestone last. */
export function mergeGroups(model: BoardModel): MergeGroup[] {
  const bySession = new Map<string, BoardModel['tasks'][number]>();
  for (const task of model.tasks) {
    if (!task.owner_session_id) bySession.set(task.id, task);
    for (const { session_id } of task.segments) if (session_id) bySession.set(session_id, task);
    if (task.claim) bySession.set(task.claim.session_id, task);
    if (task.evidence) bySession.set(task.evidence.session_id, task);
  }
  const merged = new Map<string | null, Set<string>>();
  for (const merge of model.merges) {
    const task = bySession.get(merge.session_id);
    const milestone =
      model.milestones.find((m) => m.id === task?.milestone_id) ??
      model.milestones.find((m) => m.session_ids.includes(merge.session_id));
    const key = milestone?.id ?? null;
    merged.set(key, (merged.get(key) ?? new Set()).add(task?.id ?? merge.session_id));
  }
  const groups: MergeGroup[] = model.milestones.flatMap((m) => {
    const tasks = merged.get(m.id)?.size ?? 0;
    return tasks ? [{ key: m.id, title: m.title, tasks, completed: m.status === 'completed' }] : [];
  });
  const loose = merged.get(null)?.size ?? 0;
  if (loose) groups.push({ key: '', title: null, tasks: loose, completed: false });
  return groups;
}

interface RuntimeSplit {
  runtime: string;
  first: number;
  rework: number;
}

/** The week's first and last local day, and the end of its last day. */
function weekOf({ since }: Pick<BoardModel, 'since'>) {
  const first = new Date(since);
  const day = (n: number) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + n);
  return { first, last: day(6), end: day(7).getTime() };
}

const recordedInWeek = (
  model: BoardModel,
  { recorded_at }: NonNullable<BoardModel['tasks'][number]['retrospective']>,
) => recorded_at !== undefined && recorded_at >= model.since && recorded_at < weekOf(model).end;

/** The week's dates; the month is written once when both ends share it. */
const weekText = (model: Pick<BoardModel, 'since'>) => {
  const { first, last } = weekOf(model);
  const day = new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' });
  const end =
    first.getMonth() === last.getMonth()
      ? new Intl.DateTimeFormat(currentLocale(), { day: 'numeric' })
      : day;
  return t(
    { id: 'insights.digest.weekRange', defaultMessage: '{from} to {to}' },
    { from: day.format(first), to: end.format(last) },
  );
};

/** Each runtime's tasks with a retrospective recorded in the week: gates passed on the first run, and the rest. */
export function runtimeSplits(model: BoardModel): RuntimeSplit[] {
  const splits = new Map<string, RuntimeSplit>();
  for (const task of model.tasks) {
    const retro = task.retrospective;
    if (!retro || retro.outcome === 'removed' || !task.claim) continue;
    if (!recordedInWeek(model, retro)) continue;
    // A finished task with no passing gate run had no gate run to repeat.
    if (retro.gate_passed_on_attempt === undefined && retro.outcome !== 'failed') continue;
    const { runtime } = task.claim;
    const split = splits.get(runtime) ?? { runtime, first: 0, rework: 0 };
    splits.set(runtime, split);
    if (retro.gate_passed_on_attempt === 1) split.first++;
    else split.rework++;
  }
  return [...splits.values()].sort((a, b) => compareRuntimes(a.runtime, b.runtime));
}

const discardedTotal = (model: BoardModel) =>
  Object.values(model.task_progress.totals).reduce((sum, n) => sum + n, 0);

// The merged sessions' median, the population of last week's median and of the session time.
const cycleText = (model: BoardModel) => {
  const { median_ms } = model.counts;
  return median_ms !== null ? durationText(median_ms) : '—';
};

/** Last week's merges and start to merge, beside this week's. */
const previousNotes = (model: BoardModel) => {
  const before = model.counts.previous;
  return {
    merged: previousText(7, before && String(before.merged)),
    cycle: previousText(7, before?.median_ms != null ? durationText(before.median_ms) : undefined),
  };
};

const LABEL = {
  get title() {
    return t({ id: 'insights.digest.label', defaultMessage: 'Weekly digest' });
  },
  get merged() {
    return t({ id: 'insights.digest.merged', defaultMessage: 'Merged' });
  },
  get cycle() {
    return t({ id: 'insights.quality.cycle', defaultMessage: 'Start to merge' });
  },
  get waiting() {
    return t({ id: 'insights.digest.waiting', defaultMessage: 'Of which waiting for you' });
  },
  get discarded() {
    return t({ id: 'insights.digest.discarded', defaultMessage: 'Discarded tasks' });
  },
  get rules() {
    return t({ id: 'insights.digest.rules', defaultMessage: 'Rules worth changing' });
  },
  get mergedWhat() {
    return t({ id: 'insights.digest.mergedWhat', defaultMessage: 'Merged this week' });
  },
  get runtimes() {
    return t({ id: 'insights.digest.runtimes', defaultMessage: 'How each runtime did' });
  },
  get noMilestone() {
    return t({ id: 'insights.digest.noMilestone', defaultMessage: 'Not in any milestone' });
  },
  get sessionTime() {
    return t({ id: 'insights.digest.sessionTime', defaultMessage: 'Where a session’s time goes' });
  },
  get waitByReason() {
    return t({
      id: 'insights.digest.waitByReason',
      defaultMessage: 'Time waiting for you, by reason',
    });
  },
};

const sessionMedianText = (time: BoardSessionTime) =>
  t(
    {
      id: 'insights.digest.sessionMedian',
      defaultMessage: '{count, plural, one {Median of # session} other {Median of # sessions}}',
    },
    { count: time.sessions },
  );

const ofTotal = (count: number) =>
  t({ id: 'insights.digest.ofTotal', defaultMessage: 'of {count}' }, { count });

const groupText = (group: MergeGroup) =>
  group.completed
    ? t(
        {
          id: 'insights.digest.tasksCompleted',
          defaultMessage: '{count, plural, one {# task, completed} other {# tasks, completed}}',
        },
        { count: group.tasks },
      )
    : t(
        {
          id: 'insights.digest.tasks',
          defaultMessage: '{count, plural, one {# task} other {# tasks}}',
        },
        { count: group.tasks },
      );

const splitText = (split: RuntimeSplit) =>
  t(
    { id: 'insights.digest.split', defaultMessage: '{first} first pass, {rework} reworked' },
    { first: split.first, rework: split.rework },
  );

const line = (label: string, value: string) =>
  t({ id: 'insights.digest.line', defaultMessage: '{label}: {value}' }, { label, value });

const noteLine = (label: string, value: string, note: string | undefined) =>
  note === undefined
    ? line(label, value)
    : t(
        { id: 'insights.digest.lineNote', defaultMessage: '{label}: {value} ({note})' },
        { label, value, note },
      );

/** The digest of week `week` as a markdown document, with the numbers and blocks the panel shows. */
export function digestMarkdown(
  model: BoardModel,
  findings: readonly ImprovementFinding[],
  week: number,
): string {
  const rules = digestFindings(model, findings, week);
  const groups = mergeGroups(model);
  const splits = runtimeSplits(model);
  const current = week === 0;
  const notes = previousNotes(model);
  const { session_time: time, wait_by_reason_ms: waits } = model.counts;
  const wait = waitKpi(time);
  const reasons = waitReasons(waits);
  const ruleText = (f: ImprovementFinding) =>
    f.evidence?.kind === 'always_approved_command'
      ? `\`${f.evidence.command}\` ${findingText(f)}`
      : findingText(f);
  return [
    `# ${t(
      { id: 'insights.digest.heading', defaultMessage: '{title}, {range}' },
      { title: LABEL.title, range: weekText(model) },
    )}`,
    '',
    `- ${noteLine(LABEL.merged, String(model.counts.merged), notes.merged)}`,
    `- ${noteLine(LABEL.cycle, cycleText(model), notes.cycle)}`,
    `- ${noteLine(LABEL.waiting, wait.value, wait.note)}`,
    ...(current
      ? [
          `- ${t(
            { id: 'insights.digest.lineNote', defaultMessage: '{label}: {value} ({note})' },
            {
              label: LABEL.discarded,
              value: String(model.task_progress.totals.discarded),
              note: ofTotal(discardedTotal(model)),
            },
          )}`,
        ]
      : []),
    '',
    ...(time
      ? [
          `## ${LABEL.sessionTime}`,
          '',
          sessionMedianText(time),
          '',
          ...PARTS.map((p) => `- ${line(p.label(), durationText(time[p.key]))}`),
          '',
        ]
      : []),
    ...(reasons.length > 0
      ? [
          `## ${LABEL.waitByReason}`,
          '',
          ...reasons.map((r) => `- ${line(r.label(), durationText(r.ms))}`),
          '',
        ]
      : []),
    ...(current ? [`## ${LABEL.rules}`, '', ...rules.map((f) => `- ${ruleText(f)}`), ''] : []),
    `## ${LABEL.mergedWhat}`,
    '',
    ...groups.map((g) => `- ${line(g.title ?? LABEL.noMilestone, groupText(g))}`),
    '',
    `## ${LABEL.runtimes}`,
    '',
    ...splits.map((s) => `- ${line(runtimeName(s.runtime), splitText(s))}`),
    '',
  ].join('\n');
}

/** Saves the text through a download link; the bridge has no save dialog. */
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

const fileName = (model: BoardModel) => {
  const { first, last } = weekOf(model);
  return `digest-${localDay(first)}-${localDay(last)}.md`;
};

/**
 * The top bar's week buttons around the week's dates, then `end`; without the read's first day the
 * dates are those of the 7 days through the day `week` weeks before today.
 */
export function weekSwitch({
  bar,
  since,
  week,
  onWeek,
  end,
}: {
  bar: HTMLElement;
  since?: number;
  week: number;
  onWeek: (week: number) => void;
  end?: ReactNode;
}) {
  const today = new Date();
  since ??= new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 6 - 7 * week,
  ).getTime();
  return createPortal(
    <>
      <button
        type="button"
        className="ib"
        aria-label={t({
          id: 'insights.digest.previousWeek',
          defaultMessage: 'Previous week',
        })}
        onClick={() => onWeek(week + 1)}
      >
        <ChevronLeft aria-hidden="true" />
      </button>
      <span className="wkd-wk">{weekText({ since })}</span>
      <button
        type="button"
        className="ib"
        aria-label={t({ id: 'insights.digest.nextWeek', defaultMessage: 'Next week' })}
        disabled={week === 0}
        onClick={() => onWeek(week - 1)}
      >
        <ChevronRight aria-hidden="true" />
      </button>
      {end}
    </>,
    bar,
  );
}

function DigestSkeleton() {
  return (
    <div className="wkd" aria-busy="true">
      <div className="panel wkd-kpis">
        {[0, 1, 2].map((i) => (
          <div key={i} className="cell">
            <Skeleton style={{ width: 64, height: 16 }} />
            <Skeleton style={{ width: 48, height: 28 }} />
          </div>
        ))}
      </div>
      <div className="panel">
        <div className="cell">
          <Skeleton style={{ width: 120, height: 20 }} />
          <Skeleton />
          <Skeleton />
        </div>
      </div>
      <div className="panel wkd-two">
        {[0, 1].map((i) => (
          <div key={i} className="cell">
            <Skeleton style={{ width: 120, height: 20 }} />
            <Skeleton />
            <Skeleton />
          </div>
        ))}
      </div>
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="cell wkd-k">
      <span className="cap">{label}</span>
      <div className="wkd-kv">
        <span className="kpi">{value}</span>
        {note && <span className="wkd-d">{note}</span>}
      </div>
    </div>
  );
}

/** The median session's wait and its share of the four parts; the share is absent when they sum to 0. */
function waitKpi(time: BoardSessionTime | undefined) {
  if (!time) return { value: '—' };
  const total = time.working_ms + time.waiting_ms + time.gate_ms + time.queue_ms;
  return {
    value: durationText(time.waiting_ms),
    note:
      total > 0
        ? t(
            { id: 'insights.digest.waitShare', defaultMessage: '{share}%' },
            { share: Math.round((time.waiting_ms / total) * 100) },
          )
        : undefined,
  };
}

type Part = 'working_ms' | 'waiting_ms' | 'gate_ms' | 'queue_ms';

// Each part's colour: running, waiting, review, neutral.
const PARTS: { key: Part; c: string; label: () => string }[] = [
  {
    key: 'working_ms',
    c: 'run',
    label: () => t({ id: 'insights.digest.part.working', defaultMessage: 'Agent working' }),
  },
  {
    key: 'waiting_ms',
    c: 'wait',
    label: () => t({ id: 'insights.digest.part.waiting', defaultMessage: 'Waiting for you' }),
  },
  {
    key: 'gate_ms',
    c: 'rev',
    label: () => t({ id: 'insights.digest.part.gates', defaultMessage: 'Gates' }),
  },
  {
    key: 'queue_ms',
    c: 'idle',
    label: () => t({ id: 'insights.digest.part.queued', defaultMessage: 'Queued' }),
  },
];

type WaitReasons = NonNullable<BoardModel['counts']['wait_by_reason_ms']>;

const REASONS: { key: keyof WaitReasons; label: () => string }[] = [
  {
    key: 'approval',
    label: () => t({ id: 'insights.digest.reason.approval', defaultMessage: 'Approving commands' }),
  },
  {
    key: 'review',
    label: () => t({ id: 'insights.digest.reason.review', defaultMessage: 'Review and merge' }),
  },
  {
    key: 'question',
    label: () =>
      t({ id: 'insights.digest.reason.question', defaultMessage: 'Answering questions' }),
  },
];

/** The reasons with time, in a fixed order. */
const waitReasons = (waits: WaitReasons | undefined) =>
  REASONS.flatMap((r) => {
    const ms = waits?.[r.key];
    return ms === undefined ? [] : [{ ...r, ms }];
  });

/** Where a merged session's time goes, and the user's wait by reason. */
function SessionTime({ time, waits }: { time?: BoardSessionTime; waits?: WaitReasons }) {
  const reasons = waitReasons(waits);
  const longest = Math.max(...reasons.map((r) => r.ms));
  return (
    <div className="cell">
      {time && (
        <>
          <div className="wkd-h">
            <h3>{LABEL.sessionTime}</h3>
            <span className="wkd-hn">{sessionMedianText(time)}</span>
          </div>
          <span
            className="wkd-seg wkd-seg-lg"
            role="img"
            aria-label={t(
              {
                id: 'insights.digest.sessionTimeLabel',
                defaultMessage:
                  'Agent working {working}, waiting for you {waiting}, gates {gates}, queued {queued}',
              },
              {
                working: durationText(time.working_ms),
                waiting: durationText(time.waiting_ms),
                gates: durationText(time.gate_ms),
                queued: durationText(time.queue_ms),
              },
            )}
          >
            {PARTS.map(
              (p) =>
                time[p.key] > 0 && (
                  <i key={p.key} data-c={p.c} style={{ '--n': time[p.key] } as CSSProperties} />
                ),
            )}
          </span>
          <div className="legend">
            {PARTS.map((p) => (
              <span key={p.key}>
                <i className="wkd-dot" data-c={p.c} aria-hidden="true" />
                <span>{p.label()}</span>
                <span className="wkd-lv">{durationText(time[p.key])}</span>
              </span>
            ))}
          </div>
        </>
      )}
      {reasons.length > 0 && (
        <>
          {time && <hr className="wkd-sep" />}
          <span className="cap">{LABEL.waitByReason}</span>
          <ul className="wkd-wait">
            {reasons.map((r) => (
              <li key={r.key}>
                <span>{r.label()}</span>
                <span
                  className="meter"
                  aria-hidden="true"
                  style={{ '--v': `${Math.round((r.ms / longest) * 100)}%` } as CSSProperties}
                >
                  <i />
                </span>
                <span className="wkd-wv">{durationText(r.ms)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export interface AllowRuleProps {
  projectId: string;
  /** The project rule the command's last approval backs. */
  rule: string;
  /** The session of that approval. */
  sessionId: string;
}

/**
 * Adds the rule to the project and offers to undo it; the finding leaves the next improvement.signals
 * read, which the board moving after the command starts.
 */
export function AllowRule({ projectId, rule, sessionId }: AllowRuleProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const allow = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await addPermissionRule(projectId, rule, sessionId);
    setBusy(false);
    if (!result.ok) {
      setFailure(result.error);
      return;
    }
    noticeResult({
      tone: 'done',
      heading: t({
        id: 'insights.digest.allowedForProject',
        defaultMessage: 'Always allowed for this project',
      }),
      command: rule,
      actions: [
        {
          label: t({ id: 'insights.digest.undo', defaultMessage: 'Undo' }),
          run: () =>
            void removePermissionRule(projectId, rule).then((undone) => {
              if (!undone.ok) toast({ title: failureText(undone.error), kind: 'failure' });
            }),
        },
      ],
    });
  };
  return (
    <>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void allow()}>
        {t({
          id: 'insights.digest.allowForProject',
          defaultMessage: 'Always allow for this project',
        })}
      </button>
      {failure && (
        <div className="pj-err" role="alert">
          <b>{failureText(failure)}</b>
        </div>
      )}
    </>
  );
}

/** The week in review: what merged, how long it took, the rules worth changing and how each runtime did. */
export function DigestPanel({ model, projectId, bar, week, onWeek }: DigestPanelProps) {
  const signals = useImprovementSignals(projectId);
  if (!model || (signals.read === null && !signals.error)) return <DigestSkeleton />;
  const findings = signals.read ?? [];
  const rules = digestFindings(model, findings, week);
  const groups = mergeGroups(model);
  const splits = runtimeSplits(model);
  const sample = splits.reduce((sum, s) => sum + s.first + s.rework, 0);
  // Only what the read moves to an earlier week is drawn for it.
  const current = week === 0;
  const notes = previousNotes(model);
  const { session_time: time, wait_by_reason_ms: waits } = model.counts;
  const timed = Boolean(time || waits);
  return (
    <section className="wkd" aria-label={LABEL.title}>
      {bar &&
        weekSwitch({
          bar,
          since: model.since,
          week,
          onWeek,
          end: (
            <button
              type="button"
              className="btn"
              onClick={() => download(digestMarkdown(model, findings, week), fileName(model))}
            >
              <FileText aria-hidden="true" />
              {t({ id: 'insights.digest.export', defaultMessage: 'Export' })}
            </button>
          ),
        })}
      <div className="panel wkd-kpis">
        <Kpi label={LABEL.merged} value={String(model.counts.merged)} note={notes.merged} />
        <Kpi label={LABEL.cycle} value={cycleText(model)} note={notes.cycle} />
        <Kpi label={LABEL.waiting} {...waitKpi(time)} />
        {current && (
          <Kpi
            label={LABEL.discarded}
            value={String(model.task_progress.totals.discarded)}
            note={ofTotal(discardedTotal(model))}
          />
        )}
      </div>
      {(current || timed) && (
        <div className={current && timed ? 'panel wkd-two' : 'panel'}>
          {timed && <SessionTime time={time} waits={waits} />}
          {current && (
            <div className="cell">
              <div className="wkd-h">
                <h3>{LABEL.rules}</h3>
              </div>
              {signals.error && <LoadError message={signals.error} onRetry={signals.reload} />}
              {signals.read &&
                (rules.length === 0 ? (
                  <Empty
                    text={t({
                      id: 'insights.digest.noRules',
                      defaultMessage: 'Nothing to change this week',
                    })}
                  />
                ) : (
                  <ul className="wkd-rules">
                    {rules.map((finding, i) => (
                      <li key={`${finding.signal}-${i}`} className="wkd-rule">
                        {finding.evidence?.kind === 'always_approved_command' ? (
                          <span className="wkd-rt">
                            <code className="wkd-cmd" title={finding.evidence.command}>
                              {finding.evidence.command}
                            </code>
                            {` ${findingText(finding)}`}
                          </span>
                        ) : (
                          <span className="wkd-rt">{findingText(finding)}</span>
                        )}
                        {finding.evidence?.kind === 'always_approved_command' &&
                          finding.evidence.rule !== undefined &&
                          finding.evidence.session_id !== undefined && (
                            <AllowRule
                              projectId={projectId}
                              rule={finding.evidence.rule}
                              sessionId={finding.evidence.session_id}
                            />
                          )}
                        {finding.evidence?.kind === 'late_gate_failure' ? (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => openSettingsPage(projectId, 'gates')}
                          >
                            {t({
                              id: 'insights.digest.openGateSettings',
                              defaultMessage: 'Open gate settings',
                            })}
                          </button>
                        ) : (
                          !finding.evidence && (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => openRetrospective(finding.retrospective_ids[0])}
                            >
                              {t({
                                id: 'insights.digest.openRetro',
                                defaultMessage: 'Open retrospective',
                              })}
                            </button>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
                ))}
            </div>
          )}
        </div>
      )}
      <div className="panel wkd-two">
        <div className="cell">
          <div className="wkd-h">
            <h3>{LABEL.mergedWhat}</h3>
            <span className="wkd-hn">{groups.reduce((sum, g) => sum + g.tasks, 0)}</span>
          </div>
          {groups.length === 0 ? (
            <Empty
              text={t({
                id: 'insights.digest.noMerges',
                defaultMessage: 'Nothing merged this week',
              })}
            />
          ) : (
            <ul className="wkd-ms">
              {groups.map((group) => (
                <li key={group.key} data-loose={group.title === null || undefined}>
                  {group.title === null ? (
                    <FileText aria-hidden="true" />
                  ) : (
                    <Flag aria-hidden="true" />
                  )}
                  <span className="wkd-mt">{group.title ?? LABEL.noMilestone}</span>
                  <span className="wkd-mn">{groupText(group)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="cell">
          <div className="wkd-h">
            <h3>{LABEL.runtimes}</h3>
          </div>
          {splits.length === 0 ? (
            <Empty
              text={t({
                id: 'insights.digest.noModels',
                defaultMessage: 'No finished tasks this week',
              })}
            />
          ) : (
            <>
              <ul className="wkd-rts">
                {splits.map((split) => (
                  <li key={split.runtime}>
                    <span className="wkd-rn">
                      <RuntimeGlyph runtime={split.runtime} />
                      {runtimeName(split.runtime)}
                    </span>
                    <span
                      className="wkd-seg"
                      role="img"
                      aria-label={t(
                        {
                          id: 'insights.digest.splitLabel',
                          defaultMessage:
                            '{runtime}: {first} passed gates first time, {rework} reworked',
                        },
                        {
                          runtime: runtimeName(split.runtime),
                          first: split.first,
                          rework: split.rework,
                        },
                      )}
                    >
                      {split.first > 0 && (
                        <i data-c="ok" style={{ '--n': split.first } as CSSProperties} />
                      )}
                      {split.rework > 0 && (
                        <i data-c="bad" style={{ '--n': split.rework } as CSSProperties} />
                      )}
                    </span>
                    <span className="wkd-mn">{splitText(split)}</span>
                  </li>
                ))}
              </ul>
              {sample < SMALL_SAMPLE && (
                <span className="wkd-note">
                  {t(
                    {
                      id: 'insights.digest.smallSample',
                      defaultMessage:
                        '{count, plural, one {Only # task in the sample; the difference may just be the task.} other {Only # tasks in the sample; the difference may just be the tasks.}}',
                    },
                    { count: sample },
                  )}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
