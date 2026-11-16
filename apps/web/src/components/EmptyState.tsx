import type { ReactNode } from 'react';
import { keyText } from '../lib/shortcuts';
import './empty-state.css';

interface EmptyAction {
  icon?: ReactNode;
  label: string;
  /** In aria-keyshortcuts notation, such as `Meta+N`. */
  keys?: string;
  onClick: () => void;
}

type EmptyStateProps =
  | {
      inline?: false;
      /** A 20px status glyph or icon. */
      graphic: ReactNode;
      title: string;
      note?: string;
      action?: EmptyAction;
    }
  /** One line of text in a panel, table or list that has nothing to show. */
  | { inline: true; title: string };

export function EmptyState(props: EmptyStateProps) {
  if (props.inline) return <div className="es-in">{props.title}</div>;
  const { graphic, title, note, action } = props;
  return (
    <div className="es">
      <span className="es-g">{graphic}</span>
      <span className="es-t">{title}</span>
      {note && <span className="es-n">{note}</span>}
      {action && (
        <button
          type="button"
          className="btn"
          aria-keyshortcuts={action.keys}
          onClick={action.onClick}
        >
          {action.icon}
          {action.label}
          {action.keys && (
            <span className="kbd" aria-hidden="true">
              {keyText(action.keys)}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
