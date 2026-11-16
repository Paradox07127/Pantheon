import type { CSSProperties } from 'react';
import { projectColor } from './Sidebar';

/** The project's first letter on its colour. */
export function ProjectMonogram({ id, name }: { id: string; name: string }) {
  return (
    <span className="pmono" aria-hidden style={{ '--pmono': projectColor(id) } as CSSProperties}>
      {([...name.trim()][0] ?? '').toUpperCase()}
    </span>
  );
}
