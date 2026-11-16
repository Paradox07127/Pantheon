import { open, readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { canonical, type TraceMeta, type TraceSpan } from '@pantheon/domain';
import { toolOutputOutcome } from './codex.js';
import { reportedToolTokens, toolInputSummary } from './trace.js';

export interface TraceReducer {
  /** One raw line without its trailing newline. */
  push(line: string): void;
  spans(): TraceSpan[];
  /** JSON-serializable; restore() on a fresh reducer continues from here. */
  state(): unknown;
  restore(state: unknown): void;
  /** Lines skipped, by native type or invalid_json. */
  unknown(): Record<string, number>;
  /** The session's custom title, else the first line of its first typed prompt. */
  title(): string | undefined;
}

type Row = Record<string, any>;
interface Spans {
  spans: TraceSpan[];
  index: Record<string, number>;
  unknown: Record<string, number>;
  title?: string;
  tool_inputs: Record<string, string>;
  last_tool_by_turn: Record<string, string>;
}

const CLAUDE_TYPES = new Set([
  'user',
  'assistant',
  'api-request',
  'system',
  'attachment',
  'queue-operation',
  'last-prompt',
  'relocated',
  'custom-title',
  'agent-name',
  'file-history-snapshot',
  'file-history-delta',
  'cost-state',
]);
const CODEX_TYPES = new Set([
  'session_meta',
  'event_msg',
  'response_item',
  'world_state',
  'turn_context',
  'token_usage_record',
  'compacted',
]);
const COMMIT_LINE = /^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/m;

function parse(line: string, known: Set<string>, unknown: Record<string, number>): Row | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    row = null;
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    unknown.invalid_json = (unknown.invalid_json ?? 0) + 1;
    return null;
  }
  const type = String((row as Row).type);
  if (!known.has(type)) {
    unknown[type] = (unknown[type] ?? 0) + 1;
    return null;
  }
  return row as Row;
}

const timeOf = (row: Row): number | null =>
  typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : null;

function addTool(state: Spans, span: TraceSpan, input: unknown): void {
  const summary = toolInputSummary(input);
  if (summary !== undefined) span.input_summary = summary;
  if (input !== undefined) {
    const signature = canonical([span.turn, span.name, input]);
    const previous = find(state, state.last_tool_by_turn[span.turn]);
    if (
      previous &&
      state.tool_inputs[previous.id] === signature &&
      previous.status === 'error' &&
      previous.end !== null &&
      span.start !== null &&
      previous.end <= span.start
    )
      span.retry_count = (previous.retry_count ?? 0) + 1;
    state.tool_inputs[span.id] = signature;
  }
  state.last_tool_by_turn[span.turn] = span.id;
  add(state, span);
}

function add(state: Spans, span: TraceSpan): void {
  state.index[span.id] = state.spans.length;
  state.spans.push(span);
}

const find = (state: Spans, id: unknown): TraceSpan | undefined => {
  const at = typeof id === 'string' ? state.index[id] : undefined;
  return at === undefined ? undefined : state.spans[at];
};

const TITLE_CHARS = 80;

/** The first non-empty line of text, cut to TITLE_CHARS characters. */
function titleOf(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  if (line === undefined) return undefined;
  const chars = Array.from(line);
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('')}…` : line;
}

/** The tags Codex and Claude Code wrap around the text they inject as a user message. */
const INJECTED_TAGS = new Set([
  'environment_context',
  'user_instructions',
  'user_shell_command',
  'turn_aborted',
  'subagent_notification',
  'skill',
  'skills_instructions',
  'permissions',
  'collaboration_mode',
  'multi_agent_mode',
  'multi_agent_role',
  'model_instructions',
  'recommended_plugins',
  'app-context',
  'image_resize_notice',
  'codex_apps_client_time_context',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'system-reminder',
  'task-notification',
  'user-prompt-submit-hook',
]);

/** A prompt the user typed, not text the runtime injected inside one of its tags. */
const promptTitle = (text: unknown): string | undefined =>
  typeof text === 'string' &&
  !INJECTED_TAGS.has(/^<([\w-]+)[\s>]/.exec(text.trimStart())?.[1] ?? '')
    ? titleOf(text)
    : undefined;

function reducer<S extends Spans>(initial: () => S, push: (state: S, line: string) => void) {
  let state = initial();
  return {
    push: (line: string) => push(state, line),
    spans: () => structuredClone(state.spans),
    state: () => structuredClone(state),
    restore: (saved: unknown) => {
      state = structuredClone(saved) as S;
    },
    unknown: () => ({ ...state.unknown }),
    title: () => state.title,
  } satisfies TraceReducer;
}

interface ClaudeState extends Spans {
  turn: string | null;
  turn_index: number | null;
  /** Row uuids read so far; a resumed session replays its history under the same uuids. */
  seen: Record<string, true>;
}

export function createClaudeReducer(lane: {
  native_id: string;
  parent_tool_use_id?: string;
}): TraceReducer {
  const openTurn = (state: ClaudeState, index: number, at: number | null): string => {
    const id = `${lane.native_id}:turn:${index}`;
    add(state, {
      id,
      parent: lane.parent_tool_use_id ?? null,
      turn: id,
      kind: 'turn',
      name: `turn ${index}`,
      start: at,
      end: at,
      status: 'ok',
      timing: 'native',
    });
    state.turn = id;
    state.turn_index = index;
    return id;
  };
  // A file without turnPosition rows, such as a subagent's, is one turn.
  const turnOf = (state: ClaudeState, at: number | null): string =>
    state.turn ?? openTurn(state, 1, at);

  return reducer<ClaudeState>(
    () => ({
      spans: [],
      index: {},
      unknown: {},
      tool_inputs: {},
      last_tool_by_turn: {},
      turn: null,
      turn_index: null,
      seen: {},
    }),
    (state, line) => {
      const row = parse(line, CLAUDE_TYPES, state.unknown);
      if (!row) return;
      if (typeof row.uuid === 'string') {
        if (state.seen[row.uuid]) return;
        state.seen[row.uuid] = true;
      }
      const at = timeOf(row);
      const historyBefore =
        !lane.parent_tool_use_id && typeof row.parentUuid === 'string' ? row.parentUuid : undefined;
      const content: Row[] = Array.isArray(row.message?.content) ? row.message.content : [];
      if (row.type === 'custom-title') {
        const title = typeof row.customTitle === 'string' ? titleOf(row.customTitle) : undefined;
        if (title) state.title = title;
      } else if (row.type === 'user') {
        if (state.title === undefined && row.isMeta !== true && row.isSidechain !== true) {
          const title = promptTitle(
            typeof row.message?.content === 'string'
              ? row.message.content
              : content.find((block) => block?.type === 'text')?.text,
          );
          if (title) state.title = title;
        }
        const index = row.turnPosition?.turnIndex;
        if (typeof index === 'number') {
          if (index !== state.turn_index) openTurn(state, index, at);
        } else turnOf(state, at);
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          const span = find(state, block.tool_use_id);
          if (!span) continue;
          span.end = at;
          span.status = block.is_error === true ? 'error' : 'ok';
          const tokens = reportedToolTokens(row.toolUseResult?.usage);
          if (tokens) span.tokens = tokens;
          if (span.name === 'Bash' && typeof row.toolUseResult?.exitCode === 'number')
            span.exit_code = row.toolUseResult.exitCode;
          if (span.name !== 'Bash') continue;
          const text =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((part: Row) => typeof part?.text === 'string')
                    .map((part: Row) => part.text)
                    .join('\n')
                : '';
          const sha = COMMIT_LINE.exec(text)?.[1];
          if (sha) span.commit = { sha, via: 'bash_output' };
        }
      } else if (row.type === 'api-request' && typeof row.id === 'string') {
        const turn = turnOf(state, at);
        if (!find(state, row.id))
          add(state, {
            id: row.id,
            parent: turn,
            turn,
            kind: 'llm',
            name: '',
            start: at,
            end: null,
            status: 'unknown',
            timing: 'native',
          });
      } else if (row.type === 'assistant') {
        const turn = turnOf(state, at);
        const llm = find(state, row.requestRef);
        if (llm) {
          const usage = row.message?.usage ?? {};
          llm.native_history_before ??= historyBefore;
          llm.end = at;
          llm.name = String(row.message?.model ?? '');
          llm.status = 'ok';
          // Input counts the whole prompt, cached or not, as Codex usage does.
          llm.tokens = {
            input:
              (usage.input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0),
            output: usage.output_tokens ?? 0,
            ...(usage.cache_read_input_tokens !== undefined
              ? { cache_read: usage.cache_read_input_tokens }
              : {}),
          };
        }
        for (const block of content) {
          if (block?.type !== 'tool_use' || typeof block.id !== 'string' || find(state, block.id))
            continue;
          const name = String(block.name ?? '');
          const file = block.input?.file_path ?? block.input?.path;
          addTool(
            state,
            {
              id: block.id,
              ...(historyBefore ? { native_history_before: historyBefore } : {}),
              parent: turn,
              turn,
              kind: name === 'Task' || name === 'Agent' ? 'subagent' : 'tool',
              name,
              start: at,
              end: null,
              status: 'unknown',
              timing: 'native',
              ...(typeof file === 'string' ? { files: [file] } : {}),
            },
            block.input,
          );
        }
      } else if (row.type === 'system' && row.subtype === 'compact_boundary') {
        const turn = turnOf(state, at);
        add(state, {
          id: String(row.uuid),
          parent: turn,
          turn,
          kind: 'compact',
          name: 'compact',
          start: at,
          end: at,
          status: 'ok',
          timing: 'native',
        });
      }
      // Queued prompts, titles, compaction and its summary can be written long after the turn's work.
      const work =
        (row.type === 'user' && row.isCompactSummary !== true) ||
        row.type === 'assistant' ||
        row.type === 'api-request' ||
        (row.type === 'system' && row.subtype !== 'compact_boundary');
      const turn = find(state, state.turn);
      if (work && turn && at !== null) turn.end = at;
    },
  );
}

interface Tokens {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
}
interface CodexState extends Spans {
  turn: string | null;
  turns: number;
  open: boolean;
  /** Model-initiated call ids of the current turn, in start order. */
  calls: string[];
  /** Cumulative usage before the current turn started. */
  base: Tokens;
  /** Latest cumulative usage. */
  total: Tokens | null;
  /** True while a spawned agent's rollout repeats its parent's history; null before session_meta. */
  inherited: boolean | null;
  /** The parent's spawn_agent call that started this agent; null in a rollout nobody spawned. */
  spawn: string | null;
  /** The parent's running turn, which Codex aborts at the end of the repeated history. */
  aborted: string | null;
}

const ZERO: Tokens = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };

function itemName(item: Row): string | null {
  if (item.type === 'CommandExecution') return 'command';
  if (item.type === 'ContextCompaction') return 'compact';
  if (item.type === 'McpToolCall') return `${item.server}.${item.tool}`;
  if (item.type === 'FileChange') return 'file_change';
  return null;
}

export function createCodexReducer(lane: { native_id: string }): TraceReducer {
  return reducer<CodexState>(
    () => ({
      spans: [],
      index: {},
      unknown: {},
      tool_inputs: {},
      last_tool_by_turn: {},
      turn: null,
      turns: 0,
      open: false,
      calls: [],
      base: { ...ZERO },
      total: null,
      inherited: null,
      spawn: null,
      aborted: null,
    }),
    (state, line) => {
      const row = parse(line, CODEX_TYPES, state.unknown);
      if (!row) return;
      const at = timeOf(row);
      const payload: Row = row.payload ?? {};
      if (row.type === 'session_meta') {
        // The first record is this rollout's own; a spawned agent's repeats its parent's next.
        state.inherited ??= payload.source?.subagent?.thread_spawn !== undefined;
        return;
      }
      if (state.inherited) {
        if (row.type === 'response_item' && payload.name === 'spawn_agent')
          state.spawn = payload.call_id;
        else if (row.type === 'event_msg' && payload.type === 'turn_aborted')
          state.aborted = payload.turn_id;
        // The agent's own first turn names the parent turn the repeated history ended in.
        if (!(
          row.type === 'event_msg' &&
          payload.type === 'task_started' &&
          state.aborted !== null &&
          payload.turn_attribution?.parent_turn_id === state.aborted
        ))
          return;
        state.inherited = false;
      }
      // An open turn lasts at least until the last line read.
      const current = state.open ? find(state, state.turn) : undefined;
      if (current && at !== null) current.end = at;
      if (
        state.title === undefined &&
        row.type === 'response_item' &&
        payload.type === 'message' &&
        payload.role === 'user' &&
        Array.isArray(payload.content)
      )
        for (const part of payload.content) {
          if (part?.type !== 'input_text' || String(part.text).startsWith('# AGENTS.md')) continue;
          const title = promptTitle(part.text);
          if (!title) continue;
          state.title = title;
          break;
        }
      if (row.type === 'event_msg' && payload.type === 'task_started') {
        state.turns += 1;
        const id = `${lane.native_id}:turn:${state.turns}`;
        add(state, {
          id,
          parent: state.spawn,
          turn: id,
          kind: 'turn',
          name: `turn ${state.turns}`,
          start: at,
          end: at,
          status: 'unknown',
          timing: 'native',
        });
        state.turn = id;
        state.open = true;
        state.calls = [];
        state.base = { ...(state.total ?? ZERO) };
        return;
      }
      // An interrupted turn ends where it was aborted, as a cancelled Pantheon turn ends ok.
      if (
        row.type === 'event_msg' &&
        (payload.type === 'task_complete' || payload.type === 'turn_aborted')
      ) {
        const turn = find(state, state.turn);
        if (turn && state.open) {
          turn.end = at;
          turn.status = 'ok';
        }
        state.open = false;
        return;
      }
      if (row.type === 'event_msg' && payload.type === 'token_count') {
        const usage = payload.info?.total_token_usage;
        if (!usage) return;
        state.total = {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cached_input_tokens: usage.cached_input_tokens ?? 0,
        };
        const turn = find(state, state.turn);
        if (turn && state.open)
          turn.tokens = {
            input: state.total.input_tokens - state.base.input_tokens,
            output: state.total.output_tokens - state.base.output_tokens,
            cache_read: state.total.cached_input_tokens - state.base.cached_input_tokens,
          };
        return;
      }
      const turn = state.turn;
      if (!turn) return;
      if (
        row.type === 'response_item' &&
        (payload.type === 'custom_tool_call' ||
          payload.type === 'function_call' ||
          payload.type === 'local_shell_call') &&
        typeof payload.call_id === 'string' &&
        !find(state, payload.call_id)
      ) {
        const local = payload.type === 'local_shell_call';
        let input = local ? payload.action : (payload.arguments ?? payload.input);
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            // Custom tools can carry plain text.
          }
        }
        const text = typeof input === 'string' ? titleOf(input) : undefined;
        addTool(
          state,
          {
            id: payload.call_id,
            parent: turn,
            turn,
            kind: payload.name === 'spawn_agent' ? 'subagent' : 'tool',
            ...(text !== undefined ? { input_summary: text } : {}),
            name: local
              ? 'local_shell_call'
              : typeof payload.namespace === 'string'
                ? `${payload.namespace}.${payload.name}`
                : String(payload.name ?? ''),
            start: at,
            end: null,
            status: 'unknown',
            timing: 'native',
          },
          input,
        );
        state.calls.push(payload.call_id);
        return;
      }
      if (
        row.type === 'response_item' &&
        (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output')
      ) {
        const call = find(state, payload.call_id);
        if (call) {
          call.end = at;
          const output = payload.output;
          const exitCode = typeof output?.exitCode === 'number' ? output.exitCode : undefined;
          const ok = exitCode !== undefined ? exitCode === 0 : toolOutputOutcome(output).ok;
          call.status = ok === undefined ? 'unknown' : ok ? 'ok' : 'error';
          const tokens = reportedToolTokens(output?.usage);
          if (tokens) call.tokens = tokens;
          if (exitCode !== undefined) call.exit_code = exitCode;
        }
        return;
      }
      const item: Row = payload.item ?? {};
      const name = row.type === 'event_msg' && payload.type === 'item_completed' && itemName(item);
      if (!name || typeof item.id !== 'string' || at === null) return;
      const duration = item.duration;
      const reported =
        Number.isSafeInteger(duration?.secs) &&
        duration.secs >= 0 &&
        Number.isSafeInteger(duration?.nanos) &&
        duration.nanos >= 0 &&
        duration.nanos < 1e9
          ? duration.secs * 1000 + duration.nanos / 1e6
          : undefined;
      const end = typeof payload.completed_at_ms === 'number' ? payload.completed_at_ms : at;
      const recorded = typeof payload.started_at_ms === 'number' ? payload.started_at_ms : null;
      const start = recorded ?? (reported === undefined ? null : Math.round(end - reported));
      const began = start ?? end;
      const status =
        item.status === 'failed' ||
        (item.type === 'CommandExecution' &&
          typeof item.exit_code === 'number' &&
          item.exit_code !== 0)
          ? 'error'
          : 'ok';
      const exit_code =
        item.type === 'CommandExecution' && typeof item.exit_code === 'number'
          ? item.exit_code
          : undefined;
      // Paginated rollouts give a command item its call's id.
      const call = find(state, item.id);
      if (call) {
        call.end = end;
        call.status = status;
        if (exit_code !== undefined) call.exit_code = exit_code;
        return;
      }
      // A call started after the step began cannot have run it, even if it overlaps the step's end.
      const parent = state.calls.findLast((id) => {
        const call = find(state, id);
        return (
          !!call &&
          call.start !== null &&
          call.start <= began &&
          (call.end === null || began <= call.end)
        );
      });
      const tokens = reportedToolTokens(item.usage);
      // A rollout records a shell command as [shell, '-lc', script].
      const command =
        Array.isArray(item.command) && item.command.length === 3 && /^-l?c$/.test(item.command[1])
          ? item.command[2]
          : item.command;
      const summary = item.type === 'CommandExecution' ? toolInputSummary({ command }) : undefined;
      if (item.type === 'FileChange')
        state.tool_inputs[item.id] = canonical([turn, name, { changes: item.changes }]);
      add(state, {
        id: item.id,
        parent: parent ?? turn,
        turn,
        kind: item.type === 'ContextCompaction' ? 'compact' : 'tool',
        name,
        start,
        end,
        status,
        timing: 'native',
        ...(reported !== undefined && (recorded === null || recorded === end)
          ? { duration_ms: reported }
          : {}),
        ...(tokens ? { tokens } : {}),
        ...(exit_code !== undefined ? { exit_code } : {}),
        ...(summary !== undefined ? { input_summary: summary } : {}),
        ...(item.type === 'FileChange' && item.changes && typeof item.changes === 'object'
          ? { files: Object.keys(item.changes) }
          : {}),
      });
    },
  );
}

const PROBE_BYTES = 256 * 1024;
// Metadata sits in the first rows; past this a file is left pending instead of read whole.
const PROBE_LIMIT = 8 * 1024 * 1024;

function rowsOf(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row as Row);
    } catch {
      // A line cut off at the end of the read is not a record yet.
    }
  }
  return rows;
}

/** The record that names the session: a Codex session_meta payload or a Claude row with a session id. */
function metaRecord(rows: Row[]): { codex: Row } | { claude: Row } | undefined {
  const first = rows[0];
  if (!first) return;
  if (first.payload && typeof first.payload === 'object') {
    const meta = rows.find((row) => row.type === 'session_meta')?.payload;
    return typeof meta?.id === 'string' && typeof meta.cwd === 'string'
      ? { codex: meta }
      : undefined;
  }
  const row = rows.find((row) => typeof row.sessionId === 'string' && typeof row.cwd === 'string');
  return row ? { claude: row } : undefined;
}

export async function probeMeta(file: string): Promise<TraceMeta | 'pending'> {
  const handle = await open(file, 'r');
  let record: ReturnType<typeof metaRecord>;
  try {
    const { size } = await handle.stat();
    // Widen the window until it holds a metadata record, the whole file or PROBE_LIMIT bytes.
    for (let window = PROBE_BYTES; ; window *= 2) {
      const buffer = Buffer.alloc(Math.min(window, size, PROBE_LIMIT));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      record = metaRecord(rowsOf(buffer.subarray(0, bytesRead).toString('utf8')));
      if (record || window >= size || window >= PROBE_LIMIT) break;
    }
  } finally {
    await handle.close();
  }
  if (!record) return 'pending';
  if ('codex' in record) {
    const meta = record.codex;
    const parent = meta.source?.subagent?.thread_spawn?.parent_thread_id;
    return {
      runtime: 'codex',
      native_id: meta.id,
      cwd: meta.cwd,
      ...(typeof meta.cli_version === 'string' ? { version: meta.cli_version } : {}),
      ...(typeof parent === 'string' ? { parent_native_id: parent } : {}),
    };
  }
  const row = record.claude;
  const version = typeof row.version === 'string' ? { version: row.version } : {};
  const subagents = dirname(file);
  if (basename(subagents) !== 'subagents' || !basename(file).startsWith('agent-'))
    return { runtime: 'claude', native_id: row.sessionId, cwd: row.cwd, ...version };
  const native_id = basename(file, '.jsonl');
  let parent_tool_use_id: unknown;
  try {
    parent_tool_use_id = JSON.parse(
      await readFile(`${subagents}/${native_id}.meta.json`, 'utf8'),
    ).toolUseId;
  } catch {
    return 'pending';
  }
  if (typeof parent_tool_use_id !== 'string') return 'pending';
  return {
    runtime: 'claude',
    native_id,
    cwd: row.cwd,
    ...version,
    parent_native_id: basename(dirname(subagents)),
    parent_tool_use_id,
  };
}
