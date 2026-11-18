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
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', () => xy);
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.js', () => xy);

const dg = vi.hoisted(() => {
  const graphs: { label: any; nodes: Map<string, any>; edges: any[] }[] = [];
  class Graph {
    label: any;
    nodes = new Map<string, any>();
    edges: any[] = [];
    constructor() {
      graphs.push(this);
    }
    setGraph(label: unknown) {
      this.label = label;
    }
    setDefaultEdgeLabel() {}
    setNode(id: string, value: { width: number; height: number }) {
      this.nodes.set(id, { ...value, x: 100 + this.nodes.size * 200, y: 50 });
    }
    setEdge(from: string, to: string, value?: unknown) {
      this.edges.push({ from, to, value });
    }
    node(id: string) {
      return this.nodes.get(id);
    }
  }
  return { graphs, Graph, layout: vi.fn() };
});
vi.mock('../../apps/web/node_modules/@dagrejs/dagre/dist/dagre.esm.js', () => ({
  Graph: dg.Graph,
  layout: dg.layout,
}));

import { GraphDiagram } from '@/components/visual/GraphDiagram';
import { KlineChart } from '@/components/visual/KlineChart';
import { MermaidDiagram } from '@/components/visual/MermaidDiagram';
import { SandboxFrame } from '@/components/visual/SandboxFrame';
import { TableVisual, type TableSpec } from '@/components/visual/TableVisual';
import { VegaChart } from '@/components/visual/VegaChart';
import { currentLocale } from '@/i18n';
import { zh } from './i18n-setup.js';

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
  dg.graphs.splice(0);
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
    const spec = { source: 'graph LR\na-->b' };
    const h = mount(() => MermaidDiagram({ spec, height: 280 }));
    await settle(h);
    expect(mm.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', theme: 'base' }),
    );
    expect(mm.render).toHaveBeenCalledWith(expect.any(String), 'graph LR\na-->b');
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
    const spec = { source: 'graph LR\na-->b' };
    const h = mount(() => MermaidDiagram({ spec, height: 720 }));
    sized(h, 1200, 720);
    await settle(h);
    const drawn = find(h.value, (n) => n.props.dangerouslySetInnerHTML);
    expect(drawn.props.style).toEqual({ width, height });
  });

  it('colours notes, table rows, actors and labels from the app tokens', async () => {
    const spec = { source: 'erDiagram\nA ||--o{ B : has' };
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
  const groups = ['a', 'b', 'c', 'd', 'e', 'f'];
  const spec = {
    nodes: groups.map((group) => ({ id: `n-${group}`, label: `node ${group}`, group })),
    edges: [{ from: 'n-a', to: 'n-b', label: 'calls' }],
  };

  it('lays the graph out left to right unless told otherwise, read-only', async () => {
    const h = mount(() => GraphDiagram({ spec, height: 280 }));
    await settle(h);
    expect(dg.graphs[0]!.label.rankdir).toBe('LR');
    const flow = find(h.value, (n) => n.type === xy.ReactFlow);
    expect(flow.props.nodesDraggable).toBe(false);
    expect(flow.props.nodesConnectable).toBe(false);
    expect(flow.props.nodes.map((n: any) => n.data.label)).toEqual(groups.map((g) => `node ${g}`));
    expect(flow.props.edges).toEqual([
      expect.objectContaining({ source: 'n-a', target: 'n-b', label: 'calls' }),
    ]);
  });

  it('draws every node 24 high on the same neutral style, whatever its group', async () => {
    const down = { ...spec, direction: 'TB' as const };
    const h = mount(() => GraphDiagram({ spec: down, height: 280 }));
    await settle(h);
    expect(dg.graphs[0]!.label.rankdir).toBe('TB');
    expect([...dg.graphs[0]!.nodes.values()].map((n) => n.height)).toEqual(groups.map(() => 24));
    const flow = find(h.value, (n) => n.type === xy.ReactFlow);
    expect(flow.props.nodes.map((n: any) => [n.className, n.height])).toEqual(
      groups.map(() => ['vis-node', 24]),
    );
  });

  it('gives dagre the size of each edge label and fits the view between two thirds and full size', async () => {
    const h = mount(() => GraphDiagram({ spec, height: 280 }));
    await settle(h);
    const [edge] = dg.graphs[0]!.edges;
    expect(edge).toMatchObject({ from: 'n-a', to: 'n-b' });
    expect(edge.value.width).toBeGreaterThanOrEqual('calls'.length * 7);
    expect(edge.value.height).toBeGreaterThan(0);
    const flow = find(h.value, (n) => n.type === xy.ReactFlow);
    expect(flow.props.fitViewOptions).toMatchObject({ minZoom: 2 / 3, maxZoom: 1 });
  });

  it.each([
    [600, true],
    [1200, false],
  ])(
    'in a card %ipx wide, a graph that outgrows it at two thirds shows a map of the whole: %s',
    async (width, map) => {
      const h = mount(() => GraphDiagram({ spec, height: 280 }));
      sized(h, width, 280);
      await settle(h);
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

  it('grows a card to a graph taller than it, up to the zoomed view, and keeps a short one at its size', async () => {
    const box = (h: HookHost<any>) =>
      find(h.value, (n) => String(n.props.className).includes('vis-graph')).props.style.height;
    const short = mount(() => GraphDiagram({ spec, height: 280, grows: true }));
    await settle(short);
    expect(box(short)).toBe(280);
    // Ranks 120 apart: 3 ranks need more than 280, 6 more than the zoomed view.
    const ranked = (count: number) =>
      vi.spyOn(dg.Graph.prototype, 'setNode').mockImplementation(function (
        this: InstanceType<typeof dg.Graph>,
        id: string,
        value: { width: number; height: number },
      ) {
        if (this.nodes.size < count)
          this.nodes.set(id, { ...value, x: 100, y: 12 + this.nodes.size * 120 });
        else this.nodes.set(id, { ...value, x: 300, y: 12 });
      });
    ranked(3);
    const mid = mount(() => GraphDiagram({ spec, height: 280, grows: true }));
    await settle(mid);
    expect(box(mid)).toBeGreaterThan(280);
    expect(box(mid)).toBeLessThan(640);
    ranked(6);
    const tall = mount(() => GraphDiagram({ spec, height: 280, grows: true }));
    await settle(tall);
    expect(box(tall)).toBe(640);
    // A pinned card keeps the size picked for it.
    const pinned = mount(() => GraphDiagram({ spec, height: 280 }));
    await settle(pinned);
    expect(box(pinned)).toBe(280);
    vi.restoreAllMocks();
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
