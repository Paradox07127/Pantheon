import { StringDecoder } from 'node:string_decoder';
import { requireThat, type Principal, type Project } from '@pantheon/domain';
import type {
  LandingDiff,
  RepoBlame,
  RepoCommit,
  RepoCommitAfter,
  RepoCompare,
  RepoConflict,
  RepoFileHistory,
  RepoLog,
} from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import type { GitResult } from './git.js';
import { rangeDiffWithSyncBounds } from './landing-diff.js';
import { mergeBase, mergePreview } from './merge-preview.js';
import { commitOf } from './review.js';
import { BOUND, PATCH_BOUND, listedWorktrees, sessionWorktrees, sourceGit } from './source-git.js';

function repository(ctx: ControlContext, principal: Principal, projectId: string) {
  projectAccess(ctx, principal, projectId, 'project.read');
  const root = ctx.store.must<Project>('projects', projectId).roots[0]!;
  const git = sourceGit(ctx, principal, projectId, root);
  const read = async (args: string[]) => {
    const result = await git(args, BOUND);
    requireThat(
      result.exit_code === 0,
      'workspace_read_failed',
      result.error ?? result.stderr.toString(),
    );
    return result.stdout.toString();
  };
  return { root, git, read };
}

function attributedCommits<T extends { sha: string }>(
  ctx: ControlContext,
  projectId: string,
  commits: T[],
) {
  if (!commits.length) return commits;
  const rows = ctx.store
    .statement(
      `
    SELECT sha, session_id, landing_id FROM landing_commits
    WHERE project_id=$project AND sha IN (SELECT value FROM json_each($shas))
    ORDER BY ended_at
  `,
    )
    .all({ $project: projectId, $shas: JSON.stringify(commits.map((commit) => commit.sha)) }) as {
    sha: string;
    session_id: string | null;
    landing_id: string | null;
  }[];
  const byCommit = new Map<string, Pick<RepoCommit, 'session_id' | 'landing_id'>>();
  for (const { sha, session_id, landing_id } of rows) {
    const attribution = byCommit.get(sha) ?? {};
    if (session_id) attribution.session_id = session_id;
    if (landing_id) attribution.landing_id = landing_id;
    byCommit.set(sha, attribution);
  }
  return commits.map((commit) => ({ ...commit, ...byCommit.get(commit.sha) }));
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
    subject: subject!,
    body: body!.replace(/(?:\r?\n)+$/, ''),
  };
}

const PARSED_DIFF = ['--no-color', '--no-ext-diff'];

export async function repoLog(
  ctx: ControlContext,
  p: Principal,
  input: { project_id: string; ref?: string; limit: number; skip: number },
): Promise<RepoLog> {
  const { root, git, read } = repository(ctx, p, input.project_id);
  if (input.ref === undefined) {
    // A new repository's branch has no commit yet.
    const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], BOUND);
    if (head.exit_code === 1) return { commits: [], has_more: false };
    requireThat(
      head.exit_code === 0,
      'workspace_read_failed',
      head.error ?? head.stderr.toString(),
    );
  }
  const start = await commitOf(root, input.ref ?? 'HEAD', BOUND);
  const lines = loggedFields(
    await read([
      'log',
      ...PARSED_DIFF,
      '-z',
      // The graph's lanes need every commit before its parents.
      '--topo-order',
      `--max-count=${input.limit + 1}`,
      `--skip=${input.skip}`,
      LOG_FORMAT,
      start,
      '--',
    ]),
    LOG_FIELDS,
  );
  const commits = lines.slice(0, input.limit).map((line) => loggedCommit(line.fields));
  return {
    commits: attributedCommits(ctx, input.project_id, commits),
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
  const { root, read } = repository(ctx, p, projectId);
  const commit = await commitOf(root, sha, BOUND);
  const [, parent] = (await read(['rev-list', '--parents', '--max-count=1', commit, '--']))
    .trim()
    .split(' ');
  return rangeDiffWithSyncBounds(ctx, p, projectId, {
    source: root,
    from_sha: parent ?? (await read(['hash-object', '-t', 'tree', '/dev/null'])).trim(),
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
  const { root, read, git } = repository(ctx, p, projectId);
  const [baseSha, headSha, rootHead] = await Promise.all([
    commitOf(root, base, BOUND),
    commitOf(root, head, BOUND),
    commitOf(root, 'HEAD', BOUND),
  ]);
  const previewed_at = ctx.store.now();
  const common = await mergeBase(root, baseSha, headSha, BOUND);
  const [counts, merge, listed, headRef] = await Promise.all([
    read(['rev-list', '--left-right', '--count', `${baseSha}...${headSha}`, '--']),
    common ? mergePreview(root, baseSha, headSha, BOUND) : undefined,
    listedWorktrees(root),
    read(['rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', head]),
  ]);
  const worktrees = [...new Set(sessionWorktrees(ctx, projectId, root, listed).values())];
  let compared = listed.find(
    (worktree) => worktree.branch && `refs/heads/${worktree.branch}` === headRef.trim(),
  );
  // A commit given as a SHA names no branch; the one session worktree at it is the compared one.
  if (!headRef.trim()) {
    const matches = worktrees.filter((worktree) => worktree.head_sha === headSha);
    if (matches.length === 1) compared = matches[0];
  }
  const [behind, ahead] = counts.trim().split('\t').map(Number);
  const [diff, conflicts, others] = await Promise.all([
    rangeDiffWithSyncBounds(ctx, p, projectId, {
      source: root,
      from_sha: common ?? baseSha,
      to_sha: headSha,
    }),
    merge && conflictFiles(git, merge),
    Promise.all(
      worktrees
        .filter((worktree) => worktree.path !== compared?.path)
        .map(async (worktree) => {
          const from = (await mergeBase(root, rootHead, worktree.head_sha, BOUND)) ?? rootHead;
          return read([
            'diff',
            ...PARSED_DIFF,
            '--no-renames',
            '--name-only',
            '-z',
            from,
            worktree.head_sha,
            '--',
          ]);
        }),
    ),
  ]);
  const elsewhere = new Set(others.flatMap((names) => names.split('\0')));
  return {
    ...diff,
    merge_base: common ?? null,
    ahead: ahead!,
    behind: behind!,
    ...(conflicts ? { conflicts, previewed_at } : {}),
    single_owner_files: diff.files.filter(
      (file) => !elsewhere.has(file.path) && !(file.old_path && elsewhere.has(file.old_path)),
    ).length,
  };
}

async function conflictFiles(git: ReturnType<typeof sourceGit>, merge: GitResult) {
  // Git versions without merge-tree --write-tree return its usage.
  if (merge.exit_code === 129) return undefined;
  requireThat(
    merge.exit_code === 0 || merge.exit_code === 1,
    'workspace_read_failed',
    merge.error ?? merge.stderr.toString(),
  );
  if (merge.exit_code === 0) return [];
  const [tree, ...files] = merge.stdout.toString().split('\0\0')[0]!.split('\0');
  return Promise.all(
    files.slice(0, 20).map(async (path): Promise<RepoConflict> => {
      const shown = await git(['cat-file', 'blob', `${tree}:${path}`], BOUND);
      return {
        path,
        ...firstConflict(shown.exit_code === 0 ? shown.stdout.toString().split('\n') : []),
      };
    }),
  );
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

export async function repoCommitAfter(
  ctx: ControlContext,
  p: Principal,
  input: { project_id: string; sha: string },
): Promise<RepoCommitAfter> {
  const { root, read } = repository(ctx, p, input.project_id);
  const [commit, head] = await Promise.all([
    commitOf(root, input.sha, BOUND),
    commitOf(root, 'HEAD', BOUND),
  ]);
  const count = Number(
    await read(['rev-list', '--first-parent', '--count', `${commit}..${head}`, '--']),
  );
  if (!count) return { next: null };
  // A side branch can also exclude part of this line. Check the candidate's first parent.
  const log = await read([
    'log',
    ...PARSED_DIFF,
    '-1',
    '-z',
    LOG_FORMAT,
    `${head}~${count - 1}`,
    '--',
  ]);
  const next = loggedCommit(loggedFields(log, LOG_FIELDS)[0]!.fields);
  if (next.parents[0] !== commit) return { next: null };
  return { next: attributedCommits(ctx, input.project_id, [next])[0]! };
}

const LITERAL = '--literal-pathspecs';

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
  const { root, git, read } = repository(ctx, p, input.project_id);
  const file = input.path;
  const head = await commitOf(root, 'HEAD', BOUND);
  const [sha, listed] = await Promise.all([
    input.ref ? commitOf(root, input.ref, BOUND) : head,
    listedWorktrees(root),
  ]);
  const runs: { start: number; count: number; sha: string }[] = [],
    authors = new Map<string, { author: string; at: number }>();
  let current = '';
  const shown = await git(['cat-file', 'blob', `${sha}:./${file}`], {
    ...BOUND,
    max_buffer: PATCH_BOUND,
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
  const blamed = await read([
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
  const pending = await Promise.all(
    [...sessionWorktrees(ctx, input.project_id, root, listed)].map(
      async ([session_id, worktree]) => {
        const base = (await mergeBase(root, head, worktree.head_sha, BOUND)) ?? head;
        const [diff, moved] = await Promise.all([
          read([LITERAL, 'diff', ...PARSED_DIFF, '-U0', base, worktree.head_sha, '--', file]),
          read([LITERAL, 'diff', ...PARSED_DIFF, '-U0', base, sha, '--', file]),
        ]);
        const shifts = hunks(moved);
        const onBlamed = (line: number, edge: 'start' | 'end') => {
          let shift = 0;
          for (const hunk of shifts) {
            if (hunk.start + Math.max(hunk.count, 1) - 1 < line)
              shift += hunk.new_count - hunk.count;
            else if (hunk.count > 0 && hunk.start <= line) {
              // A deletion's new_start is the preceding line. A range can start only after it.
              return hunk.new_start + (edge === 'start' && hunk.new_count === 0 ? 1 : 0);
            } else break;
          }
          return line + shift;
        };
        const ranges = hunks(diff).flatMap((range) => {
          if (range.count === 0) return [{ start: onBlamed(range.start, 'end'), count: 0 }];
          const start = onBlamed(range.start, 'start');
          const end = onBlamed(range.start + range.count - 1, 'end');
          return end < start ? [] : [{ start, count: end - start + 1 }];
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
    chunks: attributedCommits(
      ctx,
      input.project_id,
      runs.map((run) => ({ ...run, ...authors.get(run.sha)! })),
    ),
    pending: pending.filter((entry) => entry.ranges.length),
  };
}

export async function repoFileHistory(
  ctx: ControlContext,
  p: Principal,
  input: { project_id: string; path: string },
): Promise<RepoFileHistory> {
  const { root, read } = repository(ctx, p, input.project_id);
  const head = await commitOf(root, 'HEAD', BOUND);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const firstWeek = (Math.floor(ctx.store.now() / weekMs) - 25) * weekMs;
  const log = ['log', ...PARSED_DIFF, '--diff-merges=first-parent'];
  const follow = [LITERAL, ...log, '--follow'];
  const [changed, times, scannedLog] = await Promise.all([
    read([
      ...follow,
      '-z',
      '--max-count=500',
      LOG_FORMAT,
      '--name-only',
      '--relative',
      head,
      '--',
      input.path,
    ]),
    read([
      ...follow,
      '--no-patch',
      '--format=%ct',
      `--since-as-filter=@${firstWeek / 1000} +0000`,
      head,
      '--',
      input.path,
    ]),
    read([
      ...log,
      '-z',
      '--max-count=500',
      '--format=%x00%H',
      '--name-only',
      '--relative',
      head,
      '--',
    ]),
  ]);
  const weekly = Array.from({ length: 26 }, (_, index) => ({
    start: firstWeek + index * weekMs,
    count: 0,
  }));
  for (const time of times.split('\n').filter(Boolean)) {
    const week = weekly[Math.floor((Number(time) * 1000 - firstWeek) / weekMs)];
    if (week) week.count++;
  }

  const changes = loggedFields(changed, LOG_FIELDS);
  // --follow reports the file's name at each change, including before a rename.
  const changedPath = new Map(changes.map(({ fields, names }) => [fields[0]!, names[0]!]));
  const scanned = loggedFields(scannedLog, 1);
  const together = new Map<string, number>();
  for (const { fields, names } of scanned) {
    const file = changedPath.get(fields[0]!);
    if (file === undefined) continue;
    for (const name of names) if (name !== file) together.set(name, (together.get(name) ?? 0) + 1);
  }
  const shown = changes.slice(0, 50).map(({ fields }) => loggedCommit(fields));
  return {
    changes: attributedCommits(ctx, input.project_id, shown),
    weekly,
    cochange: [...together]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([path, count]) => ({ path, together: count })),
    scanned: scanned.length,
  };
}
