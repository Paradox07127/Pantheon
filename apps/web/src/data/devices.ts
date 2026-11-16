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
        typeof d.load?.sessions === 'number',
    )
  )
    return {
      state: 'failed',
      text: failureText({ code: 'bad_response', message: 'device.list result is incomplete' }),
    };
  return { state: 'ready', devices: value as DeviceListItem[] };
}

/** GET /v1/device.list on mount; reload settles once its read has landed. */
export function useDevices() {
  const [read, setRead] = useState<DevicesRead>({ state: 'loading' });
  // Only the latest read lands; an earlier one answered late is dropped.
  const latest = useRef(0);
  const reload = useCallback(async (refresh: boolean) => {
    const at = ++latest.current;
    const next = await readDevices(refresh);
    if (at === latest.current) setRead(next);
  }, []);
  useEffect(() => {
    void reload(false);
    return () => {
      latest.current++;
    };
  }, [reload]);
  return { read, reload };
}
