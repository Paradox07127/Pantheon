import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { energy, STILL_ENERGY, templeDensity, waveStep } from '@/lib/pantheon-field';
import { PantheonField } from '@/components/PantheonField';

const COLS = 160;
const ROWS = 60;

// Runs of cells at or above `floor` along one row, as [start, end) pairs.
function runs(row: Float32Array, floor: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  row.forEach((v, x) => {
    if (v >= floor && start < 0) start = x;
    if (v < floor && start >= 0) {
      out.push([start, x]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, row.length]);
  return out;
}

describe('glyph temple', () => {
  const density = templeDensity(COLS, ROWS);
  const row = (y: number) => density.subarray(y * COLS, (y + 1) * COLS);

  it('leaves the sky above the temple empty', () => {
    expect(row(0).every((v) => v === 0)).toBe(true);
  });

  it('stands eight dense columns with shadowed gaps between them', () => {
    const colonnade = Array.from({ length: ROWS }, (_, y) => y).filter(
      (y) => runs(row(y), 0.5).length === 8,
    );
    expect(colonnade.length).toBeGreaterThan(5);
    const middle = row(colonnade[Math.floor(colonnade.length / 2)]!);
    const shafts = runs(middle, 0.5);
    for (const [start, end] of shafts)
      expect(Math.max(...middle.subarray(start, end))).toBeGreaterThan(0.9);
    for (let k = 1; k < shafts.length; k++)
      expect(Math.min(...middle.subarray(shafts[k - 1]![1], shafts[k]![0]))).toBeLessThan(0.2);
  });

  it('raises a dome behind the portico, its drum wider than the pediment', () => {
    const crown = Array.from({ length: ROWS }, (_, y) => y).find((y) =>
      row(y).some((v) => v > 0.05),
    )!;
    const cornice = Array.from({ length: ROWS }, (_, y) => y).find((y) =>
      row(y).some((v) => v >= 0.85),
    )!;
    expect(crown).toBeGreaterThan(0);
    expect(crown).toBeLessThan(cornice);
    const drum = runs(row(ROWS - 4), 0.05);
    expect(drum[0]![1] - drum[0]![0]).toBeGreaterThan(COLS * 0.6);
  });

  it('rests on a floor that spans the bottom row', () => {
    expect(runs(row(ROWS - 1), 0.5)).toHaveLength(1);
  });
});

describe('ripple', () => {
  it('dies down by itself once nothing stirs it, so the loop can stop', () => {
    let prev: Float32Array = new Float32Array(COLS * ROWS);
    let cur: Float32Array = new Float32Array(COLS * ROWS);
    cur[30 * COLS + 80] = -4;
    const peaks: number[] = [];
    let still = -1;
    for (let k = 0; k < 600; k++) {
      const next = waveStep(prev, cur, COLS, ROWS, 0.5, 0.125, 0.94);
      prev = cur;
      cur = next;
      const e = energy(prev) + energy(cur);
      if (k % 30 === 0) peaks.push(0);
      peaks[peaks.length - 1] = Math.max(peaks.at(-1)!, e);
      if (e < STILL_ENERGY && still < 0) still = k;
      if (still >= 0) expect(e).toBeLessThan(STILL_ENERGY);
    }
    expect(still).toBeGreaterThan(0);
    expect(still).toBeLessThan(300);
    for (let k = 1; k < peaks.length; k++) expect(peaks[k]).toBeLessThan(peaks[k - 1]!);
  });
});

describe('field element', () => {
  it('is a canvas hidden from assistive technology', () => {
    const html = renderToStaticMarkup(createElement(PantheonField));
    expect(html).toMatch(/^<canvas\b[^>]*\baria-hidden="true"[^>]*><\/canvas>$/);
  });
});
