import type { NeedsYouItem } from '../data/needs-you';
import { t } from '../i18n';
import { NeedsPopover } from './NeedsPopover';
import './title-bar-end.css';

interface TitleBarEndProps {
  /** What waits for the user across the projects. */
  needs: readonly NeedsYouItem[];
}

/** The global controls at the right end of the window's title bar: what waits for the user. */
export function TitleBarEnd({ needs }: TitleBarEndProps) {
  return (
    <div className="tbe">
      {needs.length > 0 && (
        <NeedsPopover
          items={needs}
          trigger={
            <button
              type="button"
              className="sb-wait tbe-wait"
              aria-label={t(
                {
                  id: 'components.titleBarEnd.needs',
                  defaultMessage:
                    '{count, plural, one {# thing waits for you} other {# things wait for you}}',
                },
                { count: needs.length },
              )}
            >
              {needs.length}
            </button>
          }
        />
      )}
    </div>
  );
}
