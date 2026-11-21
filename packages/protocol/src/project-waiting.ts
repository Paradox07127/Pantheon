import type { NeedsYouItem } from '@pantheon/domain';

/** A project's needs-you items: how many of each decision and how long the oldest has waited. */
export interface ProjectWaiting {
  by_decision: Partial<Record<NeedsYouItem['decision'], number>>;
  longest_wait_ms: number;
}
