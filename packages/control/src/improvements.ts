import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  canonical,
  id,
  learnedGrade,
  requireThat,
  type AgentProfile,
  type BoardPlan,
  type EvalReceipt,
  type Improvement,
  type Principal,
  type Project,
  type Retrospective,
  type Session,
  type SignalIssue,
} from '@pantheon/domain';
import {
  inputSchemas,
  type Command,
  type ImprovementListItem,
  type ImprovementSession,
} from '@pantheon/protocol';
import {
  gitFolderAsync,
  insert,
  projectAccess,
  resolvedPath,
  userOnly,
  type ControlContext,
  type Handler,
  type Handlers,
  type Preparers,
} from './context.js';
import { changeKind, playbookEval } from './learned-change-kinds.js';
import { sessionTaskScope } from './memory-access.js';
import { agentAttempt, improvementSignals } from './improvement-signals.js';
import { armsCostChange } from './paired-stats.js';
import { exportPlaybook, playbookVersion, storedPlaybook } from './playbooks.js';
import { afterCommit } from './workbench-session.js';
import { changedPolicy, pinParam, policyValue, workflowPolicy } from './workflow-policy.js';

const LIST_LIMIT = 100;
/** How long the daemon waits before proposing a reverted or rejected change again, in milliseconds. */
const RETRY_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** The fewest tasks a trial is judged on, and the fewest tasks before it it is compared with, in tasks. */
const TRIAL_TASKS = 10;
/** How long a trial waits for its tasks before it is reverted for too few, in milliseconds. */
const TRIAL_WAIT_MS = 14 * 24 * 60 * 60 * 1000;
/** How far a target metric must fall below the tasks before the trial for it to stay, as a fraction. */
const BETTER_SHARE = 0.1;
/** How far the other of two metrics may rise while one falls, as a fraction. */
const WORSE_SHARE = 0.1;
/** The share of the findings per task before the trial that an experience's trial may keep at most, as a fraction. */
const FINDINGS_SHARE = 0.5;
/** How many more harmful than beneficial trial tasks a trial may have and stay, in tasks. */
const HARM_MARGIN = 3;
/** The confidence and bootstrap of the cost change of interleaved arms, as the eval report uses them. */
const PAIRED_COST = { confidence: 0.95, bootstrap: { resamples: 10_000, seed: 1 } };
type Verdict = NonNullable<NonNullable<Improvement['trial_evaluation']>['verdict']>;
/** The verdict of each reason the evaluator ends a trial for. */
const VERDICT: Record<string, Verdict> = {
  trial_passed: 'better',
  not_better: 'worse',
  insufficient_sample: 'not_enough_evidence',
  no_baseline: 'not_enough_evidence',
  no_conclusion: 'not_enough_evidence',
};

type Status = Improvement['status'];
type PolicyChange = Extract<Improvement['change'], { type: 'policy_change' }>;

function setStatus(
  ctx: ControlContext,
  improvement: Improvement,
  to: Status,
  commandId: string,
  fields: Partial<Improvement> = {},
  detail: Record<string, unknown> = {},
): Improvement {
  const now = ctx.store.now();
  const next = ctx.store.update<Improvement>(
    'improvements',
    {
      ...improvement,
      ...fields,
      status: to,
      // A trial held for want of a baseline goes on from its start.
      ...(to === 'trial' && improvement.status !== 'trial' && { trial_started_at: now }),
      ...(['active', 'reverted'].includes(to) &&
        improvement.status === 'trial' && {
          trial_evaluation: {
            ...trialEvidence(ctx, improvement),
            ...(fields.status_reason &&
              VERDICT[fields.status_reason] && { verdict: VERDICT[fields.status_reason] }),
          },
        }),
      ...(['active', 'reverted', 'rejected'].includes(to) && { decided_at: now }),
    },
    improvement.revision,
  );
  ctx.store.event(
    'improvement.status_changed',
    next,
    next.project_id,
    {
      improvement_id: next.id,
      from: improvement.status,
      to,
      ...(fields.status_reason && { reason: fields.status_reason }),
      ...(fields.status_detail && { detail: fields.status_detail }),
      ...detail,
    },
    commandId,
  );
  return next;
}

/** Puts the change in force: on trial when its grade is trial, else kept at once. */
function applyImprovement(
  ctx: ControlContext,
  improvement: Improvement,
  commandId: string,
  gitRoots: ReadonlySet<string> = new Set(),
) {
  const applied = changeKind(improvement.change).apply(ctx, improvement, commandId, gitRoots);
  if (applied.refusal) return setStatus(ctx, improvement, 'rejected', commandId, applied.refusal);
  return setStatus(
    ctx,
    improvement,
    learnedGrade(improvement.change) === 'trial' ? 'trial' : 'active',
    commandId,
    'from' in applied
      ? { change: { ...improvement.change, from: applied.from } as Improvement['change'] }
      : {},
  );
}

function revert(
  ctx: ControlContext,
  improvement: Improvement,
  commandId: string,
  fields: Partial<Improvement> = {},
  detail: Record<string, unknown> = {},
  gitRoots: ReadonlySet<string> = new Set(),
) {
  const kept = changeKind(improvement.change).revert(ctx, improvement, commandId, gitRoots);
  return setStatus(
    ctx,
    improvement,
    'reverted',
    commandId,
    kept ? { ...fields, status_detail: kept } : fields,
    detail,
  );
}

/** Whether the row changes what the change changes. */
const sameTarget = (row: Improvement, change: Improvement['change']) =>
  row.change.type === change.type && changeKind(change).sameTarget(row.change, change);

/** The count and revision sum of the retrospectives: it changes when one is recorded or replaced. */
const retrospectivesMark = (ctx: ControlContext) =>
  (
    ctx.store.db
      .prepare("SELECT count(*) || ':' || coalesce(sum(revision), 0) AS mark FROM retrospectives")
      .get() as { mark: string }
  ).mark;
/** The mark at the last pass over the signals and over the trials, by context. */
const passed = {
  signals: new WeakMap<ControlContext, string>(),
  trials: new WeakMap<ControlContext, string>(),
};

/**
 * Proposes the policy change of each signal that suggests one, and starts its trial in auto mode.
 * It runs only when the retrospectives changed: the tick runs many times a second and the signals
 * come from nothing else, so a mode change alone proposes nothing until the next task ends.
 */
export function proposeFromSignals(ctx: ControlContext): void {
  const mark = retrospectivesMark(ctx);
  if (passed.signals.get(ctx) === mark) return;
  passed.signals.set(ctx, mark);
  const now = ctx.store.now();
  const improvements = ctx.store.list<Improvement>('improvements');
  for (const project of ctx.store.list<Project>('projects')) {
    if (project.removed_at !== undefined) continue;
    const policy = workflowPolicy(ctx, project.id);
    if (policy.improvement_mode === 'off') continue;
    for (const finding of improvementSignals(ctx, project.id)) {
      const suggestion = finding.suggestion;
      // The rules suggest only policy changes; an experience's text comes from a lead.
      if (suggestion?.type !== 'policy_change' || finding.withheld) continue;
      const change = { ...suggestion, from: policyValue(policy, suggestion) };
      if (
        improvements
          .filter((row) => row.project_id === project.id && sameTarget(row, change))
          .some(
            (row) =>
              ['candidate', 'trial'].includes(row.status) ||
              (['reverted', 'rejected'].includes(row.status) &&
                canonical((row.change as PolicyChange).to) === canonical(suggestion.to) &&
                now - row.decided_at! < RETRY_AFTER_MS),
          )
      )
        continue;
      const improvement = insert<Improvement>(
        ctx,
        'improvements',
        {
          id: id(),
          revision: 1,
          project_id: project.id,
          source: 'daemon',
          signal: finding.signal,
          retrospective_ids: finding.retrospective_ids,
          status: 'candidate',
          change,
          proposed_at: now,
        },
        'improvement.proposed',
        project.id,
        '',
      );
      improvements.push(improvement);
      if (policy.improvement_mode === 'auto') applyImprovement(ctx, improvement, '');
    }
  }
}

const kindOf = (row: Retrospective) => row.measured_kind ?? row.planned_kind;
/** Whether the task counts for the trial: of the path's tier, or of the experience's domain, tier and runtime. */
function counts(change: Improvement['change'], row: Retrospective): boolean {
  if (change.type === 'policy_change') return !change.tier || kindOf(row)?.tier === change.tier;
  if (change.type !== 'experience') return false;
  return (
    (!change.domain || kindOf(row)?.domain === change.domain) &&
    (!change.tier || kindOf(row)?.tier === change.tier) &&
    (!change.runtime || row.runtime === change.runtime)
  );
}
/** The sum over the rows, leaving out a failed row that lacks the value; undefined when another row lacks it. */
const total = (rows: Retrospective[], value: (row: Retrospective) => number | undefined) =>
  rows.reduce<number | undefined>((sum, row) => {
    const one = value(row);
    if (one === undefined && row.outcome === 'failed') return sum;
    return sum === undefined || one === undefined ? undefined : sum + one;
  }, 0);
const inputTokens = (row: Retrospective) =>
  row.lead_usage || row.task_usage
    ? (row.lead_usage?.input_tokens ?? 0) + (row.task_usage?.input_tokens ?? 0)
    : undefined;
const wallMs = (row: Retrospective) => {
  const stages = Object.entries(row.stage_ms ?? {}).flatMap(([stage, ms]) =>
    stage === 'step_approval' || ms === undefined ? [] : [ms],
  );
  return stages.length ? stages.reduce((sum, ms) => sum + ms, 0) : undefined;
};
const waitAndExecutionMs = (row: Retrospective) =>
  row.stage_ms?.execution === undefined
    ? row.outcome === 'failed'
      ? row.stage_ms?.dispatch_wait
      : undefined
    : (row.stage_ms.dispatch_wait ?? 0) + row.stage_ms.execution;

/** The same domain, tier and runtime gate used for session instruction delivery. */
export function experienceMatchesSession(
  ctx: ControlContext,
  change: Extract<Improvement['change'], { type: 'experience' }>,
  session?: Session,
): boolean {
  const scope = sessionTaskScope(session);
  const task =
    scope &&
    ctx.store
      .get<BoardPlan>('board_plans', scope.lead_session_id)
      ?.tasks.find((task) => task.id === scope.id);
  return (
    !session?.runtime_review &&
    (!change.runtime || change.runtime === session?.runtime) &&
    (!change.domain || change.domain === task?.kind?.domain) &&
    (!change.tier || change.tier === task?.kind?.tier)
  );
}

export type Metric = (rows: Retrospective[]) => number | undefined;
/** The metrics a trial of the improvement is judged by; undefined when no rule judges it. */
function trialMetrics(
  ctx: ControlContext,
  improvement: Improvement,
): Record<string, Metric> | undefined {
  const change = improvement.change;
  if (change.type === 'experience') {
    const signal = improvement.signal;
    if (!signal) return undefined;
    const findings = (rows: Retrospective[]) =>
      improvementSignals(ctx, improvement.project_id, rows).filter(
        (found) => found.signal === signal,
      );
    return {
      signal_findings: (rows) => findings(rows).length,
      first_pass_without_findings: (rows) => {
        const found = new Set(findings(rows).flatMap((finding) => finding.retrospective_ids));
        return rows.filter((row) => row.gate_passed_on_attempt === 1 && !found.has(row.id)).length;
      },
    };
  }
  if (change.type !== 'policy_change') return undefined;
  const tokensAndWall: Record<string, Metric> = {
    input_tokens: (rows) => total(rows, inputTokens),
    wall_ms: (rows) => total(rows, wallMs),
  };
  switch (change.param) {
    case 'path':
    case 'task_size_hint':
      return tokensAndWall;
    case 'acceptance_wake':
      return {
        ...tokensAndWall,
        wakes_without_decision_per_task: (rows) => {
          const idle = total(rows, (row) => row.lead_wakes_without_decision);
          return idle === undefined || !rows.length ? undefined : idle / rows.length;
        },
      };
    case 'max_parallel':
      return { wait_and_execution_ms: (rows) => total(rows, waitAndExecutionMs) };
    case 'handback_limit':
    case 'runtime_quota_threshold':
    case 'budget':
      return undefined;
  }
}

/** The sample's tasks, first gate passes, merged or accepted tasks, and each metric. */
export const measure = (
  sample: Retrospective[],
  metrics?: Record<string, Metric>,
): Record<string, number | undefined> => ({
  tasks: sample.length,
  first_pass: sample.filter((row) => row.gate_passed_on_attempt === 1).length,
  delivered: sample.filter((row) => row.outcome === 'merged' || row.outcome === 'accepted').length,
  ...Object.fromEntries(Object.entries(metrics ?? {}).map(([key, of]) => [key, of(sample)])),
});

/** Shared task selection and measurements for evaluation and list reads. */
function trialEvidence(
  ctx: ControlContext,
  improvement: Improvement,
): NonNullable<Improvement['trial_evaluation']> {
  if (improvement.status !== 'trial' && improvement.trial_evaluation)
    return improvement.trial_evaluation;
  if (improvement.status !== 'trial') {
    const event = ctx.store.db
      .prepare(
        `SELECT json_extract(payload,'$.comparison') AS comparison FROM events
         WHERE aggregate_id=? AND kind='improvement.status_changed'
           AND json_extract(payload,'$.to') IN ('active','reverted')
           AND json_extract(payload,'$.comparison') IS NOT NULL
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(improvement.id);
    if (event) {
      const comparison = JSON.parse(String(event.comparison)) as NonNullable<
        Improvement['trial_evaluation']
      >['comparison'];
      const verdict = improvement.status_reason && VERDICT[improvement.status_reason];
      return {
        comparison,
        no_baseline:
          comparison.baseline.tasks! < TRIAL_TASKS ||
          Object.keys(comparison.trial).some((name) => comparison.baseline[name] === undefined),
        ...(verdict && { verdict }),
      };
    }
  }
  const started = improvement.trial_started_at!;
  const rows = ctx.store
    .list<Retrospective>('retrospectives')
    .filter(
      (row) =>
        row.project_id === improvement.project_id &&
        agentAttempt(row) &&
        counts(improvement.change, row) &&
        (improvement.status === 'trial' ||
          improvement.decided_at === undefined ||
          row.recorded_at <= improvement.decided_at),
    );
  // Tasks that took an arm of the trial ran on the same days as the tasks of the other arm.
  const arm = (row: Retrospective) => row.trial_arms?.[improvement.id];
  const interleaved = rows.some(arm);
  // A task under way at the start ran partly without the rule; legacy tasks count from recording.
  const after = rows
    .filter((row) =>
      interleaved ? arm(row) === 'new' : (row.started_at ?? row.recorded_at) > started,
    )
    .sort((a, b) => a.recorded_at - b.recorded_at);
  const before = interleaved
    ? rows.filter((row) => arm(row) === 'old').sort((a, b) => a.recorded_at - b.recorded_at)
    : rows
        .filter((row) => row.recorded_at < started)
        .sort((a, b) => b.recorded_at - a.recorded_at)
        .slice(0, after.length);
  const metrics = trialMetrics(ctx, improvement);
  const comparison = { baseline: measure(before, metrics), trial: measure(after, metrics) };
  const noBaseline =
    !metrics ||
    before.length < TRIAL_TASKS ||
    [...Object.values(comparison.baseline), ...Object.values(comparison.trial)].includes(undefined);
  // A task without input tokens is left out.
  const costs = (arm: Retrospective[]) => arm.flatMap((row) => inputTokens(row) || []);
  return {
    comparison,
    no_baseline: noBaseline,
    design: interleaved ? 'interleaved' : 'before_after',
    ...(interleaved &&
      before.length >= TRIAL_TASKS &&
      after.length >= TRIAL_TASKS && {
        paired_cost: armsCostChange(costs(before), costs(after), PAIRED_COST),
      }),
  };
}

type Measure = Record<string, number>;
const fell = (before: number, after: number) => after < before * (1 - BETTER_SHARE);
const rose = (before: number, after: number) => after > before * (1 + WORSE_SHARE);
/**
 * Whether the trial tasks passed their first gate run and were merged or accepted as often per
 * task, had at most HARM_MARGIN more harmful than beneficial tasks, cost less than the other arm
 * when the arms were interleaved, and moved the target metric enough per task; undefined when the
 * interval of the arms' paired cost holds no change.
 */
function better(
  change: Improvement['change'],
  before: Measure,
  after: Measure,
  pairedCost?: NonNullable<Improvement['trial_evaluation']>['paired_cost'],
): boolean | undefined {
  const perTask = (measure: Measure, key: string) => measure[key]! / measure.tasks!;
  if (perTask(after, 'first_pass') < perTask(before, 'first_pass')) return false;
  if (perTask(after, 'delivered') < perTask(before, 'delivered')) return false;
  // Harmful: failed its first gate run; beneficial: passed it, and showed no finding of an experience's signal.
  const harmful = after.tasks! - after.first_pass!,
    beneficial = after.first_pass_without_findings ?? after.first_pass!;
  if (harmful - beneficial > HARM_MARGIN) return false;
  if (pairedCost) {
    const [lower, upper] = pairedCost.interval ?? [0, 0];
    if (lower > 0) return false;
    if (upper >= 0) return undefined;
  }
  if (change.type === 'experience')
    return perTask(after, 'signal_findings') <= perTask(before, 'signal_findings') * FINDINGS_SHARE;
  if (change.type !== 'policy_change') return false;
  if (change.param === 'max_parallel')
    return fell(perTask(before, 'wait_and_execution_ms'), perTask(after, 'wait_and_execution_ms'));
  const tokens = [perTask(before, 'input_tokens'), perTask(after, 'input_tokens')] as const,
    wall = [perTask(before, 'wall_ms'), perTask(after, 'wall_ms')] as const;
  if (change.param === 'acceptance_wake')
    return (
      fell(before.wakes_without_decision_per_task!, after.wakes_without_decision_per_task!) &&
      !rose(...tokens) &&
      !rose(...wall)
    );
  return (fell(...tokens) && !rose(...wall)) || (fell(...wall) && !rose(...tokens));
}

/** Keeps or reverts each trial once its tasks are in, against as many tasks before it as there are. */
export function evaluateTrials(ctx: ControlContext): void {
  const trials = ctx.store
    .list<Improvement>('improvements')
    .filter((row) => row.status === 'trial');
  if (!trials.length) return;
  const now = ctx.store.now(),
    mark = retrospectivesMark(ctx);
  // A trial's outcome changes only with the retrospectives or when its wait runs out.
  if (
    passed.trials.get(ctx) === mark &&
    !trials.some((row) => now - row.trial_started_at! >= TRIAL_WAIT_MS)
  )
    return;
  passed.trials.set(ctx, mark);
  for (const improvement of trials) {
    const started = improvement.trial_started_at!;
    const {
      comparison,
      no_baseline: noBaseline,
      paired_cost: pairedCost,
    } = trialEvidence(ctx, improvement);
    const tasksSeen = comparison.trial.tasks!;
    if (tasksSeen < TRIAL_TASKS) {
      if (now - started >= TRIAL_WAIT_MS)
        revert(ctx, improvement, '', {
          status_reason: 'insufficient_sample',
          status_detail: `Weak evidence: ${tasksSeen} / ${TRIAL_TASKS} tasks`,
        });
      continue;
    }
    if (noBaseline) {
      if (now - started >= TRIAL_WAIT_MS)
        revert(
          ctx,
          improvement,
          '',
          {
            status_reason: 'no_baseline',
            status_detail: `Weak evidence: no ${TRIAL_TASKS} earlier tasks measured to compare with`,
          },
          { comparison },
        );
      else if (improvement.status_reason !== 'no_baseline')
        setStatus(ctx, improvement, 'trial', '', { status_reason: 'no_baseline' }, { comparison });
      continue;
    }
    const judged = better(
      improvement.change,
      comparison.baseline as Measure,
      comparison.trial as Measure,
      pairedCost,
    );
    if (judged)
      setStatus(ctx, improvement, 'active', '', { status_reason: 'trial_passed' }, { comparison });
    else
      revert(
        ctx,
        improvement,
        '',
        { status_reason: judged === undefined ? 'no_conclusion' : 'not_better' },
        { comparison },
      );
  }
}

export const improvementHandlers: Handlers = {
  'improvement.propose': (ctx, p, c) => {
    const input = inputSchemas['improvement.propose'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    ctx.store.must<Project>('projects', input.project_id);
    const retrospectiveIds = input.retrospective_ids ?? [];
    requireThat(
      retrospectiveIds.length || input.evidence,
      'invalid_input',
      'Give retrospective_ids or evidence',
    );
    const tables = {
      retrospective: 'retrospectives',
      signal_issue: 'signal_issues',
      session: 'sessions',
    } as const;
    const missing = [
      ...retrospectiveIds.map((id) => ({ kind: 'retrospective' as const, id })),
      ...(input.evidence ?? []).flatMap((entry) => (entry.kind === 'eval_receipt' ? [] : [entry])),
    ].filter(({ kind, id }) =>
      kind === 'gate_run'
        ? !ctx.store
            .kindEvents(input.project_id, ['session.gate_checked'])
            .some((event) => event.event_id === id)
        : ctx.store.get<Retrospective | SignalIssue | Session>(tables[kind], id)?.project_id !==
          input.project_id,
    );
    requireThat(
      !missing.length,
      'invalid_input',
      `No such record of this project: ${missing.map(({ kind, id }) => `${kind} ${id}`).join(', ')}`,
    );
    const policy = workflowPolicy(ctx, input.project_id);
    requireThat(
      policy.improvement_mode !== 'off',
      'permission_denied',
      'Improvements are off for this project',
    );
    let change: Improvement['change'];
    if (input.change.type === 'policy_change') {
      const proposed = input.change;
      requireThat(
        !policy.pinned.includes(proposed.param),
        'permission_denied',
        `The user pinned ${proposed.param}`,
      );
      changedPolicy(policy, proposed);
      requireThat(
        proposed.param !== 'handback_limit' || proposed.to !== 0,
        'invalid_input',
        'handback_limit proposals must be from 2 to 5',
      );
      const from = policyValue(policy, proposed);
      requireThat(
        canonical(from) !== canonical(proposed.to),
        'invalid_input',
        `${proposed.param} is already ${canonical(proposed.to)}`,
      );
      change = { ...proposed, from };
    } else if (input.change.type === 'gate_command')
      change = { ...input.change, root: resolvedPath(input.change.root) };
    else if (input.change.type === 'agent_instructions') {
      const { agent_id } = input.change;
      requireThat(
        ctx.store.get<AgentProfile>('agents', agent_id)?.project_id === input.project_id,
        'invalid_input',
        `No agent of this project: ${agent_id}`,
      );
      change = input.change;
    } else if (input.change.type === 'playbook') {
      const { runtime, to } = input.change;
      requireThat(
        storedPlaybook(ctx, input.project_id, runtime)?.versions[to] !== undefined,
        'invalid_input',
        `Playbook version ${to} is not stored`,
      );
      requireThat(
        playbookVersion(ctx, input.project_id, runtime) !== to,
        'invalid_input',
        `Playbook version ${to} is current already`,
      );
      change = input.change;
    } else change = input.change;
    requireThat(
      !ctx.store
        .list<Improvement>('improvements')
        .some(
          (other) =>
            other.project_id === input.project_id &&
            ['candidate', 'trial'].includes(other.status) &&
            sameTarget(other, change),
        ),
      'invalid_state',
      `Another improvement of ${
        change.type === 'policy_change'
          ? change.param
          : change.type === 'gate_command'
            ? `the gate of ${change.root}`
            : change.type === 'agent_instructions'
              ? `the instructions of agent ${change.agent_id}`
              : change.type === 'playbook'
                ? 'the playbook'
                : 'the worktree setup'
      } is waiting or on trial`,
    );
    const improvementId = id();
    // A playbook change without a receipt would be refused on confirm, so it records the eval it needs.
    const evalRequest =
      change.type === 'playbook' &&
      !input.evidence?.some((entry) => entry.kind === 'eval_receipt') &&
      playbookEval(ctx, { id: improvementId, project_id: input.project_id }, change.runtime, [
        playbookVersion(ctx, input.project_id, change.runtime),
        change.to,
      ]).request;
    const improvement = insert<Improvement>(
      ctx,
      'improvements',
      {
        id: improvementId,
        revision: 1,
        project_id: input.project_id,
        lead_session_id: p.session_id!,
        source: 'lead',
        retrospective_ids: retrospectiveIds,
        ...(input.evidence && { evidence: input.evidence }),
        ...(evalRequest && { eval_request: evalRequest }),
        status: 'candidate',
        change,
        proposed_at: ctx.store.now(),
      },
      'improvement.proposed',
      input.project_id,
      c.command_id,
    );
    if (policy.improvement_mode !== 'auto' || learnedGrade(change) !== 'trial') return improvement;
    return applyImprovement(ctx, improvement, c.command_id);
  },
  'improvement.decide': (ctx, p, c) => decide(ctx, p, c),
  'eval.request.run': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['eval.request.run'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    const improvement = ctx.store.get<Improvement>('improvements', input.improvement_id);
    requireThat(
      improvement?.project_id === input.project_id,
      'not_found',
      `improvements/${input.improvement_id}`,
    );
    const { change, eval_request: request } = improvement;
    requireThat(
      change.type === 'playbook' && request && improvement.status === 'candidate',
      'invalid_state',
      'Only a waiting playbook change with an eval request has an eval to run',
    );
    requireThat(
      workflowPolicy(ctx, input.project_id).eval_runner !== 'off',
      'invalid_state',
      'The eval runner is off for this project; run the eval_request command yourself, or turn eval_runner on',
    );
    let running = runningEvals.get(ctx);
    if (!running) runningEvals.set(ctx, (running = new Set()));
    requireThat(
      !running.has(improvement.id),
      'invalid_state',
      'The eval of this improvement is running',
    );
    for (const version of request.conditions)
      exportPlaybook(ctx, input.project_id, change.runtime, version);
    const { checkout, args, out } = playbookEval(
      ctx,
      improvement,
      change.runtime,
      request.conditions,
    );
    const committed = afterCommit(ctx);
    running.add(improvement.id);
    void Promise.resolve()
      .then(async () => {
        if (!committed()) return;
        const code = await (ctx.evalRunner ?? spawnEval)(checkout, args);
        const runsFile = path.join(out, 'runs.jsonl');
        if (code !== 0 || !existsSync(runsFile))
          throw new Error(`The eval of improvement ${improvement.id} exited ${code} without runs`);
        if (ctx.closing) return;
        // The receipt carries the report's verdict for the proposed version; confirming checks it against the runs.
        const second = args[args.lastIndexOf('--condition') + 1];
        const verdicts = [
          ...readFileSync(path.join(out, 'report.md'), 'utf8').matchAll(
            /^Verdict: (.+?) (leaks less|passes more|cheaper)\b/gm,
          ),
        ].map(([, condition, what]) => `${condition}_${what!.replace(' ', '_')}`);
        const receipt: EvalReceipt = {
          kind: 'eval_receipt',
          path: runsFile,
          sha256: createHash('sha256').update(readFileSync(runsFile)).digest('hex'),
          verdict:
            verdicts.find((verdict) => verdict.startsWith(`${second}_`)) ??
            verdicts[0] ??
            'no_conclusion',
        };
        ctx.store.transaction(() => {
          const current = ctx.store.must<Improvement>('improvements', improvement.id);
          const next = ctx.store.update<Improvement>(
            'improvements',
            { ...current, evidence: [...(current.evidence ?? []), receipt] },
            current.revision,
          );
          ctx.store.event(
            'improvement.evidence_added',
            next,
            next.project_id,
            { improvement_id: next.id, evidence: receipt },
            c.command_id,
          );
        });
        ctx.changed();
      })
      .catch((error: unknown) => ctx.diagnostic(error))
      .finally(() => running.delete(improvement.id));
    return improvement;
  },
};

/** The improvements whose eval this daemon started and that has not ended, by context. */
const runningEvals = new WeakMap<ControlContext, Set<string>>();

/** Runs node with args in cwd detached, so a daemon restart does not stop the eval; only this daemon attaches its receipt. */
const spawnEval = (cwd: string, args: string[]) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? -1));
    child.unref();
  });

/** A gate change reads its root as a git folder before the transaction. */
export const improvementPreparers: Preparers = {
  'improvement.decide': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['improvement.decide'].parse(c.input);
    const change = ctx.store.get<Improvement>('improvements', input.improvement_id)?.change;
    if (change?.type !== 'gate_command' || !['confirm', 'revert'].includes(input.decision))
      return improvementHandlers['improvement.decide']!;
    return gitFolderAsync(change.root).then(
      (git): Handler =>
        (ctx, p, c) =>
          decide(ctx, p, c, new Set(git ? [change.root] : [])),
    );
  },
};

function decide(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  gitRoots: ReadonlySet<string> = new Set(),
) {
  userOnly(p);
  const input = inputSchemas['improvement.decide'].parse(c.input);
  projectAccess(ctx, p, input.project_id, c.type);
  ctx.store.must<Project>('projects', input.project_id);
  const improvement = ctx.store.get<Improvement>('improvements', input.improvement_id);
  requireThat(
    improvement?.project_id === input.project_id,
    'not_found',
    `improvements/${input.improvement_id}`,
  );
  const status = improvement.status;
  const fits = (...statuses: Status[]) =>
    requireThat(
      statuses.includes(status),
      'invalid_state',
      `Cannot ${input.decision} an improvement in ${status}`,
    );
  switch (input.decision) {
    case 'confirm':
      fits('candidate');
      return applyImprovement(ctx, improvement, c.command_id, gitRoots);
    case 'reject':
      fits('candidate');
      return setStatus(ctx, improvement, 'rejected', c.command_id, {
        reject_reason: input.reject_reason,
        reject_note: input.reject_note,
      });
    case 'revert':
      fits('trial', 'active');
      return revert(ctx, improvement, c.command_id, {}, {}, gitRoots);
    case 'pin': {
      const change = improvement.change;
      requireThat(
        change.type === 'policy_change',
        'invalid_input',
        'Only a policy change can be pinned',
      );
      fits('trial', 'active');
      pinParam(
        ctx,
        improvement.project_id,
        change.param,
        { improvement_id: improvement.id },
        c.command_id,
      );
      return status === 'trial' ? setStatus(ctx, improvement, 'active', c.command_id) : improvement;
    }
  }
}

/** The project's improvements, newest first, optionally of one status. */
export function improvementList(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  status?: Status,
): ImprovementListItem[] {
  projectAccess(ctx, principal, projectId, 'improvement.list');
  ctx.store.must<Project>('projects', projectId);
  return ctx.store
    .list<Improvement>('improvements')
    .filter((row) => row.project_id === projectId && (!status || row.status === status))
    .sort((a, b) => b.proposed_at - a.proposed_at)
    .slice(0, LIST_LIMIT)
    .map((row) => {
      const { trial_evaluation: _, ...rest } = row;
      const item = { ...rest, grade: learnedGrade(row.change) };
      if (row.trial_started_at === undefined) return item;
      const evidence = trialEvidence(ctx, row);
      const { comparison, no_baseline: noBaseline } = evidence;
      const units: Record<string, string> = {
        first_pass: 'tasks',
        input_tokens: 'tokens',
        wall_ms: 'milliseconds',
        wait_and_execution_ms: 'milliseconds',
        wakes_without_decision_per_task: 'wakes/task',
        signal_findings: 'findings',
        first_pass_without_findings: 'tasks',
      };
      return {
        ...item,
        trial: {
          tasks_seen: comparison.trial.tasks!,
          tasks_required: TRIAL_TASKS,
          baseline_tasks: comparison.baseline.tasks!,
          ...(noBaseline && { status_reason: 'no_baseline' as const }),
          ...('verdict' in evidence && evidence.verdict && { verdict: evidence.verdict }),
          ...(evidence.design && { design: evidence.design }),
          metrics: Object.keys(comparison.trial)
            .filter((name) => name !== 'tasks' && name !== 'delivered')
            .map((name) => ({
              name,
              unit: units[name]!,
              ...(comparison.baseline.tasks && comparison.baseline[name] !== undefined
                ? { baseline: comparison.baseline[name] }
                : {}),
              ...(comparison.trial.tasks && comparison.trial[name] !== undefined
                ? { trial: comparison.trial[name] }
                : {}),
            })),
        },
      };
    });
}

export function improvementSessions(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  improvementId: string,
): ImprovementSession[] {
  projectAccess(ctx, principal, projectId, 'improvement.sessions');
  ctx.store.must<Project>('projects', projectId);
  const improvement = ctx.store.get<Improvement>('improvements', improvementId);
  requireThat(improvement?.project_id === projectId, 'not_found', `improvements/${improvementId}`);
  const change = improvement.change;
  if (change.type !== 'experience') return [];
  return ctx.store
    .list<Session>('sessions')
    .filter(
      (session) =>
        session.project_id === projectId &&
        !session.archived_at &&
        experienceMatchesSession(ctx, change, session),
    )
    .map((session) => ({
      session_id: session.id,
      title: session.title,
      delivered:
        session.memory_delivery?.delivered_experience_ids?.includes(improvement.id) ?? false,
    }));
}
