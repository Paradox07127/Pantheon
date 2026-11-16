import { matchesGlob } from 'node:path';
import {
  canonical,
  closeUserExtensions,
  DomainError,
  id,
  requireThat,
  type BoardPlan,
  type StoredWorkflowDefinition,
  type LeadNote,
  type Principal,
  type Project,
  type Review,
  type Session,
  type SessionTurn,
  type StepRun,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowLeafStep,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas, type WorkflowDefinitionView } from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { autoMerge } from './user-config.js';
import { workflowPolicy } from './workflow-policy.js';
import { currentBinding, currentDirectMerge, taskGeneration, taskSessions } from './board-plan.js';
import { dispatchQueue, taskPath } from './task-dispatch.js';
import { admitMerge, afterCommit } from './workbench-session.js';
import { appendNote, contractLines } from './lead-inbox.js';
import { doneReported, queueStepTurn, wakeLead } from './task-tracking.js';
import { causeTurn } from './progress.js';
import { unsnooze } from './session.js';
import { runValidationCommand } from './validation-executor.js';
import { reviewInstruction, reviewerRuntime, startReview } from './review.js';
import { sessionRange } from './landing-diff.js';
import { runGit } from './git.js';
import { workflowResults } from './workflow-results.js';
import { checkGates, gateFailed } from './landing.js';

const EMPTY_WORKFLOW_DEFINITION: WorkflowDefinition = {
  slots: { before_dispatch: [], before_merge: [], after_merge: [] },
  plan_review: { tiers: ['t3'] },
  review: { max_rounds: 3 },
};

/** The stored named definition; an absent id selects the project's default. */
function storedDefinition(ctx: ControlContext, projectId: string, workflowId?: string) {
  const row = workflowId
    ? ctx.store.get<StoredWorkflowDefinition>('workflow_definitions', workflowId)
    : ctx.store
        .list<StoredWorkflowDefinition>('workflow_definitions')
        .find((row) => row.project_id === projectId && row.is_default);
  requireThat(
    !workflowId || row || workflowId === projectId,
    'not_found',
    `Not found: workflow ${workflowId}`,
  );
  requireThat(
    !row || row.project_id === projectId,
    'scope_violation',
    'Workflow belongs to another project',
  );
  return row;
}

/** The latest definition, or a task's immutable pinned version; version zero is the fixed path. */
export function workflowDefinition(
  ctx: ControlContext,
  projectId: string,
  version?: number,
  workflowId?: string,
) {
  const row = storedDefinition(ctx, projectId, workflowId);
  const definition_version = version ?? row?.definition_version ?? 0;
  return {
    id: row?.id ?? projectId,
    name: row?.name ?? 'Default',
    is_default: row?.is_default ?? true,
    definition_version,
    definition:
      definition_version === 0
        ? structuredClone(EMPTY_WORKFLOW_DEFINITION)
        : row!.versions[definition_version]!,
  };
}

export function workflowDefinitionList(ctx: ControlContext, projectId: string) {
  const rows = ctx.store
    .list<StoredWorkflowDefinition>('workflow_definitions')
    .filter((row) => row.project_id === projectId);
  const listed = rows.map((row) => ({
    id: row.id,
    name: row.name,
    version: row.definition_version,
    is_default: row.is_default,
  }));
  if (!rows.some((row) => row.id === projectId))
    listed.unshift({
      id: projectId,
      name: 'Default',
      version: 0,
      is_default: !rows.some((row) => row.is_default),
    });
  return listed;
}

type Slot = keyof WorkflowDefinition['slots'];
type PlanTask = BoardPlan['tasks'][number];
const trialTaskKey = (lead: string, task: string, generation: number) =>
  JSON.stringify([lead, task, generation]);

/** A running session without a pin keeps the fixed path, including after a definition is saved. */
export function sessionWorkflow(ctx: ControlContext, session: Session) {
  const binding = session.task ?? session.direct_task;
  const row = storedDefinition(
    ctx,
    session.project_id,
    binding ? (binding.workflow_id ?? session.project_id) : undefined,
  );
  const trialVersion =
    binding &&
    row?.task_versions?.[
      trialTaskKey(session.task?.lead_session_id ?? session.id, binding.id, binding.generation ?? 1)
    ];
  return workflowDefinition(
    ctx,
    session.project_id,
    trialVersion ?? (binding ? (binding.definition_version ?? 0) : row?.trial?.previous_version),
    row?.id ?? (binding ? session.project_id : undefined),
  );
}

/** Before opening, the first slot run pins the task; opening copies that pin onto its binding. */
export function taskWorkflow(
  ctx: ControlContext,
  plan: BoardPlan,
  taskId: string,
  // The task's taskSessions, when the caller read them since the last write.
  sessions?: Session[],
) {
  const row = storedDefinition(
    ctx,
    plan.project_id,
    plan.tasks.find((task) => task.id === taskId)?.workflow_id,
  );
  const trialVersion =
    row?.task_versions?.[trialTaskKey(plan.id, taskId, taskGeneration(plan, taskId))];
  if (trialVersion !== undefined)
    return workflowDefinition(ctx, plan.project_id, trialVersion, row?.id);
  const session = (sessions ?? taskSessions(ctx, plan.id, taskId)).find((s) =>
    currentBinding(plan, s.task!),
  );
  if (session) return sessionWorkflow(ctx, session);
  const lead = ctx.store.get<Session>('sessions', plan.id);
  if (
    lead?.direct_task?.id === taskId &&
    lead.direct_task.generation === taskGeneration(plan, taskId)
  )
    return sessionWorkflow(ctx, lead);
  const run = ctx.store
    .list<StepRun>('workflow_step_runs')
    .find(
      (r) =>
        r.lead_session_id === plan.id &&
        r.task_id === taskId &&
        r.generation === taskGeneration(plan, taskId) &&
        r.state !== 'retired',
    );
  return workflowDefinition(
    ctx,
    plan.project_id,
    run?.definition_version ?? row?.trial?.previous_version,
    run ? (run.workflow_id ?? plan.project_id) : row?.id,
  );
}

/** The id of the review a review loop task gets before its merge when its definition has no blocking one. */
export const REVIEW_LOOP_STEP_ID = 'review-loop';

/** Conditions inspect Git's diff, never an agent's account of which files changed. */
export function workflowCondition(
  ctx: ControlContext,
  step: WorkflowStep,
  sessionId?: string,
  slot?: Slot,
  taskId?: string,
): boolean {
  if (!step.when) return true;
  if (!sessionId) return false;
  const session = ctx.store.must<Session>('sessions', sessionId);
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!);
  // A direct task's merge leaves its lead open; its plan keeps the landed range.
  const direct =
    slot === 'after_merge' && taskId
      ? currentDirectMerge(ctx.store.get<BoardPlan>('board_plans', sessionId), taskId)
      : undefined;
  const merged = session.outcome === 'merged' || !!direct;
  const range = direct
    ? { source: workspace.source!, from_sha: direct.from_sha, to_sha: direct.to_sha }
    : sessionRange(ctx, session);
  if (!merged) {
    const sourceHead = runGit(workspace.source!, ['rev-parse', '--verify', 'HEAD^{commit}']);
    requireThat(sourceHead.exit_code === 0, 'git_failed', sourceHead.stderr.toString().trim());
    const objects = runGit(workspace.source!, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'objects',
    ]);
    requireThat(objects.exit_code === 0, 'git_failed', objects.stderr.toString().trim());
    const base = runGit(
      workspace.path,
      ['merge-base', range.to_sha, sourceHead.stdout.toString().trim()],
      undefined,
      false,
      { env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.stdout.toString().trim() } },
    );
    requireThat(base.exit_code === 0, 'git_failed', base.stderr.toString().trim());
    range.from_sha = base.stdout.toString().trim();
  }
  const ranges =
    slot === 'after_merge' && session.task?.parallel_index !== undefined
      ? taskSessions(ctx, session.task.lead_session_id, session.task.id).map((part) =>
          sessionRange(ctx, part),
        )
      : [range];
  const paths = ranges.flatMap((changed) => {
    const result = runGit(merged ? changed.source : workspace.path, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      changed.from_sha,
      changed.to_sha,
      '--',
    ]);
    requireThat(result.exit_code === 0, 'git_failed', result.stderr.toString().trim());
    return result.stdout.toString().split('\0').filter(Boolean);
  });
  return paths.some((file) => step.when!.changed_paths.some((glob) => matchesGlob(file, glob)));
}

const appliesTo = (step: WorkflowStep, task: PlanTask) =>
  (!step.applies_to?.tiers || (task.kind && step.applies_to.tiers.includes(task.kind.tier))) &&
  (!step.applies_to?.domains || (task.kind && step.applies_to.domains.includes(task.kind.domain)));

/** When the task reached its after-merge slot: its direct merge, its last merge or its first done report. */
function afterMergeReached(ctx: ControlContext, plan: BoardPlan, task: PlanTask) {
  const sessionId = afterMergeSession(ctx, plan, task);
  if (!sessionId) return;
  if (sessionId === plan.id) return currentDirectMerge(plan, task.id)!.at;
  const report = task.done_when === 'report',
    sessions = new Set(taskSessions(ctx, plan.id, task.id).map((s) => s.id));
  const times = ctx.store
    .kindEvents(plan.project_id, [report ? 'task.reported' : 'session.merged'])
    .filter((event) => {
      const note = event.payload as LeadNote;
      return report
        ? note.kind === 'done' && sessions.has(note.session_id)
        : sessions.has(event.aggregate_id);
    })
    .map((event) => event.created_at);
  return report ? Math.min(...times) : Math.max(...times);
}

/** A trial enrolls a task that reaches its changed slot after the trial started and has no run there yet. */
function trialEligible(
  ctx: ControlContext,
  row: StoredWorkflowDefinition,
  plan: BoardPlan,
  task: PlanTask,
  slot: Slot,
): boolean {
  const trial = row.trial,
    generation = taskGeneration(plan, task.id);
  return (
    trial?.slot === slot &&
    trial.enrolled.length < trial.tasks &&
    !trial.enrolled.includes(trialTaskKey(plan.id, task.id, generation)) &&
    !ctx.store
      .list<StepRun>('workflow_step_runs')
      .some(
        (run) =>
          run.lead_session_id === plan.id &&
          run.task_id === task.id &&
          run.generation === generation &&
          run.slot === slot,
      ) &&
    (slot !== 'after_merge' ||
      (afterMergeReached(ctx, plan, task) ?? trial.started_at) >= trial.started_at)
  );
}

function applicableSteps(
  ctx: ControlContext,
  plan: BoardPlan,
  task: PlanTask,
  slot: Slot,
  workflow = taskWorkflow(ctx, plan, task.id),
) {
  const row = storedDefinition(ctx, plan.project_id, workflow.id);
  const preview = row && trialEligible(ctx, row, plan, task, slot);
  const steps = (preview ? row.definition : workflow.definition).slots[slot].filter((step) =>
    appliesTo(step, task),
  );
  if (
    slot !== 'before_merge' ||
    taskPath(ctx, plan.project_id, task) !== 'review_loop' ||
    steps
      .flatMap((step) =>
        step.kind.type === 'parallel'
          ? step.kind.steps
          : step.kind.type === 'loop'
            ? [step.kind.step]
            : [step],
      )
      .some((step) => step.kind.type === 'review' && step.kind.blocking && appliesTo(step, task))
  )
    return steps;
  const review: WorkflowStep = {
    id: REVIEW_LOOP_STEP_ID,
    title: 'Code review',
    kind: { type: 'review', blocking: true },
  };
  return [review, ...steps];
}

/** The stored runs of this slot, in definition order. Only entry points that start work create them. */
export function startSlot(
  ctx: ControlContext,
  plan: BoardPlan,
  task: PlanTask,
  slot: Slot,
  sessionId?: string,
): StepRun[] {
  const row = storedDefinition(ctx, plan.project_id, taskWorkflow(ctx, plan, task.id).id);
  if (row && trialEligible(ctx, row, plan, task, slot)) {
    const trial = row.trial!,
      key = trialTaskKey(plan.id, task.id, taskGeneration(plan, task.id));
    ctx.store.update(
      'workflow_definitions',
      {
        ...row,
        task_versions: { ...row.task_versions, [key]: row.definition_version },
        trial: { ...trial, enrolled: [...trial.enrolled, key] },
      },
      row.revision,
    );
  }
  const existing = ctx.store
    .list<StepRun>('workflow_step_runs')
    .filter(
      (r) =>
        r.lead_session_id === plan.id &&
        r.task_id === task.id &&
        r.generation === taskGeneration(plan, task.id) &&
        r.slot === slot &&
        (slot !== 'before_merge' || !sessionId || r.session_id === sessionId) &&
        !r.parent_run_id,
    );
  const version = taskWorkflow(ctx, plan, task.id).definition_version;
  return applicableSteps(ctx, plan, task, slot).map((step) => {
    const old = existing.find((r) => r.step.id === step.id);
    if (old) return old;
    const run = ctx.store.insert<StepRun>('workflow_step_runs', {
      id: id(),
      revision: 1,
      project_id: plan.project_id,
      lead_session_id: plan.id,
      task_id: task.id,
      generation: taskGeneration(plan, task.id),
      definition_version: version,
      workflow_id: taskWorkflow(ctx, plan, task.id).id,
      slot,
      step,
      state: 'pending',
      created_at: ctx.store.now(),
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    ctx.store.event('workflow.step_created', run, plan.project_id, {
      task_id: task.id,
      slot,
      step_id: step.id,
    });
    if (!workflowCondition(ctx, step, sessionId, slot, task.id))
      return changeRun(ctx, run, 'skipped', 'condition');
    return run;
  });
}

/** The first step not passed; reading a view never creates a run or starts a command. */
export function slotWait(
  ctx: ControlContext,
  plan: BoardPlan,
  task: PlanTask,
  slot: Slot,
): { id: string; title: string; kind: WorkflowStep['kind']['type'] } | undefined {
  const runs = ctx.store
    .list<StepRun>('workflow_step_runs')
    .filter(
      (r) =>
        r.lead_session_id === plan.id &&
        r.task_id === task.id &&
        r.generation === taskGeneration(plan, task.id) &&
        r.slot === slot &&
        !r.parent_run_id,
    );
  const step = applicableSteps(ctx, plan, task, slot).find(
    (step) =>
      runs.find((r) => r.step.id === step.id)?.state !== 'passed' &&
      runs.find((r) => r.step.id === step.id)?.state !== 'skipped',
  );
  if (step) return { id: step.id, title: step.title, kind: step.kind.type };
}

export function waitingStep(ctx: ControlContext, plan: BoardPlan, task: PlanTask) {
  const run = ctx.store
    .list<StepRun>('workflow_step_runs')
    .find(
      (r) =>
        r.lead_session_id === plan.id &&
        r.task_id === task.id &&
        r.generation === taskGeneration(plan, task.id) &&
        ['waiting', 'running', 'failed', 'rejected'].includes(r.state),
    );
  return run
    ? { id: run.step.id, title: run.step.title, kind: run.step.kind.type }
    : plan.dispatch?.[task.id]
      ? slotWait(ctx, plan, task, 'before_dispatch')
      : undefined;
}

function changeRun(
  ctx: ControlContext,
  run: StepRun,
  state: StepRun['state'],
  reason?: string,
  cause?: string,
): StepRun {
  const next = ctx.store.update(
    'workflow_step_runs',
    {
      ...run,
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(['passed', 'failed', 'rejected', 'retired', 'skipped'].includes(state)
        ? { finished_at: ctx.store.now() }
        : {}),
    },
    run.revision,
  );
  ctx.store.event(
    'workflow.step_changed',
    next,
    run.project_id,
    {
      state,
      task_id: run.task_id,
      slot: run.slot,
      step_id: run.step.id,
      ...(reason ? { reason } : {}),
    },
    cause,
  );
  if (state === 'waiting') unsnooze(ctx, run.session_id ?? run.lead_session_id, 'needs_you', cause);
  return next;
}

/** Uses the same blocked note and report as a user task hand-back, so automatic repairs stay held. */
function handBackStep(ctx: ControlContext, run: StepRun, reason: string, cause = ''): void {
  const plan = ctx.store.must<BoardPlan>('board_plans', run.lead_session_id);
  const note: LeadNote = {
    at: ctx.store.now(),
    session_id: run.session_id ?? '',
    task_id: run.task_id,
    generation: run.generation,
    turn_id: run.session_id ? causeTurn(ctx, run.session_id)?.id : undefined,
    kind: 'blocked',
    text:
      run.state === 'rejected'
        ? `The user handed this task back to you: ${run.step.title}: ${reason}`
        : `Workflow step “${run.step.title}” failed: ${reason}`,
  };
  const next = appendNote(ctx, plan, note, cause);
  ctx.store.event('task.reported', next, run.project_id, note, cause);
  ctx.store.event(
    'task.handed_back',
    next,
    run.project_id,
    { session_id: run.session_id, task_id: run.task_id, reason },
    cause,
  );
  wakeLead(ctx, next, cause);
}

/** The merge stays; the result joins the task's merged or done note, which wakes the lead once the slot ends. */
function noteAfterMerge(ctx: ControlContext, run: StepRun, reason: string, cause = ''): void {
  const plan = ctx.store.must<BoardPlan>('board_plans', run.lead_session_id),
    text = `Workflow step “${run.step.title}” after the merge failed; the merge stays: ${reason}`,
    index = plan.inbox.findIndex(
      (note) => note.task_id === run.task_id && (note.kind === 'merged' || note.kind === 'done'),
    );
  if (index < 0)
    appendNote(
      ctx,
      plan,
      {
        at: ctx.store.now(),
        session_id: run.session_id ?? '',
        task_id: run.task_id,
        generation: run.generation,
        kind: 'merged',
        text,
      },
      cause,
    );
  else
    ctx.store.update(
      'board_plans',
      {
        ...plan,
        inbox: plan.inbox.map((note, i) =>
          i === index ? { ...note, text: `${note.text}\n${text}` } : note,
        ),
      },
      plan.revision,
    );
  unsnooze(ctx, plan.id, 'needs_you', cause);
}

function reportFailure(ctx: ControlContext, run: StepRun, reason: string, cause = ''): void {
  if (run.parent_run_id) return;
  const failedCommand =
    run.slot === 'before_merge' &&
    run.session_id &&
    ctx.store
      .list<StepRun>('workflow_step_runs')
      .find(
        (child) =>
          child.parent_run_id === run.id &&
          child.step.kind.type === 'command' &&
          child.state === 'failed',
      );
  if (failedCommand) {
    const session = ctx.store.must<Session>('sessions', run.session_id!);
    const next = ctx.store.update(
      'sessions',
      {
        ...session,
        merge: {
          state: 'blocked' as const,
          reason: 'gate_failed',
          failure_class: failedCommand.failure_class,
          gate: { name: failedCommand.step.title, output: failedCommand.reason ?? '' },
        },
      },
      session.revision,
    );
    ctx.store.event('session.merge_blocked', next, run.project_id, next.merge, cause);
    unsnooze(ctx, next.id, 'merge_blocked', cause);
    return;
  }
  if (run.slot === 'after_merge') noteAfterMerge(ctx, run, reason, cause);
  else handBackStep(ctx, run, reason, cause);
}

function failStep(ctx: ControlContext, run: StepRun, reason: string): void {
  reportFailure(ctx, changeRun(ctx, run, 'failed', reason), reason);
}

/** True until the task's after-merge steps have all passed or one has failed; its merged or done note waits that long. */
export function afterMergeHolds(
  ctx: ControlContext,
  plan: BoardPlan,
  note: Pick<LeadNote, 'task_id'>,
): boolean {
  const task = plan.tasks.find((t) => t.id === note.task_id);
  if (!task) return false;
  const runs = liveRuns(ctx, plan, task.id, 'after_merge'),
    steps = applicableSteps(ctx, plan, task, 'after_merge');
  return (
    !runs.some((r) => r.state === 'failed' || r.state === 'rejected') &&
    steps.some(
      (step) =>
        runs.find((r) => r.step.id === step.id)?.state !== 'passed' &&
        runs.find((r) => r.step.id === step.id)?.state !== 'skipped',
    )
  );
}

function liveRuns(
  ctx: ControlContext,
  plan: BoardPlan,
  taskId: string,
  slot: Slot,
  runs = ctx.store.list<StepRun>('workflow_step_runs'),
): StepRun[] {
  return runs.filter(
    (r) =>
      r.lead_session_id === plan.id &&
      r.task_id === taskId &&
      r.generation === taskGeneration(plan, taskId) &&
      r.slot === slot &&
      !r.parent_run_id &&
      r.state !== 'retired',
  );
}

/** A turn on the task session cleared its held merge; once the session is idle the slot resumes it. */
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

function startPrompt(ctx: ControlContext, run: StepRun): void {
  const kind = run.step.kind as Extract<WorkflowStep['kind'], { type: 'prompt' }>;
  const session = ctx.store.must<Session>(
    'sessions',
    kind.target === 'lead' ? run.lead_session_id : run.session_id!,
  );
  const turn = queueStepTurn(
    ctx,
    session,
    run.task_id,
    kind.prompt,
    kind.skill ? [kind.skill] : undefined,
  );
  if (turn) changeRun(ctx, { ...run, turn_id: turn.id }, 'running');
}

/** Reviews the task's committed range on the named runtime, else on the one `reviewerRuntime` picks. */
function startReviewStep(ctx: ControlContext, run: StepRun): void {
  const kind = run.step.kind as Extract<WorkflowStep['kind'], { type: 'review' }>,
    session = ctx.store.must<Session>('sessions', run.session_id!),
    plan = ctx.store.must<BoardPlan>('board_plans', run.lead_session_id),
    task = plan.tasks.find((t) => t.id === run.task_id)!;
  const name = kind.runtime ?? reviewerRuntime(ctx, session.project_id, session.runtime);
  if (!name) return failStep(ctx, run, 'No runtime can run a read-only review');
  const round =
      ctx.store.list<Review>('reviews').filter((r) => r.session_id === session.id).length + 1,
    maxRounds = taskWorkflow(ctx, plan, task.id).definition.review.max_rounds;
  if (round > maxRounds)
    return failStep(
      ctx,
      run,
      `Code review limit reached: at most ${maxRounds} rounds per reviewed session`,
    );
  try {
    const range = sessionRange(ctx, session),
      diff = runGit(range.source, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        range.from_sha,
        range.to_sha,
      ]);
    requireThat(
      diff.exit_code === 0,
      'git_failed',
      diff.stderr.toString().trim() || 'Git diff failed',
    );
    const review = startReview(ctx, run.project_id, [name], {
      round,
      cause: '',
      prompt: `${reviewInstruction}\n\nTask goal:\n${contractLines(task).join('\n')}\n\nChanges:\n${diff.stdout.toString('utf8')}`,
      artifact: { name: 'changes.diff', content: diff.stdout },
      session_id: session.id,
      requester: {
        lead_session_id: plan.id,
        task_id: task.id,
        generation: run.generation,
        step_run_id: run.id,
      },
      range,
      choice: { model: kind.model, effort: kind.effort },
    });
    changeRun(ctx, { ...run, review_id: review.id }, 'running');
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    failStep(ctx, run, error.message);
  }
}

/** Before the merge, blocking findings go to the task session, and the slot runs again after its turn. */
function settleReviewStep(ctx: ControlContext, run: StepRun): void {
  const review = ctx.store.must<Review>('reviews', run.review_id!);
  if (review.state === 'running') return;
  const kind = run.step.kind as Extract<WorkflowStep['kind'], { type: 'review' }>,
    blocking = review.findings.filter((f) => f.status === 'open' && f.blocking);
  if (!kind.blocking || (review.state === 'completed' && !blocking.length)) {
    changeRun(ctx, run, 'passed');
    return;
  }
  if (!blocking.length) return failStep(ctx, run, `Review ${review.id} ${review.state}`);
  const findings = blocking.map(
    (f) =>
      `${f.location}\nQuote: ${f.quote}\nEvidence: ${f.evidence}\nImpact: ${f.impact}${f.reproduction === undefined ? '' : `\nReproduction: ${JSON.stringify(f.reproduction)}`}`,
  );
  if (run.slot !== 'before_merge')
    return failStep(ctx, run, [`Review ${review.id} found:`, ...findings].join('\n'));
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

/** Each group's child runs, from one read of the step runs. */
function childRuns(ctx: ControlContext): Map<string, StepRun[]> {
  const children = new Map<string, StepRun[]>();
  for (const run of ctx.store.list<StepRun>('workflow_step_runs'))
    if (run.parent_run_id)
      children.set(run.parent_run_id, [...(children.get(run.parent_run_id) ?? []), run]);
  return children;
}

/** Settles a running prompt or review, and reruns a slot whose findings turn has completed. */
function followRun(ctx: ControlContext, run: StepRun): void {
  const turn = run.turn_id ? ctx.store.get<SessionTurn>('session_turns', run.turn_id) : undefined;
  if (run.state === 'running' && run.step.kind.type === 'prompt' && turn) {
    if (turn.state === 'completed') {
      changeRun(ctx, run, 'passed');
      if (run.slot === 'before_merge' && run.step.kind.target !== 'lead') resumeMerge(ctx, run);
    } else if (turn.state === 'failed' || turn.state === 'cancelled') {
      failStep(ctx, run, `The prompt turn ${turn.state}`);
      // Its group settles, and hands the task back, only while the merge is held.
      if (run.parent_run_id && run.slot === 'before_merge' && run.step.kind.target !== 'lead')
        resumeMerge(ctx, run);
    }
  }
  if (run.state === 'running' && run.review_id) settleReviewStep(ctx, run);
  if (run.state === 'failed' && run.review_id && run.slot === 'before_merge' && turn) {
    if (turn.state !== 'completed') return;
    const plan = ctx.store.must<BoardPlan>('board_plans', run.lead_session_id),
      children = childRuns(ctx);
    for (const other of liveRuns(ctx, plan, run.task_id, 'before_merge'))
      if (other.step.kind.type !== 'command' && other.session_id === run.session_id) {
        for (const child of children.get(other.id) ?? [])
          if (child.state !== 'retired') changeRun(ctx, child, 'retired');
        const { turn_id: _, review_id: __, reason: ___, finished_at: ____, ...rest } = other;
        const applies = workflowCondition(
          ctx,
          other.step,
          other.session_id,
          'before_merge',
          other.task_id,
        );
        changeRun(ctx, rest, applies ? 'pending' : 'skipped', applies ? undefined : 'condition');
      }
    resumeMerge(ctx, run);
  }
}

/** Runs a slot command in the source repository; a restart fails it as recoverWorkflowSteps does. */
function runCommandStep(ctx: ControlContext, pending: StepRun): void {
  const kind = pending.step.kind as Extract<WorkflowStep['kind'], { type: 'command' }>,
    run = changeRun(ctx, pending, 'running');
  const cancelled = () => {
    const current = ctx.store.must<StepRun>('workflow_step_runs', run.id);
    return current.state === 'retired' || current.revision !== run.revision;
  };
  const project = ctx.store.must<Project>('projects', run.project_id),
    workspaceId =
      run.session_id && ctx.store.get<Session>('sessions', run.session_id)?.workspace_id,
    source =
      (workspaceId && ctx.store.get<Workspace>('workspaces', workspaceId)?.source) ||
      project.roots[0]!,
    committed = afterCommit(ctx);
  const completion = Promise.resolve()
    .then(async () => {
      if (!committed() || ctx.closing) return;
      const checked =
        run.slot === 'before_merge' && workspaceId
          ? await checkGates(
              ctx,
              {
                key: `workflow-${run.id}-${run.revision}`,
                projectId: run.project_id,
                session_id: run.session_id,
                cancelled,
                event: () => {},
              },
              ctx.store.must<Workspace>('workspaces', workspaceId),
              source,
              [
                {
                  name: run.step.title,
                  argv: ['/bin/sh', '-c', kind.command],
                  timeout_ms: kind.timeout_seconds * 1000,
                },
              ],
              sessionRange(ctx, ctx.store.must<Session>('sessions', run.session_id!)).to_sha,
            )
          : undefined;
      if (ctx.closing || (run.slot === 'before_merge' && !checked)) return;
      const result = checked
        ? {
            exit_code: gateFailed(checked[0]!) ? checked[0]!.exit_code : 0,
            timedOut: checked[0]!.timed_out,
            tail: checked[0]!.output,
            error: undefined,
          }
        : await runValidationCommand({
            ctx,
            key: `check-process:workflow-${run.id}-${run.revision}`,
            argv: ['/bin/sh', '-c', kind.command],
            cwd: source,
            root: source,
            env: {
              ...project.env,
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              LANG: 'en_US.UTF-8',
              pnpm_config_verify_deps_before_run: 'false',
            },
            timeoutMs: kind.timeout_seconds * 1000,
            cancelled,
          });
      if (ctx.closing) return;
      ctx.store.transaction(() => {
        const current = ctx.store.must<StepRun>('workflow_step_runs', run.id);
        if (current.state !== 'running' || current.revision !== run.revision) return;
        const passed = result.exit_code === 0 && !result.timedOut;
        const finished = changeRun(
          ctx,
          {
            ...current,
            ...(checked?.[0]?.failure_class ? { failure_class: checked[0].failure_class } : {}),
          },
          passed ? 'passed' : 'failed',
          result.error ?? result.tail,
        );
        if (!passed) reportFailure(ctx, finished, result.error ?? result.tail);
      });
    })
    .catch((error) => {
      if (ctx.closing) return;
      ctx.store.transaction(() => {
        const current = ctx.store.must<StepRun>('workflow_step_runs', run.id);
        if (current.state === 'running' && current.revision === run.revision)
          failStep(ctx, current, String(error));
      });
    })
    .finally(() => {
      ctx.completions.delete(completion);
      if (!ctx.closing) ctx.changed();
    });
  ctx.completions.add(completion);
}

/** Starts a leaf or advances its persisted parallel/loop children. */
function advanceRun(ctx: ControlContext, pending: StepRun): void {
  const run = ctx.store.must<StepRun>('workflow_step_runs', pending.id);
  const kind = run.step.kind;
  if (kind.type === 'parallel' || kind.type === 'loop') {
    if (!['pending', 'running'].includes(run.state)) return;
    if (run.state === 'pending') changeRun(ctx, run, 'running');
    const task = ctx.store
      .must<BoardPlan>('board_plans', run.lead_session_id)
      .tasks.find((t) => t.id === run.task_id)!;
    let children = ctx.store
      .list<StepRun>('workflow_step_runs')
      .filter((child) => child.parent_run_id === run.id && child.state !== 'retired');
    const create = (step: WorkflowLeafStep, iteration: number) => {
      const old = ctx.store
        .list<StepRun>('workflow_step_runs')
        .find(
          (child) =>
            child.parent_run_id === run.id &&
            child.iteration === iteration &&
            child.step.id === step.id,
        );
      const value: StepRun = {
        id: old?.id ?? id(),
        revision: old?.revision ?? 1,
        project_id: run.project_id,
        lead_session_id: run.lead_session_id,
        task_id: run.task_id,
        generation: run.generation,
        definition_version: run.definition_version,
        workflow_id: run.workflow_id,
        slot: run.slot,
        step,
        state: 'pending',
        created_at: old?.created_at ?? ctx.store.now(),
        session_id: run.session_id,
        parent_run_id: run.id,
        iteration,
      };
      const child = old
        ? ctx.store.update('workflow_step_runs', value, old.revision)
        : ctx.store.insert('workflow_step_runs', value);
      ctx.store.event('workflow.step_created', child, run.project_id, {
        task_id: run.task_id,
        slot: run.slot,
        step_id: step.id,
        parent_run_id: run.id,
        iteration,
      });
      if (!appliesTo(step, task)) return changeRun(ctx, child, 'skipped', 'applies_to');
      return workflowCondition(ctx, step, run.session_id, run.slot, run.task_id)
        ? child
        : changeRun(ctx, child, 'skipped', 'condition');
    };
    if (kind.type === 'parallel')
      children = kind.steps.map(
        (step) => children.find((child) => child.step.id === step.id) ?? create(step, 1),
      );
    else if (!children.length) children = [create(kind.step, 1)];
    for (const child of children) {
      followRun(ctx, child);
      advanceRun(ctx, ctx.store.must<StepRun>('workflow_step_runs', child.id));
    }
    children = children.map((child) => ctx.store.must<StepRun>('workflow_step_runs', child.id));
    // Review findings went to the task session; followRun reruns the group after that turn.
    if (children.some((child) => child.state === 'failed' && child.review_id && child.turn_id))
      return;
    const current = ctx.store.must<StepRun>('workflow_step_runs', run.id);
    if (kind.type === 'parallel') {
      if (
        children.some((child) => !['passed', 'skipped', 'failed', 'rejected'].includes(child.state))
      )
        return;
      const failed = children.find(
        (child) => child.state === 'failed' || child.state === 'rejected',
      );
      if (failed) failStep(ctx, current, failed.reason ?? failed.step.title);
      else
        changeRun(
          ctx,
          current,
          children.every((child) => child.state === 'skipped') ? 'skipped' : 'passed',
        );
    } else {
      const last = children.at(-1)!;
      if (last.state === 'passed' || last.state === 'skipped')
        changeRun(ctx, current, last.state, last.reason);
      else if (last.state === 'failed' || last.state === 'rejected') {
        if (children.length < kind.max) advanceRun(ctx, create(kind.step, children.length + 1));
        else failStep(ctx, current, last.reason ?? last.step.title);
      }
    }
    return;
  }
  if (run.state !== 'pending') return;
  if (kind.type === 'approval') changeRun(ctx, run, 'waiting');
  else if (kind.type === 'command') runCommandStep(ctx, run);
  else if (kind.type === 'prompt') startPrompt(ctx, run);
  else if (kind.type === 'review') startReviewStep(ctx, run);
}

/** The session after whose merge or done report the after-merge slot runs; undefined before then. */
function afterMergeSession(
  ctx: ControlContext,
  plan: BoardPlan,
  task: PlanTask,
): string | undefined {
  const sessions = taskSessions(ctx, plan.id, task.id);
  if (task.done_when === 'report')
    return doneReported(ctx, plan, task.id) ? sessions.at(-1)?.id : undefined;
  if (
    taskPath(ctx, plan.project_id, task) === 'parallel' &&
    sessions.some((session) => session.outcome !== 'merged')
  )
    return;
  return (
    sessions.find((s) => s.outcome === 'merged')?.id ??
    (currentDirectMerge(plan, task.id) ? plan.id : undefined)
  );
}

/** Records the landing gate's progress on the session's before-merge command runs. */
export function recordWorkflowGates(
  ctx: ControlContext,
  session: Session,
  kind: 'gate_started' | 'gate_step_checked' | 'gate_checked',
  payload: Record<string, unknown>,
): void {
  const binding = session.task ?? session.direct_task;
  if (!binding) return;
  const leadId = session.task?.lead_session_id ?? session.id;
  const runs = ctx.store
    .list<StepRun>('workflow_step_runs')
    .filter(
      (r) =>
        r.lead_session_id === leadId &&
        r.task_id === binding.id &&
        r.generation === (binding.generation ?? 1) &&
        r.slot === 'before_merge' &&
        r.session_id === session.id &&
        r.step.kind.type === 'command' &&
        r.state !== 'retired',
    );
  if (kind === 'gate_started') {
    for (const group of ctx.store
      .list<StepRun>('workflow_step_runs')
      .filter(
        (run) =>
          run.session_id === session.id &&
          run.slot === 'before_merge' &&
          !run.parent_run_id &&
          (run.step.kind.type === 'parallel' || run.step.kind.type === 'loop') &&
          !['pending', 'retired'].includes(run.state),
      )) {
      for (const child of ctx.store
        .list<StepRun>('workflow_step_runs')
        .filter((run) => run.parent_run_id === group.id))
        // Like a top-level prompt, a started prompt keeps its turn; rerunning it would queue another.
        if (child.step.kind.type !== 'prompt' || !['running', 'passed'].includes(child.state))
          changeRun(ctx, child, 'retired');
      const applies = workflowCondition(ctx, group.step, session.id);
      changeRun(
        ctx,
        { ...group, finished_at: undefined, reason: undefined },
        applies ? 'pending' : 'skipped',
        applies ? undefined : 'condition',
      );
    }
  }
  const results = (kind === 'gate_started' ? payload.commands : payload.results) as {
    name: string;
    exit_code?: number | null;
    timed_out?: boolean;
    output?: string;
    state?: 'passed' | 'failed' | 'skipped';
  }[];
  for (const run of runs) {
    const result = results.find((r) => r.name === `${run.step.id}: ${run.step.title}`);
    if (result)
      changeRun(
        ctx,
        run,
        kind === 'gate_started'
          ? 'running'
          : result.state === 'skipped'
            ? 'skipped'
            : result.exit_code === 0 && !result.timed_out
              ? 'passed'
              : 'failed',
        result.output,
      );
    // The gate stops at the first failed command, so the ones after it did not run.
    else if (kind === 'gate_checked' && run.state === 'running') changeRun(ctx, run, 'pending');
  }
}

/** Called only after landing has passed all gates, immediately before moving the source branch. */
export function waitBeforeMerge(ctx: ControlContext, session: Session): boolean {
  const binding = session.task ?? session.direct_task;
  if (!binding) return false;
  const plan = ctx.store.must<BoardPlan>(
    'board_plans',
    session.task?.lead_session_id ?? session.id,
  );
  const task = plan.tasks.find((t) => t.id === binding.id)!;
  const runs = startSlot(ctx, plan, task, 'before_merge', session.id);
  const next = runs.find((r) => !['passed', 'skipped'].includes(r.state));
  if (!next) return false;
  if (next.state === 'pending' && next.step.kind.type === 'approval')
    changeRun(ctx, next, 'waiting');
  return true;
}

/** Startup settles interrupted commands after process reconciliation, as explicit gate runs do. */
export function recoverWorkflowSteps(ctx: ControlContext): void {
  for (const run of ctx.store.list<StepRun>('workflow_step_runs'))
    if (
      (run.slot !== 'before_merge' || run.parent_run_id) &&
      run.step.kind.type === 'command' &&
      run.state === 'running'
    ) {
      const failed = changeRun(ctx, run, 'failed', 'daemon_restart');
      reportFailure(ctx, failed, 'The daemon restarted while the command was running');
    }
}

const SLOTS: Slot[] = ['before_dispatch', 'before_merge', 'after_merge'];

export function advanceSteps(ctx: ControlContext): void {
  for (const row of ctx.store.list<StoredWorkflowDefinition>('workflow_definitions')) {
    if (!row.trial) continue;
    const trial = row.trial;
    const done = trial.enrolled.filter((key) => {
      const [lead, task, generation] = JSON.parse(key) as [string, string, number];
      return ctx.store
        .list<StepRun>('workflow_step_runs')
        .filter(
          (run) =>
            run.lead_session_id === lead &&
            run.task_id === task &&
            run.generation === generation &&
            run.slot === trial.slot,
        )
        .every((run) => ['passed', 'failed', 'rejected', 'retired', 'skipped'].includes(run.state));
    }).length;
    if (done !== trial.done) {
      const next = ctx.store.update(
        'workflow_definitions',
        { ...row, trial: { ...trial, done } },
        row.revision,
      );
      if (done === trial.tasks)
        ctx.store.event('workflow.definition_trial_completed', next, row.project_id, {
          tasks: done,
        });
    }
  }
  for (const run of ctx.store.list<StepRun>('workflow_step_runs')) {
    const plan = ctx.store.get<BoardPlan>('board_plans', run.lead_session_id);
    if (
      run.state !== 'retired' &&
      (!plan?.tasks.some((t) => t.id === run.task_id) ||
        taskGeneration(plan, run.task_id) !== run.generation)
    )
      changeRun(ctx, run, 'retired');
  }
  const plans = ctx.store.list<BoardPlan>('board_plans');
  for (const projectId of new Set(plans.map((p) => p.project_id)))
    for (const entry of dispatchQueue(ctx, projectId))
      if (!entry.wait || entry.wait === 'step')
        startSlot(ctx, entry.plan, entry.task, 'before_dispatch');
  const children = childRuns(ctx);
  // Read for the tasks below, and read again after each call that may write.
  let read: { sessions: Session[]; plans: Map<string, BoardPlan>; runs: StepRun[] } | undefined;
  const current = () =>
    (read ??= {
      sessions: ctx.store.list<Session>('sessions'),
      plans: new Map(ctx.store.list<BoardPlan>('board_plans').map((each) => [each.id, each])),
      runs: ctx.store.list<StepRun>('workflow_step_runs'),
    });
  for (const plan of plans)
    for (const task of plan.tasks) {
      const sessions = taskSessions(
          ctx,
          plan.id,
          task.id,
          current().sessions,
          current().plans.get(plan.id),
        ),
        workflow = taskWorkflow(ctx, plan, task.id, sessions);
      if (
        applicableSteps(ctx, plan, task, 'after_merge', workflow).length ||
        storedDefinition(ctx, plan.project_id, workflow.id)?.trial?.slot === 'after_merge'
      ) {
        const sessionId = afterMergeSession(ctx, plan, task);
        if (sessionId) {
          startSlot(ctx, plan, task, 'after_merge', sessionId);
          read = undefined;
        }
      }
      for (const slot of SLOTS) {
        for (const run of liveRuns(ctx, plan, task.id, slot, current().runs)) {
          // A group's children are followed here too, since advanceRun waits for a held merge.
          for (const child of children.get(run.id) ?? [])
            followRun(ctx, ctx.store.must<StepRun>('workflow_step_runs', child.id));
          followRun(ctx, ctx.store.must<StepRun>('workflow_step_runs', run.id));
          read = undefined;
        }
        const live = liveRuns(ctx, plan, task.id, slot, current().runs);
        // Each parallel part holds its own merge, so its steps before the merge advance on their own.
        for (const sessionId of new Set(
          live.map((r) => (slot === 'before_merge' ? r.session_id : undefined)),
        )) {
          const next = live.find(
            (r) =>
              (slot !== 'before_merge' || r.session_id === sessionId) &&
              !['passed', 'skipped'].includes(r.state),
          );
          if (!next || !['pending', 'running'].includes(next.state)) continue;
          // Steps before the merge start once the gates have passed and the merge waits for them.
          if (
            slot === 'before_merge' &&
            ctx.store.get<Session>('sessions', next.session_id ?? '')?.merge?.reason !==
              'workflow_approval'
          )
            continue;
          // Direct commands before the merge are run by landing; composite children use the same verifier.
          if (slot === 'before_merge' && next.step.kind.type === 'command') continue;
          advanceRun(ctx, next);
          read = undefined;
        }
      }
    }
  for (const session of ctx.store.list<Session>('sessions')) {
    if (
      session.merge?.reason !== 'workflow_approval' ||
      session.state !== 'open' ||
      session.outcome ||
      session.stop_requested
    )
      continue;
    if (waitBeforeMerge(ctx, session)) continue;
    try {
      admitMerge(
        ctx,
        session,
        undefined,
        session.merge.allow_out_of_scope,
        undefined,
        session.merge.allowed_files,
      );
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const next = ctx.store.update(
        'sessions',
        { ...session, merge: { ...session.merge, state: 'blocked' as const, reason: error.code } },
        session.revision,
      );
      ctx.store.event('session.merge_blocked', next, next.project_id, next.merge);
      unsnooze(ctx, next.id, 'merge_blocked');
    }
  }
}

/** The fixed path and the values that govern it, for the web step chart. */
export function workflowDefinitionView(
  ctx: ControlContext,
  projectId: string,
  workflowId?: string,
): WorkflowDefinitionView {
  const current = workflowDefinition(ctx, projectId, undefined, workflowId),
    policy = workflowPolicy(ctx, projectId),
    trial = storedDefinition(ctx, projectId, current.id)?.trial,
    project = ctx.store.must<Project>('projects', projectId),
    results = workflowResults(
      ctx,
      projectId,
      current.id,
      new Set(
        Object.values(current.definition.slots)
          .flat()
          .map((step) => step.id),
      ),
    );
  return {
    ...current,
    ...(trial
      ? {
          trial: { tasks: trial.tasks, done: trial.done, previous_version: trial.previous_version },
        }
      : {}),
    ...(results.step_results ? { step_results: results.step_results } : {}),
    fixed_steps: [
      { id: 'plan', policy: {} },
      { id: 'plan_review', policy: current.definition.plan_review },
      {
        id: 'dispatch',
        policy: {
          path: policy.path,
          max_parallel: policy.max_parallel,
          runtime_parallel: policy.runtime_parallel,
          dispatch_paused: policy.dispatch_paused,
          runtime_quota_threshold: policy.runtime_quota_threshold,
          project_budget: policy.project_budget,
        },
      },
      { id: 'build', policy: {} },
      {
        id: 'gate',
        policy: {
          gates: project.gates,
          acceptance: 'task.acceptance',
          gate_on_fail: policy.gate_on_fail,
          gate_runner: policy.gate_runner,
        },
        ...(results.gate ? { result: results.gate } : {}),
      },
      { id: 'merge', policy: { auto_merge: autoMerge(ctx, project) } },
      { id: 'handback', policy: { handback_limit: policy.handback_limit } },
      { id: 'wake', policy: { acceptance_wake: policy.acceptance_wake } },
      {
        id: 'review',
        policy: current.definition.review,
        ...(results.review ? { result: results.review } : {}),
      },
      { id: 'acceptance', policy: { done_when: 'task.done_when' } },
    ],
  };
}

/**
 * Refuses a prompt skill that no inventory of the project's runtimes lists, or that the project
 * turned off on each runtime that lists it; undefined when the definition names no skill.
 */
export function checkWorkflowSkills(
  ctx: ControlContext,
  principal: Principal,
  input: { project_id: string; definition: WorkflowDefinition },
): Promise<void> | undefined {
  const skills = Object.values(input.definition.slots)
    .flat()
    .flatMap((step) =>
      step.kind.type === 'parallel'
        ? step.kind.steps
        : step.kind.type === 'loop'
          ? [step.kind.step]
          : [step],
    )
    .flatMap((step) => (step.kind.type === 'prompt' && step.kind.skill ? [step.kind.skill] : []));
  if (!skills.length) return;
  userOnly(principal);
  projectAccess(ctx, principal, input.project_id, 'workflow.definition.set');
  const project = ctx.store.must<Project>('projects', input.project_id);
  return Promise.all(
    [...ctx.adapters].map(async ([name, adapter]) => {
      if (!adapter.inventory) return [];
      const read = adapter.inventory.bind(adapter);
      const listed = (await Promise.all(project.roots.map((root) => read(root)))).flatMap(
        (inventory) => inventory.skills,
      );
      const overrides = project.extension_overrides?.[name],
        disabled = overrides
          ? closeUserExtensions(overrides, { mcp_servers: [], skills: listed }).disabled_skills
          : [];
      return listed.filter((s) => !disabled.includes(s.id) && !disabled.includes(s.name));
    }),
  ).then((offered) => {
    for (const skill of skills)
      requireThat(
        offered.flat().some((s) => s.name === skill.name && s.path === skill.path),
        'skill_unavailable',
        `Skill ${skill.name} is in no extension inventory of this project's runtimes, or the project turned it off`,
      );
  });
}

export const workflowEngineHandlers: Handlers = {
  'workflow.definition.save_as': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['workflow.definition.save_as'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    requireThat(
      !workflowDefinitionList(ctx, input.project_id).some((row) => row.name === input.name),
      'invalid_input',
      'Workflow name already exists in this project',
    );
    const from = workflowDefinition(ctx, input.project_id, undefined, input.from_id);
    // Materialize the original default so switching defaults cannot hide it.
    if (!storedDefinition(ctx, input.project_id, from.id))
      ctx.store.insert<StoredWorkflowDefinition>('workflow_definitions', {
        id: input.project_id,
        revision: 1,
        project_id: input.project_id,
        name: 'Default',
        is_default: true,
        definition_version: 0,
        definition: structuredClone(EMPTY_WORKFLOW_DEFINITION),
        versions: {},
      });
    const row = ctx.store.insert<StoredWorkflowDefinition>('workflow_definitions', {
      id: id(),
      revision: 1,
      project_id: input.project_id,
      name: input.name,
      is_default: false,
      definition_version: 1,
      definition: structuredClone(from.definition),
      versions: { 1: structuredClone(from.definition) },
    });
    ctx.store.event(
      'workflow.definition_created',
      row,
      input.project_id,
      { from_id: from.id, name: input.name },
      c.command_id,
    );
    return workflowDefinitionView(ctx, input.project_id, row.id);
  },
  'workflow.definition.set_default': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['workflow.definition.set_default'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    const row = storedDefinition(ctx, input.project_id, input.id);
    requireThat(row, 'not_found', 'Workflow has not been saved');
    const current = storedDefinition(ctx, input.project_id);
    if (current?.id === row.id) return workflowDefinitionView(ctx, input.project_id, row.id);
    if (current)
      ctx.store.update('workflow_definitions', { ...current, is_default: false }, current.revision);
    const next = ctx.store.update(
      'workflow_definitions',
      { ...row, is_default: true },
      row.revision,
    );
    ctx.store.event(
      'workflow.definition_default_changed',
      next,
      input.project_id,
      { id: row.id },
      c.command_id,
    );
    return workflowDefinitionView(ctx, input.project_id, row.id);
  },
  'workflow.definition.trial.decide': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['workflow.definition.trial.decide'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    const row = storedDefinition(ctx, input.project_id, input.id);
    requireThat(row, 'not_found', 'No workflow trial');
    requireThat(
      row.trial && row.trial.done === row.trial.tasks,
      'invalid_state',
      'Workflow trial has not finished',
    );
    const { trial, ...rest } = row;
    const definition =
      input.decision === 'keep'
        ? row.definition
        : workflowDefinition(ctx, row.project_id, trial.previous_version, row.id).definition;
    const version = row.definition_version + 1;
    const next = ctx.store.update(
      'workflow_definitions',
      {
        ...rest,
        definition,
        definition_version: version,
        versions: { ...row.versions, [version]: definition },
      },
      row.revision,
    );
    ctx.store.event(
      'workflow.definition_trial_decided',
      next,
      row.project_id,
      { decision: input.decision, definition_version: version },
      c.command_id,
    );
    return workflowDefinitionView(ctx, row.project_id, row.id);
  },
  'workflow.step.decide': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['workflow.step.decide'].parse(c.input);
    const run = ctx.store.must<StepRun>('workflow_step_runs', input.step_run_id);
    projectAccess(ctx, p, run.project_id, c.type);
    const plan = ctx.store.must<BoardPlan>('board_plans', run.lead_session_id);
    requireThat(
      plan.tasks.some((t) => t.id === run.task_id) &&
        taskGeneration(plan, run.task_id) === run.generation &&
        run.state === 'waiting' &&
        run.step.kind.type === 'approval',
      'invalid_state',
      'Workflow approval is no longer waiting',
    );
    const next = changeRun(
      ctx,
      run,
      input.decision === 'approve' ? 'passed' : 'rejected',
      input.reason,
      c.command_id,
    );
    if (input.decision === 'reject')
      reportFailure(ctx, next, input.reason ?? 'Rejected by the user', c.command_id);
    advanceSteps(ctx);
    return next;
  },
  'workflow.definition.set': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['workflow.definition.set'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    const old = storedDefinition(ctx, input.project_id, input.id);
    requireThat(
      input.base_version === (old?.definition_version ?? 0),
      'version_conflict',
      'Supply the current workflow definition base_version',
    );
    requireThat(
      !old?.trial,
      'invalid_state',
      'Decide the current workflow trial before changing the definition',
    );
    const trialSlot = (Object.keys(input.definition.slots) as Slot[]).find(
      (slot) =>
        canonical(input.definition.slots[slot]) !==
        canonical((old?.definition ?? EMPTY_WORKFLOW_DEFINITION).slots[slot]),
    );
    for (const [slot, steps] of Object.entries(input.definition.slots))
      for (const step of steps.flatMap((step) =>
        step.kind.type === 'parallel'
          ? step.kind.steps
          : step.kind.type === 'loop'
            ? [step.kind.step]
            : [step],
      ))
        requireThat(
          (step.kind.type !== 'review' || slot !== 'before_dispatch') &&
            (step.kind.type !== 'prompt' || step.kind.target === 'lead' || slot === 'before_merge'),
          'invalid_input',
          `Workflow step ${step.id} has no task session or changes to work on in ${slot}`,
        );
    if (old && canonical(old.definition) === canonical(input.definition))
      return { definition: old.definition, definition_version: old.definition_version };
    const definition_version = (old?.definition_version ?? 0) + 1;
    const value: StoredWorkflowDefinition = {
      id: old?.id ?? input.project_id,
      name: old?.name ?? 'Default',
      is_default: old?.is_default ?? true,
      revision: old?.revision ?? 1,
      project_id: input.project_id,
      definition_version,
      definition: input.definition,
      versions: { ...old?.versions, [definition_version]: input.definition },
      ...(old?.task_versions ? { task_versions: old.task_versions } : {}),
      ...(input.trial_tasks
        ? {
            trial: {
              tasks: input.trial_tasks,
              done: 0,
              previous_version: old?.definition_version ?? 0,
              slot: trialSlot ?? 'before_dispatch',
              enrolled: [],
              started_at: ctx.store.now(),
            },
          }
        : {}),
    };
    const stored = old
      ? ctx.store.update('workflow_definitions', value, old.revision)
      : ctx.store.insert('workflow_definitions', value);
    ctx.store.event(
      'workflow.definition_changed',
      stored,
      input.project_id,
      { definition_version, definition: input.definition },
      c.command_id,
    );
    return {
      id: stored.id,
      name: stored.name,
      is_default: stored.is_default,
      definition: stored.definition,
      definition_version,
    };
  },
};
