import {
  DomainError,
  id,
  requireThat,
  type BoardPlan,
  type LeadNote,
  type Review,
  type ReviewFinding,
  type Session,
  type SessionTurn,
  type StepRun,
  type TaskKind,
  type WorkflowStep,
  type Workspace,
} from '@pantheon/domain';
import { type ControlContext } from './context.js';
import { retiredBinding, taskGeneration } from './board-plan.js';
import { taskPath } from './task-dispatch.js';
import { admitMerge, afterCommit, readMergeStates } from './workbench-session.js';
import { appendNote, contractLines } from './lead-inbox.js';
import { queueStepTurn, wakeLead } from './task-tracking.js';
import { causeTurn } from './progress.js';
import { unsnooze } from './session.js';
import { reviewInstruction, reviewerRuntime, reviewerVerdict, startReview } from './review.js';
import { sessionRangeAsync } from './landing-diff.js';
import { runGit } from './git.js';

/** The task tiers whose plan gets a plan review before their tasks dispatch. */
export const PLAN_REVIEW_TIERS: readonly TaskKind['tier'][] = ['t3'];

/** The most code review rounds a reviewed session gets. */
export const REVIEW_MAX_ROUNDS = 3;

type PlanTask = BoardPlan['tasks'][number];

/** The id of the review a review loop task gets before its merge. */
export const REVIEW_LOOP_STEP_ID = 'review-loop';

/** The code review that holds the task's merge; undefined off the review loop path. */
function mergeReviewStep(
  ctx: ControlContext,
  plan: BoardPlan,
  task: PlanTask,
): WorkflowStep | undefined {
  if (taskPath(ctx, plan.project_id, task) !== 'review_loop') return;
  return { id: REVIEW_LOOP_STEP_ID, title: 'Code review', kind: { type: 'review' } };
}

/** The stored run of the review that holds the session's merge, inserted when missing. */
export function openMergeReview(
  ctx: ControlContext,
  plan: BoardPlan,
  task: PlanTask,
  sessionId?: string,
): StepRun | undefined {
  const step = mergeReviewStep(ctx, plan, task);
  if (!step) return;
  const old = ctx.store
    .list<StepRun>('workflow_step_runs')
    .find(
      (r) =>
        r.lead_session_id === plan.id &&
        r.task_id === task.id &&
        r.generation === taskGeneration(plan, task.id) &&
        (!sessionId || r.session_id === sessionId) &&
        r.state !== 'retired' &&
        r.step.id === step.id,
    );
  if (old) return old;
  const run = ctx.store.insert<StepRun>('workflow_step_runs', {
    id: id(),
    revision: 1,
    project_id: plan.project_id,
    lead_session_id: plan.id,
    task_id: task.id,
    generation: taskGeneration(plan, task.id),
    slot: 'before_merge',
    step,
    state: 'pending',
    created_at: ctx.store.now(),
    ...(sessionId ? { session_id: sessionId } : {}),
  });
  ctx.store.event('workflow.step_created', run, plan.project_id, {
    task_id: task.id,
    slot: 'before_merge',
    step_id: step.id,
  });
  return run;
}

export function waitingStep(ctx: ControlContext, plan: BoardPlan, task: PlanTask) {
  const run = ctx.store
    .list<StepRun>('workflow_step_runs')
    .find(
      (r) =>
        r.lead_session_id === plan.id &&
        r.task_id === task.id &&
        r.generation === taskGeneration(plan, task.id) &&
        ['running', 'failed'].includes(r.state),
    );
  if (run) return { id: run.step.id, title: run.step.title, kind: run.step.kind.type };
}

function changeRun(
  ctx: ControlContext,
  run: StepRun,
  state: StepRun['state'],
  reason?: string,
): StepRun {
  const next = ctx.store.update(
    'workflow_step_runs',
    {
      ...run,
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(['passed', 'failed', 'retired', 'skipped'].includes(state)
        ? { finished_at: ctx.store.now() }
        : {}),
    },
    run.revision,
  );
  ctx.store.event('workflow.step_changed', next, run.project_id, {
    state,
    task_id: run.task_id,
    slot: run.slot,
    step_id: run.step.id,
    ...(reason ? { reason } : {}),
  });
  return next;
}

/** Uses the same blocked note and report as a user task hand-back, so automatic repairs stay held. */
function handBackStep(ctx: ControlContext, run: StepRun, reason: string): void {
  const plan = ctx.store.must<BoardPlan>('board_plans', run.lead_session_id);
  const note: LeadNote = {
    at: ctx.store.now(),
    session_id: run.session_id ?? '',
    task_id: run.task_id,
    generation: run.generation,
    turn_id: run.session_id ? causeTurn(ctx, run.session_id)?.id : undefined,
    kind: 'blocked',
    text: `Workflow step “${run.step.title}” failed: ${reason}`,
  };
  const next = appendNote(ctx, plan, note);
  ctx.store.event('task.reported', next, run.project_id, note);
  ctx.store.event('task.handed_back', next, run.project_id, {
    session_id: run.session_id,
    task_id: run.task_id,
    reason,
  });
  wakeLead(ctx, next, '');
}

function failStep(ctx: ControlContext, run: StepRun, reason: string): void {
  handBackStep(ctx, changeRun(ctx, run, 'failed', reason), reason);
}

function liveRuns(
  ctx: ControlContext,
  plan: BoardPlan,
  taskId: string,
  runs = ctx.store.list<StepRun>('workflow_step_runs'),
): StepRun[] {
  return runs.filter(
    (r) =>
      r.lead_session_id === plan.id &&
      r.task_id === taskId &&
      r.generation === taskGeneration(plan, taskId) &&
      r.state !== 'retired',
  );
}

/** A turn on the task session cleared its held merge; once the session is idle the review resumes it. */
function resumeMerge(ctx: ControlContext, run: StepRun): void {
  const session = ctx.store.get<Session>('sessions', run.session_id ?? '');
  if (
    !session ||
    session.merge ||
    session.outcome ||
    session.state !== 'open' ||
    session.stop_requested
  )
    return;
  ctx.store.update(
    'sessions',
    { ...session, merge: { state: 'blocked' as const, reason: 'workflow_approval' } },
    session.revision,
  );
}

/**
 * The runtime and round a review step starts on, or why it fails; read from the store alone.
 * Undefined once the session, plan or task is gone, which the plan may do while the changes are read.
 */
function reviewStart(ctx: ControlContext, run: StepRun) {
  const session = ctx.store.get<Session>('sessions', run.session_id ?? ''),
    plan = ctx.store.get<BoardPlan>('board_plans', run.lead_session_id),
    task = plan?.tasks.find((t) => t.id === run.task_id);
  if (!session || !plan || !task) return;
  const name = reviewerRuntime(ctx, session.project_id, session.runtime);
  if (!name) return { failure: 'No runtime can run a read-only review' };
  const round =
      ctx.store.list<Review>('reviews').filter((r) => r.session_id === session.id).length + 1,
    maxRounds = REVIEW_MAX_ROUNDS;
  if (round > maxRounds)
    return {
      failure: `Code review limit reached: at most ${maxRounds} rounds per reviewed session`,
    };
  return { session, plan, task, name, round };
}

// The review steps whose range and diff are being read, by run id.
const reviewReads = new WeakMap<ControlContext, Set<string>>();

/**
 * Reviews the task's committed range on the runtime `reviewerRuntime` picks; reads the range and
 * diff first, then starts the review if the run is still pending.
 */
function startReviewStep(ctx: ControlContext, run: StepRun): void {
  let reading = reviewReads.get(ctx);
  if (!reading) reviewReads.set(ctx, (reading = new Set()));
  if (reading.has(run.id)) return;
  const start = reviewStart(ctx, run);
  if (!start) return;
  if (start.failure !== undefined) return failStep(ctx, run, start.failure);
  const committed = afterCommit(ctx);
  const work: Promise<void> = Promise.resolve()
    .then(async () => {
      if (!committed() || ctx.closing) return;
      const read = await (async () => {
        const range = await sessionRangeAsync(ctx, start.session),
          diff = await runGit(
            range.source,
            ['diff', '--no-color', '--no-ext-diff', range.from_sha, range.to_sha],
            undefined,
            true,
          );
        requireThat(
          diff.exit_code === 0,
          'git_failed',
          diff.stderr.toString().trim() || 'Git diff failed',
        );
        return { range, diff };
      })().catch((error: unknown) => {
        if (!(error instanceof DomainError)) throw error;
        return error.message;
      });
      if (ctx.closing) return;
      ctx.store.transaction(() => {
        const current = ctx.store.get<StepRun>('workflow_step_runs', run.id);
        if (current?.state !== 'pending' || current.revision !== run.revision) return;
        // A turn may have cleared the held merge while the changes were read; the next hold starts the review.
        if (
          ctx.store.get<Session>('sessions', current.session_id ?? '')?.merge?.reason !==
          'workflow_approval'
        )
          return;
        if (typeof read === 'string') return failStep(ctx, current, read);
        // Another review of the session may have taken this round meanwhile.
        const again = reviewStart(ctx, current);
        if (!again) return;
        if (again.failure !== undefined) return failStep(ctx, current, again.failure);
        const { session, plan, task, name, round } = again;
        try {
          const review = startReview(ctx, current.project_id, [name], {
            round,
            cause: '',
            prompt: `${reviewInstruction}\n\nTask goal:\n${contractLines(task).join('\n')}\n\nChanges:\n${read.diff.stdout.toString('utf8')}`,
            artifact: { name: 'changes.diff', content: read.diff.stdout },
            session_id: session.id,
            requester: {
              lead_session_id: plan.id,
              task_id: task.id,
              generation: current.generation,
              step_run_id: current.id,
            },
            range: read.range,
          });
          changeRun(ctx, { ...current, review_id: review.id }, 'running');
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          failStep(ctx, current, error.message);
        }
      });
    })
    .catch((error: unknown) => ctx.diagnostic(error))
    .finally(() => {
      reading.delete(run.id);
      ctx.completions.delete(work);
      if (!ctx.closing) ctx.changed();
    });
  reading.add(run.id);
  ctx.completions.add(work);
}

/** A review finding as the task session reads it in the turn that asks it to fix the finding. */
const findingText = (f: ReviewFinding) =>
  `${f.location}\nQuote: ${f.quote}\nEvidence: ${f.evidence}\nImpact: ${f.impact}${f.reproduction === undefined ? '' : `\nReproduction: ${JSON.stringify(f.reproduction)}`}`;

/** Before the merge, blocking findings go to the task session, and the review runs again after its turn. */
function settleReviewStep(ctx: ControlContext, run: StepRun): void {
  const review = ctx.store.must<Review>('reviews', run.review_id!);
  if (review.state === 'running') return;
  const blocking = review.findings.filter((f) => f.status === 'open' && f.blocking),
    reviewers =
      review.state === 'completed'
        ? review.session_ids.map((id) => {
            const name = ctx.store.get<Session>('sessions', id)?.runtime;
            return { name: name ?? id, given: reviewerVerdict(review, id, name) };
          })
        : [],
    failed = reviewers.flatMap(({ given }) => (given?.verdict === 'fail' ? [given] : [])),
    silent = reviewers.filter(({ given }) => !given);
  if (
    review.state === 'completed' &&
    !review.incomplete &&
    !blocking.length &&
    !failed.length &&
    !silent.length
  ) {
    changeRun(ctx, run, 'passed');
    return;
  }
  if (!blocking.length)
    return failStep(
      ctx,
      run,
      review.incomplete || failed.length || silent.length
        ? [
            ...(review.incomplete ? [`Review ${review.id} incomplete: ${review.incomplete}`] : []),
            ...(failed.length
              ? [
                  `Review ${review.id} failed by verdict:`,
                  ...failed.map((verdict) => `${verdict.runtime}: ${verdict.summary}`),
                ]
              : []),
            ...silent.map(({ name }) => `Review ${review.id}: ${name} handed in no verdict.`),
            ...(silent.length && !failed.length
              ? ['Call request_review for this task to run the review again.']
              : []),
            ...(failed.length
              ? [
                  'Call request_review for this task to send the verdict back to the task session; the review runs again after its turn.',
                ]
              : []),
          ].join('\n')
        : `Review ${review.id} ${review.state}`,
    );
  const findings = blocking.map(findingText);
  const session = ctx.store.must<Session>('sessions', run.session_id!);
  const turn = queueStepTurn(
    ctx,
    session,
    run.task_id,
    [
      `[Pantheon] The workflow review “${run.step.title}” found problems to fix before the merge:`,
      ...findings,
      'Fix them and commit; the workflow steps before the merge run again after this turn.',
    ].join('\n\n'),
  );
  if (!turn) return;
  changeRun(
    ctx,
    { ...run, turn_id: turn.id },
    'failed',
    `${blocking.length} blocking finding(s) sent to the task session`,
  );
  unsnooze(ctx, session.id, 'merge_blocked');
}

/**
 * Settles a running review, reruns a review whose findings turn has completed, and hands the task
 * back when that turn failed or was cancelled.
 */
function followRun(ctx: ControlContext, run: StepRun): void {
  const turn = run.turn_id ? ctx.store.get<SessionTurn>('session_turns', run.turn_id) : undefined;
  if (run.state === 'running' && run.review_id) {
    // A turn cleared the held merge meanwhile, so the verdict may not be on the commit that merges.
    if (
      ctx.store.get<Session>('sessions', run.session_id ?? '')?.merge?.reason !==
      'workflow_approval'
    ) {
      const { review_id: _, ...rest } = run;
      changeRun(ctx, rest, 'pending');
      return;
    }
    settleReviewStep(ctx, run);
  }
  if (run.state === 'failed' && run.review_id && turn?.state === 'completed') rerunReview(ctx, run);
  if (
    run.state === 'failed' &&
    run.review_id &&
    (turn?.state === 'failed' || turn?.state === 'cancelled')
  ) {
    const { turn_id: _, ...rest } = run;
    handBackStep(
      ctx,
      changeRun(ctx, rest, 'failed'),
      `The task session's turn with the review findings ${turn.state === 'failed' ? 'failed' : 'was cancelled'}`,
    );
  }
}

/** Sets the session's review before the merge back to pending. */
function rerunReview(ctx: ControlContext, run: StepRun): void {
  const plan = ctx.store.must<BoardPlan>('board_plans', run.lead_session_id),
    others = liveRuns(ctx, plan, run.task_id).filter(
      (other) => other.session_id === run.session_id,
    );
  for (const other of others) {
    const { turn_id: _, review_id: __, reason: ___, finished_at: ____, ...rest } = other;
    changeRun(ctx, rest, 'pending');
  }
  resumeMerge(ctx, run);
}

/**
 * Runs again the failed review step before the merge of a held task session. When a reviewer
 * failed it by verdict, sends the verdict and open findings to the task session instead, and the
 * review runs again after that turn; undefined at the round limit.
 */
export function reopenReviewStep(
  ctx: ControlContext,
  session: Session,
): { reopened: string } | { handed_back: string; turn_id: string } | undefined {
  const plan =
    session.task && ctx.store.get<BoardPlan>('board_plans', session.task.lead_session_id);
  if (!plan || !heldForReview(session)) return;
  const run = liveRuns(ctx, plan, session.task!.id).find(
    (r) => r.session_id === session.id && r.state === 'failed' && !r.turn_id,
  );
  if (!run) return;
  if (!run.review_id) {
    // The review never started; one that hit the round limit stays failed.
    const start = reviewStart(ctx, run);
    if (!start || start.failure !== undefined) return;
    rerunReview(ctx, run);
    return { reopened: run.id };
  }
  const review = ctx.store.must<Review>('reviews', run.review_id!),
    failed = review.verdicts?.filter((given) => given.verdict === 'fail') ?? [];
  if (!failed.length) {
    rerunReview(ctx, run);
    return { reopened: run.id };
  }
  const start = reviewStart(ctx, run);
  if (!start || start.failure !== undefined) return;
  const turn = queueStepTurn(
    ctx,
    session,
    run.task_id,
    [
      [
        `[Pantheon] The workflow review “${run.step.title}” failed by verdict before the merge:`,
        ...failed.map((verdict) => `${verdict.runtime}: ${verdict.summary}`),
      ].join('\n'),
      ...review.findings.filter((f) => f.status === 'open').map(findingText),
      'Fix what it found and commit; the workflow steps before the merge run again after this turn.',
    ].join('\n\n'),
  );
  requireThat(turn, 'resource_busy', 'The task session cannot take a turn now');
  changeRun(
    ctx,
    { ...run, turn_id: turn.id },
    'failed',
    `The fail verdict of review ${review.id} sent to the task session`,
  );
  unsnooze(ctx, session.id, 'merge_blocked');
  return { handed_back: run.id, turn_id: turn.id };
}

/** Starts a pending review. */
function advanceRun(ctx: ControlContext, pending: StepRun): void {
  const run = ctx.store.must<StepRun>('workflow_step_runs', pending.id);
  if (run.state === 'pending') startReviewStep(ctx, run);
}

/** Called only after landing has passed all gates, immediately before moving the source branch. */
export function mergeWaitsForReview(ctx: ControlContext, session: Session): boolean {
  const binding = session.task ?? session.direct_task;
  if (!binding) return false;
  const plan = ctx.store.get<BoardPlan>('board_plans', session.task?.lead_session_id ?? session.id);
  const task = plan?.tasks.find((t) => t.id === binding.id);
  // The merge stops on its task binding check instead, so no review opens for a stale binding.
  if (
    !plan ||
    !task ||
    (session.task
      ? retiredBinding(plan, session)
      : taskGeneration(plan, task.id) !== binding.generation)
  )
    return false;
  const run = openMergeReview(ctx, plan, task, session.id);
  return !!run && !['passed', 'skipped'].includes(run.state);
}

/**
 * Startup retires the runs of step kinds that no longer run, those of the steps grouped under them,
 * those before dispatch or after merge, and those of steps other than the review loop one, so the
 * dispatches, merges and notes they held go on.
 */
export function retireRemovedStepRuns(ctx: ControlContext): void {
  for (const run of ctx.store.list<StepRun & { parent_run_id?: string }>('workflow_step_runs'))
    if (run.state !== 'retired' && run.slot !== 'before_merge')
      changeRun(ctx, run, 'retired', 'step_slot_removed');
    else if (run.state !== 'retired' && (run.step.kind.type !== 'review' || run.parent_run_id)) {
      changeRun(ctx, run, 'retired', 'step_kind_removed');
      cancelSettledHold(ctx, run);
    } else if (run.state !== 'retired' && run.step.id !== REVIEW_LOOP_STEP_ID) {
      changeRun(ctx, run, 'retired', 'custom_step_removed');
      cancelSettledHold(ctx, run);
    }
}

/** A retired step that had already rejected or failed the merge keeps the merge it held from going on. */
function cancelSettledHold(ctx: ControlContext, run: StepRun): void {
  // `rejected` is a state only older daemons stored.
  if (!['rejected', 'failed'].includes(run.state)) return;
  const session = ctx.store.get<Session>('sessions', run.session_id ?? '');
  if (session?.merge?.reason !== 'workflow_approval') return;
  const next = ctx.store.update(
    'sessions',
    { ...session, merge: { ...session.merge, state: 'blocked' as const, reason: 'cancelled' } },
    session.revision,
  );
  ctx.store.event('session.merge_blocked', next, next.project_id, next.merge);
  unsnooze(ctx, next.id, 'merge_blocked');
}

export function advanceMergeReviews(ctx: ControlContext): void {
  for (const run of ctx.store.list<StepRun>('workflow_step_runs')) {
    const plan = ctx.store.get<BoardPlan>('board_plans', run.lead_session_id);
    if (
      run.state !== 'retired' &&
      (!plan?.tasks.some((t) => t.id === run.task_id) ||
        taskGeneration(plan, run.task_id) !== run.generation ||
        // A task dispatched again in its generation leaves the run of its closed session behind.
        (run.state !== 'passed' &&
          (ctx.store.get<Session>('sessions', run.session_id ?? '')?.state ?? 'closed') ===
            'closed'))
    )
      changeRun(ctx, run, 'retired');
  }
  const plans = ctx.store.list<BoardPlan>('board_plans');
  // Read for the tasks below, and read again after each call that may write.
  let read: StepRun[] | undefined;
  const current = () => (read ??= ctx.store.list<StepRun>('workflow_step_runs'));
  for (const plan of plans)
    for (const task of plan.tasks) {
      for (const run of liveRuns(ctx, plan, task.id, current())) {
        followRun(ctx, ctx.store.must<StepRun>('workflow_step_runs', run.id));
        read = undefined;
      }
      const live = liveRuns(ctx, plan, task.id, current());
      // A task dispatched again in one generation keeps its earlier session's run, so each
      // session's review advances on its own.
      for (const sessionId of new Set(live.map((r) => r.session_id))) {
        const next = live.find(
          (r) => r.session_id === sessionId && !['passed', 'skipped'].includes(r.state),
        );
        if (!next || !['pending', 'running'].includes(next.state)) continue;
        // The review starts once the gates have passed and the merge waits for it.
        if (
          ctx.store.get<Session>('sessions', next.session_id ?? '')?.merge?.reason !==
          'workflow_approval'
        )
          continue;
        advanceRun(ctx, next);
        read = undefined;
      }
    }
  for (const session of ctx.store.list<Session>('sessions')) {
    if (!heldForReview(session) || mergeWaitsForReview(ctx, session)) continue;
    admitAfterReview(ctx, session);
  }
}

// The sessions whose review before the merge passed and whose repository states are being read.
const admitReads = new WeakMap<ControlContext, Set<string>>();

const heldForReview = (session: Session) =>
  session.merge?.reason === 'workflow_approval' &&
  session.state === 'open' &&
  !session.outcome &&
  !session.stop_requested;

/** Reads the repository states of a session its review before the merge let through, then admits its merge. */
function admitAfterReview(ctx: ControlContext, held: Session): void {
  let reading = admitReads.get(ctx);
  if (!reading) admitReads.set(ctx, (reading = new Set()));
  if (reading.has(held.id)) return;
  const committed = afterCommit(ctx),
    workspace = ctx.store.must<Workspace>('workspaces', held.workspace_id!);
  const work: Promise<void> = Promise.resolve()
    .then(async () => {
      if (!committed() || ctx.closing) return;
      const reads = await readMergeStates(workspace);
      if (ctx.closing) return;
      ctx.store.transaction(() => {
        const session = ctx.store.must<Session>('sessions', held.id);
        if (!heldForReview(session) || mergeWaitsForReview(ctx, session)) return;
        try {
          admitMerge(
            ctx,
            session,
            undefined,
            session.merge!.allow_out_of_scope,
            undefined,
            session.merge!.allowed_files,
            reads,
          );
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          const next = ctx.store.update(
            'sessions',
            {
              ...session,
              merge: { ...session.merge!, state: 'blocked' as const, reason: error.code },
            },
            session.revision,
          );
          ctx.store.event('session.merge_blocked', next, next.project_id, next.merge);
          unsnooze(ctx, next.id, 'merge_blocked');
        }
      });
    })
    .catch((error: unknown) => ctx.diagnostic(error))
    .finally(() => {
      reading.delete(held.id);
      ctx.completions.delete(work);
      if (!ctx.closing) ctx.changed();
    });
  reading.add(held.id);
  ctx.completions.add(work);
}
