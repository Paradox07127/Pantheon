const holders = new Map<string, number>();

/** Sets `data-<name>` on the document's root; it stays until every holder has released it. */
export function holdRootFlag(name: string): () => void {
  const root = document.documentElement;
  holders.set(name, (holders.get(name) ?? 0) + 1);
  root.setAttribute(`data-${name}`, '');
  return () => {
    const left = holders.get(name)! - 1;
    holders.set(name, left);
    if (left === 0) root.removeAttribute(`data-${name}`);
  };
}

/** The ref of a modal dialog's scrim: the root carries `data-scrim-open` while the scrim is open. */
export function scrimFlag(scrim: HTMLElement | null) {
  // React detaches through the returned cleanup and never passes null here.
  if (!scrim) return;
  let release: (() => void) | null = null;
  const sync = () => {
    const open = scrim.hasAttribute('data-open');
    if (open && !release) release = holdRootFlag('scrim-open');
    if (!open && release) {
      release();
      release = null;
    }
  };
  sync();
  // Base UI drops data-open as the close begins, while the scrim stays mounted until it has faded.
  const observer = new MutationObserver(sync);
  observer.observe(scrim, { attributeFilter: ['data-open'] });
  return () => {
    observer.disconnect();
    release?.();
  };
}
