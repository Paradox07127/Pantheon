import { getLook } from '../data/layout';

/** Whether motion is reduced right now, by the Appearance choice or else the system; asked on every call, so it follows a change mid-run. */
export function reducedMotion(): boolean {
  const { motion } = getLook();
  if (motion !== 'system') return motion === 'reduced';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
