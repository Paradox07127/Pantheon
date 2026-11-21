import { useState } from 'react';

/**
 * Props for a Dialog.Root that stays mounted: `show` opens it with content, and the content stays
 * until the exit transition ends, so the popup animates out instead of vanishing.
 */
export function useDialogContent<T>() {
  const [content, setContent] = useState<T | null>(null);
  const [open, setOpen] = useState(false);
  return {
    content,
    show: (next: T) => {
      setContent(next);
      setOpen(true);
    },
    close: () => setOpen(false),
    root: {
      open,
      onOpenChange: (next: boolean) => {
        if (!next) setOpen(false);
      },
      onOpenChangeComplete: (next: boolean) => {
        if (!next) setContent(null);
      },
    },
  };
}
