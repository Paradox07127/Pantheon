import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel, BoardTaskRung } from '@pantheon/protocol';
import { nodes, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'card' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useStore: (select: (s: { transform: [number, number, number] }) => unknown) =>
    select({ transform: [0, 0, 1] }),
}));
vi.mock('@/data/backends', () => ({ useBackends: () => [] }));
vi.mock('@/data/runtime-models', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeModels: (_project: string | null, runtimes: readonly string[]) =>
    Object.fromEntries(runtimes.map((r) => [r, { state: 'loading' }])),
}));
import { BudgetShare, RungLabel } from '@/screens/board/TaskRecovery';
import { TaskCard as FlowNode } from '@/screens/board/FlowNode';
import { TaskList } from '@/screens/board/TaskList';
import { Clip } from '@/components/Clip';
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { needActions, type BoardNeed } from '@/screens/board/frame-model';
import { needContext } from '@/screens/board/BoardFrame';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
type Budget = NonNullable<Task['budget']>;

const NOW = Date.UTC(2026, 10, 18, 12);
const noop = () => {};

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
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
    started_at: NOW - 40 * 60_000,
    ended_at: null,
    last_progress_at: null,
    blocked_since: null,
    turn_running: false,
    ...extra,
  }) as Task;

const rung = (level: BoardTaskRung['rung'], extra: Partial<BoardTaskRung> = {}): BoardTaskRung => ({
  rung: level,
  by: level === 'retry' ? 'pantheon' : level === 'user' ? 'user' : 'lead',
  reason: 'gate_failed',
  since: NOW - 31 * 60_000,
  switches: [],
  ...extra,
});

const budget = (ratio: number): Budget => ({
  ratio,
  input_tokens: Math.round(ratio * 1_000_000),
  wall_ms: 30 * 60_000,
  limit: { input_tokens: 1_000_000, wall_ms: 60 * 60_000 },
});

const board = (tasks: Task[]) =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [],
    needs: [],
    tasks,
    milestones: [],
    leads: [],
  }) as unknown as BoardModel;

const icons = (tree: ReactNode) =>
  nodes(tree)
    .map((n) => (n.type as { displayName?: string }).displayName)
    .filter(Boolean);
const has = (tree: ReactNode, name: string) =>
  nodes(tree).some((n) => typeof n.type === 'function' && n.type.name === name);

beforeEach(() => {
  const listeners = { addEventListener: noop, removeEventListener: noop };
  vi.stubGlobal('window', {
    ...listeners,
    innerWidth: 1440,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', { ...listeners, activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('the rung label', () => {
  it.each([
    [
      'retry with its tries',
      rung('retry', { used: 2, limit: 3 }),
      zhf('board.recovery.rung.retryCount', { used: 2, limit: 3 }),
    ],
    ['retry without a count', rung('retry', { used: 1 }), zh('board.recovery.rung.retry')],
    [
      'retry held for the usage limit',
      rung('retry', { used: 1, limit: 3, held: 'usage_limit' }),
      zh('board.recovery.rung.heldUsage'),
    ],
    [
      'retry held for the project budget',
      rung('retry', { used: 1, limit: 3, held: 'project_budget' }),
      zh('board.recovery.rung.heldBudget'),
    ],
    [
      'switch',
      rung('switch', {
        switches: [
          { from: 'claude', to: 'gemini', at: NOW - 3_600_000, by: 'lead' },
          { from: 'gemini', to: 'codex', at: NOW - 60_000, by: 'lead' },
        ],
      }),
      zhf('board.recovery.rung.switch', { runtime: 'Codex' }),
    ],
    ['lead', rung('lead'), zh('board.recovery.rung.lead')],
    ['user', rung('user'), zh('board.recovery.rung.user')],
  ])('names the %s rung', (_name, value, label) => {
    expect(text(RungLabel({ rung: value }))).toBe(label);
  });

  it('marks each rung with its own icon', () => {
    const marks = (['retry', 'switch', 'lead', 'user'] as const).map((level) =>
      icons(RungLabel({ rung: rung(level) })),
    );
    for (const mark of marks) expect(mark).toHaveLength(1);
    expect(new Set(marks.flat()).size).toBe(4);
  });

  it('spells the switch with the runtime name, the retry count in plain words', () => {
    expect(zhf('board.recovery.rung.retryCount', { used: 2, limit: 3 })).toBe(
      'Pantheon 重试 2 / 3',
    );
    expect(zhf('board.recovery.rung.switch', { runtime: 'Codex' })).toBe('已转到 Codex');
  });
});

describe('the budget share', () => {
  it.each([
    [0.41, '预算已用 41%', false],
    [1.12, '预算已用 112%，已超出预算', true],
  ])('names a share of %s by its percent', (ratio, label, over) => {
    const share = BudgetShare({ budget: budget(ratio) }) as ReactElement<any>;
    expect(share.props.role).toBe('img');
    expect(share.props['aria-label']).toBe(label);
    expect(text(share)).toBe(`${Math.round(ratio * 100)}%`);
    expect(share.props['data-over']).toBe(over || undefined);
  });
});

const flowNode = (t: Task) =>
  FlowNode({
    data: { task: t, selected: false, now: NOW, critical: false, ready: false, line: null },
  } as unknown as Parameters<typeof FlowNode>[0]);

const taskRows = (tasks: Task[]) => {
  const tree = mount(() => TaskList({ model: board(tasks), onOpenTask: noop, bar: null })).value;
  return nodes(tree).filter((n) => n.props.role === 'row' && n.props['aria-label']);
};

describe('the four places', () => {
  const both = task('a', { budget: budget(0.41), rung: rung('user') });
  const none = task('b');

  it('puts the share and the rung on a flow node, and nothing on a node without them', () => {
    const tree = flowNode(both);
    expect(has(tree, 'BudgetShare')).toBe(true);
    expect(has(tree, 'RungLabel')).toBe(true);
    const bare = flowNode(none);
    expect(has(bare, 'BudgetShare')).toBe(false);
    expect(has(bare, 'RungLabel')).toBe(false);
  });

  it('keeps the whole title of a task row behind a one-line clip', () => {
    const [row] = taskRows([
      task('a', { title: 'Rebuild the nightly refunds export with retries' }),
    ]);
    const clips = nodes(row).filter((n) => n.type === Clip);
    expect(clips.map((n) => n.props.text)).toEqual([
      'Rebuild the nightly refunds export with retries',
    ]);
    expect(clips[0]!.props.lines ?? 1).toBe(1);
  });
});

const drawer = (t: Task) =>
  mount(() =>
    TaskDrawer({
      model: board([t]),
      taskId: t.id,
      onSelect: noop,
      onOpenSession: noop,
      onOpenStory: noop,
    }),
  ).value;
const section = (tree: ReactNode, heading: string) =>
  nodes(tree).find(
    (n) => n.type === 'section' && nodes(n).some((h) => h.type === 'h3' && text(h) === heading),
  );

describe('the task drawer', () => {
  it('lists tokens and time against their limits, the larger one marked', () => {
    const t = task('a', {
      budget: {
        ratio: 0.92,
        input_tokens: 610_000,
        wall_ms: 55 * 60_000,
        limit: { input_tokens: 1_120_000, wall_ms: 60 * 60_000 },
      },
    });
    const budgetSection = section(drawer(t), zh('board.recovery.budget.heading'))!;
    expect(text(budgetSection)).toContain('92%');
    const meters = nodes(budgetSection).filter((n) => n.props.role === 'img');
    expect(meters.map((n) => [n.type, n.props.className])).toEqual([
      ['svg', 'bd-drg-c'],
      ['svg', 'bd-drg-c'],
    ]);
    expect(meters.map((n) => n.props['aria-label'])).toEqual([
      zhf('board.recovery.budget.tokensMeter', { percent: 54 }),
      zhf('board.recovery.budget.timeMeter', { percent: 92 }),
    ]);
    expect(meters.map((n) => n.props['data-max'])).toEqual([undefined, true]);
    expect(text(budgetSection)).toContain('610k / 1.1M');
  });

  const track = (t: Task) => {
    const recovery = section(drawer(t), zh('board.recovery.ladder'))!;
    const ol = nodes(recovery).find((n) => n.type === 'ol')!;
    const steps = nodes(ol).filter((n) => n.type === 'li');
    return {
      recovery,
      ol,
      names: steps.map((n) => text(n)),
      current: steps.findIndex((n) => n.props['aria-current'] === 'step'),
      marks: steps.map((n) => nodes(n).find((m) => m.props.role === 'img')!.props['aria-label']),
    };
  };

  it('draws a fix per retry the limit allows, then the lead and you, the current rung marked', () => {
    const t = task('a', {
      rung: rung('lead', { used: 2, limit: 2, reason: 'gate_failed' }),
      activity: { phase: 'idle', since: NOW, health: 'fresh', attempt: 2, repeated_failure: true },
    });
    const { recovery, ol, names, current, marks } = track(t);
    expect(names).toEqual([
      zhf('board.drawer.esc.retry', { n: 1 }),
      zhf('board.drawer.esc.retry', { n: 2 }),
      zh('board.drawer.esc.lead'),
      zh('board.drawer.esc.user'),
    ]);
    expect(current).toBe(2);
    expect(marks).toEqual([
      zh('board.task.step.failed'),
      zh('board.task.step.failed'),
      zh('board.recovery.step.current'),
      zh('board.recovery.step.ahead'),
    ]);
    expect(ol.props['aria-label']).toBe(
      zhf('board.drawer.esc.label', { count: 4, step: 3, current: zh('board.drawer.esc.lead') }),
    );
    expect(text(recovery)).toContain(zh('board.recovery.reason.gate_failed'));
    expect(text(recovery)).toContain(zh('board.recovery.repeated'));
  });

  it.each([
    ['the fix under way while retrying', rung('retry', { used: 2, limit: 3 }), 5, 1],
    ['another runtime after the fixes while switching', rung('switch', { limit: 2 }), 5, 2],
    ['one fix without a limit or count', rung('lead'), 3, 1],
    ['you last, the lead passed', rung('user', { used: 1, limit: 1 }), 3, 2],
  ])('marks %s', (_name, value, count, at) => {
    const { names, current, marks } = track(task('a', { rung: value }));
    expect(names).toHaveLength(count);
    expect(current).toBe(at);
    expect(marks.slice(0, at)).not.toContain(zh('board.recovery.step.ahead'));
    expect(marks.slice(at + 1)).toEqual(
      Array(count - at - 1).fill(zh('board.recovery.step.ahead')),
    );
    if (value.rung === 'switch') expect(names[at]).toBe(zh('board.recovery.step.switch'));
    if (value.rung === 'user') expect(marks[at - 1]).toBe(zh('board.recovery.step.done'));
  });

  it('counts the hand-backs at the head, from the retrospective else the activity, and none without', () => {
    const head = (t: Task) =>
      nodes(drawer(t))
        .filter((n) => n.props.className === 'chip')
        .map((n) => text(n));
    const activity = {
      phase: 'idle' as const,
      since: NOW,
      health: 'fresh' as const,
      attempt: 1,
      handed_back: ['gate_failed', 'out_of_scope'],
    };
    expect(head(task('a', { activity }))).toEqual([
      zhf('board.recovery.step.handedBackCount', { count: 2 }),
    ]);
    expect(
      head(task('a', { activity, retrospective: { handbacks: 3 } as Task['retrospective'] })),
    ).toEqual([zhf('board.recovery.step.handedBackCount', { count: 3 })]);
    expect(head(task('a'))).toEqual([]);
  });

  it('shows no reason for a reason it does not know, and no code', () => {
    const t = task('a', { rung: rung('lead', { reason: 'something_new' }) });
    const recovery = section(drawer(t), zh('board.recovery.ladder'))!;
    expect(text(recovery)).not.toContain('something_new');
  });

  it('has neither section for a task without a budget or a rung', () => {
    const tree = drawer(task('b'));
    expect(section(tree, zh('board.recovery.budget.heading'))).toBeUndefined();
    expect(section(tree, zh('board.recovery.ladder'))).toBeUndefined();
  });
});

describe('needs-you actions of a task Pantheon or the lead still holds', () => {
  const worker = {
    id: 'worker-1',
    revision: 7,
    project_id: 'project-a',
    runtime: 'fixture',
    state: 'open',
    turn_count: 1,
    task: { lead_session_id: 'lead-1', id: 'a' },
    merge: { state: 'blocked', reason: 'gate_failed' },
  } as unknown as SnapshotSession;
  const blocked: BoardNeed = {
    source: { table: 'sessions', id: 'worker-1', revision: 7 },
    kind: 'session.gate_failed',
    project_id: 'project-a',
    status: 'open',
    created_at: NOW - 60_000,
    reason: 'gate_failed',
    decision: 'other',
    blocks: 0,
    actions: [],
    unblocks: 0,
  } as BoardNeed;

  it.each([
    ['retry', ['handoff', 'open']],
    ['lead', ['handoff', 'open']],
    ['user', ['merge', 'gates', 'handoff', 'open']],
  ] as const)('offers a %s task these actions', (level, keys) => {
    const model = board([task('a', { rung: rung(level) })]);
    const context = needContext(blocked, model, [worker], [], null);
    expect(context.rung).toBe(level);
    expect(needActions(blocked, worker, undefined, context.rung).map((a) => a.key)).toEqual(keys);
  });
});
