import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DomainError,
  id,
  requireThat,
  type BoardPlan,
  type EffortLevel,
  type Principal,
  type Project,
  type Review,
  type ReviewFinding,
  type ReviewMetrics,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import { inputSchemas, type Command } from '@pantheon/protocol';
import { readBoundedSync, textLimit } from './files.js';
import { runtime } from './admission.js';
import {
  insert,
  inside,
  checkedPath,
  projectAccess,
  projectFolder,
  projectFolders,
  resolvedPath,
  revision,
  sessionPrincipal,
  userOnly,
  type ControlContext,
  type Handler,
  type Handlers,
} from './context.js';
import { sessionDefaults } from './user-config.js';
import { runGit } from './git.js';
import { mergeBase } from './merge-preview.js';
import { sessionGoal, sessionRangeAsync, type DiffRange } from './landing-diff.js';
import { confirmTermination } from './process.js';
import type { WrittenState } from './non-writer-audit.js';
import { closeReconciledSession } from './session.js';
import { assertManagedLocation } from './protection.js';
import { currentBinding, retiredBinding } from './board-plan.js';
import { appendNote, contractLines } from './lead-inbox.js';
import { wakeLead } from './task-tracking.js';
import { notifySession } from './session-wake.js';
import { REVIEW_MAX_ROUNDS, reopenReviewStep } from './merge-review.js';

export const REVIEW_WALL_TIME_MS = 2 * 60 * 60 * 1000;
export const reviewInstruction =
  'Review these changes against the task goal. Record each problem with review_finding; quote the diff exactly. End the review with one review_verdict call, pass or fail, with a summary of what you checked.';
const rangeInstruction = `${reviewInstruction} Write each finding's location as path:line in the changed file. The checkout in your working directory may not be the reviewed head; changes.diff is the reviewed code.`;
/** A finding location naming a file and a line or line range. */
const FINDING_PLACE = /^(.+?):(\d+)(?:-\d+)?$/;

/** The session, requester and goal of a review.request, once its permissions are checked. */
function reviewTarget(ctx: ControlContext, principal: Principal, command: Command) {
  const input = inputSchemas['review.request'].parse(command.input);
  const session = ctx.store.must<Session>('sessions', input.session_id);
  projectAccess(ctx, principal, session.project_id, command.type);
  revision(ctx, command);
  let requester: Review['requester'];
  let goal = sessionGoal(ctx, session);
  if (principal.role !== 'user') {
    requireThat(principal.role === 'lead', 'permission_denied', 'Owning lead required');
    const plan = ctx.store.get<BoardPlan>('board_plans', principal.session_id!);
    const task = session.task && plan?.tasks.find((task) => task.id === session.task!.id);
    requireThat(
      plan &&
        plan.project_id === session.project_id &&
        task &&
        session.workspace_id &&
        session.task &&
        session.task.lead_session_id === principal.session_id &&
        currentBinding(plan, session.task) &&
        !retiredBinding(plan, session),
      'permission_denied',
      'Review target must be a worker of your current board plan',
    );
    requireCrossReview(ctx, session, input.runtimes);
    requester = {
      lead_session_id: plan.id,
      task_id: task.id,
      generation: session.task!.generation ?? 1,
    };
    goal = contractLines(task).join('\n');
  }
  return { input, session, requester, goal };
}

/** The text the agent wrote after its last tool call in the turn. */
export function finalOutput(ctx: ControlContext, sessionId: string, turnId: string): string {
  const rows = ctx.store.db
    .prepare(
      "SELECT kind, payload ->> '$.text' AS text FROM events WHERE aggregate_id=? AND kind IN ('agent.message.delta', 'agent.tool.started') AND payload ->> '$.turn_id'=? ORDER BY sequence",
    )
    .all(sessionId, turnId) as { kind: string; text: string | null }[];
  let reply = '';
  for (const row of rows) reply = row.kind === 'agent.tool.started' ? '' : reply + (row.text ?? '');
  return reply.trim();
}

/** Refuses the writer's own runtime as a reviewer while another runtime can review. */
export function requireCrossReview(ctx: ControlContext, session: Session, runtimes: string[]) {
  const other = reviewerRuntime(ctx, session.project_id, session.runtime);
  requireThat(
    other === undefined ||
      other === session.runtime ||
      runtimes.every((name) => name !== session.runtime),
    'invalid_input',
    `Cross-review runtime must differ from the writer runtime ${session.runtime}; choose another runtime, such as ${other}`,
  );
}

/** A session's committed range and its diff; the caller has checked its access to the session. */
export async function sessionChanges(ctx: ControlContext, session: Session) {
  const range = await sessionRangeAsync(ctx, session);
  requireThat(
    range.from_sha !== range.to_sha,
    'invalid_state',
    'No committed changes to review; commit the changes first',
  );
  // Reading this one artifact does not grant the caller the general workspace.read capability.
  const source = checkedPath(
      ctx,
      ctx.store.must<Project>('projects', session.project_id),
      range.source,
    ),
    diff = await runGit(
      source,
      ['diff', '--no-color', '--no-ext-diff', range.from_sha, range.to_sha],
      undefined,
      true,
    );
  requireThat(
    diff.exit_code === 0,
    'git_failed',
    diff.stderr.toString().trim() || diff.error || 'Git diff failed',
  );
  return { range, diff: diff.stdout };
}

/** Refuses a requested reviewer already reviewing the session. */
export function requireNoRunningReviewer(
  ctx: ControlContext,
  session: Session,
  runtimes: string[],
) {
  const duplicate = ctx.store
    .list<Review>('reviews')
    .find(
      (review) =>
        review.session_id === session.id &&
        review.state === 'running' &&
        review.runtimes.some((name) => runtimes.includes(name)),
    );
  requireThat(!duplicate, 'resource_busy', 'A requested reviewer is already reviewing this worker');
}

/** Starts the next review round of a session's committed changes, within the round limit. */
export function startSessionReview(
  ctx: ControlContext,
  session: Session,
  runtimes: string[],
  options: {
    cause: string;
    goal: string;
    changes: Awaited<ReturnType<typeof sessionChanges>>;
    requester?: Review['requester'];
    notify_session_id?: string;
  },
): Review {
  const round =
    ctx.store.list<Review>('reviews').filter((review) => review.session_id === session.id).length +
    1;
  const maxRounds = REVIEW_MAX_ROUNDS;
  requireThat(
    round <= maxRounds,
    'invalid_state',
    `Code review limit reached: at most ${maxRounds} rounds per reviewed session (${session.id}).`,
  );
  const { diff, range } = options.changes;
  return startReview(ctx, session.project_id, runtimes, {
    round,
    cause: options.cause,
    prompt: `${reviewInstruction}\n\nTask goal:\n${options.goal}\n\nChanges:\n${diff.toString('utf8')}`,
    artifact: { name: 'changes.diff', content: diff },
    session_id: session.id,
    requester: options.requester,
    notify_session_id: options.notify_session_id,
    range,
  });
}

/** review.request; the session's range and its diff are read before the transaction. */
export function prepareReviewRequest(
  ctx: ControlContext,
  principal: Principal,
  command: Command,
): Promise<Handler> {
  const { session } = reviewTarget(ctx, principal, command);
  return (async () => {
    const changes = await sessionChanges(ctx, session);
    return (ctx: ControlContext, principal: Principal, command: Command) => {
      const { input, session, requester, goal } = reviewTarget(ctx, principal, command);
      if (requester) {
        const step = reopenReviewStep(ctx, session);
        if (step) return step;
        requireNoRunningReviewer(ctx, session, input.runtimes);
      }
      const review = startSessionReview(ctx, session, input.runtimes, {
        cause: command.command_id,
        goal,
        changes,
        requester,
      });
      return { ...review, review_id: review.id };
    };
  })();
}

/** The real path of a root the caller named and the project that lists it, once the principal may act there. */
export function projectAtRoot(
  ctx: ControlContext,
  principal: Principal,
  named: string,
  action: string,
) {
  let root = '';
  try {
    root = realpathSync(named);
  } catch {
    // A missing root is reported below like any root of no project.
  }
  const project = ctx.store
    .list<Project>('projects')
    .find((candidate) => candidate.removed_at === undefined && candidate.roots.includes(root));
  requireThat(project, 'not_found', `${named} is not a project root`);
  projectAccess(ctx, principal, project.id, action);
  return { root, project };
}

/** The input, real root and project of a review.range, once its permissions are checked. */
function rangeTarget(ctx: ControlContext, principal: Principal, command: Command) {
  userOnly(principal);
  const input = inputSchemas['review.range'].parse(command.input);
  const { root, project } = projectAtRoot(ctx, principal, input.root, command.type);
  revision(ctx, command);
  return { input, root, project };
}

export async function commitOf(root: string, ref: string): Promise<string> {
  const result = await runGit(
    root,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    undefined,
    true,
  );
  requireThat(result.exit_code === 0, 'invalid_input', `Not a commit: ${ref}`);
  return result.stdout.toString().trim();
}

/** review.range; the refs, their merge base, the diff and the commit messages are read before the transaction. */
export function prepareRangeReview(
  ctx: ControlContext,
  principal: Principal,
  command: Command,
): Promise<Handler> {
  const { input, root } = rangeTarget(ctx, principal, command);
  const head = input.head ?? 'HEAD';
  return (async () => {
    const to_sha = await commitOf(root, head),
      from_sha = await mergeBase(root, await commitOf(root, input.base), to_sha);
    requireThat(from_sha, 'invalid_input', `${input.base} and ${head} share no history`);
    requireThat(
      from_sha !== to_sha,
      'invalid_input',
      `No committed changes to review between ${input.base} and ${head}`,
    );
    const [diff, log] = await Promise.all([
      runGit(root, ['diff', '--no-color', '--no-ext-diff', from_sha, to_sha], undefined, true),
      runGit(root, ['log', '--format=%B', `${from_sha}..${to_sha}`], undefined, true),
    ]);
    for (const result of [diff, log])
      requireThat(
        result.exit_code === 0,
        'git_failed',
        result.stderr.toString().trim() || result.error || 'Git failed',
      );
    const goal = log.stdout.toString('utf8').slice(0, 2000);
    return (ctx: ControlContext, principal: Principal, command: Command) => {
      const { input, project } = rangeTarget(ctx, principal, command);
      const busy = ctx.store
        .list<Review>('reviews')
        .some(
          (review) =>
            review.state === 'running' &&
            review.refs &&
            review.range?.from_sha === from_sha &&
            review.range.to_sha === to_sha,
        );
      requireThat(!busy, 'resource_busy', 'This range is already under review');
      const reviewer = input.runtimes ? undefined : reviewerRuntime(ctx, project.id, '');
      requireThat(
        input.runtimes || reviewer,
        'unsupported_capability',
        'No runtime can run a read-only review',
      );
      const review = startReview(ctx, project.id, input.runtimes ?? [reviewer!], {
        round: 1,
        cause: command.command_id,
        prompt: `${rangeInstruction}\n\nTask goal:\n${goal}\n\nChanges:\n${diff.stdout.toString('utf8')}`,
        artifact: { name: 'changes.diff', content: diff.stdout },
        range: { source: root, from_sha, to_sha },
        refs: { base: input.base, head },
      });
      return { ...review, review_id: review.id };
    };
  })();
}

export const reviewHandlers: Handlers = {
  'review.finding': (ctx, principal, command) => {
    requireThat(principal.role === 'reviewer', 'permission_denied', 'Reviewer session required');
    const session = sessionPrincipal(ctx, principal);
    projectAccess(ctx, principal, session.project_id, command.type);
    revision(ctx, command);
    const finding = recordFinding(
      ctx,
      session,
      inputSchemas['review.finding'].parse(command.input),
    );
    requireThat(finding, 'invalid_state', 'Review is not accepting findings');
    return finding.status === 'rejected'
      ? { error: finding.reason ?? finding.artifact_error, finding }
      : finding;
  },
  'review.verdict': (ctx, principal, command) => {
    requireThat(principal.role === 'reviewer', 'permission_denied', 'Reviewer session required');
    const session = sessionPrincipal(ctx, principal);
    projectAccess(ctx, principal, session.project_id, command.type);
    revision(ctx, command);
    const input = inputSchemas['review.verdict'].parse(command.input);
    const review = session.review_id
      ? ctx.store.must<Review>('reviews', session.review_id)
      : undefined;
    requireThat(
      review?.state === 'running' && review.session_ids.includes(session.id),
      'invalid_state',
      'Review is not accepting verdicts',
    );
    const verdict = {
      session_id: session.id,
      runtime: session.runtime,
      ...input,
      at: ctx.store.now(),
    };
    const next = ctx.store.update<Review>(
      'reviews',
      {
        ...review,
        verdicts: [
          ...(review.verdicts ?? []).filter(
            (given) => given !== reviewerVerdict(review, session.id, session.runtime),
          ),
          verdict,
        ],
      },
      review.revision,
    );
    ctx.store.event(
      'review.verdict_recorded',
      next,
      review.project_id,
      verdict,
      command.command_id,
    );
    return verdict;
  },
  'review.finding.resolve': (ctx, principal, command) => {
    requireThat(
      principal.role === 'user',
      'permission_denied',
      'Resolving review findings requires user authority',
    );
    const input = inputSchemas['review.finding.resolve'].parse(command.input),
      review = ctx.store.must<Review>('reviews', input.review_id);
    projectAccess(ctx, principal, review.project_id, command.type);
    revision(ctx, command, review);
    const finding = review.findings.find((item) => item.id === input.finding_id);
    requireThat(finding, 'not_found', 'Review finding not found');
    requireThat(
      finding.status === 'open' && !finding.resolution,
      'invalid_state',
      'Review finding cannot be resolved',
    );
    const resolution: NonNullable<ReviewFinding['resolution']> = {
      outcome: input.outcome,
      ...(input.note === undefined ? {} : { note: input.note }),
      resolved_at: ctx.store.now(),
      resolved_by: principal.id,
    };
    const next = ctx.store.update<Review>(
      'reviews',
      {
        ...review,
        findings: review.findings.map((item) =>
          item.id === finding.id ? { ...item, resolution } : item,
        ),
      },
      review.revision,
    );
    ctx.store.event(
      'review.finding_resolved',
      next,
      review.project_id,
      { finding_id: finding.id, outcome: input.outcome },
      command.command_id,
    );
    return next;
  },
};

/** Review timing comes from its own events, independently of the worker's lifetime. */
export function reviewTimeReader(ctx: ControlContext, projectId: string) {
  const times = new Map<string, Pick<Review, 'started_at' | 'ended_at'>>();
  for (const event of ctx.store.kindEvents(projectId, [
    'review.requested',
    'review.completed',
    'review.failed',
  ])) {
    const time = times.get(event.aggregate_id) ?? {};
    if (event.kind === 'review.requested') time.started_at = event.created_at;
    else time.ended_at = event.created_at;
    times.set(event.aggregate_id, time);
  }
  return (review: Review) => times.get(review.id) ?? {};
}

/** Read live execution coverage independently of the aggregate review state. */
export function reviewExecutionReader(ctx: ControlContext, projectId: string) {
  const sessions = new Map(
    ctx.store
      .list<Session>('sessions')
      .filter((session) => session.project_id === projectId)
      .map((session) => [session.id, session]),
  );
  const turns = new Map<string, SessionTurn>();
  for (const turn of ctx.store.list<SessionTurn>('session_turns'))
    if (turn.project_id === projectId && turn.kind === 'send' && !turn.rolled_back)
      turns.set(turn.session_id, turn);
  const errors = new Map<string, string>();
  for (const event of ctx.store.kindEvents(projectId, ['turn.failed', 'turn.cancelled'])) {
    const error = (event.payload as { error?: unknown } | undefined)?.error;
    if (typeof error === 'string') errors.set(event.aggregate_id, error.slice(0, 500));
  }
  return (review: Review): NonNullable<Review['executions']> =>
    review.runtimes.map((name, index) => {
      const session = review.session_ids
        .map((id) => sessions.get(id))
        .find((session) => session?.runtime === name);
      const turn = session && turns.get(session.id);
      const error = turn && (errors.get(turn.id) ?? turn.delivery_reason);
      return {
        runtime: name,
        session_id: session?.id ?? review.session_ids[index],
        state: turn?.state ?? 'unknown',
        ...(error ? { error: error.slice(0, 500) } : {}),
      };
    });
}

export function projectReviewMetrics(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): ReviewMetrics[] {
  projectAccess(ctx, principal, projectId, 'project.review.metrics');
  ctx.store.must<Project>('projects', projectId);
  const reviews = ctx.store
    .list<Review>('reviews')
    .filter((review) => review.project_id === projectId);
  const rows = new Map<string, ReviewMetrics>();
  for (const review of reviews) {
    for (const name of review.runtimes) {
      let row = rows.get(name);
      if (!row)
        rows.set(
          name,
          (row = {
            runtime: name,
            reviews: 0,
            reviews_without_findings: 0,
            findings: 0,
            adopted: 0,
            dismissed: 0,
            unresolved: 0,
            invalid: 0,
          }),
        );
      row.reviews++;
      let valid = 0;
      for (const finding of review.findings) {
        if (finding.runtime !== name) continue;
        row.findings++;
        if (finding.status === 'rejected') {
          row.invalid++;
          continue;
        }
        valid++;
        if (finding.resolution?.outcome === 'adopted') row.adopted++;
        else if (finding.resolution?.outcome === 'dismissed') row.dismissed++;
        else if (finding.status === 'open') row.unresolved++;
      }
      if (valid === 0) row.reviews_without_findings++;
    }
  }
  return [...rows.values()].sort((a, b) => a.runtime.localeCompare(b.runtime));
}

function boundedInput(input: string): string {
  const bytes = Buffer.from(input);
  if (bytes.length <= textLimit) return input;
  let end = textLimit;
  for (;;) {
    const suffix = `\n[${bytes.length - end} bytes omitted]\n`;
    let next = Math.min(end, textLimit - Buffer.byteLength(suffix));
    while (next > 0 && (bytes[next]! & 0xc0) === 0x80) next--;
    if (next === end) return bytes.subarray(0, end).toString('utf8') + suffix;
    end = next;
  }
}

/** The directory a reviewer session reads the reviewed changes from, in the project folder holding its review. */
export function reviewerDirectory(
  ctx: ControlContext,
  projectId: string,
  reviewId: string,
  sessionId: string,
): string {
  if (!ctx.workspaceRoot)
    return path.resolve(path.dirname(ctx.files.directory), 'reviews', reviewId, sessionId);
  const folder =
    projectFolders(ctx, projectId).find((candidate) =>
      existsSync(path.join(candidate, 'reviews', reviewId)),
    ) ?? projectFolder(ctx, projectId);
  return resolvedPath(path.join(folder, 'reviews', reviewId, sessionId));
}

/**
 * The role's choice, else the project's single model, with its fallback on admission failure;
 * otherwise the first admitted reviewer runtime other than the writer's, then the writer's own.
 * A review on the writer's runtime still runs in its own read-only session.
 */
export function reviewerRuntime(
  ctx: ControlContext,
  projectId: string,
  writerRuntime: string,
): string | undefined {
  const admitted = (name: string) => {
    try {
      runtime(ctx, name, 'reviewer');
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  };
  const defaults = sessionDefaults(ctx, ctx.store.must<Project>('projects', projectId));
  const preferred = defaults?.reviewer ?? (defaults?.single_model ? defaults : undefined);
  if (preferred && admitted(preferred.runtime)) return preferred.runtime;
  const fallback = defaults?.fallbacks?.reviewer;
  if (preferred && fallback && admitted(fallback.runtime)) return fallback.runtime;
  return (
    [...ctx.adapters.keys()].find((name) => name !== writerRuntime && admitted(name)) ??
    (admitted(writerRuntime) ? writerRuntime : undefined)
  );
}

/** The verdict a reviewer session handed in last. */
export function reviewerVerdict(
  review: Review,
  sessionId: string,
  runtime: string | undefined,
): NonNullable<Review['verdicts']>[number] | undefined {
  return review.verdicts?.find((verdict) =>
    verdict.session_id === undefined
      ? verdict.runtime === runtime
      : verdict.session_id === sessionId,
  );
}

/** Reviews the artifact in read-only reviewer sessions; the caller commits the database work. */
export function startReview(
  ctx: ControlContext,
  projectId: string,
  names: string[],
  options: {
    round: number;
    cause: string;
    prompt: string;
    /** The file each reviewer reads from its directory. */
    artifact: { name: string; content: Buffer };
    session_id?: string;
    requester?: Review['requester'];
    notify_session_id?: string;
    range?: NonNullable<Review['range']>;
    refs?: Review['refs'];
    /** Overrides the session defaults' model and effort of every reviewer session. */
    choice?: { model?: string; effort?: EffortLevel };
  },
): Review {
  const project = ctx.store.must<Project>('projects', projectId),
    runtimes = [...new Set(names)],
    cause = options.cause,
    review: Review = {
      id: id(),
      revision: 1,
      project_id: project.id,
      ...(options.session_id ? { session_id: options.session_id } : {}),
      ...(options.range ? { range: options.range } : {}),
      ...(options.refs ? { refs: options.refs } : {}),
      ...(options.requester ? { requester: options.requester } : {}),
      ...(options.notify_session_id ? { notify_session_id: options.notify_session_id } : {}),
      round: options.round,
      runtimes,
      state: 'running',
      findings: [],
      session_ids: [],
    };
  for (const name of runtimes) runtime(ctx, name, 'reviewer');
  // Findings are checked against the stored input.
  const prompt = boundedInput(options.prompt);
  review.input_hash = ctx.files.put(Buffer.from(prompt)).hash;
  // The normal outbox starts the turns.
  const directories: string[] = [];
  for (const name of runtimes) {
    const settings = sessionDefaults(ctx, project);
    const defaults = [settings?.reviewer, settings?.fallbacks?.reviewer, settings].find(
      (choice) => choice?.runtime === name,
    );
    // A default effort may not fit a chosen model, so a chosen model takes only the chosen effort.
    const model = options.choice?.model ?? defaults?.model,
      effort =
        options.choice?.model !== undefined
          ? options.choice.effort
          : (options.choice?.effort ?? defaults?.effort);
    const reviewer: Session = {
      id: id(),
      revision: 1,
      project_id: project.id,
      runtime: name,
      ...(model !== undefined ? { requested_model: model } : {}),
      ...(effort !== undefined ? { requested_effort: effort } : {}),
      review_id: review.id,
      state: 'running',
      turn_count: 1,
    };
    const directory = reviewerDirectory(ctx, project.id, review.id, reviewer.id);
    if (ctx.workspaceRoot) {
      assertManagedLocation(directory);
      requireThat(
        inside(ctx.workspaceRoot, directory),
        'scope_violation',
        'Reviewer path outside managed workspace root',
      );
    }
    directories.push(directory);
    insert(ctx, 'sessions', reviewer, 'session.opened', project.id, cause);
    const turn: SessionTurn = {
      id: id(),
      revision: 1,
      project_id: project.id,
      session_id: reviewer.id,
      model: reviewer.reported_model ?? reviewer.requested_model ?? null,
      input: prompt,
      kind: 'send',
      delivery: 'pending',
      state: 'queued',
    };
    insert(ctx, 'session_turns', turn, 'turn.queued', project.id, cause);
    ctx.store.enqueue('session.turn', { turn_id: turn.id });
    review.session_ids.push(reviewer.id);
  }
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, options.artifact.name), options.artifact.content, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  insert(ctx, 'reviews', review, 'review.requested', project.id, cause);
  return review;
}

/** The caller owns the transaction and command or native event deduplication. */
export function recordFinding(
  ctx: ControlContext,
  session: Session,
  input: ReturnType<(typeof inputSchemas)['review.finding']['parse']> | undefined,
): ReviewFinding | undefined {
  if (!session.review_id) return;
  const review = ctx.store.must<Review>('reviews', session.review_id);
  if (review.state !== 'running' || !review.session_ids.includes(session.id)) return;
  const finding: ReviewFinding = {
    id: id(),
    review_id: review.id,
    runtime: session.runtime,
    round: review.round,
    ...(input ?? { location: '', quote: '', evidence: '', impact: '', blocking: false }),
    status: 'open',
  };
  if (!input) {
    finding.status = 'rejected';
    finding.reason = 'incomplete_finding';
  } else {
    try {
      let inputBytes: Buffer | undefined;
      if (review.input_hash !== undefined) {
        requireThat(
          /^[a-f0-9]{64}$/.test(review.input_hash),
          'hash_mismatch',
          'Invalid review input hash',
        );
        inputBytes = readBoundedSync(path.join(ctx.files.directory, review.input_hash), textLimit);
        requireThat(
          createHash('sha256').update(inputBytes).digest('hex') === review.input_hash,
          'hash_mismatch',
          'Stored review input bytes changed',
        );
      }
      if (!inputBytes?.includes(Buffer.from(finding.quote))) {
        finding.status = 'rejected';
        finding.reason = 'quote_not_in_artifact';
      }
    } catch {
      finding.status = 'rejected';
      finding.artifact_error = 'artifact_unavailable';
    }
  }
  if (review.refs && !FINDING_PLACE.test(finding.location)) {
    finding.blocking = false;
    finding.unlocated = true;
  }
  const next = ctx.store.update(
    'reviews',
    { ...review, findings: [...review.findings, finding] },
    review.revision,
  );
  ctx.store.event('review.finding_recorded', next, review.project_id, finding);
  // The reviewed session may have committed past the reviewed range before this finding arrived.
  const reviewed =
    finding.status === 'open' && review.session_id
      ? ctx.store.get<Session>('sessions', review.session_id)
      : undefined;
  if (reviewed) markStaleFindings(ctx, reviewed);
  return ctx.store
    .must<Review>('reviews', review.id)
    .findings.find((item) => item.id === finding.id);
}

const openFinding = (finding: ReviewFinding) => finding.status === 'open' && !finding.resolution;

const reviewsWithOpenFindings = (ctx: ControlContext, sessionId: string) =>
  ctx.store
    .list<Review>('reviews')
    .filter(
      (review) =>
        review.session_id === sessionId && review.range && review.findings.some(openFinding),
    );

/**
 * Marks stale the open, unresolved findings on the session's reviews whose quote is no longer in
 * the diff of its current range, once its head moved past the reviewed range. Git runs in the
 * background, so the marks come later, in a transaction of their own.
 */
export function markStaleFindings(ctx: ControlContext, session: Session): void {
  if (session.review_id || !reviewsWithOpenFindings(ctx, session.id).length) return;
  const work: Promise<void> = staleFindings(ctx, session).finally(() =>
    ctx.completions.delete(work),
  );
  ctx.completions.add(work);
}

/** The files open findings name as `path:line`; undefined when one names none, so all are read. */
function findingFiles(reviews: Review[]): string[] | undefined {
  const files = new Set<string>();
  for (const finding of reviews.flatMap((review) => review.findings.filter(openFinding))) {
    const place = FINDING_PLACE.exec(finding.location);
    if (!place) return undefined;
    files.add(place[1]!);
  }
  return [...files];
}

async function staleFindings(ctx: ControlContext, session: Session): Promise<void> {
  let range: DiffRange, source: string;
  try {
    range = await sessionRangeAsync(ctx, session);
    source = checkedPath(
      ctx,
      ctx.store.must<Project>('projects', session.project_id),
      range.source,
    );
  } catch (error) {
    // With no range to read, the findings stay as they are.
    if (error instanceof DomainError) return;
    throw error;
  }
  const moved = reviewsWithOpenFindings(ctx, session.id).filter(
    (review) => review.range!.to_sha !== range.to_sha,
  );
  if (!moved.length) return;
  // A finding recorded meanwhile may name a file this diff leaves out; its own recording checks it.
  const checked = new Set(
    moved.flatMap((review) => review.findings.filter(openFinding).map((finding) => finding.id)),
  );
  const files = findingFiles(moved);
  const diff = await runGit(
    source,
    [
      '--literal-pathspecs',
      'diff',
      '--no-color',
      '--no-ext-diff',
      range.from_sha,
      range.to_sha,
      ...(files ? ['--', ...files] : []),
    ],
    undefined,
    true,
  );
  if (diff.exit_code !== 0 || ctx.closing) return;
  ctx.store.transaction(() => {
    for (const { id: reviewId } of moved) {
      const review = ctx.store.must<Review>('reviews', reviewId);
      const stale = review.findings.filter(
        (finding) =>
          checked.has(finding.id) &&
          openFinding(finding) &&
          !diff.stdout.includes(Buffer.from(finding.quote)),
      );
      if (!stale.length) continue;
      const next = ctx.store.update<Review>(
        'reviews',
        {
          ...review,
          findings: review.findings.map((finding) =>
            stale.includes(finding) ? { ...finding, status: 'stale' as const } : finding,
          ),
        },
        review.revision,
      );
      for (const finding of stale)
        ctx.store.event('review.finding_marked_stale', next, review.project_id, {
          finding_id: finding.id,
          to_sha: range.to_sha,
        });
    }
  });
  ctx.changed();
}

/** `reconciled` holds the tracked state of the review's reconciling sessions, read before the transaction. */
export function settleReview(
  ctx: ControlContext,
  reviewId: string,
  recovering = false,
  reconciled: ReadonlyMap<string, WrittenState> = new Map(),
): void {
  const review = ctx.store.must<Review>('reviews', reviewId);
  if (recovering) {
    for (const sessionId of review.session_ids) {
      const session = ctx.store.get<Session>('sessions', sessionId);
      if (!session || session.state !== 'reconciling') continue;
      try {
        confirmTermination(ctx, session);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'termination_unconfirmed') continue;
        throw error;
      }
      closeReconciledSession(ctx, session, reconciled.get(session.id));
    }
  }
  if (review.state !== 'running') return;
  const turns = ctx.store.list<SessionTurn>('session_turns');
  const states = review.session_ids.map((sessionId) => {
    const session = ctx.store.get<Session>('sessions', sessionId);
    const turn = turns.find((t) => t.session_id === sessionId);
    return session && turn ? turn.state : 'failed';
  });
  // A failed reviewer fails only itself; the review settles once every reviewer has ended.
  const state = recovering
    ? states.every((s) => s === 'completed')
      ? 'completed'
      : 'failed'
    : states.some((s) => s === 'queued' || s === 'running')
      ? 'running'
      : states.some((s) => s === 'completed')
        ? 'completed'
        : 'failed';
  if (state === 'running') return;
  const incomplete = state === 'completed' ? incompleteReason(ctx, review, turns) : undefined;
  const next = ctx.store.update<Review>(
    'reviews',
    { ...review, state, ...(incomplete ? { incomplete } : {}) },
    review.revision,
  );
  ctx.store.event(
    `review.${state}`,
    next,
    review.project_id,
    recovering ? { reason: 'daemon_restart' } : {},
  );
  ctx.store.enqueue('review.remove', { review_id: review.id });
  notifyRequestingLead(ctx, next, turns);
  notifyRequestingSession(ctx, next, turns);
}

/** Why a reviewer gave no full result: its turn did not complete, it could not read the input, or it left no verdict, finding or reply. */
function incompleteReason(
  ctx: ControlContext,
  review: Review,
  turns: SessionTurn[],
): string | undefined {
  const reasons = review.session_ids.flatMap((sessionId) => {
    const name = ctx.store.get<Session>('sessions', sessionId)?.runtime ?? sessionId,
      turn = turns.find((t) => t.session_id === sessionId),
      findings = review.findings.filter((finding) => finding.runtime === name);
    if (turn?.state !== 'completed') return [`reviewer ${name} ${turn?.state ?? 'failed'}`];
    if (findings.some((finding) => finding.artifact_error))
      return [`reviewer ${name} could not read the review input`];
    if (
      !reviewerVerdict(review, sessionId, name) &&
      !findings.some((finding) => finding.status !== 'rejected') &&
      !finalOutput(ctx, sessionId, turn.id)
    )
      return [`reviewer ${name} ended its turn with no finding and no reply`];
    return [];
  });
  return reasons.length ? reasons.join('; ') : undefined;
}

/** Each reviewer's outcome and verdict, then the open findings with their locations. */
function reviewResults(ctx: ControlContext, review: Review, turns: SessionTurn[]): string[] {
  return [
    ...review.session_ids.map((sessionId) => {
      const session = ctx.store.get<Session>('sessions', sessionId);
      const turn = turns.find((turn) => turn.session_id === sessionId);
      const runtime = session?.runtime ?? sessionId,
        state = turn?.state ?? 'failed',
        given = reviewerVerdict(review, sessionId, runtime);
      return `Reviewer ${runtime}: ${state}.${given ? ` Verdict ${given.verdict}: ${given.summary}` : state === 'completed' ? ' No verdict given.' : ''}`;
    }),
    ...(review.incomplete ? [`Incomplete: ${review.incomplete}.`] : []),
    'Only findings whose quotes match the supplied artifact follow. Failed or cancelled reviewers are not a clean review.',
    ...review.findings
      .filter((finding) => finding.status === 'open')
      .map(
        (finding) =>
          `${finding.runtime} ${finding.location} (${finding.blocking ? 'must fix before merge' : 'report-only'})\nQuote: ${finding.quote}\nEvidence: ${finding.evidence}\nImpact: ${finding.impact}${finding.reproduction === undefined ? '' : `\nReproduction: ${JSON.stringify(finding.reproduction)}`}`,
      ),
  ];
}

/** A review a session asked for returns to that session as a message, not through a lead's inbox. */
function notifyRequestingSession(ctx: ControlContext, review: Review, turns: SessionTurn[]): void {
  if (!review.notify_session_id) return;
  const blocking = review.findings.some((finding) => finding.status === 'open' && finding.blocking);
  const lines = [
    `[Pantheon] Review ${review.id}: ${review.state}. Reviewed session ${review.session_id}.`,
    ...(review.range
      ? [`Reviewed commits: ${review.range.from_sha}..${review.range.to_sha}.`]
      : []),
    ...reviewResults(ctx, review, turns),
    ...(blocking
      ? ['report_ready is refused until a later review has no open blocking findings.']
      : []),
  ];
  notifySession(ctx, review.notify_session_id, lines.join('\n'), '');
}

/** Durable review results return to the owning plan; a transfer routes them to its new lead. */
function notifyRequestingLead(ctx: ControlContext, review: Review, turns: SessionTurn[]): void {
  const requester = review.requester;
  // The workflow engine settles its own review step, and a milestone verification its review.
  if (!requester || requester.step_run_id || requester.milestone_id) return;
  let lead = requester.lead_session_id;
  const visited = new Set<string>();
  const transfers = ctx.store.kindEvents(review.project_id, ['board.plan_transferred']);
  while (!visited.has(lead)) {
    visited.add(lead);
    const moved = transfers.findLast((event) => (event.payload as { from?: string }).from === lead);
    if (!moved) break;
    lead = moved.aggregate_id;
  }
  const plan = ctx.store.get<BoardPlan>('board_plans', lead);
  if (!plan || plan.project_id !== review.project_id) return;
  const results = reviewResults(ctx, review, turns);
  const lines = [
    `Review ${review.id}: ${review.state}. Worker ${review.session_id}; task generation ${requester.generation}.`,
    ...(review.range
      ? [`Reviewed commits: ${review.range.from_sha}..${review.range.to_sha}.`]
      : []),
    ...results,
    'This review covers the recorded commits only. Re-read current task and session state before deciding; request fixes with message_task. Review completion does not accept the task or merge it.',
  ];
  const next = appendNote(ctx, plan, {
    at: ctx.store.now(),
    session_id: review.session_id ?? '',
    task_id: requester.task_id!,
    generation: requester.generation,
    kind: review.state === 'completed' ? 'review_completed' : 'review_failed',
    text: lines.join('\n'),
  });
  wakeLead(ctx, next, '');
}
