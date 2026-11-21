import type { Entity, LandingItem } from './index.js';

export type StoryKind = 'added' | 'behavior' | 'fix' | 'refactor' | 'style' | 'test' | 'config';
/** Where a change shows: a ui card gets a sketch, every other surface a structure diagram. */
export type StorySurface = 'ui' | 'api' | 'cli' | 'data' | 'internal';
/** The commit a diagram element exists in: before is from_sha, after is to_sha. */
export type StorySide = 'before' | 'after' | 'both';
/** quote must occur in file at the commit(s) the element's side names. */
export interface StoryAnchor {
  file: string;
  quote: string;
}
export interface FlowDiagram {
  type: 'flow';
  title: string;
  lanes: string[];
  nodes: { id: string; label: string; lane: string; side: StorySide; anchor?: StoryAnchor }[];
  edges: { from: string; to: string; label?: string; side: StorySide }[];
}
export interface DecisionDiagram {
  type: 'decision';
  title: string;
  rows: {
    case: string;
    before: string;
    after: string;
    before_anchor?: StoryAnchor;
    after_anchor?: StoryAnchor;
  }[];
}
export interface TypeDiagram {
  type: 'type';
  name: string;
  file: string;
  /** A field whose type changed appears twice under one name, once per side; quote is looked up in file. */
  fields: { name: string; type: string; side: StorySide; quote: string }[];
}
export interface UiSketch {
  type: 'ui';
  title: string;
  /** A region without parent is a top-level area. */
  regions: { id: string; label: string; parent?: string; side: StorySide; anchor?: StoryAnchor }[];
}
export type StoryDiagram = FlowDiagram | DecisionDiagram | TypeDiagram | UiSketch;
/** Hunk ids are the `H1…Hn` of the landing diff the interpreter was given. */
export interface StoryCardInput {
  title: string;
  kind: StoryKind;
  surface: StorySurface;
  /** Indexes into the task's acceptance list; empty means the card is outside the task. */
  acceptance: number[];
  before: string;
  after: string;
  how: { text: string; hunks: string[] }[];
  hunks: string[];
  /** The card's hunks that change test files. */
  tests: string[];
  diagram?: StoryDiagram;
}
/** overall.before[i] and overall.after[i] describe the same thing. */
export interface StorySubmission {
  overall: { before: string[]; after: string[] };
  cards: StoryCardInput[];
  noise: string[];
}
export interface StoryEvidence {
  source: 'check' | 'gate';
  /** Check id, or the gate's name. */
  id: string;
  label: string;
  status: 'passed' | 'failed';
}
export interface StoryCard extends Omit<StoryCardInput, 'diagram'> {
  out_of_scope: boolean;
  /** Recorded gates that name one of the card's test files; their status is the command's exit result. */
  evidence: StoryEvidence[];
  /**
   * Absent when the card had no diagram or more than half its elements are inferred.
   * Element keys: node or region id; row or field index as a decimal string.
   */
  diagram?: { spec: StoryDiagram; inferred: string[]; hunks: Record<string, string> };
  /** Indexes of other cards that share a hunk with this one; non-empty disables the card revert. */
  shared_with: number[];
}
export interface StoryResult {
  overall: StorySubmission['overall'];
  cards: StoryCard[];
  noise: string[];
  /** Hunks that no card and no noise entry claimed. */
  uninterpreted: string[];
  hunk_total: number;
  /** Acceptance indexes that no card cites. */
  unmatched_acceptance: number[];
}
export interface StoryTag {
  story_id: string;
}
/** Frozen task and command evidence supplied to the interpreter, independent of model claims. */
export interface StoryContext {
  goal: string;
  acceptance: string[];
  task?: import('./memory.js').MemoryTaskScope;
  /** False when a bound task's historical generation no longer has a recorded contract. */
  contract_available: boolean;
  checks: {
    state: 'none' | 'stale' | 'recorded';
    /** Expected command configuration, including task acceptance commands before project gates. */
    spec_hash: string;
    commands: { name: string; argv: string[]; timeout_ms?: number }[];
    run_id?: string;
    commit?: string;
    recorded_spec_hash?: string;
    checked_at?: number;
    results: NonNullable<LandingItem['gate_results']>;
  };
}
/** One interpretation of one workbench session's from_sha..to_sha. */
export interface ChangeStory extends Entity {
  project_id: string;
  /** The workbench session whose changes are interpreted; session_id is the interpreting session. */
  workbench_session_id?: string;
  source: string;
  from_sha: string;
  to_sha: string;
  state: 'running' | 'ready' | 'failed';
  reason?: string;
  session_id?: string;
  runtime?: string;
  deadline?: number;
  created_at: number;
  context?: StoryContext;
  /** Read-time projection: commits, contract or recorded command evidence have changed. */
  outdated?: boolean;
  result?: StoryResult;
}
