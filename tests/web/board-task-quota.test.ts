import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel, RuntimeModel, RuntimeStatus } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
const { statuses, models, boardTabs } = vi.hoisted(() => ({
  statuses: [] as RuntimeStatus[],
  models: {} as Record<string, RuntimeModel[]>,
  boardTabs: [] as unknown[][],
}));
vi.mock('@/data/backends', () => ({ useBackends: () => [] }));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({ read: { state: 'ready', statuses } }),
  offeredRuntimes: () => ['claude', 'codex'],
}));
vi.mock('@/data/runtime-models', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeModels: (_project: string | null, runtimes: readonly string[]) =>
    Object.fromEntries(
      runtimes.map((r) => [
        r,
        models[r] ? { state: 'ready', models: models[r] } : { state: 'loading' },
      ]),
    ),
}));
vi.mock('@/screens/settings/settings-jump', async (actual) => ({
  ...(await actual<object>()),
  openBoardTab: (...args: unknown[]) => void boardTabs.push(args),
}));
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useStore: (select: (s: { transform: [number, number, number] }) => unknown) =>
    select({ transform: [0, 0, 1] }),
}));
import { quotaLine } from '@/screens/board/activity';
import { TaskCard } from '@/screens/board/FlowNode';
import { useRouteFields } from '@/screens/board/PlanEdit';
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { zh } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];

// Ahead of the clock, so the drawer's own clock does not move the board's time.
const NOW = Date.UTC(2036, 0, 1, 12);
const HOUR = 3_600_000;
const noop = () => {};
const lead = {
  id: 'lead-1',
  revision: 1,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
} as SnapshotSession;

const row = (extra: Partial<Task>): Task =>
  ({
    id: 'lead-1:a',
    owner_session_id: 'lead-1',
    title: 'task a',
    goal: '',
    scope: [],
    lane_id: null,
    milestone_id: null,
    status: 'todo',
    state: 'todo',
    blockers: [],
    segments: [],
    additions: null,
    deletions: null,
    checks: 'none',
    started_at: null,
    ended_at: null,
    last_progress_at: null,
    blocked_since: null,
    turn_running: false,
    ...extra,
  }) as Task;

const quotaWait = row({
  planned: { runtime: 'codex' },
  dispatch_wait: 'runtime_limited',
  blockers: ['Queued: waiting for runtime quota'],
  blocker_codes: [{ code: 'queued' }],
} as Partial<Task>);

const board = (tasks: Task[]) =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [],
    tasks,
    milestones: [],
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state: 'idle',
        inbox: 0,
        updated_at: 0,
        plan_version: 1,
      },
    ],
  }) as unknown as BoardModel;

const drawer = (task: Task) =>
  mount(() =>
    TaskDrawer({
      model: board([task]),
      taskId: task.id,
      onSelect: noop,
      onOpenSession: noop,
      onOpenStory: noop,
      tell: { sessions: [lead], run: async () => null },
    }),
  ).value;

const model = (id: string, extra: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id,
  label: id,
  permission_modes: [],
  efforts: [],
  default_effort: null,
  default: false,
  ...extra,
});
const CLAUDE = [
  model('default', {
    label: 'Default (recommended)',
    resolved: 'claude-opus-5-5',
    default: true,
  }),
  model('opus', { label: 'Opus 5.5', resolved: 'claude-opus-5-5' }),
  model('sonnet', { label: 'Sonnet 5.5', resolved: 'claude-sonnet-5-5' }),
];

beforeEach(() => {
  const listeners = { addEventListener: noop, removeEventListener: noop };
  vi.stubGlobal('window', {
    ...listeners,
    innerWidth: 1440,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', { ...listeners, activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  statuses.splice(0, statuses.length, {
    runtime: 'codex',
    quota: {
      seen_at: NOW,
      windows: [
        { window: 'five_hour', used_percent: 20, resets_at: NOW + 2 * HOUR },
        { window: 'seven_day', used_percent: 95, resets_at: NOW + 64 * HOUR },
      ],
    },
  } as RuntimeStatus);
  for (const runtime of Object.keys(models)) delete models[runtime];
  boardTabs.splice(0);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('a task waiting on runtime quota', () => {
  it('says on its card when the quota comes back', () => {
    expect(quotaLine(row({}), statuses, NOW)).toBeNull();
    const card = mount(() =>
      TaskCard({
        data: {
          task: quotaWait,
          selected: false,
          now: NOW,
          critical: false,
          ready: false,
          line: '排队中：等待运行时额度恢复',
        },
      } as never),
    ).value;
    const line = named(card, 'QuotaLine');
    expect(text(mount(() => (line.type as (p: object) => ReactNode)(line.props)).value)).toBe(
      '额度约 2 天 16 小时后恢复',
    );
  });

  it('reads the quota of the runtime the task is claimed on before the planned one', () => {
    const moved = row({
      planned: { runtime: 'claude' },
      claim: { runtime: 'codex' },
      dispatch_wait: 'runtime_limited',
    } as Partial<Task>);
    expect(quotaLine(moved, statuses, NOW)).toBe('额度约 2 天 16 小时后恢复');
  });

  it('shows the reset time in the drawer and opens usage on the engineering board', () => {
    const tree = drawer(quotaWait);
    expect(nodes(tree).some((n) => text(n) === '约 2 天 16 小时后恢复')).toBe(true);
    const usage = find(
      tree,
      (n) => n.type === 'button' && n.props['aria-label'] === zh('board.task.quota.usageLabel'),
    );
    usage.props.onClick();
    expect(boardTabs).toEqual([['usage']]);
  });
});

describe('the model in the task drawer', () => {
  it('names the routed model as the model menu does', () => {
    models.claude = CLAUDE;
    const route = (modelId: string) => {
      const element = named(
        drawer(row({ planned: { runtime: 'claude', model: modelId } } as Partial<Task>)),
        'TaskRoute',
      );
      return text(mount(() => (element.type as (p: object) => ReactNode)(element.props)).value);
    };
    expect(route('claude-opus-5-5')).toBe('Opus 5.5');
    expect(route('default')).toBe(zh('sessions.composer.defaultModel'));
  });

  it("offers the runtime's default once, named by the model it resolves to", () => {
    models.claude = CLAUDE;
    const h = mount(() =>
      useRouteFields(
        'project-a',
        { runtime: 'claude', model: 'default', effort: null },
        false,
        noop,
      ),
    );
    const select = nodes(h.value).find(
      (n) => n.props['aria-label'] === zh('board.plan.field.model'),
    )!;
    expect(select.props.value).toBe('');
    expect(select.props.options).toEqual([
      { value: '', label: '默认（Opus 5.5）' },
      { value: 'opus', label: 'Opus 5.5' },
      { value: 'sonnet', label: 'Sonnet 5.5' },
    ]);
  });
});
