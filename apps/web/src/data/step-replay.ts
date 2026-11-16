import { useMemo } from 'react';
import type { SessionStepDiff, SessionTrace } from '@pantheon/protocol';
import type { DiffRead } from '../components/DiffReview';
import { parsePatch } from './patch';
import { COMMANDS, EDITS } from './tool-calls';
import { useQuery } from './workbench-sessions';

type TraceSpan = SessionTrace['spans'][number];

export type StepKind = 'read' | 'search' | 'edit' | 'run' | 'other';

/** One tool call of a session, in the order it started. */
export interface ReplayStep {
  span: TraceSpan & { start: number };
  kind: StepKind;
  /** The path, command or query the call acted on; the tool's name without one. */
  subject: string;
  /** Ms from the session's first recorded time. */
  at: number;
}

/** What the session had reached when a step started. */
export interface StepMoment {
  context: { used_tokens: number; window_tokens: number } | null;
  /** Input and output tokens spent before the step. */
  tokens: number;
  /** Distinct files the edit steps up to and including this one named. */
  files: number;
  tests: NonNullable<TraceSpan['gate_state']>;
}

const SEARCHES = ['Glob', 'Grep'];

export function stepKind(name: string): StepKind {
  if (name === 'Read') return 'read';
  if (SEARCHES.includes(name)) return 'search';
  if (EDITS.includes(name)) return 'edit';
  if (COMMANDS.includes(name)) return 'run';
  return 'other';
}

/** The session's timed tool calls by start, ties by id, and its length from first start to last end. */
export function replaySteps(spans: readonly TraceSpan[]): { steps: ReplayStep[]; total: number } {
  const timed = spans.filter((span): span is ReplayStep['span'] => span.start !== null);
  if (timed.length === 0) return { steps: [], total: 0 };
  let origin = Infinity,
    last = -Infinity;
  for (const span of timed) {
    origin = Math.min(origin, span.start);
    last = Math.max(last, span.end ?? span.start);
  }
  const steps = timed
    .filter((span) => span.kind === 'tool')
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((span) => ({
      span,
      kind: stepKind(span.name),
      subject: span.input_summary ?? span.files?.join(', ') ?? span.name,
      at: span.start - origin,
    }));
  return { steps, total: last - origin };
}

const spent = (tokens: TraceSpan['tokens']) => (tokens ? tokens.input + tokens.output : 0);

/** The session at the start of steps[index]; a turn counts its own total once it has ended, its model calls before. */
export function stepMoment(
  spans: readonly TraceSpan[],
  steps: readonly ReplayStep[],
  index: number,
): StepMoment {
  const step = steps[index]!;
  const at = step.span.start;
  const turns = new Map<string, TraceSpan>();
  for (const span of spans) if (span.kind === 'turn') turns.set(span.id, span);
  let tokens = 0;
  for (const span of spans) {
    if (span.kind === 'turn') {
      if (span.tokens && span.end !== null && span.end <= at) tokens += spent(span.tokens);
      continue;
    }
    const turn = span.kind === 'llm' ? turns.get(span.turn) : undefined;
    if (!turn) continue;
    const ended = turn.end !== null && turn.end <= at;
    if (ended ? !turn.tokens : span.end !== null && span.end <= at) tokens += spent(span.tokens);
  }
  const files = new Set(
    steps
      .slice(0, index + 1)
      .filter((s) => s.kind === 'edit')
      .flatMap((s) => s.span.files ?? []),
  );
  const { context_tokens, context_window } = step.span;
  return {
    context:
      context_tokens !== undefined && context_window
        ? { used_tokens: context_tokens, window_tokens: context_window }
        : null,
    tokens,
    files: files.size,
    tests: step.span.gate_state ?? 'none',
  };
}

/** m:ss, or h:mm:ss from an hour. */
export function replayClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const stepParams = (key: string) => {
  const [session_id = '', turn_id = '', span_id = ''] = key.split('\n');
  return { session_id, turn_id, span_id };
};

const acceptStepDiff = (value: unknown): SessionStepDiff | null =>
  Array.isArray((value as Partial<SessionStepDiff> | null)?.files)
    ? (value as SessionStepDiff)
    : null;

/** A step diff in the shape the diff view reads; each recorded patch is one file section. */
export function stepDiffFiles(diff: SessionStepDiff): NonNullable<DiffRead['data']> {
  return {
    files: diff.files.map((f) => {
      const lines = parsePatch(f.patch ?? '').flatMap((file) => file.hunks.flatMap((h) => h.lines));
      return {
        path: f.path,
        additions: lines.filter((l) => l.kind === 'add').length,
        deletions: lines.filter((l) => l.kind === 'del').length,
        untracked: /^--- \/dev\/null$/m.test(f.patch ?? ''),
      };
    }),
    patch: diff.files.map((f) => f.patch ?? '').join(''),
    truncated: diff.files.some((f) => f.truncated),
  };
}

/** What one step's recorded tool input changed; nothing read while step is null. */
export function useStepDiff(
  sessionId: string,
  step: { turn: string; id: string } | null,
): DiffRead {
  // A recorded tool input never changes, so the read is not repeated on board events.
  const read = useQuery(
    'session.step_diff',
    step && `${sessionId}\n${step.turn}\n${step.id}`,
    stepParams,
    acceptStepDiff,
    0,
  );
  const data = useMemo(() => (read.data ? stepDiffFiles(read.data) : null), [read.data]);
  return { data, error: read.error, reload: read.reload };
}
