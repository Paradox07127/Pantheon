import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ProjectTrace, TraceStats } from '@pantheon/protocol';
import { type HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ trace: null as unknown }));
vi.mock('@/data/commands', () => ({ runCommand: vi.fn() }));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => ({ data: null, loading: false, error: null, reload() {} }),
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/trace', async (actual) => ({
  ...(await actual<object>()),
  useProjectTimeline: (() => {
    const read = {
      data: { from: '', to: '', sessions: [] },
      loading: false,
      error: null,
      reload() {},
    };
    return () => read;
  })(),
  useProjectTrace: (projectId: string | null) => ({
    data: projectId ? mock.trace : null,
    loading: false,
    error: null,
    reload() {},
  }),
  useProjectHeatmap: () => ({ data: null, loading: false, error: null, reload() {} }),
  useSessionTrace: () => ({ data: null, loading: false, error: null, reload() {} }),
  useTraceTime: () => ({ data: null, loading: true, error: null, reload() {} }),
  useTurnSteps: () => ({ data: null, loading: false, error: null, reload() {} }),
}));
import { timeAxis } from '@/lib/time-axis';
import { ReplayBar, useTraceReplay } from '@/screens/trace/Replay';
import { TraceScreen } from '@/screens/trace/TraceScreen';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

const SECOND = 1000;
const MIN = 60 * SECOND;
const NOW = new Date(2026, 2, 8, 14, 20).getTime();
const LANE = 'session-a';

const zero: TraceStats = {
  sessions: 1,
  turns: 2,
  llm: 0,
  tool: 0,
  error: 0,
  tokens: { input: 0, output: 0 },
  active_ms: 0,
  commits: 0,
};

function projectTrace(): ProjectTrace {
  return {
    epoch: null,
    from: new Date(NOW - 60 * MIN).toISOString(),
    to: new Date(NOW).toISOString(),
    indexing: null,
    stats: zero,
    lanes: [
      {
        lane: {
          key: LANE,
          source: 'pantheon',
          runtime: 'claude',
          session_id: LANE,
          native_id: 'native-a',
          title: 'fix the refund',
          cwd: '/repo',
        },
        stats: zero,
        turns: [
          {
            id: 'turn-a',
            start: NOW - 50 * MIN,
            end: NOW - 40 * MIN,
            status: 'error',
            segments: [],
          },
          { id: 'turn-b', start: NOW - 30 * MIN, end: null, status: 'running', segments: [] },
        ],
      },
    ],
    buckets: [],
  };
}

type Listener = (e: Record<string, unknown>) => void;
let keyListeners: Listener[] = [];
let frames: ((t: number) => void)[] = [];
let reduce = false;
const press = (key: string, target: unknown = null) => {
  const e = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    target,
    defaultPrevented: false,
    preventDefault: vi.fn(),
  };
  for (const listener of [...keyListeners]) listener(e);
  return e.preventDefault;
};
/** A focused element inside whatever the selector names when it lists `owner`. */
const inside = (owner: string) => ({
  closest: (selector: string) => (selector.split(/,\s*/).includes(owner) ? {} : null),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  keyListeners = [];
  frames = [];
  reduce = false;
  mock.trace = projectTrace();
  useShell.setState({ traceTab: 'timeline', runsView: 'now', runsSession: null });
  vi.stubGlobal('document', { activeElement: null, body: {} });
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && keyListeners.push(fn),
    removeEventListener: (_type: string, fn: Listener) => {
      keyListeners = keyListeners.filter((l) => l !== fn);
    },
    matchMedia: () => ({ matches: reduce }),
  });
  vi.stubGlobal('requestAnimationFrame', (fn: (t: number) => void) => frames.push(fn));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function screen() {
  const el = TraceScreen({ projectId: 'project-a', sessions: [] }) as ReactElement<any>;
  return mount(() => (el.type as (props: unknown) => ReactElement)(el.props));
}
function child(tree: unknown, name: string) {
  const el = named(tree as ReactElement, name);
  return mount(() => (el.type as (props: unknown) => ReactElement)(el.props));
}
const has = (tree: unknown, name: string) =>
  nodes(tree as ReactElement).some((n) => typeof n.type === 'function' && n.type.name === name);
const labelled = (tree: unknown, label: string) =>
  nodes(tree as ReactElement).find((n) => n.props['aria-label'] === label);

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

describe('the replay bar on the timeline', () => {
  it('stays under the timeline without a replay opened first', () => {
    const h = screen();
    expect(has(child(h.value, 'Lanes').value, 'Replayer')).toBe(true);
  });

  it('puts the replay speed in the top bar and plays the bar at that speed', () => {
    const h = screen();
    const speed = labelled(child(h.value, 'ReplaySpeedControl').value, zh('trace.replay.speed'))!;
    expect(
      [speed.props.children].flat().map((n: ReactElement<any>) => text(n.props.children)),
    ).toEqual(['1x', '4x', '16x']);
    expect(has(child(h.value, 'Lanes').value, 'ReplaySpeedControl')).toBe(false);
    speed.props.onValueChange(4);
    h.render();
    expect(named(child(h.value, 'Lanes').value, 'Replayer').props.speed).toBe(4);
  });

  it('opens the session replay from a row and comes back to the same timeline', () => {
    const h = screen();
    const lanes = child(h.value, 'Lanes').value;
    const rowEl = find(
      lanes,
      (n) =>
        (n.type as { type?: { name?: string } })?.type?.name === 'Row' && n.props.row.key === LANE,
    );
    const row = (rowEl.type as unknown as { type: (p: unknown) => ReactElement }).type(rowEl.props);
    nodes(row)
      .find((n) => n.type === 'button' && n.props['aria-label'] === zh('trace.row.replay'))!
      .props.onClick();
    h.render();
    expect(has(h.value, 'Lanes')).toBe(false);
    expect(named(h.value, 'StepReplay').props).toMatchObject({
      sessionId: LANE,
      projectId: 'project-a',
    });
    expect(named(h.value, 'ReplaySpeedControl').props.speed).toBe(1);
    nodes(h.value)
      .find((n) => n.type === 'button' && text(n) === zh('trace.replay.back'))!
      .props.onClick();
    h.render();
    expect(has(h.value, 'StepReplay')).toBe(false);
    expect(named(h.value, 'Lanes').props.focus).toBe(LANE);
  });
});

describe('the replay scrubber', () => {
  const full = { from: 0, to: 100 * SECOND };
  const axis = timeAxis([], full.from, full.to, 1000 * SECOND);
  const steps = [20 * SECOND, 50 * SECOND, 80 * SECOND];
  const marks = steps.map((at, i) => ({ at, state: i === 1 ? 'error' : 'ok' }) as const);
  const scrubber = () => {
    const host = hostElement();
    const h = mount(() => {
      const replay = useTraceReplay(axis, full, full, host, 1, steps);
      return { replay, bar: ReplayBar({ replay, axis, view: full, full, marks }) };
    });
    return { h, host };
  };
  const slider = (h: HookHost<any>) => find(h.value.bar, (n) => n.props.role === 'slider');

  it('is a slider that names its step, with a mark per step and no native range', () => {
    const { h } = scrubber();
    const s = slider(h);
    expect(s.props).toMatchObject({
      'aria-valuemin': 0,
      'aria-valuemax': 1000,
      'aria-valuenow': 1000,
    });
    expect(s.props['aria-valuetext']).toMatch(/^第 3 步，共 3 步/);
    expect(nodes(h.value.bar).some((n) => n.type === 'input')).toBe(false);
    expect(
      nodes(s)
        .filter((n) => n.props.className === 'rpb-mk')
        .map((n) => n.props['data-state']),
    ).toEqual(['ok', 'error', 'ok']);
  });

  it('steps with the arrows and plays on Space, and leaves those keys to fields, sliders and buttons', () => {
    const { h } = scrubber();
    for (const owner of ['input', 'textarea', 'button', '[role="slider"]'])
      for (const key of ['ArrowLeft', ' '])
        expect(press(key, inside(owner))).not.toHaveBeenCalled();
    h.render();
    expect(h.value.replay.share).toBeNull();
    expect(h.value.replay.playing).toBe(false);

    press('ArrowLeft');
    h.render();
    expect(h.value.replay.share).toBeCloseTo(0.8);
    press('ArrowLeft');
    h.render();
    expect(h.value.replay.share).toBeCloseTo(0.5);
    expect(slider(h).props['aria-valuetext']).toMatch(/^第 2 步，共 3 步/);
    press('ArrowRight');
    h.render();
    expect(h.value.replay.share).toBeCloseTo(0.8);
    press(' ');
    h.render();
    expect(h.value.replay.playing).toBe(true);
    press(' ');
    h.render();
    expect(h.value.replay.playing).toBe(false);
  });

  it('steps from the slider on the arrows', () => {
    const { h } = scrubber();
    const preventDefault = vi.fn();
    slider(h).props.onKeyDown({
      key: 'ArrowLeft',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault,
    });
    h.render();
    expect(preventDefault).toHaveBeenCalled();
    expect(h.value.replay.share).toBeCloseTo(0.8);
  });

  it('moves only the knob while dragging and takes the place on release', () => {
    const { h } = scrubber();
    const thumb = { style: {} as Record<string, string> };
    const fill = { style: {} as Record<string, string> };
    h.value.replay.thumb.current = thumb as never;
    h.value.replay.fill.current = fill as never;
    const target = {
      getBoundingClientRect: () => ({ left: 0, width: 200 }),
      setPointerCapture() {},
    };
    const s = slider(h);
    s.props.onPointerDown({ button: 0, pointerId: 1, clientX: 50, currentTarget: target });
    s.props.onPointerMove({ clientX: 60, currentTarget: target });
    expect(thumb.style.transform).toBe('translateX(30%)');
    expect(fill.style.transform).toBe('scaleX(0.3)');
    h.render();
    expect(h.value.replay.share).toBeNull();
    s.props.onPointerUp({ currentTarget: target });
    h.render();
    expect(h.value.replay.share).toBeCloseTo(0.3);
  });

  it('jumps from step to step while playing when motion is reduced', () => {
    reduce = true;
    const { h, host } = scrubber();
    h.value.replay.seek(0);
    h.render();
    h.value.replay.toggle();
    h.render();
    frames.shift()!(0);
    // At 1x the playhead crosses the view in a minute, so 21s in it has passed the first step only.
    frames.shift()!(21 * SECOND);
    expect(Number(host.props.get('--ph'))).toBeCloseTo(0.2);
  });
});
