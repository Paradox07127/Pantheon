import type {
  ApprovalQuestion,
  BoardHistory,
  EffortLevel,
  RuntimeModel,
  WorkbenchSession,
} from '@pantheon/protocol';
import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { normalizeMathDelimiters } from '../../components/markdownMath';
import { rehypePlugins, remarkPlugins } from '../../components/markdownPlugins';
import { KNOWN_RUNTIMES, runtimeTraits } from '../../components/RuntimeGlyph';
import { reasonText } from '../../data/needs-you';
import { listText } from '../../lib/list-text';
import { durationText } from '../../lib/time-text';
import type { DaemonEvent } from '../../data/sync';
import { subagentCall, toolLabel } from '../../data/tool-calls';
import {
  isQuietEvent,
  type SessionTurn,
  type Transcript,
  type TranscriptItem,
  type TurnView,
} from '../../data/transcript';
import { t } from '../../i18n';

/** The failed turn's error: the text of its code, else the runtime's own words. */
export const turnErrorText = (s: WorkbenchSession): string | undefined =>
  s.last_turn?.error_code ? reasonText(s.last_turn.error_code) : s.last_turn?.error;

const LOGIN_FIXES = new Set(['billing_channel_mismatch', 'account_check_timeout']);

/** The runtime whose own login fixes the last failed turn; null when logging in would not. */
export function turnLogin(s: WorkbenchSession): 'claude' | 'codex' | null {
  const code = s.last_turn?.state === 'failed' ? s.last_turn.error_code : undefined;
  if (code === undefined || !LOGIN_FIXES.has(code)) return null;
  return s.runtime === 'claude' || s.runtime === 'codex' ? s.runtime : null;
}

export const PERMISSION_MODES: readonly {
  value: WorkbenchSession['permission_mode'];
  label: string;
}[] = [
  {
    value: 'ask',
    get label() {
      return t({ id: 'sessions.model.mode.ask', defaultMessage: 'Manual' });
    },
  },
  {
    value: 'auto_edit',
    get label() {
      return t({ id: 'sessions.model.mode.autoEdit', defaultMessage: 'Auto edit' });
    },
  },
  {
    value: 'plan',
    get label() {
      return t({ id: 'sessions.model.mode.plan', defaultMessage: 'Plan' });
    },
  },
  {
    value: 'auto',
    get label() {
      return t({ id: 'sessions.model.mode.auto', defaultMessage: 'Auto' });
    },
  },
  {
    value: 'full_access',
    get label() {
      return t({ id: 'sessions.model.mode.fullAccess', defaultMessage: 'Full access' });
    },
  },
];

/** The name of a permission mode on the runtime. */
export const permissionModeLabel = (
  runtime: string,
  mode: WorkbenchSession['permission_mode'],
): string =>
  runtimeTraits(runtime).modeNames[mode] ??
  PERMISSION_MODES.find((m) => m.value === mode)?.label ??
  mode;

/** The modes the runtime can switch between, in this order. */
export const permissionModes = (runtime: string): typeof PERMISSION_MODES =>
  PERMISSION_MODES.filter((m) => runtimeTraits(runtime).modes.includes(m.value));

/** The modes the model menu offers: the model's own, else the runtime's when the model lists none. */
export const modelPermissionModes = (
  runtime: string,
  model: RuntimeModel | null,
): WorkbenchSession['permission_mode'][] =>
  model?.permission_modes.length
    ? model.permission_modes
    : permissionModes(runtime).map((m) => m.value);

/**
 * The mode a new session on the runtime starts in: the preferred one when offered, else the first;
 * ask, the protocol's default, on a runtime without modes.
 */
export function defaultPermissionMode(
  runtime: string,
  preferred?: WorkbenchSession['permission_mode'],
): WorkbenchSession['permission_mode'] {
  const modes = permissionModes(runtime);
  return modes.find((m) => m.value === preferred)?.value ?? modes[0]?.value ?? 'ask';
}

/**
 * The runtime a new session starts on: the preferred one when offered or none are known yet, else the table's first, else the first offered one.
 * Unavailable runtimes count as not offered unless every offered one is unavailable.
 */
export function defaultRuntime(
  runtimes: readonly string[],
  preferred = KNOWN_RUNTIMES[0]!,
  unavailable: Readonly<Record<string, string>> = {},
): string {
  const usable = runtimes.filter((r) => !unavailable[r]);
  const from = usable.length > 0 ? usable : runtimes;
  if (from.length === 0 || from.includes(preferred)) return preferred;
  return from.includes(KNOWN_RUNTIMES[0]!) ? KNOWN_RUNTIMES[0]! : from[0]!;
}

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  get none() {
    return t({ id: 'sessions.model.effort.none', defaultMessage: 'Off' });
  },
  get minimal() {
    return t({ id: 'sessions.model.effort.minimal', defaultMessage: 'Minimal' });
  },
  get low() {
    return t({ id: 'sessions.model.effort.low', defaultMessage: 'Low' });
  },
  get medium() {
    return t({ id: 'sessions.model.effort.medium', defaultMessage: 'Medium' });
  },
  get high() {
    return t({ id: 'sessions.model.effort.high', defaultMessage: 'High' });
  },
  get xhigh() {
    return t({ id: 'sessions.model.effort.xhigh', defaultMessage: 'Extra high' });
  },
  get max() {
    return t({ id: 'sessions.model.effort.max', defaultMessage: 'Max' });
  },
  get ultra() {
    return t({ id: 'sessions.model.effort.ultra', defaultMessage: 'Ultra' });
  },
};

/** The model marked default, else the first one; null for an empty list. */
export const defaultModel = (models: readonly RuntimeModel[]): RuntimeModel | null =>
  models.find((m) => m.default) ?? models[0] ?? null;

/** The preferred model by id or resolved id, else the default model. */
export const defaultModelFor = (
  models: readonly RuntimeModel[],
  preferred: string | undefined,
): RuntimeModel | null =>
  (preferred !== undefined && models.find((m) => m.id === preferred || m.resolved === preferred)) ||
  defaultModel(models);

/** A model's name; the runtime's own default entry, whose id is `default`, in the interface language. */
export const modelLabel = (model: RuntimeModel): string =>
  model.id === 'default'
    ? t({ id: 'sessions.composer.defaultModel', defaultMessage: 'Default' })
    : model.label;

/** `runtime, model, effort, backend` of the model menu; a null model is the runtime's default. */
export function modelText(
  runtime: string,
  models: readonly RuntimeModel[],
  model: string | null,
  effort: EffortLevel | null,
  backend: string | null = null,
): string {
  if (model === null) return listText(runtime, backend);
  const found = models.find((m) => m.id === model || m.resolved === model);
  const name = found ? modelLabel(found) : model;
  return listText(runtime, name, effort && EFFORT_LABEL[effort], backend);
}

/** The first message of a session opened from a board task. */
export const taskPrompt = (task: { title: string; goal: string }): string =>
  `${task.title}\n\n${task.goal}`;

/** The session.create input; task_id binds the new session to its board task. */
export function newSessionInput(input: {
  projectId: string;
  runtime: string;
  permissionMode: WorkbenchSession['permission_mode'];
  input: string;
  taskId?: string;
  backend?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  attachments?: readonly string[];
}) {
  return {
    project_id: input.projectId,
    runtime: input.runtime,
    permission_mode: input.permissionMode,
    input: input.input,
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.backend ? { backend: input.backend } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  };
}

export interface PendingPermission {
  id: string;
  tool: string;
  /** The approval's revision as of its newest event. */
  revision: number;
  /** The agent's request id, which names the request item of the transcript. */
  request?: string;
  /** An AskUserQuestion request's questions, from the approval event payload. */
  questions?: ApprovalQuestion[];
  /** The rule an allow for the session adds. */
  rule?: string;
}

const field = (payload: unknown, key: string): unknown =>
  payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;

/** Whether an approval event belongs to the session. */
export const isSessionApproval = (event: DaemonEvent, sessionId: string): boolean =>
  event.kind.startsWith('approval.') && field(event.payload, 'session_id') === sessionId;

/** The session's permission requests whose newest approval event still leaves them pending. */
export function pendingPermissions(
  events: readonly DaemonEvent[],
  sessionId: string,
): PendingPermission[] {
  const newest = new Map<string, DaemonEvent>();
  for (const event of events)
    if (isSessionApproval(event, sessionId)) {
      const seen = newest.get(event.aggregate_id);
      if (!seen || seen.sequence < event.sequence) newest.set(event.aggregate_id, event);
    }
  return [...newest.values()]
    .filter(
      (e) => field(e.payload, 'kind') === 'permission' && field(e.payload, 'state') === 'pending',
    )
    .sort((a, b) => a.sequence - b.sequence)
    .map((e) => {
      const tool = field(e.payload, 'tool'),
        request = field(e.payload, 'request_id'),
        questions = field(e.payload, 'questions'),
        rule = field(e.payload, 'rule');
      return {
        id: e.aggregate_id,
        tool: typeof tool === 'string' ? tool : '',
        revision: e.aggregate_revision,
        ...(typeof request === 'string' ? { request } : {}),
        ...(Array.isArray(questions) ? { questions: questions as ApprovalQuestion[] } : {}),
        ...(typeof rule === 'string' ? { rule } : {}),
      };
    });
}

/** The waiting requests whose request item is not in the transcript; the others show in place. */
export function unplacedPermissions(
  pending: readonly PendingPermission[],
  transcript: Transcript,
): PendingPermission[] {
  const placed = new Set(
    [...transcript.turns, transcript.loose].flatMap((owner) =>
      owner.items.flatMap((item) => (item.kind === 'request' ? [item.id] : [])),
    ),
  );
  return pending.filter((p) => p.request === undefined || !placed.has(p.request));
}

export type TurnStatusKind =
  | 'loading'
  | 'queued'
  | 'thinking'
  | 'writing'
  | 'tool'
  | 'agents'
  | 'approval'
  | 'question'
  | 'retrying'
  | 'compacting'
  | 'ended';

export type RetryReason = 'rate_limit' | 'overloaded' | 'network';

export interface TurnStatus {
  kind: TurnStatusKind;
  /** The running tool's title. */
  tool: string | null;
  /** created_at the clock counts from; null shows no clock. */
  since: number | null;
  /** The subagents of the turn that finished, and all it dispatched, while it waits for them. */
  agents?: { done: number; total: number };
  /** The turn's own tool calls that finished, while it thinks, writes or runs a tool. */
  steps?: number;
  /** The newest sentence of the reply being written. */
  line?: string;
  /** The tool and target of the approval the turn waits for. */
  ask?: { tool: string; detail: string };
  /** The API call the runtime tries again; at is when, in epoch ms, when it said. */
  retry?: { attempt: number; reason: RetryReason; at: number | null };
  /** What started the compaction under way. */
  compacting?: 'auto' | 'manual';
}

/** The last sentence of the text's last line, which may still be growing. */
export function newestSentence(text: string): string {
  const line =
    text
      .split('\n')
      .findLast((l) => l.trim() !== '')
      ?.trim() ?? '';
  const sentences = line.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [];
  return (sentences.at(-1) ?? '').trim();
}

/**
 * What the status line under a turn says; `view` is null while the history loads, `waiting` names
 * what a request of the session waits for.
 */
export function turnStatus(
  view: TurnView | null,
  waiting: 'approval' | 'question' | null,
): TurnStatus {
  const status = (
    kind: TurnStatusKind,
    since: number | null = null,
    tool: string | null = null,
  ): TurnStatus => ({
    kind,
    tool,
    since,
  });
  if (!view) return status('loading');
  const { state } = view.turn;
  if (view.end || (state !== 'running' && state !== 'queued')) return status('ended');
  if (waiting === 'approval') {
    const asked = view.items.findLast(
      (item) => item.kind === 'request' && !item.outcome && item.questions.length === 0,
    );
    const detail = asked?.kind === 'request' ? toolLabel(asked.tool, asked.input).detail : '';
    return asked?.kind === 'request' && detail
      ? { ...status(waiting), ask: { tool: asked.tool, detail } }
      : status(waiting);
  }
  if (waiting) return status(waiting);
  if (state === 'queued') return status('queued');
  // A retry or compaction holds until the turn's next output or event.
  const latest = view.items.findLast((item) => item.kind !== 'event' || !isQuietEvent(item.event));
  if (latest?.kind === 'event' && latest.event.kind === 'agent.turn.retrying') {
    const p = latest.event.payload as { attempt: number; retry_at?: number; reason: RetryReason };
    return {
      ...status('retrying'),
      retry: { attempt: p.attempt, reason: p.reason, at: p.retry_at ?? null },
    };
  }
  if (latest?.kind === 'event' && latest.event.kind === 'agent.context.compacting') {
    const p = latest.event.payload as { trigger: 'auto' | 'manual' };
    return { ...status('compacting'), compacting: p.trigger };
  }
  const steps = view.items.filter(
    (item) => item.kind === 'tool' && !item.parent && item.ok !== undefined,
  ).length;
  const running = view.items.findLast((item) => item.kind === 'tool' && item.ok === undefined);
  if (running?.kind === 'tool') {
    if (subagentCall(running.name, running.input) && !running.parent) {
      const agents = view.items.filter(
        (item) => item.kind === 'tool' && !item.parent && subagentCall(item.name, item.input),
      );
      return {
        ...status('agents', running.started_at ?? null),
        agents: {
          done: agents.filter((item) => item.kind === 'tool' && item.ok !== undefined).length,
          total: agents.length,
        },
      };
    }
    return {
      ...status('tool', running.started_at ?? null, toolLabel(running.name, running.input).title),
      steps,
    };
  }
  const last = view.items.at(-1);
  return last?.kind === 'text'
    ? { ...status('writing', view.started_at ?? view.at), steps, line: newestSentence(last.text) }
    : { ...status('thinking', view.started_at ?? view.at), steps };
}

const SPOKEN: Record<TurnStatusKind, string> = {
  loading: '',
  get queued() {
    return t({ id: 'sessions.model.status.queued', defaultMessage: 'Queued' });
  },
  get thinking() {
    return t({ id: 'sessions.model.status.working', defaultMessage: 'Working' });
  },
  get writing() {
    return t({ id: 'sessions.model.status.working', defaultMessage: 'Working' });
  },
  get tool() {
    return t({ id: 'sessions.model.status.working', defaultMessage: 'Working' });
  },
  get agents() {
    return t({ id: 'sessions.model.status.working', defaultMessage: 'Working' });
  },
  get approval() {
    return t({ id: 'sessions.model.status.waiting', defaultMessage: 'Waiting for you' });
  },
  get question() {
    return t({ id: 'sessions.model.status.waiting', defaultMessage: 'Waiting for you' });
  },
  get retrying() {
    return t({ id: 'sessions.model.status.working', defaultMessage: 'Working' });
  },
  get compacting() {
    return t({ id: 'sessions.model.status.working', defaultMessage: 'Working' });
  },
  ended: '',
};

/** The status kind for screen readers; it changes only when the kind does. */
export const turnStatusSpoken = (status: TurnStatus): string => SPOKEN[status.kind];

/** Whether the status line counts the seconds. */
export const statusTicks = (kind: TurnStatusKind): boolean =>
  kind === 'thinking' || kind === 'writing' || kind === 'tool' || kind === 'agents';

/** The status line at `now`; empty when there is none. */
export function turnStatusText(status: TurnStatus, now: number): string {
  const label = turnStatusLabel(status);
  if (!label || status.since === null || !statusTicks(status.kind)) return label;
  return t(
    { id: 'sessions.model.status.withClock', defaultMessage: '{status}, {clock}' },
    { status: label, clock: durationText(now - status.since) },
  );
}

/** The status line without its clock. */
export function turnStatusLabel(status: TurnStatus): string {
  return status.kind === 'tool'
    ? t(
        { id: 'sessions.model.status.tool', defaultMessage: 'Running {tool}' },
        { tool: status.tool },
      )
    : status.kind === 'thinking'
      ? t({ id: 'sessions.thread.status.thinking', defaultMessage: 'Thinking' })
      : status.kind === 'writing'
        ? t({ id: 'sessions.thread.status.writing', defaultMessage: 'Writing' })
        : status.kind === 'agents'
          ? t(
              {
                id: 'sessions.thread.status.agents',
                defaultMessage: 'Waiting for agents, {done} / {total}',
              },
              { done: status.agents?.done ?? 0, total: status.agents?.total ?? 0 },
            )
          : status.kind === 'approval'
            ? t({
                id: 'sessions.thread.status.approval',
                defaultMessage: 'Waiting for your approval',
              })
            : status.kind === 'question'
              ? t({
                  id: 'sessions.thread.status.question',
                  defaultMessage: 'Waiting for your answer',
                })
              : status.kind === 'retrying'
                ? t(
                    {
                      id: 'sessions.model.status.retrying',
                      defaultMessage:
                        'Retry {attempt}, {reason, select, rate_limit {rate limited} overloaded {overloaded} other {network}}',
                    },
                    { attempt: status.retry?.attempt ?? 1, reason: status.retry?.reason ?? '' },
                  )
                : status.kind === 'compacting'
                  ? t(
                      {
                        id: 'sessions.model.status.compacting',
                        defaultMessage:
                          '{trigger, select, auto {Compacting context automatically} other {Compacting context}}',
                      },
                      { trigger: status.compacting ?? '' },
                    )
                  : SPOKEN[status.kind];
}

/** The turn's input as the thread shows it: without the tag Pantheon or the lead writes before it. */
export const shownInput = (turn: Pick<SessionTurn, 'input' | 'origin'>): string =>
  turn.origin === 'lead'
    ? turn.input.replace(/^\[Lead\]\s*/, '')
    : turn.origin
      ? turn.input.replace(/^\[Pantheon\]\s*/, '')
      : turn.input;

/**
 * One match of a search in the thread: its turn, the text block holding it ('input', or the index of
 * a text item among the turn's items) and its place among that block's matches.
 */
export interface FindMatch {
  turn: string;
  block: string;
  nth: number;
}

// A fenced block the thread draws as a chart in place of its source.
const CHART_CODE = /\blanguage-(mermaid|vega-lite|kline)\b/;

function elementText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(elementText).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement<{ children?: ReactNode; className?: string }>(node)) return '';
  if (node.type === 'code' && CHART_CODE.test(node.props.className ?? '')) return '';
  return elementText(node.props.children);
}

/** Drawn texts by Markdown source, least recently read first. */
const drawn = new Map<string, string>();
const DRAWN_MAX = 300;

/**
 * The text a reply's Markdown draws: parsed as `components/Markdown.tsx` parses it, less the
 * highlighting, which only splits the text.
 */
function drawnText(markdown: string): string {
  let text = drawn.get(markdown);
  if (text === undefined) {
    text = elementText(
      ReactMarkdown({
        remarkPlugins,
        rehypePlugins,
        disallowedElements: ['img'],
        children: normalizeMathDelimiters(markdown),
      }),
    );
    if (drawn.size >= DRAWN_MAX) drawn.delete(drawn.keys().next().value!);
  } else drawn.delete(markdown);
  drawn.set(markdown, text);
  return text;
}

/**
 * Every match of `query`, case aside, in the user's messages and the agent's replies, in order; a
 * reply is searched in the text it draws, as the thread marks it.
 */
export function findMatches(turns: readonly TurnView[], query: string): FindMatch[] {
  const needle = query.toLowerCase();
  if (!needle.trim()) return [];
  return turns.flatMap((view) =>
    [
      ...(view.turn.origin === 'compaction'
        ? []
        : [{ block: 'input', text: shownInput(view.turn) }]),
      ...view.items.flatMap((item, i) =>
        item.kind === 'text' ? [{ block: String(i), text: drawnText(item.text) }] : [],
      ),
    ].flatMap(({ block, text }) => {
      const hay = text.toLowerCase();
      const found: FindMatch[] = [];
      for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length))
        found.push({ turn: view.turn.id, block, nth: found.length });
      return found;
    }),
  );
}

export interface TimelineNode {
  id: string;
  kind: 'goal' | 'task' | 'milestone' | 'wait' | 'turn';
  /** Epoch milliseconds. */
  at: number;
  /** The one line the rail shows. */
  label: string;
  /** What the node is, with its kind: the tooltip and the accessible name. */
  name: string;
  /** The turn a click scrolls to; null scrolls to the request cards below the thread. */
  turn: string | null;
}

/**
 * The thread's milestones in time order: goal, completed tasks and reached milestones, key points
 * and waiting requests. A goal, task or milestone points to the turn running by then.
 */
export function timelineNodes(input: {
  sessionId: string;
  history: Pick<BoardHistory, 'tasks' | 'milestones'> | null;
  turns: readonly { id: string; at: number | null; summary?: string }[];
  waits: readonly { id: string; at: number; turn: string | null; question: boolean }[];
  goal?: { text: string; at: string } | null;
  /** The session's title, shown for the goal when it says something else than the goal. */
  title?: string;
}): TimelineNode[] {
  const turnAt = (at: number) =>
    input.turns.findLast((turn) => turn.at !== null && turn.at <= at)?.id ??
    input.turns[0]?.id ??
    null;
  const tasks = (input.history?.tasks ?? []).filter(
    (task) =>
      task.state !== 'removed' &&
      (task.owner_session_id === input.sessionId || task.session_id === input.sessionId),
  );
  const milestones = new Set(tasks.flatMap((task) => task.milestone_id ?? []));
  const goal = input.goal ? { text: input.goal.text.trim(), at: Date.parse(input.goal.at) } : null;
  const title = input.title?.trim() ?? '';
  const nodes: TimelineNode[] = [
    ...(goal
      ? [
          {
            id: 'goal',
            kind: 'goal' as const,
            at: goal.at,
            label: title && title !== goal.text ? title : firstSentence(goal.text),
            name: t(
              { id: 'sessions.thread.timeline.goal', defaultMessage: 'Goal: {text}' },
              {
                text:
                  goal.text.length > GOAL_SHOWN
                    ? `${goal.text.slice(0, GOAL_SHOWN).trimEnd()}…`
                    : goal.text,
              },
            ),
            turn: turnAt(goal.at),
          },
        ]
      : []),
    ...tasks.flatMap((task) =>
      task.merged_at === null
        ? []
        : [
            {
              id: `task:${task.id}`,
              kind: 'task' as const,
              at: task.merged_at,
              label: task.title,
              name: t(
                { id: 'sessions.thread.timeline.task', defaultMessage: 'Task done: {title}' },
                { title: task.title },
              ),
              turn: turnAt(task.merged_at),
            },
          ],
    ),
    ...(input.history?.milestones ?? []).flatMap((milestone) =>
      milestone.reached_at === null || !milestones.has(milestone.id)
        ? []
        : [
            {
              id: `milestone:${milestone.id}`,
              kind: 'milestone' as const,
              at: milestone.reached_at,
              label: milestone.title,
              name: t(
                { id: 'sessions.thread.timeline.milestone', defaultMessage: 'Milestone: {title}' },
                { title: milestone.title },
              ),
              turn: turnAt(milestone.reached_at),
            },
          ],
    ),
    ...input.turns.flatMap((turn, i) =>
      turn.summary === undefined || turn.at === null
        ? []
        : [
            {
              id: `turn:${turn.id}`,
              kind: 'turn' as const,
              at: turn.at,
              label: turn.summary,
              name: t(
                { id: 'sessions.thread.timeline.turn', defaultMessage: 'Turn {number}: {summary}' },
                { number: i + 1, summary: turn.summary },
              ),
              turn: turn.id,
            },
          ],
    ),
    ...input.waits.map((wait) => {
      const label = wait.question
        ? t({ id: 'sessions.thread.status.question', defaultMessage: 'Waiting for your answer' })
        : t({ id: 'sessions.thread.status.approval', defaultMessage: 'Waiting for your approval' });
      return {
        id: `wait:${wait.id}`,
        kind: 'wait' as const,
        at: wait.at,
        label,
        name: label,
        turn: wait.turn,
      };
    }),
  ];
  return nodes.sort((a, b) => a.at - b.at);
}

/** Characters of the goal its tooltip shows. */
const GOAL_SHOWN = 200;

/** The text up to its first full stop, question or exclamation mark, or line break. */
const firstSentence = (text: string) =>
  text
    .split(/[。！？\n]|[.!?](?=\s|$)/)
    .find((part) => part.trim())
    ?.trim() ?? text;

/**
 * A transcript item's id. Text grows in place and never follows other text, so a text block is
 * named by the item before it.
 */
export function itemId(owner: string, items: readonly TranscriptItem[], index: number): string {
  const item = items[index]!;
  if (item.kind === 'tool') return `tool:${item.id}`;
  if (item.kind === 'request') return `request:${item.id}`;
  if (item.kind === 'visual') return `visual:${item.visual_id}`;
  if (item.kind === 'event') return `event:${item.event.event_id}`;
  return `${item.kind}:${index === 0 ? owner : itemId(owner, items, index - 1)}`;
}

/** The ids of everything the thread shows: turns, their items, loose items and waiting cards. */
export function threadIds(transcript: Transcript, pending: readonly PendingPermission[]): string[] {
  const own = (owner: string, items: readonly TranscriptItem[]) =>
    items.map((_, i) => itemId(owner, items, i));
  return [
    ...transcript.turns.flatMap((t) => [`turn:${t.turn.id}`, ...own(t.turn.id, t.items)]),
    ...own('loose', transcript.loose.items),
    ...pending.map((p) => `approval:${p.id}`),
  ];
}

export interface Arrivals {
  /** The ids at the first history load; null until it completes. */
  baseline: ReadonlySet<string> | null;
  /** Ids seen since, in order of arrival. */
  fresh: ReadonlySet<string>;
}

export const NO_ARRIVALS: Arrivals = { baseline: null, fresh: new Set() };

/** The arrivals after the thread shows `ids`; null while the history loads. Unchanged is the same object. */
export function arrivals(before: Arrivals, ids: readonly string[] | null): Arrivals {
  if (!ids) return before;
  if (!before.baseline) return { baseline: new Set(ids), fresh: before.fresh };
  const { baseline, fresh } = before;
  const added = ids.filter((id) => !baseline.has(id) && !fresh.has(id));
  return added.length ? { baseline, fresh: new Set([...fresh, ...added]) } : before;
}

/** A running session takes a message into its current turn; any other state starts a turn. */
export const messageCommand = (state: string | undefined): 'session.steer' | 'session.send' =>
  state === 'running' ? 'session.steer' : 'session.send';
