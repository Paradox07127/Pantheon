import {
  canonical,
  id,
  requireThat,
  type BoardPlan,
  type Improvement,
  type Principal,
  type Project,
  type Retrospective,
  type Session,
} from '@pantheon/domain';
import {
  inputSchemas,
  type ImprovementListItem,
  type ImprovementSession,
} from '@pantheon/protocol';
import { insert, projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { screenExperience } from './experience-screen.js';
import { sessionTaskScope } from './memory-access.js';
import { agentAttempt, improvementSignals } from './improvement-signals.js';
import {
  applyPolicyChange,
  changedPolicy,
  pinParam,
  policyValue,
  workflowPolicy,
} from './workflow-policy.js';

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
type Verdict = NonNullable<NonNullable<Improvement['trial_evaluation']>['verdict']>;
/** The verdict of each reason the evaluator ends a trial for. */
const VERDICT: Record<string, Verdict> = {
  trial_passed: 'better',
  not_better: 'worse',
  insufficient_sample: 'not_enough_evidence',
  no_baseline: 'not_enough_evidence',
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

function startTrial(ctx: ControlContext, improvement: Improvement, commandId: string) {
  const change = improvement.change;
  if (change.type === 'experience') {
    const refusal = screenExperience(
      ctx.store.must<Project>('projects', improvement.project_id),
      change,
    );
    return refusal
      ? setStatus(ctx, improvement, 'rejected', commandId, refusal)
      : setStatus(ctx, improvement, 'trial', commandId);
  }
  const from = applyPolicyChange(
    ctx,
    improvement.project_id,
    change,
    { improvement_id: improvement.id },
    commandId,
  );
  return setStatus(ctx, improvement, 'trial', commandId, { change: { ...change, from } });
}

function revert(
  ctx: ControlContext,
  improvement: Improvement,
  commandId: string,
  fields: Partial<Improvement> = {},
  detail: Record<string, unknown> = {},
) {
  const change = improvement.change;
  if (change.type !== 'policy_change')
    return setStatus(ctx, improvement, 'reverted', commandId, fields, detail);
  const now = policyValue(workflowPolicy(ctx, improvement.project_id), change);
  if (canonical(now) !== canonical(change.to))
    return setStatus(
      ctx,
      improvement,
      'reverted',
      commandId,
      {
        ...fields,
        status_detail: `${change.param} was changed to ${canonical(now)} since the trial started, so it stays`,
      },
      detail,
    );
  applyPolicyChange(
    ctx,
    improvement.project_id,
    { param: change.param, tier: change.tier, to: change.from },
    { improvement_id: improvement.id },
    commandId,
  );
  return setStatus(ctx, improvement, 'reverted', commandId, fields, detail);
}

const samePolicyTarget = (a: Improvement['change'], b: Pick<PolicyChange, 'param' | 'tier'>) =>
  a.type === 'policy_change' && a.param === b.param && a.tier === b.tier;

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
      const sameTarget = improvements.filter(
        (row) => row.project_id === project.id && samePolicyTarget(row.change, suggestion),
      );
      if (
        sameTarget.some(
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
          change: { ...suggestion, from: policyValue(policy, suggestion) },
          proposed_at: now,
        },
        'improvement.proposed',
        project.id,
        '',
      );
      improvements.push(improvement);
      if (policy.improvement_mode === 'auto') startTrial(ctx, improvement, '');
    }
  }
}

const kindOf = (row: Retrospective) => row.measured_kind ?? row.planned_kind;
/** Whether the task counts for the trial: of the path's tier, or of the experience's domain, tier and runtime. */
function counts(change: Improvement['change'], row: Retrospective): boolean {
  if (change.type === 'policy_change') return !change.tier || kindOf(row)?.tier === change.tier;
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

type Metric = (rows: Retrospective[]) => number | undefined;
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

/** Shared task selection and measurements for evaluation and list reads. */
function trialEvidence(ctx: ControlContext, improvement: Improvement) {
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
  // A task under way at the start ran partly without the rule; legacy tasks count from recording.
  const after = rows
    .filter((row) => (row.started_at ?? row.recorded_at) > started)
    .sort((a, b) => a.recorded_at - b.recorded_at);
  const before = rows
    .filter((row) => row.recorded_at < started)
    .sort((a, b) => b.recorded_at - a.recorded_at)
    .slice(0, after.length);
  const metrics = trialMetrics(ctx, improvement);
  const measure = (sample: Retrospective[]): Record<string, number | undefined> => ({
    tasks: sample.length,
    first_pass: sample.filter((row) => row.gate_passed_on_attempt === 1).length,
    delivered: sample.filter((row) => row.outcome === 'merged' || row.outcome === 'accepted')
      .length,
    ...Object.fromEntries(Object.entries(metrics ?? {}).map(([key, of]) => [key, of(sample)])),
  });
  const comparison = { baseline: measure(before), trial: measure(after) };
  const noBaseline =
    !metrics ||
    before.length < TRIAL_TASKS ||
    [...Object.values(comparison.baseline), ...Object.values(comparison.trial)].includes(undefined);
  return { comparison, no_baseline: noBaseline };
}

type Measure = Record<string, number>;
const fell = (before: number, after: number) => after < before * (1 - BETTER_SHARE);
const rose = (before: number, after: number) => after > before * (1 + WORSE_SHARE);
/**
 * Whether the trial tasks passed their first gate run and were merged or accepted as often per
 * task, had at most HARM_MARGIN more harmful than beneficial tasks, and moved the target metric
 * enough per task.
 */
function better(change: Improvement['change'], before: Measure, after: Measure): boolean {
  const perTask = (measure: Measure, key: string) => measure[key]! / measure.tasks!;
  if (perTask(after, 'first_pass') < perTask(before, 'first_pass')) return false;
  if (perTask(after, 'delivered') < perTask(before, 'delivered')) return false;
  // Harmful: failed its first gate run; beneficial: passed it, and showed no finding of an experience's signal.
  const harmful = after.tasks! - after.first_pass!,
    beneficial = after.first_pass_without_findings ?? after.first_pass!;
  if (harmful - beneficial > HARM_MARGIN) return false;
  if (change.type === 'experience')
    return perTask(after, 'signal_findings') <= perTask(before, 'signal_findings') * FINDINGS_SHARE;
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
    const { comparison, no_baseline: noBaseline } = trialEvidence(ctx, improvement);
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
    if (better(improvement.change, comparison.baseline as Measure, comparison.trial as Measure))
      setStatus(ctx, improvement, 'active', '', { status_reason: 'trial_passed' }, { comparison });
    else revert(ctx, improvement, '', { status_reason: 'not_better' }, { comparison });
  }
}

export const improvementHandlers: Handlers = {
  'improvement.propose': (ctx, p, c) => {
    const input = inputSchemas['improvement.propose'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    ctx.store.must<Project>('projects', input.project_id);
    const missing = input.retrospective_ids.filter(
      (retrospectiveId) =>
        ctx.store.get<Retrospective>('retrospectives', retrospectiveId)?.project_id !==
        input.project_id,
    );
    requireThat(
      !missing.length,
      'invalid_input',
      `No retrospective of this project: ${missing.join(', ')}`,
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
      requireThat(
        !ctx.store
          .list<Improvement>('improvements')
          .some(
            (other) =>
              other.project_id === input.project_id &&
              ['candidate', 'trial'].includes(other.status) &&
              samePolicyTarget(other.change, proposed),
          ),
        'invalid_state',
        `Another improvement of ${proposed.param} is waiting or on trial`,
      );
    } else change = input.change;
    const improvement = insert<Improvement>(
      ctx,
      'improvements',
      {
        id: id(),
        revision: 1,
        project_id: input.project_id,
        lead_session_id: p.session_id!,
        source: 'lead',
        retrospective_ids: input.retrospective_ids,
        status: 'candidate',
        change,
        proposed_at: ctx.store.now(),
      },
      'improvement.proposed',
      input.project_id,
      c.command_id,
    );
    if (policy.improvement_mode !== 'auto') return improvement;
    return startTrial(ctx, improvement, c.command_id);
  },
  'improvement.decide': (ctx, p, c) => {
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
        return startTrial(ctx, improvement, c.command_id);
      case 'reject':
        fits('candidate');
        return setStatus(ctx, improvement, 'rejected', c.command_id, {
          reject_reason: input.reject_reason,
          reject_note: input.reject_note,
        });
      case 'revert':
        fits('trial', 'active');
        return revert(ctx, improvement, c.command_id);
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
        return status === 'trial'
          ? setStatus(ctx, improvement, 'active', c.command_id)
          : improvement;
      }
    }
  },
};

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
      const { trial_evaluation: _, ...item } = row;
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
