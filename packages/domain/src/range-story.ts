import type { Entity } from './index.js';

/** One paragraph on what was merged into a project between two times, written by a read-only session. */
export interface RangeStory extends Entity {
  id: string;
  /** The project whose merges are explained. */
  project_id: string;
  /** Start of the range, inclusive, in ms since the epoch. */
  from: number;
  /** End of the range, exclusive, in ms since the epoch. */
  to: number;
  /** running until the session submits; failed when it ends or times out without one. */
  state: 'running' | 'ready' | 'failed';
  /** The interpreting session; null when none was started. */
  session_id: string | null;
  /** ISO time the story was started. */
  created_at: string;
  /** The submitted lines; empty until ready. */
  lines: string[];
  /** Whether the story explains the range's merges or its commits. */
  source: 'merges' | 'commits';
  /** Why the story failed. */
  error?: string;
}
