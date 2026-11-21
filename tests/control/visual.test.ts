import { expect, it } from 'vitest';
import type { Principal, Session, Visual } from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';
import { agentEvent } from '../../packages/control/src/agent.js';
import type { ControlContext } from '../../packages/control/src/context.js';

async function drawings() {
  const f = await workbenchFixture();
  const call = <T = unknown>(type: string, input: Record<string, unknown>, actor = user): T =>
    f.control.execute(actor, command(actor.id, type as CommandType, input)) as T;
  // A project setup session carries the planner credential, whose tools include draw.
  const create = (input: string) =>
    call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input,
      purpose: 'project_setup',
    });
  const session = await create('Draw a chart');
  const principal: Principal = {
    id: `session:${session.id}`,
    role: 'planner',
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60000,
  };
  const draw = (input: Record<string, unknown>, actor = principal) =>
    call<{ visual_id: string; revision: number }>(
      'visual.draw',
      { title: 'Chart', kind: 'mermaid', spec: { source: 'graph LR; a-->b' }, ...input },
      actor,
    );
  return { ...f, create, session, principal, call, draw };
}

it('lets a conductor session draw', async () => {
  const f = await drawings();
  const conductor = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Plan the work',
    purpose: 'conductor',
  });
  const principal: Principal = {
    ...f.principal,
    id: `session:${conductor.id}`,
    role: 'conductor',
    session_id: conductor.id,
  };
  expect(f.draw({}, principal)).toMatchObject({ visual_id: expect.any(String) });
});

it('records drawing progress in the session stream without creating a visual', async () => {
  const f = await drawings();
  const event = {
    key: 'drawing-progress',
    provider_sequence: 1,
    kind: 'visual.drawing' as const,
    tool_call_id: 'drawing-call',
    received_bytes: 1234,
  };
  const ctx = { store: f.store, changed() {} } as ControlContext;
  expect(agentEvent(ctx, f.session.id, event)).toBe(true);
  expect(agentEvent(ctx, f.session.id, event)).toBe(false);
  expect(f.store.events().filter((event) => event.kind === 'visual.drawing')).toMatchObject([
    {
      aggregate_id: f.session.id,
      project_id: f.project.id,
      payload: { tool_call_id: 'drawing-call', received_bytes: 1234 },
    },
  ]);
  expect(f.call('visual.list', { project_id: f.project.id })).toEqual({ visuals: [] });
});

it.each([
  ['vega-lite', { data: { values: [{ x: 1 }] }, mark: 'bar' }],
  [
    'kline',
    {
      candles: [{ time: 1, open: 1, high: 3, low: 0, close: 2, volume: 4 }],
      lines: [{ name: 'Trend', points: [{ time: 1, value: 2 }] }],
    },
  ],
  ['mermaid', { source: 'graph LR; a-->b' }],
  [
    'graph',
    {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', group: 'Group' },
      ],
      edges: [{ from: 'a', to: 'b', label: 'Edge' }],
      direction: 'LR',
    },
  ],
  ['html', { html: '<!doctype html><html><script>const x = 1;</script><body>Chart</body></html>' }],
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
        { name: 'Second', value: null, date: '2026-01-02T12:30:00Z' },
        {},
      ],
      sort: { key: 'value', direction: 'desc' },
    },
  ],
])('stores and reads a %s visual and appends its session event', async (kind, spec) => {
  const f = await drawings();
  const result = f.draw({ kind, spec });
  expect(result).toEqual({ visual_id: expect.any(String), revision: 1 });
  const visual = f.call<Visual>('visual.read', { visual_id: result.visual_id });
  expect(visual).toEqual({
    id: result.visual_id,
    revision: 1,
    project_id: f.project.id,
    session_id: f.session.id,
    title: 'Chart',
    kind,
    spec,
    created_at: expect.any(Number),
    updated_at: expect.any(Number),
  });
  const events = f.store.events().filter((event) => event.kind === 'visual.drawn');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    aggregate_id: f.session.id,
    project_id: f.project.id,
    payload: { visual_id: visual.id, title: 'Chart', kind, revision: 1 },
  });
});

it.each([
  ['vega-lite', { layer: [{ data: { url: 'https://example.com/data' } }] }, /spec.*data.*url/s],
  [
    'kline',
    { candles: [2, 1].map((time) => ({ time, open: 1, high: 2, low: 0, close: 1 })) },
    /candles.*1.*time.*increasing/s,
  ],
  ['mermaid', { source: '' }, /source/],
  [
    'graph',
    { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'missing' }] },
    /edges.*0.*to.*missing/s,
  ],
  ['html', { html: 'x'.repeat(524289) }, /html/],
  [
    'table',
    {
      columns: [{ key: 'value', title: 'Value', type: 'number' }],
      rows: [{ value: 'invalid' }],
    },
    /rows.*0.*value/s,
  ],
  ['mermaid', null, /spec/],
])(
  'keeps an invalid %s spec and its field error while refusing the command',
  async (kind, spec, message) => {
    const f = await drawings();
    expect(() => f.draw({ kind, spec })).toThrow(message);
    const visuals = f.call<{ visuals: Visual[] }>('visual.list', {
      project_id: f.project.id,
    }).visuals;
    expect(visuals).toHaveLength(1);
    expect(visuals[0]).toMatchObject({ title: 'Chart', kind, spec, error: expect.any(Array) });
    expect(f.call('visual.read', { visual_id: visuals[0]!.id })).toEqual(visuals[0]);
    expect(f.store.events().filter((event) => event.kind === 'visual.drawn')).toMatchObject([
      { payload: { visual_id: visuals[0]!.id, title: 'Chart', kind, revision: 1, failed: true } },
    ]);
  },
);

it.each(['S', 'M', 'L'])(
  'stores source and display height %s independently of the pin',
  async (size) => {
    const f = await drawings();
    const first = f.draw({ source: 'data/results.csv', size, pin: 'M' });
    const read = () => f.call<Visual>('visual.read', { visual_id: first.visual_id });
    expect(read()).toMatchObject({
      source: 'data/results.csv',
      size,
      pin: { size: 'M', position: 0 },
    });
    f.draw({ replaces: first.visual_id, source: 'SELECT value FROM results', size: 'L' });
    expect(read()).toMatchObject({ source: 'SELECT value FROM results', size: 'L', revision: 2 });
    f.draw({ replaces: first.visual_id });
    expect(read()).not.toHaveProperty('source');
    expect(read()).not.toHaveProperty('size');
    expect(read().pin).toEqual({ size: 'M', position: 0 });
  },
);

it('keeps raw failed specs, caps stored issues and clears them on a successful replacement', async () => {
  const f = await drawings();
  const spec = {
    nodes: [{ id: 'a', label: 'A' }],
    edges: Array.from({ length: 25 }, () => ({ from: 'a', to: 'missing' })),
  };
  expect(() => f.draw({ kind: 'graph', spec, source: 'query', size: 'S' })).toThrow();
  const failed = f.call<{ visuals: Visual[] }>('visual.list', { project_id: f.project.id })
    .visuals[0]!;
  expect(failed).toMatchObject({ spec, source: 'query', size: 'S' });
  expect(failed.error).toEqual(
    Array.from({ length: 20 }, (_, index) => ({
      message: 'Missing node id: missing',
      path: ['edges', index, 'to'],
    })),
  );
  expect(f.draw({ replaces: failed.id })).toEqual({ visual_id: failed.id, revision: 2 });
  const repaired = f.call<Visual>('visual.read', { visual_id: failed.id });
  expect(repaired).not.toHaveProperty('error');
  expect(repaired).not.toHaveProperty('source');
  expect(repaired).not.toHaveProperty('size');
  expect(
    f.store
      .events()
      .filter((event) => event.kind === 'visual.drawn')
      .at(-1)!.payload,
  ).toEqual({
    visual_id: failed.id,
    title: 'Chart',
    kind: 'mermaid',
    revision: 2,
  });
  expect(() =>
    f.draw({ replaces: failed.id, spec: { source: '', extra: 'keep this field' } }),
  ).toThrow();
  expect(f.call('visual.read', { visual_id: failed.id })).toMatchObject({
    revision: 3,
    spec: { source: '', extra: 'keep this field' },
    error: expect.any(Array),
  });
});

it('replays the same validation error without drawing again on a failed command retry', async () => {
  const f = await drawings();
  const input = {
    title: 'Chart',
    kind: 'graph',
    spec: {
      nodes: [{ id: 'a', label: 'A' }],
      edges: [{ from: 'a', to: 'missing' }],
    },
  };
  const request = command(f.principal.id, 'visual.draw', input);
  for (let attempt = 0; attempt < 2; attempt++)
    expect(() => f.control.execute(f.principal, request)).toThrow(
      expect.objectContaining({
        name: 'ZodError',
        issues: [
          {
            code: 'custom',
            message: 'Missing node id: missing',
            path: ['spec', 'edges', 0, 'to'],
          },
        ],
      }),
    );
  expect(
    f.call<{ visuals: Visual[] }>('visual.list', { project_id: f.project.id }).visuals,
  ).toHaveLength(1);
  expect(f.store.events().filter((event) => event.kind === 'visual.drawn')).toHaveLength(1);
});

it.each([
  { title: '' },
  { title: 'x'.repeat(121) },
  { kind: 'unknown' },
  { replaces: '' },
  { replaces: 'missing' },
  { source: 'x'.repeat(501) },
  { source: 'first\nsecond' },
  { source: 'first\rsecond' },
  { size: 'XL' },
])('keeps nothing when the draw envelope is invalid: %j', async (input) => {
  const f = await drawings();
  expect(() => f.draw({ spec: { source: '' }, ...input })).toThrow();
  expect(f.call('visual.list', { project_id: f.project.id })).toEqual({ visuals: [] });
  expect(f.store.events().filter((event) => event.kind === 'visual.drawn')).toEqual([]);
});

it('redraws in place while keeping the pin and refuses a different session', async () => {
  const f = await drawings();
  const first = f.draw({ pin: 'M' });
  const before = f.call<Visual>('visual.read', { visual_id: first.visual_id });
  const redraw = f.draw({
    replaces: first.visual_id,
    title: 'Redrawn',
    kind: 'html',
    spec: { html: '<html>Updated</html>' },
  });
  expect(redraw).toEqual({ visual_id: first.visual_id, revision: 2 });
  expect(f.call('visual.read', { visual_id: first.visual_id })).toMatchObject({
    ...before,
    revision: 2,
    title: 'Redrawn',
    kind: 'html',
    spec: { html: '<html>Updated</html>' },
    updated_at: expect.any(Number),
  });
  const other = await f.create('Other session');
  expect(() =>
    f.draw(
      { replaces: first.visual_id, kind: 'mermaid', spec: { source: '' } },
      { ...f.principal, id: `session:${other.id}`, session_id: other.id },
    ),
  ).toThrow(/replaces.*same session/);
  expect(f.store.events().filter((event) => event.kind === 'visual.drawn')).toHaveLength(2);
  expect(f.call<Visual>('visual.read', { visual_id: first.visual_id })).not.toHaveProperty('error');
});

it('pins, resizes, unpins and arranges exactly the pinned project set', async () => {
  const f = await drawings();
  const first = f.draw({});
  const second = f.draw({ pin: 'S' });
  const third = f.draw({});
  const list = () =>
    f.call<{ visuals: Visual[] }>('visual.list', { project_id: f.project.id, pinned: true })
      .visuals;
  f.call('visual.pin', { visual_id: first.visual_id, size: 'M' });
  f.call('visual.pin', { visual_id: second.visual_id, size: 'L' });
  expect(list().map((v) => [v.id, v.pin, v.revision])).toEqual([
    [second.visual_id, { size: 'L', position: 0 }, 1],
    [first.visual_id, { size: 'M', position: 1 }, 1],
  ]);
  for (const order of [
    [first.visual_id],
    [first.visual_id, first.visual_id],
    [first.visual_id, second.visual_id, third.visual_id],
  ])
    expect(() => f.call('visual.arrange', { project_id: f.project.id, order })).toThrow(
      /order.*pinned/,
    );
  f.call('visual.arrange', {
    project_id: f.project.id,
    order: [first.visual_id, second.visual_id],
  });
  expect(list().map((v) => [v.id, v.pin?.position])).toEqual([
    [first.visual_id, 0],
    [second.visual_id, 1],
  ]);
  f.call('visual.unpin', { visual_id: first.visual_id });
  expect(list().map((v) => v.id)).toEqual([second.visual_id]);
  expect(f.call<Visual>('visual.read', { visual_id: first.visual_id })).not.toHaveProperty('pin');
  expect(
    f
      .call<{ visuals: Visual[] }>('visual.list', { project_id: f.project.id, pinned: false })
      .visuals.map((v) => v.id),
  ).toEqual([third.visual_id, second.visual_id, first.visual_id]);
});

it('records which visuals a pin, an arrangement and an unpin changed', async () => {
  const f = await drawings();
  const first = f.draw({});
  const second = f.draw({});
  f.call('visual.pin', { visual_id: first.visual_id, size: 'M' });
  f.call('visual.pin', { visual_id: second.visual_id, size: 'S' });
  f.call('visual.arrange', {
    project_id: f.project.id,
    order: [second.visual_id, first.visual_id],
  });
  f.call('visual.unpin', { visual_id: first.visual_id });
  expect(
    f.store
      .events()
      .filter((event) => event.kind === 'visual.changed')
      .map((event) => [event.project_id, event.payload]),
  ).toEqual([
    [f.project.id, { visual_ids: [first.visual_id] }],
    [f.project.id, { visual_ids: [second.visual_id] }],
    [f.project.id, { visual_ids: [second.visual_id, first.visual_id] }],
    [f.project.id, { visual_ids: [first.visual_id] }],
  ]);
});

it('stores a pin width, keeps an omitted width and applies an explicit new width', async () => {
  const f = await drawings();
  const first = f.draw({});
  const read = () => f.call<Visual>('visual.read', { visual_id: first.visual_id });
  expect(
    f.call<Visual>('visual.pin', { visual_id: first.visual_id, size: 'M', width: 8 }).pin,
  ).toEqual({ size: 'M', width: 8, position: 0 });
  expect(read().pin).toEqual({ size: 'M', width: 8, position: 0 });
  f.call('visual.pin', { visual_id: first.visual_id, size: 'S' });
  expect(read().pin).toEqual({ size: 'S', width: 8, position: 0 });
  f.call('visual.pin', { visual_id: first.visual_id, size: 'L', width: 12 });
  expect(read().pin).toEqual({ size: 'L', width: 12, position: 0 });
  expect(read().revision).toBe(1);
});

it('keeps pin size, width and position on replacement and width on arrangement', async () => {
  const f = await drawings();
  const first = f.draw({ pin: 'S' });
  const second = f.draw({});
  f.call('visual.pin', { visual_id: second.visual_id, size: 'L', width: 6 });
  const redraw = f.draw({ replaces: second.visual_id });
  expect(redraw.revision).toBe(2);
  expect(f.call<Visual>('visual.read', { visual_id: second.visual_id }).pin).toEqual({
    size: 'L',
    width: 6,
    position: 1,
  });
  f.call('visual.arrange', {
    project_id: f.project.id,
    order: [second.visual_id, first.visual_id],
  });
  expect(f.call<Visual>('visual.read', { visual_id: second.visual_id }).pin).toEqual({
    size: 'L',
    width: 6,
    position: 0,
  });
  expect(f.call<Visual>('visual.read', { visual_id: first.visual_id }).pin).toEqual({
    size: 'S',
    position: 1,
  });
  f.draw({ replaces: second.visual_id, pin: 'M' });
  expect(f.call<Visual>('visual.read', { visual_id: second.visual_id }).pin).toEqual({
    size: 'M',
    width: 6,
    position: 0,
  });
});

it('lists at most 200 newest visuals and filters by session and project', async () => {
  const f = await drawings();
  const ids = Array.from({ length: 202 }, () => f.draw({}).visual_id);
  expect(
    f
      .call<{ visuals: Visual[] }>('visual.list', { project_id: f.project.id })
      .visuals.map((v) => v.id),
  ).toEqual(ids.slice(-200).reverse());
  expect(
    f.call('visual.list', { project_id: f.project.id, session_id: 'another-session' }),
  ).toEqual({ visuals: [] });
  expect(
    f.call('visual.list', { project_id: f.project.id, session_id: f.session.id }),
  ).toMatchObject({ visuals: expect.any(Array) });
});

it('removes unpinned visuals with their session and detaches pinned visuals', async () => {
  const f = await drawings();
  const unpinned = f.draw({});
  const pinned = f.draw({ pin: 'L' });
  const current = f.store.must<Session>('sessions', f.session.id);
  f.control.execute(
    user,
    command(user.id, 'session.delete', { session_id: current.id }, current.revision),
  );
  expect(f.store.get('sessions', current.id)).toBeUndefined();
  expect(() => f.call('visual.read', { visual_id: unpinned.visual_id })).toThrow(
    expect.objectContaining({ code: 'not_found' }),
  );
  expect(f.call('visual.read', { visual_id: pinned.visual_id })).toMatchObject({
    session_id: null,
    pin: { size: 'L', position: 0 },
    revision: 1,
  });
});

it('requires a session credential to draw and user authority for board commands', async () => {
  const f = await drawings();
  expect(() => f.draw({}, user)).toThrow(/session/i);
  const visual = f.draw({});
  for (const [type, input] of [
    ['visual.read', { visual_id: visual.visual_id }],
    ['visual.list', { project_id: f.project.id }],
    ['visual.pin', { visual_id: visual.visual_id, size: 'S' }],
    ['visual.unpin', { visual_id: visual.visual_id }],
    ['visual.arrange', { project_id: f.project.id, order: [] }],
  ] as const)
    expect(() => f.call(type, input, f.principal)).toThrow(/session role/);
});
