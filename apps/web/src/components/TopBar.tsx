import type { ReactNode } from 'react';

interface TopBarProps {
  // The page name.
  title: string;
  // A number shown muted after the name; countLabel says what it counts.
  count?: number;
  countLabel?: string;
  // The page's tabs, then its controls in a `.tb-end` container.
  children?: ReactNode;
}

export function TopBar({ title, count, countLabel, children }: TopBarProps) {
  return (
    <header className="tb">
      <h1>{title}</h1>
      {count !== undefined && (
        <span className="tb-ct" role={countLabel ? 'img' : undefined} aria-label={countLabel}>
          {count}
        </span>
      )}
      {children}
    </header>
  );
}
