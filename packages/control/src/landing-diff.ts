import {
  DomainError,
  requireThat,
  type Principal,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import type { DiffHunk, LandingDiff, LandingDiffFile } from '@pantheon/protocol';
import type { ControlContext } from './context.js';
import { PATCH_BOUND, TIME_BOUND, checkedSource } from './source-git.js';
import { runGit, type GitResult } from './git.js';

// Lockfiles are not here: a lockfile change can change what gets installed.
const GENERATED = [/(^|\/)dist\//, /\.min\.(js|css)$/];
// Files where indentation or tabs carry meaning.
const WHITESPACE_SENSITIVE = /(^|\/)((GNU)?[Mm]akefile|[^/]*\.(py|ya?ml|mk|sh|bash|zsh))$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function changed(hunk: DiffHunk, sign: '+' | '-'): string[] {
  return hunk.text
    .split('\n')
    .filter((line) => line.startsWith(sign))
    .map((line) => line.slice(1));
}

function markNoise(files: LandingDiffFile[], hunks: DiffHunk[]) {
  const built = files.filter((file) => GENERATED.some((rule) => rule.test(file.path)));
  // Committed build output that changes alone is the change itself.
  const generated = new Set(built.length < files.length ? built.map((f) => f.path) : []);
  const sides = hunks.map((hunk) => {
    const strict = WHITESPACE_SENSITIVE.test(hunk.file);
    const lines = (sign: '+' | '-') =>
      changed(hunk, sign).map((line) => (strict ? line : line.trim()));
    return { strict, added: lines('+'), removed: lines('-') };
  });
  // Only indentation and blank lines: a split or joined line, or space inside one, can change what runs.
  const words = (lines: string[]) => lines.filter((line) => line !== '').join('\n');
  // Blocks that only depart, outside generated files, by their joined lines in hunk order.
  const departing = new Map<string, number[]>();
  sides.forEach((side, index) => {
    if (side.added.length > 0 || generated.has(hunks[index]!.file)) return;
    const key = side.removed.join('\n');
    const same = departing.get(key);
    if (same) same.push(index);
    else departing.set(key, [index]);
  });
  const moving = new Set<number>();
  hunks.forEach((hunk, index) => {
    const { strict, added, removed } = sides[index]!;
    if (generated.has(hunk.file)) hunk.noise = 'generated';
    else if (!strict && added.length + removed.length > 0 && words(added) === words(removed))
      hunk.noise = 'whitespace';
    else if (added.length > 0 && removed.length === 0) {
      // Pairs each arriving block with one unpaired departing block of the same lines in order.
      const from = departing.get(added.join('\n'))?.find((other) => !moving.has(other));
      if (from !== undefined && added.filter((line) => line.trim() !== '').length >= 3) {
        moving.add(from).add(index);
        hunk.noise = 'moved';
        hunks[from]!.noise = 'moved';
      }
    }
  });
}

function failed(): never {
  throw new DomainError('workspace_read_failed', 'Landing diff failed or exceeded its time bound');
}

export interface DiffRange {
  source: string;
  from_sha: string;
  to_sha: string;
}

function diffRange(range: DiffRange): string[] {
  return ['--no-ext-diff', '--no-textconv', '--find-renames', range.from_sha, range.to_sha, '--'];
}

// --raw gives each file's status; -z keeps paths unquoted. Both lists come in patch order, then a
// NUL and the patch, with no color and fixed prefixes whatever color.ui, diff.noprefix or
// diff.mnemonicPrefix the project sets.
const LISTING = [
  'diff',
  '--raw',
  '--numstat',
  '-z',
  '-p',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/** The listing and the patch of a LISTING run; no patch when the output ends inside the listing. */
function splitListing(output: Buffer): [Buffer, Buffer | undefined] {
  // Neither list has an empty field, so their first empty one is the NUL before the patch.
  const end = output.indexOf('\0\0');
  return end === -1 ? [output, undefined] : [output.subarray(0, end + 1), output.subarray(end + 2)];
}

function landingFiles(listing: string): LandingDiffFile[] {
  const tokens = listing.split('\0');
  const files: LandingDiffFile[] = [];
  let counted = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith(':')) {
      const letter = token.split(' ').at(-1)![0];
      const filePath = tokens[++i]!;
      if (letter === 'R') {
        files.push({
          path: tokens[++i]!,
          old_path: filePath,
          status: 'renamed',
          additions: null,
          deletions: null,
        });
      } else {
        files.push({
          path: filePath,
          status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified',
          additions: null,
          deletions: null,
        });
      }
      continue;
    }
    const [additions, deletions, name] = token.split('\t');
    if (deletions === undefined) continue;
    // A rename leaves the path empty and is followed by the old and the new path.
    if (!name) i += 2;
    const file = files[counted++]!;
    file.additions = additions === '-' ? null : Number(additions);
    file.deletions = deletions === '-' ? null : Number(deletions);
  }
  return files;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** A name as a patch prints it, without the C-style quoting git gives unusual paths. */
function unquoted(name: string): string {
  if (!name.startsWith('"')) return name;
  // Byte by byte: with core.quotePath=false the quoted name keeps raw UTF-8 beside its escapes.
  const quoted = Buffer.from(name.slice(1, -1));
  const bytes: number[] = [];
  for (let i = 0; i < quoted.length; i++) {
    if (quoted[i] !== 0x5c) bytes.push(quoted[i]!);
    else if (/[0-7]/.test(String.fromCharCode(quoted[++i]!))) {
      bytes.push(parseInt(quoted.toString('latin1', i, i + 3), 8));
      i += 2;
    } else bytes.push(ESCAPES[String.fromCharCode(quoted[i]!)] ?? quoted[i]!);
  }
  return Buffer.from(bytes).toString();
}

/** The path of a `--- a/…` or `+++ b/…` patch line, undefined for /dev/null. */
function patchPath(line: string): string | undefined {
  // Git ends a path containing a space with a tab.
  const name = unquoted(line.slice(4).replace(/\t$/, ''));
  return name === '/dev/null' ? undefined : name.slice(2);
}

/** The path of a `diff --git a/… b/…` line, without renames, so both names are the same path. */
export function headerPath(line: string): string {
  const names = line.slice('diff --git '.length);
  const first = names.startsWith('"')
    ? /^"(?:[^"\\]|\\.)*"/.exec(names)![0]
    : names.slice(0, (names.length - 1) / 2);
  return unquoted(first).slice(2);
}

/** A null patch is a truncated one. */
function landingResult(range: DiffRange, listing: string, patch: string | null): LandingDiff {
  const files = landingFiles(listing);
  const paths = new Set(files.map((file) => file.path));
  const truncated = patch === null;
  const hunks: DiffHunk[] = [];
  if (patch !== null) {
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let body: string[] | undefined;
    const bodies: string[][] = [];
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git ')) {
        oldPath = newPath = undefined;
        body = undefined;
        continue;
      }
      if (!body && line.startsWith('--- ')) oldPath = patchPath(line);
      if (!body && line.startsWith('+++ ')) newPath = patchPath(line);
      const header = HUNK_HEADER.exec(line);
      if (header) {
        const name = newPath ?? oldPath;
        bodies.push((body = []));
        hunks.push({
          id: `H${hunks.length + 1}`,
          file: name !== undefined && paths.has(name) ? name : failed(),
          header: line,
          old_start: Number(header[1]),
          old_lines: header[2] === undefined ? 1 : Number(header[2]),
          new_start: Number(header[3]),
          new_lines: header[4] === undefined ? 1 : Number(header[4]),
          text: '',
        });
        continue;
      }
      if (body && /^[ +\-\\]/.test(line)) body.push(line);
    }
    hunks.forEach((hunk, index) => (hunk.text = bodies[index]!.join('\n')));
    markNoise(files, hunks);
  }
  return {
    source: range.source,
    from_sha: range.from_sha,
    to_sha: range.to_sha,
    files,
    hunks,
    truncated,
  };
}

// runGit's synchronous bounds: spawnSync's output buffer and its default time limit.
const SYNC_BOUND = { max_buffer: 64 * 1024 * 1024, timeout_ms: 120000 };

/** rangeDiff with the bounds of a synchronous runGit: output past them fails the read. */
export async function rangeDiffWithSyncBounds(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  range: DiffRange,
): Promise<LandingDiff> {
  const source = checkedSource(ctx, principal, projectId, range.source);
  // Each part keeps the bound it had as a run of its own.
  const diff = await runGit(source, [...LISTING, ...diffRange(range)], undefined, true, {
    max_buffer: 2 * SYNC_BOUND.max_buffer + 1,
    timeout_ms: SYNC_BOUND.timeout_ms,
  });
  if (diff.exit_code !== 0) failed();
  const [listing, patch = Buffer.alloc(0)] = splitListing(diff.stdout);
  if (listing.length > SYNC_BOUND.max_buffer || patch.length > SYNC_BOUND.max_buffer) failed();
  return landingResult(
    range,
    listing.toString(),
    patch.length > PATCH_BOUND ? null : patch.toString(),
  );
}

/** The committed change from_sha..to_sha in a project source, split into numbered hunks. */
export async function rangeDiff(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  range: DiffRange,
): Promise<LandingDiff> {
  const source = checkedSource(ctx, principal, projectId, range.source);
  const diff = await runGit(source, [...LISTING, ...diffRange(range)], undefined, true, {
    max_buffer: 4 * PATCH_BOUND + 1 + PATCH_BOUND,
    timeout_ms: TIME_BOUND,
  });
  // Output past the bound keeps its start, so a whole listing still comes with a truncated patch.
  const overflowed =
    diff.exit_code !== 0 && /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/.test(diff.error ?? '');
  if (diff.exit_code !== 0 && !overflowed) failed();
  const [listing, patch] = splitListing(diff.stdout);
  if (listing.length > 4 * PATCH_BOUND || (overflowed && !patch)) failed();
  return landingResult(
    range,
    listing.toString(),
    overflowed || (patch && patch.length > PATCH_BOUND) ? null : (patch ?? '').toString(),
  );
}

const HEAD_COMMIT = ['rev-parse', '--verify', 'HEAD^{commit}'];

/** A merged session's recorded range, else the worktree whose HEAD ends the range. */
function rangeStart(ctx: ControlContext, session: Session): DiffRange | Workspace {
  requireThat(session.workspace_id, 'invalid_state', 'Session has no worktree');
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id);
  requireThat(
    workspace.kind === 'linked_worktree' || session.in_place?.base_sha,
    'invalid_state',
    'Session works in the user folder and has no committed range',
  );
  if (session.outcome === 'merged') {
    const merged = ctx.store
      .kindEvents(session.project_id, ['session.merged'])
      .findLast((event) => event.aggregate_id === session.id)?.payload as
      { from_sha?: string; to_sha?: string } | undefined;
    if (!merged?.from_sha || !merged.to_sha)
      throw new DomainError('landing_unavailable', 'Session merge recorded no commits');
    return { source: workspace.source!, from_sha: merged.from_sha, to_sha: merged.to_sha };
  }
  if (workspace.kind === 'in_place') return { ...workspace, base_sha: session.in_place!.base_sha };
  if (!workspace.base_sha)
    throw new DomainError('diff_base_missing', 'Worktree has no base commit');
  return workspace;
}

function headRange(workspace: Workspace, head: GitResult): DiffRange {
  if (head.exit_code !== 0)
    throw new DomainError(
      'workspace_unavailable',
      'Workspace directory is missing or not a Git repository',
    );
  return {
    source: workspace.source!,
    from_sha: workspace.base_sha!,
    to_sha: head.stdout.toString().trim(),
  };
}

/**
 * A workbench session's committed range: its recorded merge once merged, else its base commit to
 * its worktree HEAD; heads keeps each worktree's HEAD read for one request.
 */
export async function sessionRangeAsync(
  ctx: ControlContext,
  session: Session,
  heads = new Map<string, Promise<GitResult>>(),
): Promise<DiffRange> {
  const start = rangeStart(ctx, session);
  if ('from_sha' in start) return start;
  let head = heads.get(start.path);
  if (!head) heads.set(start.path, (head = runGit(start.path, HEAD_COMMIT, undefined, true)));
  return headRange(start, await head);
}

/** A workbench session's goal: its title and the start of its first turn's input. */
export function sessionGoal(ctx: ControlContext, session: Session): string {
  const first = ctx.store
    .list<SessionTurn>('session_turns')
    .find((turn) => turn.session_id === session.id);
  return `${session.title ?? ''}\n${(first?.input ?? '').slice(0, 2000)}`;
}
