import { useSyncExternalStore } from 'react';

/** The root's --sf and --tx, which the top bar shows, and its --bg, each as #rrggbb. */
export function windowColours(doc: Document = document): {
  color: string;
  symbolColor: string;
  background: string;
} {
  const style = getComputedStyle(doc.documentElement);
  // One canvas pixel turns any colour notation a theme writes into sRGB bytes.
  const context = doc.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const hex = (token: string): string => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = style.getPropertyValue(token).trim();
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return '#' + [r!, g!, b!].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  return { color: hex('--sf'), symbolColor: hex('--tx'), background: hex('--bg') };
}

const REDUCED = '(prefers-reduced-motion: reduce)';
const reducedNow = () => window.matchMedia(REDUCED).matches;
const subscribeReduced = (listener: () => void) => {
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};

/** Whether the system asks for reduced motion, following a change. */
export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, reducedNow, () => false);
}
