/**
 * agent.chapter_started, on the new resident session after a rotation: chapter counts the agent's
 * sessions; handoff_memory_id is the note the old session wrote, previous_memory_id the one it replaced.
 */
export interface AgentChapterStartedPayload {
  chapter: number;
  handoff_memory_id?: string;
  previous_memory_id?: string;
}
