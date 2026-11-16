import type { ReactElement } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { keyText } from '../lib/shortcuts';
import './tip.css';

interface TipProps {
  content: string;
  /** The shortcut, as the registry writes it (`Meta+N`), shown in a key cap after the text. */
  keys?: string;
  side?: 'top' | 'right';
  // A focusable DOM element; the tooltip opens on its hover and keyboard focus.
  children: ReactElement;
  disabled?: boolean;
}

export function Tip({ content, keys, side = 'top', children, disabled }: TipProps) {
  return (
    <Tooltip.Root disabled={disabled}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={8} style={{ zIndex: 60 }}>
          <Tooltip.Popup className="tooltip">
            {content}
            {keys && <span className="kbd">{keyText(keys)}</span>}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
