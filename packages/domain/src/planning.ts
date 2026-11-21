import type { GateFailureClass } from './board.js';
import type { Entity } from './index.js';
/** One run of a project root's commands in a throwaway worktree provisioned as a worker's is. */
export interface EnvironmentCheck extends Entity {
  project_id: string;
  root: string;
  /** The throwaway worktree; every end of the check queues its removal. */
  workspace_id?: string;
  commit?: string;
  cause:
    | { kind: 'user' }
    | { kind: 'baseline'; baseline_id: string; attempt: 1 | 2 }
    // Disused: only checks of older databases have this cause.
    | { kind: 'signal'; issue_id: string };
  state: 'running' | 'passed' | 'failed' | 'inconclusive';
  reason_code?:
    'setup_failed' | 'checks_failed' | 'checks_environment' | 'check_error' | 'daemon_restart';
  /** In run order; the worktree's preparation is the command named `setup`. */
  commands: {
    name: string;
    argv: string[];
    exit_code: number;
    duration_ms: number;
    output_tail: string;
    failure_class?: GateFailureClass;
  }[];
  started_at: number;
  finished_at?: number;
}
export interface BaselineTag {
  baseline_id: string;
}
/** One project root's gate candidates; its `file:` sources are relative to `root`. */
export interface BaselineFolder {
  root: string;
  gate: {
    name: string;
    argv: string[];
    timeout_ms?: number;
    enabled?: boolean;
    skippable?: boolean;
    sources: string[];
  }[];
  /** Prepares a fresh worktree before the gate runs, such as installing dependencies. */
  setup?: { argv: string[]; sources: string[] };
}
/** Each source is `file:<relative path>`, `file:<relative path>:<line>` or `commit:<sha>`. */
export interface BaselineResult {
  folders: BaselineFolder[];
}
/** An extension an assessment turned off; restored means the user turned it back on. */
export interface AutoClosedExtension {
  runtime: string;
  kind: 'mcp_server' | 'plugin' | 'skill';
  name: string;
  reason: string;
  baseline_id: string;
  restored?: true;
}
export interface ChecklistItem {
  line: number;
  done: boolean;
  text: string;
  section?: string;
  hash: string;
}
/** Module dependencies measured from manifests and import statements; directories are relative to the root, "." for the root itself. */
export interface CodeDependencies {
  packages: { dir: string; name: string; depends_on: string[] }[];
  modules: { from: string; to: string; imports: number; sample: string }[];
  languages: string[];
  not_measured: { language: string; files: number }[];
  external_imports: number;
}
export interface FolderFacts {
  root: string;
  git: boolean;
  branch?: string;
  head?: string;
  dirty_files?: number;
  ahead?: number;
  behind?: number;
  last_commit_at?: number;
  commits_per_day: { date: string; count: number }[];
  hotspots: { path: string; commits: number }[];
  recent_commits: { sha: string; subject: string; at: number }[];
  file_types: { ext: string; count: number }[];
  directories: { path: string; files: number }[];
  manifests: { path: string; scripts: Record<string, string>; dependencies: string[] }[];
  agent_instructions: { path: string; lines: number }[];
  docs: { path: string; headings: string[]; modified_at: number }[];
  checklists: { path: string; modified_at: number; items: ChecklistItem[] }[];
  tests: { files: number; configs: string[] };
  ci: { path: string; commands: string[] }[];
  truncated: string[];
  code_deps?: CodeDependencies;
}
export interface ProjectFacts {
  collected_at: number;
  folders: FolderFacts[];
}
/** One measured snapshot of a project's folders, taken without a model. */
export interface BaselineFacts extends Entity {
  project_id: string;
  collected_at: number;
  facts: ProjectFacts;
}
export interface ProjectBaseline extends Entity {
  project_id: string;
  state: 'running' | 'submitted' | 'confirmed' | 'failed' | 'empty';
  session_id?: string;
  runtime?: string;
  facts_id: string;
  result?: BaselineResult;
  /** Entries dropped because none of their sources resolved. */
  dropped: number;
  reason?: string;
  created_at: number;
  deadline?: number;
  /** The environment checks of the proposed commands; `commands` is of the newest attempt. */
  environment?: {
    check_ids: string[];
    /** When a failed check sent the baseline session back to fix its commands, which it gets once. */
    fix_requested_at?: number;
    commands: { root: string; name: string; state: 'passed' | 'failed' | 'not_run' }[];
  };
}
