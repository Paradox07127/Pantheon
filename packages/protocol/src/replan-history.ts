import type { ReplanTrigger } from '@pantheon/domain';

/** A fired re-plan condition: what the task did, and the board task `<lead session id>:<task id>` with its title then. */
export interface ReplanFiredRef {
  event_id: string;
  /** The milestone row id. */
  milestone_id: string;
  type: ReplanTrigger['type'];
  /** The hand-backs counted or the budget ratio reached; absent for a stall. */
  value?: number;
  task_id: string;
  task_title: string;
}

/** A re-plan condition a plan change answered; text says what the task did. */
export interface ReplanHistoryTrigger extends ReplanFiredRef {
  text: string;
}

/** A re-plan condition that fired and no plan change answered yet; at is epoch milliseconds. */
export interface PendingReplan extends ReplanFiredRef {
  at: number;
}
