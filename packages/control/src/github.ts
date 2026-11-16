import { z } from 'zod';
import {
  requireThat,
  type Principal,
  type Project,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import type {
  Command,
  GithubItems,
  GithubPullDetail,
  GithubReviewDecision,
  inputSchemas,
} from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handler } from './context.js';
import { githubConnection, githubJson } from './connections-status.js';
import { remoteOf } from './import-candidates.js';
import { runGit } from './git.js';
import { listedWorktrees, sessionWorktrees } from './repo.js';

const cached = new WeakMap<ControlContext, Map<string, { at: number; value: GithubItems }>>();
const details = new WeakMap<ControlContext, Map<string, { at: number; value: GithubPullDetail }>>();
const pullSchema = z.object({ number: z.number().int(), url: z.string() });
const checkSchema = z.object({
  conclusion: z.string().nullish(),
  status: z.string().nullish(),
  state: z.string().nullish(),
});
const itemSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.literal('OPEN'),
  author: z.object({ login: z.string() }).nullable(),
  updatedAt: z.string(),
  statusCheckRollup: z.array(checkSchema).nullish(),
  reviewDecision: z.string().nullish(),
  headRefName: z.string().optional(),
});
const detailSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  reviewDecision: z.string().nullish(),
  headRefName: z.string(),
  baseRefName: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  statusCheckRollup: z
    .array(
      checkSchema.extend({
        // A check run has a name; a commit status has a context.
        name: z.string().nullish(),
        context: z.string().nullish(),
        startedAt: z.string().nullish(),
        completedAt: z.string().nullish(),
        detailsUrl: z.string().nullish(),
        targetUrl: z.string().nullish(),
      }),
    )
    .nullish(),
});
const threadsSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              isResolved: z.boolean(),
              path: z.string(),
              line: z.number().int().nullable(),
              comments: z.object({
                nodes: z.array(
                  z.object({
                    author: z.object({ login: z.string() }).nullable(),
                    body: z.string(),
                  }),
                ),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { isResolved path line comments(first: 1) { nodes { author { login } body } } }
      }
    }
  }
}`;

function checkState(
  check: z.infer<typeof checkSchema>,
): GithubPullDetail['checks'][number]['state'] {
  const state = check.state || (check.status === 'COMPLETED' ? check.conclusion : 'PENDING');
  if (
    [
      'ERROR',
      'FAILURE',
      'CANCELLED',
      'TIMED_OUT',
      'ACTION_REQUIRED',
      'STARTUP_FAILURE',
      'STALE',
    ].includes(state ?? '')
  )
    return 'failed';
  if (state === 'SKIPPED') return 'skipped';
  return ['SUCCESS', 'NEUTRAL'].includes(state ?? '') ? 'passed' : 'running';
}

function reviewDecision(decision: string | null | undefined): GithubReviewDecision | null {
  return decision === 'APPROVED' ||
    decision === 'CHANGES_REQUESTED' ||
    decision === 'REVIEW_REQUIRED'
    ? (decision.toLowerCase() as GithubReviewDecision)
    : null;
}

/** Finds the session that opened a pull request, or else the one whose worktree is on its head branch. */
async function pullSessions(ctx: ControlContext, projectId: string, root: string) {
  const opened = new Map<number, string>();
  for (const event of ctx.store.kindEvents(projectId, ['session.pr_created']))
    opened.set((event.payload as { number: number }).number, event.aggregate_id);
  const onBranch = new Map<string, string>();
  for (const [session, worktree] of sessionWorktrees(
    ctx,
    projectId,
    root,
    await listedWorktrees(root),
  ))
    if (worktree.branch) onBranch.set(worktree.branch, session);
  return (number: number, head: string | undefined) =>
    opened.get(number) ?? (head === undefined ? undefined : onBranch.get(head));
}

async function githubRun(ctx: ControlContext, args: string[], cwd: string): Promise<string> {
  // Listing and creating go over the network; 3 s is only enough for the local auth check.
  const result = await ctx.localCommand('gh', args, cwd, 60_000);
  requireThat(
    !result.missing && !result.timed_out && result.exit_code === 0,
    'connection_check_failed',
    result.stderr || 'gh command failed',
  );
  return result.stdout;
}

async function repository(ctx: ControlContext, root: string) {
  const remote = await remoteOf(root);
  if (!remote) return null;
  const connection = await githubConnection(ctx.localCommand, remote.host);
  if (remote.host !== 'github.com' && !connection.signed_in) return null;
  requireThat(
    connection.signed_in,
    'connection_check_failed',
    `gh auth status: ${connection.state}`,
  );
  return {
    ...remote,
    repo: `${remote.owner}/${remote.name}`,
    qualified: `${remote.host}/${remote.owner}/${remote.name}`,
  };
}

const referenceSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  body: z.string(),
});
// The text of each referenced item, read before the command applies; null text = not found.
const references = new WeakMap<ControlContext, Map<string, { at: number; text: string | null }>>();
const referenceKey = (projectId: string, ref: { kind: 'pr' | 'issue'; number: number }) =>
  `${projectId}:${ref.kind}:${ref.number}`;

/** Reads the pull requests and issues a message references, once each. */
export async function prepareGithubReferences(
  ctx: ControlContext,
  projectId: string,
  refs: { kind: string; number?: number }[],
): Promise<void> {
  const wanted = refs.filter(
    (ref): ref is { kind: 'pr' | 'issue'; number: number } => ref.kind !== 'session',
  );
  if (!wanted.length) return;
  let texts = references.get(ctx);
  if (!texts) references.set(ctx, (texts = new Map()));
  const root = ctx.store.must<Project>('projects', projectId).roots[0]!,
    repo = await repository(ctx, root);
  for (const ref of wanted) {
    const key = referenceKey(projectId, ref);
    if (ctx.store.now() - (texts.get(key)?.at ?? -Infinity) < 60_000) continue;
    const result = repo
      ? await ctx.localCommand(
          'gh',
          [
            ref.kind,
            'view',
            String(ref.number),
            '--repo',
            repo.qualified,
            '--json',
            'number,title,state,url,body',
          ],
          root,
          60_000,
        )
      : undefined;
    if (!result || result.exit_code !== 0) {
      texts.set(key, { at: ctx.store.now(), text: null });
      continue;
    }
    const item = githubJson(result.stdout, referenceSchema);
    texts.set(key, {
      at: ctx.store.now(),
      text: `[Pantheon] Referenced ${ref.kind === 'pr' ? 'pull request' : 'issue'} #${item.number} (${item.state}): ${item.title}\n${item.url}\n${item.body.slice(0, 4000)}`,
    });
  }
}

/** The text read by prepareGithubReferences; a reference it did not find is invalid input. */
export function githubReference(
  ctx: ControlContext,
  projectId: string,
  ref: { kind: 'pr' | 'issue'; number: number },
): string {
  const text = references.get(ctx)?.get(referenceKey(projectId, ref))?.text;
  requireThat(text, 'invalid_input', `The repository has no ${ref.kind} #${ref.number}`);
  return text;
}

export async function githubItems(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  kind: 'pr' | 'issue',
): Promise<GithubItems> {
  projectAccess(ctx, principal, projectId, 'github.items');
  const project = ctx.store.must<Project>('projects', projectId);
  let entries = cached.get(ctx);
  if (!entries) cached.set(ctx, (entries = new Map()));
  const key = `${projectId}:${kind}`,
    previous = entries.get(key);
  if (previous && ctx.store.now() - previous.at < 60_000) return previous.value;
  const root = project.roots[0]!,
    repo = await repository(ctx, root);
  let value: GithubItems = { repo: null, items: [] };
  if (repo) {
    const output = await githubRun(
      ctx,
      [
        kind,
        'list',
        '--repo',
        repo.qualified,
        '--state',
        'open',
        '--limit',
        '30',
        '--search',
        'sort:updated-desc',
        '--json',
        `number,title,url,state,author,updatedAt${kind === 'pr' ? ',statusCheckRollup,reviewDecision,headRefName' : ''}`,
      ],
      root,
    );
    const items = githubJson(output, z.array(itemSchema));
    const sessionOf = kind === 'pr' ? await pullSessions(ctx, projectId, root) : undefined;
    value = {
      repo: repo.repo,
      items: items
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 30)
        .map((item) => {
          const checks = kind === 'pr' ? item.statusCheckRollup : undefined;
          const states = checks?.map(checkState);
          let summary: 'passing' | 'failing' | 'pending' | undefined;
          if (states?.length) {
            summary = states.includes('failed')
              ? 'failing'
              : states.every((state) => state === 'passed' || state === 'skipped')
                ? 'passing'
                : 'pending';
          }
          const decision = reviewDecision(item.reviewDecision),
            session = sessionOf?.(item.number, item.headRefName);
          return {
            number: item.number,
            title: item.title,
            url: item.url,
            state: 'open',
            ...(item.author ? { author: item.author.login } : {}),
            updated_at: item.updatedAt,
            ...(summary ? { checks: summary } : {}),
            ...(states?.length
              ? {
                  checks_passed: states.filter((state) => state === 'passed').length,
                  checks_total: states.length,
                }
              : {}),
            ...(decision ? { review_decision: decision } : {}),
            ...(kind === 'pr' && item.headRefName !== undefined ? { head: item.headRefName } : {}),
            ...(session ? { session_id: session } : {}),
          };
        }),
    };
  }
  entries.set(key, { at: ctx.store.now(), value });
  return value;
}

export async function githubPullDetail(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  number: number,
): Promise<GithubPullDetail> {
  projectAccess(ctx, principal, projectId, 'github.pr.detail');
  const project = ctx.store.must<Project>('projects', projectId);
  let entries = details.get(ctx);
  if (!entries) details.set(ctx, (entries = new Map()));
  const key = `${projectId}:${number}`,
    previous = entries.get(key);
  if (previous && ctx.store.now() - previous.at < 60_000) return previous.value;
  const root = project.roots[0]!,
    repo = await repository(ctx, root);
  requireThat(repo, 'invalid_input', 'Project has no GitHub repository');
  const [pull, threads] = await Promise.all([
    githubRun(
      ctx,
      [
        'pr',
        'view',
        String(number),
        '--repo',
        repo.qualified,
        '--json',
        'number,title,url,state,reviewDecision,headRefName,baseRefName,additions,deletions,statusCheckRollup',
      ],
      root,
    ).then((output) => githubJson(output, detailSchema)),
    githubRun(
      ctx,
      [
        'api',
        'graphql',
        '--hostname',
        repo.host,
        '-f',
        `query=${THREADS_QUERY}`,
        '-f',
        `owner=${repo.owner}`,
        '-f',
        `name=${repo.name}`,
        '-F',
        `number=${number}`,
      ],
      root,
    ).then((output) => githubJson(output, threadsSchema)),
  ]);
  // GitHub gives an unfinished check the zero time as its completion.
  const time = (value: string | null | undefined) => {
    const at = value ? Date.parse(value) : NaN;
    return at > 0 ? at : null;
  };
  const session = (await pullSessions(ctx, projectId, root))(pull.number, pull.headRefName);
  const value: GithubPullDetail = {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    state: pull.state === 'OPEN' ? 'open' : pull.state === 'CLOSED' ? 'closed' : 'merged',
    review_decision: reviewDecision(pull.reviewDecision),
    head: pull.headRefName,
    base: pull.baseRefName,
    additions: pull.additions,
    deletions: pull.deletions,
    ...(session ? { session_id: session } : {}),
    checks: (pull.statusCheckRollup ?? []).map((check) => {
      const started = time(check.startedAt),
        completed = time(check.completedAt);
      return {
        name: check.name || check.context || '',
        state: checkState(check),
        duration_ms: started !== null && completed !== null ? completed - started : null,
        url: check.detailsUrl || check.targetUrl || null,
      };
    }),
    threads: threads.data.repository.pullRequest.reviewThreads.nodes
      .map((thread) => ({
        path: thread.path,
        line: thread.line,
        author: thread.comments.nodes[0]?.author?.login ?? '',
        body: thread.comments.nodes[0]?.body ?? '',
        resolved: thread.isResolved,
      }))
      .sort((a, b) => Number(a.resolved) - Number(b.resolved)),
  };
  entries.set(key, { at: ctx.store.now(), value });
  return value;
}

export async function preparePullRequest(
  ctx: ControlContext,
  principal: Principal,
  command: Command,
  input: ReturnType<(typeof inputSchemas)['github.pr.create']['parse']>,
): Promise<Handler> {
  userOnly(principal);
  const session = ctx.store.must<Session>('sessions', input.session_id);
  const workspace = session.workspace_id
    ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
    : undefined;
  requireThat(
    workspace?.kind === 'linked_worktree' && workspace.source_branch,
    'invalid_input',
    'Session requires a worktree with a source branch',
  );
  const status = await runGit(workspace.path, ['status', '--porcelain'], undefined, true);
  requireThat(
    status.exit_code === 0 && !status.stdout.length,
    'invalid_input',
    'Worktree has uncommitted changes or cannot be read',
  );
  const head = await runGit(workspace.path, ['symbolic-ref', '--short', 'HEAD'], undefined, true);
  // Session worktrees are detached; their commits go up under a branch named after the session.
  const branch =
    head.exit_code === 0 ? head.stdout.toString().trim() : `pantheon/${session.id.slice(0, 8)}`;
  const existing = githubJson(
    await githubRun(
      ctx,
      ['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number,url'],
      workspace.path,
    ),
    z.array(pullSchema),
  );
  let pull = existing[0];
  if (!pull) {
    // Signs in with the gh login or the ssh agent, never with what the repository config names.
    const pushed = await runGit(
      workspace.path,
      [
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        'push',
        'origin',
        `HEAD:refs/heads/${branch}`,
      ],
      undefined,
      true,
      {
        env: {
          GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
          ...(process.env.SSH_AUTH_SOCK === undefined
            ? {}
            : { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
        },
      },
    );
    requireThat(
      pushed.exit_code === 0,
      'git_failed',
      pushed.stderr.toString() || pushed.error || 'git push failed',
    );
    const created = await githubRun(
      ctx,
      [
        'pr',
        'create',
        '--base',
        workspace.source_branch,
        '--head',
        branch,
        '--title',
        input.title ?? session.title ?? '',
        '--body',
        '',
        ...(input.draft ? ['--draft'] : []),
      ],
      workspace.path,
    );
    pull = githubJson(
      await githubRun(ctx, ['pr', 'view', created.trim(), '--json', 'number,url'], workspace.path),
      pullSchema,
    );
  }
  const result = pull;
  return () => {
    const current = ctx.store.must<Session>('sessions', session.id);
    const next = ctx.store.update(
      'sessions',
      { ...current, pull_request: { number: result.number, url: result.url } },
      current.revision,
    );
    ctx.store.event('session.pr_created', next, next.project_id, result, command.command_id);
    return result;
  };
}
