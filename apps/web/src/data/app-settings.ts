import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@pantheon/protocol';
import { ipcFailure } from '../screens/settings/editors';
import { useBoard } from './board';
import { runCommand } from './commands';
import { failureText, reasonText } from './needs-you';

/**
 * The user's settings across projects, read again after a change from any window, a resync or a
 * failed save, and a write that sends only the fields given.
 */
export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sending = useRef(false);
  const changed = useBoard((s) => {
    for (let i = s.events.length - 1; i >= 0; i--)
      if (s.events[i]!.kind === 'app.settings_set') return s.events[i]!.sequence;
    return 0;
  });
  const resync = useBoard((s) => s.resync);
  const [failedSaves, setFailedSaves] = useState(0);

  useEffect(() => {
    const bridge = window.pantheon;
    if (!bridge) {
      setError(reasonText('bridge_unavailable'));
      return;
    }
    void bridge
      .query('app.settings')
      .catch(ipcFailure)
      .then((result) => {
        if (result.ok) setSettings(result.value as AppSettings);
        else setError(failureText(result.error));
      });
  }, [changed, resync, failedSaves]);

  const save = async (patch: Partial<AppSettings>) => {
    if (sending.current) return;
    sending.current = true;
    setSaving(true);
    const result = await runCommand('app.settings.set', patch, null);
    sending.current = false;
    setSaving(false);
    setError(result.ok ? null : failureText(result.error));
    if (result.ok) setSettings((now) => now && { ...now, ...patch });
    else setFailedSaves((n) => n + 1);
  };

  return { settings, error, saving, save };
}
