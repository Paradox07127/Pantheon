import { z } from 'zod';

/** One page of a lead plan's replay: frames whose sequence is after `after`, at most `limit` of them. */
export const planReplayQuerySchema = z.strictObject({
  lead_session_id: z.string().min(1).max(16384),
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type PlanReplayTaskStatus = 'planned' | 'dispatched' | 'merged' | 'accepted';

/** One event of the plan, with the plan's tasks as they stood once it happened; times are epoch milliseconds. */
export interface PlanReplayFrame {
  sequence: number;
  at: number;
  kind:
    | 'board.plan_updated'
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
  /** The plan headline, question, answer, proposal reason or milestone title. */
  text?: string;
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
}
