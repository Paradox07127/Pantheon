import { describe, expect, it } from 'vitest';
import { BREAK_SHARE, timeAxis } from '@/lib/time-axis';

const MIN = 60_000;

describe('timeAxis', () => {
  it('maps a position back to its time when nothing is cut', () => {
    const axis = timeAxis([[0, 10 * MIN]], 0, 10 * MIN, MIN);
    expect(axis.breaks).toEqual([]);
    for (const t of [0, 1, 37_000, 5 * MIN, 10 * MIN]) expect(axis.time(axis.position(t))).toBe(t);
  });

  it('keeps the axis linear when the idle stretches cover the whole range', () => {
    const axis = timeAxis(
      [
        [0, 0],
        [30 * MIN, 30 * MIN],
      ],
      0,
      30 * MIN,
      0,
    );
    expect(axis.breaks).toEqual([]);
    expect(axis.position(15 * MIN)).toBeCloseTo(0.5, 9);
    expect(axis.position(30 * MIN)).toBeCloseTo(1, 9);
  });

  it('inverts the axis on both sides of a break and inside it', () => {
    const busy: [number, number][] = [
      [0, 10 * MIN],
      [60 * MIN, 70 * MIN],
      [200 * MIN, 210 * MIN],
    ];
    const axis = timeAxis(busy, 0, 210 * MIN, MIN);
    expect(axis.breaks).toHaveLength(2);
    for (const t of [0, 3 * MIN, 10 * MIN, 60 * MIN, 65 * MIN, 70 * MIN, 205 * MIN, 210 * MIN])
      expect(Math.abs(axis.time(axis.position(t)) - t)).toBeLessThanOrEqual(1);
    for (const gap of axis.breaks)
      for (const part of [0.1, 0.5, 0.9]) {
        const x = gap.at + part * BREAK_SHARE;
        expect(Math.abs(axis.position(axis.time(x)) - x)).toBeLessThanOrEqual(1e-9);
      }
  });
});
