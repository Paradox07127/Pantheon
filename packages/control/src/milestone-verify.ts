import {
  DomainError,
  id,
  type BoardPlan,
  type Milestone,
  type MilestoneVerification,
  type MilestoneVerificationReason,
  type Project,
  type Review,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import { taskSessions } from './board-plan.js';
import { rootOf, type ControlContext } from './context.js';
import { runGit } from './git.js';
import { checkCandidate, gateFailed } from './landing.js';
import { appendNote, contractLines } from './lead-inbox.js';
import { commitmentHash, milestoneView } from './project-facts.js';
import { reviewerVerdict, startReview } from './review.js';
import { verifierRuntime } from './runtime-vendor.js';
import { wakeLead } from './task-tracking.js';
import { afterCommit } from './workbench-session.js';
import { workflowPolicy } from './workflow-policy.js';

type GateCommands = NonNullable<Project['gates']>[string];
type GateResults = NonNullable<Awaited<ReturnType<typeof checkCandidate>>>;
type Task = BoardPlan['tasks'][number];

const verifierInstruction =
  'Verify that the merged changes below meet this milestone: read them against its criteria and the contract of each task. The checks listed already ran on the merged code in a fresh clone. Record each problem with review_finding; quote the diff exactly. End the review with one review_verdict call, pass or fail, with a summary of what you checked.';

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args, undefined, true);
  if (result.exit_code !== 0)
    throw new Error(result.stderr.toString().trim() || result.error || 'Git command failed');
  return result.stdout.toString();
}

const INDEPENDENCE: Record<NonNullable<MilestoneVerification['independence']>, string> = {
  other_vendor: 'another vendor',
  other_runtime: 'another runtime of an unknown vendor',
  same_runtime: "the writers' own runtime",
};
const OUTPUT_TAIL_LIMIT = 600;

/** What the lead's note says about a verification that ended. */
function verifiedText(milestone: Milestone, row: MilestoneVerification): string {
  return [
    `Verification ${row.id} of milestone ${milestone.key} "${milestone.title}": ${row.state}.${
      row.runtime
        ? ` Checked on ${row.runtime}${row.independence ? `, ${INDEPENDENCE[row.independence]}` : ''}.`
        : ''
    }`,
    ...row.commands
      .filter((command) => command.exit_code !== 0)
      .map(
        (command) =>
          `Failed: ${command.name} (exit ${command.exit_code})\n${command.output_tail.slice(-OUTPUT_TAIL_LIMIT)}`,
      ),
    ...(row.verdict ? [`Verdict ${row.verdict.verdict}: ${row.verdict.summary}`] : []),
    ...(row.reason && row.reason !== row.verdict?.summary ? [`Reason: ${row.reason}`] : []),
    ...(row.state === 'failed'
      ? ['Propose fix tasks under this milestone with propose_board, citing this evidence.']
      : []),
  ].join('\n');
}

/** Ends the row and tells the milestone's lead, waking it. */
function finish(
  ctx: ControlContext,
  row: MilestoneVerification,
  end:
    | { state: 'passed' }
    | { state: 'failed' | 'inconclusive'; reason_code: MilestoneVerificationReason },
  fields: Omit<Partial<MilestoneVerification>, 'reason_code'> = {},
): void {
  const next = ctx.store.update<MilestoneVerification>(
    'milestone_verifications',
    { ...row, ...fields, ...end, finished_at: ctx.store.now() },
    row.revision,
  );
  ctx.store.event('milestone.verified', next, next.project_id, next);
  const milestone = ctx.store.must<Milestone>('milestones', next.milestone_id),
    plan = ctx.store.get<BoardPlan>('board_plans', milestone.owner_session_id!);
  if (!plan) return;
  const noted = appendNote(ctx, plan, {
    at: ctx.store.now(),
    session_id: '',
    task_id: '',
    kind: 'milestone_verified',
    text: verifiedText(milestone, next),
  });
  wakeLead(ctx, noted, '');
}

/**
 * Per source root the milestone's merged sessions landed in: its branch, their bases, and the
 * root's enabled gate followed by the acceptance of the tasks that landed there.
 */
function landedRoots(
  ctx: ControlContext,
  project: Project,
  tasks: { task: Task; sessions: Session[] }[],
) {
  const roots = new Map<string, { branch: string; bases: string[]; acceptance: string[] }>();
  for (const { task, sessions } of tasks)
    for (const session of sessions) {
      const workspace =
        session.outcome === 'merged' && session.workspace_id
          ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
          : undefined;
      if (!workspace?.source) continue;
      let root = roots.get(workspace.source);
      if (!root)
        roots.set(
          workspace.source,
          (root = { branch: workspace.source_branch ?? 'HEAD', bases: [], acceptance: [] }),
        );
      if (workspace.base_sha) root.bases.push(workspace.base_sha);
      for (const command of task.acceptance)
        if (!root.acceptance.includes(command)) root.acceptance.push(command);
    }
  return [...roots].map(([source, root]) => {
    const folder = rootOf(project, [source]);
    const commands: GateCommands = [
      ...((folder && project.gates?.[folder]?.filter((command) => command.enabled !== false)) ||
        []),
      ...root.acceptance.map((command) => ({ name: command, argv: ['/bin/sh', '-c', command] })),
    ];
    return { source, branch: root.branch, bases: root.bases, commands };
  });
}

/** Starts the verifier review of checks that all passed; the caller owns the transaction. */
function startVerifier(
  ctx: ControlContext,
  milestone: Milestone,
  tasks: { task: Task; sessions: Session[] }[],
  row: MilestoneVerification,
  diff: string,
): void {
  const writers = [...new Set(tasks.flatMap(({ sessions }) => sessions.map((s) => s.runtime)))];
  const chosen = verifierRuntime(ctx, row.project_id, writers);
  if (!chosen)
    return finish(
      ctx,
      row,
      { state: 'inconclusive', reason_code: 'no_verifier_runtime' },
      { reason: 'no runtime can verify' },
    );
  const prompt = [
    verifierInstruction,
    `Milestone: ${milestone.title}`,
    ['Criteria:', ...milestone.criteria.map((criterion) => `- ${criterion}`)].join('\n'),
    ...tasks.map(({ task }) => [`Task ${task.id}:`, ...contractLines(task)].join('\n')),
    [
      'Checks run on the merged code:',
      ...row.commands.map((command) => `- ${command.name}: exit ${command.exit_code}`),
    ].join('\n'),
    `Changes:\n${diff}`,
  ].join('\n\n');
  try {
    const review = startReview(ctx, row.project_id, [chosen.runtime], {
      round: 1,
      cause: '',
      prompt,
      artifact: { name: 'milestone.diff', content: Buffer.from(diff) },
      requester: { lead_session_id: milestone.owner_session_id!, milestone_id: milestone.id },
    });
    ctx.store.update<MilestoneVerification>(
      'milestone_verifications',
      { ...row, review_id: review.id, ...chosen },
      row.revision,
    );
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    finish(
      ctx,
      row,
      { state: 'inconclusive', reason_code: 'review_not_started' },
      { reason: error.message },
    );
  }
}

/** Runs the checks of each root on its head in a fresh clone, then starts the verifier review. */
function checkMilestone(ctx: ControlContext, milestone: Milestone, row: MilestoneVerification) {
  const plan = ctx.store.must<BoardPlan>('board_plans', milestone.owner_session_id!);
  const tasks = (milestone.task_ids ?? []).flatMap((taskId) => {
    const task = plan.tasks.find((each) => each.id === taskId);
    return task ? [{ task, sessions: taskSessions(ctx, plan.id, taskId) }] : [];
  });
  const roots = landedRoots(ctx, ctx.store.must<Project>('projects', row.project_id), tasks);
  const cancelled = () => {
    const current = ctx.store.get<MilestoneVerification>('milestone_verifications', row.id);
    return current?.state !== 'running' || current.revision !== row.revision;
  };
  const committed = afterCommit(ctx);
  const work: Promise<void> = Promise.resolve()
    .then(async () => {
      if (!committed() || ctx.closing) return;
      const commits: { source: string; commit: string }[] = [],
        results: GateResults = [],
        diffs: string[] = [];
      for (const root of roots) {
        const commit = (
          await gitOutput(root.source, ['rev-parse', '--verify', `${root.branch}^{commit}`])
        ).trim();
        commits.push({ source: root.source, commit });
        const checked = await checkCandidate(ctx, {
          key: `milestone-verify:${row.id}`,
          projectId: row.project_id,
          source: root.source,
          commit,
          commands: root.commands,
          cancelled,
        });
        if (!checked) return;
        results.push(...checked);
        if (checked.some(gateFailed)) break;
        const base = root.bases.length
          ? (await gitOutput(root.source, ['merge-base', '--octopus', ...root.bases])).trim()
          : commit;
        diffs.push(
          `# ${root.source}\n${await gitOutput(root.source, ['diff', '--no-color', '--no-ext-diff', base, commit])}`,
        );
      }
      if (ctx.closing) return;
      ctx.store.transaction(() => {
        if (cancelled()) return;
        const next: MilestoneVerification = {
          ...row,
          commits,
          commands: results.map((result) => ({
            name: result.name,
            // A run that timed out or gave no exit code still failed.
            exit_code: gateFailed(result) ? result.exit_code || -1 : 0,
            output_tail: result.output,
            hidden: false,
            ...(result.failure_class ? { failure_class: result.failure_class } : {}),
          })),
        };
        const failed = results.find(gateFailed);
        if (failed)
          return finish(
            ctx,
            next,
            failed.failure_class === 'environment'
              ? { state: 'inconclusive', reason_code: 'checks_environment' }
              : { state: 'failed', reason_code: 'checks_failed' },
          );
        startVerifier(ctx, milestone, tasks, next, diffs.join('\n'));
      });
    })
    .catch((error: unknown) => {
      if (ctx.closing) return;
      ctx.store.transaction(() => {
        if (!cancelled())
          finish(
            ctx,
            ctx.store.must<MilestoneVerification>('milestone_verifications', row.id),
            { state: 'inconclusive', reason_code: 'check_error' },
            {
              reason: error instanceof Error ? error.message : String(error),
            },
          );
      });
    })
    .finally(() => {
      ctx.completions.delete(work);
      if (!ctx.closing) ctx.changed();
    });
  ctx.completions.add(work);
}

/** Ends a running verification whose review ended, by the verifier's verdict and open blocking findings. */
function settleVerification(ctx: ControlContext, row: MilestoneVerification): void {
  const review = ctx.store.must<Review>('reviews', row.review_id!);
  if (review.state === 'running') return;
  const sessionId = review.session_ids[0],
    verdict = sessionId ? reviewerVerdict(review, sessionId, row.runtime) : undefined,
    blocking = review.findings.filter((finding) => finding.status === 'open' && finding.blocking),
    fields = verdict ? { verdict } : {};
  if (
    review.state === 'completed' &&
    !review.incomplete &&
    verdict?.verdict === 'pass' &&
    !blocking.length
  )
    return finish(ctx, row, { state: 'passed' }, fields);
  if (verdict?.verdict === 'fail' || blocking.length)
    return finish(
      ctx,
      row,
      { state: 'failed', reason_code: 'verifier_failed' },
      {
        ...fields,
        reason: [
          ...(verdict?.verdict === 'fail' ? [verdict.summary] : []),
          ...blocking.map((finding) => `${finding.location}: ${finding.impact}`),
        ].join('\n'),
      },
    );
  finish(
    ctx,
    row,
    {
      state: 'inconclusive',
      reason_code:
        review.state === 'failed'
          ? 'review_failed'
          : review.incomplete
            ? 'review_incomplete'
            : 'no_verdict',
    },
    {
      ...fields,
      reason:
        review.state === 'failed'
          ? `Review ${review.id} failed`
          : (review.incomplete ?? 'The verifier handed in no verdict'),
    },
  );
}

/**
 * Settles verifications whose review ended, then starts one for each ready lead milestone of a
 * project with milestone verification on whose current commitment has none; one runs per project.
 */
export function advanceMilestoneVerifications(ctx: ControlContext): void {
  const rows = ctx.store.list<MilestoneVerification>('milestone_verifications');
  for (const row of rows)
    if (row.state === 'running' && row.review_id) settleVerification(ctx, row);
  const busy = new Set(
    ctx.store
      .list<MilestoneVerification>('milestone_verifications')
      .filter((row) => row.state === 'running')
      .map((row) => row.project_id),
  );
  const verifying = new Map<string, boolean>();
  const on = (projectId: string) => {
    let value = verifying.get(projectId);
    if (value === undefined)
      verifying.set(
        projectId,
        (value = workflowPolicy(ctx, projectId).milestone_verify === 'auto'),
      );
    return value;
  };
  for (const milestone of ctx.store.list<Milestone>('milestones')) {
    if (
      !milestone.owner_session_id ||
      milestone.removed_at !== undefined ||
      busy.has(milestone.project_id) ||
      !on(milestone.project_id)
    )
      continue;
    const view = milestoneView(ctx, milestone);
    if (view.status !== 'ready_for_acceptance' || view.verification) continue;
    const row = ctx.store.insert<MilestoneVerification>('milestone_verifications', {
      id: id(),
      revision: 1,
      project_id: milestone.project_id,
      milestone_id: milestone.id,
      commitment_hash: commitmentHash(
        milestone,
        view.required_sessions,
        ctx.store.get<BoardPlan>('board_plans', milestone.owner_session_id),
      ),
      state: 'running',
      commands: [],
      started_at: ctx.store.now(),
    });
    busy.add(milestone.project_id);
    checkMilestone(ctx, milestone, row);
  }
}

/** Startup ends verifications whose checks were running; one with a review settles once it ends. */
export function recoverMilestoneVerifications(ctx: ControlContext): void {
  for (const row of ctx.store.list<MilestoneVerification>('milestone_verifications'))
    if (row.state === 'running' && !row.review_id)
      finish(
        ctx,
        row,
        { state: 'inconclusive', reason_code: 'daemon_restart' },
        { reason: 'daemon_restart' },
      );
}
