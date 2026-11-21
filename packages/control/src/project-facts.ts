import { memoryContext } from './memory.js';
import {
  id,
  hash,
  requireThat,
  type BoardPlan,
  type LeadGuidance,
  type LeadNote,
  type Project,
  type ProjectBrief,
  type Milestone,
  type MilestoneVerification,
  type MilestoneView,
  type ProjectRead,
  type Principal,
  type Retrospective,
  type Session,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import {
  actsAsUser,
  insert,
  projectAccess,
  revision,
  type ControlContext,
  type Handlers,
} from './context.js';
import { personalAnswer, personalCalled } from './personal-scope.js';
import { runtimeReviewHistory } from './runtime-review.js';
import { RUNTIME_LOOKBACK_MS, runtimeDiagnostics } from './runtime-findings.js';
import { chartered, charterModes } from './charter.js';
import { workflowPolicy } from './workflow-policy.js';
import { listDevices } from './devices.js';
import { deviceLoads } from './task-dispatch.js';
import { readUserConfig } from './user-config.js';
import {
  currentAcceptance,
  planUnfinished,
  planViews,
  taskGeneration,
  taskSessions,
  taskState,
} from './board-plan.js';
import { goalViews } from './project-goals.js';
import { noteMilestone } from './task-thread.js';
import { hiddenChecks } from './milestone-checks.js';

export function userOnly(principal: Principal): void {
  requireThat(
    principal.role === 'user',
    'permission_denied',
    'Changing project commitments requires user authority',
  );
}
export function history(
  ctx: ControlContext,
  kind: 'brief' | 'milestone',
  value: { id: string; revision: number; project_id: string },
  actor: string,
): void {
  ctx.store.insert('project_fact_versions', {
    id: id(),
    revision: 1,
    project_id: value.project_id,
    kind,
    target_id: value.id,
    target_revision: value.revision,
    actor,
    created_at: ctx.store.now(),
    value,
  });
}
function sessionReferences(ctx: ControlContext, projectId: string, sessionIds: string[]): void {
  requireThat(
    new Set(sessionIds).size === sessionIds.length,
    'invalid_input',
    'Session references must be unique',
  );
  for (const sessionId of sessionIds) {
    const session = ctx.store.get<Session>('sessions', sessionId);
    requireThat(session?.workspace_id, 'not_found', `Not found: sessions/${sessionId}`);
    requireThat(
      session.project_id === projectId,
      'scope_violation',
      `Session ${sessionId} belongs to another project`,
    );
  }
}
const outcome = (ctx: ControlContext, sessionId: string) =>
  ctx.store.get<Session>('sessions', sessionId)?.outcome ?? 'open';
// task_ids is absent on user milestones, so their hash is unchanged.
export function commitmentHash(
  milestone: Milestone,
  requiredSessions: string[],
  plan?: BoardPlan,
): string {
  return hash({
    title: milestone.title,
    required_sessions: requiredSessions,
    criteria: milestone.criteria,
    task_ids: milestone.task_ids,
    // A changed task contract is a new commitment; first generations keep hashes written before them.
    tasks: milestone.task_ids?.some((taskId) => taskGeneration(plan, taskId) > 1)
      ? milestone.task_ids.map((taskId) => taskGeneration(plan, taskId))
      : undefined,
  });
}
function userMilestoneView(ctx: ControlContext, milestone: Milestone): MilestoneView {
  const reasons = milestone.required_sessions
    .map((sessionId) => [sessionId, outcome(ctx, sessionId)] as const)
    .filter(([, state]) => state !== 'merged')
    .map(([sessionId, state]) => `session:${sessionId}:${state}`);
  return {
    milestone,
    status: reasons.some((reason) => reason.endsWith(':discarded'))
      ? 'stale'
      : reasons.length
        ? 'active'
        : milestone.acceptance?.commitment_hash ===
            commitmentHash(milestone, milestone.required_sessions)
          ? 'completed'
          : 'ready_for_acceptance',
    required_total: milestone.required_sessions.length,
    merged_total: milestone.required_sessions.length - reasons.length,
    reasons,
    required_sessions: milestone.required_sessions,
  };
}
function leadMilestoneView(ctx: ControlContext, milestone: Milestone): MilestoneView {
  const plan = ctx.store.get<BoardPlan>('board_plans', milestone.owner_session_id!),
    lead = ctx.store.get<Session>('sessions', milestone.owner_session_id!);
  const tasks = (milestone.task_ids ?? []).map((taskId) => {
    const sessions = taskSessions(ctx, milestone.owner_session_id!, taskId);
    return { taskId, sessions, state: taskState(plan, taskId, sessions, lead) };
  });
  const sessions = tasks.flatMap((task) => task.sessions);
  const required = sessions.map((session) => session.id);
  // The sessions of an accepted report task need not merge.
  const open = tasks
    .filter((task) => !currentAcceptance(plan, task.taskId))
    .flatMap((task) => task.sessions)
    .filter((session) => session.outcome !== 'merged');
  const reasons = [
    ...tasks
      .filter((task) => task.state !== 'done')
      .map((task) => `task:${task.taskId}:${task.state}`),
    ...open.map((session) => `session:${session.id}:open`),
  ];
  const current = commitmentHash(milestone, required, plan);
  const verification = reasons.length ? undefined : currentVerification(ctx, milestone, current);
  return {
    milestone,
    status: reasons.length
      ? 'active'
      : milestone.acceptance?.commitment_hash === current
        ? 'completed'
        : 'ready_for_acceptance',
    required_total: required.length,
    merged_total: required.length - open.length,
    reasons,
    required_sessions: required,
    tasks: {
      done: tasks.filter((task) => task.state === 'done').length,
      total: tasks.length,
    },
    ...(verification && {
      verification: {
        id: verification.id,
        state: verification.state,
        independence: verification.independence,
        runtime: verification.runtime,
        reason: verification.reason,
        reason_code: verification.reason_code,
        started_at: verification.started_at,
        finished_at: verification.finished_at,
        failed: verification.commands
          .filter((command) => command.exit_code !== 0)
          .map(({ name, output_tail }) => ({ name, output_tail })),
        commands: verification.commands.map(({ name, exit_code }) => ({ name, exit_code })),
      },
    }),
  };
}
/** The newest verification run against the milestone's commitment with this hash and the current hidden checks. */
function currentVerification(
  ctx: ControlContext,
  milestone: Milestone,
  commitment: string,
): MilestoneVerification | undefined {
  const checks = hash(hiddenChecks(ctx, milestone.project_id)),
    none = hash([]);
  return ctx.store
    .statement(
      "SELECT data FROM milestone_verifications WHERE json_extract(data,'$.milestone_id')=? ORDER BY rowid",
    )
    .all(milestone.id)
    .map((row) => JSON.parse(String(row.data)) as MilestoneVerification)
    .filter((row) => row.commitment_hash === commitment && (row.checks_hash ?? none) === checks)
    .reduce<MilestoneVerification | undefined>(
      (newest, row) => (newest && newest.started_at >= row.started_at ? newest : row),
      undefined,
    );
}

/** The milestone's progress as project.read shows it. */
export const milestoneView = (ctx: ControlContext, row: Milestone): MilestoneView =>
  row.owner_session_id ? leadMilestoneView(ctx, row) : userMilestoneView(ctx, row);

/**
 * True for the note about the lead's own merge once its plan has no task left and none of its
 * milestones waits for its acceptance: it wakes the lead for nothing.
 */
export function finishingMerge(ctx: ControlContext, plan: BoardPlan, note: LeadNote): boolean {
  return (
    note.kind === 'merged' &&
    note.session_id === plan.id &&
    !planUnfinished(ctx, plan.id) &&
    !ctx.store
      .list<Milestone>('milestones')
      .some(
        (row) =>
          row.owner_session_id === plan.id &&
          milestoneView(ctx, row).status === 'ready_for_acceptance',
      )
  );
}

/** Facts only: this projection never schedules work or mutates acceptance. */
export function projectRead(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): ProjectRead {
  projectAccess(ctx, principal, projectId, 'project.read');
  const session = principal.session_id
    ? ctx.store.get<Session>('sessions', principal.session_id)
    : undefined;
  return {
    ...projectFacts(ctx, projectId),
    memory: memoryContext(ctx, projectId, session, 12000, !!session),
    ...(session
      ? { you: { session_id: session.id, role: principal.role, task: session.task ?? null } }
      : {}),
    ...(session && principal.role === 'lead'
      ? { lead: leadGuidance(ctx, projectId, session.id) }
      : {}),
  };
}
function recentRuntimeOrUnavailable(
  ctx: ControlContext,
  projectId: string,
  leadSessionId: string,
): LeadGuidance['runtime'] {
  try {
    const now = ctx.store.now();
    const sessions = new Set(
      ctx.store
        .list<Session>('sessions')
        .filter(
          (row) => row.project_id === projectId && row.task?.lead_session_id === leadSessionId,
        )
        .map((row) => row.id),
    );
    sessions.add(leadSessionId);
    return runtimeDiagnostics(ctx, projectId, Math.max(0, now - RUNTIME_LOOKBACK_MS), now, {
      scope: { leadId: leadSessionId, sessions },
      limit: 0,
      live: true,
    });
  } catch {
    const to = ctx.store.now();
    return {
      from: Math.max(0, to - RUNTIME_LOOKBACK_MS),
      to,
      partial: true,
      native: 'unavailable',
      events_read: 0,
      tools_timed: 0,
      tools_untimed: 0,
      findings: [],
    };
  }
}

function leadGuidance(ctx: ControlContext, projectId: string, leadSessionId: string): LeadGuidance {
  const policy = workflowPolicy(ctx, projectId);
  const config = readUserConfig(ctx.userConfigDir),
    loads =
      Object.keys(config.devices ?? {}).length || config.local_device
        ? deviceLoads(ctx)
        : undefined;
  return {
    runtime: recentRuntimeOrUnavailable(ctx, projectId, leadSessionId),
    runtime_reviews: runtimeReviewHistory(ctx, projectId, leadSessionId).flatMap(
      ({ session_id, report, verification }) =>
        report
          ? [
              {
                session_id,
                summary: report.summary,
                change: report.change,
                outcome: verification?.outcome,
              },
            ]
          : [],
    ),
    workflow: {
      policy_version: policy.policy_version,
      path: policy.path,
      acceptance_wake: policy.acceptance_wake,
      max_parallel: policy.max_parallel,
      handback_limit: policy.handback_limit,
      ...(policy.task_size_hint === undefined ? {} : { task_size_hint: policy.task_size_hint }),
      pinned: policy.pinned,
      plan_changes: policy.plan_changes,
      charter: charterModes(ctx, projectId),
    },
    retrospectives: ctx.store
      .list<Retrospective>('retrospectives')
      .filter((row) => row.project_id === projectId && row.lead_session_id === leadSessionId)
      .sort((a, b) => b.recorded_at - a.recorded_at)
      .slice(0, 10)
      .map((row) => ({
        id: row.id,
        task_id: row.task_id,
        outcome: row.outcome,
        ...(row.measured_kind ? { measured_kind: row.measured_kind } : {}),
        ...(row.model ? { model: row.model } : {}),
        handbacks: row.handbacks?.length ?? 0,
        ...(row.gate_passed_on_attempt === undefined
          ? {}
          : { gate_passed_on_attempt: row.gate_passed_on_attempt }),
        ...(row.runtime_findings?.length
          ? { runtime_finding_count: row.runtime_findings.length }
          : {}),
        ...(row.turn_failure_codes ? { turn_failure_codes: row.turn_failure_codes } : {}),
      })),
    ...(loads
      ? {
          devices: listDevices(ctx).map((device) => ({
            id: device.id,
            name: device.name,
            online: device.online,
            ...(device.os && { os: device.os }),
            ...(device.arch && { arch: device.arch }),
            labels: device.labels,
            resources: device.resources,
            ...(device.id !== 'local' || config.local_device?.max_sessions !== undefined
              ? { max_sessions: device.max_sessions }
              : {}),
            runtimes: Object.entries(device.runtimes).flatMap(([name, found]) =>
              found.logged_in ? [name] : [],
            ),
            sessions: loads.get(device.id)?.sessions ?? 0,
          })),
        }
      : {}),
  };
}
/** Internal evidence projection; no authority changes and no dispatch side effects. */
export function projectFacts(ctx: ControlContext, projectId: string): ProjectRead {
  const project = ctx.store.must<Project>('projects', projectId);
  const milestones: MilestoneView[] = ctx.store
    .list<Milestone>('milestones')
    .filter((m) => m.project_id === projectId && !m.removed_at)
    .map((row) => milestoneView(ctx, row));
  return {
    project,
    brief: ctx.store.get<ProjectBrief>('project_briefs', projectId),
    milestones,
    cursor: ctx.store.cursor(),
    plans: planViews(ctx, projectId),
    goals: goalViews(ctx, projectId, milestones),
  };
}

export const projectFactHandlers: Handlers = {
  'project.read': (ctx, p, c) => {
    revision(ctx, c);
    return projectRead(ctx, p, inputSchemas['project.read'].parse(c.input).project_id);
  },
  'project.brief.set': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['project.brief.set'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    const old = ctx.store.get<ProjectBrief>('project_briefs', input.project_id);
    revision(ctx, c, old);
    const value: ProjectBrief = {
      ...input,
      id: input.project_id,
      revision: old?.revision ?? 1,
      created_at: old?.created_at ?? ctx.store.now(),
      updated_by: p.id,
    };
    const next = old
      ? ctx.store.update('project_briefs', value, old.revision)
      : ctx.store.insert('project_briefs', value);
    history(ctx, 'brief', next, p.id);
    ctx.store.event('project.brief_updated', next, input.project_id, next, c.command_id);
    return next;
  },
  'milestone.create': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['milestone.create'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    revision(ctx, c);
    ctx.store.must<Project>('projects', input.project_id);
    sessionReferences(ctx, input.project_id, input.required_sessions);
    const milestone: Milestone = {
      ...input,
      id: id(),
      revision: 1,
      created_at: ctx.store.now(),
      updated_by: p.id,
    };
    history(ctx, 'milestone', milestone, p.id);
    return insert(
      ctx,
      'milestones',
      milestone,
      'milestone.created',
      input.project_id,
      c.command_id,
    );
  },
  'milestone.revise': (ctx, p, c) => {
    userOnly(p);
    const { milestone_id, ...input } = inputSchemas['milestone.revise'].parse(c.input);
    const old = ctx.store.must<Milestone>('milestones', milestone_id);
    projectAccess(ctx, p, old.project_id, c.type);
    revision(ctx, c, old);
    requireThat(
      !old.owner_session_id,
      'invalid_state',
      `Milestone ${old.id} belongs to a lead's plan and follows its tasks; ask the lead to change it`,
    );
    sessionReferences(ctx, old.project_id, input.required_sessions);
    const next = ctx.store.update(
      'milestones',
      { ...old, ...input, acceptance: undefined, updated_by: p.id },
      old.revision,
    );
    history(ctx, 'milestone', next, p.id);
    ctx.store.event('milestone.revised', next, old.project_id, next, c.command_id);
    noteMilestone(ctx, next, milestoneView(ctx, next).status, c.command_id);
    return next;
  },
  'milestone.accept': (ctx, p, c) => {
    const input = inputSchemas['milestone.accept'].parse(c.input);
    let old: Milestone;
    let override: NonNullable<Milestone['acceptance']>['override'];
    if (p.role === 'lead') {
      projectAccess(ctx, p, p.project_id!, c.type);
      // A lead names its own milestones by key; the MCP binding sends no revision.
      const owned = ctx.store
        .list<Milestone>('milestones')
        .find(
          (m) =>
            m.owner_session_id === p.session_id && m.key === input.milestone_id && !m.removed_at,
        );
      requireThat(owned, 'not_found', `Not found: milestone ${input.milestone_id}`);
      // A verification still running has not passed either.
      const { status, verification } = milestoneView(ctx, owned);
      const overridden = verification && verification.state !== 'passed' ? verification : undefined;
      requireThat(
        chartered(
          ctx,
          p,
          'accept_milestone',
          owned,
          overridden && input.override_reason,
          overridden && { id: overridden.id, state: overridden.state },
        ) === 'on',
        'permission_denied',
        `The user accepts milestone ${owned.key} on the milestone card; the project's charter does not let a lead accept milestones`,
      );
      // Hidden checks run only in a verification, so one must run the current checks before a lead accepts.
      requireThat(
        verification ||
          status !== 'ready_for_acceptance' ||
          workflowPolicy(ctx, owned.project_id).milestone_verify !== 'auto' ||
          !hiddenChecks(ctx, owned.project_id).length,
        'invalid_state',
        `No verification of milestone ${owned.key} has run the user's current hidden checks yet; wait for its result, which reaches you as a note`,
      );
      if (overridden) {
        requireThat(
          input.override_reason,
          'invalid_request',
          `The verification of milestone ${owned.key} is ${overridden.state}, not passed; to accept it anyway, give override_reason with why, or propose fix tasks instead`,
        );
        override = {
          reason: input.override_reason,
          verification_id: overridden.id,
          state: overridden.state,
        };
      }
      old = owned;
    } else {
      actsAsUser(p);
      old = ctx.store.must<Milestone>('milestones', input.milestone_id);
      projectAccess(ctx, p, old.project_id, c.type);
      revision(ctx, c, old);
      personalAnswer(ctx, p, 'milestone.accept', old.project_id);
      personalCalled(ctx, p, c, old.project_id);
    }
    const view = projectFacts(ctx, old.project_id).milestones.find(
      (m) => m.milestone.id === old.id,
    )!;
    requireThat(
      new Set(input.evidence_refs).size === input.evidence_refs.length,
      'invalid_input',
      'Evidence references must be unique',
    );
    const plan = old.owner_session_id
      ? ctx.store.get<BoardPlan>('board_plans', old.owner_session_id)
      : undefined;
    const references = new Set([
      ...view.required_sessions
        .filter((sessionId) => outcome(ctx, sessionId) === 'merged')
        .map((sessionId) => `session:${sessionId}`),
      ...(plan?.tasks ?? [])
        .filter((task) => currentAcceptance(plan, task.id))
        .map((task) => `task:${task.id}`),
    ]);
    requireThat(
      input.evidence_refs.every((ref) => references.has(ref)),
      'invalid_input',
      'Evidence references must name merged required sessions as session:<id> or accepted tasks of the plan as task:<id>',
    );
    requireThat(
      view.status === 'ready_for_acceptance',
      'acceptance_pending',
      'Only a milestone whose required sessions are all merged, and not yet accepted, can be accepted',
    );
    // Without criteria_checked the acceptance covers the whole milestone, as for leads.
    const checked = input.criteria_checked;
    requireThat(
      !checked ||
        (new Set(checked).size === checked.length &&
          checked.every((index) => index >= 0 && index < old.criteria.length)),
      'invalid_input',
      'Checked criteria must be unique indices into the criteria',
    );
    const unchecked = checked ? old.criteria.filter((_, index) => !checked.includes(index)) : [];
    requireThat(
      !unchecked.length,
      'invalid_input',
      `Check every criterion before accepting; unchecked: ${unchecked.map((text) => JSON.stringify(text)).join(', ')}`,
    );
    const next = ctx.store.update(
      'milestones',
      {
        ...old,
        updated_by: p.id,
        acceptance: {
          actor: p.id,
          accepted_at: ctx.store.now(),
          evidence_refs: input.evidence_refs,
          commitment_hash: commitmentHash(old, view.required_sessions, plan),
          criteria_checked: checked,
          ...(override ? { override } : {}),
        },
      },
      old.revision,
    );
    history(ctx, 'milestone', next, p.id);
    ctx.store.event('milestone.accepted', next, old.project_id, next, c.command_id);
    noteMilestone(ctx, next, milestoneView(ctx, next).status, c.command_id);
    return next;
  },
};
