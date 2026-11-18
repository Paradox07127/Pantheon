import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HookHost, nodes } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);

const vg = vi.hoisted(() => ({
  embed: vi.fn(async (_box: unknown, _spec: any, _options: any) => ({ finalize: () => {} })),
}));
vi.mock('../../apps/web/node_modules/vega-embed/build/embed.js', () => ({ default: vg.embed }));
vi.mock('../../apps/web/node_modules/vega-interpreter/build/vega-interpreter.js', () => ({
  expressionInterpreter: {},
}));

const mm = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, _source: string) => ({ svg: '<svg></svg>' })),
}));
vi.mock('../../apps/web/node_modules/mermaid/dist/mermaid.core.mjs', () => ({ default: mm }));

import { MermaidDiagram } from '@/components/visual/MermaidDiagram';
import { VegaChart } from '@/components/visual/VegaChart';

const hosts: HookHost<any>[] = [];
const sizes: Record<string, string> = { '--fs-xs': '12px', '--fs-sm': '13px' };

function mount<T>(body: () => T) {
  const h = new HookHost(body, (tree) => {
    for (const node of nodes(tree as ReactNode))
      if (node.props.ref && typeof node.props.ref === 'object') node.props.ref.current ??= {};
  });
  hosts.push(h);
  h.render();
  return h;
}

async function settle(h: HookHost<any>) {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.flush();
  }
}

// Stands in for the browser painting a colour: each colour string gets a pixel of its own.
const pixel = (colour: string) =>
  [0, 1, 2, 3].map((i) => [...colour].reduce((n, c) => (n * 31 + c.charCodeAt(0) + i) % 256, 7));
const hex = (colour: string) =>
  `#${pixel(colour)
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => {
      let fill = '';
      const context = {
        set fillStyle(colour: string) {
          fill = colour;
        },
        get fillStyle() {
          return fill;
        },
        clearRect() {},
        fillRect() {},
        getImageData: () => ({ data: Uint8ClampedArray.from(pixel(fill)) }),
      };
      return { width: 1, height: 1, getContext: () => context };
    },
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => sizes[name] ?? `token(${name})`,
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

const KINDS = { client: 1, service: 2, store: 4, queue: 3, external: 5, policy: 6 };

async function drawn(source: string) {
  const spec = { source };
  const h = mount(() => MermaidDiagram({ spec, height: 280 }));
  await settle(h);
  return { spec, rendered: mm.render.mock.calls.at(-1)![1] };
}

// Pantheon draws other flowcharts and state diagrams itself; mermaid draws these, which use an
// icon, an image, a fork or a join.
describe('mermaid node kinds', () => {
  it.each([
    [
      'a flowchart with an icon',
      'flowchart LR',
      'flowchart LR\n  a[fa:fa-globe Web]:::client --> b[(Orders)]:::store',
    ],
    [
      'a graph with an image after front matter',
      'graph TB',
      '---\ntitle: Orders\n---\ngraph TB\na@{ img: "https://example.com/a.png" } --> b\nclass b store',
    ],
    [
      'a state diagram with a fork',
      'stateDiagram-v2',
      'stateDiagram-v2\n  state split <<fork>>\n  [*] --> split\n  class split queue',
    ],
    [
      'an older state diagram with a join',
      'stateDiagram',
      '%% states\nstateDiagram\n  state merge <<join>>\n  Idle:::policy --> merge',
    ],
  ])('defines the six kinds right after the header of %s', async (_name, header, source) => {
    const { spec, rendered } = await drawn(source);
    const lines = rendered.split('\n');
    const at = lines.indexOf(header);
    const defs = lines.slice(at + 1, at + 7).map((line) => line.trim().split(/\s+/));
    expect(defs.map(([word, kind]) => [word, kind])).toEqual(
      Object.keys(KINDS).map((kind) => ['classDef', kind]),
    );
    // The model's own lines follow unchanged, and the card keeps showing what the model wrote.
    expect([...lines.slice(0, at + 1), ...lines.slice(at + 7)].join('\n')).toBe(source);
    expect(spec.source).toBe(source);
  });

  it('fills and edges each kind with its series colour mixed into the node surface and edge', async () => {
    const { rendered } = await drawn('flowchart LR\n  a[fa:fa-box A]:::store --> b:::client');
    const styles = Object.fromEntries(
      rendered
        .split('\n')
        .filter((line) => line.trim().startsWith('classDef '))
        .map((line) => {
          const [, kind, style] = line.trim().split(/\s+/);
          return [kind, Object.fromEntries(style!.split(',').map((p) => p.split(':')))];
        }),
    );
    for (const [kind, n] of Object.entries(KINDS)) {
      const series = `token(--series-${n})`;
      expect(styles[kind]).toMatchObject({
        fill: hex(`color-mix(in srgb, ${series} 8%, token(--sf2))`),
        stroke: hex(`color-mix(in srgb, ${series} 45%, token(--bd))`),
      });
    }
  });

  it.each([
    [
      'a state diagram that uses no kind',
      'stateDiagram-v2\n  state split <<fork>>\n  store --> split : client call',
    ],
    [
      'a class diagram with a lollipop interface',
      'classDiagram\n  class Store\n  class Queue:::store\n  Store --() Queue',
    ],
    ['a flowchart that uses no kind', 'flowchart LR\n  a[fa:fa-user A] --> b'],
  ])('leaves the source of %s as written', async (_name, source) => {
    const { rendered } = await drawn(source);
    expect(rendered).toBe(source);
  });
});

describe('mermaid layout settings', () => {
  it('spaces flowcharts and sequences tighter, draws straight edges and sets text in the interface size', async () => {
    await drawn('flowchart LR\n  a[fa:fa-user A] --> b');
    const config = mm.initialize.mock.calls.at(-1)![0];
    expect(config).toMatchObject({
      fontSize: 13,
      flowchart: { nodeSpacing: 24, rankSpacing: 48, curve: 'linear' },
      sequence: { actorMargin: 48, messageMargin: 32, noteMargin: 8 },
    });
  });
});

describe('Vega-Lite chart style', () => {
  async function config() {
    const spec = { mark: 'bar', data: { values: [{ a: 1 }] } };
    const h = mount(() => VegaChart({ spec, height: 280 }));
    await settle(h);
    return vg.embed.mock.calls.at(-1)![2].config;
  }

  it('draws no axis lines or ticks, and a hairline grid on value axes only', async () => {
    const { axis, axisDiscrete } = await config();
    expect(axis).toMatchObject({
      domain: false,
      ticks: false,
      tickSize: 0,
      grid: true,
      gridColor: 'token(--bd2)',
      gridWidth: 0.5,
      labelFontSize: 12,
      labelColor: 'token(--mu)',
      titleFontSize: 12,
      titleFontWeight: 600,
      titleColor: 'token(--tx2)',
    });
    expect(axisDiscrete).toMatchObject({ grid: false });
  });

  it('rounds bars, spaces them, and sizes points and lines', async () => {
    const c = await config();
    expect(c.bar).toMatchObject({ cornerRadius: 3 });
    expect(c.scale).toMatchObject({ barBandPaddingInner: 0.25 });
    expect(c.point).toMatchObject({ size: 48 });
    expect(c.line).toMatchObject({ strokeWidth: 1.5 });
  });

  it('puts the legend on top with round symbols, and the title at the start in the interface type', async () => {
    const c = await config();
    expect(c.font).toBe('token(font-family)');
    expect(c.legend).toMatchObject({
      orient: 'top',
      labelFontSize: 12,
      symbolType: 'circle',
      symbolSize: 64,
    });
    expect(c.title).toMatchObject({
      anchor: 'start',
      fontSize: 13,
      fontWeight: 600,
      color: 'token(--tx)',
      subtitleFontSize: 12,
      subtitleColor: 'token(--mu)',
    });
  });

  it('keeps the labels of a quantitative x axis apart, as in a waterfall of close values', async () => {
    const c = await config();
    const [{ compile }, vega] = await Promise.all([
      import('../../apps/web/node_modules/vega-lite/build/index.js'),
      vi.importActual<any>('../../apps/web/node_modules/vega/build/vega.module.js'),
    ]);
    const spec = {
      width: 580,
      height: 120,
      data: {
        values: [
          { step: 'open', start: 1100, end: 1175 },
          { step: 'close', start: 1175, end: 1250 },
        ],
      },
      mark: 'bar',
      encoding: {
        y: { field: 'step', type: 'nominal' },
        x: { field: 'start', type: 'quantitative', scale: { zero: false } },
        x2: { field: 'end' },
      },
    };
    // No canvas measures text here: Vega estimates label widths, as it does without one.
    vega.textMetrics.width = vega.textMetrics.estimateWidth;
    const view = new vega.View(vega.parse(compile(spec as never, { config: c }).spec), {
      renderer: 'none',
    });
    await view.runAsync();
    type Item = { role?: string; items?: Item[]; text?: string; opacity?: number; bounds: any };
    const labels: Item[] = [];
    const walk = (item: Item) => {
      if (item.role === 'axis-label') labels.push(...(item.items ?? []));
      for (const child of item.items ?? []) if (child) walk(child);
    };
    walk(view.scenegraph().root as unknown as Item);
    // Vega hides a label that would collide; the ones shown are the values along x.
    const shown = labels
      .filter((l) => l.opacity !== 0 && /\d/.test(String(l.text)))
      .sort((a, b) => a.bounds.x1 - b.bounds.x1);
    expect(shown.length).toBeGreaterThan(2);
    const gaps = shown.slice(1).map((l, i) => l.bounds.x1 - shown[i]!.bounds.x2);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(4);
  });
});

describe('sequence diagram text', () => {
  const read = (path: string) =>
    readFileSync(new URL(`../../apps/web/src/${path}`, import.meta.url), 'utf8');
  const index = read('index.css');
  const sheet = read('components/visual/native-diagram.css');
  type Rgb = number[];
  const themes = [':root', '\\.dark'].map((selector) => {
    const block = index.match(new RegExp(`^${selector}\\s*\\{[^}]*color-scheme[^}]*\\}`, 'm'))![0];
    return new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!]));
  });
  // A colour as a theme paints it; what is transparent shows the card's surface under it.
  const paint = (theme: Map<string, string>, value: string): Rgb => {
    if (value === 'transparent') return paint(theme, 'var(--sf)');
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (ref) return paint(theme, theme.get(ref[1]!)!.trim());
    const hex = /^#([0-9a-fA-F]{6})$/.exec(value);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16));
    const mixed = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(value);
    if (!mixed) throw new Error(`cannot paint ${value}`);
    const [a, b, share] = [paint(theme, mixed[1]!), paint(theme, mixed[3]!), +mixed[2]! / 100];
    return a.map((v, i) => v * share + b[i]! * (1 - share));
  };
  const luminance = (rgb: Rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: Rgb, b: Rgb) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const fill = (rule: string) => {
    const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(sheet)?.[1] ?? '';
    return /(?:^|;)\s*fill:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? `no fill in ${rule}`;
  };
  // A participant with a type takes its kind's colour into its card.
  const tones = [
    ...sheet.matchAll(/^\.vis-sq-n\[data-kind='\w+'\] \{\s*--k: (var\(--[\w-]+\));/gm),
  ];
  const card = [
    fill('.vis-sq-nb'),
    ...tones.map((m) => fill('.vis-sq-n[data-kind] .vis-sq-nb').replace('var(--k)', m[1]!)),
  ];
  const segment = fill('.vis-nd-g rect');
  const pairs: [string, string, string[]][] = [
    ['participant title', fill('.vis-sq-t'), card],
    ['participant description', fill('.vis-sq-s'), card],
    ['note', fill('.vis-sq-note text'), [fill('.vis-sq-note rect')]],
    ['segment label', fill('.vis-sq-chip text'), [fill('.vis-sq-chip rect')]],
    ['segment keyword', fill('.vis-sq-kw'), [fill('.vis-sq-chip rect')]],
    ['box label', fill('.vis-nd-gl'), [segment]],
    ['message in a segment', fill('.vis-sq-msg'), [segment, 'var(--sf)']],
    ['message number', fill('.vis-sq-no text'), [fill('.vis-sq-no circle')]],
  ];

  it.each([
    ['light', 0],
    ['dark', 1],
  ])('reads at 4.5:1 or more on its fill in the %s theme', (_name, at) => {
    const theme = themes[at]!;
    expect(tones.length).toBeGreaterThan(0);
    const low = pairs.flatMap(([name, text, fills]) =>
      fills
        .map((under) => ({ under, ratio: contrast(paint(theme, text), paint(theme, under)) }))
        .filter(({ ratio }) => ratio < 4.5)
        .map(({ under, ratio }) => `${name}: ${text} on ${under} ${ratio.toFixed(2)}`),
    );
    expect(low).toEqual([]);
  });
});
