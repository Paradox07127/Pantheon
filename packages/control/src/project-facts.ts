import { memoryContext } from './memory.js';
import {
  id,
  requireThat,
  type BoardPlan,
  type LeadGuidance,
  type LeadNote,
  type Project,
  type ProjectBrief,
  type ProjectRead,
  type Principal,
  type Retrospective,
  type Session,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { projectAccess, revision, type ControlContext, type Handlers } from './context.js';
import { runtimeReviewHistory } from './runtime-review.js';
import { RUNTIME_LOOKBACK_MS, runtimeDiagnostics } from './runtime-findings.js';
import { charterModes } from './charter.js';
import { workflowPolicy } from './workflow-policy.js';
import { listDevices } from './devices.js';
import { deviceLoads } from './task-dispatch.js';
import { readUserConfig } from './user-config.js';
import { planUnfinished, planViews } from './board-plan.js';

export function userOnly(principal: Principal): void {
  requireThat(
    principal.role === 'user',
    'permission_denied',
    'Changing project commitments requires user authority',
  );
}
export function history(
  ctx: ControlContext,
  kind: 'brief',
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
/** True for the note about the lead's own merge once its plan has no task left: it wakes the lead for nothing. */
export function finishingMerge(ctx: ControlContext, plan: BoardPlan, note: LeadNote): boolean {
  return note.kind === 'merged' && note.session_id === plan.id && !planUnfinished(ctx, plan.id);
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
  return {
    project,
    brief: ctx.store.get<ProjectBrief>('project_briefs', projectId),
    cursor: ctx.store.cursor(),
    plans: planViews(ctx, projectId),
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
};
