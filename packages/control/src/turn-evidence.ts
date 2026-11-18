import path from 'node:path';
import { requireThat, type Session, type StepRun, type Workspace } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { SHELL_TOOLS } from './handoff.js';
import { stepFiles } from './step-diff.js';

// Read at call time: handoff.js sits in an import cycle with this module's importers.
const shell = (name: string) =>
  SHELL_TOOLS.has(name) || name === 'exec_command' || name === 'command';

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A command as text; Codex raw calls carry it as an argument list. */
const commandText = (value: unknown): string =>
  Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';

const collapsed = (text: string) => text.replace(/\s+/g, ' ').trim();

export interface TurnEvidence {
  /** In the order the turn ran them, whitespace collapsed. */
  commands: { text: string; exit_code?: number }[];
  /** Relative to the session's worktree. */
  files: string[];
}

/** The shell commands one turn ran, with their exit codes, and the files it edited, from its tool events. */
export function turnEvidence(ctx: ControlContext, sessionId: string, turnId: string): TurnEvidence {
  const rows = ctx.store.db
    .prepare(
      "SELECT kind, payload FROM events WHERE aggregate_id=? AND kind IN ('agent.tool.started', 'agent.tool.completed') AND payload ->> '$.turn_id'=? ORDER BY sequence",
    )
    .all(sessionId, turnId) as { kind: string; payload: string }[];
  const session = ctx.store.must<Session>('sessions', sessionId),
    root = session.workspace_id
      ? ctx.store.get<Workspace>('workspaces', session.workspace_id)?.path
      : undefined;
  const commands = new Map<unknown, TurnEvidence['commands'][number]>(),
    files = new Set<string>();
  for (const row of rows) {
    const payload = record(JSON.parse(row.payload));
    if (row.kind === 'agent.tool.started' && shell(String(payload.name)))
      commands.set(payload.tool_call_id, {
        text: collapsed(commandText(record(payload.input).command)),
      });
    else if (row.kind === 'agent.tool.started')
      for (const file of stepFiles(String(payload.name), payload.input))
        files.add(
          root && path.isAbsolute(file.path)
            ? path.relative(root, file.path)
            : path.normalize(file.path),
        );
    else {
      const command = commands.get(payload.tool_call_id),
        { exitCode } = record(payload.output);
      if (command && typeof exitCode === 'number') command.exit_code = exitCode;
    }
  }
  return { commands: [...commands.values()], files: [...files] };
}

/**
 * Marks each item checked against what the turn did. While the turn ran a shell command, a command
 * item it did not run and a pass with nothing checked are refused.
 */
export function checkEvidence(
  found: TurnEvidence,
  verdict: 'pass' | 'fail',
  items: { kind: 'command' | 'file'; ref: string }[],
): NonNullable<StepRun['verdict']>['evidence'] {
  const ran = `This turn ran: ${found.commands.map((command) => command.text).join('; ')}`;
  const evidence = items.map((item) => {
    if (item.kind === 'file')
      return { ...item, checked: found.files.includes(path.normalize(item.ref)) };
    const ref = collapsed(item.ref),
      match = found.commands.findLast(
        (command) => command.text === ref || (ref.length >= 8 && command.text.includes(ref)),
      );
    requireThat(
      match || !found.commands.length,
      'invalid_input',
      `evidence: “${item.ref}” is no command this turn ran. ${ran}`,
    );
    return {
      ...item,
      checked: match !== undefined,
      ...(match?.exit_code === undefined ? {} : { exit_code: match.exit_code }),
    };
  });
  requireThat(
    verdict === 'fail' || !found.commands.length || evidence.some((item) => item.checked),
    'invalid_input',
    `evidence: a pass needs a command this turn ran or a file it changed. ${ran}`,
  );
  return evidence;
}
