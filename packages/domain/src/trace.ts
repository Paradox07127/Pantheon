export interface TraceSpan {
  /** Unique within its source: a Claude toolu_ or request id, a Codex call_id, a Pantheon turn id. */
  id: string;
  /** null on a turn span; a span inside a subagent points at the tool call that spawned it. */
  parent: string | null;
  /** id of the turn span this span belongs to. */
  turn: string;
  kind: 'turn' | 'llm' | 'tool' | 'subagent' | 'compact';
  name: string;
  /** Epoch ms; null when no start was recorded. */
  start: number | null;
  /** Epoch ms; null when no end was recorded. Only a running span grows with the clock. */
  end: number | null;
  status: 'ok' | 'error' | 'running' | 'unknown';
  /** Which side the times come from. */
  timing: 'native' | 'daemon';
  /** Duration explicitly reported by the runtime, independent of receipt timestamps. */
  duration_ms?: number;
  /** True when both endpoints were recorded by the same native source. */
  native_interval?: boolean;
  /** Exact Claude chain entry preceding this main-thread span, when recorded. */
  native_history_before?: string;
  tokens?: { input: number; output: number; cache_read?: number };
  /** Tool input excerpt, at most 200 characters. */
  input_summary?: string;
  /** Consecutive failed identical calls preceding this attempt in the same turn; absent when zero. */
  retry_count?: number;
  exit_code?: number;
  cost_usd?: number;
  /** Latest runtime usage at or before this span's start; absent without a report. */
  context_tokens?: number;
  context_window?: number;
  /** Latest completed session gate at span start; none when no result is recorded. */
  gate_state?: 'passed' | 'failed' | 'none';
  files?: string[];
  commit?: { sha: string; via: 'merge' | 'bash_output' };
}
export interface TraceLane {
  /** session_id for a Pantheon session; native:<runtime>:<native id> for an external one. */
  key: string;
  source: 'pantheon' | 'external';
  runtime: 'claude' | 'codex';
  session_id?: string;
  native_id: string;
  title: string;
  cwd: string;
  branch?: string;
}
export interface TraceMeta {
  runtime: 'claude' | 'codex';
  native_id: string;
  cwd: string;
  version?: string;
  parent_native_id?: string;
  parent_tool_use_id?: string;
}

export type TraceTimeKind =
  | 'queue'
  | 'approval'
  | 'delivery'
  | 'tool'
  | 'llm'
  | 'subagent'
  | 'compact'
  | 'parallel'
  | 'unknown';

export interface TraceTimeEvidence {
  lane_key: string;
  turn_id?: string;
  id: string;
  span_id?: string;
  operation?: string;
  at: number;
  source: 'daemon' | 'native' | 'runtime_reported';
}

export interface TraceTimeSlice {
  kind: TraceTimeKind;
  ms: number;
  evidence: TraceTimeEvidence[];
  concurrent?: { kinds: TraceTimeKind[]; ms: number }[];
}

/** The union of request windows and the sum of individually timed operations. */
export interface TraceTimeAllocation {
  from: number;
  to: number;
  wall_ms: number;
  wall: TraceTimeSlice[];
  work_ms: number;
  work: TraceTimeSlice[];
  turns: number;
  operations: number;
  untimed_operations: number;
  /** Runtime durations without reliable placement in the wall clock. */
  unplaced_operations: number;
  gate_ms: number;
  gates: number;
  live: boolean;
  partial: boolean;
  native: 'included' | 'indexing' | 'unavailable';
  /** Project reads include each lane's allocation over the same window. */
  by_lane?: Record<string, Omit<TraceTimeAllocation, 'by_lane'>>;
}

export type RuntimeFindingKind =
  | 'turn_queue'
  | 'turn_prepare'
  | 'approval'
  | 'permission_delivery'
  | 'gate'
  | 'slow_tool'
  | 'tool_failure'
  | 'turn_failure'
  | 'context_compaction'
  | 'background_task';

export interface RuntimeFinding {
  id: string;
  kind: RuntimeFindingKind;
  layer: 'harness' | 'human' | 'tool' | 'runtime';
  source: 'daemon' | 'native' | 'runtime_reported';
  at: number;
  lane_key?: string;
  turn_id?: string;
  task_id?: string;
  duration_ms?: number;
  ongoing?: boolean;
  /** Allowlisted category only. Commands and tool arguments stay in the source. */
  tool_category?: 'shell' | 'poll' | 'agent' | 'edit' | 'read' | 'other';
  /** The error of the turn.failed event, on a turn_failure. */
  error?: string;
  /** Parent span is useful for detecting overlap. Native associations may be inferred. */
  parent_span_id?: string;
  /** True for Codex execution items linked to an enclosing logical call by timing. */
  parent_inferred?: boolean;
  /** Observed start, available when the time boundaries share a source. */
  started_at?: number;
  evidence_ids: string[];
  /** At most 20 source records, oldest first. */
  evidence?: {
    source: RuntimeFinding['source'];
    at: number;
    id: string;
    duration_ms?: number;
  }[];
}

export interface RuntimeDiagnostics {
  from: number;
  to: number;
  slow_tool_ms?: number;
  events_read: number;
  tools_timed: number;
  tools_untimed: number;
  partial: boolean;
  native: 'included' | 'indexing' | 'unavailable';
  /** Per-source presence; even an uncapped native window can lack approval or scheduler events. */
  coverage?: {
    daemon_events: number;
    native_lanes: number;
    paired_approvals: number;
    compactions: number;
  };
  findings: RuntimeFinding[];
}

/** The analysis session owns a frozen projection, a proposed experiment and any user readback. */
export interface RuntimeReview {
  from: number;
  to: number;
  evidence_hash: string;
  created_at: number;
  report?: RuntimeReviewReport;
  memory_id?: string;
  verification?: {
    outcome: 'improved' | 'unchanged' | 'regressed';
    baseline: number;
    trial: number;
    evidence: string;
    recorded_at: number;
  };
}

export interface RuntimeReviewReport {
  summary: string;
  finding_ids: string[];
  evidence_ids?: string[];
  change: string;
  baseline: string;
  metric: string;
  rollback: string;
  disposition: 'experiment' | 'measure' | 'none';
  recorded_at: number;
}

export interface RuntimeReviewHistory {
  session_id: string;
  runtime: string;
  from: number;
  to: number;
  created_at: number;
  state: 'running' | 'ready' | 'failed' | 'waiting';
  report?: RuntimeReviewReport;
  memory_id?: string;
  verification?: RuntimeReview['verification'];
}
