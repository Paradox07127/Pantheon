import { sessionTools } from '@pantheon/protocol';
import { t } from '../i18n';
import { listText } from '../lib/list-text';
/** A tool call as one short line: a readable tool name and its key argument. */
export interface ToolLabel {
  title: string;
  detail: string;
  /** The detail is a title in words, not code, a path or an id. */
  prose?: true;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

function flat(value: string, max = 300): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// Labels are getters, so each is read in the language loaded by then.
const TITLES: Record<string, string> = {
  get commandExecution() {
    return t({ id: 'data.toolCalls.title.commandExecution', defaultMessage: 'Command' });
  },
  get local_shell_call() {
    return t({ id: 'data.toolCalls.title.localShellCall', defaultMessage: 'Command' });
  },
  get fileChange() {
    return t({ id: 'data.toolCalls.title.fileChange', defaultMessage: 'Edit files' });
  },
  get webSearch() {
    return t({ id: 'data.toolCalls.title.webSearch', defaultMessage: 'Web search' });
  },
  get imageView() {
    return t({ id: 'data.toolCalls.title.imageView', defaultMessage: 'View image' });
  },
  get imageGeneration() {
    return t({ id: 'data.toolCalls.title.imageGeneration', defaultMessage: 'Generate image' });
  },
  get sleep() {
    return t({ id: 'data.toolCalls.title.sleep', defaultMessage: 'Wait' });
  },
  get collabAgentToolCall() {
    return t({
      id: 'data.toolCalls.title.collabAgentToolCall',
      defaultMessage: 'Collaborating agent',
    });
  },
  get dynamicToolCall() {
    return t({ id: 'data.toolCalls.title.dynamicToolCall', defaultMessage: 'Dynamic tool' });
  },
};

/** The path relative to the longest base that contains it; else the path itself. */
function relative(path: string, bases: readonly string[]): string {
  let best: string | null = null;
  for (const base of bases) {
    const root = base.replace(/\/+$/, '');
    if ((path === root || path.startsWith(`${root}/`)) && root.length > (best?.length ?? -1))
      best = root;
  }
  if (best === null) return path;
  return path === best ? '.' : path.slice(best.length + 1);
}

// Shell argv as `bash -lc <script>` shows only the script.
function command(value: unknown): string {
  if (typeof value === 'string') return flat(value);
  if (!Array.isArray(value) || !value.every((part) => typeof part === 'string')) return '';
  const argv = value as string[];
  if (argv.length === 3 && /^-l?c$/.test(argv[1]!)) return flat(argv[2]!);
  return flat(argv.join(' '));
}

function scalars(args: Record<string, unknown> | null, count = 2): string {
  const shown: string[] = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    if (shown.length >= count) break;
    if (key === 'truncated') continue;
    if (typeof value === 'number' || typeof value === 'boolean') shown.push(`${key}=${value}`);
    else if (typeof value === 'string' && value.length <= 60) shown.push(`${key}=${flat(value)}`);
  }
  return listText(...shown);
}

function firstString(input: Record<string, unknown>): string {
  for (const value of Object.values(input)) {
    const s = text(value);
    if (s && s.length <= 200) return flat(s);
  }
  return '';
}

const changePaths = (changes: unknown): string[] =>
  Array.isArray(changes)
    ? changes.map((c) => text(record(c)?.path)).filter((p): p is string => p !== null)
    : Object.keys(record(changes) ?? {}).filter((key) => key !== 'truncated');

const PANTHEON_TOOLS: ReadonlySet<string> = new Set(
  Object.values(sessionTools).flatMap((tools) => Object.keys(tools)),
);

/**
 * The Pantheon tool a call names, from Claude's `mcp__pantheon__<tool>`, Codex's
 * `pantheon.<tool>` or the fixture adapter's bare `<tool>`; null for any other tool.
 */
export function pantheonTool(name: string): string | null {
  const tool = name.startsWith('mcp__pantheon__')
    ? name.slice('mcp__pantheon__'.length)
    : name.startsWith('pantheon.')
      ? name.slice('pantheon.'.length)
      : name;
  return PANTHEON_TOOLS.has(tool) ? tool : null;
}

/** A lead's or task session's call that steers the plan: its action, detail and task ids. */
export interface OrchestrationLabel extends ToolLabel {
  tasks: string[];
}

const firstLine = (value: unknown): string =>
  flat(
    text(value)
      ?.split('\n')
      .find((line) => line.trim() !== '') ?? '',
  );

// Codex wraps an MCP call's arguments as {server, tool, arguments}.
function callArgs(input: unknown): Record<string, unknown> {
  const outer = record(input) ?? {};
  return record(outer.arguments) ?? outer;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => text(v) !== null) : [];

/** The receipt of a Pantheon command in a call's output text, `{"receipt": …}`; else null. */
export function receiptOf(output: unknown): Record<string, unknown> | null {
  try {
    return record(record(JSON.parse(outputText(output)))?.receipt);
  } catch {
    return null;
  }
}

/** The orchestration row of a Pantheon call; null for reads and any other tool. */
export function orchestrationLabel(
  name: string,
  input: unknown,
  output?: unknown,
): OrchestrationLabel | null {
  const i = callArgs(input);
  const task = [text(i.task_id)].filter((t): t is string => t !== null);
  switch (pantheonTool(name)) {
    case 'start_task':
      return {
        title: t({ id: 'data.toolCalls.action.dispatch', defaultMessage: 'Dispatch' }),
        detail: '',
        tasks: Array.isArray(i.task_ids)
          ? i.task_ids.filter((t): t is string => text(t) !== null)
          : [],
      };
    case 'message_task':
      return {
        title: t({ id: 'data.toolCalls.action.message', defaultMessage: 'Message' }),
        detail: firstLine(i.text),
        tasks: task,
      };
    case 'accept_task':
      return {
        title: t({ id: 'data.toolCalls.action.accept', defaultMessage: 'Accept' }),
        detail: '',
        tasks: task,
      };
    case 'stop_task':
      return {
        title: t({ id: 'data.toolCalls.action.stop', defaultMessage: 'Stop' }),
        detail: flat(text(i.reason) ?? ''),
        tasks: task,
      };
    case 'update_board':
      return {
        title: t({ id: 'data.toolCalls.action.updatePlan', defaultMessage: 'Update plan' }),
        detail: Array.isArray(i.tasks)
          ? t(
              {
                id: 'data.toolCalls.action.taskCount',
                defaultMessage: '{count, plural, one {# task} other {# tasks}}',
              },
              { count: i.tasks.length },
            )
          : '',
        tasks: [],
      };
    case 'milestone_accept':
      return {
        title: t({
          id: 'data.toolCalls.action.acceptMilestone',
          defaultMessage: 'Accept milestone',
        }),
        detail: text(i.milestone_id) ?? '',
        tasks: [],
      };
    case 'report':
      return {
        title: t({ id: 'data.toolCalls.action.report', defaultMessage: 'Report' }),
        detail: firstLine(i.text),
        tasks: [],
      };
    case 'edit_board': {
      const ops = Array.isArray(i.ops) ? i.ops.map((op) => record(op) ?? {}) : [];
      const ids = ops.map((op) => text(op.task_id) ?? text(record(op.task)?.id));
      return {
        title: t({ id: 'data.toolCalls.action.editPlan', defaultMessage: 'Edit plan' }),
        detail: ops.length
          ? t(
              {
                id: 'data.toolCalls.action.opCount',
                defaultMessage: '{count, plural, one {# change} other {# changes}}',
              },
              { count: ops.length },
            )
          : '',
        tasks: [...new Set(ids.filter((t): t is string => t !== null))],
      };
    }
    case 'interrupt_task':
      return {
        title: t({ id: 'data.toolCalls.action.interrupt', defaultMessage: 'Interrupt' }),
        detail: '',
        tasks: task,
      };
    case 'sync_board':
      return {
        title: t({ id: 'data.toolCalls.action.syncBoard', defaultMessage: 'Sync board' }),
        detail: '',
        tasks: [],
      };
    case 'rerun_baseline':
      return {
        title: t({ id: 'data.toolCalls.action.rerunBaseline', defaultMessage: 'Rerun baseline' }),
        detail: '',
        tasks: [],
      };
    case 'request_review': {
      const reviewed = text(record(receiptOf(output)?.requester)?.task_id);
      return {
        title: t({ id: 'data.toolCalls.action.requestReview', defaultMessage: 'Request review' }),
        detail: strings(i.runtimes).join(', '),
        tasks: reviewed ? [reviewed] : [],
      };
    }
  }
  return null;
}

// Labels are getters, so each is read in the language loaded by then.
const BASELINE_STATE: Record<string, string> = {
  get running() {
    return t({ id: 'data.toolCalls.baseline.running', defaultMessage: 'Baseline running' });
  },
  get empty() {
    return t({ id: 'data.toolCalls.baseline.empty', defaultMessage: 'Empty project' });
  },
  get submitted() {
    return t({ id: 'data.toolCalls.baseline.submitted', defaultMessage: 'Awaiting confirmation' });
  },
  get confirmed() {
    return t({ id: 'data.toolCalls.baseline.confirmed', defaultMessage: 'Confirmed' });
  },
  get failed() {
    return t({ id: 'data.toolCalls.baseline.failed', defaultMessage: 'Failed' });
  },
};
const REVIEW_STATE: Record<string, string> = {
  get running() {
    return t({ id: 'data.toolCalls.review.running', defaultMessage: 'Reviewing' });
  },
  get completed() {
    return t({ id: 'data.toolCalls.review.completed', defaultMessage: 'Reviewed' });
  },
  get failed() {
    return t({ id: 'data.toolCalls.review.failed', defaultMessage: 'Review failed' });
  },
};
const TASK_STATE: Record<string, string> = {
  get todo() {
    return t({ id: 'data.toolCalls.taskState.todo', defaultMessage: 'To do' });
  },
  get active() {
    return t({ id: 'data.toolCalls.taskState.active', defaultMessage: 'In progress' });
  },
  get done() {
    return t({ id: 'data.toolCalls.taskState.done', defaultMessage: 'Done' });
  },
};

// The MCP server's refusal: `Refused <command>: <code>` with ` — <message>` when there is one.
const REFUSED = /^Refused [^:]+: (\S+)(?: — ([\s\S]+))?$/;

const firstSentence = (value: string): string =>
  flat(
    value
      .trim()
      .split('\n')[0]!
      .split(/(?<=[.。!?！？])\s/)[0]!,
    120,
  );

/** A few words on how an orchestration call ended, from its receipt or its error. */
export function orchestrationResult(
  name: string,
  input: unknown,
  output: unknown,
  ok: boolean,
): string {
  if (!ok) {
    const said = outputText(output).trim();
    const refused = REFUSED.exec(said);
    if (refused)
      return t(
        { id: 'data.toolCalls.refused', defaultMessage: 'Refused: {reason}' },
        { reason: firstSentence(refused[2] ?? refused[1]!) },
      );
    return said
      ? firstSentence(said)
      : t({ id: 'data.toolCalls.failed', defaultMessage: 'Failed' });
  }
  const r = receiptOf(output);
  if (!r) return toolOutcome(output, ok);
  switch (pantheonTool(name)) {
    case 'update_board':
    case 'edit_board':
      return typeof r.plan_version === 'number'
        ? t(
            { id: 'data.toolCalls.savedVersion', defaultMessage: 'Saved v{version}' },
            { version: r.plan_version },
          )
        : t({ id: 'data.toolCalls.saved', defaultMessage: 'Saved' });
    case 'start_task': {
      if (text(r.claimed))
        return t({ id: 'data.toolCalls.claimed', defaultMessage: 'Doing it itself' });
      const requested = strings(r.requested);
      const queued = strings(callArgs(input).task_ids).filter((t) => requested.includes(t));
      return t(
        { id: 'data.toolCalls.queuedCount', defaultMessage: '{count} queued' },
        { count: queued.length },
      );
    }
    case 'stop_task':
      return Array.isArray(r.sessions) &&
        r.sessions.some((session) => record(session)?.step === 'stopping')
        ? t({ id: 'data.toolCalls.stopping', defaultMessage: 'Stopping' })
        : t({ id: 'data.toolCalls.stopped', defaultMessage: 'Stopped' });
    case 'interrupt_task':
      return t({ id: 'data.toolCalls.interrupted', defaultMessage: 'Interrupted' });
    case 'sync_board':
      return t({ id: 'data.toolCalls.read', defaultMessage: 'Read' });
    case 'rerun_baseline':
      return BASELINE_STATE[String(r.state)] ?? '';
    case 'request_review':
      return REVIEW_STATE[String(r.state)] ?? '';
  }
  return '';
}

/** One line of an orchestration call's folded-out detail: its task, a word, and text or code. */
export interface OrchestrationEntry {
  task?: string;
  name?: string;
  text?: string;
  code?: string;
}

const entry = (fields: OrchestrationEntry): OrchestrationEntry =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== ''));

// The lines board.sync writes for each task: `- <id> "<title>": <state>; sessions: <list>`.
const SYNC_TASK = /^- (\S+) ".*": (\w+); sessions: (.*)$/;

function editEntry(op: Record<string, unknown>): OrchestrationEntry {
  const task = text(op.task_id) ?? undefined;
  switch (op.type) {
    case 'add_task': {
      const added = record(op.task) ?? {};
      return entry({
        task: text(added.id) ?? undefined,
        name: t({ id: 'data.toolCalls.edit.add', defaultMessage: 'Add' }),
        text: flat(String(added.title ?? '')),
      });
    }
    case 'remove_task':
      return entry({
        task,
        name: t({ id: 'data.toolCalls.edit.remove', defaultMessage: 'Remove' }),
      });
    case 'set_task':
      return entry({
        task,
        name: t({ id: 'data.toolCalls.edit.set', defaultMessage: 'Set' }),
        code: listText(
          ...Object.entries(record(op.patch) ?? {}).map(
            ([key, value]) => `${key}=${flat(String(value))}`,
          ),
        ),
      });
    case 'set_dependencies': {
      const on = strings(op.depends_on);
      return entry({
        task,
        name: on.length
          ? t({ id: 'data.toolCalls.edit.dependsOn', defaultMessage: 'Depends on' })
          : t({
              id: 'data.toolCalls.edit.clearDependencies',
              defaultMessage: 'Clear dependencies',
            }),
        code: on.join(', '),
      });
    }
    case 'resolve_edit':
      return entry({
        name:
          op.decision === 'apply'
            ? t({ id: 'data.toolCalls.edit.apply', defaultMessage: 'Apply edit' })
            : t({ id: 'data.toolCalls.edit.reject', defaultMessage: 'Reject edit' }),
        code: text(op.edit_id) ?? undefined,
        text: flat(text(op.reason) ?? ''),
      });
  }
  return entry({ task, code: text(op.type) ?? undefined });
}

/** The folded-out lines of an orchestration call; null when its input and output have no shape to list. */
export function orchestrationDetail(
  name: string,
  input: unknown,
  output: unknown,
): OrchestrationEntry[] | null {
  const i = callArgs(input);
  const r = receiptOf(output);
  let entries: OrchestrationEntry[] = [];
  switch (pantheonTool(name)) {
    case 'edit_board':
      entries = Array.isArray(i.ops) ? i.ops.map((op) => editEntry(record(op) ?? {})) : [];
      break;
    case 'start_task': {
      const requested = strings(r?.requested);
      entries = strings(i.task_ids).map((task) =>
        entry({
          task,
          name: requested.includes(task)
            ? t({ id: 'data.toolCalls.queued', defaultMessage: 'Queued' })
            : undefined,
        }),
      );
      break;
    }
    case 'sync_board':
      for (const line of (text(r?.brief) ?? '').split('\n')) {
        const m = SYNC_TASK.exec(line);
        if (m)
          entries.push(
            entry({
              task: m[1],
              name: TASK_STATE[m[2]!] ?? m[2],
              code: m[3] === 'none' ? '' : m[3],
            }),
          );
      }
      break;
    case 'stop_task':
      entries = (Array.isArray(r?.sessions) ? r.sessions : []).map((s) => {
        const session = record(s) ?? {};
        return entry({
          name:
            session.step === 'discarded'
              ? t({ id: 'data.toolCalls.discarded', defaultMessage: 'Discarded' })
              : t({ id: 'data.toolCalls.stopping', defaultMessage: 'Stopping' }),
          code: text(session.session_id) ?? undefined,
        });
      });
      break;
    case 'request_review':
      entries = [
        entry({
          name: t({ id: 'data.toolCalls.reviewEntry', defaultMessage: 'Review' }),
          code: strings(i.runtimes).join(', '),
        }),
      ];
      break;
  }
  return entries.length ? entries : null;
}

export const COMMANDS = [
  'Bash',
  'commandExecution',
  'local_shell_call',
  'shell',
  'command',
  'exec_command',
  'bash',
];
export const EDITS = [
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'fileChange',
  'file_change',
  'apply_patch',
  'edit',
  'write',
];
const AGENTS = ['Task', 'Agent', 'collabAgentToolCall', 'subagent', 'subagent_fork'];
const WEB = ['WebFetch', 'WebSearch', 'webSearch', 'web_fetch', 'web_search'];
export const READS = ['Read', 'Glob', 'Grep', 'read', 'glob', 'grep'];

interface Kind {
  key: string;
  rank: number;
  /** What the call touched; a kind counts its distinct entries. */
  touched: string[];
  text: (n: number) => string;
}

function kindOf(name: string, input: unknown, own: string): Kind {
  const i = record(input) ?? {};
  const single = (key: string, rank: number, label: (n: number) => string): Kind => ({
    key,
    rank,
    touched: [own],
    text: label,
  });
  if (COMMANDS.includes(name))
    return single('command', 0, (n) =>
      t(
        {
          id: 'data.toolCalls.group.commands',
          defaultMessage: '{count, plural, one {# command run} other {# commands run}}',
        },
        { count: n },
      ),
    );
  if (EDITS.includes(name)) {
    const paths =
      name === 'fileChange' || name === 'file_change'
        ? changePaths(i.changes)
        : [text(i.file_path ?? i.notebook_path)].filter((p): p is string => p !== null);
    return {
      key: 'edit',
      rank: 1,
      touched: paths.length ? paths : [own],
      text: (n) =>
        t(
          {
            id: 'data.toolCalls.group.edits',
            defaultMessage: '{count, plural, one {# file edited} other {# files edited}}',
          },
          { count: n },
        ),
    };
  }
  if (AGENTS.includes(name))
    return single('agent', 2, (n) =>
      t(
        {
          id: 'data.toolCalls.group.agents',
          defaultMessage:
            '{count, plural, one {# subagent dispatched} other {# subagents dispatched}}',
        },
        { count: n },
      ),
    );
  const tool = pantheonTool(name);
  if (tool === 'project_read' || tool === 'read_note')
    return single('project', 3, (n) =>
      t(
        {
          id: 'data.toolCalls.group.project',
          defaultMessage:
            '{count, plural, one {# read of the project} other {# reads of the project}}',
        },
        { count: n },
      ),
    );
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1]!;
    return single(`mcp:${server}`, 3, (n) =>
      t(
        {
          id: 'data.toolCalls.group.mcp',
          defaultMessage: '{count, plural, one {# {server} call} other {# {server} calls}}',
        },
        { server, count: n },
      ),
    );
  }
  if (WEB.includes(name))
    return single('web', 4, (n) =>
      t(
        {
          id: 'data.toolCalls.group.web',
          defaultMessage: '{count, plural, one {# web lookup} other {# web lookups}}',
        },
        { count: n },
      ),
    );
  if (READS.includes(name))
    return {
      key: 'read',
      rank: 5,
      touched: [((name === 'Read' || name === 'read') && text(i.file_path)) || own],
      text: (n) =>
        t(
          {
            id: 'data.toolCalls.group.reads',
            defaultMessage: '{count, plural, one {# file read} other {# files read}}',
          },
          { count: n },
        ),
    };
  return single('other', 6, () => '');
}

/** A group of calls by its two highest kinds, e.g. 4 commands run, 3 files edited, 2 more. */
export function toolGroupLabel(calls: { name: string; input: unknown }[]): string {
  const kinds = new Map<string, Omit<Kind, 'touched'> & { calls: number; touched: Set<string> }>();
  calls.forEach((call, at) => {
    const kind = kindOf(call.name, call.input, `#${at}`);
    const seen = kinds.get(kind.key);
    if (seen) {
      seen.calls++;
      for (const t of kind.touched) seen.touched.add(t);
    } else kinds.set(kind.key, { ...kind, calls: 1, touched: new Set(kind.touched) });
  });
  // Map order keeps first appearance among kinds of one rank.
  const ranked = [...kinds.values()].sort((a, b) => a.rank - b.rank);
  const named = ranked.filter((k) => k.key !== 'other').slice(0, 2);
  if (!named.length)
    return t(
      {
        id: 'data.toolCalls.group.calls',
        defaultMessage: '{count, plural, one {# tool call} other {# tool calls}}',
      },
      { count: calls.length },
    );
  const rest = calls.length - named.reduce((n, k) => n + k.calls, 0);
  const shown = named.map((k) => k.text(k.touched.size));
  return listText(
    ...shown,
    rest > 0 &&
      t({ id: 'data.toolCalls.group.rest', defaultMessage: '{count} more' }, { count: rest }),
  );
}

/**
 * A call that dispatches a subagent: Claude's Task or Agent, or a Codex collab spawn; null for any
 * other call. Codex reports no agent type.
 */
export function subagentCall(
  name: string,
  input: unknown,
): { type: string | null; description: string; prompt: string } | null {
  const i = record(input) ?? {};
  if (name === 'Task' || name === 'Agent')
    return {
      type: text(i.subagent_type),
      description: flat(text(i.description) ?? ''),
      prompt: text(i.prompt) ?? '',
    };
  if (name === 'collabAgentToolCall' && /^spawn/i.test(text(i.tool) ?? ''))
    return { type: null, description: flat(text(i.prompt) ?? ''), prompt: text(i.prompt) ?? '' };
  return null;
}

/** The name of the kind a draw call asks for, as the card names it; null for an unknown kind. */
function drawnKind(kind: unknown): string | null {
  switch (kind) {
    case 'kline':
      return t({ id: 'visual.kind.kline', defaultMessage: 'Candlestick chart' });
    case 'vega-lite':
      return t({ id: 'visual.kind.vegaLite', defaultMessage: 'Chart' });
    case 'mermaid':
      return t({ id: 'visual.kind.mermaid', defaultMessage: 'Mermaid diagram' });
    case 'graph':
      return t({ id: 'visual.kind.graph', defaultMessage: 'Graph' });
    default:
      return null;
  }
}

/** The data source a draw call names; null for any other call or a draw without one. */
export function drawSource(name: string, input: unknown): string | null {
  return pantheonTool(name) === 'draw' ? text(callArgs(input).source) : null;
}

/** Title and key argument of a Claude or Codex tool call; paths are shown relative to `bases`. */
export function toolLabel(name: string, input: unknown, bases: readonly string[] = []): ToolLabel {
  const i = record(input) ?? {};
  const path = (value: unknown) => {
    const s = text(value);
    return s ? relative(s, bases) : '';
  };
  const title = TITLES[name] ?? name;
  if (pantheonTool(name) === 'draw') {
    const args = callArgs(input);
    const shown = flat(text(args.title) ?? '');
    if (args.kind === 'html')
      return {
        title: t({ id: 'visual.tool.writePage', defaultMessage: 'Write page' }),
        detail: shown,
        prose: true,
      };
    return {
      title: listText(t({ id: 'visual.tool.draw', defaultMessage: 'Draw' }), drawnKind(args.kind)),
      detail: shown,
      prose: true,
    };
  }
  if (name.startsWith('mcp__')) {
    const [, server, ...tool] = name.split('__');
    return { title: `${server}, ${tool.join('__')}`, detail: scalars(i) };
  }
  switch (name) {
    case 'Bash':
    case 'commandExecution':
    case 'local_shell_call':
    case 'shell':
      return { title, detail: command(i.command) };
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { title, detail: path(i.file_path ?? i.notebook_path) };
    case 'imageView':
      return { title, detail: path(i.path) };
    case 'Glob':
      return { title, detail: listText(text(i.pattern), path(i.path)) };
    case 'Grep':
      return { title, detail: listText(text(i.pattern), path(i.path), text(i.glob)) };
    case 'WebFetch':
      return { title, detail: text(i.url) ?? '' };
    case 'WebSearch':
    case 'webSearch':
      return { title, detail: flat(text(i.query) ?? '') };
    case 'Task':
    case 'Agent':
      return {
        title: listText(name, text(i.subagent_type)),
        detail: flat(text(i.description) ?? ''),
      };
    case 'TodoWrite': {
      if (!Array.isArray(i.todos))
        return { title: t({ id: 'data.toolCalls.todos', defaultMessage: 'Tasks' }), detail: '' };
      const todos = i.todos.map((t) => record(t) ?? {});
      const done = todos.filter((t) => t.status === 'completed').length;
      const current = text(todos.find((t) => t.status === 'in_progress')?.content);
      return {
        title: t({ id: 'data.toolCalls.todos', defaultMessage: 'Tasks' }),
        detail: `${done}/${todos.length}${current ? ` ${flat(current)}` : ''}`,
      };
    }
    case 'fileChange':
      return {
        title,
        detail: changePaths(i.changes)
          .map((p) => relative(p, bases))
          .join(', '),
      };
    case 'dynamicToolCall':
      return {
        title: listText(text(i.namespace), text(i.tool)) || title,
        detail: scalars(record(i.arguments)),
      };
    case 'collabAgentToolCall':
      return { title, detail: listText(text(i.tool), flat(text(i.prompt) ?? '', 200)) };
  }
  const dot = name.indexOf('.');
  if (dot > 0) {
    return {
      title: listText(name.slice(0, dot), name.slice(dot + 1)),
      detail: scalars('arguments' in i ? record(i.arguments) : i),
    };
  }
  return {
    title: name || t({ id: 'data.toolCalls.unknownTool', defaultMessage: 'Unknown tool' }),
    detail: command(i.command) || firstString(i),
  };
}

/** The decoded path of a file URL on this machine; null for another host or a malformed URL. */
function localFilePath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.host === '' || parsed.host === 'localhost'
      ? decodeURIComponent(parsed.pathname)
      : null;
  } catch {
    return null;
  }
}

/**
 * The path of a file in the folder the files panel shows, `bases[0]`, from a path or file URL; null
 * for one outside it.
 */
export function workspaceFile(path: string, bases: readonly string[]): string | null {
  const root = bases[0]?.replace(/\/+$/, '');
  if (!root) return null;
  const plain = /^file:/i.test(path) ? localFilePath(path) : path;
  if (plain === null) return null;
  const inside = plain.startsWith('/')
    ? plain.startsWith(`${root}/`)
      ? plain.slice(root.length + 1)
      : null
    : plain.replace(/^(\.\/)+/, '');
  return inside && !inside.split('/').includes('..') ? inside : null;
}

/** The files a call wrote, changed, viewed or generated, as the files panel names them. */
export function toolFiles(
  name: string,
  input: unknown,
  output: unknown,
  bases: readonly string[],
): string[] {
  const i = record(input) ?? {};
  const named =
    name === 'fileChange' || name === 'file_change'
      ? changePaths(i.changes)
      : name === 'imageView'
        ? [text(i.path)]
        : name === 'imageGeneration'
          ? [text(record(output)?.savedPath)]
          : EDITS.includes(name)
            ? [text(i.file_path ?? i.notebook_path)]
            : [];
  const files = named.flatMap((path) => (path ? [workspaceFile(path, bases)] : []));
  return [...new Set(files.filter((path) => path !== null))];
}

/** Whether the files panel shows the file as a picture. */
export const isImageFile = (path: string): boolean => /\.(png|jpe?g|gif|webp|svg)$/i.test(path);

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((part) => (typeof part === 'string' ? part : (text(record(part)?.text) ?? '')))
      .filter(Boolean)
      .join('\n');
  const r = record(value);
  if (!r) return '';
  for (const key of ['content', 'text', 'contentItems', 'result', 'error', 'output']) {
    const found = outputText(r[key]);
    if (found) return found;
  }
  return '';
}

/** The text a tool call returned: Claude content, Codex text, MCP result or error; else ''. */
export const toolOutputText = (output: unknown): string => outputText(output);

/** One line about a finished call: exit code, then its only line or its line count. */
export function toolOutcome(output: unknown, ok: boolean): string {
  const exitCode = record(output)?.exitCode;
  const exit =
    typeof exitCode === 'number'
      ? t({ id: 'data.toolCalls.exitCode', defaultMessage: 'Exit code {code}' }, { code: exitCode })
      : null;
  const lines = outputText(output).replace(/\s+$/, '').split('\n');
  const first = flat(lines.find((line) => line.trim() !== '') ?? '', 120);
  if (!ok)
    return listText(t({ id: 'data.toolCalls.failed', defaultMessage: 'Failed' }), exit, first);
  // A Pantheon command's receipt holds ids, not words; what it made shows under the row.
  if (receiptOf(output)) return '';
  return listText(
    exit,
    lines.length > 1
      ? t(
          {
            id: 'data.toolCalls.lineCount',
            defaultMessage: '{count, plural, one {# line} other {# lines}}',
          },
          { count: lines.length },
        )
      : first,
  );
}

/** Whether tracePayload cut the payload short. */
export const isTruncated = (payload: unknown): boolean => record(payload)?.truncated === true;
