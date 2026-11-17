import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@pantheon/protocol';
import { ipcFailure } from '../screens/settings/editors';
import { useBoard } from './board';
import { runCommand } from './commands';
import { failureText, reasonText } from './needs-you';

/** The settings a save sends: some delivery rules, and null quiet hours to clear them. */
export type AppSettingsPatch = Partial<Omit<AppSettings, 'attention_delivery' | 'quiet_hours'>> & {
  attention_delivery?: Partial<AppSettings['attention_delivery']>;
  quiet_hours?: AppSettings['quiet_hours'] | null;
};

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

  const save = async (patch: AppSettingsPatch) => {
    if (sending.current) return;
    sending.current = true;
    setSaving(true);
    const result = await runCommand('app.settings.set', patch, null);
    sending.current = false;
    setSaving(false);
    setError(result.ok ? null : failureText(result.error));
    // The daemon merges the delivery rules kind by kind, and null clears the quiet hours.
    const { attention_delivery, quiet_hours, ...rest } = patch;
    if (result.ok)
      setSettings(
        (now) =>
          now && {
            ...now,
            ...rest,
            attention_delivery: { ...now.attention_delivery, ...attention_delivery },
            quiet_hours: quiet_hours === undefined ? now.quiet_hours : (quiet_hours ?? undefined),
          },
      );
    else setFailedSaves((n) => n + 1);
  };

  return { settings, error, saving, save };
}
