import { afterEach, expect, it, vi } from 'vitest';
import { reducedMotion } from '@/lib/motion';

afterEach(() => vi.unstubAllGlobals());

it('follows the reduced-motion preference as it changes', () => {
  let reduce = false;
  const queries: string[] = [];
  vi.stubGlobal('window', {
    matchMedia: (query: string) => {
      queries.push(query);
      return { matches: reduce };
    },
  });
  expect(reducedMotion()).toBe(false);
  reduce = true;
  expect(reducedMotion()).toBe(true);
  reduce = false;
  expect(reducedMotion()).toBe(false);
  expect(new Set(queries)).toEqual(new Set(['(prefers-reduced-motion: reduce)']));
});
