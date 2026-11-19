import { z } from 'zod';

/**
 * One page of a lead plan's replay: at most `limit` frames whose sequence is after `after`, or the
 * last `limit` frames whose sequence is before `before`.
 */
export const planReplayQuerySchema = z
  .strictObject({
    lead_session_id: z.string().min(1).max(16384),
    after: z.coerce.number().int().min(0).optional(),
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .refine(
    (input) => input.after === undefined || input.before === undefined,
    'Give after or before, not both',
  );

export type PlanReplayTaskStatus = 'planned' | 'dispatched' | 'merged' | 'accepted';

/** One event of the plan, with the plan's tasks as they stood once it happened; times are epoch milliseconds. */
export interface PlanReplayFrame {
  sequence: number;
  at: number;
  kind:
    | 'board.plan_updated'
    | 'board.replan_triggered'
    | 'lead.question_asked'
    | 'lead.question_answered'
    | 'lead.question_overruled'
    | 'board.plan_proposed'
    | 'board.plan_proposal_resolved'
    | 'board.plan_proposal_withdrawn'
    | 'task.dispatched'
    | 'session.merged'
    | 'task.accepted'
    | 'milestone.accepted';
  /** The plan task a dispatch, merge or acceptance is of. */
  task_id?: string;
  /** The plan headline, what met a re-plan condition, question, answer, proposal reason or milestone title. */
  text?: string;
  /** On a plan update that answers a re-plan condition it names. */
  replan?: true;
  /** On a resolved proposal, how the user resolved it. */
  decision?: 'accepted' | 'rejected';
  /** On a dispatch its first session, on a merge the merged session. */
  session_id?: string;
  /** The tasks of the newest plan update at or before this event, in plan order. */
  tasks: {
    id: string;
    title: string;
    lane: string;
    depends_on: string[];
    status: PlanReplayTaskStatus;
  }[];
}

export interface PlanReplay {
  frames: PlanReplayFrame[];
  /** The `after` of the next page; null on the last page. */
  next_after: number | null;
  /** The plan's frames in all pages. */
  total: number;
  /** The time of the plan's last frame; null without frames. */
  last_at: number | null;
}
