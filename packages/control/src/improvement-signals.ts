import { toolCommand } from '@pantheon/adapters';
import type { ImprovementSignalFinding } from '@pantheon/protocol';
import type {
  AgentEvent,
  Approval,
  Event,
  LandingItem,
  Project,
  Retrospective,
  ImprovementSignal,
  TaskKind,
  WorkflowParam,
  WorkflowPolicy,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { projectDefaults } from './user-config.js';
import { DEFAULT_WORKFLOW_POLICY, ownPolicySettings, workflowPolicy } from './workflow-policy.js';

/** The latest tasks a windowed rule reads, in retrospectives. */
const RECENT_TASKS = 5;
/** The lead's share of the lead plus task input tokens that dispatch_overhead exceeds, as a fraction. */
const LEAD_INPUT_SHARE = 0.6;
/** Direct tasks of the window whose gate did not pass on the first run that make direct_rework, in tasks. */
const REWORK_TASKS = 2;
/** The lead wakes idle_wakeups counts back to at least, in wakes. */
const IDLE_WAKES = 10;
/** The share of those wakes without a decision that idle_wakeups exceeds, as a fraction. */
const IDLE_SHARE = 0.5;
/** The share of execution time the dispatch wait of the window exceeds for queue_wait, as a fraction. */
const QUEUE_WAIT_SHARE = 0.5;
/** Tasks of the window handed back a rebase conflict that make merge_conflicts, in tasks. */
const CONFLICT_TASKS = 2;
/** Tasks of the window over their budget that make over_budget, in tasks. */
const OVER_BUDGET_TASKS = 3;
/** Different tasks one failed check or turn failure code appears in for a repeat signal, in tasks. */
const REPEAT_TASKS = 2;
/** Rolling window of command approvals and gate failures, in milliseconds. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** User approvals without a refusal that make always_approved_command, in approvals. */
const COMMAND_APPROVALS = 5;
/** Runs failing after passing predecessors that make late_gate_failure, in runs. */
const LATE_GATE_RUNS = 3;

const kindOf = (row: Retrospective) => row.measured_kind ?? row.planned_kind;
const ids = (rows: Retrospective[]) => rows.map((row) => row.id);
const taskKey = (row: Retrospective) => JSON.stringify([row.lead_session_id, row.task_id]);
const firstPass = (row: Retrospective) => row.gate_passed_on_attempt === 1;
const gated = (row: Retrospective) =>
  row.gate_passed_on_attempt !== undefined || !!row.gate_failures?.length;
const conflicted = (row: Retrospective) =>
  !!row.handbacks?.some((handback) => handback.reason === 'rebase_conflict');
const sum = (rows: Retrospective[], value: (row: Retrospective) => number | undefined) =>
  rows.reduce((total, row) => total + (value(row) ?? 0), 0);

/** The newest rows of each (domain, tier) cell, newest first. */
function byCell(rows: Retrospective[]): { cell: TaskKind; rows: Retrospective[] }[] {
  const cells = new Map<string, { cell: TaskKind; rows: Retrospective[] }>();
  for (const row of rows) {
    const kind = kindOf(row);
    if (!kind) continue;
    const key = `${kind.domain}:${kind.tier}`;
    const entry = cells.get(key) ?? { cell: { domain: kind.domain, tier: kind.tier }, rows: [] };
    cells.set(key, entry);
    entry.rows.push(row);
  }
  return [...cells.values()];
}

/** Rows that appear in at least REPEAT_TASKS tasks under the same value, one finding per value. */
function repeated(
  signal: ImprovementSignal,
  rows: Retrospective[],
  values: (row: Retrospective) => string[] | undefined,
): ImprovementSignalFinding[] {
  const found = new Map<string, Retrospective[]>();
  for (const row of rows)
    for (const value of new Set(values(row) ?? []))
      found.set(value, [...(found.get(value) ?? []), row]);
  return [...found.values()]
    .filter((matches) => new Set(matches.map(taskKey)).size >= REPEAT_TASKS)
    .map((matches) => ({ signal, retrospective_ids: ids(matches) }));
}

/** The handback_limit changes among the events, with when each was made. */
const limitChanges = (events: Event[]) =>
  events
    .filter(
      (event) =>
        event.kind === 'workflow.policy_changed' &&
        (event.payload as { param: string }).param === 'handback_limit',
    )
    .map((event) => ({
      ...(event.payload as { from: number; policy_version?: number }),
      sequence: event.sequence,
      created_at: event.created_at,
    }));

/** The handback_limit in force when the row's task started; the current one for a row without a version. */
function handbackLimits(
  events: Event[],
  globalEvents: Event[],
  policy: WorkflowPolicy,
  followsGlobal: boolean,
): (row: Retrospective) => number {
  const changes = limitChanges(events);
  // A change of the global limit reaches a project that sets none itself.
  const globalChanges = followsGlobal ? limitChanges(globalEvents) : [];
  return (row) => {
    const version = row.policy_version;
    if (version === undefined) return policy.handback_limit;
    // The first later change of the limit starts from the value in force at the version.
    const later = [
      changes.find((change) => change.policy_version! > version),
      row.started_at === undefined
        ? undefined
        : globalChanges.find((change) => change.created_at > row.started_at!),
    ]
      .filter((change) => change !== undefined)
      .sort((a, b) => a.sequence - b.sequence)[0];
    return later ? later.from : policy.handback_limit;
  };
}

/** A task the agents carried to an end: merged, accepted, or failed without the user stopping it. */
export const agentAttempt = (row: Retrospective) =>
  row.outcome === 'merged' ||
  row.outcome === 'accepted' ||
  (row.outcome === 'failed' && row.stopped_by !== 'user');

/** Fixed signals from agent-attempt retrospectives and project events; `of` limits the retrospective rules. */
export function improvementSignals(
  ctx: ControlContext,
  projectId: string,
  of?: Retrospective[],
): ImprovementSignalFinding[] {
  const policy = workflowPolicy(ctx, projectId);
  const rows = (of ?? ctx.store.list<Retrospective>('retrospectives'))
    .filter((row) => row.project_id === projectId && agentAttempt(row))
    .sort((a, b) => b.recorded_at - a.recorded_at);
  const recent = rows.slice(0, RECENT_TASKS);
  const findings: ImprovementSignalFinding[] = [];
  /** Adds the finding, withheld when its parameter is pinned or already has the suggested value. */
  const suggest = (
    finding: Omit<ImprovementSignalFinding, 'suggestion'>,
    param: WorkflowParam,
    current: unknown,
    to: unknown,
    tier?: TaskKind['tier'],
  ) => {
    const withheld = policy.pinned.includes(param)
      ? 'pinned'
      : current === to
        ? 'already_set'
        : undefined;
    findings.push({
      ...finding,
      suggestion: { type: 'policy_change', param, ...(tier ? { tier } : {}), to },
      ...(withheld ? { withheld } : {}),
    });
  };
  const pathOf = (tier: TaskKind['tier']) =>
    policy.path[tier] ?? DEFAULT_WORKFLOW_POLICY.path[tier];

  for (const { cell, rows: cellRows } of byCell(rows)) {
    const dispatched = cellRows.filter((row) => row.path === 'dispatch').slice(0, RECENT_TASKS);
    const leadInput = sum(dispatched, (row) => row.lead_usage?.input_tokens),
      taskInput = sum(dispatched, (row) => row.task_usage?.input_tokens);
    if (
      dispatched.length === RECENT_TASKS &&
      dispatched.every(firstPass) &&
      leadInput > LEAD_INPUT_SHARE * (leadInput + taskInput)
    )
      suggest(
        { signal: 'dispatch_overhead', cell, retrospective_ids: ids(dispatched) },
        'path',
        pathOf(cell.tier),
        'direct',
        cell.tier,
      );
    const direct = cellRows.filter((row) => row.path === 'direct').slice(0, RECENT_TASKS);
    if (
      direct.length === RECENT_TASKS &&
      direct.filter((row) => gated(row) && !firstPass(row)).length >= REWORK_TASKS
    )
      suggest(
        { signal: 'direct_rework', cell, retrospective_ids: ids(direct) },
        'path',
        pathOf(cell.tier),
        'dispatch',
        cell.tier,
      );
    const latest = cellRows.slice(0, RECENT_TASKS);
    if (
      latest.length === RECENT_TASKS &&
      latest.filter((row) => (row.budget_ratio ?? 0) > 1).length >= OVER_BUDGET_TASKS
    )
      findings.push({ signal: 'over_budget', cell, retrospective_ids: ids(latest) });
  }

  const woken: Retrospective[] = [];
  let wakes = 0,
    idle = 0;
  for (const row of rows) {
    if (wakes >= IDLE_WAKES) break;
    // A row recorded before decisions were counted cannot say which wakes were idle.
    if (!row.lead_wakes || row.lead_wakes_without_decision === undefined) continue;
    // A direct task's wake is for the lead's own merge, not the acceptance wake of a task session's merge.
    if (row.path === 'direct') continue;
    woken.push(row);
    wakes += row.lead_wakes;
    idle += row.lead_wakes_without_decision;
  }
  if (wakes >= IDLE_WAKES && idle > IDLE_SHARE * wakes)
    suggest(
      { signal: 'idle_wakeups', retrospective_ids: ids(woken) },
      'acceptance_wake',
      policy.acceptance_wake,
      'milestone',
    );

  if (recent.length === RECENT_TASKS) {
    const waited = sum(recent, (row) => {
        const queue = row.runtime_findings?.find((finding) => finding.kind === 'dispatch_queue');
        // Only the project-wide place limit can be relieved by changing max_parallel.
        if (queue?.wait_ms_by_reason) return queue.wait_ms_by_reason.capacity ?? 0;
        return queue?.wait_reason && queue.wait_reason !== 'capacity'
          ? 0
          : row.stage_ms?.dispatch_wait;
      }),
      executed = sum(recent, (row) => row.stage_ms?.execution);
    if (
      waited > QUEUE_WAIT_SHARE * executed &&
      !recent.some(conflicted) &&
      policy.max_parallel < policy.max_parallel_limit
    )
      suggest(
        { signal: 'queue_wait', retrospective_ids: ids(recent) },
        'max_parallel',
        policy.max_parallel,
        policy.max_parallel + 1,
      );
    if (recent.filter(conflicted).length >= CONFLICT_TASKS && policy.max_parallel > 1)
      suggest(
        { signal: 'merge_conflicts', retrospective_ids: ids(recent) },
        'max_parallel',
        policy.max_parallel,
        policy.max_parallel - 1,
      );
  }

  findings.push(
    ...repeated('repeat_gate_failure', rows, (row) => row.gate_failed_checks),
    ...repeated('repeat_turn_failure', rows, (row) => row.turn_failure_codes),
  );
  const events = ctx.store.kindEvents(projectId, [
    'workflow.policy_changed',
    'agent.permission.requested',
    'approval.approved',
    'approval.rejected',
    'session.gate_checked',
  ]);
  const limitAt = handbackLimits(
    events,
    ctx.store.kindEvents('', ['workflow.policy_changed']),
    policy,
    !(
      'handback_limit' in
      ownPolicySettings(ctx.store.get<WorkflowPolicy>('workflow_policies', projectId))
    ),
  );
  for (const row of rows) {
    const limit = limitAt(row);
    const counts = new Map<string, number>();
    for (const { reason } of row.handbacks ?? []) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    if (limit > 0 && [...counts.values()].some((count) => count >= limit))
      findings.push({ signal: 'handback_loop', retrospective_ids: [row.id] });
  }
  const now = ctx.store.now(),
    since = now - WEEK_MS;
  const rules = new Set(
    [
      ...(ctx.store.must<Project>('projects', projectId).permission_rules ?? []),
      ...(projectDefaults(ctx.userConfigDir).permission_rules ?? []),
    ].map((entry) => entry.rule),
  );
  const commands = new Map<string, string>();
  const approvals = new Map<
    string,
    { approved: number; rejected: number; covered: boolean; newest: Approval; at: number }
  >();
  const failures = new Map<string, number[]>();
  for (const event of events) {
    if (event.kind === 'agent.permission.requested') {
      const request = event.payload as Extract<AgentEvent, { kind: 'permission.requested' }>;
      const detail = request.detail as { input?: unknown } | undefined;
      const command = toolCommand(detail?.input ?? request.detail);
      if (command) commands.set(JSON.stringify([event.aggregate_id, request.request_id]), command);
      continue;
    }
    if (event.created_at < since || event.created_at > now) continue;
    if (event.kind === 'approval.approved' || event.kind === 'approval.rejected') {
      const approval = event.payload as Approval;
      // A project rule answers without decided_by.
      if (!approval.decided_by) continue;
      const command = commands.get(JSON.stringify([approval.session_id, approval.request_id]));
      if (!command) continue;
      const counts = approvals.get(command) ?? {
        approved: 0,
        rejected: 0,
        covered: false,
        newest: approval,
        at: event.created_at,
      };
      if (event.created_at >= counts.at) {
        counts.newest = approval;
        counts.at = event.created_at;
      }
      counts[event.kind === 'approval.approved' ? 'approved' : 'rejected']++;
      counts.covered ||= approval.rule !== undefined && rules.has(approval.rule);
      approvals.set(command, counts);
    } else if (event.kind === 'session.gate_checked') {
      const { results = [] } = event.payload as {
        results?: NonNullable<LandingItem['gate_results']>;
      };
      let priorMs = 0;
      for (const [index, result] of results.entries()) {
        // Carried results passed in a different run, so their time was not spent in this one.
        if (result.carried) break;
        if (result.state !== 'skipped' && (result.exit_code !== 0 || result.timed_out)) {
          if (index > 0) {
            const times = failures.get(result.name) ?? [];
            times.push(priorMs);
            failures.set(result.name, times);
          }
          break;
        }
        priorMs += result.duration_ms;
      }
    }
  }
  for (const [command, counts] of approvals)
    if (counts.approved >= COMMAND_APPROVALS && counts.rejected === 0 && !counts.covered)
      findings.push({
        signal: 'always_approved_command',
        retrospective_ids: [],
        evidence: {
          kind: 'always_approved_command',
          command,
          approvals: counts.approved,
          ...(counts.newest.project_rule_supported
            ? { rule: counts.newest.rule!, session_id: counts.newest.session_id! }
            : {}),
        },
      });
  for (const [name, times] of failures) {
    if (times.length < LATE_GATE_RUNS) continue;
    times.sort((a, b) => a - b);
    const mid = times.length >> 1;
    findings.push({
      signal: 'late_gate_failure',
      retrospective_ids: [],
      evidence: {
        kind: 'late_gate_failure',
        name,
        runs: times.length,
        median_prior_ms: times.length % 2 ? times[mid]! : (times[mid - 1]! + times[mid]!) / 2,
      },
    });
  }
  return findings;
}
