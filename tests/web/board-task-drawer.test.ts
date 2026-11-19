import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type {
  BackendSummary,
  BoardModel,
  SessionDiff,
  SessionGatesHistory,
} from '@pantheon/protocol';
import { find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
const { editPlan, backends, models, gateRuns, diffFiles } = vi.hoisted(() => ({
  editPlan: vi.fn(async (..._args: unknown[]) => ({ kind: 'applied' })),
  backends: [] as BackendSummary[],
  models: {} as Record<string, ModelsState>,
  gateRuns: [] as SessionGatesHistory['runs'],
  diffFiles: { value: null as SessionDiff['files'] | null },
}));
vi.mock('@/data/plan-edit', async (actual) => ({ ...(await actual<object>()), editPlan }));
vi.mock('@/data/backends', () => ({ useBackends: () => backends }));
vi.mock('@/data/session-panel', async (actual) => ({
  ...(await actual<object>()),
  useSessionGatesHistory: () => ({ data: { runs: gateRuns }, loading: false, error: null }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionDiff: () => ({ data: diffFiles.value && { files: diffFiles.value }, error: null }),
}));
vi.mock('@/data/runtime-models', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeModels: (_project: string | null, runtimes: readonly string[]) =>
    Object.fromEntries(runtimes.map((r) => [r, models[r] ?? { state: 'loading' }])),
}));
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { Clip } from '@/components/Clip';
import { useDrafts } from '@/data/drafts';
import { wantedRequest, focusRequest } from '@/data/focus-request';
import { useQueued } from '@/screens/sessions/compose';
import type { SnapshotSession } from '@/screens/board/panels-model';
import type { ModelsState } from '@/data/runtime-models';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 13, 12);
const noop = () => {};
const session = (extra: Partial<SnapshotSession>): SnapshotSession =>
  ({
    revision: 1,
    project_id: 'project-a',
    runtime: 'fixture',
    state: 'open',
    turn_count: 1,
    ...extra,
  }) as SnapshotSession;
const lead = session({ id: 'lead-1', revision: 4 });
const worker = session({ id: 'session-b', revision: 7, runtime: 'codex', workspace_id: 'ws-b' });
const backend = (id: string, runtime: string) =>
  ({ id, runtimes: [runtime], models: [], key: { env: 'KEY' }, key_present: true }) as never;

const row = (id: string, extra: Partial<Task>): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
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

const waiting = row('b', {
  order: 1,
  milestone_id: 'ms-sign',
  status: 'waiting',
  state: 'waiting_approval',
  claim: { session_id: 'session-b', runtime: 'codex', model: null },
  acceptance_checks: [
    { text: 'a bad signature returns 401', state: 'passed' },
    { text: 'the migration runs on staging', state: 'pending' },
  ],
  activity: {
    phase: 'waiting_approval',
    since: NOW,
    health: 'fresh',
    attempt: 1,
    waiting: { kind: 'approval', summary: 'git push', approval_id: 'approval-1', since: NOW },
  },
});
const plan = [
  row('a', { order: 0, milestone_id: 'ms-sign', status: 'done', state: 'merged' }),
  waiting,
  row('c', { order: 2, milestone_id: 'ms-report', status: 'running', state: 'running' }),
  row('d', { order: 3 }),
  row('e', { order: 4, milestone_id: 'ms-sign', status: 'failed', state: 'failed' }),
];

const board = (tasks: Task[] = plan) =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [],
    tasks,
    milestones: [
      {
        id: 'ms-sign',
        title: 'signing',
        session_ids: [],
        merged: 0,
        status: 'active',
        criteria: [],
      },
      {
        id: 'ms-report',
        title: 'reports',
        session_ids: [],
        merged: 0,
        status: 'active',
        criteria: [],
      },
    ],
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state: 'idle',
        inbox: 0,
        updated_at: 0,
        plan_version: 9,
      },
    ],
  }) as unknown as BoardModel;

const run = vi.fn(async (..._args: unknown[]) => null as string | null);
const openSession = vi.fn();
const drawer = (taskId = waiting.id, tasks: Task[] = plan) =>
  mount(() =>
    TaskDrawer({
      model: board(tasks),
      taskId,
      onSelect: noop,
      onOpenSession: openSession,
      onOpenStory: noop,
      tell: { sessions: [lead, worker], run },
    }),
  );
/** Renders a child element of a rendered tree from the props it was given. */
const inner = (tree: unknown, name: string) => {
  const element = named(tree as never, name);
  return mount(() => (element.type as (p: object) => ReactNode)(element.props));
};
const maybe = (tree: unknown, name: string) =>
  nodes(tree as never).find((n) => typeof n.type === 'function' && n.type.name === name);
const button = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n).includes(label));

beforeEach(() => {
  const listeners = { addEventListener: noop, removeEventListener: noop };
  vi.stubGlobal('window', {
    ...listeners,
    innerWidth: 1440,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', { ...listeners, activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  run.mockClear();
  editPlan.mockClear();
  openSession.mockClear();
  backends.splice(0);
  for (const runtime of Object.keys(models)) delete models[runtime];
  focusRequest(null);
  useDrafts.setState({ drafts: {} });
  gateRuns.splice(0);
  diffFiles.value = null;
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('the plan list in the task drawer', () => {
  it("lists the lead's plan by milestone, in plan order, with the drawer's task marked", () => {
    const list = inner(drawer().value, 'PlanList').value;
    const heads = nodes(list).filter((n) => n.type === 'h3');
    expect(heads.map(text)).toEqual([
      '阶段 1 signing',
      '阶段 2 reports',
      zh('board.drawer.plan.none'),
    ]);
    const rows = nodes(list).filter((n) => n.props.className === 'bd-plb');
    expect(rows.map(text)).toEqual([
      'task a已合并',
      'task b待批准',
      'task e失败',
      'task c运行中',
      'task d待办',
    ]);
    expect(rows.map((n) => n.props['aria-current'] ?? null)).toEqual([
      null,
      'true',
      null,
      null,
      null,
    ]);
    const counts = nodes(list).filter((n) => n.props.className === 'bd-plc');
    expect(counts.map(text)).toEqual(['1 / 3', '0 / 1', '0 / 1']);
  });

  it('has no plan list on a session that no lead planned', () => {
    const own = row('x', { id: 'session-x', owner_session_id: undefined, state: undefined });
    expect(maybe(drawer(own.id, [own]).value, 'PlanList')).toBeUndefined();
  });

  it('moves a task within its milestone from the keyboard, through the plan edit', () => {
    const list = inner(drawer().value, 'PlanList').value;
    const handle = (label: string) =>
      find(list, (n) => n.type === 'button' && n.props['aria-label'] === label);
    handle('移动 task e').props.onKeyDown({ key: 'ArrowUp', preventDefault: noop });
    handle('移动 task b').props.onKeyDown({ key: 'ArrowDown', preventDefault: noop });
    handle('移动 task a').props.onKeyDown({ key: 'ArrowUp', preventDefault: noop });
    const target = (id: string) => ({
      projectId: 'project-a',
      leadId: 'lead-1',
      planId: id,
      taskId: `lead-1:${id}`,
    });
    expect(editPlan.mock.calls).toEqual([
      [target('e'), [{ type: 'move_task', task_id: 'e', before: 'b' }], 9],
      [target('b'), [{ type: 'move_task', task_id: 'b', before: null }], 9],
    ]);
  });

  it('drops a dragged row before another row of its milestone only', () => {
    const h = inner(drawer().value, 'PlanList');
    const item = (title: string) =>
      find(h.value, (n) => n.type === 'li' && text(n).includes(title));
    const drag = { preventDefault: noop, dataTransfer: { setData: noop } };
    item('task e').props.onDragStart(drag);
    h.render();
    item('task c').props.onDragOver(drag);
    item('task c').props.onDrop(drag);
    expect(editPlan).not.toHaveBeenCalled();
    item('task a').props.onDragOver(drag);
    h.render();
    item('task a').props.onDrop(drag);
    expect(editPlan.mock.calls.map((call) => call[1])).toEqual([
      [{ type: 'move_task', task_id: 'e', before: 'a' }],
    ]);
  });

  it('moves a task next to a locked one, which itself stays put', () => {
    const locked = plan.map((task) =>
      task.id === waiting.id ? { ...task, order_locked: true as const } : task,
    );
    const list = () => inner(drawer('lead-1:a', locked).value, 'PlanList');
    const keys = list().value;
    expect(nodes(keys).some((n) => n.props['aria-label'] === '移动 task b')).toBe(false);
    find(keys, (n) => n.props['aria-label'] === '移动 task a').props.onKeyDown({
      key: 'ArrowDown',
      preventDefault: noop,
    });
    const h = list();
    const item = (title: string) =>
      find(h.value, (n) => n.type === 'li' && text(n).includes(title));
    expect(item('task b').props.draggable).toBeUndefined();
    const drag = { preventDefault: noop, dataTransfer: { setData: noop } };
    item('task e').props.onDragStart(drag);
    h.render();
    item('task b').props.onDragOver(drag);
    h.render();
    item('task b').props.onDrop(drag);
    expect(editPlan.mock.calls.map((call) => call[1])).toEqual([
      [{ type: 'move_task', task_id: 'a', before: 'c' }],
      [{ type: 'move_task', task_id: 'e', before: 'b' }],
    ]);
  });
});

describe('the rest of the task drawer', () => {
  it('names the drawer by its whole title, behind a three-line clip', () => {
    const tree = drawer().value;
    const name = find(tree, (n) => n.type === 'aside').props['aria-labelledby'];
    const heading = find(tree, (n) => n.props.id === name);
    expect(find(heading, (n) => n.type === Clip).props).toEqual({
      text: waiting.title,
      lines: 3,
    });
  });

  it('marks what backs a merged task among the badges at its head, and nothing without a level', () => {
    const backed = row('a', {
      status: 'done',
      state: 'merged',
      evidence_level: 'reviewed',
      evidence_reviewer: 'other_vendor',
    });
    const mark = (task: Task) => {
      const el = maybe(drawer(task.id, [task]).value, 'EvidenceMark');
      const drawn = el && (el.type as (p: object) => ReactNode)(el.props);
      return drawn ? [(drawn as never as { props: object }).props, text(drawn)] : null;
    };
    expect(mark(backed)).toEqual([
      expect.objectContaining({
        role: 'img',
        'aria-label': zh('board.evidence.reviewed.otherVendor.label'),
      }),
      zh('board.evidence.reviewed.otherVendor'),
    ]);
    expect(mark(row('a', { status: 'done', state: 'merged' }))).toBeNull();
  });

  it('ticks each acceptance check the task met, read-only', () => {
    const boxes = nodes(drawer().value).filter((n) => n.props.type === 'checkbox');
    expect(boxes.map((n) => [n.props.checked, n.props.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    const labels = nodes(drawer().value).filter((n) => n.type === 'label');
    expect(labels.map(text)).toEqual([
      'a bad signature returns 401',
      'the migration runs on staging',
    ]);
  });

  it('writes to the lead in the drawer and sends on Enter', async () => {
    const tree = drawer().value;
    expect(maybe(tree, 'TellLead')).toBeUndefined();
    const box = inner(tree, 'TellLeadBox');
    const area = () => find(box.value, (n) => n.type === 'textarea');
    expect(area().props['aria-label']).toBe(zh('board.lead.tell.title'));
    expect(area().props.value).toBe('关于任务「task b」（b）：\n');
    expect(text(box.value)).toContain(zh('board.drawer.tell.send'));
    area().props.onChange({ target: { value: '关于任务「task b」（b）：\n先做灰度开关' } });
    box.render();
    area().props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: noop,
    });
    await box.flush();
    expect(run.mock.calls).toEqual([
      [
        'session.send',
        { session_id: 'lead-1', input: '关于任务「task b」（b）：\n先做灰度开关' },
        4,
      ],
    ]);
  });

  it('sends a message to the lead once, until the text changes', async () => {
    const box = inner(drawer().value, 'TellLeadBox');
    const area = () => find(box.value, (n) => n.type === 'textarea');
    const send = () => find(box.value, (n) => n.type === 'button');
    area().props.onChange({ target: { value: '关于任务「task b」（b）：\n先做灰度开关' } });
    box.render();
    send().props.onClick();
    await box.flush();
    expect(text(send())).toContain(zh('board.lead.tell.sent'));
    expect(send().props.disabled).toBe(true);
    area().props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: noop,
    });
    await box.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps the message to the lead of each task while another task is shown', () => {
    const typed = '关于任务「task b」（b）：\n先做灰度开关';
    const first = inner(drawer().value, 'TellLeadBox');
    find(first.value, (n) => n.type === 'textarea').props.onChange({ target: { value: typed } });
    first.render();
    first.unmount();
    const other = inner(drawer(plan[2]!.id).value, 'TellLeadBox');
    expect(find(other.value, (n) => n.type === 'textarea').props.value).toBe(
      '关于任务「task c」（c）：\n',
    );
    const back = inner(drawer().value, 'TellLeadBox');
    expect(find(back.value, (n) => n.type === 'textarea').props.value).toBe(typed);
  });

  it('goes to the approval the task waits for: opens its session and asks for the request card', () => {
    button(drawer().value, zh('board.drawer.approve')).props.onClick();
    expect(wantedRequest()).toBe('approval-1');
    expect(openSession).toHaveBeenCalledWith('session-b');
    const quiet = row('b', { ...waiting, activity: undefined });
    const tree = drawer(quiet.id, [quiet]).value;
    expect(
      nodes(tree).some((n) => n.type === 'button' && text(n) === zh('board.drawer.approve')),
    ).toBe(false);
  });

  it('jumps to the approval in the needs-you strip beside it, and offers no jump without the strip or the item', () => {
    const approval = {
      source: { table: 'approvals', id: 'approval-1', revision: 2 },
      kind: 'permission',
      project_id: 'project-a',
      session_id: 'session-b',
      status: 'pending',
      created_at: NOW,
      reason: 'permission_requested',
      actions: [{ command: 'approval.respond', allowed: true }],
      unblocks: 0,
    } as unknown as NonNullable<BoardModel['needs']>[number];
    const onAskNeed = vi.fn();
    const shown = (needs: BoardModel['needs'], ask?: (key: string) => void) =>
      mount(() =>
        TaskDrawer({
          model: { ...board(), needs },
          taskId: waiting.id,
          onSelect: noop,
          onOpenSession: openSession,
          onOpenStory: noop,
          tell: { sessions: [lead, worker], run },
          onAskNeed: ask,
        }),
      ).value;
    const inNeeds = (tree: unknown) =>
      nodes(tree as never).filter(
        (n) => n.type === 'button' && text(n) === zh('board.drawer.inNeeds'),
      );
    const jump = inNeeds(shown([approval], onAskNeed));
    expect(jump).toHaveLength(1);
    jump[0]!.props.onClick();
    expect(onAskNeed).toHaveBeenCalledWith('approval-1');
    expect(openSession).not.toHaveBeenCalled();
    expect(inNeeds(shown([approval]))).toEqual([]);
    expect(inNeeds(shown([], onAskNeed))).toEqual([]);
    // Allowing or denying stays in the strip.
    const all = nodes(shown([approval], onAskNeed) as never).filter((n) => n.type === 'button');
    expect(all.map((n) => text(n))).not.toContain(zh('board.needs.actions.approve'));
    expect(all.map((n) => text(n))).not.toContain(zh('board.needs.actions.reject'));
  });

  const asking = row('b', {
    ...waiting,
    state: 'running',
    activity: {
      ...waiting.activity!,
      phase: 'waiting_input',
      waiting: { kind: 'input', summary: 'which region?', approval_id: 'approval-2', since: NOW },
    },
  });
  it.each([
    ['an approval its state already names', 0, waiting, 'board.task.phase.waitingApproval'],
    ['a question, which no state names', 1, asking, 'board.task.phase.waitingInput'],
  ])('lists the wait for %s among the badges %i times', (_, count, task, label) => {
    const tree = drawer(task.id, [task]).value;
    expect(nodes(tree).filter((n) => n.type === 'li' && text(n) === zh(label))).toHaveLength(count);
  });

  it.each([
    ['repeats the title', 0, 'task b'],
    ['says more than the title', 1, 'Sign every webhook'],
  ])('shows a goal that %s %i times', (_, count, goal) => {
    const task = row('b', { ...waiting, goal });
    const tree = drawer(task.id, [task]).value;
    expect(nodes(tree).filter((n) => n.type === 'p' && text(n) === goal)).toHaveLength(count);
  });

  it("redoes the task on another backend: switches the session's backend, then queues the message", async () => {
    backends.push(backend('other', 'codex'), backend('elsewhere', 'claude'));
    const redo = inner(drawer().value, 'Redo');
    const items = nodes(redo.value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'MenuItem',
    );
    expect(items.map(text)).toEqual(['other']);
    items[0]!.props.onClick();
    await redo.flush();
    // The switch may close the idle process, which moves the revision again; the queue sends at
    // whatever revision the session reaches.
    expect(run.mock.calls).toEqual([
      ['session.setBackend', { session_id: 'session-b', backend: 'other' }, 7],
    ]);
    expect(useQueued.getState().queued['session-b']).toEqual([
      { text: 'Redo this task from the start.', attachments: [], skills: [] },
    ]);
    useQueued.getState().remove('session-b', 0);
  });

  it("redoes the task on the runtime's own endpoint with its default model in place of one only the left backend serves", async () => {
    const relayed = { ...worker, backend_id: 'relay', requested_model: 'relay-only' };
    const own = (id: string, extra: object = {}) => ({
      id,
      label: id,
      permission_modes: [],
      efforts: [],
      default_effort: null,
      default: false,
      ...extra,
    });
    models.codex = {
      state: 'ready',
      models: [own('gpt-mini'), own('gpt-main', { default: true, resolved: 'gpt-main-2026' })],
    };
    const redoOn = async (requested: string) => {
      run.mockClear();
      const tree = mount(() =>
        TaskDrawer({
          model: board(),
          taskId: waiting.id,
          onSelect: noop,
          onOpenSession: noop,
          onOpenStory: noop,
          tell: { sessions: [lead, { ...relayed, requested_model: requested }], run },
        }),
      ).value;
      const redo = inner(tree, 'Redo');
      const items = nodes(redo.value).filter(
        (n) => typeof n.type === 'function' && n.type.name === 'MenuItem',
      );
      items[0]!.props.onClick();
      await redo.flush();
      useQueued.getState().remove('session-b', 0);
      return run.mock.calls;
    };
    expect(await redoOn('relay-only')).toEqual([
      ['session.setBackend', { session_id: 'session-b', backend: null, model: 'gpt-main' }, 7],
    ]);
    expect(await redoOn('gpt-main-2026')).toEqual([
      ['session.setBackend', { session_id: 'session-b', backend: null }, 7],
    ]);
  });

  it('offers no redo without another backend for the runtime', () => {
    backends.push(backend('elsewhere', 'claude'));
    expect(maybe(drawer().value, 'Redo')).toBeUndefined();
  });

  it('gives each attempt its changed lines and time taken, and no line count when the attempt has none', () => {
    const segment = (extra: Partial<Task['segments'][number]>) =>
      ({
        session_id: null,
        model: null,
        started_at: NOW - 52 * 60_000,
        ended_at: NOW,
        tokens: 0,
        ...extra,
      }) as Task['segments'][number];
    const tried = row('t', {
      segments: [
        segment({
          id: 'seg-kept',
          title: 'signature check',
          runtime: 'claude',
          status: 'done',
          additions: 96,
          deletions: 8,
        }),
        segment({ id: 'seg-dropped', title: 'first try', runtime: 'codex', status: 'discarded' }),
      ],
    });
    const rows = nodes(drawer(tried.id, [tried]).value).filter(
      (n) => n.props.className === 'bd-dbtn bd-dseg',
    );
    const part = (n: unknown, className: string) =>
      nodes(n as never).find((c) => c.props.className === className);
    expect(rows.map((n) => text(part(n, 'bd-dfx') ?? null))).toEqual(['+96 −8', '']);
    expect(rows.map((n) => text(part(n, 'bd-dtook')))).toEqual(['52 分钟', '52 分钟']);
    expect(text(rows[1])).toContain('已丢弃');
    expect(text(rows[1])).not.toContain('+0');
  });

  it('lists the files the task may change, one path per row, and leaves the part out without any', () => {
    const scoped = row('s', { scope: ['src/webhooks/**', 'db/migrations/**'] });
    const section = (tree: unknown) =>
      nodes(tree as never).find(
        (n) => n.type === 'section' && text(n).startsWith(zh('board.task.drawer.scope')),
      );
    const paths = nodes(section(drawer(scoped.id, [scoped]).value)).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'PathText',
    );
    expect(paths.map((n) => [n.props.path, n.props.className])).toEqual([
      ['src/webhooks/**', 'mono'],
      ['db/migrations/**', 'mono'],
    ]);
    const open = row('o', { scope: [] });
    expect(section(drawer(open.id, [open]).value)).toBeUndefined();
  });

  it('measures the tokens used against the plan budget in the one budget section, full past it', () => {
    const spent = (id: string, tokens: number, budget?: number) =>
      row(id, {
        ...(budget !== undefined && { token_budget: budget }),
        segments: [
          {
            id: `seg-${id}`,
            session_id: null,
            title: id,
            runtime: 'claude',
            model: null,
            status: 'running',
            started_at: null,
            ended_at: null,
            tokens,
          },
        ],
      });
    const budget = (task: Task) => {
      const tree = drawer(task.id, [task]).value;
      const sections = nodes(tree).filter(
        (n) => n.type === 'section' && text(n).startsWith(zh('board.recovery.budget.heading')),
      );
      const meters = nodes(sections).filter((n) => n.props.role === 'img');
      return {
        sections: sections.length,
        meters: meters.map((n) => [n.props['aria-label'], n.props.style['--v']]),
        said: text(sections[0] ?? null),
        all: text(tree),
      };
    };
    const under = budget(spent('under', 30_000, 100_000));
    expect(under.sections).toBe(1);
    expect(under.meters).toEqual([
      [zhf('board.recovery.budget.planMeter', { percent: 30 }), '30%'],
    ]);
    expect(under.said).toContain(`${zh('board.recovery.budget.plan')}30k / 100k30%`);
    expect(under.all).not.toContain('100k token');
    const over = budget(spent('over', 150_000, 100_000));
    expect(over.sections).toBe(1);
    expect(over.meters).toEqual([
      [zhf('board.recovery.budget.planMeter', { percent: 150 }), '100%'],
    ]);
    expect(over.said).toContain('150k / 100k150%');
    const plain = budget(spent('plain', 30_000));
    expect(plain.sections).toBe(0);
    expect(plain.all).toContain('30k tokens');
  });

  it('stays open for a click or Esc in a select list it opened, and closes for one elsewhere', () => {
    const heard = new Map<string, (e: object) => void>();
    const listeners = {
      addEventListener: (type: string, fn: (e: object) => void) => heard.set(type, fn),
      removeEventListener: noop,
    };
    vi.stubGlobal('window', {
      ...listeners,
      innerWidth: 1440,
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('document', { ...listeners, activeElement: null });
    const onSelect = vi.fn();
    mount(() =>
      TaskDrawer({
        model: board(),
        taskId: waiting.id,
        onSelect,
        onOpenSession: noop,
        onOpenStory: noop,
        tell: { sessions: [lead, worker], run },
      }),
    );
    // Matches a selector list against the classes of the element and its ancestors.
    const element = (...classes: string[]) => ({
      closest: (selectors: string) =>
        selectors.split(',').some((s) => classes.includes(s.trim().slice(1))) ? {} : null,
    });
    const option = element('mn-row', 'mn', 'mn-list', 'pop');
    heard.get('pointerdown')!({ target: option });
    heard.get('keydown')!({ key: 'Escape', target: option });
    heard.get('pointerdown')!({
      target: element('ib', 'rq-acts', 'rq-hd', 'rq', 'bf-need', 'bf-needs'),
    });
    expect(onSelect).not.toHaveBeenCalled();
    heard.get('pointerdown')!({ target: element('bd-canvas') });
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('lays out its parts without the viewport', () => {
    const css = readFileSync(
      new URL('../../apps/web/src/screens/board/drawer.css', import.meta.url),
      'utf8',
    );
    expect(css).not.toMatch(/\d(vh|vw|dvh|svh)\b|position:\s*fixed/);
    expect(css).toMatch(/container:\s*bd-drw \/ inline-size/);
  });
});

describe('the task drawer graphics', () => {
  const failing = row('f', {
    status: 'failed',
    state: 'failed',
    checks: 'fail',
    milestone_id: 'ms-sign',
    claim: { session_id: 'session-b', runtime: 'codex', model: null },
    additions: 212,
    deletions: 40,
    gate_steps: [
      { name: 'lint', state: 'passed' },
      { name: 'test:web', state: 'failed', tests: { passed: 40, failed: 3, skipped: 0 } },
      { name: 'typecheck', state: 'passed' },
    ],
  });
  const result = (name: string, duration_ms: number) => ({ name, command: [], duration_ms });
  const pipeline = () => {
    const checks = inner(drawer(failing.id, [failing]).value, 'GateChecks');
    const blocks = nodes(checks.value).filter((n) => n.props.className === 'bd-gp-s');
    return {
      checks,
      graphic: find(checks.value, (n) => n.props.className === 'bd-gp'),
      names: blocks.map((n) => text(find(n, (c) => c.props.className === 'bd-gp-n'))),
      grow: blocks.map((n) => n.props.style.flexGrow as number),
    };
  };

  it('draws one block per gate step, failed first, as wide as the newest run timed it', () => {
    gateRuns.push(
      {
        run_id: 'new',
        commit: 'c2',
        started_at: '',
        finished_at: '',
        results: [result('lint', 6_000), result('test:web', 72_000), result('typecheck', 18_000)],
      },
      { run_id: 'old', commit: 'c1', started_at: '', finished_at: '', results: [] },
    );
    const { checks, graphic, names, grow } = pipeline();
    expect(names).toEqual(['test:web', 'lint', 'typecheck']);
    expect(grow[0]! / grow[1]!).toBe(12);
    expect(grow[2]! / grow[1]!).toBe(3);
    expect(graphic.props.role).toBe('img');
    expect(graphic.props['aria-label']).toContain(
      zhf('board.drawer.gate.testsFailed', { count: 3 }),
    );
    expect(text(find(checks.value, (n) => n.props.className === 'bd-dsv'))).toBe(
      zhf('lib.time.minutesSeconds', { minutes: 1, seconds: 36 }),
    );
  });

  it('draws even blocks without the run times, and reruns only the failed steps of the session', async () => {
    const { checks, grow } = pipeline();
    expect(grow).toEqual([1, 1, 1]);
    expect(nodes(checks.value).some((n) => n.props.className === 'bd-dsv')).toBe(false);
    button(checks.value, zh('board.drawer.gate.rerunFailed')).props.onClick();
    await checks.flush();
    expect(run.mock.calls).toEqual([
      ['session.gates.run', { session_id: 'session-b', only_failed: true }, 7],
    ]);
  });

  it('gives each changed file a bar scaled to the largest file, beside the totals', () => {
    diffFiles.value = [
      { path: 'tests/acceptance/verify/run.mjs', additions: 148, deletions: 31, untracked: false },
      { path: 'drivers/window.mjs', additions: 64, deletions: 9, untracked: false },
    ];
    const tree = drawer(failing.id, [failing]).value;
    const cells = find(tree, (n) => n.props.className === 'bd-dcells');
    expect(cells.props['aria-label']).toBe(
      zhf('board.drawer.changes.total', { additions: 212, deletions: 40 }),
    );
    expect(nodes(cells).map((n) => n.props['data-k'] ?? null)).toEqual([
      null,
      'a',
      'a',
      'a',
      'a',
      'd',
    ]);
    const files = inner(tree, 'ChangedFiles').value;
    const bars = nodes(files).filter((n) => n.props.className === 'bd-dfb');
    expect(bars.map((n) => n.props['aria-label'])).toEqual([
      zhf('board.drawer.changes.file', {
        path: 'tests/acceptance/verify/run.mjs',
        additions: 148,
        deletions: 31,
      }),
      zhf('board.drawer.changes.file', { path: 'drivers/window.mjs', additions: 64, deletions: 9 }),
    ]);
    expect(
      bars.map((n) =>
        nodes(n)
          .filter((i) => i.type === 'i')
          .map((i) => i.props.style.flexGrow),
      ),
    ).toEqual([
      [148, 31, 0],
      [64, 9, 106],
    ]);
  });

  it('draws the budget as two rings named by their percent', () => {
    const spent = row('r', {
      started_at: NOW - 60_000,
      budget: {
        ratio: 0.62,
        input_tokens: 1_240_000,
        wall_ms: 41 * 60_000,
        limit: { input_tokens: 2_000_000, wall_ms: 90 * 60_000 },
      },
    });
    const rings = nodes(drawer(spent.id, [spent]).value).filter(
      (n) => n.props.className === 'bd-drg-c',
    );
    expect(rings.map((n) => [n.props.role, n.props['aria-label']])).toEqual([
      ['img', zhf('board.recovery.budget.tokensMeter', { percent: 62 })],
      ['img', zhf('board.recovery.budget.timeMeter', { percent: 46 })],
    ]);
  });

  it('draws the upstream tasks, the task and its milestone, the met dependency in green', () => {
    const tasks = [plan[0]!, failing];
    const model = { ...board(tasks), edges: [{ from: plan[0]!.id, to: failing.id, state: 'met' }] };
    const tree = mount(() =>
      TaskDrawer({
        model: model as BoardModel,
        taskId: failing.id,
        onSelect: noop,
        onOpenSession: noop,
        onOpenStory: noop,
      }),
    ).value;
    const graph = find(tree, (n) => n.props.className === 'bd-dg');
    expect(graph.props.role).toBe('img');
    expect(graph.props['aria-label']).toContain('task a');
    expect(graph.props['aria-label']).toContain('signing');
    const boxes = nodes(graph).filter((n) => String(n.props.className).startsWith('bd-dg-'));
    expect(boxes.map((n) => [n.props.className, text(n)])).toEqual([
      ['bd-dg-c', 'task a'],
      ['bd-dg-n', 'task a'],
      ['bd-dg-n bd-dg-me', 'task f'],
      ['bd-dg-ms', '0 / 0signing'],
      ['bd-dg-mh', '0 / 0'],
      ['bd-dg-mn', '0 / 0'],
    ]);
    expect(
      nodes(graph)
        .filter((n) => n.type === 'path')
        .map((n) => n.props['data-met']),
    ).toEqual([true, undefined]);
  });

  it('heads the details with the hand-backs and the milestone', () => {
    const handed = row('h', {
      ...failing,
      activity: { phase: 'idle', since: NOW, health: 'fresh', attempt: 3, handed_back: ['a', 'b'] },
    });
    const meta = find(drawer(handed.id, [handed]).value, (n) => n.props.className === 'bd-dmeta');
    expect(text(meta)).toContain(zhf('board.recovery.step.handedBackCount', { count: 2 }));
    expect(text(meta)).toContain('signing');
  });
});
