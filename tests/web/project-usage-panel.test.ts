import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleUsage, SessionRole } from '@pantheon/domain';
import type { ProjectOverlap, ProjectUsageDaily, WorkbenchSession } from '@pantheon/protocol';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  queries: [] as { method: string; kinds?: ReadonlySet<string> }[],
  answers: {} as Record<string, { read: unknown; error: string | null }>,
  roles: { read: null, error: null, loading: false } as any,
  daily: { read: null, error: null, loading: false } as any,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', async (actual) => ({
  ...(await actual<object>()),
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (
    method: string,
    _projectId: string | null,
    _valid: unknown,
    _extra: unknown,
    options?: { kinds?: ReadonlySet<string> },
  ) => {
    mock.queries.push({ method, kinds: options?.kinds });
    const answer = mock.answers[method] ?? { read: null, error: null };
    return { ...answer, loading: false, unavailable: false, stale: false, reload() {} };
  },
}));
vi.mock('@/data/project-usage', () => ({
  useRoleUsage: () => ({ ...mock.roles, reload() {} }),
  useDailyUsage: () => ({ ...mock.daily, reload() {} }),
}));
vi.mock('@/data/project-plan', () => ({
  useProjectPlan: () => ({ read: null, error: null, loading: false, reload() {} }),
}));
vi.mock('@/data/projects-summary', () => ({
  useProjectsSummary: () => ({ data: [], loading: false, error: null }),
}));
import { useProjectOverlap } from '@/data/project-overlap';
import { AgentList } from '@/screens/project/AgentList';
import { PlanList } from '@/screens/project/PlanList';
import { ProjectScreen } from '@/screens/project/ProjectScreen';
import {
  DailyChart,
  RoleBars,
  UsageBody,
  UsagePanel,
  USAGE_DAYS,
} from '@/screens/project/UsagePanel';
import { dailyStack } from '@/screens/project/usage-model';
import { Failure } from '@/components/PanelBoundary';

const role = (name: SessionRole, extra: Partial<RoleUsage> = {}): RoleUsage => ({
  role: name,
  sessions: 1,
  turns: 0,
  tool_calls: 0,
  input_tokens: 0,
  cached_input_tokens: null,
  output_tokens: 0,
  turn_ms: 0,
  turns_without_usage: 0,
  ...extra,
});

const ALL: SessionRole[] = ['baseline', 'conductor', 'reviewer', 'spawned', 'story', 'user'];

/** 14 days, each with every role, the given ones used. */
const daily = (used: Record<number, RoleUsage[]>): ProjectUsageDaily => ({
  days: Array.from({ length: USAGE_DAYS }, (_, i) => ({
    date: `2026-11-${String(13 + i).padStart(2, '0')}`,
    roles: ALL.map((name) => used[i]?.find((r) => r.role === name) ?? role(name, { sessions: 0 })),
  })),
});

const storage = new Map<string, string>();

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    events: [],
    reads: {},
    status: { state: 'live' },
    resync: 0,
  };
  mock.queries = [];
  // Read, with no resident: the main agent is the one active last.
  mock.answers = {
    'project.resident': {
      read: {
        session_id: null,
        since: null,
        turns: { pantheon: 0, user: 0 },
        budget: null,
        wakes: [],
      },
      error: null,
    },
  };
  mock.roles = { read: null, error: null, loading: false };
  mock.daily = { read: null, error: null, loading: false };
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('the overlap read', () => {
  it('reads again after the event kinds its last answer names', () => {
    const h = mount(() => useProjectOverlap('alpha'));
    expect(mock.queries.at(-1)).toMatchObject({ method: 'project.overlap' });
    expect([...mock.queries.at(-1)!.kinds!]).toEqual([]);
    mock.answers['project.overlap'] = {
      read: { pairs: [], refresh_events: ['session.write_detected', 'session.merged'] },
      error: null,
    };
    h.render();
    expect([...mock.queries.at(-1)!.kinds!]).toEqual(['session.write_detected', 'session.merged']);
  });
});

describe('the project screen', () => {
  const lead = { id: 'lead', conductor: true, state: 'idle', last_activity_at: '' };
  const shared: ProjectOverlap = {
    pairs: [{ session_ids: ['a', 'b'], paths: ['x.ts'] }],
    refresh_events: [],
  };
  const screen = () =>
    mount(
      () =>
        ProjectScreen({
          projectId: 'alpha',
          sessions: [lead as WorkbenchSession],
        }) as ReactElement,
    );
  const prop = (tree: unknown, component: unknown) =>
    nodes(tree as ReactElement).find((n) => n.type === component)?.props.overlap;

  it('hands the overlap to the agent and plan rows, and none once its read failed', () => {
    mock.answers['project.overlap'] = { read: shared, error: null };
    expect(prop(screen().value, AgentList)).toBe(shared);
    expect(prop(screen().value, PlanList)).toBe(shared);
    mock.answers['project.overlap'] = { read: shared, error: 'daemon gone' };
    expect(prop(screen().value, AgentList)).toBe(null);
    expect(prop(screen().value, PlanList)).toBe(null);
  });

  it('puts the usage section after the plan', () => {
    const pane = nodes(screen().value).find(
      (n) => n.props.className === 'pj-pane' && nodes(n).some((c) => c.type === PlanList),
    )!;
    const order = (pane.props.children as unknown[]).flat().filter(Boolean) as ReactElement[];
    const plan = order.findIndex((n) => n.type === PlanList);
    expect(order[plan + 1]?.type).toBe(UsagePanel);
    expect((order[plan + 1]?.props as { projectId: string }).projectId).toBe('alpha');
  });
});

describe('the usage section', () => {
  const root = (tree: unknown) =>
    nodes(tree as ReactElement).find((n) => n.props.onOpenChange !== undefined)!;

  it('starts folded, opens to its two blocks and keeps that per project', () => {
    const h = mount(() => UsagePanel({ projectId: 'alpha' }) as ReactElement);
    expect(root(h.value).props.open).toBe(false);
    root(h.value).props.onOpenChange(true);
    h.render();
    expect(root(h.value).props.open).toBe(true);
    const body = nodes(h.value).find((n) => n.type === UsageBody);
    expect(body?.props.projectId).toBe('alpha');
    expect(
      root(mount(() => UsagePanel({ projectId: 'alpha' }) as ReactElement).value).props.open,
    ).toBe(true);
    expect(
      root(mount(() => UsagePanel({ projectId: 'beta' }) as ReactElement).value).props.open,
    ).toBe(false);
  });

  it('opens even where the browser keeps no storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    const h = mount(() => UsagePanel({ projectId: 'alpha' }) as ReactElement);
    expect(root(h.value).props.open).toBe(false);
    root(h.value).props.onOpenChange(true);
    h.render();
    expect(root(h.value).props.open).toBe(true);
  });

  const blocks = () => {
    const h = mount(() => UsageBody({ projectId: 'alpha' }) as ReactElement);
    return {
      h,
      sections: nodes(h.value)
        .filter((n) => n.type === 'section')
        .map((n) => n.props['aria-label']),
    };
  };

  it('has a block by role and one by day', () => {
    mock.roles.read = [role('user', { input_tokens: 100 })];
    mock.daily.read = daily({});
    expect(blocks().sections).toEqual(['按角色，全部时间', '最近 14 天']);
  });

  it('draws one bar per role with the tokens project.usage.read gives', () => {
    const rows = [
      role('user', { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 }),
      role('conductor', { input_tokens: 40_000, output_tokens: 2000 }),
      role('spawned', { input_tokens: 9000, output_tokens: 1000, turns: 4 }),
    ];
    mock.roles.read = rows;
    mock.daily.read = daily({});
    expect(nodes(blocks().h.value).find((n) => n.type === RoleBars)?.props.rows).toBe(rows);
    const bars = mount(() => RoleBars({ rows }) as ReactElement).value;
    const shown = nodes(bars)
      .filter((n) => n.props.className === 'pj-ur')
      .map((row) => text(row));
    expect(shown).toEqual(['主 agent42k', '主 agent 起的会话10k', '你开的会话2k']);
    const labels = nodes(bars)
      .filter((n) => n.props.role === 'img')
      .map((n) => n.props['aria-label']);
    expect(labels[0]).toContain('输入 40k');
    expect(labels[0]).toContain('缓存 未报告');
    expect(labels[2]).toContain('缓存 800');
  });

  const drawn = (days: ProjectUsageDaily, metric: 'tokens' | 'turns') => {
    const h = mount(() => DailyChart({ days: dailyStack(days, metric), metric }) as ReactElement);
    nodes(h.value)
      .find((n) => n.props.className === 'pj-uchart')!
      .props.ref({ clientWidth: 640, clientHeight: 200 });
    h.render();
    return nodes(h.value);
  };
  const chart = (days: ProjectUsageDaily, metric: 'tokens' | 'turns') =>
    drawn(days, metric)
      .filter((n) => n.type === 'g' && n.props['data-day'])
      .map((g) => nodes(g.props.children).filter((n) => n.type === 'rect').length);

  it('draws a bar per day and a segment per role that used something that day', () => {
    const days = daily({
      0: [role('user', { input_tokens: 10, turns: 1 })],
      5: [
        role('user', { input_tokens: 10, turns: 2 }),
        role('conductor', { output_tokens: 30, turns: 1 }),
        role('reviewer', { turns: 3 }),
      ],
      13: [role('story', { input_tokens: 5, turns: 1 })],
    });
    const tokens = chart(days, 'tokens');
    expect(tokens).toHaveLength(14);
    expect(tokens[0]).toBe(1);
    expect(tokens[5]).toBe(2);
    expect(tokens[13]).toBe(1);
    expect(tokens.reduce((a, b) => a + b, 0)).toBe(4);
    const turns = chart(days, 'turns');
    expect(turns[5]).toBe(3);
  });

  it('says how many turns reported no usage, and nothing when all did', () => {
    mock.roles.read = [];
    mock.daily.read = daily({ 3: [role('spawned', { turns: 3, turns_without_usage: 2 })] });
    expect(text(blocks().h.value)).toContain('2 个回合没有报告用量');
    mock.daily.read = daily({ 3: [role('spawned', { turns: 3, input_tokens: 9 })] });
    expect(text(blocks().h.value)).not.toContain('没有报告用量');
  });

  it('names each day with its roles and lets the keyboard reach it', () => {
    const days = daily({
      5: [role('user', { input_tokens: 10 }), role('conductor', { output_tokens: 30 })],
    });
    const tree = drawn(days, 'tokens');
    expect(tree.find((n) => n.type === 'svg')?.props.role).toBe('group');
    const day = tree.find((n) => n.type === 'g' && n.props['data-day'] === '2026-11-18')!;
    expect(day.props.tabIndex).toBe(0);
    expect(day.props['aria-label']).toBe('2026-11-18：你开的会话 10，主 agent 30，合计 40');
  });

  it('gives every token axis step its own label', () => {
    const tree = drawn(daily({ 2: [role('user', { input_tokens: 1600 })] }), 'tokens');
    const ticks = tree
      .filter((n) => n.type === 'text' && n.props.textAnchor === 'end')
      .map((n) => text(n));
    expect(ticks.length).toBeGreaterThan(2);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('offers a retry when a refresh failed, and keeps the last read', () => {
    mock.roles = {
      read: [role('user', { input_tokens: 100 })],
      error: 'daemon gone',
      loading: false,
    };
    mock.daily = { read: daily({}), error: 'daemon gone', loading: false };
    const tree = nodes(blocks().h.value);
    expect(tree.filter((n) => n.type === Failure)).toHaveLength(2);
    expect(tree.some((n) => n.type === RoleBars)).toBe(true);
    expect(tree.some((n) => n.type === DailyChart)).toBe(true);
  });
});

describe('the usage reads', () => {
  it('read again after a delivery receipt, which can end a steer', async () => {
    const actual =
      await vi.importActual<typeof import('@/data/project-usage')>('@/data/project-usage');
    mount(() => {
      actual.useRoleUsage('alpha');
      actual.useDailyUsage('alpha', USAGE_DAYS);
      return null as unknown as ReactElement;
    });
    const kinds = mock.queries.filter((q) => q.method.startsWith('project.usage'));
    expect(kinds).toHaveLength(2);
    for (const q of kinds) expect(q.kinds?.has('session.turn.delivery')).toBe(true);
  });
});
