import type {
  BoardActivity,
  BoardModel,
  BoardTaskState,
  BoardTaskStatus,
  RuntimeStatus,
} from '@pantheon/protocol';
import { recapLine } from '../../components/SessionStateIcon';
import { ageText, reasonText } from '../../data/needs-you';
import { t } from '../../i18n';
import { blockerTexts } from '../../lib/daemon-text';
import { listText } from '../../lib/list-text';
import { callVerb } from '../runtime/call-rows';
import { VERB } from '../runtime/CallTable';
import type { NodeLook } from './FlowNode';
import { durationText, type BoardTask } from './panels-model';
import { STATUS } from './status';

type Board = Pick<BoardModel, 'tasks' | 'edges' | 'merges' | 'task_places'>;

export interface TaskBadge {
  kind: 'waiting' | 'upstream' | 'blocked' | 'stalled' | 'looping' | 'attempt' | 'handed_back';
  label: string;
  /** Shown next to the badge's icon. */
  count?: number;
  /** What a `waiting` badge waits for. */
  waits?: 'approval' | 'question';
}

export const PHASE: Record<BoardActivity['phase'], string> = {
  get queued() {
    return t({ id: 'board.task.phase.queued', defaultMessage: 'Queued' });
  },
  get starting() {
    return t({ id: 'board.task.phase.starting', defaultMessage: 'Starting' });
  },
  get thinking() {
    return t({ id: 'board.task.phase.thinking', defaultMessage: 'Thinking' });
  },
  get tool() {
    return t({ id: 'board.task.phase.tool', defaultMessage: 'Using tools' });
  },
  get waiting_approval() {
    return t({ id: 'board.task.phase.waitingApproval', defaultMessage: 'Awaiting approval' });
  },
  get waiting_input() {
    return t({ id: 'board.task.phase.waitingInput', defaultMessage: 'Awaiting an answer' });
  },
  get gate() {
    return t({ id: 'board.task.phase.gate', defaultMessage: 'Running checks' });
  },
  get merging() {
    return t({ id: 'board.task.phase.merging', defaultMessage: 'Merging' });
  },
  get idle() {
    return t({ id: 'board.task.phase.idle', defaultMessage: 'Idle' });
  },
};

const waits = (a: BoardActivity) => a.phase === 'waiting_approval' || a.phase === 'waiting_input';
const fails = (task: BoardTask, a: BoardActivity) => task.status === 'failed' || !!a.turn_error;
const stuck = (a: BoardActivity) => a.health === 'stalled' || a.health === 'looping';
const ended = (task: BoardTask) => task.status === 'done' || task.status === 'discarded';
/** Not started, and its blockers only say it is queued or waits on upstream tasks. */
const onlyWaits = (task: BoardTask) =>
  task.status === 'todo' && (task.dispatch_wait != null || task.blocked_since != null);
const joinReasons = (reasons: string[]) =>
  reasons.join(t({ id: 'board.task.badge.reasonSeparator', defaultMessage: '; ' }));
const stalledWord = () => t({ id: 'board.task.health.stalled', defaultMessage: 'Stalled' });
const loopingWord = () => t({ id: 'board.task.health.looping', defaultMessage: 'Looping' });

/** What a plan task waits for or, merged, what landed; null when neither applies or is known. */
function stateLine(task: BoardTask, board?: Board): string | null {
  if (task.state === 'merged') {
    const merge = board?.merges
      .filter((m) => task.segments.some((s) => s.session_id === m.session_id))
      .reduce<Board['merges'][number] | null>(
        (newest, m) => (newest && newest.merged_at >= m.merged_at ? newest : m),
        null,
      );
    return merge
      ? `${merge.sha.slice(0, 7)} +${task.additions ?? merge.additions} −${task.deletions ?? merge.deletions}`
      : null;
  }
  if (task.state === 'claimed')
    return t({
      id: 'board.task.activity.claimed',
      defaultMessage: 'Session open, waiting for the first turn',
    });
  if (task.dispatch_wait === 'capacity') {
    const places = board?.task_places;
    return places
      ? t(
          {
            id: 'board.task.activity.waitingSlotOf',
            defaultMessage: 'Waiting for a free slot {used}/{limit}',
          },
          { used: places.used, limit: places.limit },
        )
      : t({ id: 'board.task.activity.waitingSlot', defaultMessage: 'Waiting for a free slot' });
  }
  if (task.dispatch_wait === 'upstream' && board) {
    const byId = new Map(board.tasks.map((up) => [up.id, up]));
    const ups = board.edges.filter((e) => e.to === task.id).flatMap((e) => byId.get(e.from) ?? []);
    const failed = ups.filter((up) => up.state === 'failed');
    if (failed.length)
      return t(
        { id: 'board.task.activity.upstreamFailed', defaultMessage: 'Dependency failed: {tasks}' },
        { tasks: listText(...failed.map((up) => up.title)) },
      );
    const open = ups.filter((up) => up.state !== 'merged').length;
    if (open)
      return t(
        {
          id: 'board.task.activity.waitingUpstream',
          defaultMessage:
            '{count, plural, one {Waiting on # dependency} other {Waiting on # dependencies}}',
        },
        { count: open },
      );
  }
  return null;
}

/** A sentence an agent wrote, with how long ago it wrote it. */
export interface ActivityNote {
  text: string;
  /** Absent when the sentence is the board's own. */
  ago?: string;
}

/** How long ago an agent wrote a line. */
export const agoText = (at: number, now: number) =>
  now - at < 60_000
    ? ageText(at, now)
    : t({ id: 'board.task.activity.ago', defaultMessage: '{age} ago' }, { age: ageText(at, now) });

/**
 * What the task is doing right now, in one sentence: the board's state, else the newer of the
 * agent's status line and its recap, else the phase; null when there is nothing to say. Without
 * the board, upstream waits and merges go unnamed.
 */
export function activityNote(task: BoardTask, now: number, board?: Board): ActivityNote | null {
  const stated = stateLine(task, board);
  if (stated) return { text: stated };
  const a = task.activity;
  const settled =
    !!a &&
    a.phase === 'idle' &&
    (task.status === 'idle' || task.status === 'ready') &&
    !a.turn_error;
  const recap = a && (waits(a) || settled) ? recapLine(task.recap, waits(a)) : null;
  const status = task.status_line;
  if (status && (!recap || status.at >= task.recap!.at))
    return { text: status.text, ago: agoText(status.at, now) };
  if (recap) return { text: recap, ago: agoText(task.recap!.at, now) };
  const line = phaseLine(task, now);
  return line === null ? null : { text: line };
}

/** The sentence of `activityNote` alone. */
export const activityLine = (task: BoardTask, now: number, board?: Board): string | null =>
  activityNote(task, now, board)?.text ?? null;

function phaseLine(task: BoardTask, now: number): string | null {
  const a = task.activity;
  if (!a) return blockerTexts(task)[0] ?? null;
  const lasted = lastedText(now - a.since);
  if (a.phase === 'tool') return listText(a.tool ? toolText(a.tool) : PHASE.tool, lasted);
  if (a.phase === 'waiting_approval')
    return a.waiting
      ? t(
          {
            id: 'board.task.activity.waitingApprovalFor',
            defaultMessage: 'Awaiting approval {summary}',
          },
          { summary: a.waiting.summary },
        )
      : PHASE.waiting_approval;
  if (a.phase === 'waiting_input')
    return a.waiting
      ? t(
          {
            id: 'board.task.activity.waitingInputFor',
            defaultMessage: 'Awaiting an answer {summary}',
          },
          { summary: a.waiting.summary },
        )
      : PHASE.waiting_input;
  if (a.turn_error)
    return t(
      { id: 'board.task.activity.turnFailed', defaultMessage: 'Turn failed: {error}' },
      { error: a.turn_error },
    );
  switch (a.phase) {
    case 'queued':
      if (task.blockers.length === 0) return PHASE.queued;
      // A queued blocker's text stands on its own: it starts with the word or names what it waits for.
      return task.blocker_codes?.[0]?.code === 'queued'
        ? blockerTexts(task)[0]!
        : t(
            { id: 'board.task.activity.queuedFor', defaultMessage: 'Queued: {reason}' },
            { reason: blockerTexts(task)[0] },
          );
    case 'gate':
    case 'merging':
    case 'thinking':
      return listText(PHASE[a.phase], lasted);
    case 'starting':
      return PHASE.starting;
    case 'idle':
      return blockerTexts(task)[0] ?? null;
  }
}

/**
 * When the runtime quota a task waits on frees up: the reset of its runtime's most used window
 * still ahead; null when the task waits on something else or the runtime gives no reset.
 */
export function quotaResetsAt(
  task: BoardTask,
  statuses: readonly RuntimeStatus[],
  now: number,
): number | null {
  if (task.dispatch_wait !== 'runtime_limited') return null;
  const runtime = (task.claim ?? task.planned)?.runtime;
  const windows = (statuses.find((s) => s.runtime === runtime)?.quota?.windows ?? []).filter(
    (w) => w.resets_at !== undefined && w.resets_at > now,
  );
  const top = windows.reduce<(typeof windows)[number] | null>(
    (most, w) =>
      !most ||
      w.used_percent > most.used_percent ||
      (w.used_percent === most.used_percent && w.resets_at! > most.resets_at!)
        ? w
        : most,
    null,
  );
  return top?.resets_at ?? null;
}

/** The drawer's word on a quota wait, beside the wait itself. */
export const resumesText = (at: number, now: number) =>
  t(
    { id: 'board.task.quota.resumes', defaultMessage: 'Resumes in about {duration}' },
    { duration: durationText(at - now) },
  );

/** A flow card's line for a task waiting on runtime quota; null when the reset is not known. */
export function quotaLine(
  task: BoardTask,
  statuses: readonly RuntimeStatus[],
  now: number,
): string | null {
  const at = quotaResetsAt(task, statuses, now);
  return at === null
    ? null
    : t(
        { id: 'board.task.quota.line', defaultMessage: 'Quota back in about {duration}' },
        { duration: durationText(at - now) },
      );
}

/** A tool call by its verb and target; a tool without a verb keeps its name. */
export function toolText(tool: NonNullable<BoardActivity['tool']>): string {
  const verb = callVerb('tool', tool.name);
  const name = verb === 'tool' ? tool.name : VERB[verb].label;
  return tool.target
    ? t(
        { id: 'board.task.activity.toolTarget', defaultMessage: '{tool} {target}' },
        { tool: name, target: tool.target },
      )
    : name;
}

/** What a flow node puts before the user: a command or question waiting, a retry, a lapse or the basis of done. */
export interface NodeReason {
  kind: 'command' | 'question' | 'retried' | 'unattended' | 'basis';
  text: string;
}

export function nodeReason(task: BoardTask, look: NodeLook): NodeReason | null {
  const a = task.activity;
  if (a?.waiting?.summary)
    return {
      kind: a.waiting.kind === 'approval' ? 'command' : 'question',
      text: a.waiting.summary,
    };
  if (look === 'failed' && a && a.attempt >= 2)
    return {
      kind: 'retried',
      text: a.repeated_failure
        ? t(
            {
              id: 'board.node.reason.retriedSamePlace',
              defaultMessage:
                '{count, plural, one {Retried # time, failing at the same place} other {Retried # times, failing at the same place}}',
            },
            { count: a.attempt - 1 },
          )
        : t(
            {
              id: 'board.node.reason.retried',
              defaultMessage: '{count, plural, one {Retried # time} other {Retried # times}}',
            },
            { count: a.attempt - 1 },
          ),
    };
  if (task.state === 'blocked' && !task.turn_running)
    return {
      kind: 'unattended',
      text: t({
        id: 'board.node.reason.unattended',
        defaultMessage: 'No session is working on it',
      }),
    };
  if (task.state === 'merged' && task.done_by)
    return {
      kind: 'basis',
      text:
        task.done_by === 'accepted'
          ? t({ id: 'board.node.reason.accepted', defaultMessage: 'Basis: the lead accepted it' })
          : task.checks === 'pass'
            ? t({
                id: 'board.node.reason.mergedChecked',
                defaultMessage: 'Basis: checks passed, merged',
              })
            : t({ id: 'board.node.reason.merged', defaultMessage: 'Basis: merged' }),
    };
  return null;
}

export const taskTokens = (task: BoardTask): number =>
  task.segments.reduce((sum, s) => sum + s.tokens, 0);

/** How long a state has lasted; null under a minute, which would read as 0 minutes. */
const lastedText = (ms: number) => (ms < 60_000 ? null : durationText(ms));

// Follows the order of displayStatus, so the word matches the icon beside it.
function phaseWord(task: BoardTask, a: BoardActivity): string {
  if (ended(task)) return STATUS[task.status].label;
  if (waits(a)) return PHASE[a.phase];
  if (fails(task, a)) return STATUS.failed.label;
  if (a.health === 'stalled') return stalledWord();
  if (a.health === 'looping') return loopingWord();
  return a.phase === 'idle' ? STATUS[displayStatus(task)].label : PHASE[a.phase];
}

/** The status word of the card's first line and how long that state has lasted. */
export function phaseText(task: BoardTask, now: number): string {
  const a = task.activity;
  if (!a) return STATUS[task.status].label;
  // A failure or health word did not start with the phase, so the phase's age is not its age.
  const later = !ended(task) && !waits(a) && (fails(task, a) || stuck(a));
  return later ? phaseWord(task, a) : listText(phaseWord(task, a), lastedText(now - a.since));
}

export function taskBadges(task: BoardTask): TaskBadge[] {
  const a = task.activity;
  const badges: TaskBadge[] = [];
  if (a?.waiting)
    badges.push({
      kind: 'waiting',
      label: a.waiting.kind === 'approval' ? PHASE.waiting_approval : PHASE.waiting_input,
      waits: a.waiting.kind === 'approval' ? 'approval' : 'question',
    });
  if (task.blockers.length > 0)
    badges.push(
      onlyWaits(task)
        ? { kind: 'upstream', label: joinReasons(blockerTexts(task)) }
        : {
            kind: 'blocked',
            label: t(
              { id: 'board.task.badge.blocked', defaultMessage: 'Blocked: {reasons}' },
              { reasons: joinReasons(blockerTexts(task)) },
            ),
          },
    );
  if (a?.health === 'stalled') badges.push({ kind: 'stalled', label: stalledWord() });
  if (a?.health === 'looping') badges.push({ kind: 'looping', label: loopingWord() });
  if (a && a.attempt >= 2)
    badges.push({
      kind: 'attempt',
      label: t(
        { id: 'board.task.badge.attempt', defaultMessage: 'Attempt {attempt}' },
        { attempt: a.attempt },
      ),
      count: a.attempt,
    });
  // The board lists each reason once, however often it was handed back.
  if (a?.handed_back?.length)
    badges.push({
      kind: 'handed_back',
      label: t(
        { id: 'board.task.badge.handedBack', defaultMessage: 'Handed back: {reasons}' },
        { reasons: joinReasons(a.handed_back.map(reasonText)) },
      ),
    });
  return badges;
}

/** Whether the badge only repeats what the glyph of `shown` beside it already draws. */
export const repeatsState = (badge: TaskBadge, shown: BoardTaskState | BoardTaskStatus) =>
  badge.kind === 'waiting'
    ? badge.waits === 'approval' && shown === 'waiting_approval'
    : badge.kind === 'blocked' && shown === 'blocked';

/**
 * The status whose icon leads the card: done or discarded, then waiting on the user, then failed,
 * then a stalled or looping turn, then work under way; idle and queued tasks show as not started.
 */
export function displayStatus(task: BoardTask): BoardTaskStatus {
  const a = task.activity;
  if (!a || ended(task)) return task.status;
  if (waits(a)) return 'waiting';
  if (fails(task, a) || stuck(a)) return 'failed';
  if (a.phase === 'queued') return 'todo';
  if (a.phase === 'idle') return task.status === 'running' ? 'todo' : task.status;
  return 'running';
}
