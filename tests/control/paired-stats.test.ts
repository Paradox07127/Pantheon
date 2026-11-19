import { expect, it } from 'vitest';
import { costChange } from '../../packages/control/dist/paired-stats.js';

const { costChange: evalCostChange } = await import(
  new URL('../eval/lib/paired-stats.mjs', import.meta.url).href
);

const rule = { confidence: 0.95, bootstrap: { resamples: 2000, seed: 1 } };

it('gives the same change and interval as the eval report for the same pairs and seed', () => {
  const pairs = Array.from({ length: 12 }, (_, index) => ({
    task: `task-${index % 9}`,
    first: 1000 + index * 37,
    second: 600 + ((index * 53) % 400),
  }));
  expect(costChange(pairs, rule)).toEqual(evalCostChange(pairs, rule));
});

it('holds no change in the interval when every pair costs the same on both sides', () => {
  const pairs = Array.from({ length: 10 }, (_, index) => ({
    task: `task-${index}`,
    first: 1000,
    second: 1000,
  }));
  expect(costChange(pairs, rule)).toEqual({ pairs: 10, tasks: 10, change: 0, interval: [0, 0] });
});

it('gives no change and no interval without pairs', () => {
  expect(costChange([], rule)).toEqual({ pairs: 0, tasks: 0, change: null, interval: null });
});
