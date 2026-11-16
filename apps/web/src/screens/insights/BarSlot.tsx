import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A tab's controls, drawn in its place in the top bar; nothing until that place is in. */
export function BarSlot({ bar, children }: { bar?: HTMLElement | null; children: ReactNode }) {
  return bar ? createPortal(children, bar) : null;
}
