import type { Entity } from './index.js';

/** The board task a stored record was scoped to. */
export interface MemoryTaskScope {
  lead_session_id: string;
  id: string;
  generation?: number;
}

/** An immutable text version. Only lifecycle metadata changes; a replacement gets a new id. */
export interface MemoryRecord extends Entity {
  project_id: string;
  key: string;
  title?: string;
  summary?: string;
  tags?: string[];
  references?: MemoryReference[];
  kind: 'decision' | 'report' | 'note';
  task?: MemoryTaskScope;
  state: 'draft' | 'active' | 'archived';
  authority: 'user' | 'agent_reported';
  author: string;
  author_session_id?: string;
  body_hash: string;
  dependencies: string[];
  based_on: string;
  source_signature?: string;
  created_at: number;
  /** When a session last read it with memory.get, stamped at most once a day. */
  last_used_at?: number;
  /** HEAD of the project's first root when a session proposed it with a file reference. */
  verified_commit?: string;
  expires_at?: number;
  committed_at?: number;
  archived_at?: number;
  /** Set on a record a plan wrote; the plan decided it, not the user. */
  origin?: MemoryOrigin;
  reason?: 'superseded' | 'expired' | 'retracted' | 'stale';
  superseded_by?: string;
  restored_from?: string;
  /** Durable pre-retraction states and the revisions produced by that operation. */
  retraction?: {
    records: { record: Omit<MemoryRecord, 'retraction'>; archived_revision: number }[];
    /** Already committed versions; a later commit of the same scope prevents undo. */
    committed_ids: string[];
  };
}
export interface MemoryOrigin {
  kind: 'plan';
  lead_session_id: string;
  /** The milestone entity the assumption or risk rested on. */
  milestone_id?: string;
  subject: 'assumption' | 'risk';
  subject_id: string;
  outcome: 'confirmed' | 'refuted' | 'closed';
  edit_id?: string;
}
export interface MemoryState extends Entity {
  project_id: string;
  epoch: number;
}
export interface MemoryJob extends Entity {
  project_id: string;
  signature: string;
  state: 'pending' | 'running' | 'done' | 'obsolete' | 'failed';
  attempts: number;
  lease_until?: number;
  retry_at?: number;
  error?: string;
  created_at: number;
  completed_at?: number;
  body_hash?: string;
}
export interface MemoryItem extends MemoryRecord {
  text: string;
  version?: number;
}
export interface MemoryContext {
  epoch: number;
  signature: string;
  items: MemoryItem[];
  omitted: number;
  bytes: number;
}

/** Reference identity only. The original project file or URL remains authoritative. */
export interface MemoryReference {
  kind: 'file' | 'url';
  uri: string;
  label?: string;
  root?: number;
  /** Captured when the referenced project file is small enough to hash. */
  content_hash?: string;
}
export interface MemorySummary {
  id: string;
  revision: number;
  key: string;
  title: string;
  summary: string;
  tags: string[];
  kind: MemoryRecord['kind'];
  state: MemoryRecord['state'];
  authority: MemoryRecord['authority'];
  author_session_id?: string;
  task?: MemoryRecord['task'];
  created_at: number;
  reason?: MemoryRecord['reason'];
  version?: number;
  superseded_by?: string;
  superseded_by_version?: number;
  expires_at?: number;
  archived_at?: number;
  basis_id?: string;
  basis_title?: string;
  origin?: MemoryOrigin;
  indexed: boolean;
  bytes: number;
  reasons?: string[];
}
export interface MemoryFilters {
  state?: MemoryRecord['state'] | 'all';
  /** Several kinds match any of them; an empty list matches none. */
  kind?: MemoryRecord['kind'] | MemoryRecord['kind'][];
  /** A record matches when it has every tag given. */
  tag?: string | string[];
  q?: string;
}
export interface MemoryDirectory {
  epoch: number;
  records: MemorySummary[];
  signature: string;
  next_cursor?: string;
  total: number;
  index_pending: number;
  facets: {
    tags: { tag: string; count: number }[];
  };
  budget: { used_bytes: number; limit_bytes: number };
  counts: Record<MemoryRecord['state'], number>;
  jobs: MemoryJob[];
  sessions: {
    id: string;
    title?: string;
    delivered: boolean;
    prepared: boolean;
    memory_tool: boolean;
    stale: boolean;
  }[];
  document_ready: boolean;
}
export interface MemoryGraph {
  nodes: {
    id: string;
    label: string;
    kind: MemoryRecord['kind'] | 'tag' | 'source';
    state?: MemoryRecord['state'];
    version?: number;
    source_kind?: 'file' | 'url' | 'session';
    memory_id?: string;
    summary?: string;
    uri?: string;
  }[];
  edges: {
    id: string;
    from: string;
    to: string;
    kind: 'depends_on' | 'supersedes' | 'restored_from' | 'source' | 'tagged';
  }[];
  signature: string;
  total: number;
  truncated: boolean;
  depth: number;
}
