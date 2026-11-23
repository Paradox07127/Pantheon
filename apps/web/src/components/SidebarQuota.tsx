import type { CSSProperties } from 'react';
import { useNow } from '../data/needs-you';
import { useRuntimeStatus } from '../data/runtime-status';
import { t } from '../i18n';
import { quotaUsed, quotaWindowText, runtimeQuotas } from '../lib/usage-quota';
import { RuntimeGlyph, runtimeName } from './RuntimeGlyph';
import { Tip } from './Tip';
import './sidebar-quota.css';

const level = (percent: number) => (percent >= 95 ? 'out' : percent >= 80 ? 'high' : undefined);

/** Each runtime's subscription quota: its most used window as a bar and when it resets. */
export function SidebarQuota({ rail = false }: { rail?: boolean }) {
  const { read } = useRuntimeStatus();
  const now = useNow(30_000);
  const quotas = read.state === 'ready' ? runtimeQuotas(read.statuses) : [];
  if (!quotas.length) return null;
  return (
    <div
      className={rail ? 'sb-q-rail' : 'sb-q'}
      role="group"
      aria-label={t({ id: 'components.sidebarQuota.label', defaultMessage: 'Subscription quota' })}
    >
      {quotas.map(({ runtime, percent, top, windows }) => {
        const reset = quotaWindowText(top, now);
        const name = t(
          {
            id: 'components.sidebarQuota.runtime',
            defaultMessage: '{runtime}: {percent}% used, {reset}',
          },
          { runtime: runtimeName(runtime), percent, reset },
        );
        const tip = [
          runtimeName(runtime),
          ...windows.map((w) =>
            t(
              { id: 'components.sidebarQuota.window', defaultMessage: '{percent}% used, {window}' },
              { percent: Math.round(quotaUsed(w)), window: quotaWindowText(w, now) },
            ),
          ),
        ].join('\n');
        return rail ? (
          <Tip key={runtime} content={tip} side="right">
            <span
              className="sb-q-ring"
              role="img"
              aria-label={name}
              tabIndex={0}
              data-level={level(percent)}
            >
              <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden="true">
                <circle cx="16" cy="16" r="13" pathLength={100} />
                <circle
                  cx="16"
                  cy="16"
                  r="13"
                  pathLength={100}
                  strokeDasharray={`${quotaUsed(top)} 100`}
                  transform="rotate(-90 16 16)"
                />
              </svg>
            </span>
          </Tip>
        ) : (
          <Tip key={runtime} content={tip} side="right">
            <div
              className="sb-q-row"
              role="meter"
              aria-label={name}
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              data-level={level(percent)}
            >
              <RuntimeGlyph runtime={runtime} size={14} />
              <span
                className="sb-q-bar"
                aria-hidden="true"
                style={{ '--v': `${quotaUsed(top)}%` } as CSSProperties}
              >
                <i />
              </span>
              <span className="sb-q-pct">{`${percent}%`}</span>
              <span className="sb-q-reset">{reset}</span>
            </div>
          </Tip>
        );
      })}
    </div>
  );
}
