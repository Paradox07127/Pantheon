import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { HookHost, find, named, nodes } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);

import type { VisualContent } from '@pantheon/domain';
import { TimelineChart } from '@/components/visual/TimelineChart';
import { layoutTimeline, type TimelineSpec } from '@/components/visual/timeline-layout';
import { VisualFrame } from '@/components/visual/VisualCard';
import { zh } from './i18n-setup.js';

const fixture = (name: string): TimelineSpec =>
  JSON.parse(readFileSync(new URL(`../fixtures/timeline/${name}.json`, import.meta.url), 'utf8'));
const incident = fixture('payment-incident');
const checkout = fixture('checkout-waterfall');

type Box = { x: number; y: number; width: number; height: number };
const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

const hosts: HookHost<any>[] = [];
// Gives the measured box its width before the effects read it.
function mount<T>(body: () => T, width: number) {
  const h = new HookHost(body, (tree) => {
    for (const node of nodes(tree as ReactNode))
      if (node.props.ref && typeof node.props.ref === 'object')
        node.props.ref.current ??= { clientWidth: width };
  });
  hosts.push(h);
  h.render();
  return h;
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
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

describe('timeline layout', () => {
  it('moves the later of two close events on a lane to a second row inside the lane', () => {
    const spec: TimelineSpec = {
      unit: 'time',
      timezone: 'UTC',
      lanes: [
        { id: 'ops', label: 'Operations' },
        { id: 'quiet', label: 'Quiet' },
      ],
      items: [
        {
          id: 'page',
          label: 'Pager fires for checkout',
          detail: 'Error rate crosses the paging threshold for five minutes.',
          lane: 'ops',
          at: '2026-11-18T10:00:00Z',
        },
        {
          id: 'ack',
          label: 'On-call acknowledges',
          detail: 'Starts the incident channel.',
          lane: 'ops',
          at: '2026-11-18T10:00:30Z',
        },
        { id: 'note', label: 'Status page note', lane: 'quiet', at: '2026-11-18T10:20:00Z' },
      ],
    };
    for (const width of [480, 760, 1200]) {
      const layout = layoutTimeline(spec, width);
      const [page, ack] = ['page', 'ack'].map((id) => layout.events.find((e) => e.item.id === id)!);
      expect(apart(page!.box, ack!.box)).toBe(true);
      expect(ack!.box.y).toBeGreaterThanOrEqual(page!.box.y + page!.box.height);
      const [ops, quiet] = layout.lanes;
      for (const shown of [page!, ack!]) {
        expect(shown.box.y).toBeGreaterThanOrEqual(ops!.y);
        expect(shown.box.y + shown.box.height).toBeLessThanOrEqual(ops!.y + ops!.height);
      }
      // The quiet lane takes the one row it needs, not the height of the busy one.
      expect(quiet!.height).toBeLessThan(ops!.height);
    }
  });

  it('keeps every event of the incident timeline clear of the others', () => {
    for (const width of [480, 760, 1200]) {
      const { events } = layoutTimeline(incident, width);
      expect(events).toHaveLength(5);
      for (const a of events)
        for (const b of events) if (a !== b) expect(apart(a.box, b.box)).toBe(true);
      // Each event keeps a title and at most two lines of detail.
      for (const shown of events) expect(shown.lines.length).toBeLessThanOrEqual(2);
    }
  });

  it('indents each child span under its parent and orders siblings by start', () => {
    const items = checkout.items;
    const spec: TimelineSpec = {
      ...checkout,
      // Declared out of order, with a grandchild under the inventory lookup; the lookup and the
      // discount start together, so their declared order stands.
      items: [
        items[5]!,
        items[4]!,
        { id: 'reserve', label: 'Reserve stock', at: 250, end: 380, parent: 'inventory' },
        items[0]!,
        items[2]!,
        items[3]!,
        items[1]!,
      ],
    };
    const { spans } = layoutTimeline(spec, 760);
    expect(spans.map((span) => span.item.id)).toEqual([
      'checkout',
      'authenticate',
      'inventory',
      'reserve',
      'discount',
      'payment',
      'order',
    ]);
    const at = new Map(spans.map((span) => [span.item.id, span]));
    expect(at.get('authenticate')!.label.x).toBe(at.get('checkout')!.label.x + 16);
    expect(at.get('reserve')!.label.x).toBe(at.get('inventory')!.label.x + 16);
    expect(at.get('payment')!.label.x).toBe(at.get('authenticate')!.label.x);
    for (let i = 1; i < spans.length; i++)
      expect(spans[i]!.y).toBeGreaterThanOrEqual(spans[i - 1]!.y + spans[i - 1]!.bar.height);
    // A bar starts and ends at its times on the shared axis.
    const zero = at.get('checkout')!.bar.x;
    const payment = at.get('payment')!.bar;
    expect(at.get('order')!.bar.x).toBeCloseTo(payment.x + payment.width, 5);
    expect(at.get('authenticate')!.bar.x).toBe(zero);
  });

  it('writes each duration beside its bar, inside it where it would leave the plot', () => {
    const { spans, width } = layoutTimeline(checkout, 480);
    for (const span of spans) {
      const end = span.bar.x + span.bar.width;
      expect(span.duration.text).not.toBe('');
      if (span.duration.inside) expect(span.duration.x).toBeLessThanOrEqual(end);
      else expect(span.duration.x).toBeGreaterThan(end);
      expect(span.duration.x).toBeLessThanOrEqual(width);
    }
  });

  it.each([
    ['the incident timeline', incident],
    ['the checkout waterfall', checkout],
    [
      'a run over three days',
      {
        unit: 'time',
        timezone: 'Asia/Shanghai',
        items: [
          { id: 'open', label: 'Opened', at: '2026-11-16T09:00:00+08:00' },
          { id: 'merge', label: 'Merged', at: '2026-11-18T17:45:00+08:00' },
        ],
      },
    ],
    [
      'a trace of seconds',
      {
        unit: 'ms',
        items: [
          { id: 'job', label: 'Job', at: 0, end: 48_000 },
          { id: 'step', label: 'Step', at: 1200, end: 9400, parent: 'job' },
        ],
      },
    ],
  ] as [string, TimelineSpec][])('spaces the axis labels of %s at 480px and 1200px', (_, spec) => {
    for (const width of [480, 1200]) {
      const { ticks } = layoutTimeline(spec, width);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(8);
      for (let i = 1; i < ticks.length; i++) {
        const [before, tick] = [ticks[i - 1]!, ticks[i]!];
        expect(tick.x - tick.width / 2 - (before.x + before.width / 2)).toBeGreaterThanOrEqual(8);
      }
      expect(new Set(ticks.map((tick) => tick.label)).size).toBe(ticks.length);
    }
  });

  it('labels the clock in the spec time zone and the waterfall in ms', () => {
    expect(layoutTimeline(incident, 760).ticks.map((tick) => tick.label)).toEqual([
      '10:00',
      '10:05',
      '10:10',
      '10:15',
      '10:20',
    ]);
    expect(layoutTimeline(checkout, 760).ticks.map((tick) => tick.label)).toEqual([
      '0',
      '200',
      '400',
      '600',
      '800',
      '1000',
      '1200',
    ]);
  });

  it('lists each group with its count, only when there are two or more', () => {
    expect(layoutTimeline(checkout, 760).legend.map((g) => [g.label, g.count])).toEqual([
      ['checkout-api', 3],
      ['identity', 1],
      ['inventory', 1],
      ['payments', 1],
    ]);
    const one = { ...checkout, groups: [checkout.groups![0]!] };
    expect(
      layoutTimeline(
        {
          ...one,
          items: one.items.map(({ group: _, ...item }) => ({ ...item, group: 'checkout-api' })),
        },
        760,
      ).legend,
    ).toEqual([]);
  });
});

describe('timeline chart', () => {
  const draw = (spec: TimelineSpec, width = 760) =>
    mount(() => TimelineChart({ spec, height: 280 }), width);
  const reachable = (tree: ReactNode) => nodes(tree).filter((n) => n.props.tabIndex === 0);

  it('gives every item a keyboard stop named by its label, time and detail', () => {
    for (const spec of [incident, checkout]) {
      const h = draw(spec);
      const stops = reachable(h.value).map((n) => n.props['aria-label'] as string);
      expect(stops).toHaveLength(spec.items.length);
      for (const item of spec.items) {
        const name = stops.find((stop) => stop.startsWith(item.label));
        expect(name, item.label).toBeDefined();
        if (item.detail) expect(name).toContain(item.detail);
      }
    }
    const stops = reachable(draw(incident).value).map((n) => n.props['aria-label']);
    expect(stops[0]).toContain('10:00');
    const spans = reachable(draw(checkout).value).map((n) => n.props['aria-label']);
    expect(spans[0]).toContain('1200');
  });

  it('sums up the lanes, the items and the range on the picture', () => {
    const svg = find(draw(incident).value, (n) => n.type === 'svg');
    expect(svg.props.role).toBe('img');
    const label = svg.props['aria-label'] as string;
    expect(label).toContain('3');
    expect(label).toContain('5');
    expect(label).toContain('10:00');
    expect(label).toContain('10:20');
  });

  it('dims the other items while one is hovered or focused', () => {
    const h = draw(checkout);
    const marks = () => nodes(h.value).filter((n) => n.props['data-item'] !== undefined);
    expect(marks().every((n) => n.props['data-focus'] === undefined)).toBe(true);
    reachable(h.value)[1]!.props.onMouseEnter();
    h.render();
    const focus = marks().map((n) => [n.props['data-item'], n.props['data-focus']]);
    expect(focus).toContainEqual(['authenticate', 'on']);
    expect(focus).toContainEqual(['checkout', 'dim']);
    reachable(h.value)[1]!.props.onMouseLeave();
    h.render();
    expect(marks().every((n) => n.props['data-focus'] === undefined)).toBe(true);
    reachable(h.value)[2]!.props.onFocus();
    h.render();
    expect(marks().filter((n) => n.props['data-focus'] === 'on')).toHaveLength(1);
  });

  it('shows the legend under its name with each group and count', () => {
    const legend = find(
      draw(checkout).value,
      (n) => n.type === 'ul' && n.props['aria-label'] === zh('visual.timeline.legend'),
    );
    expect(nodes(legend).filter((n) => n.type === 'li')).toHaveLength(4);
  });
});

describe('a timeline card', () => {
  it('draws the timeline with its spec and keeps its items in reach', () => {
    const content: VisualContent = { kind: 'timeline', spec: incident };
    const frame = mount(() => VisualFrame({ title: 'Incident', content, size: 'M' }), 760);
    const chart = named(frame.value, 'TimelineChart') as ReactElement<any>;
    expect(chart.props.spec).toEqual(incident);
    const picture = find(frame.value, (n) => n.props.className === 'vis-body');
    // Its items take the keyboard focus, which an image role would hide.
    expect(picture.props.role).toBe('group');
    expect(picture.props['aria-label']).toContain('Incident');
    expect(picture.props['aria-label']).toContain(zh('visual.timeline.kind'));
  });
});
