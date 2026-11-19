import { z } from 'zod';
import type { LeadNote } from '@pantheon/domain';
import type { WakeOutcome } from './agent-wakes.js';

export const agentLedgerQuerySchemas = {
  /** The user only; returns an AgentLedgerWeek for each of the agent's last weeks, newest first. */
  'agent.ledger': z.strictObject({
    agent_id: z.string().min(1).max(65536),
    weeks: z.coerce.number().int().min(1).max(52).default(4),
  }),
};

/** What an agent did in the seven days after `from` up to and including `to`. */
export interface AgentLedgerWeek {
  /** Unix epoch ms. */
  from: number;
  /** Unix epoch ms. */
  to: number;
  /** The wakes queued in the week. */
  wakes: number;
  /** How many of those wakes each cause woke; a wake with several causes counts under each. */
  causes: Partial<Record<LeadNote['kind'], number>>;
  outcomes: Record<WakeOutcome, number>;
  /** Ended tasks the agent's sessions led that started in the week. */
  tasks_started: number;
  /** Of those, the tasks that merged or were accepted. */
  tasks_merged: number;
  /** Input tokens of the turns of the agent's sessions that ended in the week. */
  input_tokens: number;
  /** Permission prompts of the agent's task sessions approved on its behalf under the project's charter. */
  prompts_auto_approved: number;
}
