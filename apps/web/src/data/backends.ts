import { useEffect, useRef, useState } from 'react';
import type { BackendSummary } from '@pantheon/protocol';
import { useBoard } from './board';

const NONE: readonly BackendSummary[] = [];

/** The backends, or null when the read failed or its result is incomplete. */
async function readBackends(): Promise<BackendSummary[] | null> {
  const result = await window.pantheon?.query('backend.list', {}).catch(() => null);
  if (!result?.ok) return null;
  const value = result.value as Partial<BackendSummary>[] | null;
  return Array.isArray(value) &&
    value.every(
      (b) => typeof b?.id === 'string' && Array.isArray(b.runtimes) && Array.isArray(b.models),
    )
    ? (value as BackendSummary[])
    : null;
}

interface BackendsRead {
  list: readonly BackendSummary[];
  done: Promise<readonly BackendSummary[]>;
  /** When the read succeeded; null while it runs. */
  at: number | null;
}

/** A successful read older than this is done again on the next mount; its result shows meanwhile. */
const MAX_AGE_MS = 60_000;

// One read shared across mounts; a failed read is tried again on the next mount.
let shared: BackendsRead | null = null;

function readOnce(): BackendsRead {
  const known = shared;
  if (known && (known.at === null || Date.now() - known.at < MAX_AGE_MS)) return known;
  const read: BackendsRead = {
    list: known?.list ?? NONE,
    at: null,
    done: readBackends().then((list) => {
      read.list = list ?? NONE;
      read.at = Date.now();
      if (!list && shared === read) shared = null;
      return read.list;
    }),
  };
  shared = read;
  return read;
}

/** GET /v1/backend.list, kept across mounts for MAX_AGE_MS and asked again on reconnect; empty until read and when the read fails. */
export function useBackends(): readonly BackendSummary[] {
  const [settled, setSettled] = useState<readonly BackendSummary[] | null>(null);
  const live = useBoard((s) => s.status.state === 'live');
  // Counts the times the stream went live, so a disconnect alone reads nothing.
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  const reconnected = reconnects.current.count;

  useEffect(() => {
    let current = true;
    void readOnce().done.then((list) => {
      if (current) setSettled(list);
    });
    return () => {
      current = false;
    };
  }, [reconnected]);

  return settled ?? shared?.list ?? NONE;
}
