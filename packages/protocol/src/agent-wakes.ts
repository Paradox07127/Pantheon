import { z } from 'zod';
import type { AgentRoutine, LeadNote, SessionTurn, Usage } from '@pantheon/domain';

const str = z.string().min(1).max(65536);

export const agentWakeInputSchemas = {
  /** The user only; wakes the agent with an enabled routine's prompt now, even while its contract holds its wakes, and runs no precheck. */
  'agent.routine.run': z.strictObject({ agent_id: str, routine_id: str }),
  /** The user only; leaves the project's Assistant the final output of an agent's wake as the user's request, and wakes it. */
  'agent.wake.to_task': z.strictObject({ turn_id: str }),
};

export const agentWakeQuerySchemas = {
  /** The user only; returns the agent's wakes as AgentWake records, newest first. */
  'agent.wakes': z.strictObject({
    agent_id: str,
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  /** The user only; returns an AgentRoutineRow for each routine of the project's agents that are not archived. */
  'agent.routines': z.strictObject({ project_id: str }),
};

/** What a wake came to: asked wins over told_user, which wins over acted. */
export type WakeOutcome = 'nothing' | 'acted' | 'told_user' | 'asked';

/** One turn Pantheon queued to wake an agent with notes. */
export interface AgentWake {
  turn_id: string;
  session_id: string;
  /** When the turn was queued, Unix epoch ms. */
  at: number;
  state: SessionTurn['state'];
  causes: LeadNote['kind'][];
  routine_ids?: string[];
  usage?: Usage;
  /** nothing too while the turn has not run. */
  outcome: WakeOutcome;
  /** The messages the agent left for the user in the turn. */
  message_ids: string[];
  /** The questions the agent asked the user in the turn. */
  question_ids: string[];
  /** Plan changes and task starts or stops the agent made in the turn. */
  actions: number;
  /** message_ids with the first line of each message, cut at 140 characters. */
  messages: { id: string; text: string }[];
  /** question_ids with the first line of each question, cut at 140 characters. */
  questions: { id: string; text: string }[];
  /** The tasks the agent's start requests in the turn named. */
  tasks_started: number;
}

/** One routine of an agent of the project. */
export interface AgentRoutineRow {
  agent_id: string;
  agent_name: string;
  /** The revision agent.update takes for this agent. */
  agent_revision: number;
  routine: AgentRoutine;
  /** When the pending run is due, Unix epoch ms; absent while none is pending. */
  next_run_at?: number;
  /** The newest wake that ran the routine; absent when none did. */
  last_run?: Pick<AgentWake, 'turn_id' | 'at' | 'state' | 'outcome'>;
}
