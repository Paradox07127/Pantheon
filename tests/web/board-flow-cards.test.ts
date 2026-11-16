import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel, BoardTaskState } from '@pantheon/protocol';
import { HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'card' }),
);
const viewport = vi.hoisted(() => ({ zoom: 1 }));
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useReactFlow: () => ({ setViewport: async () => true }),
  useStore: (select: (s: { transform: [number, number, number] }) => unknown) =>
    select({ transform: [0, 0, viewport.zoom] }),
}));
import { FlowChart } from '@/screens/board/FlowPanel';
import { TaskCard as FlowNode } from '@/screens/board/FlowNode';
import { activityLine } from '@/screens/board/activity';
import { ColumnsPanel } from '@/screens/board/Columns';

type Task = BoardModel['tasks'][number];
const NOW = Date.UTC(2026, 10, 7, 12);

const task = (id: string, status: Task['status'], activity?: Task['activity']): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status,
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: activity !== undefined,
  ...(activity ? { activity } : {}),
});

const runningTool: Task['activity'] = {
  phase: 'tool',
  since: NOW - 10 * 60_000,
  tool: { name: 'Bash', target: 'pnpm test' },
  health: 'stalled',
  attempt: 2,
};

const model = (tasks: Task[], edges: BoardModel['edges']) =>
  ({ since: 0, now: NOW, lanes: [], merges: [], tasks, edges }) as unknown as BoardModel;

const hosts: HookHost<any>[] = [];
afterEach(() => {
  unmountAll();
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
  viewport.zoom = 1;
});

describe('flow chart keyboard access', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  const box = (tree: unknown) =>
    find(tree as any, (n) => String(n.props.className ?? '').startsWith('bd-fc'));
  /** The canvas under the chart, laid out 1000px wide. */
  function canvas(m: BoardModel, onSelect: (id: string) => void) {
    const chart = FlowChart({ model: m, selected: null, onSelect, title: 'flow' });
    const Canvas = named(chart, 'FlowCanvas').type as (
      props: Parameters<typeof FlowChart>[0],
    ) => ReactElement<any>;
    const h = new HookHost(
      () => Canvas({ model: m, selected: null, onSelect, title: 'flow' }),
      (tree) => (box(tree).props.ref.current ??= { clientWidth: 1000 }),
    );
    hosts.push(h);
    return h.render();
  }

  it('lets Tab reach every task node and opens the focused one with Enter or Space', () => {
    const onSelect = vi.fn();
    const m = model(
      [task('build', 'done'), task('ship', 'todo')],
      [{ from: 'build', to: 'ship', state: 'met' }],
    );
    const tree = canvas(m, onSelect);
    const flow = find(tree, (n) => 'nodeTypes' in n.props);
    expect(flow.props.nodesFocusable).not.toBe(false);
    expect(flow.props.nodes.map((n: { id: string }) => n.id)).toEqual(['build', 'ship']);
    for (const node of flow.props.nodes) expect(node.focusable).not.toBe(false);

    for (const key of ['Enter', ' ']) {
      const preventDefault = vi.fn();
      box(tree).props.onKeyDown({
        key,
        preventDefault,
        target: { closest: () => ({ getAttribute: () => 'ship' }) },
      });
      expect(preventDefault).toHaveBeenCalled();
    }
    expect(onSelect.mock.calls).toEqual([['ship'], ['ship']]);
  });

  it('describes a task node by the keys that open it, not by delete or move keys', () => {
    const flow = find(
      canvas(model([task('build', 'done')], []), () => {}),
      (n) => 'nodeTypes' in n.props,
    );
    // xyflow reads the keyboardDisabled text while keyboard access is on.
    const config = flow.props.ariaLabelConfig ?? {};
    for (const key of ['node.a11yDescription.default', 'node.a11yDescription.keyboardDisabled']) {
      expect(config[key]).toContain('回车');
      expect(config[key]).not.toMatch(/delete|arrow|删除|方向键/i);
    }
  });
});

/** Calls function components down to host elements, leaving hover tips and xyflow handles. */
const expand = (tree: ReactNode): ReactNode => {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return tree;
  const el = tree as ReactElement<any>;
  if (typeof el.type === 'function' && el.type.name !== 'Tip')
    return expand((el.type as (p: unknown) => ReactNode)(el.props));
  return { ...el, props: { ...el.props, children: expand(el.props.children) } } as ReactElement;
};

const flowNode = (t: Task, line: string | null = null) =>
  expand(
    FlowNode({
      data: { task: t, selected: false, now: NOW, critical: false, ready: false, line },
    } as unknown as Parameters<typeof FlowNode>[0]),
  );
const byClass = (tree: ReactNode, name: string) =>
  nodes(tree).find((n) => n.props.className === name);
const marks = (tree: ReactNode) =>
  nodes(byClass(tree, 'bd-nrt'))
    .filter((n) => n.type === 'title')
    .map((n) => text(n));

const state = (key: string) => zh(`board.task.state.${key}`);
const STATE_NAMES: Record<BoardTaskState, string> = {
  todo: state('todo'),
  waiting_upstream: state('waitingUpstream'),
  claimed: state('claimed'),
  running: state('running'),
  waiting_approval: state('waitingApproval'),
  blocked: state('blocked'),
  needs_attention: state('needsAttention'),
  gating: state('gating'),
  awaiting_acceptance: state('awaitingAcceptance'),
  awaiting_merge: state('awaitingMerge'),
  merged: state('merged'),
  failed: state('failed'),
};

const segment = (id: string, tokens: number): Task['segments'][number] => ({
  id,
  session_id: id,
  title: '',
  runtime: 'codex',
  model: null,
  status: 'running',
  started_at: NOW - 12 * 60_000,
  ended_at: null,
  tokens,
});

describe('flow chart task node', () => {
  it.each(Object.keys(STATE_NAMES) as BoardTaskState[])(
    'shows a %s task by its own state name and glyph',
    (state) => {
      const tree = flowNode({ ...task('build', 'todo'), state });
      expect(text(byClass(tree, 'bd-nrow bd-nw'))).toContain(STATE_NAMES[state]);
      const glyph = find(tree, (n) => n.type === 'svg' && n.props.className === 'bd-sti');
      expect(glyph.props['data-state']).toBe(state);
    },
  );

  it('keeps the session status on a row opened without a task', () => {
    const tree = flowNode(task('session', 'idle'));
    expect(text(byClass(tree, 'bd-nrow bd-nw'))).toContain(zh('board.task.status.idle'));
    const glyph = find(tree, (n) => n.type === 'svg' && n.props.className === 'bd-sti');
    expect(glyph.props['data-state']).toBeUndefined();
  });

  it('names the claimed model, else the planned one, else draws no runtime glyph', () => {
    const planned = { runtime: 'claude', model: 'claude-opus-5-5' };
    const claim = { session_id: 's', runtime: 'codex', model: 'gpt-6.1-sol' };
    const both = flowNode({ ...task('a', 'running'), state: 'running', claim, planned });
    expect(byClass(both, 'bd-nrt')!.props['aria-label']).toBe('Codex, gpt-6.1-sol');
    expect(marks(both)).toEqual(['Codex']);
    const plan = flowNode({ ...task('a', 'todo'), state: 'todo', planned });
    expect(byClass(plan, 'bd-nrt')!.props['aria-label']).toBe('Claude, claude-opus-5-5');
    expect(marks(plan)).toEqual(['Claude Code']);
    expect(byClass(flowNode({ ...task('a', 'todo'), state: 'todo' }), 'bd-nrt')).toBeUndefined();
  });

  it("adds the model maker's mark only when it differs from the runtime's own", () => {
    const planned = { runtime: 'agy', model: 'claude-sonnet-4-5' };
    const other = flowNode({ ...task('a', 'todo'), state: 'todo', planned });
    expect(marks(other)).toEqual(['Antigravity', 'Claude']);
    const own = { runtime: 'agy', model: 'gemini-3-pro' };
    expect(marks(flowNode({ ...task('a', 'todo'), state: 'todo', planned: own }))).toEqual([
      'Antigravity',
    ]);
    const bare = flowNode({ ...task('a', 'todo'), state: 'todo', planned: { model: 'gpt-5' } });
    expect(marks(bare)).toEqual(['OpenAI']);
  });

  it('marks a task not started that waits on upstream with the neutral badge', () => {
    const waits = flowNode({
      ...task('a', 'todo'),
      state: 'waiting_upstream',
      dispatch_wait: 'upstream',
      blockers: ['排队中：等待依赖'],
    });
    expect(nodes(waits).flatMap((n) => n.props['data-kind'] ?? [])).toEqual(['upstream']);
  });

  it('draws a waiting or blocked state once, in the leading glyph, which names the blockers', () => {
    const approving = flowNode({
      ...task('a', 'waiting', {
        phase: 'waiting_approval',
        since: NOW,
        health: 'fresh',
        attempt: 1,
        waiting: { kind: 'approval', summary: 'pnpm migrate', approval_id: 'ap', since: NOW },
      }),
      state: 'waiting_approval',
    });
    expect(nodes(approving).flatMap((n) => n.props['data-kind'] ?? [])).toEqual([]);
    const blocked = flowNode({
      ...task('b', 'running'),
      state: 'blocked',
      blockers: ['合并受阻，2 个冲突文件'],
    });
    expect(nodes(blocked).flatMap((n) => n.props['data-kind'] ?? [])).toEqual([]);
    const label = zhf('board.task.badge.blocked', { reasons: '合并受阻，2 个冲突文件' });
    const glyph = nodes(blocked).find((n) => n.props['aria-label'] === label)!;
    expect(glyph.props.role).toBe('img');
    expect(nodes(glyph).some((n) => n.props['data-state'] === 'blocked')).toBe(true);
  });

  it('keeps the question badge on a plan task whose question holds it in the approval state', () => {
    const asking = flowNode({
      ...task('a', 'waiting', {
        phase: 'waiting_input',
        since: NOW,
        health: 'fresh',
        attempt: 1,
        waiting: { kind: 'input', summary: 'Which store?', approval_id: 'ap', since: NOW },
      }),
      state: 'waiting_approval',
    });
    const badges = nodes(asking).filter((n) => n.props['data-kind'] === 'waiting');
    expect(badges.map((n) => n.props['aria-label'])).toEqual([zh('board.task.phase.waitingInput')]);
  });

  it('shows how long a started task has run, and no time before it starts', () => {
    const running: Task = {
      ...task('a', 'running', { ...runningTool, health: 'fresh' }),
      state: 'running',
      started_at: NOW - 12 * 60_000,
      segments: [segment('s1', 120_000), segment('s2', 64_000)],
    };
    expect(text(byClass(flowNode(running), 'bd-ntm'))).toBe('12 分钟');
    const merged = { ...running, state: 'merged' as const, ended_at: NOW - 2 * 60_000 };
    expect(text(byClass(flowNode(merged), 'bd-ntm'))).toBe('10 分钟');
    expect(byClass(flowNode({ ...task('a', 'todo'), state: 'todo' }), 'bd-ntm')).toBeUndefined();
  });

  const full: Task = {
    ...task('a', 'running', { ...runningTool, health: 'fresh' }),
    state: 'running',
    started_at: NOW - 12 * 60_000,
    checks: 'pass',
    additions: 42,
    deletions: 6,
    claim: { session_id: 's', runtime: 'codex', model: 'gpt-6.1-sol' },
    planned: { kind: { domain: 'backend-logic', tier: 't2' } },
  };
  const rows = (tree: ReactNode) =>
    nodes(tree)
      .filter((n) => String(n.props.className ?? '').startsWith('bd-nrow'))
      .map((n) => n.props.className);

  it('keeps only the status icon and title below 60% zoom', () => {
    viewport.zoom = 0.6;
    expect(rows(flowNode(full))).toEqual([
      'bd-nrow bd-nh',
      'bd-nrow bd-nw',
      'bd-nrow',
      'bd-nrow bd-nq',
    ]);
    viewport.zoom = 0.5;
    const tree = flowNode(full);
    expect(rows(tree)).toEqual([]);
    const pill = byClass(tree, 'bd-npill')!;
    const shown = [pill.props.children].flat().filter((c) => c && typeof c === 'object');
    expect(shown.map((n) => n.props.className)).toEqual(['bd-sti', 'bd-nt']);
    expect(text(byClass(tree, 'bd-nt'))).toBe('task a');
  });

  it('draws a layer only when the task has data for it', () => {
    const shown = flowNode(full);
    expect(byClass(shown, 'bd-nstg')!.props['aria-label']).toBe('阶段：实现，5 步里的第 2 步');
    expect(byClass(shown, 'bd-ngate')!.props['aria-label']).toBe(zh('board.plan.flow.checks.pass'));
    expect(text(byClass(shown, 'bd-ndiff'))).toBe('+42 −6');
    expect(byClass(shown, 'bd-nkind')!.props['aria-label']).toBe(
      zh('data.workflowPolicy.domain.backendLogic'),
    );
    expect(byClass(shown, 'bd-nrt')).toBeDefined();

    const bare = flowNode(task('session', 'running'));
    expect(rows(bare)).toEqual(['bd-nrow bd-nh', 'bd-nrow bd-nw']);
    for (const name of ['bd-nrt', 'bd-nkind', 'bd-nstg', 'bd-ngate', 'bd-ndiff', 'bd-ntm'])
      expect(byClass(bare, name), name).toBeUndefined();
    // A failed task whose checks did not fail gives no stage to point at.
    const failed = flowNode({ ...task('a', 'failed'), state: 'failed' });
    expect(byClass(failed, 'bd-nstg')).toBeUndefined();
  });

  it('marks a flow path other than direct beside the runtime, and nothing on a row without one', () => {
    const planned = { runtime: 'claude', model: 'claude-opus-5-5' };
    for (const [path, icon, label] of [
      ['dispatch', 'Split', zh('data.workflowPolicy.path.dispatch')],
      ['review_loop', 'Repeat', zh('data.workflowPolicy.path.reviewLoop')],
    ] as const) {
      const tree = flowNode({ ...task('a', 'todo'), state: 'todo', planned, path });
      const row = byClass(tree, 'bd-nrow bd-nw')!;
      const mark = byClass(row, 'bd-npath')!;
      expect(mark.props).toMatchObject({ role: 'img', 'aria-label': label });
      expect(nodes(mark).map((n) => (n.type as { displayName?: string }).displayName)).toContain(
        icon,
      );
      expect(nodes(row).map((n) => n.props.className)).toEqual(
        expect.arrayContaining(['bd-nrt', 'bd-npath']),
      );
    }
    expect(byClass(flowNode({ ...task('a', 'todo'), state: 'todo' }), 'bd-npath')).toBeUndefined();
    const direct = flowNode({ ...task('a', 'todo'), state: 'todo', planned, path: 'direct' });
    expect(
      nodes(direct).some((n) => n.props['aria-label'] === zh('data.workflowPolicy.path.direct')),
    ).toBe(false);
  });

  it('marks a task whose user edit waits for the lead', () => {
    const waiting = flowNode({ ...task('a', 'todo'), state: 'todo', pending_edit: true });
    expect(text(byClass(waiting, 'bd-pchip'))).toBe(zh('board.plan.flow.pendingEdit'));
    const settled = flowNode({ ...task('a', 'todo'), state: 'todo', pending_edit: false });
    expect(byClass(settled, 'bd-pchip')).toBeUndefined();
  });

  const checks = (count: number, state: 'pending' | 'passed' | 'failed' = 'pending') =>
    Array.from({ length: count }, (_, i) => ({ text: `check ${i}`, state }));
  const squares = (tree: ReactNode) =>
    nodes(byClass(tree, 'bd-nacc')).filter((n) => n.type === 'i');
  const facts: Task = {
    ...full,
    context: { used_tokens: 82_000, window_tokens: 100_000 },
    acceptance_checks: [
      { text: 'retries three times', state: 'passed' },
      { text: 'no second refund', state: 'failed' },
      { text: 'logs the key', state: 'pending' },
    ],
    gate_steps: [
      { name: 'lint', state: 'passed' },
      { name: 'unit', state: 'running' },
      { name: 'e2e', state: 'pending' },
    ],
    successors: 2,
    external_review: { rounds: 2, verdict: 'failed' },
  };

  it('draws the context ring, warning past 80%', () => {
    const ring = byClass(flowNode(facts), 'bd-nctx')!;
    expect(ring.props['aria-label']).toBe('上下文已用 82%');
    expect(ring.props['data-high']).toBe(true);
    const calm = flowNode({ ...facts, context: { used_tokens: 80_000, window_tokens: 100_000 } });
    expect(byClass(calm, 'bd-nctx')!.props['aria-label']).toBe('上下文已用 80%');
    expect(byClass(calm, 'bd-nctx')!.props['data-high']).toBeUndefined();
  });

  it('draws one square per acceptance check by its state, the first seven past eight', () => {
    const tree = flowNode(facts);
    expect(byClass(tree, 'bd-nacc')!.props['aria-label']).toBe('验收判据 3 条，满足 1 条');
    expect(squares(tree).map((n) => n.props['data-state'])).toEqual([
      'passed',
      'failed',
      'pending',
    ]);
    const eight = flowNode({ ...full, acceptance_checks: checks(8) });
    expect(squares(eight)).toHaveLength(8);
    expect(text(byClass(eight, 'bd-nacc'))).toBe('');
    const nine = flowNode({ ...full, acceptance_checks: checks(9, 'passed') });
    expect(squares(nine)).toHaveLength(7);
    expect(text(byClass(nine, 'bd-nacc'))).toBe('+2');
    expect(byClass(nine, 'bd-nacc')!.props['aria-label']).toBe('验收判据 9 条，满足 9 条');
  });

  it('splits the gate bar into its steps by state and counts the passed ones', () => {
    const tree = flowNode(facts);
    const gate = byClass(tree, 'bd-ngate')!;
    expect(gate.props['aria-label']).toBe('门禁 3 步，过 1 步');
    expect(
      nodes(gate)
        .filter((n) => n.type === 'i')
        .map((n) => n.props['data-state']),
    ).toEqual(['passed', 'running', 'pending']);
    expect(text(byClass(tree, 'bd-ngn'))).toBe('1/3');
  });

  it('counts the follow-up tasks and shows the external review rounds and verdict', () => {
    const tree = flowNode(facts);
    const successors = nodes(tree).find((n) => n.props['aria-label'] === '2 个后续任务')!;
    expect(text(successors)).toBe('2');
    expect(
      nodes(successors).map((n) => (n.type as { displayName?: string }).displayName),
    ).toContain('CornerDownRight');
    const review = byClass(tree, 'bd-nrow bd-nrv')!;
    expect(text(review)).toBe('外审 2 轮');
    const verdict = nodes(review).find((n) => n.props['data-verdict'])!;
    expect(verdict.props['data-verdict']).toBe('failed');
    expect(verdict.props['aria-label']).toBe(zh('board.plan.flow.review.failed'));
    expect(rows(tree)).toEqual([
      'bd-nrow bd-nh',
      'bd-nrow bd-nw',
      'bd-nrow',
      'bd-nrow bd-nq',
      'bd-nrow bd-nrv',
    ]);
  });

  it('leaves out each fact the task has no data for, and all of them below 60% zoom', () => {
    const factClasses = ['bd-nctx', 'bd-nacc', 'bd-ngn', 'bd-nsucc', 'bd-nrow bd-nrv'];
    const bare = flowNode(full);
    for (const name of factClasses) expect(byClass(bare, name), name).toBeUndefined();
    expect(byClass(flowNode({ ...facts, successors: 0 }), 'bd-nsucc')).toBeUndefined();
    const onlyChecks = flowNode({
      ...task('a', 'todo'),
      state: 'todo',
      acceptance_checks: checks(2),
    });
    expect(rows(onlyChecks)).toEqual([
      'bd-nrow bd-nh',
      'bd-nrow bd-nw',
      'bd-nrow',
      'bd-nrow bd-nq',
    ]);
    expect(nodes(byClass(onlyChecks, 'bd-nrow bd-nq')).map((n) => n.props.className)).toEqual([
      'bd-nrow bd-nq',
      'bd-nend',
      'bd-nacc',
      undefined,
      undefined,
    ]);
    viewport.zoom = 0.5;
    const compact = flowNode(facts);
    expect(rows(compact)).toEqual([]);
    for (const name of factClasses) expect(byClass(compact, name), name).toBeUndefined();
  });
});

describe('flow chart status line', () => {
  const queued: Task['activity'] = { phase: 'queued', since: NOW, health: 'fresh', attempt: 1 };
  const ups = (states: BoardTaskState[]) =>
    states.map((state, i) => ({ ...task(`up${i}`, 'todo'), state }));
  const waitingOn = (upstream: Task[]) => {
    const down: Task = {
      ...task('down', 'todo', queued),
      state: 'waiting_upstream',
      dispatch_wait: 'upstream',
    };
    const board = model(
      [...upstream, down],
      upstream.map((u) => ({ from: u.id, to: 'down', state: 'pending' as const })),
    );
    return activityLine(down, NOW, board);
  };

  it('names what a task waits for and what a merged task landed', () => {
    const capacity: Task = {
      ...task('a', 'todo', queued),
      state: 'todo',
      dispatch_wait: 'capacity',
    };
    expect(activityLine(capacity, NOW)).toBe(zh('board.task.activity.waitingSlot'));
    const places = { ...model([capacity], []), task_places: { used: 4, limit: 4 } };
    expect(activityLine(capacity, NOW, places)).toBe('等待空位 4/4');
    expect(waitingOn(ups(['running', 'todo', 'merged']))).toBe('等待 2 个依赖');
    expect(waitingOn(ups(['failed', 'merged']))).toBe('依赖失败：task up0');
    const approval: Task = {
      ...task('a', 'waiting', {
        phase: 'waiting_approval',
        since: NOW,
        health: 'fresh',
        attempt: 1,
        waiting: { kind: 'approval', summary: 'pnpm add left-pad', approval_id: 'x', since: NOW },
      }),
      state: 'waiting_approval',
    };
    expect(activityLine(approval, NOW)).toContain('pnpm add left-pad');
    const claimed: Task = {
      ...task('a', 'running', { phase: 'starting', since: NOW, health: 'fresh', attempt: 1 }),
      state: 'claimed',
    };
    expect(activityLine(claimed, NOW)).toBe(zh('board.task.activity.claimed'));
    const merged: Task = {
      ...task('a', 'done'),
      state: 'merged',
      done_by: 'merged',
      additions: 212,
      deletions: 40,
      segments: [segment('s1', 0)],
    };
    const board = {
      ...model([merged], []),
      merges: [{ session_id: 's1', sha: '3e1c9a0f00d', additions: 212, deletions: 40 }],
    } as unknown as BoardModel;
    expect(activityLine(merged, NOW, board)).toBe('3e1c9a0 +212 −40');
  });
});

/** Calls function components down to the host element they render. */
const rendered = (el: ReactElement<any>): ReactElement<any> => {
  while (typeof el.type === 'function')
    el = (el.type as (p: unknown) => ReactElement<any>)(el.props);
  return el;
};

describe('column task card', () => {
  const card = (t: Task) => {
    const h = mount(() =>
      ColumnsPanel({
        model: model([t], []),
        selected: null,
        onSelect() {},
        onOpenSession() {},
        onOpenStory() {},
      }),
    );
    const el = named(h.value, 'TaskCard');
    return mount(() => rendered(el)).value;
  };

  it('keeps the same task button when the shown status changes', () => {
    const before = card(task('build', 'running', { ...runningTool, health: 'fresh' }));
    const after = card(task('build', 'running', runningTool));
    expect(before.type).toBe('button');
    expect(after.type).toBe('button');
    expect(after.props['data-status']).not.toBe(before.props['data-status']);
    expect(after.key).toBe(before.key);
  });

  it('takes focus back when a status change moves the focused card to another column', () => {
    let tasks = [task('build', 'running')];
    const panel = new HookHost(() =>
      ColumnsPanel({
        model: model(tasks, []),
        selected: null,
        onSelect() {},
        onOpenSession() {},
        onOpenStory() {},
      }),
    );
    hosts.push(panel);
    const columnOf = (tree: unknown) =>
      find(
        tree as any,
        (n) =>
          /^bd-col( |$)/.test(n.props.className ?? '') &&
          nodes(n.props.children).some((c) => c.key === 'build'),
      ).key;
    /** Mounts the card the panel last rendered, its button standing in for the DOM node. */
    const mountCard = (button: { focus: () => void }) => {
      const card = named(panel.value, 'TaskCard');
      const h = new HookHost(
        () => (card.type as (p: unknown) => ReactElement<any>)(card.props),
        (el) => (el.props.ref.current = button),
      );
      hosts.push(h);
      h.render();
      return h;
    };
    const before = { focus: vi.fn() };
    vi.stubGlobal('document', { activeElement: before });
    panel.render();
    const running = mountCard(before);
    const from = columnOf(panel.value);

    tasks = [task('build', 'done')];
    panel.render();
    expect(columnOf(panel.value)).not.toBe(from);
    // In one commit React drops the focused card from its old column, then mounts it in the new one.
    running.unmount();
    const after = { focus: vi.fn() };
    vi.stubGlobal('document', { activeElement: null });
    mountCard(after);
    expect(after.focus).toHaveBeenCalled();
    expect(before.focus).not.toHaveBeenCalled();
  });
});
