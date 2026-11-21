import type {
  BoardPlan,
  LeadNote,
  LeadQuestion,
  Milestone,
  MilestoneView,
  Principal,
  Project,
  Review,
  ReviewFinding,
  Session,
  SessionTurn,
  TaskThreadEntry,
} from '@pantheon/domain';
import { ownEntry, projectAccess, type ControlContext } from './context.js';
import { ensureAgents } from './agents.js';
import { residentPlan } from './agent-always-on.js';
import { appendNote, planLineage } from './lead-inbox.js';
import { openOf } from './resident.js';

const KINDS = [
  'turn.queued',
  'task.reported',
  'review.finding_recorded',
  'lead.question_asked',
  'lead.question_answered',
  'lead.question_overruled',
  'lead.note_added',
  'session.gate_checked',
  'task.dispatched',
  'task.handed_back',
  'session.merged',
  'session.merge_blocked',
];

/**
 * The task's lead and tracker messages, reports, review findings, questions, answers, notes, gate
 * runs, dispatches, hand-backs, blocked merges and merges, in event order.
 */
export function taskThread(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  leadId: string,
  taskId: string,
): TaskThreadEntry[] {
  projectAccess(ctx, principal, projectId, 'task.thread');
  ctx.store.must<Project>('projects', projectId);
  const lineage = new Set(planLineage(ctx, leadId));
  const retired = ownEntry(ctx.store.get<BoardPlan>('board_plans', leadId)?.retired, taskId) ?? 0;
  // A task added again under a removed id is new work; its thread starts where it was added.
  const since = retired
    ? (ctx.store
        .kindEvents(projectId, ['board.plan_updated'])
        .find(
          (event) =>
            lineage.has(event.aggregate_id) &&
            (ownEntry((event.payload as BoardPlan).generations, taskId)?.generation ?? 0) > retired,
        )?.sequence ?? 0)
    : 0;
  const sessions = new Set(
    ctx.store
      .list<Session>('sessions')
      .filter(
        (session) =>
          !!session.task &&
          lineage.has(session.task.lead_session_id) &&
          session.task.id === taskId &&
          (session.task.generation ?? 1) > retired,
      )
      .map((session) => session.id),
  );
  const events = ctx.store.kindEvents(projectId, KINDS).filter((event) => event.sequence >= since);
  const noteKey = (cause: string, note: LeadNote) =>
    [cause, note.session_id, note.kind, note.text].join('\n');
  // Each report is also kept as a note in the same command; the report stands for both.
  const reported = new Set(
    events
      .filter((event) => event.kind === 'task.reported' && lineage.has(event.aggregate_id))
      .map((event) => noteKey(event.causation_id, event.payload as LeadNote)),
  );
  const entries: TaskThreadEntry[] = [];
  for (const event of events) {
    const base = { event_id: event.event_id, at: event.created_at };
    if (event.kind === 'turn.queued') {
      const turn = event.payload as SessionTurn;
      if ((turn.origin === 'lead' || turn.origin === 'tracker') && sessions.has(turn.session_id))
        entries.push({
          ...base,
          kind: turn.origin === 'lead' ? 'lead_message' : 'tracker_message',
          session_id: turn.session_id,
          text: turn.input,
        });
    } else if (event.kind === 'task.reported' || event.kind === 'lead.note_added') {
      const note = event.payload as LeadNote;
      if (!lineage.has(event.aggregate_id) || note.task_id !== taskId) continue;
      // A note of a question repeats the question's own event.
      if (
        event.kind === 'lead.note_added' &&
        (note.question_id || reported.has(noteKey(event.causation_id, note)))
      )
        continue;
      entries.push({
        ...base,
        kind: event.kind === 'task.reported' ? 'report' : 'note',
        ...(note.session_id ? { session_id: note.session_id } : {}),
        text: note.text,
        note_kind: note.kind,
      });
    } else if (event.kind === 'review.finding_recorded') {
      const finding = event.payload as ReviewFinding,
        review = ctx.store.get<Review>('reviews', finding.review_id);
      if (
        finding.status === 'rejected' ||
        !(
          (review?.session_id && sessions.has(review.session_id)) ||
          (review?.requester &&
            lineage.has(review.requester.lead_session_id) &&
            review.requester.task_id === taskId)
        )
      )
        continue;
      const reviewers = review.session_ids.filter(
        (id) => ctx.store.get<Session>('sessions', id)?.runtime === finding.runtime,
      );
      entries.push({
        ...base,
        kind: 'finding',
        ...(review.session_id ? { session_id: review.session_id } : {}),
        text: `${finding.location}: ${finding.impact}`,
        location: finding.location,
        impact: finding.impact,
        ...(reviewers.length === 1 ? { reviewer_session_id: reviewers[0] } : {}),
        blocking: finding.blocking,
      });
    } else if (event.kind.startsWith('lead.question_')) {
      const question = event.payload as LeadQuestion;
      if (
        !lineage.has(event.aggregate_id) ||
        !(question.blocks.includes(taskId) || sessions.has(question.source?.session_id ?? ''))
      )
        continue;
      entries.push({
        ...base,
        ...(question.source ? { session_id: question.source.session_id } : {}),
        question_id: question.id,
        ...(event.kind === 'lead.question_asked'
          ? { kind: 'question' as const, text: question.question }
          : {
              kind: 'answer' as const,
              text: question.answer!.text,
              answered_by: question.answered_by ?? 'user',
              overruled: event.kind === 'lead.question_overruled',
            }),
      });
    } else if (event.kind === 'task.dispatched' || event.kind === 'task.handed_back') {
      const p = event.payload as { task_id: string; session_id?: string; reason?: string };
      if (!lineage.has(event.aggregate_id) || p.task_id !== taskId) continue;
      entries.push({
        ...base,
        kind: event.kind === 'task.dispatched' ? 'dispatched' : 'handed_back',
        ...(p.session_id ? { session_id: p.session_id } : {}),
        text: p.reason ?? '',
      });
    } else if (event.kind === 'session.merged') {
      const p = event.payload as { direct?: boolean; task_id?: string };
      if (
        !sessions.has(event.aggregate_id) &&
        !(lineage.has(event.aggregate_id) && p.direct && p.task_id === taskId)
      )
        continue;
      entries.push({ ...base, kind: 'merged', session_id: event.aggregate_id, text: '' });
    } else if (event.kind === 'session.merge_blocked') {
      if (!sessions.has(event.aggregate_id)) continue;
      entries.push({
        ...base,
        kind: 'merge_blocked',
        session_id: event.aggregate_id,
        text: (event.payload as { reason?: string }).reason ?? '',
      });
    } else if (sessions.has(event.aggregate_id)) {
      const commands = (
        (event.payload as Record<string, unknown>).results as {
          name: string;
          exit_code?: number | null;
          timed_out?: boolean;
          state?: string;
        }[]
      )
        .filter((result) => result.state !== 'skipped')
        .map((result) => ({
          name: result.name,
          passed: result.exit_code === 0 && !result.timed_out,
        }));
      const failed = commands.filter((command) => !command.passed);
      entries.push({
        ...base,
        kind: 'gate',
        session_id: event.aggregate_id,
        text: failed.map((command) => command.name).join(', '),
        passed: !failed.length,
        commands,
      });
    }
  }
  return entries;
}

/** Leaves the project's open Assistant a line of the milestone's new status; it does not wake the Assistant. */
export function noteMilestone(
  ctx: ControlContext,
  milestone: Milestone,
  status: MilestoneView['status'],
  cause: string,
): void {
  const assistant = openOf(
    ctx,
    ensureAgents(ctx, milestone.project_id).find((agent) => agent.template === 'assistant')!,
  );
  if (!assistant) return;
  appendNote(
    ctx,
    residentPlan(ctx, assistant),
    {
      at: ctx.store.now(),
      session_id: milestone.owner_session_id ?? '',
      task_id: '',
      kind: 'milestone',
      text: `Milestone "${milestone.title}" is now ${status.replaceAll('_', ' ')}.`,
    },
    cause,
  );
}
