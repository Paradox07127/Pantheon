import { t } from '../../i18n';

/**
 * A command the project runs, in order, before a session merges; absent enabled runs it, and a
 * skippable one that fails is recorded as skipped.
 */
export type GateCommand = {
  name: string;
  argv: string[];
  timeout_ms?: number;
  enabled?: boolean;
  skippable?: boolean;
};

/** One editable row: the command line as typed, the timeout in seconds as typed. */
export type GateRow = {
  id: number;
  name: string;
  line: string;
  timeout: string;
  enabled: boolean;
  skippable: boolean;
};

export type RowCheck = { argv: string[] | null; errors: string[] };

export type GateCheck = {
  rows: RowCheck[];
  status: 'invalid' | 'unchanged' | 'ready';
  commands: GateCommand[] | null;
};

/** Seconds the landing step waits for a command without a timeout. */
export const DEFAULT_TIMEOUT_SECONDS = 1200;
const MAX_TIMEOUT_MS = 2147483647;
const MAX_TEXT_LENGTH = 65536;

/** The saved gate of one project folder. */
export const savedGate = (
  project: { gates?: Record<string, GateCommand[]> },
  root: string,
): GateCommand[] => project.gates?.[root] ?? [];

/**
 * Whether the folder is known to be a git folder: it has a saved gate, or the newest baseline found
 * gate commands there. False means unknown, not "not git".
 */
export const knownGitFolder = (
  project: { gates?: Record<string, GateCommand[]> },
  baseline: { result?: { folders: { root: string; gate: unknown[] }[] } } | null,
  root: string,
): boolean =>
  project.gates?.[root] !== undefined ||
  (baseline?.result?.folders ?? []).some((f) => f.root === root && f.gate.length > 0);

/**
 * Splits a line into argv without a shell: whitespace separates words, single quotes keep text
 * as written, double quotes read only \" and \\, a backslash outside quotes takes the next
 * character literally. Every other character is an ordinary one.
 */
export function splitArgv(
  line: string,
): { ok: true; argv: string[] } | { ok: false; error: string } {
  const argv: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (/\s/.test(c)) {
      if (word !== null) argv.push(word);
      word = null;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0)
        return {
          ok: false,
          error: t({ id: 'settings.gate.unclosedSingle', defaultMessage: 'Unclosed single quote' }),
        };
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word ??= '';
      for (i++; ; i++) {
        if (i >= line.length)
          return {
            ok: false,
            error: t({
              id: 'settings.gate.unclosedDouble',
              defaultMessage: 'Unclosed double quote',
            }),
          };
        const d = line[i]!;
        if (d === '"') break;
        if (d === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) word += line[++i]!;
        else word += d;
      }
    } else if (c === '\\' && i + 1 < line.length) {
      word = (word ?? '') + line[++i]!;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) argv.push(word);
  return { ok: true, argv };
}

/** A line that splitArgv turns back into argv. */
export const joinArgv = (argv: readonly string[]): string =>
  argv.map((a) => (/^[^\s'"\\]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ');

/** Rows of the saved gate; row i keeps the key ids[i], so rows shown before keep their elements. */
export const rowsOf = (gate: readonly GateCommand[], ids: readonly number[] = []): GateRow[] => {
  const next = Math.max(-1, ...ids) + 1;
  return gate.map((c, i) => ({
    id: ids[i] ?? next + i - ids.length,
    name: c.name,
    line: joinArgv(c.argv),
    timeout: c.timeout_ms === undefined ? '' : String(c.timeout_ms / 1000),
    enabled: c.enabled !== false,
    skippable: c.skippable === true,
  }));
};

export const addRow = (rows: readonly GateRow[]): GateRow[] => [
  ...rows,
  {
    id: Math.max(-1, ...rows.map((r) => r.id)) + 1,
    name: '',
    line: '',
    timeout: '',
    enabled: true,
    skippable: false,
  },
];

export const removeRow = (rows: readonly GateRow[], index: number): GateRow[] =>
  rows.filter((_, i) => i !== index);

/** Swaps a row with its neighbour; past either end the rows come back unchanged. */
export function moveRow(rows: GateRow[], index: number, by: -1 | 1): GateRow[] {
  const to = index + by;
  if (to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** Takes the row at from out and puts it in at index to; the same index gives the rows back unchanged. */
export function placeRow(rows: GateRow[], from: number, to: number): GateRow[] {
  if (from === to || from < 0 || from >= rows.length || to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}

/** One recorded gate run as project.gates.history returns it. */
export type GateRun = {
  results: { name: string; command: string[]; duration_ms?: number; skipped?: boolean }[];
};

/** Milliseconds the command took in the newest run (runs come newest first) that ran it; null when none did. */
export function lastDuration(command: GateCommand, runs: readonly GateRun[]): number | null {
  for (const run of runs)
    for (const r of run.results)
      if (
        !r.skipped &&
        r.duration_ms !== undefined &&
        r.name === command.name &&
        r.command.length === command.argv.length &&
        r.command.every((arg, i) => arg === command.argv[i])
      )
        return r.duration_ms;
  return null;
}

function checkRow(row: GateRow): { check: RowCheck; command: GateCommand | null } {
  const errors: string[] = [];
  const name = row.name.trim();
  if (!name) errors.push(t({ id: 'settings.gate.nameEmpty', defaultMessage: 'Name is empty' }));
  else if (name.length > MAX_TEXT_LENGTH)
    errors.push(
      t(
        { id: 'settings.gate.nameTooLong', defaultMessage: 'Name is longer than {max} characters' },
        { max: MAX_TEXT_LENGTH },
      ),
    );
  const split = splitArgv(row.line);
  const argv = split.ok ? split.argv : null;
  if (!split.ok) errors.push(split.error);
  else if (split.argv.length === 0)
    errors.push(t({ id: 'settings.gate.lineEmpty', defaultMessage: 'Command line is empty' }));
  else if (split.argv.some((a) => a === ''))
    errors.push(
      t({
        id: 'settings.gate.emptyArgument',
        defaultMessage: 'Command line has an empty argument',
      }),
    );
  else if (split.argv.some((a) => a.includes('\0')))
    errors.push(
      t({ id: 'settings.gate.nulCharacter', defaultMessage: 'Command line has a NUL character' }),
    );
  else if (split.argv.some((a) => a.length > MAX_TEXT_LENGTH))
    errors.push(
      t(
        {
          id: 'settings.gate.argumentTooLong',
          defaultMessage: 'An argument is longer than {max} characters',
        },
        { max: MAX_TEXT_LENGTH },
      ),
    );
  const timeout = row.timeout.trim();
  // Saved timeouts are whole milliseconds, so seconds keep up to three decimals.
  const ms = Math.round(Number(timeout) * 1000);
  const timed = timeout !== '';
  if (timed && !(/^\d+(\.\d{1,3})?$/.test(timeout) && ms > 0 && ms <= MAX_TIMEOUT_MS))
    errors.push(
      t(
        {
          id: 'settings.gate.timeoutRange',
          defaultMessage: 'Timeout must be 0.001 to {max} seconds, with at most three decimals',
        },
        { max: MAX_TIMEOUT_MS / 1000 },
      ),
    );
  const check = { argv, errors };
  if (errors.length > 0 || !argv) return { check, command: null };
  return {
    check,
    command: {
      ...(timed ? { name, argv, timeout_ms: ms } : { name, argv }),
      // The defaults stay unwritten, so a gate saved without them reads back unchanged.
      ...(row.enabled ? {} : { enabled: false }),
      ...(row.skippable ? { skippable: true } : {}),
    },
  };
}

const sameCommand = (a: GateCommand, b: GateCommand) =>
  a.name === b.name &&
  a.timeout_ms === b.timeout_ms &&
  (a.enabled !== false) === (b.enabled !== false) &&
  !!a.skippable === !!b.skippable &&
  a.argv.length === b.argv.length &&
  a.argv.every((arg, i) => arg === b.argv[i]);

/** Checks each row and compares the draft with the saved gate, order included. */
export function checkGate(saved: readonly GateCommand[], rows: readonly GateRow[]): GateCheck {
  const checked = rows.map(checkRow);
  const commands = checked.map((c) => c.command);
  const valid = commands.every((c) => c !== null);
  const status = !valid
    ? 'invalid'
    : commands.length === saved.length && commands.every((c, i) => sameCommand(c, saved[i]!))
      ? 'unchanged'
      : 'ready';
  return { rows: checked.map((c) => c.check), status, commands: valid ? commands : null };
}

/** project.gate.set of one folder's protected paths at the project's revision, with its saved commands. */
export const protectedPathsRequest = (
  project: { id: string; revision: number; gates?: Record<string, GateCommand[]> },
  root: string,
  protected_paths: string[],
) => ({
  type: 'project.gate.set' as const,
  input: { project_id: project.id, root, commands: savedGate(project, root), protected_paths },
  expected_revision: project.revision,
});

/** project.gate.set for one folder at the project's revision; an empty list clears it. */
export const gateSetRequest = (
  project: { id: string; revision: number },
  root: string,
  commands: GateCommand[],
) => ({
  type: 'project.gate.set' as const,
  input: { project_id: project.id, root, commands },
  expected_revision: project.revision,
});
