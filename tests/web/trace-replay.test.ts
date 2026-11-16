import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
import { timeAxis } from '@/lib/time-axis';
import { useTraceReplay } from '@/screens/trace/Replay';
import { mount, unmountAll } from './web-hook-host.js';

const SECOND = 1000;

/** A host element that keeps the custom properties the replay writes. */
const hostElement = () => {
  const props = new Map<string, string>();
  return {
    props,
    current: {
      style: {
        setProperty: (name: string, value: string) => props.set(name, value),
        removeProperty: (name: string) => props.delete(name),
      },
      setAttribute() {},
      removeAttribute() {},
    } as unknown as HTMLElement,
  };
};

describe('the replay playhead', () => {
  beforeEach(() => vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} }));
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  it('keeps a paused time when a refresh lengthens the axis', () => {
    const host = hostElement();
    let full = { from: 0, to: 60 * SECOND };
    const h = mount(() =>
      useTraceReplay(timeAxis([], full.from, full.to, 60 * SECOND), full, full, host, 1, []),
    );
    h.value.seek(500);
    h.render();
    expect(h.value.share).toBeCloseTo(0.5);

    full = { from: 0, to: 120 * SECOND };
    h.render();
    expect(h.value.share).toBeCloseTo(0.25);
    expect(Number(host.props.get('--ph'))).toBeCloseTo(0.25);
    expect(Number(host.props.get('--ph-strip'))).toBeCloseTo(0.25);
  });

  it('keeps the strip playhead a number over a window without length', () => {
    const host = hostElement();
    const full = { from: 60 * SECOND, to: 60 * SECOND };
    const h = mount(() =>
      useTraceReplay(timeAxis([], full.from, full.to, 60 * SECOND), full, full, host, 1, []),
    );
    h.value.seek(0);
    h.render();
    expect(Number.isFinite(Number(host.props.get('--ph-strip')))).toBe(true);
  });
});
