/** Share of the axis a cut idle stretch keeps. */
export const BREAK_SHARE = 0.04;

/** The axis with idle stretches over `gapMs` between the busy intervals cut to a break mark. */
export function timeAxis(busy: [number, number][], from: number, to: number, gapMs: number) {
  const total = Math.max(1, to - from);
  const merged: [number, number][] = [];
  for (const [a, b] of [...busy].sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const cuts: [number, number][] = [];
  for (let i = 1; i < merged.length; i++) {
    const [a, b] = [merged[i - 1]![1], merged[i]![0]];
    if (b - a > gapMs && (b - a) / total > BREAK_SHARE) cuts.push([a, b]);
  }
  // Cuts over the whole range leave nothing busy to spread out, so the axis stays linear.
  if (cuts.reduce((sum, [a, b]) => sum + b - a, 0) >= total) cuts.length = 0;
  const kept = Math.max(1, total - cuts.reduce((sum, [a, b]) => sum + b - a, 0));
  const unit = (1 - cuts.length * BREAK_SHARE) / kept;
  const position = (t: number) => {
    let x = 0;
    let prev = from;
    for (const [a, b] of cuts) {
      if (t <= a) break;
      if (t < b) return x + (a - prev) * unit + ((t - a) / (b - a)) * BREAK_SHARE;
      x += (a - prev) * unit + BREAK_SHARE;
      prev = b;
    }
    return x + (t - prev) * unit;
  };
  /** The time at a share of the axis; inside a break mark, linear over the stretch it cuts. */
  const time = (x: number) => {
    let start = 0;
    let prev = from;
    for (const [a, b] of cuts) {
      const mark = start + (a - prev) * unit;
      if (x <= mark) break;
      if (x < mark + BREAK_SHARE) return a + ((x - mark) / BREAK_SHARE) * (b - a);
      start = mark + BREAK_SHARE;
      prev = b;
    }
    return prev + (x - start) / unit;
  };
  return { position, time, unit, breaks: cuts.map(([a, b]) => ({ at: position(a), ms: b - a })) };
}
