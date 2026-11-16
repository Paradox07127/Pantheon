import { describe, expect, it } from 'vitest';
import { flowZoom } from '@/screens/board/flow-layout';

describe('flow chart zoom', () => {
  it('never zooms the flow chart below 11 px card text, and pans instead', () => {
    // The smallest card text is 12 px at 1:1.
    expect(flowZoom(300, 1200) * 12).toBeGreaterThanOrEqual(11);
    expect(flowZoom(1140, 1200)).toBeCloseTo(0.95);
    expect(flowZoom(2000, 1200)).toBe(1);
  });
});
