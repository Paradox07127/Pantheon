import { useEffect, useState } from 'react';
import { sizeText } from '../../data/worktree-setup';
import { t } from '../../i18n';

/** Counts up when the theme class on the root element changes, so colours are read again. */
export function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const watch = new MutationObserver(() => setTick((n) => n + 1));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => watch.disconnect();
  }, []);
  return tick;
}

/** The current value of an app token, or of a property such as font-family, at `at`. */
export const token = (at: Element, name: string): string =>
  getComputedStyle(at).getPropertyValue(name).trim();

/**
 * Runs `draw` after mount and whenever `deps` change; true once it resolved. What `draw` resolves
 * to is called on unmount or before the next draw. A failure is thrown to the card's boundary.
 */
export function useDraw(
  draw: (live: () => boolean) => Promise<(() => void) | undefined>,
  deps: readonly unknown[],
): boolean {
  const [state, setState] = useState<{ ready: boolean; error: unknown }>({
    ready: false,
    error: null,
  });
  useEffect(() => {
    let live = true;
    let release: (() => void) | undefined;
    setState((s) => (s.ready || s.error ? { ready: false, error: null } : s));
    draw(() => live).then(
      (done) => {
        if (!live) return done?.();
        release = done;
        setState({ ready: true, error: null });
      },
      (error: unknown) => {
        if (live) setState({ ready: false, error: error ?? new Error(String(error)) });
      },
    );
    return () => {
      live = false;
      release?.();
    };
  }, deps);
  if (state.error)
    throw state.error instanceof Error ? state.error : new Error(String(state.error));
  return state.ready;
}

/**
 * The placeholder while a library loads or a picture draws; it names the wait after a second, or
 * says at once how much of the spec has arrived.
 */
export function Drawing({ received }: { received?: number } = {}) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), 1000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="vis-skel">
      {(late || received !== undefined) && (
        <span className="vis-drawing" role="status">
          {received === undefined
            ? t({ id: 'visual.card.drawing', defaultMessage: 'Drawing' })
            : t(
                { id: 'visual.card.received', defaultMessage: 'Received {size}' },
                { size: sizeText(received) },
              )}
        </span>
      )}
    </div>
  );
}
