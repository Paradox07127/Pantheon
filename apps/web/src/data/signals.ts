import { useCallback, useEffect, useState } from 'react';
import type { BridgeResult, SignalIssues } from '@pantheon/protocol';
import { failureText } from './needs-you';
import { useProjectQuery } from './project-read';

export type { SignalIssues };
export type SignalIssue = SignalIssues['issues'][number];

const isSignals = (value: unknown): boolean =>
  Array.isArray((value as Partial<SignalIssues> | null)?.issues);

/**
 * Events that change a signal issue: its state changes, and gate runs that may count into one
 * without changing its state. A branch landing writes no event of its own; its worktree's removal
 * follows its end.
 */
export const SIGNAL_KINDS: ReadonlySet<string> = new Set([
  'signal.opened',
  'signal.escalated',
  'signal.resolved',
  'session.gate_checked',
  'session.merged',
  'session.merge_blocked',
  'workspace.removed',
]);

/** GET /v1/project.signals: the project's repeated and flaky gate failures. */
export function useProjectSignals(projectId: string | null) {
  return useProjectQuery<SignalIssues>('project.signals', projectId, isSignals, undefined, {
    kinds: SIGNAL_KINDS,
  });
}

/** GET /v1/app.signals: the errors Pantheon's daemon recorded. */
export async function readAppSignals(): Promise<BridgeResult<SignalIssues>> {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  // Through then, so a bridge that throws instead of rejecting fails the read the same way.
  const result = await Promise.resolve()
    .then(() => bridge.query('app.signals', {}))
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return result;
  if (!isSignals(result.value))
    return { ok: false, error: { code: 'bad_response', message: 'app.signals shape' } };
  return { ok: true, value: result.value as SignalIssues };
}

/** The daemon's errors, read on mount and on reload; a failure keeps the last read. */
export function useAppSignals() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    read: SignalIssues | null;
    error: string | null;
    loading: boolean;
  }>({ read: null, error: null, loading: true });
  useEffect(() => {
    let current = true;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    void readAppSignals().then((result) => {
      if (!current) return;
      setState((s) =>
        result.ok
          ? { read: result.value, error: null, loading: false }
          : { read: s.read, error: failureText(result.error), loading: false },
      );
    });
    return () => {
      current = false;
    };
  }, [attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}
