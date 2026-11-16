/** Glyphs from empty to dense. */
export const RAMP = ' .:-=+*#%@';

/** Below this, summed over the last two frames, a ripple no longer shows and the loop may stop. */
export const STILL_ENERGY = 0.01;

/** A rectangle in canvas pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The Pantheon in Rome from the front on a `cols` by `rows` glyph grid, each cell 0 (empty) to 1 (dense).
 * `porch`: the rows above the bottom edge for the portico up to its pediment's apex; the dome may rise above them.
 */
export function templeDensity(cols: number, rows: number, porch = rows): Float32Array {
  const d = new Float32Array(cols * rows);
  // Metres of the building: 58 wide at the drum, 43 high at the dome's crown.
  const W = 58;
  const H = 43;
  // Columns per metre; a glyph cell is about twice as tall as wide, so a metre is s / 2 rows.
  const s = Math.min((cols * 0.86) / W, (2 * Math.floor(rows * 0.9)) / H, (2 * porch) / 24);
  const mid = cols / 2;
  const colOf = (m: number) => mid + m * s;
  const rowOf = (m: number) => rows - 1 - (m * s) / 2;
  /** Paints cells whose centres lie in x0..x1, y0..y1 (metres), front shapes over back ones. */
  const fill = (
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    v: (x: number, y: number) => number,
  ) => {
    const top = Math.max(0, Math.ceil(rowOf(y1) - 0.5));
    const bottom = Math.min(rows - 1, Math.floor(rowOf(y0) + 0.5));
    for (let r = top; r <= bottom; r++) {
      const ym = ((rows - 1 - r) * 2) / s;
      const left = Math.max(0, Math.ceil(colOf(x0) - 0.5));
      for (let c = left; c < cols && c + 0.5 <= colOf(x1); c++) {
        const xm = (c + 0.5 - mid) / s;
        const value = v(xm, ym);
        if (value >= 0) d[r * cols + c] = value;
      }
    }
  };
  const flat = (v: number) => () => v;

  // The drum, with cornices at its storeys, and the dome rising in seven step rings, then smooth.
  fill(-29, 29, 0, 30, (_x, ym) => ([12, 21, 30].some((y) => Math.abs(ym - y) < 0.8) ? 0.5 : 0.16));
  for (let k = 0; k < 7; k++) {
    const r = 29 - k * 0.7;
    fill(-r, r, 30 + k * 0.6, 30 + (k + 1) * 0.6, flat(k % 2 ? 0.3 : 0.42));
  }
  const domeR = 24;
  const domeBase = 34.2;
  fill(-domeR, domeR, domeBase, H, (x, ym) => {
    const e = (x / domeR) ** 2 + ((ym - domeBase) / (H - domeBase)) ** 2;
    if (e > 1) return -1;
    // Lit from the upper left, brighter towards its edge.
    return 0.18 + 0.2 * Math.sqrt(e) + (x < 0 ? 0.06 : 0);
  });

  // The intermediate block between portico and drum, with its own faint pediment.
  fill(-17.5, 17.5, 17, 26, flat(0.26));
  fill(-17.5, 17.5, 26, 31, (x, ym) => {
    const roof = 26 + 5 * (1 - Math.abs(x) / 17.5);
    if (ym > roof) return -1;
    return roof - ym < 0.8 ? 0.55 : 0.2;
  });

  // The portico: steps, the shadowed porch, eight columns.
  for (let k = 0; k < 3; k++)
    fill(-17.5 - (2 - k) * 0.6, 17.5 + (2 - k) * 0.6, k * 0.5, (k + 1) * 0.5, flat(0.7 + k * 0.05));
  fill(-16.5, 16.5, 1.5, 14.5, flat(0.06));
  const pitch = 33 / 8;
  for (let k = 0; k < 8; k++) {
    const c = -16.5 + pitch * (k + 0.5);
    // The shaft, 1.5 m across, narrows by a sixth towards the capital and is fluted.
    fill(c - 0.9, c + 0.9, 1.5, 12.8, (x, ym) => {
      const half = 0.75 * (1 - ((ym - 1.5) / 11.3) * 0.15);
      const off = Math.abs(x - c);
      if (off > half) return -1;
      const fluted = Math.round((x - c) * s) % 2 === 0 ? 1 : 0.82;
      return (0.5 + 0.45 * Math.cos((Math.PI * off) / (2 * half))) * fluted;
    });
    fill(c - 1.05, c + 1.05, 1.5, 2.1, flat(0.8));
    // The Corinthian capital: wider at the abacus, in leaf rows.
    fill(c - 1.15, c + 1.15, 12.8, 14.5, (x, ym) => {
      const flare = 0.8 + ((ym - 12.8) / 1.7) * 0.35;
      if (Math.abs(x - c) > flare) return -1;
      return Math.round((x - c) * s + ym * 3) % 2 === 0 ? 0.95 : 0.6;
    });
  }

  // The entablature: three fasciae, the inscribed frieze, dentils under the cornice.
  fill(-17, 17, 14.5, 15.7, (_x, ym) => (Math.round((ym - 14.5) * 2.5) % 2 ? 0.62 : 0.78));
  fill(-17, 17, 15.7, 16.9, (x) => {
    // M·AGRIPPA·L·F·COS·TERTIVM·FECIT across the middle, as a beat of letters and stops.
    if (Math.abs(x) > 12) return 0.5;
    const beat = Math.floor((x + 12) * s * 0.9);
    return beat % 7 === 3 ? 0.35 : beat % 2 ? 0.92 : 0.75;
  });
  fill(-17.4, 17.4, 16.9, 17.4, (x) => (Math.round((x + 17.4) * s) % 2 ? 0.85 : 0.35));
  fill(-17.8, 17.8, 17.4, 17.9, flat(0.92));

  // The pediment, its raking cornices dense over a light tympanum.
  const apex = 24;
  fill(-17.8, 17.8, 17.9, apex, (x, ym) => {
    const roof = 17.9 + (apex - 17.9) * (1 - Math.abs(x) / 17.8);
    if (ym > roof) return -1;
    return roof - ym < 0.9 ? 0.9 : 0.14;
  });
  return d;
}

/**
 * One step of the damped wave equation on the grid, `cx` and `cy` the horizontal and vertical coupling
 * (stable while cx + cy <= 1); cells outside the grid hold still.
 */
export function waveStep(
  prev: Float32Array,
  cur: Float32Array,
  cols: number,
  rows: number,
  cx: number,
  cy: number,
  damp: number,
): Float32Array {
  const next = new Float32Array(cur.length);
  const self = 2 - 2 * cx - 2 * cy;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const side = (x > 0 ? cur[i - 1]! : 0) + (x < cols - 1 ? cur[i + 1]! : 0);
      const upDown = (y > 0 ? cur[i - cols]! : 0) + (y < rows - 1 ? cur[i + cols]! : 0);
      next[i] = (self * cur[i]! + cx * side + cy * upDown - prev[i]!) * damp;
    }
  return next;
}

/** The sum of squared heights. */
export function energy(h: Float32Array): number {
  let sum = 0;
  for (const v of h) sum += v * v;
  return sum;
}

/**
 * Per cell, `floor` within `clear` pixels of a box, rising to 1 over the next `fade` pixels,
 * so glyphs under text and controls stay too faint to compete with them.
 */
export function quietMap(
  cols: number,
  rows: number,
  cellW: number,
  cellH: number,
  boxes: Box[],
  clear = 24,
  fade = 48,
  floor = 0,
): Float32Array {
  const calm = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const px = (x + 0.5) * cellW;
      const py = (y + 0.5) * cellH;
      let near = Infinity;
      for (const b of boxes) {
        const dx = Math.max(b.left - px, 0, px - b.right);
        const dy = Math.max(b.top - py, 0, py - b.bottom);
        near = Math.min(near, Math.hypot(dx, dy));
      }
      calm[y * cols + x] = floor + (1 - floor) * Math.min(1, Math.max(0, (near - clear) / fade));
    }
  return calm;
}
