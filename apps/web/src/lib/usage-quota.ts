import type { QuotaWindow } from '@pantheon/domain';
import { t } from '../i18n';

export const RING_RUNTIMES = ['claude', 'codex'] as const;

/* Subscription quota */

export const quotaWindowName = (window: string) => {
  if (window === 'five_hour')
    return t({ id: 'settings.harness.quota.fiveHour', defaultMessage: '5 hours' });
  if (window === 'seven_day')
    return t({ id: 'settings.harness.quota.sevenDay', defaultMessage: '7 days' });
  return window;
};

/** The used share kept within 0 to 100, for the bar. */
export const quotaUsed = (w: QuotaWindow) => Math.min(Math.max(w.used_percent, 0), 100);

/** The window's name and, while it is ahead, how long until it resets. */
export function quotaWindowText(w: QuotaWindow, now: number): string {
  const minutes = w.resets_at === undefined ? 0 : Math.ceil((w.resets_at - now) / 60_000);
  return minutes > 0
    ? t(
        {
          id: 'insights.quota.resets',
          defaultMessage:
            '{window} window, resets in {hours, plural, =0 {} other {# h }}{minutes} min',
        },
        {
          window: quotaWindowName(w.window),
          hours: Math.floor(minutes / 60),
          minutes: minutes % 60,
        },
      )
    : t(
        { id: 'insights.quota.window', defaultMessage: '{window} window' },
        { window: quotaWindowName(w.window) },
      );
}

/* Usage targets */

export type UsageTargets = Partial<Record<string, number>>;

/** A typed target: null when empty, undefined when not a whole positive number. */
export function parseUsageTarget(text: string): number | null | undefined {
  const value = text.trim();
  if (!value) return null;
  const target = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(target) && target > 0 ? target : undefined;
}
