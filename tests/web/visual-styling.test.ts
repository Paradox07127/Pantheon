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

describe('mermaid node kinds', () => {
  it.each([
    ['a flowchart', 'flowchart LR', 'flowchart LR\n  a[Web]:::client --> b[(Orders)]:::store'],
    [
      'a graph after front matter',
      'graph TB',
      '---\ntitle: Orders\n---\ngraph TB\na --> b\nclass b store',
    ],
    ['a state diagram', 'stateDiagram-v2', 'stateDiagram-v2\n  [*] --> Idle\n  class Idle queue'],
    ['an older state diagram', 'stateDiagram', '%% states\nstateDiagram\n  Idle:::policy --> [*]'],
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
    const { rendered } = await drawn('flowchart LR\n  a:::store --> b:::client');
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
    ['a state diagram that uses no kind', 'stateDiagram-v2\n  store --> queue : client call'],
    ['a class diagram', 'classDiagram\n  class Store\n  class Queue:::store'],
    ['a flowchart that uses no kind', 'flowchart LR\n  a --> b'],
  ])('leaves the source of %s as written', async (_name, source) => {
    const { rendered } = await drawn(source);
    expect(rendered).toBe(source);
  });
});

describe('mermaid layout settings', () => {
  it('spaces flowcharts and sequences tighter, draws straight edges and sets text in the interface size', async () => {
    await drawn('flowchart LR\n  a --> b');
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
});
