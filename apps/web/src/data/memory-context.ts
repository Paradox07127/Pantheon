import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemoryContext, MemoryDirectory, MemoryRecord } from '@pantheon/domain';
import { command, USER_PRINCIPAL_ID, type BridgeResult } from '@pantheon/protocol';
import { useBoard } from './board';
import { useMemoryQuery } from './memory';
import { sendProjectCommand, type MutationResult } from './project-read';
import { STREAM_KINDS } from './sync';
import { useFocusTick, useRefetchTick } from './workbench-sessions';

export type { MemoryContext, MemoryDirectory };

/** One row of `memory.recent`, newest first. */
export interface MemoryRecentItem {
  at: number;
  kind: 'proposed' | 'committed' | 'archived' | 'restored' | 'retraction_undone';
  memory_id: string;
  memory_kind: MemoryRecord['kind'];
  /** Why the record is archived now, on a record that is. */
  reason?: NonNullable<MemoryRecord['reason']>;
  key: string;
  title: string;
  actor: string;
}

export interface ContextError {
  code: string;
  message: string;
}

/** What a `memory_budget_exceeded` refusal of `memory.commit` carries; the bytes are absent when its details did not come through. */
export interface BudgetRefusal {
  used_bytes?: number;
  limit_bytes?: number;
  /** The largest confirmed decisions, largest first. */
  largest_records: { id: string; title: string; bytes: number }[];
}

export const budgetRefusal = (error: { code: string }): BudgetRefusal => ({
  largest_records: [],
  ...(error as { details?: Partial<BudgetRefusal> }).details,
});

/** How many of one kind wait for the user, and when the oldest of them arrived. */
export interface Waiting {
  count: number;
  oldest: number | null;
}

async function readContext(project_id: string): Promise<BridgeResult<MemoryContext>> {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  // A read: unlike runCommand it does not refresh the board afterwards.
  return bridge
    .command(command(USER_PRINCIPAL_ID, 'memory.context', { project_id }))
    .then((result) => result as BridgeResult<MemoryContext>)
    .catch((error: unknown) => ({
      ok: false as const,
      error: { code: 'ipc_failed', message: String(error) },
    }));
}

/** What agents of the project get now, read again when the project's events move or the stream comes back. */
export function useMemoryContext(projectId: string) {
  const sequence = useBoard(
    (s) =>
      s.events.findLast((e) => e.project_id === projectId && !STREAM_KINDS.has(e.kind))?.sequence ??
      0,
  );
  const live = useBoard((s) => s.status.state === 'live');
  // Counts the times the stream went live, so a disconnect alone reads nothing.
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  const tick = useRefetchTick(sequence, false) + useFocusTick() + reconnects.current.count;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    projectId: string | null;
    data: MemoryContext | null;
    error: ContextError | null;
  }>({ projectId: null, data: null, error: null });
  useEffect(() => {
    let current = true;
    void readContext(projectId).then((result) => {
      if (!current) return;
      setState(
        result.ok
          ? { projectId, data: result.value, error: null }
          : {
              projectId,
              data: null,
              error: { code: result.error.code, message: result.error.message },
            },
      );
    });
    return () => {
      current = false;
    };
  }, [projectId, tick, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const mine = state.projectId === projectId;
  return {
    data: mine ? state.data : null,
    error: mine ? state.error : null,
    loading: !mine,
    reload,
  };
}

export const useMemoryRecent = (projectId: string, limit = 5) =>
  useMemoryQuery<{ items: MemoryRecentItem[] }>('memory.recent', projectId, { limit });

/** The project's memory drafts, oldest included; the directory reads at most 50 per page. */
export const useMemoryDrafts = (projectId: string) =>
  useMemoryQuery<MemoryDirectory>('memory.read', projectId, { state: 'draft', limit: 50 });

export function contextCounts(context: MemoryContext) {
  const of = (kind: string) => context.items.filter((i) => i.kind === kind).length;
  return {
    decision: of('decision'),
    report: of('report'),
    note: of('note'),
    omitted: context.omitted,
  };
}

export const maintainMemory = (project_id: string): Promise<MutationResult> =>
  sendProjectCommand('memory.maintain', { project_id }, null);
