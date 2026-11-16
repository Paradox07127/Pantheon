import type { Entity } from './index.js';
export interface BaselineTag {
  baseline_id: string;
}
/** One project root's findings; its paths and `file:` sources are relative to `root`. */
export interface BaselineFolder {
  root: string;
  stage: 'empty' | 'early' | 'active' | 'maintenance';
  stack?: string[];
  context?: { instructions: string[]; docs: string[]; task_lists: string[] };
  gate: { name: string; argv: string[]; timeout_ms?: number; sources: string[] }[];
  commands?: Partial<
    Record<'setup' | 'build' | 'test' | 'lint' | 'dev', { argv: string[]; sources: string[] }>
  >;
}
export interface BaselineWorkstream {
  id: string;
  title: string;
  status: 'done' | 'running' | 'next' | 'blocked';
  reason: string;
  /** Checklist items of the facts snapshot; `hash` finds the item again after its line moves. */
  items: { root: string; path: string; line: number; hash: string }[];
  /** `commit:<sha>` references. */
  commits: string[];
  next: string[];
  blockers: string[];
  /** Directories or files the workstream lives in, relative to a project root. */
  modules?: string[];
  /** Ids of the workstreams this one builds on or waits for. */
  depends_on?: string[];
  risks?: string[];
}
/** Each source is `file:<relative path>`, `file:<relative path>:<line>` or `commit:<sha>`. */
export interface BaselineResult {
  folders: BaselineFolder[];
  workstreams: BaselineWorkstream[];
  contradictions: { text: string; refs: string[] }[];
  findings: { text: string; refs: string[]; severity: 'info' | 'risk' }[];
  brief?: { goal: string; goals: string[]; non_goals: string[]; sources: string[] };
  /** The questions of the current round. */
  questions: BaselineQuestion[];
  /** Extensions the assessment suggests turning off for coding sessions. */
  extensions?: BaselineExtension[];
  /** Next tasks; a result stored before tasks were assessed has none. */
  tasks?: BaselineTask[];
}
/** A small picture shown with a baseline question option. */
export type BaselinePreview =
  | {
      kind: 'graph';
      spec: {
        nodes: { id: string; label: string; group?: string }[];
        edges: { from: string; to: string; label?: string }[];
        direction?: 'LR' | 'TB';
      };
    }
  | { kind: 'mermaid'; spec: { source: string } };
export interface BaselineQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; preview?: BaselinePreview }[];
  multiSelect: boolean;
  /** The label of the recommended option. */
  recommended?: string;
  kind?: 'direction';
}
export interface BaselineAnswer {
  question_id: string;
  question: string;
  /** The chosen labels joined by "; " for a multiSelect question. */
  answer: string;
  /** model: the user let the model decide; answer is empty or the recommended label. */
  by: 'user' | 'model';
}
/** `workstream` and `depends_on` name ids in the same result; `scope` holds repo-relative paths. */
export interface BaselineTask {
  id: string;
  title: string;
  workstream: string;
  why: string;
  scope: string[];
  acceptance: string[];
  depends_on: string[];
  sources: string[];
}
export interface BaselineExtension {
  runtime: string;
  kind: 'mcp_server' | 'plugin' | 'skill';
  name: string;
  reason: string;
}
/** An extension the assessment turned off; restored means the user turned it back on and assessments leave it on. */
export type AutoClosedExtension = BaselineExtension & { baseline_id: string; restored?: true };
export interface ChecklistItem {
  line: number;
  done: boolean;
  text: string;
  section?: string;
  hash: string;
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
  /** Folders handed in while running; submission moves them into `result`. */
  folders?: BaselineFolder[];
  result?: BaselineResult;
  /** Entries dropped because none of their sources resolved. */
  dropped: number;
  reason?: string;
  created_at: number;
  deadline?: number;
  /** The lead that started this baseline; the confirmed result goes to it. */
  lead_session_id?: string;
  /** The lead the confirmation opened to plan the board from this baseline. */
  plan_session_id?: string;
  /** Rounds already answered that opened the next round, oldest first. */
  rounds?: { questions: BaselineQuestion[]; answers: BaselineAnswer[]; at: number }[];
}
