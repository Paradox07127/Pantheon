import type { LeadNote } from './board.js';

/**
 * One entry of a task's thread: lead_message a lead-origin turn on a task session, report a
 * task.reported note, finding a recorded review finding of a task session, question and answer a
 * board question blocking the task or relayed from its session, note any other note left for the
 * lead on the task, gate a gate run of a task session.
 */
export interface TaskThreadEntry {
  /** The event the entry was read from. */
  event_id: string;
  /** Unix epoch milliseconds. */
  at: number;
  kind: 'lead_message' | 'report' | 'finding' | 'question' | 'answer' | 'note' | 'gate';
  session_id?: string;
  /** On a finding its location and impact; on a gate entry the names of the commands that failed. */
  text: string;
  /** On a report or note, its kind. */
  note_kind?: LeadNote['kind'];
  question_id?: string;
  /** On a finding, whether it blocks the merge. */
  blocking?: boolean;
  /** On a gate entry, whether every command passed. */
  passed?: boolean;
}
