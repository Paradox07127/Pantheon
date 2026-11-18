import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { HookHost, find, named, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);

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

import { MermaidDiagram } from '@/components/visual/MermaidDiagram';
import { nativeType, parseMermaid } from '@/components/visual/mermaid-model';
import type { Mermaid } from '../../apps/web/node_modules/mermaid/dist/mermaid.js';
import { zh, zhf } from './i18n-setup.js';

// Mermaid cleans flowchart and state labels with DOMPurify, which finds no DOM here to clean
// with; mermaid's own copy lets labels through as written.
const purify = createRequire(
  realpathSync(
    fileURLToPath(new URL('../../apps/web/node_modules/mermaid/package.json', import.meta.url)),
  ),
)
  .resolve('dompurify')
  .replace(/purify\.cjs\.js$/, 'purify.es.mjs');
Object.assign((await import(pathToFileURL(purify).href)).default, {
  sanitize: (label: string) => label,
  addHook() {},
});

// The real parser: these tests read what mermaid itself makes of a source.
const { default: mermaid } = await vi.importActual<{ default: Mermaid }>(
  '../../apps/web/node_modules/mermaid/dist/mermaid.core.mjs',
);
// ELK's layout code binds the globals it finds when the first ELK is made, so that happens before
// a test stubs window.
new (await import('../../apps/web/node_modules/elkjs/lib/elk.bundled.js')).default();

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

// Dynamic imports and the layout take more than a few microtasks to land.
async function settle(h: HookHost<any>) {
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.flush();
  }
}

/** The elements a tree draws, with the hook-free components in it rendered in place. */
function drawn(tree: ReactNode): ReactElement<any>[] {
  if (Array.isArray(tree)) return tree.flatMap(drawn);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as ReactElement<any>;
  if (typeof node.type === 'function')
    return drawn((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...drawn(node.props.children)];
}
const words = (node: ReactElement<any>): string =>
  [node, ...drawn(node.props.children)]
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .join(' ');

/** The words of each entry in the legend under a diagram Pantheon draws; none without one. */
function legend(h: HookHost<any>): string[] {
  const shown = nodes(h.value).find(
    (n) => typeof n.type === 'function' && n.type.name === 'NativeLegend',
  );
  if (!shown) return [];
  const list = drawn(shown).find((n) => n.type === 'ul')!;
  expect(list.props['aria-label']).toBe(zh('visual.graph.legend'));
  return drawn(list.props.children)
    .filter((n) => n.type === 'li')
    .map(words);
}

/** Draws a source in a box of the given size and returns what the diagram component drew. */
async function picture(source: string, component: string, box = { width: 1200, height: 720 }) {
  const spec = { source };
  const h = mount(() => MermaidDiagram({ spec, height: box.height }));
  const at = nodes(h.value).find((n) => n.props.ref?.current)!.props.ref.current;
  Object.defineProperties(at, {
    clientWidth: { value: box.width },
    clientHeight: { value: box.height },
  });
  await settle(h);
  const shown = named(h.value, component);
  const inner = mount(() => (shown.type as (props: unknown) => ReactNode)(shown.props));
  const elements = drawn(inner.value);
  return { h, elements, svg: elements.find((n) => n.type === 'svg')! };
}

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => sizes[name] ?? '#808080',
  }));
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
});
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ORDERS = `erDiagram
  customer["customer · accounts"] {
    bigint id PK
    varchar(255) email UK "login name"
    bigint org_id FK,UK
  }
  customer ||--o{ order : "places"
  order }|..|| customer : ""
  order |o--|{ line : has`;

const CHECKOUT = `sequenceDiagram
  autonumber
  actor user as User<br/>browser session
  participant api as API
  participant db@{ "type": "database" }
  user->>+api: open
  api-)db: write
  db-->>api: rows
  api-->>-user: done
  Note right of db: slow disk
  Note over user,api: handshake
  loop every 5s
    api->>db: poll
    alt hit
      db-->>api: row
    else miss
      db--)api: none
    end
  end
  api-->db: ping`;

const SHOP = `flowchart LR
  subgraph shop [Shop]
    web[Storefront]:::client
    api["Orders API<br>src/api"]
    subgraph data [Data]
      db[(Orders DB)]
      jobs[(Jobs)]:::queue
    end
  end
  check{Paid?}
  web ==> api
  api --> check
  check -->|yes| db
  check -.->|later| jobs
  api <--> auth[Auth]
  class auth policy
  classDef slow fill:#f00
  style api fill:#0f0
  linkStyle 0 stroke:#f00
  click web "https://example.com"`;

const ORDER = `stateDiagram-v2
  [*] --> Idle
  Idle --> Checkout : buy
  state Checkout {
    state paid <<choice>>
    [*] --> Paying
    Paying --> paid
    paid --> Done : ok
    paid --> Paying : retry
    Done --> [*]
  }
  Checkout --> [*]
  note right of Idle : waits for a cart
  class Idle queue`;

const SHAPES = `classDiagram
  direction TB
  namespace Geometry {
    class Shape {
      <<interface>>
      +area() double
    }
    class Square~T~ {
      -int side
      label: String
      +area() double
      +resize(int factor)$ void
    }
  }
  class Canvas["Drawing canvas"] {
    #List~Shape~ shapes
    +draw()*
  }
  class Base
  <<abstract>> Base
  Shape <|.. Square : implements
  Base <|-- Canvas
  Canvas "1" *-- "many" Shape : holds
  Square --o Canvas
  Canvas --> Base
  Square ..> Base
  Base -- Shape
  note for Canvas "draws in order\\nback to front"
  click Canvas href "https://example.com"
  style Base fill:#f00`;

describe('mermaid model', () => {
  it.each([
    ['a flowchart', 'flowchart LR\n  a --> b', 'flowchart'],
    [
      'a graph after front matter and a comment',
      '---\ntitle: x\n---\n%% c\ngraph TD\n  a --> b',
      'flowchart',
    ],
    ['a state diagram', 'stateDiagram-v2\n  [*] --> a', 'state'],
    ['an older state diagram', 'stateDiagram\n  [*] --> a', 'state'],
    ['an ER diagram', 'erDiagram\n  a ||--o{ b : has', 'er'],
    [
      'a state diagram with a fork',
      'stateDiagram-v2\n  state split <<fork>>\n  [*] --> split\n  split --> a\n  split --> b',
      undefined,
    ],
    [
      'a state diagram with a join',
      'stateDiagram-v2\n  state merge <<join>>\n  a --> merge\n  b --> merge',
      undefined,
    ],
    [
      'a state diagram with concurrent regions',
      'stateDiagram-v2\n  state Active {\n    a --> b\n    --\n    c --> d\n  }',
      undefined,
    ],
    ['a flowchart with an icon in a label', 'flowchart LR\n  a[fa:fa-user Web] --> b', undefined],
    [
      'a flowchart with an icon node',
      'flowchart LR\n  a@{ icon: "fa:user", label: "Web" } --> b',
      undefined,
    ],
    [
      'a flowchart with an image node',
      'flowchart LR\n  a@{ img: "https://example.com/a.png" } --> b',
      undefined,
    ],
    ['a class diagram', 'classDiagram\n  A <|-- B', 'class'],
    ['a newer class diagram', 'classDiagram-v2\n  A <|-- B', 'class'],
    ['a class diagram with a lollipop interface', 'classDiagram\n  A --() B', undefined],
    ['a class diagram with a lollipop on the left', 'classDiagram\n  B ()-- A', undefined],
  ])('draws %s as Pantheon type %s', (_name, source, type) => {
    expect(nativeType(source)).toBe(type);
  });

  it('reads a flowchart as a graph with its groups, kinds, decisions and edge styles', async () => {
    expect(await parseMermaid(mermaid, SHOP, 'flowchart')).toEqual({
      type: 'flowchart',
      model: {
        direction: 'LR',
        nodes: [
          { id: 'web', label: 'Storefront', kind: 'client', group: 'shop' },
          { id: 'api', label: 'Orders API', sublabel: 'src/api', group: 'shop' },
          { id: 'db', label: 'Orders DB', kind: 'store', group: 'data' },
          { id: 'jobs', label: 'Jobs', kind: 'queue', group: 'data' },
          { id: 'check', label: 'Paid?', shape: 'decision' },
          { id: 'auth', label: 'Auth', kind: 'policy' },
        ],
        edges: [
          { from: 'web', to: 'api', style: 'main' },
          { from: 'api', to: 'check' },
          { from: 'check', to: 'db', label: 'yes' },
          { from: 'check', to: 'jobs', label: 'later', style: 'async' },
          // Both ways: the graph draws one edge with a head at each end.
          { from: 'api', to: 'auth' },
          { from: 'auth', to: 'api' },
        ],
        groups: [
          { id: 'data', label: 'Data', parent: 'shop' },
          { id: 'shop', label: 'Shop' },
        ],
      },
    });
  });

  it('reads a state diagram with start and end dots in each scope, a choice and a composite state', async () => {
    const [start, end] = [zh('visual.graph.start'), zh('visual.graph.end')];
    const step = (from: string, to: string, label?: string) => ({
      from,
      to,
      ...(label && { label }),
    });
    expect(await parseMermaid(mermaid, ORDER, 'state')).toEqual({
      type: 'state',
      model: {
        nodes: [
          { id: 'root_start', label: start, shape: 'start' },
          { id: 'Idle', label: 'Idle', kind: 'queue' },
          { id: 'paid', label: 'paid', shape: 'decision', group: 'Checkout' },
          { id: 'Checkout_start', label: start, shape: 'start', group: 'Checkout' },
          { id: 'Paying', label: 'Paying', group: 'Checkout' },
          { id: 'Done', label: 'Done', group: 'Checkout' },
          { id: 'Checkout_end', label: end, shape: 'end', group: 'Checkout' },
          { id: 'root_end', label: end, shape: 'end' },
        ],
        // The note and its line are left out.
        edges: [
          step('root_start', 'Idle'),
          step('Idle', 'Checkout', 'buy'),
          step('Checkout_start', 'Paying'),
          step('Paying', 'paid'),
          step('paid', 'Done', 'ok'),
          step('paid', 'Paying', 'retry'),
          step('Done', 'Checkout_end'),
          step('Checkout', 'root_end'),
        ],
        groups: [{ id: 'Checkout', label: 'Checkout' }],
      },
    });
  });

  it.each([
    ['a flowchart written left to right', 'flowchart LR\n  a --> b', 'flowchart', 'LR'],
    ['a graph written bottom to top', 'graph BT\n  a --> b', 'flowchart', 'TB'],
    [
      'a state diagram set left to right',
      'stateDiagram-v2\n  direction LR\n  a --> b',
      'state',
      'LR',
    ],
    [
      'a state diagram set right to left',
      'stateDiagram-v2\n  direction RL\n  a --> b',
      'state',
      'LR',
    ],
    [
      'a state diagram set bottom to top',
      'stateDiagram-v2\n  a --> b\n  direction BT',
      'state',
      'TB',
    ],
    ['a state diagram that sets no direction', 'stateDiagram-v2\n  a --> b', 'state', undefined],
    [
      'a state diagram that sets one only inside a composite state',
      'stateDiagram-v2\n  state c {\n    direction LR\n    a --> b\n  }',
      'state',
      undefined,
    ],
  ] as const)('reads the direction of %s', async (_name, source, type, direction) => {
    const { model } = (await parseMermaid(mermaid, source, type)) as any;
    expect(model.direction).toBe(direction);
  });

  it.each([
    [
      'a state diagram',
      'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Live\n  class Live done\n  class Draft orange',
      'state',
    ],
    ['a flowchart', 'flowchart LR\n  Draft:::orange --> Live\n  class Live done', 'flowchart'],
  ] as const)(
    'reads a status class and a colour class of %s as the status and colour of its nodes',
    async (_name, source, type) => {
      const { model } = (await parseMermaid(mermaid, source, type)) as any;
      const of = (id: string) => model.nodes.find((n: { id: string }) => n.id === id);
      expect(of('Live')).toMatchObject({ status: 'done' });
      expect(of('Live').color).toBeUndefined();
      expect(of('Draft')).toMatchObject({ color: 'orange' });
      expect(of('Draft').status).toBeUndefined();
    },
  );

  it('reads classes with their generic, annotation and members, and the namespace they sit in', async () => {
    const { model } = (await parseMermaid(mermaid, SHAPES, 'class')) as any;
    const member = (visibility: string, name: string, type: string, more = {}) => ({
      visibility,
      name,
      type,
      ...more,
    });
    expect(model.classes).toEqual([
      {
        id: 'Shape',
        label: 'Shape',
        annotations: ['interface'],
        attributes: [],
        methods: [member('+', 'area()', 'double')],
        namespace: 'Geometry',
      },
      {
        id: 'Square',
        label: 'Square',
        generic: 'T',
        annotations: [],
        attributes: [member('-', 'side', 'int'), member('', 'label', 'String')],
        methods: [
          member('+', 'area()', 'double'),
          member('+', 'resize(int factor)', 'void', { classifier: 'static' }),
        ],
        namespace: 'Geometry',
      },
      {
        id: 'Canvas',
        label: 'Drawing canvas',
        annotations: [],
        attributes: [member('#', 'shapes', 'List<Shape>')],
        methods: [member('+', 'draw()', '', { classifier: 'abstract' })],
      },
      { id: 'Base', label: 'Base', annotations: ['abstract'], attributes: [], methods: [] },
    ]);
    expect(model.namespaces).toEqual([{ id: 'Geometry', label: 'Geometry' }]);
    expect(model.notes).toEqual([{ lines: ['draws in order', 'back to front'], for: 'Canvas' }]);
    expect(model.direction).toBe('TB');
  });

  it('reads each relation with its kind, the UML end at each class, its cardinalities and label', async () => {
    const { model } = (await parseMermaid(mermaid, SHAPES, 'class')) as any;
    expect(model.relations).toEqual([
      {
        from: 'Shape',
        to: 'Square',
        kind: 'realization',
        fromEnd: 'inheritance',
        dashed: true,
        label: 'implements',
      },
      {
        from: 'Base',
        to: 'Canvas',
        kind: 'inheritance',
        fromEnd: 'inheritance',
        dashed: false,
        label: '',
      },
      {
        from: 'Canvas',
        to: 'Shape',
        kind: 'composition',
        fromEnd: 'composition',
        dashed: false,
        label: 'holds',
        fromCardinality: '1',
        toCardinality: 'many',
      },
      // The diamond is at the whole, which the relation then starts from.
      {
        from: 'Canvas',
        to: 'Square',
        kind: 'aggregation',
        fromEnd: 'aggregation',
        dashed: false,
        label: '',
      },
      { from: 'Canvas', to: 'Base', kind: 'association', toEnd: 'arrow', dashed: false, label: '' },
      { from: 'Square', to: 'Base', kind: 'dependency', toEnd: 'arrow', dashed: true, label: '' },
      { from: 'Base', to: 'Shape', kind: 'link', dashed: false, label: '' },
    ]);
  });

  it('reads tables with their attribute types, keys and comments, and the alias after the name', async () => {
    const { model } = (await parseMermaid(mermaid, ORDERS, 'er')) as any;
    expect(model.entities).toEqual([
      {
        id: 'customer',
        alias: 'accounts',
        attributes: [
          { type: 'bigint', name: 'id', keys: ['PK'], comment: '' },
          { type: 'varchar(255)', name: 'email', keys: ['UK'], comment: 'login name' },
          { type: 'bigint', name: 'org_id', keys: ['FK', 'UK'], comment: '' },
        ],
      },
      { id: 'order', attributes: [] },
      { id: 'line', attributes: [] },
    ]);
  });

  it('reads both cardinalities of each relationship, whether it identifies, and its label', async () => {
    const { model } = (await parseMermaid(mermaid, ORDERS, 'er')) as any;
    expect(model.relationships).toEqual([
      {
        from: 'customer',
        to: 'order',
        fromCardinality: 'one',
        toCardinality: 'zero-or-more',
        identifying: true,
        label: 'places',
      },
      {
        from: 'order',
        to: 'customer',
        fromCardinality: 'one-or-more',
        toCardinality: 'one',
        identifying: false,
        label: '',
      },
      {
        from: 'order',
        to: 'line',
        fromCardinality: 'zero-or-one',
        toCardinality: 'one-or-more',
        identifying: true,
        label: 'has',
      },
    ]);
  });

  it('reads participants with their type and the description under their title', async () => {
    const { model } = (await parseMermaid(mermaid, CHECKOUT, 'sequence')) as any;
    expect(model.participants).toEqual([
      { id: 'user', title: 'User', description: 'browser session', type: 'actor' },
      { id: 'api', title: 'API' },
      { id: 'db', title: 'db', type: 'database' },
    ]);
    expect(model.autonumber).toBe(true);
  });

  it('reads message kinds, notes, activations and nested segments with their else branch', async () => {
    const { model } = (await parseMermaid(mermaid, CHECKOUT, 'sequence')) as any;
    const message = (from: string, to: string, text: string, kind: string, number: number) => ({
      item: 'message',
      from,
      to,
      text,
      kind,
      number,
    });
    expect(model.items).toEqual([
      message('user', 'api', 'open', 'sync', 1),
      { item: 'activate', participant: 'api' },
      message('api', 'db', 'write', 'async', 2),
      message('db', 'api', 'rows', 'reply', 3),
      message('api', 'user', 'done', 'reply', 4),
      { item: 'deactivate', participant: 'api' },
      { item: 'note', placement: 'right', participants: ['db'], text: 'slow disk' },
      { item: 'note', placement: 'over', participants: ['user', 'api'], text: 'handshake' },
      {
        item: 'segment',
        kind: 'loop',
        branches: [
          {
            label: 'every 5s',
            items: [
              message('api', 'db', 'poll', 'sync', 5),
              {
                item: 'segment',
                kind: 'alt',
                branches: [
                  { label: 'hit', items: [message('db', 'api', 'row', 'reply', 6)] },
                  { label: 'miss', items: [message('db', 'api', 'none', 'async', 7)] },
                ],
              },
            ],
          },
        ],
      },
      message('api', 'db', 'ping', 'dotted', 8),
    ]);
  });
});

describe('ER diagram', () => {
  it('draws its own tables instead of mermaid picture, named by its counts', async () => {
    const render = vi.spyOn(mermaid, 'render');
    const { svg, elements } = await picture(ORDERS, 'ErDiagram');
    expect(render).not.toHaveBeenCalled();
    expect(svg.props.role).toBe('img');
    expect(svg.props['aria-label']).toBe(zhf('visual.mermaid.er', { tables: 3, relationships: 3 }));
    const shown = elements.map(words).join(' ');
    for (const word of ['customer', 'accounts', 'email', 'varchar(255)', 'FK,UK', 'places'])
      expect(shown).toContain(word);
  });

  it("marks each cardinality with its own crow's foot", async () => {
    const source = `erDiagram
  hub ||--|| badge : a
  hub ||--o| photo : b
  hub ||--|{ item : c
  hub ||--o{ event : d`;
    const { elements } = await picture(source, 'ErDiagram');
    const marks = new Map<string, { strokes: number; circle: boolean }>();
    for (const mark of elements.filter((n) => n.props['data-cardinality'])) {
      const parts = drawn(mark.props.children);
      const path = parts.find((n) => n.type === 'path')!.props.d as string;
      marks.set(mark.props['data-cardinality'], {
        strokes: path.split('M').length - 1,
        circle: parts.some((n) => n.type === 'circle'),
      });
    }
    // A bar for each one, a circle for zero, three prongs and a bar or circle for many.
    expect(Object.fromEntries(marks)).toEqual({
      one: { strokes: 2, circle: false },
      'zero-or-one': { strokes: 1, circle: true },
      'one-or-more': { strokes: 4, circle: false },
      'zero-or-more': { strokes: 3, circle: true },
    });
  });

  it('lists the key badges and cardinality ends it uses in a legend', async () => {
    const { h } = await picture(ORDERS, 'ErDiagram');
    const ends = ['one', 'zeroOrOne', 'oneOrMore', 'zeroOrMore'];
    expect(legend(h)).toEqual([
      `PK ${zh('visual.mermaid.key.primary')}`,
      `FK ${zh('visual.mermaid.key.foreign')}`,
      `UK ${zh('visual.mermaid.key.unique')}`,
      ...ends.map((end) => zh(`visual.mermaid.cardinality.${end}`)),
    ]);
    const one = await picture('erDiagram\n  a ||--|| b : has', 'ErDiagram');
    expect(legend(one.h)).toEqual([]);
  });

  it('shows the error mermaid gives for a source it cannot parse, and draws nothing', async () => {
    const render = vi.spyOn(mermaid, 'render');
    const source = 'erDiagram\n  customer ||--o order : places';
    const expected = await mermaid.parse(source).catch((error: Error) => error.message);
    const h = mount(() => MermaidDiagram({ spec: { source }, height: 280 }));
    await expect(settle(h)).rejects.toThrow(expected as string);
    expect(expected).toMatch(/^Parse error on line 2/);
    expect(render).not.toHaveBeenCalled();
  });
});

describe('sequence diagram', () => {
  it('draws its own participants and rows, named by its counts', async () => {
    const render = vi.spyOn(mermaid, 'render');
    const { svg, elements } = await picture(CHECKOUT, 'SequenceDiagram');
    expect(render).not.toHaveBeenCalled();
    expect(svg.props.role).toBe('img');
    expect(svg.props['aria-label']).toBe(
      zhf('visual.mermaid.sequence', { participants: 3, messages: 8, segments: 2 }),
    );
    const shown = elements.map(words).join(' ');
    for (const word of ['User', 'browser session', 'slow disk', 'handshake', 'ping'])
      expect(shown).toContain(word);
  });

  it('colours each participant by the node kind of its type', async () => {
    const source = `sequenceDiagram
  actor user
  participant web@{ "type": "boundary" }
  participant jobs@{ "type": "queue" }
  participant db@{ "type": "database" }
  participant log
  user->>web: go`;
    const { elements } = await picture(source, 'SequenceDiagram');
    const kinds = Object.fromEntries(
      ['user', 'web', 'jobs', 'db', 'log'].map((title) => [
        title,
        elements.find((n) => n.type === 'g' && words(n) === title)?.props['data-kind'],
      ]),
    );
    expect(kinds).toEqual({
      user: 'client',
      web: 'service',
      jobs: 'queue',
      db: 'store',
      log: undefined,
    });
  });

  it('lists the participant kinds and message styles it uses in a legend', async () => {
    const { h } = await picture(CHECKOUT, 'SequenceDiagram');
    const kind = (name: string) => `${zh(`visual.graph.kind.${name}`)} 1`;
    const message = (name: string) => zh(`visual.mermaid.message.${name}`);
    expect(legend(h)).toEqual([
      kind('client'),
      kind('store'),
      message('sync'),
      message('async'),
      message('reply'),
      message('dotted'),
    ]);
    const plain = await picture(
      'sequenceDiagram\n  participant a\n  participant b\n  a->>b: hi',
      'SequenceDiagram',
    );
    expect(legend(plain.h)).toEqual([]);
  });

  it('labels each segment and branch with its keyword and text', async () => {
    const { elements } = await picture(CHECKOUT, 'SequenceDiagram');
    const texts = elements.filter((n) => n.type === 'text').map(words);
    expect(texts).toEqual(expect.arrayContaining(['loop every 5s', 'alt hit', 'else miss']));
  });

  it('numbers the messages in order', async () => {
    const { elements } = await picture(CHECKOUT, 'SequenceDiagram');
    const numbers = elements
      .filter((n) => n.type === 'text' && typeof n.props.children === 'number')
      .map((n) => n.props.children);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('repeats the participants under the lifelines only in a tall diagram', async () => {
    const titles = (elements: ReactElement<any>[]) =>
      elements.filter((n) => n.type === 'text' && n.props.children === 'API').length;
    const head = 'sequenceDiagram\n  participant user\n  participant api as API\n';
    const short = await picture(`${head}  user->>api: hello`, 'SequenceDiagram');
    const rows = Array.from({ length: 16 }, (_, i) => `  user->>api: step ${i}`).join('\n');
    const tall = await picture(`${head}${rows}`, 'SequenceDiagram');
    expect([titles(short.elements), titles(tall.elements)]).toEqual([1, 2]);
  });

  it('fits a wide diagram into its box no smaller than two thirds, then scrolls', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `  participant p${i} as Participant ${i}`);
    const source = `sequenceDiagram\n${many.join('\n')}\n  p0->>p11: across`;
    const { svg } = await picture(source, 'SequenceDiagram', { width: 600, height: 280 });
    const [, , width] = (svg.props.viewBox as string).split(' ').map(Number);
    expect(svg.props.width / width!).toBeCloseTo(2 / 3);
    const small = await picture(CHECKOUT, 'SequenceDiagram', { width: 4000, height: 4000 });
    const [, , natural] = (small.svg.props.viewBox as string).split(' ').map(Number);
    expect(small.svg.props.width).toBe(natural);
  });
});

describe('class diagram', () => {
  it('draws its own class cards, namespace and note instead of mermaid picture, named by its counts', async () => {
    const render = vi.spyOn(mermaid, 'render');
    const { svg, elements } = await picture(SHAPES, 'ClassDiagram');
    expect(render).not.toHaveBeenCalled();
    expect(svg.props.role).toBe('img');
    expect(svg.props['aria-label']).toBe(zhf('visual.mermaid.class', { classes: 4, relations: 7 }));
    const texts = elements.filter((n) => n.type === 'text').map(words);
    for (const word of [
      'Shape',
      'Square <T>',
      'Drawing canvas',
      'Base',
      '«interface»',
      '«abstract»',
      'area()',
      'double',
      'side',
      'int',
      'label',
      'String',
      'resize(int factor)',
      'void',
      'shapes',
      'List<Shape>',
      'draw()',
      'implements',
      'holds',
      '1',
      'many',
      'Geometry',
      'draws in order',
      'back to front',
    ])
      expect(texts).toContain(word);
  });

  it('ends each relation with its UML mark, dashed for realization and dependency', async () => {
    const { elements } = await picture(SHAPES, 'ClassDiagram');
    const relations = elements
      .filter((n) => n.props['data-relation'])
      .map((n) => [
        n.props['data-relation'],
        n.props['data-dashed'],
        drawn(n.props.children)
          .filter((part) => part.props['data-end'])
          .map((part) => part.props['data-end']),
      ]);
    expect(relations).toEqual([
      ['realization', true, ['inheritance']],
      ['inheritance', false, ['inheritance']],
      ['composition', false, ['composition']],
      ['aggregation', false, ['aggregation']],
      ['association', false, ['arrow']],
      ['dependency', true, ['arrow']],
      ['link', false, []],
    ]);
  });

  it('lists the relation kinds it uses in a legend', async () => {
    const { h } = await picture(SHAPES, 'ClassDiagram');
    expect(legend(h)).toEqual(
      [
        'inheritance',
        'realization',
        'composition',
        'aggregation',
        'association',
        'dependency',
        'link',
      ].map((kind) => zh(`visual.mermaid.relation.${kind}`)),
    );
  });

  it('leaves a class diagram with a lollipop interface to mermaid', async () => {
    const render = vi.spyOn(mermaid, 'render').mockResolvedValue({ svg: '<svg></svg>' } as never);
    const source = 'classDiagram\n  class Shape\n  Shape --() Drawable';
    const h = mount(() => MermaidDiagram({ spec: { source }, height: 280 }));
    await settle(h);
    expect(render).toHaveBeenCalledWith(expect.any(String), source);
    expect(
      nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'ClassDiagram'),
    ).toBe(false);
  });
});

describe('flowchart and state diagram', () => {
  // The graph the diagram hands its parse to, laid out by ELK in a box of the given size.
  async function graph(source: string, more: object = {}) {
    const h = mount(() => MermaidDiagram({ spec: { source }, height: 420, ...more }));
    await settle(h);
    const shown = named(h.value, 'GraphDiagram');
    const g = mount(() => (shown.type as (props: unknown) => ReactNode)(shown.props));
    Object.defineProperties(find(g.value, (n) => n.props.ref?.current).props.ref.current, {
      clientWidth: { value: 1200 },
      clientHeight: { value: 420 },
    });
    for (let i = 0; i < 10 && !nodes(g.value).some((n) => n.type === xy.ReactFlow); i++)
      await settle(g);
    return { shown, flow: find(g.value, (n) => n.type === xy.ReactFlow) };
  }
  const kind = (label: string, name: string) =>
    zhf('visual.graph.node', { label, kind: zh(`visual.graph.kind.${name}`) });

  it("draws a flowchart with Pantheon's node cards, named by their labels, instead of mermaid's picture", async () => {
    const render = vi.spyOn(mermaid, 'render');
    const { flow } = await graph(SHOP);
    expect(render).not.toHaveBeenCalled();
    const cards = flow.props.nodes.filter((n: { type: string }) => n.type === 'card');
    expect(cards.map((n: { ariaLabel: string }) => n.ariaLabel)).toEqual([
      kind('Storefront', 'client'),
      'Orders API',
      kind('Orders DB', 'store'),
      kind('Jobs', 'queue'),
      'Paid?',
      kind('Auth', 'policy'),
    ]);
    const api = cards.find((n: { id: string }) => n.id === 'api');
    expect(text(flow.props.nodeTypes.card({ ...api, selected: false }))).toBe('Orders APIsrc/api');
    const groups = flow.props.nodes.filter((n: { type: string }) => n.type === 'group');
    expect(groups.map((n: { id: string }) => n.id).sort()).toEqual(['group:data', 'group:shop']);
  });

  it('draws a state diagram whose transitions start and end on a composite state', async () => {
    const { flow } = await graph(ORDER);
    const ends = flow.props.edges.map((e: any) => `${e.source}>${e.target}`);
    expect(ends).toEqual(
      expect.arrayContaining(['Idle>group:Checkout', 'group:Checkout>root_end']),
    );
    expect(flow.props.edges.map((e: any) => e.ariaLabel)).toContain(
      zhf('visual.graph.edge', { from: 'Idle', to: 'Checkout' }),
    );
  });

  it('keeps growing the card and drawing at full size in the enlarged view', async () => {
    expect((await graph(SHOP, { grows: true })).shown.props).toMatchObject({ grows: true });
    expect((await graph(SHOP, { full: true })).shown.props).toMatchObject({ full: true });
  });
});
