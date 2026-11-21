import type { Session, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from './context.js';

/** The most the task sections and kept entries of a handoff take together, in UTF-8 bytes. */
const HANDOFF_BYTES = 16_000;
export const SHELL_TOOLS = new Set(['Bash', 'commandExecution', 'local_shell_call', 'shell']);

interface Entry {
  kind: 'user' | 'assistant' | 'command' | 'plan' | 'error';
  turnId: string;
  text: string;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A command as text; Codex raw calls carry it as an argument list. */
const commandText = (value: unknown): string =>
  Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';

/** Codex output carries `text`; Claude output carries `content`, a string or text blocks. */
function outputText(output: unknown): string {
  const { text, content } = record(output);
  if (typeof text === 'string') return text;
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content
        .map((part) => record(part).text)
        .filter((part) => typeof part === 'string')
        .join('\n')
    : '';
}

const planLines = (steps: unknown, label: string, status: string): string[] =>
  Array.isArray(steps)
    ? steps.map((step) => `- [${String(record(step)[status])}] ${String(record(step)[label])}`)
    : [];

/** The session's turns before `beforeTurnId` that were not rolled back, by id in order. */
function keptTurns(
  ctx: ControlContext,
  session: Session,
  beforeTurnId?: string,
): Map<string, SessionTurn> {
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === session.id);
  const cut = beforeTurnId ? turns.findIndex((turn) => turn.id === beforeTurnId) : -1;
  return new Map(
    (cut === -1 ? turns : turns.slice(0, cut))
      .filter((turn) => !turn.rolled_back)
      .map((turn) => [turn.id, turn]),
  );
}

/** The session's stored record, in time order: inputs, answers, commands, plans and turn errors. */
function entries(ctx: ControlContext, session: Session, kept: Map<string, SessionTurn>): Entry[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT kind, aggregate_id, payload FROM events WHERE aggregate_id IN (${[session.id, ...kept.keys()].map(() => '?').join(',')}) ORDER BY sequence`,
    )
    .all(session.id, ...kept.keys())
    .map((row) => ({
      kind: row.kind as string,
      aggregate: row.aggregate_id as string,
      payload: record(JSON.parse(row.payload as string)),
    }));
  // An input enters the record when its turn starts running; a turn that never ran, when queued.
  const inputAt = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind === 'turn.running' && !inputAt.has(row.aggregate))
      inputAt.set(row.aggregate, index);
  });
  rows.forEach((row, index) => {
    if (row.kind === 'turn.queued' && !inputAt.has(row.aggregate))
      inputAt.set(row.aggregate, index);
  });
  const result: Entry[] = [],
    commands = new Map<unknown, { entry: Entry; command: string }>(),
    ended = new Set<string>();
  rows.forEach((row, index) => {
    const turn = kept.get(row.aggregate);
    if (turn) {
      if (inputAt.get(turn.id) === index) {
        // The new conversation sees no image blocks, so images are listed by path too.
        const attached = turn.attachments?.length
          ? `\n\nAttached files:\n${turn.attachments.map((file) => `- ${file.path}`).join('\n')}`
          : '';
        result.push({ kind: 'user', turnId: turn.id, text: `User:\n${turn.input}${attached}` });
      }
      if ((row.kind === 'turn.failed' || row.kind === 'turn.cancelled') && !ended.has(turn.id)) {
        ended.add(turn.id);
        const error = row.payload.error ?? turn.delivery_reason;
        result.push({
          kind: 'error',
          turnId: turn.id,
          text: `[Turn ${row.kind === 'turn.failed' ? 'failed' : 'cancelled'}${error ? `: ${String(error)}` : ''}]`,
        });
      }
      return;
    }
    const turnId = row.payload.turn_id;
    if (row.aggregate !== session.id || typeof turnId !== 'string' || !kept.has(turnId)) return;
    const { payload } = row;
    if (row.kind === 'agent.message.delta') {
      const last = result.at(-1);
      if (last?.kind === 'assistant' && last.turnId === turnId) last.text += String(payload.text);
      else result.push({ kind: 'assistant', turnId, text: `Assistant:\n${String(payload.text)}` });
    } else if (row.kind === 'agent.tool.started' && SHELL_TOOLS.has(String(payload.name))) {
      const command = `$ ${commandText(record(payload.input).command)}`,
        entry: Entry = { kind: 'command', turnId, text: `${command}\n[no result recorded]` };
      commands.set(payload.tool_call_id, { entry, command });
      result.push(entry);
    } else if (row.kind === 'agent.tool.completed' && commands.has(payload.tool_call_id)) {
      const { entry, command } = commands.get(payload.tool_call_id)!,
        { exitCode } = record(payload.output),
        status = typeof exitCode === 'number' ? `exit ${exitCode}` : payload.ok ? 'ok' : 'failed';
      entry.text = `${command}\n[${status}]\n${outputText(payload.output)}`.trimEnd();
    } else if (row.kind === 'agent.tool.started' && payload.name === 'TodoWrite')
      result.push({
        kind: 'plan',
        turnId,
        text: ['Plan:', ...planLines(record(payload.input).todos, 'content', 'status')].join('\n'),
      });
    else if (row.kind === 'agent.native' && record(payload.native).method === 'turn/plan/updated')
      result.push({
        kind: 'plan',
        turnId,
        text: [
          'Plan:',
          ...planLines(record(record(payload.native).params).plan, 'step', 'status'),
        ].join('\n'),
      });
    else if (row.kind === 'agent.turn.completed' && payload.status !== 'completed') {
      ended.add(turnId);
      result.push({
        kind: 'error',
        turnId,
        text: `[Turn ${String(payload.status)}${payload.error ? `: ${String(payload.error)}` : ''}]`,
      });
    } else if (row.kind === 'agent.error')
      result.push({ kind: 'error', turnId, text: `[Error: ${String(payload.message)}]` });
  });
  return result;
}

/**
 * The session's record for a new native conversation. The record's entries are cut to the byte
 * budget by fixed rules: entries are kept whole, the latest input, the latest answer and the first input
 * first, then the rest from newest to oldest, skipping each that does not fit. `beforeTurnId`
 * leaves out that turn and later ones; rolled back turns are always left out.
 */
export function buildHandoff(ctx: ControlContext, session: Session, beforeTurnId?: string): string {
  const turns = keptTurns(ctx, session, beforeTurnId);
  const all = entries(ctx, session, turns);
  const lastOf = (kind: Entry['kind']) => all.findLastIndex((entry) => entry.kind === kind);
  const order = [
    lastOf('user'),
    lastOf('assistant'),
    all.findIndex((entry) => entry.kind === 'user'),
    ...all.map((_, index) => all.length - 1 - index),
  ].filter((index, at, list) => index !== -1 && list.indexOf(index) === at);
  const kept = new Set<number>();
  // Two bytes for the blank line that separates an entry from the one before it.
  let used = 0;
  for (const index of order) {
    const size = Buffer.byteLength(all[index]!.text) + 2;
    if (used + size > HANDOFF_BYTES) continue;
    used += size;
    kept.add(index);
  }
  const lines = [
    `[Pantheon] You continue work that a ${session.runtime} session did in this worktree. Its record follows, cut to fit; entries left out are marked. Check the files and git log for anything it does not show.`,
  ];
  let gap = 0;
  all.forEach((entry, index) => {
    if (!kept.has(index)) {
      gap++;
      return;
    }
    if (gap) lines.push(`[… ${gap} entries left out …]`);
    gap = 0;
    lines.push(entry.text);
  });
  if (gap) lines.push(`[… ${gap} entries left out …]`);
  return lines.join('\n\n');
}
