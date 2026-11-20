import type { BoardModel, BoardSnapshot, BoardTaskStatus, CommandType } from '@pantheon/protocol';
import { compareRuntimes, runtimeName } from '../../components/RuntimeGlyph';
import { composeState } from '../../data/transcript';
import { currentLocale, t } from '../../i18n';
import { messageCommand } from '../sessions/model';

export type BoardTask = BoardModel['tasks'][number];
export type BoardMilestone = BoardModel['milestones'][number];
export type BoardFinding = BoardModel['findings'][number];
export type BoardMerge = BoardModel['merges'][number];
export type BoardRisk = BoardModel['risks'][number];
export type SnapshotMilestone = NonNullable<BoardSnapshot['milestones']>[number];
export type SnapshotSession = BoardSnapshot['sessions'][number];

/** Runs one command; resolves to the failure text, or null once it went through. */
export type RunBoardCommand = (
  type: CommandType,
  input: Record<string, unknown>,
  expectedRevision: number | null,
) => Promise<string | null>;

/* Formatting */

const pad = (n: number) => String(n).padStart(2, '0');

export { durationText } from '../../lib/time-text';

export function tokenText(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function usdText(value: number | null): string {
  return value == null ? '—' : `$${value.toFixed(2)}`;
}

export { compareRuntimes, runtimeName };

export function modelLabel(runtime: string, model: string | null): string {
  return (
    model ??
    t(
      { id: 'board.models.unknown', defaultMessage: 'Unknown {runtime} model' },
      { runtime: runtimeName(runtime) },
    )
  );
}

/* Task list */

export const STATUS_ORDER: readonly BoardTaskStatus[] = [
  'waiting',
  'failed',
  'running',
  'idle',
  'ready',
  'todo',
  'done',
  'discarded',
];

export type TaskSortKey = 'task' | 'status' | 'duration';
export interface TaskSort {
  key: TaskSortKey;
  dir: 1 | -1;
}

/** From the first session's start to the merge, or to now while open. */
export function taskDuration(task: BoardTask, now: number): number | null {
  return task.started_at == null ? null : (task.ended_at ?? now) - task.started_at;
}

const byStatus = (a: BoardTask, b: BoardTask) =>
  STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);

export function sortTasks(tasks: readonly BoardTask[], sort: TaskSort | null, now: number) {
  if (!sort) return tasks.slice().sort(byStatus);
  const compare = {
    task: (a: BoardTask, b: BoardTask) => a.title.localeCompare(b.title, currentLocale()),
    status: byStatus,
    duration: (a: BoardTask, b: BoardTask) =>
      (taskDuration(a, now) ?? -1) - (taskDuration(b, now) ?? -1),
  }[sort.key];
  return tasks.slice().sort((a, b) => compare(a, b) * sort.dir || byStatus(a, b));
}

/** Ascending, then descending, then back to the status order. */
export function nextSort(current: TaskSort | null, key: TaskSortKey): TaskSort | null {
  if (current?.key !== key) return { key, dir: 1 };
  return current.dir === 1 ? { key, dir: -1 } : null;
}

export interface TimeTick {
  at: number;
  /** Set for day cells; the label sits in the middle of [at, end). */
  end?: number;
  label: string;
}

/** Three-hour marks within a day or less, otherwise one cell per local day. */
export function timeTicks(since: number, now: number): TimeTick[] {
  const first = new Date(since);
  if (now - since <= 36 * 3_600_000) {
    const ticks: TimeTick[] = [];
    const start = new Date(
      first.getFullYear(),
      first.getMonth(),
      first.getDate(),
      first.getHours(),
    );
    // Fixed hour steps: setHours lands twice on the hour after a skipped one.
    for (let h = 0; ; h++) {
      const at = start.getTime() + h * 3_600_000;
      if (at > now) break;
      const hour = new Date(at).getHours();
      if (at >= since && hour % 3 === 0) ticks.push({ at, label: `${pad(hour)}:00` });
    }
    return ticks;
  }
  const day = (i: number) =>
    new Date(first.getFullYear(), first.getMonth(), first.getDate() + i).getTime();
  const ticks: TimeTick[] = [];
  for (let i = 0; day(i) <= now; i++) {
    const date = new Date(day(i));
    const label = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    ticks.push({ at: day(i), end: day(i + 1), label });
  }
  return ticks;
}

/* Milestones */

export const MILESTONE_ROWS = 4;

export const milestoneFinished = (m: BoardMilestone) => m.status === 'completed';

/** Done and total tasks on a lead's milestone; merged and required sessions on a user's. */
export const milestoneCounts = (m: BoardMilestone): { done: number; total: number } =>
  m.tasks ?? { done: m.merged, total: m.session_ids.length };

/** In creation order; accepted ones go to the end. */
export function sortMilestones(milestones: readonly BoardMilestone[]): BoardMilestone[] {
  return milestones
    .slice()
    .sort((a, b) => Number(milestoneFinished(a)) - Number(milestoneFinished(b)));
}

export function visibleMilestones(milestones: readonly BoardMilestone[], expanded: boolean) {
  const sorted = sortMilestones(milestones);
  const rows = expanded ? sorted : sorted.slice(0, MILESTONE_ROWS);
  return { rows, hidden: sorted.length - rows.length };
}

export interface AcceptanceWatch {
  /** Milestones last seen not yet accepted. */
  unaccepted: ReadonlySet<string>;
  /** Milestones seen going from unaccepted to accepted; their check plays once. */
  accepted: ReadonlySet<string>;
}

/** The next watch over the milestones; the first look (null) only records, so nothing already accepted plays. */
export function watchAcceptance(
  watch: AcceptanceWatch | null,
  milestones: readonly Pick<BoardMilestone, 'id' | 'status'>[],
): AcceptanceWatch {
  const accepted = new Set(watch?.accepted);
  for (const m of milestones)
    if (m.status === 'completed' && watch?.unaccepted.has(m.id)) accepted.add(m.id);
  const unaccepted = new Set(milestones.filter((m) => m.status !== 'completed').map((m) => m.id));
  return { unaccepted, accepted };
}

/** `session:<id>` for each required session that is merged, in the milestone's order. */
export function acceptanceEvidence(
  milestone: Pick<BoardMilestone, 'session_ids'>,
  merges: readonly Pick<BoardMerge, 'session_id'>[],
  sessions: readonly Pick<SnapshotSession, 'id' | 'outcome'>[],
): string[] {
  const merged = new Set([
    ...merges.map((m) => m.session_id),
    ...sessions.filter((s) => s.outcome === 'merged').map((s) => s.id),
  ]);
  return milestone.session_ids.filter((id) => merged.has(id)).map((id) => `session:${id}`);
}

/** The project's sessions a milestone can require: the ones that work on its code. */
export function milestoneSessions(
  sessions: readonly SnapshotSession[],
  projectId: string,
): SnapshotSession[] {
  return sessions.filter(
    (s) =>
      s.project_id === projectId &&
      !!s.workspace_id &&
      !s.resident &&
      !s.baseline &&
      !s.intro &&
      !s.change_story &&
      !s.runtime_review &&
      !s.review_id,
  );
}

/** One criterion per non-blank line. */
export function criteriaLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/* Telling the lead */

export interface TellLeadState {
  type: 'session.send' | 'session.steer';
  enabled: boolean;
  reason: string | null;
}

/** The command a message to the lead goes out as, and whether it can go now. */
export function tellLead(lead: SnapshotSession | undefined): TellLeadState {
  if (!lead)
    return {
      type: 'session.send',
      enabled: false,
      reason: t({ id: 'board.tellLead.leadGone', defaultMessage: 'The lead session is gone' }),
    };
  const type = messageCommand(lead.state);
  const state = composeState(lead)[type === 'session.steer' ? 'steer' : 'send'];
  return { type, enabled: state.enabled, reason: state.reason };
}

/** Board task ids are `<lead session id>:<task id>`; the lead knows the part after the colon. */
export function tellLeadDraft(kind: 'task' | 'milestone', title: string, id: string): string {
  if (kind === 'milestone')
    return t(
      {
        id: 'board.tellLead.draftMilestone',
        defaultMessage: 'About milestone “{title}” ({id}):\n',
      },
      { title, id },
    );
  return t(
    { id: 'board.tellLead.draftTask', defaultMessage: 'About task “{title}” ({id}):\n' },
    { title, id: id.slice(id.indexOf(':') + 1) },
  );
}

/* Usage */

export type UsageFill = 'solid' | 'hatch' | 'other';
export interface UsageSeries {
  key: string;
  runtime: string;
  label: string;
  /** First model of a runtime is solid, the second hatched, the rest share one "other" series. */
  fill: UsageFill;
}

const seriesKey = (runtime: string, model: string | null) => `${runtime}\u0000${model ?? ''}`;
const otherKey = (runtime: string) => `${runtime}\u0000\u0001`;

const otherModelsLabel = (runtime: string) =>
  t(
    { id: 'board.models.other', defaultMessage: 'Other {runtime} models' },
    { runtime: runtimeName(runtime) },
  );

/** Bottom to top: Claude, Codex, then other runtimes; inside one, by first use in the project. */
export function usageSeries(models: BoardModel['models']): UsageSeries[] {
  const runtimes = [...new Set(models.map((m) => m.runtime))].sort(compareRuntimes);
  return runtimes.flatMap((runtime) => {
    const own = models
      .filter((m) => m.runtime === runtime)
      .sort((a, b) => a.first_seen - b.first_seen);
    const series: UsageSeries[] = own.slice(0, 2).map((m, i) => ({
      key: seriesKey(runtime, m.model),
      runtime,
      label: modelLabel(runtime, m.model),
      fill: i === 0 ? 'solid' : 'hatch',
    }));
    if (own.length > 2)
      series.push({
        key: otherKey(runtime),
        runtime,
        label: otherModelsLabel(runtime),
        fill: 'other',
      });
    return series;
  });
}

/** The series a usage row stacks into; models missing from the list fold into their runtime's "other". */
export function seriesOf(series: readonly UsageSeries[], runtime: string, model: string | null) {
  const key = seriesKey(runtime, model);
  return (
    series.find((s) => s.key === key) ??
    series.find((s) => s.key === otherKey(runtime)) ?? {
      key: otherKey(runtime),
      runtime,
      label: otherModelsLabel(runtime),
      fill: 'other' as const,
    }
  );
}

/* Lists */

export const MERGE_ROWS = 8;

export function recentMerges(merges: readonly BoardMerge[]): BoardMerge[] {
  return merges
    .slice()
    .sort((a, b) => b.merged_at - a.merged_at)
    .slice(0, MERGE_ROWS);
}

export function visibleFindings(findings: readonly BoardFinding[], all: boolean): BoardFinding[] {
  return all ? findings.slice() : findings.filter((f) => f.state === 'open');
}
