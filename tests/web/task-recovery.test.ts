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
import { TaskGroups } from '@/screens/board/TaskGroups';
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

/** Calls a function component's element once, as React would render it. */
const render = (el: ReactElement<any>) => (el.type as (p: unknown) => ReactNode)(el.props);
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
  const tree = mount(() => TaskGroups({ model: board(tasks), onOpenTask: noop })).value;
  return nodes(tree)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'TaskRow')
    .map((row) => render(row));
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

  it('puts the rung and share before the runtime of a task row, leaving the cells of a row without them empty', () => {
    const [withBoth, without] = taskRows([both, none]);
    expect(has(withBoth, 'RungLabel')).toBe(true);
    expect(has(withBoth, 'BudgetShare')).toBe(true);
    expect(has(without, 'RungLabel')).toBe(false);
    expect(has(without, 'BudgetShare')).toBe(false);
    const cells = (row: ReactNode) =>
      (nodes(row).find((n) => n.type === 'button')!.props.children as unknown[]).length;
    expect(cells(without)).toBe(cells(withBoth));
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

  it.each(['retry', 'switch', 'lead', 'user'] as const)(
    'puts the %s rung on a task row, which holds no button of its own',
    (level) => {
      const [row] = taskRows([task('a', { rung: rung(level) })]);
      expect(has(row, 'RungLabel')).toBe(true);
      expect(nodes(row).filter((n) => n.type === 'button')).toHaveLength(1);
      expect(has(taskRows([none])[0], 'RungLabel')).toBe(false);
    },
  );
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
    expect(meters.map((n) => n.props['aria-label'])).toEqual([
      zhf('board.recovery.budget.tokensMeter', { percent: 54 }),
      zhf('board.recovery.budget.timeMeter', { percent: 92 }),
    ]);
    expect(meters.map((n) => n.props['data-max'])).toEqual([undefined, true]);
    expect(text(budgetSection)).toContain('610k / 1.1M');
  });

  it('marks the current rung of the four with aria-current and words its reason', () => {
    const t = task('a', {
      rung: rung('lead', { used: 2, limit: 2, reason: 'gate_failed' }),
      activity: { phase: 'idle', since: NOW, health: 'fresh', attempt: 2, repeated_failure: true },
    });
    const recovery = section(drawer(t), zh('board.recovery.heading'))!;
    const ladder = nodes(recovery).find((n) => n.type === 'ol')!;
    expect(ladder.props['aria-label']).toBe(zh('board.recovery.ladder'));
    const steps = nodes(ladder).filter((n) => n.type === 'li');
    expect(steps).toHaveLength(4);
    expect(text(steps[2])).toContain(zh('board.recovery.step.lead'));
    expect(steps.map((n) => n.props['aria-current'])).toEqual([
      undefined,
      undefined,
      'step',
      undefined,
    ]);
    expect(text(steps[0])).toContain('2 / 2');
    expect(text(steps[2])).toContain(zh('board.recovery.reason.gate_failed'));
    expect(text(recovery)).toContain(zh('board.recovery.repeated'));
  });

  it.each([
    [
      'its hand-backs against the limit',
      rung('lead', { used: 2, limit: 2 }),
      undefined,
      zhf('board.recovery.step.handedBack', { used: 2, limit: 2 }),
    ],
    [
      'the hand-backs of its reason without a limit',
      rung('lead'),
      ['gate_failed', 'out_of_scope', 'gate_failed'],
      zhf('board.recovery.step.handedBackCount', { count: 2 }),
    ],
    ['no count without the hand-backs', rung('lead'), null, ''],
    ['none when nothing was handed back', rung('lead'), [], zh('board.task.drawer.none')],
  ])('words the passed retry step of a lead task by %s', (_name, value, handed, words) => {
    const t = task('a', {
      rung: value,
      ...(handed !== null && {
        activity: {
          phase: 'idle',
          since: NOW,
          health: 'fresh',
          attempt: 1,
          ...(handed && { handed_back: handed }),
        },
      }),
    });
    const recovery = section(drawer(t), zh('board.recovery.heading'))!;
    const ladder = nodes(recovery).find((n) => n.type === 'ol')!;
    const retry = nodes(ladder).filter((n) => n.type === 'li')[0]!;
    expect(text(retry)).toBe(`${zh('board.recovery.rung.retry')}${words}`);
  });

  it('shows no reason for a reason it does not know, and no code', () => {
    const t = task('a', { rung: rung('lead', { reason: 'something_new' }) });
    const recovery = section(drawer(t), zh('board.recovery.heading'))!;
    expect(text(recovery)).not.toContain('something_new');
  });

  it('has neither section for a task without a budget or a rung', () => {
    const tree = drawer(task('b'));
    expect(section(tree, zh('board.recovery.budget.heading'))).toBeUndefined();
    expect(section(tree, zh('board.recovery.heading'))).toBeUndefined();
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
