import { expect, it } from 'vitest';
import { inputSchemas, sessionTools, visualDrawInputSchema, visualSpecs } from '@pantheon/protocol';

it.each(['S', 'M', 'L'])('accepts an optional source and display height %s', (size) => {
  const input = {
    title: 'Chart',
    kind: 'mermaid',
    spec: { source: 'graph LR' },
    source: 'x'.repeat(500),
    size,
  };
  expect(visualDrawInputSchema.parse(input)).toEqual(input);
  expect(inputSchemas['visual.draw'].parse(input)).toEqual(input);
});

it.each([
  'x'.repeat(501),
  'first\nsecond',
  'first\n',
  'first\rsecond',
  'first\r',
  'first\u2028second',
  'first\u2029second',
  42,
  null,
])('rejects a source that is not a single line of at most 500 characters: %j', (source) => {
  const result = visualDrawInputSchema.safeParse({
    title: 'Chart',
    kind: 'mermaid',
    spec: { source: 'graph LR' },
    source,
  });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['source'] }));
});

it.each(['XL', 's', 1, null])('rejects an invalid display height %j', (size) => {
  const result = visualDrawInputSchema.safeParse({
    title: 'Chart',
    kind: 'mermaid',
    spec: { source: 'graph LR' },
    size,
  });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['size'] }));
});

it('leaves kind spec validation to the draw handler without dropping the raw spec', () => {
  const input = { title: 'Chart', kind: 'mermaid', spec: { source: '', extra: 'raw' } };
  expect(inputSchemas['visual.draw'].parse(input)).toEqual(input);
});

it('offers draw to planners, leads and workers only', () => {
  for (const role of ['planner', 'lead', 'worker'] as const)
    expect(sessionTools[role]).toHaveProperty('draw', 'visual.draw');
  expect(sessionTools.reviewer).not.toHaveProperty('draw');
});

it.each([
  ['vega-lite', { data: { values: [{ x: 1 }] }, mark: 'bar' }],
  ['kline', { candles: [{ time: '2026-01-01', open: 1, high: 3, low: 0, close: 2 }] }],
  ['mermaid', { source: 'graph LR; a-->b' }],
  ['graph', { nodes: [{ id: 'a', label: 'A' }], edges: [] }],
  ['html', { html: '<!doctype html><html><body>Chart</body></html>' }],
  [
    'table',
    {
      columns: [
        { key: 'name', title: 'Name', type: 'text' },
        { key: 'value', title: 'Value', type: 'number' },
        { key: 'date', title: 'Date', type: 'date' },
      ],
      rows: [
        { name: 'First', value: 2, date: '2026-01-01' },
        { name: '', value: null, date: '2026-01-02T12:30:00Z' },
        { name: null, date: '2026-01-02T12:30:00+08:00' },
        { date: '2026-01-02T12:30:00' },
        { name: null, value: null, date: null },
        {},
      ],
      sort: { key: 'value', direction: 'desc' },
    },
  ],
])('accepts an inline %s visual', (kind, spec) => {
  expect(inputSchemas['visual.draw'].safeParse({ title: 'Chart', kind, spec }).success).toBe(true);
});

it.each([4, 6, 8, 12])('accepts a pin width of %i columns', (width) => {
  expect(inputSchemas['visual.pin'].parse({ visual_id: 'chart', size: 'M', width })).toEqual({
    visual_id: 'chart',
    size: 'M',
    width,
  });
});

it.each([0, 5, 7, 10, 16, 6.5, '6', null])('rejects pin width %s at its field', (width) => {
  const result = inputSchemas['visual.pin'].safeParse({ visual_id: 'chart', size: 'M', width });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['width'] }));
});

it('accepts a pin without adding a width and still requires its height', () => {
  expect(inputSchemas['visual.pin'].parse({ visual_id: 'chart', size: 'S' })).toEqual({
    visual_id: 'chart',
    size: 'S',
  });
  expect(inputSchemas['visual.pin'].safeParse({ visual_id: 'chart', width: 6 }).success).toBe(
    false,
  );
});

it('keeps draw pinning limited to a height step', () => {
  expect(
    inputSchemas['visual.draw'].safeParse({
      title: 'Chart',
      kind: 'mermaid',
      spec: { source: 'graph LR' },
      pin: 'M',
      width: 6,
    }).success,
  ).toBe(false);
});

it('accepts an empty table and the column and row limits', () => {
  for (const spec of [
    { columns: [{ key: 'name', title: 'Name', type: 'text' }], rows: [] },
    {
      columns: Array.from({ length: 24 }, (_, index) => ({
        key: `column-${index}`,
        title: 'Column',
        type: 'text',
      })),
      rows: Array.from({ length: 2000 }, () => ({})),
      sort: { key: 'column-0', direction: 'asc' },
    },
    {
      columns: [{ key: 'k'.repeat(40), title: 't'.repeat(80), type: 'text' }],
      rows: [{ ['k'.repeat(40)]: 'v'.repeat(400) }],
    },
  ])
    expect(visualSpecs.table.safeParse(spec).success).toBe(true);
});

it('accepts a table at exactly 512 KB and refuses the next byte', () => {
  const spec = {
    columns: [{ key: 'value', title: 'Value', type: 'text' }],
    rows: Array.from({ length: 1400 }, () => ({ value: '' })),
  };
  let remaining = 512 * 1024 - new TextEncoder().encode(JSON.stringify(spec)).byteLength;
  for (const row of spec.rows) {
    const length = Math.min(400, remaining);
    row.value = 'x'.repeat(length);
    remaining -= length;
  }
  expect(remaining).toBe(0);
  expect(visualSpecs.table.safeParse(spec).success).toBe(true);
  spec.rows.at(-1)!.value += 'x';
  const result = visualSpecs.table.safeParse(spec);
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: [], message: 'spec JSON must be at most 512 KB' }),
    );
});

it.each([
  [
    'duplicate column key',
    {
      columns: [
        { key: 'value', title: 'First', type: 'number' },
        { key: 'value', title: 'Second', type: 'number' },
      ],
      rows: [],
    },
    ['columns', 1, 'key'],
  ],
  ['unknown row key', { rows: [{ other: 1 }] }, ['rows', 0, 'other']],
  ['string in a number column', { rows: [{ value: '2' }] }, ['rows', 0, 'value']],
  ['nonfinite cell', { rows: [{ value: Infinity }] }, ['rows', 0, 'value']],
  ['boolean cell', { rows: [{ value: true }] }, ['rows', 0, 'value']],
  [
    'number in a text column',
    { columns: [{ key: 'value', title: 'Value', type: 'text' }], rows: [{ value: 2 }] },
    ['rows', 0, 'value'],
  ],
  [
    'long text cell',
    {
      columns: [{ key: 'value', title: 'Value', type: 'text' }],
      rows: [{ value: 'x'.repeat(401) }],
    },
    ['rows', 0, 'value'],
  ],
  ...['yesterday', '2026-02-30', 123].map((value) => [
    'invalid ISO date',
    { columns: [{ key: 'value', title: 'Date', type: 'date' }], rows: [{ value }] },
    ['rows', 0, 'value'],
  ]),
  ['unknown sort column', { sort: { key: 'other', direction: 'asc' } }, ['sort', 'key']],
  ['invalid sort direction', { sort: { key: 'value', direction: 'up' } }, ['sort', 'direction']],
  ['no columns', { columns: [] }, ['columns']],
  ...['', 'k'.repeat(41)].map((key) => [
    'invalid column key length',
    { columns: [{ key, title: 'Value', type: 'number' }] },
    ['columns', 0, 'key'],
  ]),
  ...['', 't'.repeat(81)].map((title) => [
    'invalid column title length',
    { columns: [{ key: 'value', title, type: 'number' }] },
    ['columns', 0, 'title'],
  ]),
  [
    'invalid column type',
    { columns: [{ key: 'value', title: 'Value', type: 'boolean' }] },
    ['columns', 0, 'type'],
  ],
  [
    'too many columns',
    {
      columns: Array.from({ length: 25 }, (_, index) => ({
        key: `column-${index}`,
        title: 'Column',
        type: 'number',
      })),
    },
    ['columns'],
  ],
  ['too many rows', { rows: Array.from({ length: 2001 }, () => ({})) }, ['rows']],
  [
    'spec above the UTF-8 byte limit',
    {
      columns: [{ key: 'value', title: 'Value', type: 'text' }],
      rows: Array.from({ length: 2000 }, () => ({ value: '字'.repeat(100) })),
    },
    [],
  ],
] as [string, Record<string, unknown>, (string | number)[]][])(
  'rejects a table with %s at the bad value',
  (_reason, changes, path) => {
    const result = visualSpecs.table.safeParse({
      columns: [{ key: 'value', title: 'Value', type: 'number' }],
      rows: [],
      ...changes,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(expect.objectContaining({ path }));
  },
);

it('accepts inline rows with a url field and refuses each data loader url', () => {
  const rows = {
    data: { values: [{ url: 'https://example.com', count: 1, data: { url: 'https://a.b' } }] },
    mark: 'bar',
    encoding: { x: { field: 'url', type: 'nominal' } },
  };
  expect(visualSpecs['vega-lite'].safeParse(rows).success).toBe(true);
  const lookup = {
    ...rows,
    transform: [
      { lookup: 'url', from: { data: { url: 'https://example.com/b.json' }, key: 'url' } },
    ],
  };
  for (const [spec, path] of [
    [{ data: { url: 'https://example.com/a.json' } }, ['data', 'url']],
    [lookup, ['transform', 0, 'from', 'data', 'url']],
  ] as const) {
    const result = visualSpecs['vega-lite'].safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(expect.objectContaining({ path }));
  }
});

it.each([
  ['vega-lite', { layer: [{ data: { url: 'https://example.com/data.json' } }] }, 'url'],
  ['vega-lite', { data: { values: ['字'.repeat(180000)] } }, '512 KB'],
  [
    'kline',
    { candles: [1, 1].map((time) => ({ time, open: 1, high: 2, low: 0, close: 1 })) },
    'time',
  ],
  [
    'kline',
    { candles: [1, '2026-01-02'].map((time) => ({ time, open: 1, high: 2, low: 0, close: 1 })) },
    'time',
  ],
  ['kline', { candles: [{ time: 'yesterday', open: 1, high: 2, low: 0, close: 1 }] }, 'time'],
  ['kline', { candles: [{ time: 1, open: Infinity, high: 2, low: 0, close: 1 }] }, 'open'],
  [
    'kline',
    {
      candles: [{ time: 1, open: 1, high: 2, low: 0, close: 1 }],
      lines: [
        {
          name: 'Trend',
          points: [
            { time: 2, value: 1 },
            { time: 1, value: 2 },
          ],
        },
      ],
    },
    'time',
  ],
  ['mermaid', { source: '' }, 'source'],
  ['graph', { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'missing' }] }, 'to'],
  [
    'graph',
    {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'Again' },
      ],
      edges: [],
    },
    'id',
  ],
  ['html', { html: 'x'.repeat(524289) }, 'html'],
])('rejects invalid %s spec with the field path', (kind, spec, field) => {
  const result = visualSpecs[kind as keyof typeof visualSpecs].safeParse(spec);
  expect(result.success).toBe(false);
  if (!result.success) expect(JSON.stringify(result.error.issues)).toContain(field);
});

it('accepts a graph with node kinds, detail lines, sources, edge styles and nested groups', () => {
  const spec = {
    nodes: [
      {
        id: 'api',
        label: 'API',
        kind: 'service',
        sublabel: 'src/server.ts',
        sources: ['file:src/server.ts:12'],
        group: 'core',
      },
      { id: 'db', label: 'Orders', kind: 'store', group: 'data' },
      { id: 'web', label: 'Web', kind: 'client', group: 'frontend' },
    ],
    edges: [
      { from: 'web', to: 'api', style: 'main', label: 'checkout' },
      { from: 'api', to: 'db', style: 'data' },
      { from: 'db', to: 'api', style: 'return' },
      { from: 'api', to: 'api', style: 'async' },
    ],
    groups: [
      { id: 'core', label: 'Core' },
      { id: 'data', label: 'Data', parent: 'core' },
    ],
  };
  expect(visualSpecs.graph.safeParse(spec).success).toBe(true);
});

it('accepts a graph node with an icon, a color, a status and detail lines, and color meanings', () => {
  const spec = {
    nodes: [
      {
        id: 'api',
        label: 'API',
        icon: 'server',
        color: 'orange',
        status: 'failed',
        detail: ['retries 3 times', 'x'.repeat(48), 'owned by payments'],
      },
    ],
    edges: [],
    colors: { orange: 'PII path', blue: 'public' },
  };
  expect(visualSpecs.graph.safeParse(spec).success).toBe(true);
});

it.each([
  [
    'an unknown node kind',
    { nodes: [{ id: 'a', label: 'A', kind: 'database' }], edges: [] },
    'kind',
  ],
  [
    'an unknown edge style',
    {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'a', to: 'b', style: 'dotted' }],
    },
    'style',
  ],
  [
    'a group whose parent is missing',
    {
      nodes: [{ id: 'a', label: 'A', group: 'core' }],
      edges: [],
      groups: [{ id: 'core', label: 'Core', parent: 'platform' }],
    },
    'Missing group id: platform',
  ],
  [
    'groups that are each inside the other',
    {
      nodes: [{ id: 'a', label: 'A', group: 'core' }],
      edges: [],
      groups: [
        { id: 'core', label: 'Core', parent: 'data' },
        { id: 'data', label: 'Data', parent: 'core' },
      ],
    },
    'form a cycle',
  ],
  [
    'a group inside itself',
    { nodes: [{ id: 'a', label: 'A' }], edges: [], groups: [{ id: 'g', label: 'G', parent: 'g' }] },
    'form a cycle',
  ],
  [
    'two groups with one id',
    {
      nodes: [{ id: 'a', label: 'A' }],
      edges: [],
      groups: [
        { id: 'g', label: 'G' },
        { id: 'g', label: 'Again' },
      ],
    },
    'Duplicate group id: g',
  ],
  [
    'a source that is not a file or commit',
    { nodes: [{ id: 'a', label: 'A', sources: ['README.md'] }], edges: [] },
    'sources',
  ],
  [
    'an unknown icon',
    { nodes: [{ id: 'api', label: 'API', icon: 'spaceship' }], edges: [] },
    'Node api: icon spaceship is not one of monitor, smartphone, globe',
  ],
  [
    'an unknown color',
    { nodes: [{ id: 'api', label: 'API', color: 'pink' }], edges: [] },
    'Node api: color pink is not one of blue, teal, orange, violet, gray, green',
  ],
  [
    'an unknown status',
    { nodes: [{ id: 'api', label: 'API', status: 'paused' }], edges: [] },
    'Node api: status paused is not one of waiting, running, done, failed, blocked',
  ],
  [
    'a fourth detail line',
    { nodes: [{ id: 'api', label: 'API', detail: ['a', 'b', 'c', 'd'] }], edges: [] },
    'Node api: detail has at most 3 lines',
  ],
  [
    'a detail line of 49 characters',
    { nodes: [{ id: 'api', label: 'API', detail: ['ok', 'x'.repeat(49)] }], edges: [] },
    'Node api: detail line 2 is longer than 48 characters',
  ],
  [
    'a meaning for an unknown color',
    { nodes: [{ id: 'api', label: 'API' }], edges: [], colors: { pink: 'hot' } },
    'colors',
  ],
])('rejects a graph with %s', (_, spec, issue) => {
  const result = visualSpecs.graph.safeParse(spec);
  expect(result.success).toBe(false);
  if (!result.success) expect(JSON.stringify(result.error.issues)).toContain(issue);
});

it('declares strict user commands and bounds visual titles', () => {
  for (const [type, input] of [
    ['visual.read', { visual_id: 'chart' }],
    ['visual.list', { project_id: 'project', pinned: true, session_id: 'session' }],
    ['visual.pin', { visual_id: 'chart', size: 'M' }],
    ['visual.unpin', { visual_id: 'chart' }],
    ['visual.arrange', { project_id: 'project', order: ['chart'] }],
  ] as const) {
    expect(inputSchemas[type].safeParse(input).success).toBe(true);
    expect(inputSchemas[type].safeParse({ ...input, extra: true }).success).toBe(false);
  }
  for (const title of ['', 'x'.repeat(121)])
    expect(
      inputSchemas['visual.draw'].safeParse({
        title,
        kind: 'mermaid',
        spec: { source: 'graph LR' },
      }).success,
    ).toBe(false);
  expect(
    inputSchemas['visual.draw'].safeParse({
      title: 'Chart',
      kind: 'html',
      spec: { html: 'x' },
      session_id: 'session',
    }).success,
  ).toBe(false);
});
