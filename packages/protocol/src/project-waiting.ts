import type { NeedsYouItem } from '@pantheon/domain';

/** A project's needs-you items: how many of each decision, how long the oldest has waited, and the tasks they hold. */
export interface ProjectWaiting {
  by_decision: Partial<Record<NeedsYouItem['decision'], number>>;
  longest_wait_ms: number;
  /** The items' `blocks` summed; a task two items hold counts twice. */
  blocked_tasks: number;
}
