import type { Entity } from './index.js';
import type { CharterPower } from './workflow.js';

/** A project setting the Assistant may propose to change: a workflow policy value, a stored charter power or the external events mode. */
export type SettingParam =
  | 'plan_changes'
  | 'max_parallel'
  | 'dispatch_paused'
  | 'acceptance_wake'
  | 'external_events'
  | `charter.${Exclude<CharterPower, 'plan_change' | 'start_external'>}`;

/** A setting change the Assistant proposes from the user's own words, which waits for the user's decision. */
export interface SettingProposal extends Entity {
  project_id: string;
  /** The proposing Assistant session. */
  session_id: string;
  param: SettingParam;
  /** The value the setting had when the proposal was made. */
  current: string | number | boolean;
  /** The proposed value. */
  value: string | number | boolean;
  /** The user's words the proposal rests on, verbatim from one of their messages. */
  quote: string;
  state: 'pending' | 'applied' | 'declined';
  at: number;
  resolved_at?: number;
  /** The workflow policy version the applied change wrote; absent for external_events, a project setting. */
  policy_version?: number;
}
