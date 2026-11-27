import type { Entity, RuntimeChoice } from './index.js';
/** The adjustable parts of one project's workflow; the row id is the project id. */
export interface WorkflowPolicy extends Entity {
  project_id: string;
  /** Starts at 1 and rises by 1 with each change; 0 for the defaults of a project with no row. */
  policy_version: number;
  gate_on_fail?: 'retry' | 'stop';
  gate_runner?: 'daemon' | 'session';
  max_spawned?: number;
  runtime_parallel?: Record<string, number>;
  task_size?: 'small' | 'medium' | 'large';
  verify_timing?: 'each_session' | 'before_landing';
  kind_routes?: (RuntimeChoice & { kind: string; fallbacks?: RuntimeChoice[] })[];
  /**
   * The input tokens, cached ones included, the project's turns that ended since `since` (Unix
   * milliseconds, when the budget was first set) may spend; once spent, no session is woken on its
   * own until the user raises or clears it. Absent sets no limit.
   */
  project_budget?: { input_tokens: number; since: number };
  /** The settings the project sets itself; the others follow the global values. Absent on a policy stored before global values, whose stored settings are all its own. */
  overridden?: Exclude<
    keyof WorkflowPolicy,
    keyof Entity | 'project_id' | 'policy_version' | 'project_budget' | 'overridden'
  >[];
}
