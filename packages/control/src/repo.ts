import {
  requireThat,
  type Event,
  type LandingItem,
  type Principal,
  type Project,
  type ProjectBaseline,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import { existsSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  LandingDiff,
  RepoBlame,
  RepoCommit,
  RepoCommitAfter,
  RepoCompare,
  RepoConflict,
  RepoFileHistory,
  RepoLane,
  RepoLog,
  RepoStatus,
  RepoStatusFile,
  RepoTimeline,
  RepoWorktree,
} from '@pantheon/protocol';
import { CHECKPOINTS } from './checkpoint.js';
import { projectAccess, resolvedPath, userOnly, type ControlContext } from './context.js';
import { runGit, type GitResult } from './git.js';
import { gateFailed } from './landing.js';
import { rangeDiff } from './landing-diff.js';
import { mergeBase, mergePreview } from './merge-preview.js';
import { PATCH_BOUND, TIME_BOUND } from './source-git.js';

export const BOUND = { max_buffer: 4 * PATCH_BOUND, timeout_ms: TIME_BOUND };
// Each untracked file, not its folder, whatever the repository's status.showUntrackedFiles says.
const STATUS = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'];
// Paths name files, never pathspec patterns.
const LITERAL = '--literal-pathspecs';
// The repository's log.showSignature would mix the signature check's output into parsed logs.
const UNSIGNED = '--no-show-signature';

export async function git(cwd: string, args: string[], bound = BOUND): Promise<string> {
  const result = await runGit(cwd, args, undefined, true, bound);
  requireThat(
    result.exit_code === 0,
    'workspace_read_failed',
    result.error ?? result.stderr.toString(),
  );
  return result.stdout.toString();
}

/** Outputs kept by root and arguments, oldest use first; bounded by entries and by characters. */
const settled = new Map<string, { output: Promise<string>; chars: number }>();
const SETTLED_ENTRIES = 10000,
  SETTLED_CHARS = 32 * 1024 * 1024;
let settledChars = 0;

function evictSettled() {
  for (const [key, entry] of settled) {
    if (settled.size <= SETTLED_ENTRIES && settledChars <= SETTLED_CHARS) return;
    settled.delete(key);
    settledChars -= entry.chars;
  }
}

/**
 * git's output for commit-graph commands (rev-list, merge-base) that name commits only by full sha,
 * kept for later calls: commits never change, so no write makes it stale. blame and diff read the
 * repository's config and attribute files, so they are not kept. A failed run is not kept.
 */
function settledGit(root: string, args: string[]): Promise<string> {
  const key = `${root}\0${args.join('\0')}`,
    cached = settled.get(key);
  if (cached) {
    settled.delete(key);
    settled.set(key, cached);
    return cached.output;
  }
  const entry = { output: git(root, args), chars: 0 };
  settled.set(key, entry);
  entry.output.then(
    (output) => {
      if (settled.get(key) !== entry) return;
      entry.chars = output.length;
      settledChars += output.length;
      evictSettled();
    },
    () => {
      if (settled.get(key) === entry) settled.delete(key);
    },
  );
  evictSettled();
  return entry.output;
}

export function projectRoot(ctx: ControlContext, p: Principal, projectId: string): string {
  // Repository views read the project's checkout and every worktree, not one session's.
  userOnly(p);
  projectAccess(ctx, p, projectId, 'project.read');
  return ctx.store.must<Project>('projects', projectId).roots[0]!;
}

/** The full sha of the commit a revision names. */
export async function commitOf(root: string, revision: string): Promise<string> {
  // Git would read a leading '-' as an option.
  requireThat(!revision.startsWith('-'), 'invalid_input', 'Revision must not start with -');
  const result = await runGit(
    root,
    ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`],
    undefined,
    true,
    BOUND,
  );
  const replaced = 'sandbox_path_replaced: ';
  requireThat(
    !result.error?.startsWith(replaced),
    'sandbox_path_replaced',
    result.error?.slice(replaced.length) ?? '',
  );
  requireThat(result.exit_code === 0, 'invalid_input', `Not a commit: ${revision}`);
  return result.stdout.toString().trim();
}

/** The repository's empty tree, the starting point of a root commit's diff; its name depends on the object format. */
async function emptyTree(root: string): Promise<string> {
  return (await git(root, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

/** The repository's worktrees that exist on disk, the main one first. */
export async function listedWorktrees(
  root: string,
): Promise<{ path: string; head_sha: string; branch: string | null }[]> {
  const listed: { path: string; head_sha: string; branch: string | null; gone?: boolean }[] = [];
  for (const line of (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0')) {
    if (line.startsWith('worktree '))
      listed.push({
        path: resolvedPath(line.slice('worktree '.length)),
        head_sha: '',
        branch: null,
      });
    const current = listed.at(-1);
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head_sha = line.slice('HEAD '.length);
    else if (line.startsWith('branch '))
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    // A bare repository has no files; a prunable worktree's folder is gone.
    else if (line === 'bare' || line.startsWith('prunable')) current.gone = true;
  }
  // A locked worktree is never prunable, even with its folder gone.
  return listed.filter((worktree) => !worktree.gone && existsSync(worktree.path));
}

function parsedStatus(output: string): Omit<RepoStatus, 'path'> {
  const records = output.split('\0');
  const files: RepoStatusFile[] = [];
  let branch: string | null = null,
    head_sha = '',
    upstream: string | undefined,
    counts: { ahead: number; behind: number } | undefined;
  const side = (letter: string) => (letter === '.' ? null : letter);
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith('# branch.oid ')) head_sha = record.slice('# branch.oid '.length);
    else if (record.startsWith('# branch.head ')) {
      const name = record.slice('# branch.head '.length);
      branch = name === '(detached)' ? null : name;
    } else if (record.startsWith('# branch.upstream '))
      upstream = record.slice('# branch.upstream '.length);
    else if (record.startsWith('# branch.ab ')) {
      const [, , ahead, behind] = record.split(' ');
      counts = { ahead: Number(ahead), behind: -Number(behind) };
    } else if (record.startsWith('? '))
      files.push({
        path: record.slice(2),
        index: null,
        worktree: null,
        untracked: true,
        conflicted: false,
      });
    else if (/^[12u] /.test(record)) {
      // Ordinary, renamed and unmerged entries carry 8, 9 and 10 fields before the path.
      const fields = record.split(' '),
        kind = record[0]!,
        xy = fields[1]!;
      files.push({
        path: fields.slice(kind === '1' ? 8 : kind === '2' ? 9 : 10).join(' '),
        ...(kind === '2' ? { old_path: records[++index]! } : {}),
        index: side(xy[0]!),
        worktree: side(xy[1]!),
        untracked: false,
        conflicted: kind === 'u',
      });
    }
  }
  return {
    branch,
    head_sha,
    ...(upstream !== undefined && counts ? { upstream: { name: upstream, ...counts } } : {}),
    files,
  };
}

/** Commits in left...right: those only left has, then those only right has. */
const FULL_SHA = /^[0-9a-f]{40}$/;

async function sides(root: string, left: string, right: string): Promise<[number, number]> {
  // Only commits named by full sha keep their answer; a ref such as @{u} moves.
  const run = FULL_SHA.test(left) && FULL_SHA.test(right) ? settledGit : git;
  const counted = await run(root, [
    'rev-list',
    '--left-right',
    '--count',
    `${left}...${right}`,
    '--',
  ]);
  const [onlyLeft, onlyRight] = counted.trim().split('\t').map(Number);
  return [onlyLeft!, onlyRight!];
}

/** The tree and conflicting files of a merge preview; undefined when this git has no merge preview. */
function previewed(merge: GitResult): { tree: string; files: string[] } | undefined {
  // 129: this git has no merge preview.
  if (merge.exit_code === 129) return undefined;
  requireThat(
    merge.exit_code === 0 || merge.exit_code === 1,
    'workspace_read_failed',
    'Merge conflicts could not be read',
  );
  const [tree, ...files] = merge.stdout.toString().split('\0\0')[0]!.split('\0');
  return { tree: tree!, files: merge.exit_code === 0 ? [] : files.filter(Boolean) };
}

type MergeCounts = Pick<RepoWorktree, 'additions' | 'deletions' | 'conflicts'>;
/** By worktree path, for the HEAD and first folder HEAD in key. */
const worktreeMerges = new Map<string, { key: string; value: MergeCounts }>();

/** The diff stat of head from its merge base with target, and the files merging it into target would conflict on. */
async function mergeCounts(
  root: string,
  path: string,
  target: string,
  head: string,
  ahead: number,
): Promise<MergeCounts> {
  const key = `${head} ${target}`,
    cached = worktreeMerges.get(path);
  if (cached?.key === key) return cached.value;
  const base = await mergeBase(root, target, head);
  const [stat, merge] = await Promise.all([
    git(root, ['diff', '--numstat', base ?? target, head, '--']),
    // Nothing to merge cannot conflict; histories with no common commit are not merged.
    base && ahead ? mergePreview(root, target, head, true) : undefined,
  ]);
  let additions = 0,
    deletions = 0;
  for (const line of stat.split('\n')) {
    // A binary file counts - for both.
    const [added, removed] = line.split('\t');
    additions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }
  const conflicts = !base ? undefined : merge ? previewed(merge)?.files.length : 0;
  const value = { additions, deletions, ...(conflicts !== undefined ? { conflicts } : {}) };
  worktreeMerges.set(path, { key, value });
  return value;
}

export async function repoWorktrees(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): Promise<RepoWorktree[]> {
  const root = projectRoot(ctx, p, projectId);
  const listed = await listedWorktrees(root);
  const rootHead = listed.find((worktree) => worktree.path === root)?.head_sha;
  requireThat(rootHead, 'invalid_project', 'Project folder is not a worktree of its repository');
  const workspaces = ctx.store
    .list<Workspace>('workspaces')
    .filter((workspace) => workspace.project_id === projectId && !workspace.removed_at);
  const sessions = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.project_id === projectId);
  return Promise.all(
    listed.map(async (worktree): Promise<RepoWorktree> => {
      const [[behind, ahead], status] = await Promise.all([
        sides(root, rootHead, worktree.head_sha),
        git(worktree.path, STATUS),
      ]);
      const counts = await mergeCounts(root, worktree.path, rootHead, worktree.head_sha, ahead);
      const workspace = workspaces.find((candidate) => candidate.path === worktree.path),
        session =
          workspace && sessions.find((candidate) => candidate.workspace_id === workspace.id);
      return {
        path: worktree.path,
        branch: worktree.branch,
        head_sha: worktree.head_sha,
        kind: worktree.path === root ? 'checkout' : session ? 'session' : 'external',
        ...(worktree.path !== root && session ? { session_id: session.id } : {}),
        ahead,
        behind,
        uncommitted: parsedStatus(status).files.length,
        ...counts,
      };
    }),
  );
}

export async function repoStatus(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  target: string,
): Promise<RepoStatus> {
  const root = projectRoot(ctx, p, projectId);
  const worktree = resolvedPath(target);
  requireThat(
    (await listedWorktrees(root)).some((listed) => listed.path === worktree),
    'scope_violation',
    'Path is not a worktree of the project',
  );
  return { path: worktree, ...parsedStatus(await git(worktree, STATUS)) };
}

/** By project root, for the project and the merges recorded when it was built; commits never change. */
const attributions = new Map<string, { key: string; sessions: Promise<Map<string, string>> }>();

/** By commit, the session whose recorded merge landed it, the newest such merge winning. */
function mergingSessions(
  ctx: ControlContext,
  projectId: string,
  root: string,
): Promise<Map<string, string>> {
  const merges = ctx.store.kindEvents(projectId, ['session.merged']);
  const key = `${projectId} ${merges.length} ${merges.at(-1)?.sequence}`,
    cached = attributions.get(root);
  if (cached?.key === key) return cached.sessions;
  const entry = { key, sessions: attributedCommits(root, merges) };
  attributions.set(root, entry);
  entry.sessions.catch(() => {
    if (attributions.get(root) === entry) attributions.delete(root);
  });
  return entry.sessions;
}

async function attributedCommits(root: string, merges: Event[]): Promise<Map<string, string>> {
  const ranges = merges.flatMap((event) => {
    const { from_sha, to_sha } = event.payload as { from_sha?: string; to_sha?: string };
    return from_sha && to_sha ? [{ from_sha, to_sha, session: event.aggregate_id }] : [];
  });
  const found = new Map<string, string>();
  if (!ranges.length) return found;
  // Commits every merge's from_sha reaches are in no range, so the graph stops at a common one.
  // Newest first, each step of the octopus walks only from one from_sha to the next.
  const froms = [...new Set(ranges.map((range) => range.from_sha).reverse())];
  const common = await runGit(root, ['merge-base', '--octopus', ...froms], undefined, true, BOUND);
  // A failure, as for a missing commit, leaves the whole history in the graph.
  const base = common.exit_code === 0 ? common.stdout.toString().trim() || undefined : undefined;
  const tips = [...new Set(ranges.flatMap((range) => [range.to_sha, range.from_sha]))];
  const listed = await runGit(
    root,
    ['rev-list', '--topo-order', '--parents', '--ignore-missing', '--stdin'],
    Buffer.from([...tips, ...(base ? [`^${base}`] : [])].join('\n') + '\n'),
    true,
    HISTORY_BOUND,
  );
  requireThat(
    listed.exit_code === 0,
    'workspace_read_failed',
    listed.error ?? listed.stderr.toString(),
  );
  const lines = listed.stdout
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '));
  // Topological order lists every commit before its parents.
  const order = lines.map(([sha]) => sha!);
  const position = new Map(order.map((sha, index) => [sha, index]));
  const parents = lines.map(([, ...shas]) => shas.flatMap((sha) => position.get(sha) ?? []));
  // 1: reached from to_sha; 2: reached from from_sha. A commit only to_sha reaches is in the range.
  const flags = new Uint8Array(order.length);
  for (const range of ranges.reverse()) {
    const to = position.get(range.to_sha),
      from = position.get(range.from_sha);
    // Outside the graph, a to_sha is missing or its range empty; a from_sha is missing unless it is the common commit.
    if (to === undefined || (from === undefined && range.from_sha !== base)) continue;
    const touched = [to];
    flags[to] = 1;
    if (from !== undefined) {
      touched.push(from);
      flags[from] = flags[from]! | 2;
    }
    // Commits flagged 1 that the scan has yet to reach; each commit's flags are final once it does.
    let open = flags[to] === 1 ? 1 : 0;
    for (let at = Math.min(to, from ?? to); open > 0; at++) {
      const flag = flags[at]!;
      if (!flag) continue;
      if (flag === 1) {
        open--;
        if (!found.has(order[at]!)) found.set(order[at]!, range.session);
      }
      for (const parent of parents[at]!) {
        const before = flags[parent]!,
          after = before | flag;
        if (after === before) continue;
        if (!before) touched.push(parent);
        flags[parent] = after;
        if (after === 1) open++;
        else if (before === 1) open--;
      }
    }
    for (const at of touched) flags[at] = 0;
  }
  return found;
}

/**
 * The records of `git log -z` whose format is `count` fields each after a %x00, with the names
 * --name-only lists. Only NUL frames them: messages and names may hold any other byte.
 */
function loggedFields(output: string, count: number): { fields: string[]; names: string[] }[] {
  const tokens = output.split('\0'),
    records: { fields: string[]; names: string[] }[] = [];
  // Each record opens with an empty token; names are never empty, so the next one ends them.
  for (let at = 0; at + count < tokens.length;) {
    const fields = tokens.slice(at + 1, at + 1 + count),
      names: string[] = [];
    // A newline precedes the first name.
    for (at += 1 + count; at < tokens.length && tokens[at] !== ''; at++)
      names.push(names.length ? tokens[at]! : tokens[at]!.slice(1));
    records.push({ fields, names });
  }
  return records;
}

const LOG_FORMAT = '--format=%x00%H%x00%P%x00%D%x00%an%x00%ae%x00%ct%x00%s%x00%b',
  LOG_FIELDS = 8;

/** The fields of one record of git log in LOG_FORMAT. */
function loggedCommit(fields: string[]): RepoCommit {
  const [sha, parents, refs, author, email, time, subject, body] = fields;
  return {
    sha: sha!,
    parents: parents!.split(' ').filter(Boolean),
    refs: refs!.split(', ').filter(Boolean),
    author: author!,
    author_email: email!,
    committed_at: Number(time) * 1000,
    subject: subject ?? '',
    body: (body ?? '').trim(),
  };
}

export async function repoLog(
  ctx: ControlContext,
  p: Principal,
  input: { project_id: string; ref?: string; limit: number; skip: number },
): Promise<RepoLog> {
  const root = projectRoot(ctx, p, input.project_id);
  const start = await commitOf(root, input.ref ?? 'HEAD');
  const lines = loggedFields(
    await git(root, [
      'log',
      '-z',
      UNSIGNED,
      `--max-count=${input.limit + 1}`,
      `--skip=${input.skip}`,
      LOG_FORMAT,
      start,
      '--',
    ]),
    LOG_FIELDS,
  );
  const commits = lines.slice(0, input.limit).map((line) => loggedCommit(line.fields));
  const sessions = await mergingSessions(ctx, input.project_id, root);
  return {
    commits: commits.map((commit) => {
      const session = sessions.get(commit.sha);
      return session ? { ...commit, session_id: session } : commit;
    }),
    has_more: lines.length > input.limit,
  };
}

/** The change one commit made against its first parent. */
export async function repoCommitDiff(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  sha: string,
): Promise<LandingDiff> {
  const root = projectRoot(ctx, p, projectId);
  const commit = await commitOf(root, sha);
  const [, parent] = (await git(root, ['rev-list', '--parents', '--max-count=1', commit, '--']))
    .trim()
    .split(' ');
  return rangeDiff(ctx, p, projectId, {
    source: root,
    from_sha: parent ?? (await emptyTree(root)),
    to_sha: commit,
  });
}

export async function repoCompare(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  base: string,
  head: string,
): Promise<RepoCompare> {
  const root = projectRoot(ctx, p, projectId);
  const [baseSha, headSha, rootHead] = await Promise.all([
    commitOf(root, base),
    commitOf(root, head),
    commitOf(root, 'HEAD'),
  ]);
  const previewed_at = ctx.store.now();
  const common = await mergeBase(root, baseSha, headSha);
  const [[behind, ahead], merge, listed] = await Promise.all([
    sides(root, baseSha, headSha),
    common && mergePreview(root, baseSha, headSha, true),
    listedWorktrees(root),
  ]);
  const preview = merge && previewed(merge);
  const [diff, conflicts, others] = await Promise.all([
    rangeDiff(ctx, p, projectId, { source: root, from_sha: common ?? baseSha, to_sha: headSha }),
    preview &&
      Promise.all(
        preview.files.slice(0, 20).map(async (path): Promise<RepoConflict> => {
          const shown = await runGit(
            root,
            ['cat-file', 'blob', `${preview.tree}:${path}`],
            undefined,
            true,
            BOUND,
          );
          return {
            path,
            ...firstConflict(shown.exit_code === 0 ? shown.stdout.toString().split('\n') : []),
          };
        }),
      ),
    Promise.all(
      [...sessionWorktrees(ctx, projectId, root, listed).values()]
        .filter((worktree) => worktree.head_sha !== headSha)
        .map(async (worktree) => {
          const from = (await mergeBase(root, rootHead, worktree.head_sha)) ?? rootHead;
          return git(root, ['diff', '--name-only', '-z', from, worktree.head_sha, '--']);
        }),
    ),
  ]);
  const elsewhere = new Set(others.flatMap((names) => names.split('\0')));
  return {
    ...diff,
    merge_base: common ?? null,
    ahead,
    behind,
    ...(conflicts ? { conflicts, previewed_at } : {}),
    single_owner_files: diff.files.filter((file) => !elsewhere.has(file.path)).length,
  };
}

/** The first conflict in the lines of a merged file. */
function firstConflict(lines: string[]): Omit<RepoConflict, 'path'> {
  const start = lines.findIndex((line) => line.startsWith('<<<<<<<'));
  if (start === -1) return { line: null, base_lines: [], head_lines: [] };
  const middle = lines.findIndex((line, index) => index > start && line.startsWith('=======')),
    end = lines.findIndex((line, index) => index > middle && line.startsWith('>>>>>>>'));
  // The diff3 conflict styles put the merge base's lines between ||||||| and =======.
  const ancestor = lines.findIndex(
    (line, index) => index > start && index < middle && line.startsWith('|||||||'),
  );
  return {
    line: start + 1,
    base_lines: lines.slice(start + 1, ancestor === -1 ? middle : ancestor).slice(0, 5),
    head_lines: lines.slice(middle + 1, end).slice(0, 5),
  };
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** The JSON object of a file at a revision; empty when the file is absent or holds no JSON object. */
async function jsonAt(root: string, revision: string, file: string) {
  const shown = await runGit(
    root,
    ['cat-file', 'blob', `${revision}:${file}`],
    undefined,
    true,
    BOUND,
  );
  if (shown.exit_code !== 0) return {};
  try {
    const parsed: unknown = JSON.parse(shown.stdout.toString());
    return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Where a line of a -U0 diff's old side lands on its new side; a changed line goes to its hunk's first line, or for an end its last. */
function movedLine(shifts: ReturnType<typeof hunks>, line: number, end: boolean): number {
  let shift = 0;
  for (const hunk of shifts) {
    if (hunk.start + Math.max(hunk.count, 1) - 1 < line) shift += hunk.new_count - hunk.count;
    else if (hunk.count > 0 && hunk.start <= line)
      return Math.max(1, hunk.new_start + (end ? Math.max(hunk.new_count, 1) - 1 : 0));
    else break;
  }
  return line + shift;
}

type GateResults = NonNullable<LandingItem['gate_results']>;

export async function repoCommitAfter(
  ctx: ControlContext,
  p: Principal,
  input: { project_id: string; sha: string },
): Promise<RepoCommitAfter> {
  const root = projectRoot(ctx, p, input.project_id);
  const [commit, head] = await Promise.all([commitOf(root, input.sha), commitOf(root, 'HEAD')]);
  const [, parent = await emptyTree(root)] = (
    await git(root, ['rev-list', '--parents', '--max-count=1', commit, '--'])
  )
    .trim()
    .split(' ');

  const merges = ctx.store.kindEvents(input.project_id, ['session.merged']),
    checks = ctx.store.kindEvents(input.project_id, ['session.gate_checked']);
  const merged = (event: Event) => event.payload as { branch?: string; to_sha?: string };
  /** The session's last gate run after its merge before this one. */
  const gateOf = (merge: Event | undefined) => {
    if (!merge) return undefined;
    const since =
      merges.findLast(
        (event) => event.aggregate_id === merge.aggregate_id && event.sequence < merge.sequence,
      )?.sequence ?? 0;
    const checked = checks.findLast(
      (event) =>
        event.aggregate_id === merge.aggregate_id &&
        event.sequence > since &&
        event.sequence < merge.sequence,
    );
    if (!checked) return undefined;
    const { commit: sha, results } = checked.payload as { commit: string; results: GateResults };
    const skipped = results.filter((result) => result.state === 'skipped').length,
      failed = results.filter(gateFailed).length;
    return {
      passed: results.length - skipped - failed,
      failed,
      skipped,
      sha,
      duration_ms: results.reduce((sum, result) => sum + result.duration_ms, 0),
    };
  };
  const merge = merges.findLast((event) => merged(event).to_sha === commit);
  const mergedFrom = (merge?.payload as { from_sha?: string } | undefined)?.from_sha;
  const previous =
    merge &&
    merges.findLast(
      (event) => event.sequence < merge.sequence && merged(event).branch === merged(merge).branch,
    );

  const changed = (
    await git(root, ['diff', '--numstat', '-z', '--no-renames', parent, commit, '--'])
  )
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [added, , file] = record.split('\t');
      return { added: Number(added) || 0, file: file! };
    });
  const manifests = changed.filter(
    ({ file }) => file === 'package.json' || file.endsWith('/package.json'),
  );
  let dependencies = 0;
  for (const { file } of manifests) {
    const [before, after] = await Promise.all([
      jsonAt(root, parent, file),
      jsonAt(root, commit, file),
    ]);
    for (const field of DEPENDENCY_FIELDS) {
      const old = (before[field] ?? {}) as Record<string, unknown>,
        now = (after[field] ?? {}) as Record<string, unknown>;
      for (const name of new Set([...Object.keys(old), ...Object.keys(now)]))
        if (JSON.stringify(old[name]) !== JSON.stringify(now[name])) dependencies++;
    }
  }

  // Line ranges this commit added or changed, as numbered in HEAD.
  const ranges: { file: string; start: number; end: number }[] = [];
  const onHead =
    commit !== head &&
    (await runGit(root, ['merge-base', '--is-ancestor', commit, head], undefined, true, BOUND))
      .exit_code === 0;
  for (const { added, file } of onHead ? changed : []) {
    if (ranges.length >= 20) break;
    if (!added) continue;
    const [own, moved] = await Promise.all([
      git(root, [LITERAL, 'diff', '-U0', parent, commit, '--', file]),
      git(root, [LITERAL, 'diff', '-U0', commit, head, '--', file]),
    ]);
    const shifts = hunks(moved);
    for (const hunk of hunks(own))
      if (hunk.new_count > 0)
        ranges.push({
          file,
          start: movedLine(shifts, hunk.new_start, false),
          end: movedLine(shifts, hunk.new_start + hunk.new_count - 1, true),
        });
  }
  const logged = await Promise.all(
    ranges
      .slice(0, 20)
      .map((range) =>
        runGit(
          root,
          [
            LITERAL,
            'log',
            UNSIGNED,
            '-s',
            '--format=%H%x00%ct%x00%s',
            `-L${range.start},${range.end}:${range.file}`,
            `${commit}..${head}`,
          ],
          undefined,
          true,
          BOUND,
        ),
      ),
  );
  const later = new Map<string, RepoCommitAfter['later'][number]>();
  // A range git cannot trace, as in a file HEAD no longer has, adds nothing.
  for (const result of logged.filter((result) => result.exit_code === 0))
    for (const line of result.stdout.toString().split('\n')) {
      const [sha, time, subject] = line.split('\0');
      if (sha && time) later.set(sha, { sha, at: Number(time) * 1000, subject: subject ?? '' });
    }

  const upstream = await runGit(
    root,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    undefined,
    true,
    BOUND,
  );
  return {
    gate: gateOf(merge) ?? null,
    previous_gate_ms: gateOf(previous)?.duration_ms ?? null,
    dependencies,
    later: [...later.values()].sort((a, b) => b.at - a.at).slice(0, 10),
    upstream:
      upstream.exit_code === 0
        ? {
            name: upstream.stdout.toString().trim(),
            ahead: (await sides(root, '@{u}', head))[1],
          }
        : null,
    session_merge: mergedFrom
      ? { from_sha: mergedFrom, commits: (await sides(root, mergedFrom, commit))[1] }
      : null,
  };
}

const HOUR = 60 * 60 * 1000,
  DAY = 24 * HOUR,
  WEEK = 7 * DAY;
const MAX_BINS = 120,
  MAX_POINTS = 200,
  MAX_LANES = 8;

type Span = RepoLane['spans'][number];
type Gate = RepoLane['gates'][number];
type Turn = NonNullable<RepoLane['turns']>[number];
interface TimelineCommit {
  sha: string;
  at: number;
  kind: 'commit' | 'merge' | 'revert';
  author: string;
  files: string[];
  session_id?: string;
}
interface Draft {
  key: string;
  label: string;
  kind: RepoLane['kind'];
  merged_lanes?: number;
  commits: TimelineCommit[];
  spans: Span[];
  gates: Gate[];
  turns: Turn[];
}
/** A HEAD's whole history: weekly counts and the sessions whose recorded merges landed its commits. */
interface History {
  head: string;
  overview: RepoTimeline['overview'];
  extent: RepoTimeline['extent'];
  sessions: Map<string, string>;
}
/** By project root; rebuilt when that root's HEAD moves, and shared by the calls that start meanwhile. */
const histories = new Map<string, { head: string; history: Promise<History> }>();
// At about 52 bytes a commit, some 1.3 million commits.
const HISTORY_BOUND = { ...BOUND, max_buffer: 64 * 1024 * 1024 };

async function headHistory(ctx: ControlContext, projectId: string, root: string): Promise<History> {
  const head = await commitOf(root, 'HEAD');
  const cached = histories.get(root);
  if (cached?.head === head) return cached.history;
  const entry = { head, history: builtHistory(ctx, projectId, root, head) };
  histories.set(root, entry);
  entry.history.catch(() => {
    if (histories.get(root) === entry) histories.delete(root);
  });
  return entry.history;
}

async function builtHistory(
  ctx: ControlContext,
  projectId: string,
  root: string,
  head: string,
): Promise<History> {
  const commits = (await git(root, ['log', UNSIGNED, '--format=%H %ct', head, '--'], HISTORY_BOUND))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, time] = line.split(' ');
      return { sha: sha!, at: Number(time) * 1000 };
    });
  const sessions = await mergingSessions(ctx, projectId, root);
  const weeks = new Map<number, { agent: number; user: number }>();
  let first = Infinity,
    last = -Infinity,
    oldest = Infinity,
    newest = -Infinity;
  for (const commit of commits) {
    oldest = Math.min(oldest, commit.at);
    newest = Math.max(newest, commit.at);
    const week = Math.floor(commit.at / WEEK) * WEEK;
    first = Math.min(first, week);
    last = Math.max(last, week);
    const counts = weeks.get(week) ?? { agent: 0, user: 0 };
    counts[sessions.has(commit.sha) ? 'agent' : 'user']++;
    weeks.set(week, counts);
  }
  const overview: RepoTimeline['overview'] = [];
  for (let start = first; start <= last; start += WEEK)
    overview.push({ start, ...(weeks.get(start) ?? { agent: 0, user: 0 }) });
  const extent = commits.length ? { first: oldest, last: newest } : null;
  return { head, overview, extent, sessions };
}

/** Commits the revisions reach with a commit time in [from, to), oldest first. */
async function rangeCommits(
  root: string,
  revisions: string[],
  from: number,
  to: number,
  files: boolean,
): Promise<TimelineCommit[]> {
  const output = await git(root, [
    'log',
    '-z',
    UNSIGNED,
    '--format=%x00%H%x00%P%x00%ct%x00%an%x00%s',
    ...(files ? ['--name-only', '--diff-merges=first-parent'] : []),
    // --since stops the walk at an older commit, hiding the commits in range below it.
    `--since-as-filter=@${Math.floor(from / 1000)} +0000`,
    `--until=@${Math.ceil(to / 1000)} +0000`,
    ...revisions,
    '--',
  ]);
  return loggedFields(output, 5)
    .flatMap(({ fields, names }): TimelineCommit[] => {
      const [sha, parents, time, author, subject] = fields;
      const at = Number(time) * 1000;
      if (at < from || at >= to) return [];
      const kind = parents!.includes(' ')
        ? 'merge'
        : subject!.startsWith('Revert "')
          ? 'revert'
          : 'commit';
      return [{ sha: sha!, at, kind, author: author!, files: names }];
    })
    .reverse();
}

/** Turns with a checkpoint ref, at the time they started running. */
async function checkpointTurns(
  ctx: ControlContext,
  projectId: string,
  root: string,
): Promise<Turn[]> {
  const refs = (await git(root, ['for-each-ref', '--format=%(refname)', CHECKPOINTS]))
    .split('\n')
    .filter(Boolean);
  if (!refs.length) return [];
  const started = new Map<string, number>();
  for (const event of ctx.store.kindEvents(projectId, ['turn.queued', 'turn.running']))
    if (event.kind === 'turn.running' || !started.has(event.aggregate_id))
      started.set(event.aggregate_id, event.created_at);
  return refs.flatMap((ref) => {
    const [, session_id, turn_id] = ref.slice(CHECKPOINTS.length + 1).split('/');
    const at = turn_id === undefined ? undefined : started.get(turn_id);
    return session_id && turn_id && at !== undefined ? [{ at, session_id, turn_id }] : [];
  });
}

const gatePassed = (event: Event) =>
  !((event.payload as { results?: LandingItem['gate_results'] }).results ?? []).some(gateFailed);

/** Keeps the busiest lanes and folds the rest into one, so with main at most MAX_LANES remain. */
function foldedLanes(drafts: Draft[]): Draft[] {
  if (drafts.length < MAX_LANES) return drafts;
  // Commits no workstream matched always go into the folded lane.
  const kept = drafts
    .filter((draft) => draft.kind !== 'other')
    .sort((a, b) => b.commits.length - a.commits.length)
    .slice(0, MAX_LANES - 2);
  const rest = drafts.filter((draft) => !kept.includes(draft)),
    seen = new Set<string>();
  return [
    ...kept,
    {
      key: 'other',
      label: 'other',
      kind: 'other',
      merged_lanes: rest.length,
      commits: rest
        .flatMap((draft) => draft.commits)
        .filter((commit) => !seen.has(commit.sha) && seen.add(commit.sha)),
      spans: rest.flatMap((draft) => draft.spans),
      gates: rest.flatMap((draft) => draft.gates),
      turns: rest.flatMap((draft) => draft.turns),
    },
  ];
}

function finishedLane(
  draft: Draft,
  range: { from: number; to: number; bin_ms: number },
  withTurns: boolean,
): RepoLane {
  const byTime = (a: { at: number }, b: { at: number }) => a.at - b.at;
  const commits = [...draft.commits].sort(byTime);
  let detail: Pick<RepoLane, 'points' | 'bins'>;
  if (commits.length <= MAX_POINTS)
    detail = {
      points: commits.map(({ sha, at, kind, session_id }) => ({
        sha,
        at,
        kind,
        ...(session_id ? { session_id } : {}),
      })),
    };
  else {
    const bins = Array.from(
      { length: Math.ceil((range.to - range.from) / range.bin_ms) },
      (_, index) => ({ start: range.from + index * range.bin_ms, commits: 0, merges: 0 }),
    );
    for (const commit of commits) {
      const bin = bins[Math.floor((commit.at - range.from) / range.bin_ms)]!;
      bin.commits++;
      if (commit.kind === 'merge') bin.merges++;
    }
    detail = { bins };
  }
  return {
    key: draft.key,
    label: draft.label,
    kind: draft.kind,
    ...(draft.merged_lanes ? { merged_lanes: draft.merged_lanes } : {}),
    spans: [...draft.spans].sort((a, b) => a.start - b.start),
    ...detail,
    gates: [...draft.gates].sort(byTime),
    ...(withTurns ? { turns: [...draft.turns].sort(byTime) } : {}),
  };
}

export async function repoTimeline(
  ctx: ControlContext,
  p: Principal,
  input: {
    project_id: string;
    from: number;
    to: number;
    group?: 'workstream' | 'branch' | 'author' | undefined;
  },
): Promise<RepoTimeline> {
  const root = projectRoot(ctx, p, input.project_id);
  const { from, to } = input,
    inRange = (at: number) => at >= from && at < to;
  const group = input.group ?? (to - from <= DAY ? 'branch' : 'workstream');
  const bin_ms =
    [HOUR, DAY, WEEK].find((width) => Math.ceil((to - from) / width) <= MAX_BINS) ?? WEEK;
  const workstreams =
    group === 'workstream'
      ? (ctx.store
          .list<ProjectBaseline>('project_baselines')
          .filter(
            (baseline) =>
              baseline.project_id === input.project_id &&
              ['submitted', 'confirmed'].includes(baseline.state),
          )
          .at(-1)?.result?.workstreams ?? [])
      : [];
  const sessions = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.project_id === input.project_id && session.workspace_id);
  const [history, listed] = await Promise.all([
    headHistory(ctx, input.project_id, root),
    listedWorktrees(root),
  ]);
  const worktreeOf = new Map(
    sessions.flatMap((session) => {
      const workspace = ctx.store.get<Workspace>('workspaces', session.workspace_id!);
      const worktree =
        workspace &&
        !workspace.removed_at &&
        listed.find((candidate) => candidate.path === workspace.path && candidate.path !== root);
      return worktree ? [[session.id, worktree] as const] : [];
    }),
  );
  const files = workstreams.length > 0;
  const [mainCommits, ...sessionCommits] = await Promise.all([
    rangeCommits(root, [history.head], from, to, files),
    ...[...worktreeOf.values()].map((worktree) =>
      rangeCommits(root, [worktree.head_sha, '--not', history.head], from, to, files),
    ),
  ]);
  for (const commit of mainCommits!) {
    const session = history.sessions.get(commit.sha);
    if (session) commit.session_id = session;
  }
  // Merges land by fast-forward, so each recorded merge's last commit stands for the merge.
  const mergedTips = new Set(
    ctx.store
      .kindEvents(input.project_id, ['session.merged'])
      .map((event) => (event.payload as { to_sha?: string }).to_sha),
  );
  for (const commit of mainCommits!) if (mergedTips.has(commit.sha)) commit.kind = 'merge';
  const commits = new Map(mainCommits!.map((commit) => [commit.sha, commit]));
  [...worktreeOf.keys()].forEach((sessionId, index) => {
    for (const commit of sessionCommits[index]!)
      if (!commits.has(commit.sha)) commits.set(commit.sha, { ...commit, session_id: sessionId });
  });
  const [releaseRefs, turns] = await Promise.all([
    git(root, [
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(creatordate:unix)',
      'refs/tags',
    ]),
    group === 'branch' ? checkpointTurns(ctx, input.project_id, root) : [],
  ]);

  const events = new Map<string, Event[]>();
  for (const event of ctx.store.kindEvents(input.project_id, [
    'session.opened',
    'session.merged',
    'session.discarded',
    'session.closed',
    'session.gate_checked',
  ]))
    events.set(event.aggregate_id, [...(events.get(event.aggregate_id) ?? []), event]);
  let gateRuns = 0,
    gatedSessions = 0,
    firstPassed = 0;
  const perSession = sessions.flatMap((session) => {
    const own = events.get(session.id) ?? [],
      checks = own.filter((event) => event.kind === 'session.gate_checked');
    const ending = own.find(
      (event) =>
        event.kind === 'session.discarded' ||
        event.kind === 'session.closed' ||
        (event.kind === 'session.merged' && !(event.payload as { direct?: boolean }).direct),
    );
    const start = Math.min(...own.map((event) => event.created_at)),
      end = ending?.created_at ?? (session.archived_at ? Date.parse(session.archived_at) : null);
    const last = checks.at(-1);
    const state: Span['state'] =
      session.archived_at || session.outcome === 'discarded'
        ? 'archived'
        : session.outcome === 'merged' || ending?.kind === 'session.merged'
          ? 'merged'
          : session.state === 'running'
            ? 'running'
            : (last && !gatePassed(last)) || session.merge?.state === 'blocked'
              ? 'failed'
              : last
                ? 'review'
                : 'idle';
    const branch = worktreeOf.get(session.id)?.branch ?? null,
      title = session.title ?? session.native_title ?? '';
    const spans: Span[] =
      own.length && start < to && (end === null || end >= from)
        ? [{ session_id: session.id, title, branch, start, end, state }]
        : [];
    const gates = checks
      .filter((event) => inRange(event.created_at))
      .map((event) => ({
        at: event.created_at,
        session_id: session.id,
        passed: gatePassed(event),
      }));
    if (gates.length) {
      gateRuns += gates.length;
      gatedSessions++;
      if (gatePassed(checks[0]!)) firstPassed++;
    }
    const ownTurns = turns.filter((turn) => turn.session_id === session.id && inRange(turn.at)),
      ownCommits = [...commits.values()].filter((commit) => commit.session_id === session.id);
    return spans.length || gates.length || ownTurns.length || ownCommits.length
      ? [
          {
            id: session.id,
            label: branch ?? title,
            spans,
            gates,
            turns: ownTurns,
            commits: ownCommits,
          },
        ]
      : [];
  });

  let drafts: Draft[];
  if (group === 'author') {
    const byKey = new Map<string, Draft>();
    const laneFor = (kind: 'author' | 'runtime', label: string) => {
      const key = `${kind}:${label}`;
      let draft = byKey.get(key);
      if (!draft) {
        draft = { key, label, kind, commits: [], spans: [], gates: [], turns: [] };
        byKey.set(key, draft);
      }
      return draft;
    };
    const runtimeOf = new Map(sessions.map((session) => [session.id, session.runtime]));
    for (const commit of commits.values()) {
      const runtime = commit.session_id && runtimeOf.get(commit.session_id);
      (runtime ? laneFor('runtime', runtime) : laneFor('author', commit.author)).commits.push(
        commit,
      );
    }
    for (const entry of perSession) {
      const lane = laneFor('runtime', runtimeOf.get(entry.id)!);
      lane.spans.push(...entry.spans);
      lane.gates.push(...entry.gates);
    }
    drafts = [...byKey.values()].sort(
      (a, b) => b.commits.length - a.commits.length || a.label.localeCompare(b.label),
    );
  } else if (!workstreams.length)
    drafts = perSession.map(({ id, label, ...lane }) => ({
      key: id,
      label,
      kind: 'branch',
      ...lane,
    }));
  else {
    const unmatched: Draft = {
      key: 'other',
      label: 'other',
      kind: 'other',
      commits: [],
      spans: [],
      gates: [],
      turns: [],
    };
    const streams = workstreams.map((stream) => ({
      draft: {
        key: stream.id,
        label: stream.title,
        kind: 'workstream',
        commits: [],
        spans: [],
        gates: [],
        turns: [],
      } as Draft,
      // `./src`, `src/` and `src` name one folder; `.` names every file.
      modules: (stream.modules ?? []).map((module) => posix.normalize(module).replace(/\/+$/, '')),
    }));
    const laneOf = new Map<string, Draft>();
    for (const commit of commits.values()) {
      let best = unmatched,
        most = 0;
      for (const { draft, modules } of streams) {
        const touched = commit.files.filter((file) =>
          modules.some(
            (module) => module === '.' || file === module || file.startsWith(`${module}/`),
          ),
        ).length;
        if (touched > most) [best, most] = [draft, touched];
      }
      best.commits.push(commit);
      laneOf.set(commit.sha, best);
    }
    // A session sits in the lane most of its commits in the range went to.
    for (const entry of perSession) {
      const votes = new Map<Draft, number>();
      for (const commit of entry.commits) {
        const lane = laneOf.get(commit.sha)!;
        votes.set(lane, (votes.get(lane) ?? 0) + 1);
      }
      const lane = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? unmatched;
      lane.spans.push(...entry.spans);
      lane.gates.push(...entry.gates);
    }
    drafts = [...streams.map((stream) => stream.draft), unmatched].filter(
      (draft) => draft.commits.length || draft.spans.length || draft.gates.length,
    );
  }

  const main: Draft = {
    key: 'main',
    label: listed.find((worktree) => worktree.path === root)?.branch ?? 'HEAD',
    kind: 'main',
    commits: mainCommits!,
    spans: [],
    gates: [],
    turns: [],
  };
  const range = { from, to, bin_ms };
  return {
    from,
    to,
    bin_ms,
    lanes: [main, ...foldedLanes(drafts)].map((draft) =>
      finishedLane(draft, range, group === 'branch'),
    ),
    releases: releaseRefs
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const [name, object, peeled, time] = line.split('\0');
        const at = Number(time) * 1000;
        return inRange(at) ? [{ name: name!, sha: peeled || object!, at }] : [];
      })
      .sort((a, b) => a.at - b.at),
    totals: {
      commits: commits.size,
      merges: [...commits.values()].filter((commit) => commit.kind === 'merge').length,
      gate_runs: gateRuns,
      gate_first_pass: gatedSessions ? firstPassed / gatedSessions : null,
    },
    overview: history.overview,
    extent: history.extent,
  };
}

/** A path relative to the project's first folder; callers pass it after `--` or `./`, where git cannot read it as an option. */
export function relativeFile(file: string): string {
  requireThat(
    !isAbsolute(file) && !file.split('/').includes('..'),
    'invalid_input',
    'Path must be relative to the project folder and must not contain ..',
  );
  return file;
}

/** The project's sessions whose worktree exists apart from the project's first folder. */
export function sessionWorktrees(
  ctx: ControlContext,
  projectId: string,
  root: string,
  listed: Awaited<ReturnType<typeof listedWorktrees>>,
): Map<string, Awaited<ReturnType<typeof listedWorktrees>>[number]> {
  return new Map(
    ctx.store
      .list<Session>('sessions')
      .filter((session) => session.project_id === projectId && session.workspace_id)
      .flatMap((session) => {
        const workspace = ctx.store.get<Workspace>('workspaces', session.workspace_id!);
        const worktree =
          workspace &&
          !workspace.removed_at &&
          listed.find((candidate) => candidate.path === workspace.path && candidate.path !== root);
        return worktree ? [[session.id, worktree] as const] : [];
      }),
  );
}

/** The hunks of a -U0 diff, in order; a count of 0 is an insertion after line start. */
function hunks(diff: string) {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((hunk) => ({
    start: Number(hunk[1]),
    count: hunk[2] === undefined ? 1 : Number(hunk[2]),
    new_start: Number(hunk[3]),
    new_count: hunk[4] === undefined ? 1 : Number(hunk[4]),
  }));
}

export async function repoBlame(
  ctx: ControlContext,
  p: Principal,
  input: { project_id: string; path: string; ref?: string },
): Promise<RepoBlame> {
  const root = projectRoot(ctx, p, input.project_id),
    file = relativeFile(input.path);
  const [sha, history, listed] = await Promise.all([
    commitOf(root, input.ref ?? 'HEAD'),
    headHistory(ctx, input.project_id, root),
    listedWorktrees(root),
  ]);
  const runs: { start: number; count: number; sha: string }[] = [],
    authors = new Map<string, { author: string; at: number }>();
  let current = '';
  const shown = await runGit(root, ['show', `${sha}:./${file}`], undefined, true, {
    max_buffer: PATCH_BOUND,
    timeout_ms: TIME_BOUND,
  });
  const truncated =
    shown.exit_code !== 0 && /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/.test(shown.error ?? '');
  requireThat(
    shown.exit_code === 0 || truncated,
    'workspace_read_failed',
    shown.error ?? shown.stderr.toString(),
  );
  const text = truncated ? new StringDecoder('utf8').write(shown.stdout) : shown.stdout.toString();
  // Only the lines the preview holds are blamed, the last one possibly in part.
  const previewed = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  // Incremental output has a header for each run of lines, where porcelain repeats every line.
  const blamed = await git(root, [
    LITERAL,
    'blame',
    '--incremental',
    ...(truncated ? [`-L1,${previewed}`] : []),
    sha,
    '--',
    file,
  ]);
  const groups: typeof runs = [];
  for (const line of blamed.split('\n')) {
    // Each run of lines from one commit opens with "<sha> <original line> <final line> <lines>".
    const opening = /^([0-9a-f]{40,64}) \d+ (\d+) (\d+)$/.exec(line);
    if (opening) {
      current = opening[1]!;
      groups.push({ start: Number(opening[2]), count: Number(opening[3]), sha: current });
      if (!authors.has(current)) authors.set(current, { author: '', at: 0 });
    } else if (line.startsWith('author ')) authors.get(current)!.author = line.slice(7);
    else if (line.startsWith('author-time '))
      authors.get(current)!.at = Number(line.slice('author-time '.length)) * 1000;
  }
  // Runs come in the order blame settles them.
  for (const run of groups.sort((a, b) => a.start - b.start)) {
    const last = runs.at(-1);
    if (last?.sha === run.sha && last.start + last.count === run.start) last.count += run.count;
    else runs.push(run);
  }
  const sessions = await mergingSessions(ctx, input.project_id, root);
  const pending = await Promise.all(
    [...sessionWorktrees(ctx, input.project_id, root, listed)].map(
      async ([session_id, worktree]) => {
        const base = (await mergeBase(root, history.head, worktree.head_sha)) ?? history.head;
        const [diff, moved] = await Promise.all([
          git(root, [LITERAL, 'diff', '-U0', '--no-ext-diff', base, worktree.head_sha, '--', file]),
          git(root, [LITERAL, 'diff', '-U0', base, sha, '--', file]),
        ]);
        const shifts = hunks(moved);
        // A line shifts by the hunks that end before it; a line a hunk changed goes to that hunk's start.
        const onBlamed = (line: number) => {
          let shift = 0;
          for (const hunk of shifts) {
            if (hunk.start + Math.max(hunk.count, 1) - 1 < line)
              shift += hunk.new_count - hunk.count;
            else if (hunk.count > 0 && hunk.start <= line) return hunk.new_start;
            else break;
          }
          return line + shift;
        };
        const ranges = hunks(diff).map((range) => {
          const start = onBlamed(range.start);
          return {
            start,
            count: range.count === 0 ? 0 : onBlamed(range.start + range.count - 1) - start + 1,
          };
        });
        return { session_id, ranges };
      },
    ),
  );
  return {
    path: file,
    sha,
    ...(shown.stdout.subarray(0, 8 * 1024).includes(0) ? {} : { text }),
    truncated,
    chunks: runs.map((run) => {
      const session = sessions.get(run.sha);
      return { ...run, ...authors.get(run.sha)!, ...(session ? { session_id: session } : {}) };
    }),
    pending: pending.filter((entry) => entry.ranges.length),
  };
}

export async function repoFileHistory(
  ctx: ControlContext,
  p: Principal,
  input: { project_id: string; path: string },
): Promise<RepoFileHistory> {
  const root = projectRoot(ctx, p, input.project_id),
    file = relativeFile(input.path);
  const history = await headHistory(ctx, input.project_id, root);
  const thisWeek = Math.floor(ctx.store.now() / WEEK) * WEEK,
    firstWeek = thisWeek - 25 * WEEK;
  const [changed, times, scannedLog] = await Promise.all([
    git(root, [
      LITERAL,
      'log',
      '-z',
      UNSIGNED,
      '--max-count=50',
      LOG_FORMAT,
      history.head,
      '--',
      file,
    ]),
    git(root, [
      LITERAL,
      'log',
      UNSIGNED,
      '--format=%ct',
      `--since-as-filter=@${Math.floor(firstWeek / 1000)} +0000`,
      history.head,
      '--',
      file,
    ]),
    // Paths relative to the project folder, as the queried path is.
    git(root, [
      'log',
      '-z',
      UNSIGNED,
      '--max-count=500',
      '--format=%x00%H',
      '--name-only',
      '--relative',
      history.head,
      '--',
    ]),
  ]);
  const weekly = Array.from({ length: 26 }, (_, index) => ({
    start: firstWeek + index * WEEK,
    count: 0,
  }));
  for (const time of times.split('\n').filter(Boolean)) {
    const week = weekly[Math.floor((Number(time) * 1000 - firstWeek) / WEEK)];
    if (week) week.count++;
  }
  const records = loggedFields(scannedLog, 1),
    together = new Map<string, number>();
  for (const { names } of records) {
    if (!names.includes(file)) continue;
    for (const name of names) if (name !== file) together.set(name, (together.get(name) ?? 0) + 1);
  }
  return {
    changes: loggedFields(changed, LOG_FIELDS).map((line) => {
      const commit = loggedCommit(line.fields),
        session = history.sessions.get(commit.sha);
      return session ? { ...commit, session_id: session } : commit;
    }),
    weekly,
    cochange: [...together]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([path, count]) => ({ path, together: count })),
    scanned: records.length,
  };
}
