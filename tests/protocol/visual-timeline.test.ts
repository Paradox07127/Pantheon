import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { inputSchemas, visualSpecs } from '@pantheon/protocol';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/timeline/${name}.json`, import.meta.url), 'utf8'));
const incident = fixture('payment-incident');
const checkout = fixture('checkout-waterfall');

it.each([
  ['an incident timeline', incident],
  ['a checkout waterfall', checkout],
])('accepts %s', (_, spec) => {
  expect(visualSpecs.timeline.safeParse(spec).success).toBe(true);
  expect(
    inputSchemas['visual.draw'].safeParse({ title: 'Timeline', kind: 'timeline', spec }).success,
  ).toBe(true);
});

it('accepts events and spans on one clock in Unix ms and ISO date-times', () => {
  const spec = {
    unit: 'time',
    items: [
      { id: 'start', label: 'Start', at: 1_763_431_200_000 },
      { id: 'build', label: 'Build', at: '2025-11-18T10:00:00Z', end: '2025-11-18T10:04:00Z' },
      { id: 'test', label: 'Test', at: '2025-11-18T10:01:00Z', end: 1_763_460_300_000 },
    ],
  };
  expect(visualSpecs.timeline.safeParse(spec).success).toBe(true);
});

const event = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  label: id,
  at: 10,
  ...more,
});

it.each([
  [
    'an unknown lane',
    { lanes: [{ id: 'release', label: 'Release' }], items: [event('deploy', { lane: 'ops' })] },
    ['items', 0, 'lane'],
    'Item deploy: missing lane id: ops',
  ],
  [
    'a duplicate id',
    { items: [event('deploy'), event('deploy')] },
    ['items', 1, 'id'],
    'Duplicate item id: deploy',
  ],
  [
    'an end before its start',
    { items: [event('build', { at: 20, end: 10 })] },
    ['items', 0, 'end'],
    'Item build: end is before at',
  ],
  [
    'an unknown group',
    { items: [event('deploy', { group: 'change' })] },
    ['items', 0, 'group'],
    'Item deploy: missing group id: change',
  ],
  [
    'a parent that is no item',
    { items: [event('build', { end: 20, parent: 'pipeline' })] },
    ['items', 0, 'parent'],
    'Item build: missing parent id: pipeline',
  ],
  [
    'a parent that is an event',
    { items: [event('deploy'), event('build', { end: 20, parent: 'deploy' })] },
    ['items', 1, 'parent'],
    'Item build: parent deploy is an event; only spans nest',
  ],
  [
    'an event with a parent',
    { items: [event('build', { end: 20 }), event('deploy', { parent: 'build' })] },
    ['items', 1, 'parent'],
    'Item deploy: only a span, an item with end, takes a parent',
  ],
  [
    'spans that are each the parent of the other',
    {
      items: [
        event('build', { end: 20, parent: 'test' }),
        event('test', { end: 20, parent: 'build' }),
      ],
    },
    ['items', 0, 'parent'],
    'Item build: its parents form a cycle',
  ],
  [
    'a date-time on an ms axis',
    { unit: 'ms', items: [event('build', { at: '2025-11-18T10:00:00Z' })] },
    ['items', 0, 'at'],
    'Item build: unit ms takes numbers of ms',
  ],
  [
    'a time that is no date or number',
    { items: [event('build', { at: 'yesterday' })] },
    ['items', 0, 'at'],
    undefined,
  ],
  [
    'an unknown time zone',
    { timezone: 'Mars/Olympus', items: [event('build')] },
    ['timezone'],
    'timezone must be an IANA time zone, such as Asia/Shanghai',
  ],
  [
    'two lanes with one id',
    {
      lanes: [
        { id: 'ops', label: 'Ops' },
        { id: 'ops', label: 'Again' },
      ],
      items: [event('build')],
    },
    ['lanes', 1, 'id'],
    'Duplicate lane id: ops',
  ],
  [
    'more than 200 items',
    { items: Array.from({ length: 201 }, (_, index) => event(`item-${index}`)) },
    ['items'],
    undefined,
  ],
  ['no items', { items: [] }, ['items'], undefined],
] as [string, Record<string, unknown>, (string | number)[], string | undefined][])(
  'rejects a timeline with %s at that item',
  (_, spec, path, message) => {
    const result = visualSpecs.timeline.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path, ...(message && { message }) }),
      );
  },
);
