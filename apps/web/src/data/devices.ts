import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeResult, DeviceListItem } from '@pantheon/protocol';
import { failureText, reasonText } from './needs-you';

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

/** The plain read in flight; a mounting reader takes its answer instead of sending its own. */
let plainOut: Promise<DevicesRead> | null = null;
let readers = 0;

/** GET /v1/device.list on mount; reload settles once its read has landed. */
export function useDevices() {
  const [read, setRead] = useState<DevicesRead>({ state: 'loading' });
  // Only the latest read lands; an earlier one answered late is dropped.
  const latest = useRef(0);
  const take = useCallback(async (refresh: boolean, join: boolean) => {
    const at = ++latest.current;
    let reading = join ? plainOut : null;
    if (!reading) {
      const sent = readDevices(refresh);
      reading = sent;
      if (!refresh) {
        plainOut = sent;
        void sent.then(() => {
          if (plainOut === sent) plainOut = null;
        });
      }
    }
    const next = await reading;
    if (at === latest.current) setRead(next);
  }, []);
  const reload = useCallback((refresh: boolean) => take(refresh, false), [take]);
  useEffect(() => {
    readers++;
    void take(false, true);
    return () => {
      latest.current++;
      // A read no mounted reader waits for is joined by none.
      if (--readers === 0) plainOut = null;
    };
  }, [take]);
  return { read, reload };
}
