import type { CSSProperties } from 'react';
import { useDelayed } from '../lib/use-delayed';
import './skeleton.css';

/** A block in the shape of the content being loaded; it keeps its place but shows only once loading lasts. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  const shown = useDelayed(true);
  return (
    <span
      className={className ? `skel ${className}` : 'skel'}
      style={style}
      data-shown={shown || undefined}
      aria-hidden="true"
    />
  );
}
