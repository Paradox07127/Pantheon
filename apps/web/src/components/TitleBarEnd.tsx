import { useEffect, useLayoutEffect, useState } from 'react';
import { SquareDashedMousePointer } from 'lucide-react';
import { debugTarget } from '../data/app-errors';
import type { NeedsYouItem } from '../data/needs-you';
import { t } from '../i18n';
import { holdRootFlag } from '../lib/root-flag';
import { toggleDebugView, useDebugView } from './DebugView';
import { NeedsPopover } from './NeedsPopover';
import './title-bar-end.css';

interface TitleBarEndProps {
  /** What waits for the user across the projects. */
  needs: readonly NeedsYouItem[];
}

/**
 * The global controls at the right end of the window's title bar: in a dev build the debug view's
 * toggle, then what waits for the user.
 */
export function TitleBarEnd({ needs }: TitleBarEndProps) {
  const debugging = useDebugView((s) => s.open);
  const [dev, setDev] = useState(false);
  useEffect(() => void debugTarget().then((target) => setDev(target !== null)), []);
  const waits = needs.length > 0;
  // The page bars in the title bar end where these controls begin (title-bar-end.css).
  useLayoutEffect(() => (waits ? holdRootFlag('title-needs') : undefined), [waits]);
  useLayoutEffect(() => (dev ? holdRootFlag('title-debug') : undefined), [dev]);
  return (
    <div className="tbe">
      {dev && (
        <button
          type="button"
          className="ib tbe-dbg"
          aria-label={t({ id: 'components.debugView.title', defaultMessage: 'Debug view' })}
          aria-pressed={debugging}
          onClick={toggleDebugView}
        >
          <SquareDashedMousePointer aria-hidden="true" />
        </button>
      )}
      {needs.length > 0 && (
        <NeedsPopover
          items={needs}
          titleBar
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
