import { useEffect } from 'react';
import { noticeResult } from '../components/Toast';
import { t } from '../i18n';
import { openLogs } from './RecoverScreen';

/** Tells that the window reloaded after its renderer crashed; the bridge hands each crash out once. */
export function CrashNotice(): null {
  useEffect(() => {
    void window.pantheon
      ?.lastCrash()
      .then((crash) => {
        if (!crash) return;
        noticeResult({
          tone: 'failed',
          heading: t({
            id: 'shell.crashNotice.title',
            defaultMessage: 'The interface crashed and was reloaded',
          }),
          summary: crash.reason,
          actions: [
            { label: t({ id: 'recover.logs', defaultMessage: 'Open logs' }), run: openLogs },
          ],
        });
      })
      .catch(() => {});
  }, []);
  return null;
}
