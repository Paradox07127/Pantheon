import type { LeadNote, LeadQuestion } from './board.js';

/**
 * One entry of a task's thread: lead_message a lead-origin turn on a task session, report a
 * task.reported note, finding a recorded review finding of a task session, question and answer a
 * board question blocking the task or relayed from its session, note any other note left for the
 * lead on the task, gate a gate run of a task session, dispatched, handed_back and merged the
 * task's dispatch, its hand-back to the lead and a merge of the task, merge_blocked a blocked merge
 * of a task session, tracker_message a turn the task tracker queued on a task session.
 */
export interface TaskThreadEntry {
  /** The event the entry was read from. */
  event_id: string;
  /** Unix epoch milliseconds. */
  at: number;
  kind:
    | 'lead_message'
    | 'report'
    | 'finding'
    | 'question'
    | 'answer'
    | 'note'
    | 'gate'
    | 'dispatched'
    | 'handed_back'
    | 'merged'
    | 'merge_blocked'
    | 'tracker_message';
  session_id?: string;
  /**
   * On a finding its location and impact; on a gate entry the names of the commands that failed; on
   * a hand-back or blocked merge its reason; on a tracker message its input; empty on a dispatch or
   * merge.
   */
  text: string;
  /** On a report or note, its kind. */
  note_kind?: LeadNote['kind'];
  question_id?: string;
  /** On a finding, whether it blocks the merge. */
  blocking?: boolean;
  /** On a gate entry, whether every command passed. */
  passed?: boolean;
  /** On a gate entry, each command that ran and whether it passed. */
  commands?: { name: string; passed: boolean }[];
  /** On a finding, where it is and what it breaks. */
  location?: string;
  impact?: string;
  /** On a finding, the reviewer session that recorded it, when one session of its runtime reviewed. */
  reviewer_session_id?: string;
  /** On an answer, who gave it. */
  answered_by?: NonNullable<LeadQuestion['answered_by']>;
  /** On an answer, whether it replaced the lead's earlier answer. */
  overruled?: boolean;
}
