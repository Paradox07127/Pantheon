import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel, BridgeResult } from '@pantheon/protocol';
import { find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { StatusIcon } from '@/screens/board/status';
import { CollabTab } from '@/screens/insights/CollabTab';
import { zh } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
type Lead = NonNullable<BoardModel['leads']>[number];
type Today = NonNullable<Lead['messages_today']>[number];

// Local times, so where an event falls in the day does not depend on the time zone.
const NOW = new Date(2026, 10, 12, 10).getTime();
const at = (hours: number, minutes = 0) => new Date(2026, 10, 12, hours, minutes).getTime();

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: 'lead-1:parser',
    owner_session_id: 'lead-1',
    title: 'task parser',
    goal: '',
    scope: [],
    lane_id: null,
    milestone_id: null,
    status: 'running',
    state: 'running',
    blockers: [],
    segments: [],
    additions: null,
    deletions: null,
    checks: 'none',
    started_at: null,
    ended_at: null,
    last_progress_at: null,
    blocked_since: null,
    turn_running: true,
    claim: { session_id: 'session-parser', runtime: 'codex', model: null },
    external_review: { rounds: 1, verdict: 'pending' },
    gate_steps: [{ name: 'test', state: 'running' }],
    ...extra,
  }) as Task;

const lead = (today: Partial<Today>, extra: Partial<Lead> = {}): Lead => ({
  session_id: 'lead-1',
  title: 'lead',
  state: 'idle',
  inbox: 0,
  updated_at: 0,
  messages_today: [{ session_id: 'session-parser', lead: 4, tracker: 0, handbacks: 1, ...today }],
  ...extra,
});

const board = (leads: Lead[], tasks: Task[] = [task()]): BoardModel =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [],
    tasks,
    leads,
  }) as unknown as BoardModel;

const bridge = {
  async query(method: string): Promise<BridgeResult<unknown>> {
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(): Promise<BridgeResult<unknown>> {
    return { ok: true, value: {} };
  },
};

async function mount(model: BoardModel) {
  const h = host(() => CollabTab({ model, projectId: 'alpha', onOpenSession() {} }));
  await h.flush();
  return h.value;
}
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const has = (tree: unknown, label: string) =>
  nodes(tree as never).some((n) => n.props['aria-label'] === label);
const graph = (tree: unknown) => labelled(tree, zh('insights.collab.graph'));
const ofType = (tree: unknown, type: string) => nodes(tree as never).filter((n) => n.type === type);
const edges = (tree: unknown) => find(tree as never, (n) => n.props.className === 'clb-edges');
const checkLabels = (tree: unknown) =>
  nodes(graph(tree) as never)
    .filter((n) => n.props.role === 'group' && n.props.className === 'clb-node')
    .map((n) => n.props['aria-label']);

beforeEach(() => {
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: {
      cursor: 1,
      projects: [{ id: 'alpha', revision: 1, name: 'Alpha', roots: ['/work/alpha'] }],
      sessions: [],
      session_turns: [],
    },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('counts on the lines', () => {
  it('draws on each line what it counts today, with a title naming it', async () => {
    const tree = await mount(board([lead({ subagents: 2, reviews: 3, gates: 5 })]));
    const svg = edges(tree);
    expect(ofType(svg, 'text').map((n) => text(n))).toEqual(['4', '2', '3', '5']);
    expect(ofType(svg, 'title').map((n) => text(n))).toEqual([
      '今天 4 条消息',
      '今天 2 次子 agent 调用',
      '今天 3 轮评审',
      '今天 5 次门禁',
    ]);
  });

  it('draws no count on a line whose count is absent', async () => {
    const tree = await mount(board([lead({})]));
    expect(ofType(edges(tree), 'rect')).toHaveLength(1);
    expect(ofType(edges(tree), 'path')).toHaveLength(3);
  });

  it('draws no count on a line with no message today', async () => {
    const tree = await mount(board([lead({ lead: 0 })]));
    expect(ofType(edges(tree), 'rect')).toHaveLength(0);
  });
});

describe('sub-agent node', () => {
  it('comes before the review and the checks, done, with the calls of today', async () => {
    const tree = await mount(board([lead({ subagents: 2 })]));
    expect(checkLabels(tree)).toEqual([
      zh('insights.collab.subagents'),
      zh('insights.collab.review'),
      zh('insights.collab.gate'),
    ]);
    const node = labelled(graph(tree), zh('insights.collab.subagents'));
    expect(find(node, (n) => n.type === StatusIcon).props.status).toBe('done');
    expect(text(find(node, (n) => n.props.className === 'clb-nst'))).toBe('今天 2 次');
    expect(text(node).split(zh('insights.collab.subagents'))).toHaveLength(2);
  });

  it('runs without a count while only a call is in flight', async () => {
    const tree = await mount(board([lead({ in_flight: ['subagent'] })]));
    const node = labelled(graph(tree), zh('insights.collab.subagents'));
    expect(find(node, (n) => n.type === StatusIcon).props.status).toBe('running');
    expect(nodes(node).some((n) => n.props.className === 'clb-nst')).toBe(false);
  });

  it('is left out without calls today or in flight', async () => {
    const tree = await mount(board([lead({})]));
    expect(checkLabels(tree)).toEqual([zh('insights.collab.review'), zh('insights.collab.gate')]);
  });
});

describe('checks node', () => {
  it('is done when every step passed or was skipped', async () => {
    const steps: Task['gate_steps'] = [
      { name: 'lint', state: 'passed' },
      { name: 'e2e', state: 'skipped' },
    ];
    const tree = await mount(board([lead({})], [task({ gate_steps: steps })]));
    const node = labelled(graph(tree), zh('insights.collab.gate'));
    expect(find(node, (n) => n.type === StatusIcon).props.status).toBe('done');
  });

  it.each([
    ['the gate is in flight', { in_flight: ['gate'] } as Partial<Today>, {}],
    ['the task says its checks run', {}, { checks: 'running' } as Partial<Task>],
  ])('runs while %s and every step still waits for its result', async (_, today, extra) => {
    const steps: Task['gate_steps'] = [
      { name: 'lint', state: 'pending' },
      { name: 'test', state: 'pending' },
    ];
    const tree = await mount(board([lead(today)], [task({ gate_steps: steps, ...extra })]));
    const node = labelled(graph(tree), zh('insights.collab.gate'));
    expect(find(node, (n) => n.type === StatusIcon).props.status).toBe('running');
    expect(text(find(node, (n) => n.props.className === 'clb-nst'))).toBe('2 步里过了 0 步');
  });
});

describe('counts on the lines for assistive technology', () => {
  it('names each count by what it counts, and hides only the lines themselves', async () => {
    const tree = await mount(board([lead({ reviews: 3, gates: 5 })]));
    const svg = edges(tree);
    expect(svg.props['aria-hidden']).toBeUndefined();
    expect(ofType(svg, 'path').every((n) => n.props['aria-hidden'] === 'true')).toBe(true);
    const counted = nodes(svg).filter((n) => n.props.role === 'img');
    expect(counted.map((n) => n.props['aria-label'])).toEqual([
      '今天 4 条消息',
      '今天 3 轮评审',
      '今天 5 次门禁',
    ]);
  });
});

describe('lines moving now', () => {
  const liveOf = async (line: Today['in_flight']) => {
    const tree = await mount(board([lead({ subagents: 1, in_flight: line })]));
    return {
      tree,
      live: ofType(edges(tree), 'path').map((n) => n.props.className === 'live'),
    };
  };

  it.each([
    ['lead', [true, false, false, false]],
    ['subagent', [false, true, false, false]],
    ['review', [false, false, true, false]],
    ['gate', [false, false, false, true]],
  ] as const)('marks only the line %s moves on', async (line, expected) => {
    const { tree, live } = await liveOf([line]);
    expect(live).toEqual(expected);
    expect(text(labelled(graph(tree), zh('insights.collab.legend')))).toBe(
      zh('insights.collab.moving'),
    );
  });

  it('marks nothing and draws no legend when the moving line has no node', async () => {
    const tree = await mount(
      board(
        [lead({ in_flight: ['review', 'gate'] })],
        [task({ external_review: undefined, gate_steps: [] })],
      ),
    );
    expect(ofType(edges(tree), 'path').map((n) => n.props.className)).toEqual([undefined]);
    expect(has(tree, zh('insights.collab.legend'))).toBe(false);
  });

  it('draws no legend while nothing moves', async () => {
    expect(has(await mount(board([lead({ subagents: 1 })])), zh('insights.collab.legend'))).toBe(
      false,
    );
  });
});

describe('handbacks and model changes', () => {
  const summary = (tree: unknown) => labelled(tree, zh('insights.collab.summary'));

  it("puts every lead's events of today on the day", async () => {
    const tree = await mount(
      board([
        lead(
          {},
          {
            events_today: [
              { at: at(6), kind: 'handback', session_id: 'session-parser' },
              { at: at(12), kind: 'model_change', session_id: 'session-parser' },
            ],
          },
        ),
        {
          ...lead({}, { session_id: 'lead-2', messages_today: [] }),
          events_today: [{ at: at(18), kind: 'handback', session_id: 'session-other' }],
        },
      ]),
    );
    const cell = summary(tree);
    expect(text(cell)).toContain(zh('insights.collab.handbacksAndModels'));
    expect(text(cell)).toContain('今天 3 次');
    const chart = labelled(cell, '今天交回 2 次，换模型 1 次');
    expect(chart.props.role).toBe('img');
    const points = nodes(chart).filter((n) => n.props.className === 'clb-tp');
    expect(points.map((n) => n.props.x)).toEqual(['25%', '50%', '75%']);
    expect(ofType(chart, 'circle')).toHaveLength(2);
    expect(ofType(chart, 'rect').map((n) => n.props.transform)).toEqual(['rotate(45)']);
    expect(ofType(chart, 'title').map((n) => text(n))).toEqual([
      '06:00 交回',
      '12:00 换模型',
      '18:00 交回',
    ]);
  });

  it('writes 0 and draws the empty day without an event, whatever the sessions were handed back', async () => {
    const cell = summary(await mount(board([lead({ handbacks: 2 })])));
    expect(text(cell)).toContain('今天 0 次');
    const chart = labelled(cell, '今天交回 0 次，换模型 0 次');
    expect(chart.props.role).toBe('img');
    expect(ofType(chart, 'circle')).toHaveLength(0);
    expect(ofType(chart, 'rect')).toHaveLength(0);
  });
});
