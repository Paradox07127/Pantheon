import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeResult, DeviceListItem } from '@pantheon/protocol';
import { useBoard } from './board';
import { failureText, reasonText } from './needs-you';
import type { DaemonEvent } from './sync';

export type DevicesRead =
  | { state: 'loading' }
  | { state: 'ready'; devices: DeviceListItem[] }
  | { state: 'failed'; text: string };

async function readDevices(refresh: boolean): Promise<DevicesRead> {
  const bridge = window.pantheon;
  if (!bridge) return { state: 'failed', text: reasonText('bridge_unavailable') };
  // Through then, so a bridge that throws instead of rejecting fails the read the same way.
  const result = await Promise.resolve()
    .then(() => bridge.query('device.list', refresh ? { refresh: 'true' } : {}))
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return { state: 'failed', text: failureText(result.error) };
  const value = result.value as Partial<DeviceListItem>[] | null;
  if (
    !Array.isArray(value) ||
    !value.every(
      (d) =>
        typeof d?.id === 'string' &&
        typeof d.name === 'string' &&
        typeof d.online === 'boolean' &&
        Array.isArray(d.load?.active_sessions),
    )
  )
    return {
      state: 'failed',
      text: failureText({ code: 'bad_response', message: 'device.list result is incomplete' }),
    };
  return { state: 'ready', devices: value as DeviceListItem[] };
}

/** The events that add or remove a device, end a probe of one, or change the open sessions on one. */
const DEVICE_CHANGES: ReadonlySet<string> = new Set([
  'device.saved',
  'device.removed',
  'device.probed',
  'session.opened',
  'session.renamed',
  'session.merged',
  'session.discarded',
  'session.closed',
  'session.deleted',
]);

/** The sequence of the newest event that changes the device list, 0 without one. */
function newestDeviceChange(events: readonly DaemonEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--)
    if (DEVICE_CHANGES.has(events[i]!.kind)) return events[i]!.sequence;
  return 0;
}

/**
 * The plain read in flight and the device change and resync it was sent after; a reader on the same
 * ones takes its answer instead of sending its own.
 */
let plainOut: { after: string; read: Promise<DevicesRead> } | null = null;
let readers = 0;

/** Milliseconds before a failed read is sent again, as when the daemon was still starting. */
const RETRY_MS = 5_000;

/**
 * GET /v1/device.list on mount, after each device change or resync, and again a while after a failed
 * read; reload settles once its read has landed.
 */
export function useDevices() {
  const [read, setRead] = useState<DevicesRead>({ state: 'loading' });
  const changed = useBoard((s) => newestDeviceChange(s.events));
  const resync = useBoard((s) => s.resync);
  // Only the latest read lands; an earlier one answered late is dropped.
  const latest = useRef(0);
  const take = useCallback(async (refresh: boolean, after: string | null) => {
    const at = ++latest.current;
    let reading = after !== null && plainOut?.after === after ? plainOut.read : null;
    if (!reading) {
      const sent = readDevices(refresh);
      reading = sent;
      if (!refresh) {
        const out = { after: after ?? '', read: sent };
        plainOut = out;
        void sent.then(() => {
          if (plainOut === out) plainOut = null;
        });
      }
    }
    const next = await reading;
    if (at === latest.current) setRead(next);
  }, []);
  const reload = useCallback((refresh: boolean) => take(refresh, null), [take]);
  const [retries, setRetries] = useState(0);
  useEffect(() => {
    if (read.state !== 'failed') return;
    const timer = setTimeout(() => setRetries((count) => count + 1), RETRY_MS);
    return () => clearTimeout(timer);
  }, [read]);
  useEffect(() => {
    readers++;
    return () => {
      latest.current++;
      // A read no mounted reader waits for is joined by none.
      if (--readers === 0) plainOut = null;
    };
  }, []);
  useEffect(() => {
    void take(false, `${changed}:${resync}:${retries}`);
  }, [take, changed, resync, retries]);
  return { read, reload };
}
