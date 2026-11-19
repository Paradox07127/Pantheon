import type { AgentRoutineRow, AgentWake } from '@pantheon/protocol';
import { useBoard } from './board';
import { useProjectQuery } from './project-read';
import { useQuery } from './workbench-sessions';

export type { AgentRoutineRow, AgentWake };

/** The session turn events, which queue, run and end an agent's wakes. */
const TURN_KINDS: ReadonlySet<string> = new Set([
  'turn.queued',
  'turn.running',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
]);

/** Agent writes, routine timers and turns: what changes a routine, its next run or its last run. */
const ROUTINE_KINDS: ReadonlySet<string> = new Set([
  'agent_profile.created',
  'agent_profile.updated',
  'timer.fired',
  'agent.routine_skipped',
  'agent.wake_held',
  ...TURN_KINDS,
]);

/** Every routine of the project's agents that are not archived, from agent.routines. */
export function useRoutines(projectId: string | null) {
  return useProjectQuery<AgentRoutineRow[]>('agent.routines', projectId, Array.isArray, undefined, {
    kinds: ROUTINE_KINDS,
  });
}

const wakeParams = (key: string) => ({
  ...(JSON.parse(key) as Record<string, string>),
  limit: '50',
});
const acceptWakes = (value: unknown): AgentWake[] | null =>
  Array.isArray(value) ? (value as AgentWake[]) : null;

/** The agent's newest 50 wakes, of routineId only when given, read again when a turn of the project moves; none while agentId is null. */
export function useAgentWakes(
  projectId: string | null,
  agentId: string | null,
  routineId?: string,
) {
  const tick = useBoard((s) => {
    for (let i = s.events.length - 1; i >= 0; i--) {
      const event = s.events[i]!;
      if (event.project_id === projectId && TURN_KINDS.has(event.kind)) return event.sequence;
    }
    return 0;
  });
  const key =
    agentId === null
      ? null
      : JSON.stringify({ agent_id: agentId, ...(routineId && { routine_id: routineId }) });
  return useQuery<AgentWake[]>('agent.wakes', key, wakeParams, acceptWakes, tick);
}
