import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HookHost, find, named, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);

const lw = vi.hoisted(() => {
  const made: { type: string; options: any; setData: ReturnType<typeof vi.fn> }[] = [];
  const chart = {
    addSeries: vi.fn((type: string, options: unknown) => {
      const series = { type, options, setData: vi.fn() };
      made.push(series);
      return { ...series, priceScale: () => ({ applyOptions: vi.fn() }) };
    }),
    subscribeCrosshairMove: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: vi.fn(),
  };
  const lib = {
    createChart: vi.fn((_box: unknown, _options: any) => chart),
    CandlestickSeries: 'candles',
    HistogramSeries: 'histogram',
    LineSeries: 'line',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
  };
  return { made, chart, lib };
});
vi.mock(
  '../../apps/web/node_modules/lightweight-charts/dist/lightweight-charts.production.mjs',
  () => lw.lib,
);
vi.mock(
  '../../apps/web/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs',
  () => lw.lib,
);

const vg = vi.hoisted(() => {
  const finalize = vi.fn();
  return {
    finalize,
    embed: vi.fn(async (_box: unknown, _spec: any, _options: any) => ({ finalize })),
    interpreter: { name: 'interpreter' },
  };
});
vi.mock('../../apps/web/node_modules/vega-embed/build/embed.js', () => ({ default: vg.embed }));
vi.mock('../../apps/web/node_modules/vega-interpreter/build/vega-interpreter.js', () => ({
  expressionInterpreter: vg.interpreter,
}));

const mm = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, _source: string) => ({ svg: '<svg data-drawn="yes"></svg>' })),
}));
vi.mock('../../apps/web/node_modules/mermaid/dist/mermaid.core.mjs', () => ({ default: mm }));

const xy = vi.hoisted(() => ({
  ReactFlow: function ReactFlow() {
    return null;
  },
  MiniMap: function MiniMap() {
    return null;
  },
  Background: function Background() {
    return null;
  },
  Handle: function Handle() {
    return null;
  },
  BackgroundVariant: { Dots: 'dots' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', () => xy);
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.js', () => xy);

import { GraphDiagram, GraphNodeInfo } from '@/components/visual/GraphDiagram';
import { KlineChart } from '@/components/visual/KlineChart';
import { MermaidDiagram } from '@/components/visual/MermaidDiagram';
import { SandboxFrame } from '@/components/visual/SandboxFrame';
import { TableVisual, type TableSpec } from '@/components/visual/TableVisual';
import { VegaChart } from '@/components/visual/VegaChart';
import { VisualFrame } from '@/components/visual/VisualCard';
import { currentLocale } from '@/i18n';
import { zh } from './i18n-setup.js';

// ELK's layout code binds the globals it finds when the first ELK is made, so that happens before
// a test stubs window.
new (await import('../../apps/web/node_modules/elkjs/lib/elk.bundled.js')).default();

const ownWindow = { name: 'frame' };
const listeners: Record<string, (event: any) => void> = {};
const hosts: HookHost<any>[] = [];

// Gives every ref in the tree an element before the effects run. Specs stay the same object
// across renders, since a renderer draws again for a new spec.
function mount<T>(body: () => T) {
  const h = new HookHost(body, (tree) => {
    for (const node of nodes(tree as ReactNode))
      if (node.props.ref && typeof node.props.ref === 'object')
        node.props.ref.current ??= { contentWindow: ownWindow };
  });
  hosts.push(h);
  h.render();
  return h;
}

// Nothing is laid out here, so a test gives the measured box its size before the draw reads it.
function sized(h: HookHost<any>, width: number, height: number) {
  const box = find(h.value, (n) => n.props.ref?.current).props.ref.current;
  Object.defineProperties(box, { clientWidth: { value: width }, clientHeight: { value: height } });
}

// Dynamic imports take more than a few microtasks to land.
async function settle(h: HookHost<any>) {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.flush();
  }
}

beforeEach(() => {
  lw.made.splice(0);
  vi.clearAllMocks();
  vi.stubGlobal('window', {
    addEventListener: (kind: string, listener: (event: any) => void) =>
      (listeners[kind] = listener),
    removeEventListener: (kind: string) => delete listeners[kind],
  });
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => `token(${name})`,
  }));
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
});

describe('candlestick chart', () => {
  const spec = {
    candles: [
      { time: '2026-01-02', open: 10, high: 12, low: 9, close: 11, volume: 300 },
      { time: '2026-01-05', open: 11, high: 13, low: 10, close: 10.5, volume: 200 },
    ],
    lines: [{ name: 'MA5', points: [{ time: '2026-01-05', value: 10.8 }] }],
  };

  it('draws the candles, the volume bars and each line, keeping the TradingView link', async () => {
    const h = mount(() => KlineChart({ spec, height: 280 }));
    await settle(h);
    expect(lw.lib.createChart).toHaveBeenCalledOnce();
    const options = lw.lib.createChart.mock.calls[0]![1];
    expect(options.layout.attributionLogo).toBe(true);
    expect(options.layout.textColor).toBe('token(--mu)');
    expect(lw.made.map((s) => s.type)).toEqual(['candles', 'histogram', 'line']);
    expect(lw.made[0]!.options.upColor).toBe('token(--ok)');
    expect(lw.made[0]!.setData).toHaveBeenCalledWith([
      { time: '2026-01-02', open: 10, high: 12, low: 9, close: 11 },
      { time: '2026-01-05', open: 11, high: 13, low: 10, close: 10.5 },
    ]);
    expect(lw.made[1]!.setData).toHaveBeenCalledWith([
      { time: '2026-01-02', value: 300 },
      { time: '2026-01-05', value: 200 },
    ]);
    expect(lw.made[2]!.setData).toHaveBeenCalledWith([{ time: '2026-01-05', value: 10.8 }]);
  });

  it('leaves the volume series out when no candle has a volume', async () => {
    const plain = { candles: [{ time: 1767312000, open: 1, high: 2, low: 0.5, close: 1.5 }] };
    const h = mount(() =>
      KlineChart({
        spec: plain,
        height: 160,
      }),
    );
    await settle(h);
    expect(lw.made.map((s) => s.type)).toEqual(['candles']);
  });

  it('reads out time, open, high, low and close under the crosshair', async () => {
    const h = mount(() => KlineChart({ spec, height: 280 }));
    await settle(h);
    const move = lw.chart.subscribeCrosshairMove.mock.calls[0]![0] as (param: unknown) => void;
    const candles = lw.chart.addSeries.mock.results[0]!.value;
    move({
      time: '2026-01-05',
      seriesData: new Map([
        [candles, { time: '2026-01-05', open: 11, high: 13, low: 10, close: 10.5 }],
      ]),
    });
    h.render();
    const reading = text(find(h.value, (n) => n.props.className === 'vis-kl-read'));
    expect(reading).toContain('2026-01-05');
    expect(reading).toContain(`${zh('visual.kline.open')}11`);
    expect(reading).toContain(`${zh('visual.kline.close')}10.5`);
  });

  it('reads out the last candle with its change and volume while the pointer is away', async () => {
    const h = mount(() => KlineChart({ spec, height: 280 }));
    await settle(h);
    const reading = text(find(h.value, (n) => n.props.className === 'vis-kl-read'));
    expect(reading).toContain('2026-01-05');
    expect(reading).toContain(`${zh('visual.kline.close')}10.5`);
    expect(reading).toContain('-4.55%');
    expect(reading).toContain(`${zh('visual.kline.volume')}200`);
  });

  it('goes back to the last candle once the crosshair leaves', async () => {
    const h = mount(() => KlineChart({ spec, height: 280 }));
    await settle(h);
    const move = lw.chart.subscribeCrosshairMove.mock.calls[0]![0] as (param: unknown) => void;
    const candles = lw.chart.addSeries.mock.results[0]!.value;
    move({
      seriesData: new Map([
        [candles, { time: '2026-01-02', open: 10, high: 12, low: 9, close: 11 }],
      ]),
    });
    h.render();
    const reading = () => text(find(h.value, (n) => n.props.className === 'vis-kl-read'));
    expect(reading()).toContain('2026-01-02');
    move({ seriesData: new Map() });
    h.render();
    expect(reading()).toContain('2026-01-05');
    expect(reading()).toContain(`${zh('visual.kline.volume')}200`);
  });

  it('offers no range for less than a month of candles', async () => {
    const h = mount(() => KlineChart({ spec, height: 280 }));
    await settle(h);
    expect(nodes(h.value).some((n) => n.props['aria-label'] === zh('visual.kline.range'))).toBe(
      false,
    );
  });

  it('shows three months of days, one month of days or a year of weeks from one spec', async () => {
    const day = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    const long = {
      candles: Array.from({ length: 400 }, (_, i) => ({
        time: day(i),
        open: i,
        high: i + 1,
        low: i - 1,
        close: i + 0.5,
        volume: 10,
      })),
    };
    const h = mount(() => KlineChart({ spec: long, height: 280 }));
    await settle(h);
    const drawn = () =>
      lw.made.filter((s) => s.type === 'candles').at(-1)!.setData.mock.calls[0]![0];
    expect(drawn()[0].time).toBe('2025-11-05');
    expect(drawn().at(-1).time).toBe('2026-02-04');
    const range = find(h.value, (n) => n.props['aria-label'] === zh('visual.kline.range'));
    range.props.onValueChange('1m');
    await settle(h);
    expect(drawn()[0].time).toBe('2026-01-05');
    find(h.value, (n) => n.props['aria-label'] === zh('visual.kline.range')).props.onValueChange(
      '1y',
    );
    await settle(h);
    // 2025-02-05 is a Wednesday, so its week runs to Sunday 2025-02-09, the fifth day after.
    const first = long.candles.findIndex((c) => c.time === '2025-02-05');
    expect(drawn()[0]).toEqual({
      time: '2025-02-05',
      open: first,
      high: first + 4 + 1,
      low: first - 1,
      close: first + 4 + 0.5,
    });
    expect(drawn()[1].time).toBe('2025-02-10');
    const volume = lw.made.filter((s) => s.type === 'histogram').at(-1)!.setData.mock.calls[0]![0];
    expect(volume[0]).toEqual({ time: '2025-02-05', value: 50 });
  });

  it('removes the chart when it unmounts', async () => {
    const h = mount(() => KlineChart({ spec, height: 280 }));
    await settle(h);
    h.unmount();
    expect(lw.chart.remove).toHaveBeenCalledOnce();
  });
});

describe('Vega-Lite chart', () => {
  it('embeds without actions, without generated code and without fetching anything', async () => {
    const spec = { mark: 'bar', data: { values: [{ a: 1 }] } };
    const h = mount(() => VegaChart({ spec, height: 280 }));
    await settle(h);
    expect(vg.embed).toHaveBeenCalledOnce();
    const [, given, options] = vg.embed.mock.calls[0]!;
    expect(given).toMatchObject({
      ...spec,
      width: 'container',
      height: 'container',
      autosize: { type: 'fit', contains: 'padding' },
    });
    expect(options).toMatchObject({ mode: 'vega-lite', actions: false, ast: true });
    expect(options.expr).toBe(vg.interpreter);
    expect(options.config.background).toBe('transparent');
    expect(options.config.axis.labelColor).toBe('token(--mu)');
    await expect(options.loader.load('https://example.com/data.json')).rejects.toThrow();
    await expect(options.loader.sanitize('https://example.com/data.json')).rejects.toThrow();
    h.unmount();
    expect(vg.finalize).toHaveBeenCalledOnce();
  });

  it('writes axis, legend, header and mark labels and rules in theme text colours, not Vega black', async () => {
    const spec = { mark: 'rule', data: { values: [{ a: 1 }] } };
    const h = mount(() => VegaChart({ spec, height: 280 }));
    await settle(h);
    const { config } = vg.embed.mock.calls.at(-1)![2];
    const labels = {
      axis: [config.axis?.labelColor, config.axis?.titleColor],
      legend: [config.legend?.labelColor, config.legend?.titleColor],
      header: [config.header?.labelColor, config.header?.titleColor],
      text: [config.text?.color],
      rule: [config.rule?.color],
    };
    const text = ['token(--tx)', 'token(--tx2)', 'token(--mu)'];
    expect(
      Object.entries(labels).filter(([, colours]) => colours.some((c) => !text.includes(c))),
    ).toEqual([]);
    h.unmount();
  });

  it('sizes axis, legend, header and mark text at the smallest text token, not Vega 10px', async () => {
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => (name === '--fs-xs' ? ' 13px' : `token(${name})`),
    }));
    const spec = { mark: 'text', data: { values: [{ a: 1 }] } };
    const h = mount(() => VegaChart({ spec, height: 280 }));
    await settle(h);
    const { config } = vg.embed.mock.calls.at(-1)![2];
    expect({
      axis: [config.axis?.labelFontSize, config.axis?.titleFontSize],
      legend: [config.legend?.labelFontSize, config.legend?.titleFontSize],
      header: [config.header?.labelFontSize, config.header?.titleFontSize],
      text: [config.text?.fontSize],
    }).toEqual({ axis: [13, 13], legend: [13, 13], header: [13, 13], text: [13] });
    h.unmount();
  });

  it('drops the embed options a spec carries for itself', async () => {
    const spec = {
      mark: 'bar',
      data: { values: [{ a: 1 }] },
      usermeta: { embedOptions: { ast: false, actions: true } },
    };
    const h = mount(() => VegaChart({ spec, height: 280 }));
    await settle(h);
    const [, given] = vg.embed.mock.calls.at(-1)!;
    expect(given).toMatchObject({ mark: 'bar' });
    expect(given).not.toHaveProperty('usermeta');
    h.unmount();
  });
});

describe('Mermaid diagram', () => {
  it('renders in strict security mode and shows the SVG it returns', async () => {
    const spec = { source: 'classDiagram\nA <|-- B' };
    const h = mount(() => MermaidDiagram({ spec, height: 280 }));
    await settle(h);
    expect(mm.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', theme: 'base' }),
    );
    expect(mm.render).toHaveBeenCalledWith(expect.any(String), 'classDiagram\nA <|-- B');
    const svg = find(h.value, (n) => n.props.dangerouslySetInnerHTML);
    expect(svg.props.dangerouslySetInnerHTML.__html).toBe('<svg data-drawn="yes"></svg>');
  });

  it.each([
    [
      'fits a diagram into its box when that shrinks it no further than two thirds',
      '0 0 1500 600',
      [1200, 480],
    ],
    ['draws a larger diagram at two thirds and scrolls its box', '-8 -8 3000 900', [2000, 600]],
    ['never enlarges a small diagram', '0 0 300 150', [300, 150]],
  ])('%s', async (_name, viewBox, [width, height]) => {
    mm.render.mockResolvedValueOnce({ svg: `<svg viewBox="${viewBox}"></svg>` });
    const spec = { source: 'classDiagram\nA <|-- B' };
    const h = mount(() => MermaidDiagram({ spec, height: 720 }));
    sized(h, 1200, 720);
    await settle(h);
    const drawn = find(h.value, (n) => n.props.dangerouslySetInnerHTML);
    expect(drawn.props.style).toEqual({ width, height });
  });

  it('colours notes, table rows, actors and labels from the app tokens', async () => {
    const spec = { source: 'classDiagram\nA <|-- B' };
    const h = mount(() => MermaidDiagram({ spec, height: 280 }));
    await settle(h);
    const { themeVariables } = mm.initialize.mock.calls[0]![0];
    expect(themeVariables).toMatchObject({
      noteBkgColor: 'token(--bg)',
      noteTextColor: 'token(--tx)',
      noteBorderColor: 'token(--bd)',
      rowOdd: 'token(--sf)',
      rowEven: 'token(--sf2)',
      attributeBackgroundColorOdd: 'token(--sf)',
      attributeBackgroundColorEven: 'token(--sf2)',
    });
    for (const name of ['actorBkg', 'signalColor', 'labelBoxBkgColor', 'activationBkgColor'])
      expect(themeVariables[name]).toMatch(/^token\(--/);
    for (const name of ['loopTextColor', 'stateLabelColor', 'labelBackgroundColor'])
      expect(themeVariables[name]).toMatch(/^token\(--/);
    // Every colour is a token, so none falls back to a light default.
    const { fontFamily: _font, dropShadow, ...colours } = themeVariables;
    expect(dropShadow).toBe('none');
    for (const value of Object.values(colours)) expect(value).toMatch(/^token\(--[a-z0-9]+\)$/);
  });
});

describe('graph diagram', () => {
  type Spec = Parameters<typeof GraphDiagram>[0]['spec'];
  type Laid = { id: string; position: { x: number; y: number }; width: number; height: number };
  const chain = (count: number, direction?: 'LR' | 'TB'): Spec => ({
    nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, label: `step ${i}` })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
    ...(direction && { direction }),
  });
  const fan = (count: number): Spec => ({
    nodes: [
      { id: 'root', label: 'root' },
      ...Array.from({ length: count }, (_, i) => ({ id: `leaf${i}`, label: `leaf ${i}` })),
    ],
    edges: Array.from({ length: count }, (_, i) => ({ from: 'root', to: `leaf${i}` })),
  });
  // A root over `width` chains, each `depth` steps long.
  const comb = (width: number, depth: number, direction: 'LR' | 'TB'): Spec => {
    const id = (i: number, j: number) => `c${i}s${j}`;
    const ids = Array.from({ length: width }, (_, i) =>
      Array.from({ length: depth }, (_, j) => id(i, j)),
    );
    return {
      nodes: [{ id: 'root', label: 'root' }, ...ids.flat().map((n) => ({ id: n, label: n }))],
      edges: ids.flatMap((line) =>
        line.map((n, j) => ({ from: j === 0 ? 'root' : line[j - 1]!, to: n })),
      ),
      direction,
    };
  };
  const shop: Spec = {
    nodes: [
      { id: 'web', label: 'Storefront', kind: 'client', group: 'edge' },
      { id: 'api', label: 'Orders API', kind: 'service', group: 'core', sublabel: 'src/api' },
      { id: 'auth', label: 'Auth gate', kind: 'policy', group: 'core' },
      { id: 'jobs', label: 'Job queue', kind: 'queue', group: 'data' },
      { id: 'db', label: 'Orders DB', kind: 'store', group: 'data' },
      { id: 'cache', label: 'Cache', kind: 'store', group: 'data' },
      { id: 'pay', label: 'Payments' },
    ],
    edges: [
      { from: 'web', to: 'api', style: 'main', label: 'checkout' },
      { from: 'api', to: 'auth' },
      { from: 'api', to: 'db', style: 'data' },
      { from: 'api', to: 'jobs', style: 'async' },
      { from: 'jobs', to: 'pay' },
      { from: 'pay', to: 'api', style: 'return' },
      { from: 'api', to: 'cache' },
      { from: 'cache', to: 'api' },
    ],
    groups: [
      { id: 'core', label: 'Core' },
      { id: 'data', label: 'Data', parent: 'core' },
    ],
  };

  // Twelve services in three groups, with calls, events, writes and two callbacks back up.
  const services: Spec = {
    nodes: [
      { id: 'app', label: 'Mobile app', kind: 'client', group: 'edge' },
      { id: 'web', label: 'Web app', kind: 'client', group: 'edge' },
      { id: 'gateway', label: 'API gateway', kind: 'policy', group: 'edge' },
      { id: 'auth', label: 'Auth', kind: 'policy', group: 'core' },
      { id: 'orders', label: 'Orders', kind: 'service', group: 'core' },
      { id: 'billing', label: 'Billing', kind: 'service', group: 'core' },
      { id: 'catalog', label: 'Catalog', kind: 'service', group: 'core' },
      { id: 'notify', label: 'Notifier', kind: 'service', group: 'core' },
      { id: 'bus', label: 'Event bus', kind: 'queue', group: 'data' },
      { id: 'db', label: 'Orders DB', kind: 'store', group: 'data' },
      { id: 'search', label: 'Search index', kind: 'store', group: 'data' },
      { id: 'psp', label: 'Payment provider', kind: 'external' },
    ],
    edges: [
      { from: 'app', to: 'gateway', style: 'main', label: 'HTTPS' },
      { from: 'web', to: 'gateway', style: 'main', label: 'HTTPS' },
      { from: 'gateway', to: 'auth', label: 'verify token' },
      { from: 'gateway', to: 'orders', style: 'main', label: 'place order' },
      { from: 'gateway', to: 'catalog', label: 'browse' },
      { from: 'orders', to: 'billing', style: 'main', label: 'charge' },
      { from: 'billing', to: 'psp', label: 'card payment' },
      { from: 'psp', to: 'billing', style: 'return', label: 'webhook' },
      { from: 'orders', to: 'db', style: 'data', label: 'write' },
      { from: 'orders', to: 'bus', style: 'async', label: 'order placed' },
      { from: 'bus', to: 'notify', style: 'async', label: 'deliver' },
      { from: 'bus', to: 'billing', style: 'async' },
      { from: 'catalog', to: 'search', style: 'data', label: 'query' },
      { from: 'notify', to: 'app', style: 'return', label: 'push' },
      { from: 'orders', to: 'catalog', label: 'reserve stock' },
      { from: 'billing', to: 'db', style: 'data', label: 'invoice' },
      { from: 'auth', to: 'bus', style: 'async', label: 'audit' },
      { from: 'bus', to: 'search', style: 'async', label: 'reindex' },
    ],
    groups: [
      { id: 'edge', label: 'Edge' },
      { id: 'core', label: 'Core services' },
      { id: 'data', label: 'Data' },
    ],
  };

  // ELK runs for real; a layout takes more turns than the other renderers' draws.
  async function drawn(spec: Spec, width: number, height: number, more: object = {}) {
    const h = mount(() => GraphDiagram({ spec, height, ...more }));
    sized(h, width, height);
    for (let i = 0; i < 10 && !nodes(h.value).some((n) => n.type === xy.ReactFlow); i++)
      await settle(h);
    return h;
  }
  const flowOf = (h: HookHost<any>) => find(h.value, (n) => n.type === xy.ReactFlow);
  const cards = (h: HookHost<any>): Laid[] =>
    flowOf(h).props.nodes.filter((n: { type: string }) => n.type === 'card');
  const at = (h: HookHost<any>, id: string) => cards(h).find((n) => n.id === id)!;
  const inside = (inner: Laid, outer: Laid) =>
    inner.position.x >= outer.position.x &&
    inner.position.y >= outer.position.y &&
    inner.position.x + inner.width <= outer.position.x + outer.width &&
    inner.position.y + inner.height <= outer.position.y + outer.height;
  const overlap = (a: Laid, b: Laid) =>
    a.position.x < b.position.x + b.width &&
    b.position.x < a.position.x + a.width &&
    a.position.y < b.position.y + b.height &&
    b.position.y < a.position.y + a.height;
  // A node or edge component of the flow, drawn with the props the flow gives it.
  const drawnNode = (h: HookHost<any>, id: string) => {
    const node = flowOf(h).props.nodes.find((n: { id: string }) => n.id === id);
    return flowOf(h).props.nodeTypes[node.type]({ ...node, selected: !!node.selected });
  };
  const drawnEdges = (h: HookHost<any>) =>
    flowOf(h).props.edges.map((edge: any) => flowOf(h).props.edgeTypes[edge.type](edge));
  const tallOf = (h: HookHost<any>) =>
    find(h.value, (n) => n.props['data-direction']).props.style.height;
  // The size of the drawing at full size: its nodes and its routes.
  const extent = (h: HookHost<any>) => {
    const points: { x: number; y: number }[] = flowOf(h).props.edges.flatMap(
      (e: any) => e.data.edge.points,
    );
    return {
      width: Math.max(...cards(h).map((n) => n.position.x + n.width), ...points.map((p) => p.x)),
      height: Math.max(...cards(h).map((n) => n.position.y + n.height), ...points.map((p) => p.y)),
    };
  };
  // Whether the whole node is inside the plot in the view the graph opens with.
  const inView = (h: HookHost<any>, id: string, width: number, height: number) => {
    const { x, y, zoom } = flowOf(h).props.defaultViewport;
    const node = at(h, id);
    const [left, top] = [node.position.x * zoom + x, node.position.y * zoom + y];
    return (
      left >= 0 &&
      top >= 0 &&
      left + node.width * zoom <= width &&
      top + node.height * zoom <= height
    );
  };

  it('gives every node a box of its own, read-only, none overlapping another', async () => {
    const h = await drawn(shop, 1200, 420);
    const laid = cards(h);
    expect(laid.map((n) => n.id)).toEqual(shop.nodes.map((n) => n.id));
    for (const node of laid) expect(node.width * node.height).toBeGreaterThan(0);
    const pairs = laid.flatMap((a, i) => laid.slice(i + 1).filter((b) => overlap(a, b)));
    expect(pairs).toEqual([]);
    const flow = flowOf(h);
    expect(flow.props.nodesDraggable).toBe(false);
    expect(flow.props.nodesConnectable).toBe(false);
  });

  it('draws a group around its members and a nested group inside its parent', async () => {
    const h = await drawn(shop, 1200, 420);
    const groups = flowOf(h).props.nodes.filter((n: { type: string }) => n.type === 'group');
    const box = (id: string) => groups.find((g: { id: string }) => g.id === `group:${id}`);
    for (const node of shop.nodes.filter((n) => n.group))
      expect(inside(at(h, node.id), box(node.group!))).toBe(true);
    expect(inside(box('data'), box('core'))).toBe(true);
    expect(inside(at(h, 'pay'), box('core'))).toBe(false);
    // A group named only by its nodes is drawn as a top-level group of that name.
    expect(text(drawnNode(h, 'group:edge'))).toBe('edge1');
    expect(text(drawnNode(h, 'group:core'))).toBe('Core5');
  });

  it('keeps the declared order of the nodes in a rank', async () => {
    const down = await drawn({ ...fan(5), direction: 'TB' }, 1200, 420);
    const xs = [0, 1, 2, 3, 4].map((i) => at(down, `leaf${i}`).position.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    // Leaves and their edges declared from the last to the first.
    const reversed = fan(5);
    reversed.nodes = [reversed.nodes[0]!, ...reversed.nodes.slice(1).reverse()];
    reversed.edges = [...reversed.edges].reverse();
    const back = await drawn({ ...reversed, direction: 'TB' }, 1200, 420);
    const backXs = [4, 3, 2, 1, 0].map((i) => at(back, `leaf${i}`).position.x);
    expect(backXs).toEqual([...backXs].sort((a, b) => a - b));
  });

  // The nodes that line up: a chain's steps, or a fan's leaves; `row` when they share one row.
  it.each([
    ['a long chain in a wide short box', chain(8), [1200, 280], 'LR', 'row'],
    ['a long chain in a narrow tall box', chain(8), [360, 900], 'TB', 'column'],
    ['a wide fan-out in a wide short box', fan(8), [1200, 280], 'TB', 'row'],
    ['a wide fan-out in a narrow tall box', fan(8), [360, 900], 'LR', 'column'],
  ] as const)(
    'without a direction lays %s out the way that fits at the larger zoom',
    async (_, spec, [width, height], way, line) => {
      const h = await drawn(spec, width, height);
      expect(find(h.value, (n) => n.props['data-direction']).props['data-direction']).toBe(way);
      const lined = spec.nodes.filter((n) => n.id !== 'root').map((n) => at(h, n.id).position);
      const rows = new Set(lined.map((p) => p.y));
      const columns = new Set(lined.map((p) => p.x));
      expect([rows.size === 1, columns.size === 1]).toEqual([line === 'row', line === 'column']);
    },
  );

  // A five-step chain is about 640px long and 96px wide; down it fits a box 420px high at full size.
  it.each([
    [
      'an across chain the down layout fits less than 1.25 times larger',
      chain(5, 'LR'),
      [640, 420],
      'LR',
    ],
    [
      'an across chain the down layout fits 1.25 times larger or more',
      chain(5, 'LR'),
      [520, 420],
      'TB',
    ],
    ['a down chain in a wide short box', chain(8, 'TB'), [1200, 280], 'LR'],
    ['a down chain in a narrow tall box', chain(8, 'TB'), [360, 900], 'TB'],
  ] as const)(
    'with a direction lays %s out the way given unless the other fits 1.25 times larger',
    async (_, spec, [width, height], way) => {
      const h = await drawn(spec, width, height);
      expect(find(h.value, (n) => n.props['data-direction']).props['data-direction']).toBe(way);
    },
  );

  it('names each node by its label and kind and draws its kind and detail line', async () => {
    const h = await drawn(shop, 1200, 420);
    const named = Object.fromEntries(
      flowOf(h)
        .props.nodes.filter((n: { type: string }) => n.type === 'card')
        .map((n: { id: string; ariaLabel: string }) => [n.id, n.ariaLabel]),
    );
    expect(named.db).toBe('Orders DB，存储');
    expect(named.auth).toBe('Auth gate，策略');
    expect(named.pay).toBe('Payments');
    expect(flowOf(h).props.nodesFocusable).toBe(true);
    const api = drawnNode(h, 'api');
    expect(api.props['data-kind']).toBe('service');
    expect(text(api)).toBe('Orders APIsrc/api');
    expect(drawnNode(h, 'pay').props['data-kind']).toBeUndefined();
  });

  it('draws each edge in its style, a data edge in its target kind, a two-way edge with two heads', async () => {
    const h = await drawn(shop, 1200, 420);
    const edges = drawnEdges(h);
    const ends = flowOf(h).props.edges.map((e: any) => `${e.source}>${e.target}`);
    const by = (end: string) => edges[ends.indexOf(end)];
    expect(by('web>api').props['data-style']).toBe('main');
    expect(by('api>jobs').props['data-style']).toBe('async');
    expect(by('pay>api').props['data-style']).toBe('return');
    expect(by('api>auth').props['data-style']).toBe('plain');
    expect(by('api>db').props).toMatchObject({ 'data-style': 'data', 'data-kind': 'store' });
    // The edge back from the cache is the same edge's second head.
    expect(ends).not.toContain('cache>api');
    const heads = (edge: any) => nodes(edge).filter((n) => n.type === 'path').length - 1;
    expect(heads(by('api>cache'))).toBe(2);
    expect(heads(by('api>auth'))).toBe(1);
    const names = flowOf(h).props.edges.map((e: any) => e.ariaLabel);
    expect(names).toContain('Orders API 和 Cache 双向');
    expect(names).toContain('Storefront 到 Orders API');
    expect(text(by('web>api'))).toBe('checkout');
  });

  // A state machine as a diagram converted from mermaid gives it.
  const machine: Spec = {
    nodes: [
      { id: 'in', label: 'Start', shape: 'start' },
      { id: 'ask', label: 'Paid?', shape: 'decision' },
      { id: 'pay', label: 'Paying', group: 'checkout' },
      { id: 'ship', label: 'Shipped', group: 'checkout' },
      { id: 'out', label: 'End', shape: 'end' },
    ],
    edges: [
      { from: 'in', to: 'ask' },
      { from: 'ask', to: 'checkout', label: 'yes' },
      { from: 'ask', to: 'out', label: 'no' },
      { from: 'pay', to: 'ship' },
      { from: 'checkout', to: 'out' },
    ],
    groups: [{ id: 'checkout', label: 'Checkout' }],
    direction: 'TB',
  };

  it('draws a decision as a diamond around its label, and start and end as dots named by their label', async () => {
    const h = await drawn(machine, 1200, 420);
    for (const id of ['in', 'out']) {
      expect([at(h, id).width, at(h, id).height]).toEqual([10, 10]);
      expect(text(drawnNode(h, id))).toBe('');
    }
    expect(drawnNode(h, 'in').props['data-shape']).toBe('start');
    expect(drawnNode(h, 'out').props['data-shape']).toBe('end');
    const named = Object.fromEntries(
      cards(h).map((n) => [n.id, (n as Laid & { ariaLabel: string }).ariaLabel]),
    );
    expect([named.in, named.out]).toEqual(['Start', 'End']);
    const ask = drawnNode(h, 'ask');
    expect(ask.props['data-shape']).toBe('decision');
    expect(text(ask)).toBe('Paid?');
    // The diamond's four corners touch the middle of each side of the node's box.
    const { width, height } = at(h, 'ask');
    const corners = (nodes(ask).find((n) => n.type === 'path')!.props.d as string)
      .match(/-?[\d.]+ -?[\d.]+/g)!
      .map((pair) => pair.split(' ').map((v) => Math.round(+v)));
    expect(corners).toEqual(
      expect.arrayContaining(
        [
          [width / 2, 0],
          [width, height / 2],
          [width / 2, height],
          [0, height / 2],
        ].map(([x, y]) => [Math.round(x!), Math.round(y!)]),
      ),
    );
    expect(width).toBeGreaterThan(height);
  });

  it('ends each edge on the outline of a diamond or dot, not on its box', async () => {
    const h = await drawn(machine, 1200, 420);
    const outline = (id: string, p: { x: number; y: number }) => {
      const n = at(h, id);
      const [a, b] = [n.width / 2, n.height / 2];
      const [dx, dy] = [Math.abs(p.x - n.position.x - a) / a, Math.abs(p.y - n.position.y - b) / b];
      return n.width === 10 ? Math.hypot(dx, dy) : dx + dy;
    };
    for (const edge of flowOf(h).props.edges) {
      const points: { x: number; y: number }[] = edge.data.edge.points;
      for (const [id, p] of [
        [edge.source, points[0]!],
        [edge.target, points.at(-1)!],
      ] as const)
        if (['in', 'ask', 'out'].includes(id)) expect(outline(id, p)).toBeCloseTo(1, 2);
    }
  });

  it('routes an edge to and from a group to its boundary, named by the group', async () => {
    const h = await drawn(machine, 1200, 420);
    const flow = flowOf(h);
    const group = flow.props.nodes.find((n: { id: string }) => n.id === 'group:checkout');
    const ends = flow.props.edges.map((e: any) => `${e.source}>${e.target}`);
    expect(ends).toEqual(expect.arrayContaining(['ask>group:checkout', 'group:checkout>out']));
    const on = (p: { x: number; y: number }) =>
      [group.position.y, group.position.y + group.height].some((y) => Math.abs(p.y - y) < 0.5) ||
      [group.position.x, group.position.x + group.width].some((x) => Math.abs(p.x - x) < 0.5);
    const into = flow.props.edges[ends.indexOf('ask>group:checkout')];
    const out = flow.props.edges[ends.indexOf('group:checkout>out')];
    expect(on(into.data.edge.points.at(-1))).toBe(true);
    expect(on(out.data.edge.points[0])).toBe(true);
    expect(into.ariaLabel).toBe('Paid? 到 Checkout');
    // The flow attaches edges to a node's handles; a group has them too.
    expect(nodes(drawnNode(h, 'group:checkout')).filter((n) => n.type === xy.Handle)).toHaveLength(
      2,
    );
  });

  it('routes every edge in right angles from node to node', async () => {
    const h = await drawn(shop, 1200, 420);
    for (const edge of flowOf(h).props.edges) {
      const points: { x: number; y: number }[] = edge.data.edge.points;
      expect(points.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < points.length; i++)
        expect(
          Math.abs(points[i]!.x - points[i - 1]!.x) < 0.5 ||
            Math.abs(points[i]!.y - points[i - 1]!.y) < 0.5,
        ).toBe(true);
    }
  });

  type Point = { x: number; y: number };
  type Route = {
    points: Point[];
    label_box?: { x: number; y: number; width: number; height: number };
  };
  const routes = (h: HookHost<any>): Route[] => flowOf(h).props.edges.map((e: any) => e.data.edge);
  const runs = (points: Point[]) => points.slice(1).map((q, i) => [points[i]!, q] as const);
  const boxed = (b: NonNullable<Route['label_box']>): Laid => ({
    id: '',
    position: { x: b.x, y: b.y },
    width: b.width,
    height: b.height,
  });
  // Whether a straight run goes into the box, not only along its border.
  const through = ([p, q]: readonly [Point, Point], b: Laid) =>
    Math.min(p.x, q.x) < b.position.x + b.width &&
    Math.max(p.x, q.x) > b.position.x &&
    Math.min(p.y, q.y) < b.position.y + b.height &&
    Math.max(p.y, q.y) > b.position.y;
  // A level run and an upright one that cross inside both.
  const crosses = (a: readonly [Point, Point], b: readonly [Point, Point]) => {
    const level = (r: readonly [Point, Point]) => Math.abs(r[0].y - r[1].y) < 0.5;
    if (level(a) === level(b)) return false;
    const [h, v] = level(a) ? [a, b] : [b, a];
    const [x, y] = [v[0].x, h[0].y];
    return (
      x > Math.min(h[0].x, h[1].x) + 0.5 &&
      x < Math.max(h[0].x, h[1].x) - 0.5 &&
      y > Math.min(v[0].y, v[1].y) + 0.5 &&
      y < Math.max(v[0].y, v[1].y) - 0.5
    );
  };

  // Crossings as measured with the layout settings in place.
  it.each([
    ['a shop of seven nodes', shop, [1200, 420], 0],
    ['a service map of twelve nodes in three groups', services, [1200, 720], 3],
  ] as const)(
    'lays %s out with no label over a node, a label or another route, crossing at most %i times',
    async (_, spec, [width, height], most) => {
      const h = await drawn(spec, width, height);
      const all = routes(h);
      const labels = all.filter((r) => r.label_box);
      expect(labels).toHaveLength(spec.edges.filter((e) => e.label).length);
      for (const route of labels) {
        const box = boxed(route.label_box!);
        expect(cards(h).filter((n) => overlap(box, n))).toEqual([]);
        expect(labels.filter((o) => o !== route && overlap(box, boxed(o.label_box!)))).toEqual([]);
        expect(
          all.filter((o) => o !== route && runs(o.points).some((r) => through(r, box))),
        ).toEqual([]);
      }
      const crossings = all.flatMap((a, i) =>
        all
          .slice(i + 1)
          .flatMap((b) =>
            runs(a.points).flatMap((r) => runs(b.points).filter((s) => crosses(r, s))),
          ),
      );
      expect(crossings.length).toBeLessThanOrEqual(most);
    },
  );

  it('puts each edge label on its own route', async () => {
    const h = await drawn(services, 1200, 720);
    const labels = routes(h).filter((r) => r.label_box);
    expect(labels.length).toBeGreaterThan(0);
    expect(
      labels.filter((r) => !runs(r.points).some((run) => through(run, boxed(r.label_box!)))),
    ).toEqual([]);
  });

  it('lists the kinds and edge styles in use with their counts under the plot', async () => {
    const h = await drawn(shop, 1200, 420);
    const legend = find(h.value, (n) => n.props['aria-label'] === zh('visual.graph.legend'));
    expect(legend.type).toBe('ul');
    expect(
      nodes(legend)
        .filter((n) => n.type === 'li')
        .map(text),
    ).toEqual([
      '客户端1',
      '服务1',
      '存储2',
      '队列1',
      '策略1',
      '主路径1',
      '异步1',
      '数据1',
      '返回1',
    ]);
  });

  it('shows no legend for fewer than two kinds and styles', async () => {
    const one: Spec = { nodes: [{ id: 'a', label: 'A', kind: 'store' }], edges: [] };
    const h = await drawn(one, 1200, 280);
    expect(cards(h)).toHaveLength(1);
    expect(nodes(h.value).some((n) => n.props['aria-label'] === zh('visual.graph.legend'))).toBe(
      false,
    );
  });

  it('dims what is off the hovered node and lights its edges', async () => {
    const h = await drawn(shop, 1200, 420);
    flowOf(h).props.onNodeMouseEnter({}, { id: 'jobs', type: 'card' });
    h.render();
    expect(drawnNode(h, 'jobs').props['data-focus']).toBeUndefined();
    expect(drawnNode(h, 'pay').props['data-focus']).toBeUndefined();
    expect(drawnNode(h, 'db').props['data-focus']).toBe('dim');
    const ends = flowOf(h).props.edges.map((e: any) => `${e.source}>${e.target}`);
    const focus = drawnEdges(h).map((e: any) => e.props['data-focus']);
    expect(focus[ends.indexOf('api>jobs')]).toBe('on');
    expect(focus[ends.indexOf('web>api')]).toBe('dim');
    flowOf(h).props.onNodeMouseLeave({}, { id: 'jobs', type: 'card' });
    h.render();
    expect(drawnNode(h, 'db').props['data-focus']).toBeUndefined();
  });

  it('selects a node by Enter or a click and lets it go by Esc', async () => {
    const onSelect = vi.fn();
    const h = await drawn(shop, 1200, 420, { onSelect });
    const box = find(h.value, (n) => n.props['data-direction']);
    const on = (id: string) => ({
      closest: () => ({ dataset: { id } }),
    });
    box.props.onKeyDown({ key: 'Enter', target: on('db'), preventDefault() {} });
    h.render();
    expect(onSelect).toHaveBeenCalledWith('db');
    expect(drawnNode(h, 'db').props['data-selected']).toBe(true);
    find(h.value, (n) => n.props['data-direction']).props.onKeyDown({
      key: 'Escape',
      target: on('db'),
      stopPropagation() {},
    });
    h.render();
    expect(drawnNode(h, 'db').props['data-selected']).toBeUndefined();
    flowOf(h).props.onNodeClick({}, { id: 'api', type: 'card' });
    h.render();
    expect(onSelect).toHaveBeenLastCalledWith('api');
    expect(drawnNode(h, 'api').props['data-selected']).toBe(true);
  });

  it.each([
    ['a short chain at full size', chain(3, 'LR'), 1200, {}, 'one'],
    ['a long chain at the zoom that fits it', chain(10, 'LR'), 1200, {}, 'fit'],
    ['a chain too long for two thirds at two thirds', chain(10, 'LR'), 600, {}, 'floor'],
    ['the same chain enlarged at full size', chain(10, 'LR'), 600, { full: true }, 'one'],
  ] as const)('shows %s', async (_, spec, width, more, zoom) => {
    const h = await drawn(spec, width, 280, more);
    const fit = (width - 32) / extent(h).width;
    expect(flowOf(h).props.defaultViewport.zoom).toBeCloseTo(
      { one: 1, fit, floor: 2 / 3 }[zoom],
      3,
    );
  });

  it.each([
    ['an across chain wider than its card at its left end', chain(14, 'LR'), [600, 280], {}],
    ['a down chain taller than its card at its top', chain(14, 'TB'), [360, 400], {}],
    [
      'a column taller than a card grows to at its top',
      chain(24, 'TB'),
      [1200, 280],
      { grows: true },
    ],
  ] as const)('opens %s', async (_, spec, [width, height], more) => {
    const h = await drawn(spec, width, height, more);
    const plot = tallOf(h);
    expect(inView(h, 'n0', width, plot)).toBe(true);
    expect(inView(h, `n${spec.nodes.length - 1}`, width, plot)).toBe(false);
  });

  it('shows a node clicked in the enlarged graph with its edges and sources, and the spec again on Esc or a click off it', async () => {
    const sourced: Spec = {
      ...shop,
      nodes: shop.nodes.map((n) =>
        n.id === 'api' ? { ...n, sources: ['src/api/orders.ts', 'src/api/routes.ts'] } : n,
      ),
    };
    const frame = mount(() =>
      VisualFrame({ content: { kind: 'graph', spec: sourced }, size: 'M' }),
    );
    const graphs = nodes(frame.value).filter((n) => n.type === GraphDiagram);
    // The card in the conversation selects; only the enlarged one fills the inspector.
    expect(graphs.map((g) => typeof g.props.onSelect)).toEqual(['undefined', 'function']);
    const h = await drawn(sourced, 1200, 640, graphs[1]!.props);
    expect(flowOf(h).props.defaultViewport.zoom).toBe(1);
    const aside = () =>
      find(
        frame.value,
        (n) => n.type === 'aside' && n.props['aria-label'] === zh('visual.card.inspector'),
      );
    // The picked node's part of the inspector, drawn.
    const picked = () =>
      nodes(aside())
        .filter((n) => n.type === GraphNodeInfo)
        .map((n) => GraphNodeInfo(n.props));
    const list = (name: string) =>
      nodes(picked())
        .filter((n) => n.type === 'ul' && n.props['aria-label'] === zh(name))
        .flatMap((ul) =>
          nodes(ul)
            .filter((n) => n.type === 'li')
            .map(text),
        );
    flowOf(h).props.onNodeClick({}, { id: 'api', type: 'card' });
    h.render();
    frame.render();
    expect(picked()).toHaveLength(1);
    expect(text(picked())).toContain('Orders API');
    expect(text(picked())).toContain('服务');
    expect(text(picked())).toContain('src/api');
    expect(text(picked())).toContain('Core');
    expect(list('visual.graph.incoming')).toEqual(['Storefrontcheckout', 'Payments', 'Cache']);
    expect(list('visual.graph.outgoing')).toEqual(['Auth gate', 'Orders DB', 'Job queue', 'Cache']);
    expect(list('visual.graph.sources')).toEqual(['src/api/orders.ts', 'src/api/routes.ts']);
    expect(text(aside())).toContain('"nodes"');
    find(h.value, (n) => n.props['data-direction']).props.onKeyDown({
      key: 'Escape',
      stopPropagation() {},
    });
    frame.render();
    expect(list('visual.graph.incoming')).toEqual([]);
    expect(text(aside())).toContain('"nodes"');
    flowOf(h).props.onNodeClick({}, { id: 'db', type: 'card' });
    h.render();
    frame.render();
    expect(list('visual.graph.incoming')).toEqual(['Orders API']);
    flowOf(h).props.onPaneClick({});
    frame.render();
    expect(list('visual.graph.incoming')).toEqual([]);
  });

  it('shows the error in place of the picture when the layout fails, with no other layout', async () => {
    const broken: Spec = { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'gone' }] };
    const h = mount(() => GraphDiagram({ spec: broken, height: 280 }));
    sized(h, 1200, 280);
    await expect(settle(h)).rejects.toThrow();
    expect(nodes(h.value).some((n) => n.type === xy.ReactFlow)).toBe(false);
  });

  it.each([
    ['600px wide', true, chain(10, 'LR'), 600, {}],
    ['1200px wide', false, chain(10, 'LR'), 1200, {}],
    ['that grows to a twelve-step column', false, chain(12, 'TB'), 1200, { grows: true }],
    ['that cannot grow to a 24-step column', true, chain(24, 'TB'), 1200, { grows: true }],
  ] as const)(
    'in a card %s, a graph shows a map of the whole only when it overflows: %s',
    async (_, map, spec, width, more) => {
      const h = await drawn(spec, width, 280, more);
      const maps = nodes(h.value).filter((n) => n.type === xy.MiniMap);
      expect(maps.length).toBe(map ? 1 : 0);
      if (map)
        expect(maps[0]!.props).toMatchObject({
          pannable: true,
          zoomable: false,
          ariaLabel: zh('visual.graph.overview'),
        });
    },
  );

  it('grows a card to the graph at the zoom that fits its width, up to 1200px, and keeps a short one at its size', async () => {
    expect(tallOf(await drawn(chain(2, 'TB'), 1200, 280, { grows: true }))).toBe(280);
    const column = await drawn(chain(12, 'TB'), 1200, 280, { grows: true });
    expect(tallOf(column)).toBeCloseTo(extent(column).height + 32, 0);
    // Eight chains side by side, wider than the card.
    const wide = await drawn(comb(8, 7, 'TB'), 800, 280, { grows: true });
    const zoom = (800 - 32) / extent(wide).width;
    expect(zoom).toBeGreaterThan(2 / 3);
    expect(zoom).toBeLessThan(1);
    expect(flowOf(wide).props.defaultViewport.zoom).toBeCloseTo(zoom, 3);
    expect(tallOf(wide)).toBeCloseTo(extent(wide).height * zoom + 32, 0);
    expect(tallOf(await drawn(chain(24, 'TB'), 1200, 280, { grows: true }))).toBe(1200);
    // A pinned card keeps the size picked for it.
    expect(tallOf(await drawn(chain(12, 'TB'), 1200, 280))).toBe(280);
  });
});

describe('sandboxed page', () => {
  const frameOf = (h: HookHost<any>) => find(h.value, (n) => n.type === 'iframe');

  it('runs the page with scripts only, behind an offline policy placed first', () => {
    const h = mount(() =>
      SandboxFrame({
        spec: { html: '<p>hi</p>' },
        height: 280,
        network: false,
        onBlocked() {},
        onViewSpec() {},
      }),
    );
    const frame = frameOf(h);
    expect(frame.props.sandbox).toBe('allow-scripts');
    expect(
      frame.props.srcDoc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
    expect(frame.props.srcDoc).toContain("default-src 'none'");
    expect(frame.props.srcDoc).not.toContain('https:');
    expect(frame.props.srcDoc).toContain('<p>hi</p>');
    expect(frame.props.title).toBeTruthy();
  });

  it('loads the page from its own address in the desktop app, still with scripts only', async () => {
    const visualServe = vi.fn(async (_input: { html: string }) => ({
      ok: true as const,
      value: { url: 'pantheon-visual://page-1/' },
    }));
    vi.stubGlobal('window', { ...window, pantheon: { visualServe } });
    const spec = { html: '<script src="/libraries/charts.js"></script><p>hi</p>' };
    const h = mount(() =>
      SandboxFrame({ spec, height: 280, network: false, onBlocked() {}, onViewSpec() {} }),
    );
    await h.flush();
    h.render();
    const served = visualServe.mock.calls[0]![0].html;
    expect(served.startsWith("<!doctype html><script>document.addEventListener('security")).toBe(
      true,
    );
    expect(served).toContain(spec.html);
    const frame = frameOf(h);
    expect(frame.props.src).toBe('pantheon-visual://page-1/');
    expect(frame.props.srcDoc).toBeUndefined();
    expect(frame.props.sandbox).toBe('allow-scripts');
  });

  it('serves the page again with the hosts it asked for once the network is allowed in the desktop app', async () => {
    let served = 0;
    const visualServe = vi.fn(async (_input: { html: string; hosts?: string[] }) => ({
      ok: true as const,
      value: { url: `pantheon-visual://page-${++served}/` },
    }));
    vi.stubGlobal('window', { ...window, pantheon: { visualServe } });
    let network = false;
    const spec = { html: '<p>hi</p>' };
    const h = mount(() =>
      SandboxFrame({ spec, height: 280, network, onBlocked() {}, onViewSpec() {} }),
    );
    await h.flush();
    expect(visualServe.mock.calls.at(-1)![0].hosts ?? []).toEqual([]);
    listeners.message!({ source: ownWindow, data: { blocked: 'https://api.example.com/rates' } });
    h.render();
    await h.flush();
    expect(visualServe).toHaveBeenCalledOnce();
    network = true;
    h.render();
    await h.flush();
    expect(visualServe.mock.calls.at(-1)![0]).toEqual({
      html: visualServe.mock.calls[0]![0].html,
      hosts: ['https://api.example.com'],
    });
    expect(frameOf(h).props.src).toBe('pantheon-visual://page-2/');
  });

  it('opens only the hosts the page asked for once the network is allowed', () => {
    let network = false;
    const spec = { html: '<p>hi</p>' };
    const h = mount(() =>
      SandboxFrame({ spec, height: 280, network, onBlocked() {}, onViewSpec() {} }),
    );
    listeners.message!({ source: ownWindow, data: { blocked: 'https://api.example.com/rates' } });
    h.render();
    expect(frameOf(h).props.srcDoc).not.toContain('api.example.com');
    network = true;
    h.render();
    listeners.message!({ source: ownWindow, data: { blocked: 'https://later.example.com/x' } });
    h.render();
    const doc = frameOf(h).props.srcDoc;
    expect(doc).toContain('connect-src https://api.example.com"');
    expect(doc).toContain("script-src 'unsafe-inline' https://api.example.com;");
    expect(doc).not.toContain('https:;');
    expect(doc).not.toContain('later.example.com');
  });

  // The error card the frame shows after its page posts a script error, mounted.
  const failedPage = (h: HookHost<any>) => {
    listeners.message!({
      source: ownWindow,
      data: { error: 'ReferenceError: drawCurve is not defined', line: 42 },
    });
    h.render();
    const shown = named(h.value, 'VisualError');
    return mount(() => (shown.type as (props: unknown) => ReactNode)(shown.props)).value;
  };
  const buttonsOf = (tree: ReactNode) =>
    nodes(tree)
      .filter((n) => n.type === 'button')
      .map(text);

  it('shows a script error of its own page in place of the picture', () => {
    const h = mount(() =>
      SandboxFrame({
        spec: { html: '<p>hi</p>' },
        height: 280,
        network: false,
        onBlocked() {},
        onViewSpec() {},
      }),
    );
    expect(frameOf(h).props.srcDoc).toContain("addEventListener('error'");
    const data = { error: 'ReferenceError: drawCurve is not defined', line: 42 };
    listeners.message!({ source: { name: 'another frame' }, data });
    h.render();
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
    const alert = text(find(failedPage(h), (n) => n.props.role === 'alert'));
    expect(alert).toContain(zh('visual.sandbox.failed'));
    expect(alert).toContain('index.html:42 ReferenceError: drawCurve is not defined');
  });

  it('offers a fix with the script error and the spec where its page failed', () => {
    const onFix = vi.fn(async () => null);
    const onViewSpec = vi.fn();
    const h = mount(() =>
      SandboxFrame({
        spec: { html: '<p>hi</p>' },
        height: 280,
        network: false,
        onBlocked() {},
        onViewSpec,
        onFix,
      }),
    );
    const shown = failedPage(h);
    expect(buttonsOf(shown)).toEqual([zh('visual.error.fix'), zh('visual.card.viewSpec')]);
    const [fix, spec] = nodes(shown).filter((n) => n.type === 'button');
    fix!.props.onClick();
    expect(onFix).toHaveBeenCalledWith('index.html:42 ReferenceError: drawCurve is not defined');
    spec!.props.onClick();
    expect(onViewSpec).toHaveBeenCalled();
  });

  it('offers only the spec where its page failed with no session to fix it', () => {
    const h = mount(() =>
      SandboxFrame({
        spec: { html: '<p>hi</p>' },
        height: 280,
        network: false,
        onBlocked() {},
        onViewSpec() {},
      }),
    );
    expect(buttonsOf(failedPage(h))).toEqual([zh('visual.card.viewSpec')]);
  });

  it('hears blocked requests only from its own frame', () => {
    const onBlocked = vi.fn();
    mount(() =>
      SandboxFrame({
        spec: { html: '<p>hi</p>' },
        height: 280,
        network: false,
        onBlocked,
        onViewSpec() {},
      }),
    );
    const data = { blocked: 'https://api.example.com/rates' };
    listeners.message!({ source: { name: 'another frame' }, data });
    expect(onBlocked).not.toHaveBeenCalled();
    listeners.message!({ source: ownWindow, data });
    expect(onBlocked).toHaveBeenCalledWith('https://api.example.com/rates');
  });
});

describe('table', () => {
  const spec: TableSpec = {
    columns: [
      { key: 'name', title: 'Session', type: 'text' },
      { key: 'lines', title: 'Lines', type: 'number' },
      { key: 'day', title: 'Day', type: 'date' },
    ],
    rows: [
      { name: 'beta', lines: 1200, day: '2026-03-04' },
      { name: 'alpha', lines: null, day: '2026-01-02' },
      { name: 'gamma', lines: 7 },
      { name: null, lines: 30, day: '2026-02-03' },
    ],
  };
  const rows = (tree: ReactNode) =>
    nodes(tree)
      .filter((n) => n.props.role === 'row')
      .slice(1)
      .map((row) => nodes(row.props.children).filter((n) => n.props.role === 'cell'));
  const column = (tree: ReactNode, i: number) => rows(tree).map((cells) => text(cells[i]));
  const headers = (tree: ReactNode) => nodes(tree).filter((n) => n.props.role === 'columnheader');
  const sortBy = (h: HookHost<any>, title: string) => {
    const header = headers(h.value).find((n) => text(n) === title)!;
    find(header, (n) => n.type === 'button').props.onClick();
    h.render();
  };

  it('heads each column with its title and draws a row for each row of the spec', () => {
    const h = mount(() => TableVisual({ spec }));
    expect(headers(h.value).map(text)).toEqual(['Session', 'Lines', 'Day']);
    expect(column(h.value, 0)).toEqual(['beta', 'alpha', 'gamma', '']);
  });

  it('right-aligns numbers in tabular digits, formats dates in the interface language and leaves a missing value empty', () => {
    const h = mount(() => TableVisual({ spec }));
    const [first, second, third] = rows(h.value);
    expect(first!.map((c) => c.props.className)).toEqual([
      'vis-td',
      'vis-td vis-num',
      'vis-td vis-date',
    ]);
    expect(text(first![1])).toBe(new Intl.NumberFormat(currentLocale()).format(1200));
    expect(text(first![2])).toBe(
      new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date('2026-03-04'),
      ),
    );
    expect(text(second![1])).toBe('');
    expect(text(third![2])).toBe('');
    const css = readFileSync(
      new URL('../../apps/web/src/components/visual/table-visual.css', import.meta.url),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(css).toMatch(/\.vis-num \{[^}]*text-align: right;/);
    expect(css).toMatch(/\.vis-num \{[^}]*font-variant-numeric: tabular-nums;/);
  });

  it('shows a day without a time as that day west of UTC', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const h = mount(() => TableVisual({ spec }));
      expect(text(rows(h.value)[0]![2])).toBe(
        new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(
          new Date('2026-03-04'),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sorts up, then down, then back to the order it came in, with missing values last', () => {
    const h = mount(() => TableVisual({ spec }));
    const sortOf = (title: string) =>
      headers(h.value).find((n) => text(n) === title)!.props['aria-sort'];
    expect(sortOf('Lines')).toBe('none');
    sortBy(h, 'Lines');
    expect(column(h.value, 0)).toEqual(['gamma', '', 'beta', 'alpha']);
    expect(sortOf('Lines')).toBe('ascending');
    sortBy(h, 'Lines');
    expect(column(h.value, 0)).toEqual(['beta', '', 'gamma', 'alpha']);
    expect(sortOf('Lines')).toBe('descending');
    sortBy(h, 'Lines');
    expect(column(h.value, 0)).toEqual(['beta', 'alpha', 'gamma', '']);
    expect(sortOf('Lines')).toBe('none');

    sortBy(h, 'Day');
    expect(column(h.value, 0)).toEqual(['alpha', '', 'beta', 'gamma']);
    sortBy(h, 'Session');
    expect(column(h.value, 0)).toEqual(['alpha', 'beta', 'gamma', '']);
    sortBy(h, 'Session');
    expect(column(h.value, 0)).toEqual(['gamma', 'beta', 'alpha', '']);
  });

  it("starts from the spec's own sort and goes back to it on the third click", () => {
    const sorted: TableSpec = { ...spec, sort: { key: 'day', direction: 'desc' } };
    const h = mount(() => TableVisual({ spec: sorted }));
    const order = ['beta', '', 'alpha', 'gamma'];
    expect(column(h.value, 0)).toEqual(order);
    expect(headers(h.value).find((n) => text(n) === 'Day')!.props['aria-sort']).toBe('descending');
    sortBy(h, 'Lines');
    sortBy(h, 'Lines');
    sortBy(h, 'Lines');
    expect(column(h.value, 0)).toEqual(order);
  });
});
