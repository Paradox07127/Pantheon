import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import type { NeedsYouItem } from '@/data/needs-you';
import { FakeElement } from './web-fake-dom.js';
import { HookHost, find, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
  resolveTheme: () => 'light',
}));
vi.mock('@/data/commands', () => ({
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));
import { NeedsPopover, SessionsPopover } from '@/components/NeedsPopover';
import { GateMark, StateGlyph } from '@/components/SessionStateIcon';
import { runCommand } from '@/data/commands';
import { useMemoryView } from '@/data/memory-view';
import { reasonText } from '@/data/needs-you';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.now();
const MINUTE = 60_000;

const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({
  source: { table: 'approvals', id: 'approval-1', revision: 3 },
  kind: 'permission',
  project_id: 'alpha',
  status: 'pending',
  created_at: NOW - 5 * MINUTE,
  reason: 'permission_requested',
  actions: [{ command: 'approval.respond', allowed: true }],
  ...over,
});

const request = item({ session_id: 'session-login' });
const failed = item({
  source: { table: 'sessions', id: 'session-gone', revision: 1 },
  kind: 'session.failed',
  project_id: 'beta',
  created_at: NOW - 30 * MINUTE,
  reason: 'session_failed',
  actions: [],
});
const milestone = item({
  source: { table: 'milestones', id: 'first-release', revision: 1 },
  kind: 'milestone.ready_for_acceptance',
  created_at: NOW - 40 * MINUTE,
  reason: 'milestone_ready_for_acceptance',
  actions: [],
});

const trigger = createElement('button', { type: 'button' }, 'count');
const root = (tree: unknown) => find(tree as never, (n) => !!n.props.onOpenChange);
const groups = (tree: unknown) => nodes(tree as never).filter((n) => n.props.role === 'group');
const button = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n).startsWith(label));

beforeEach(() => {
  mock.board = {
    board: {
      projects: [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
      ],
      sessions: [{ id: 'session-login', project_id: 'alpha', title: 'Fix login' }],
      session_turns: [],
    },
    events: [],
    resync: 0,
  };
  mock.shell = { openProjectSession: vi.fn(), openProject: vi.fn() };
  vi.mocked(runCommand).mockClear();
  // The open list reads what was approved today.
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: { query: vi.fn(async () => ({ ok: true, value: { items: [] } })) },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('needs-you list', () => {
  const open = () => {
    const h = mount(() => NeedsPopover({ items: [request, failed, milestone], trigger }));
    root(h.value).props.onOpenChange(true);
    h.render();
    return h;
  };

  it('opens from the trigger it is given', () => {
    const h = mount(() => NeedsPopover({ items: [request], trigger }));
    expect(find(h.value, (n) => n.props.render === trigger)).toBeTruthy();
    expect(root(h.value).props.open).toBe(false);
    root(h.value).props.onOpenChange(true);
    h.render();
    expect(root(h.value).props.open).toBe(true);
  });

  it("marks the root while a title bar's list is open, until the last one closes", () => {
    vi.stubGlobal('document', { documentElement: new FakeElement(1, 'HTML', null) });
    const marked = () => document.documentElement.hasAttribute('data-needs-open');
    const toggle = (h: { value: unknown; render: () => unknown }, open: boolean) => {
      root(h.value).props.onOpenChange(open);
      h.render();
    };
    const elsewhere = new HookHost(() => NeedsPopover({ items: [request], trigger }));
    elsewhere.render();
    toggle(elsewhere, true);
    expect(marked()).toBe(false);

    const first = new HookHost(() => NeedsPopover({ items: [request], trigger, titleBar: true }));
    const second = new HookHost(() => NeedsPopover({ items: [request], trigger, titleBar: true }));
    first.render();
    second.render();
    expect(marked()).toBe(false);
    toggle(first, true);
    toggle(second, true);
    expect(marked()).toBe(true);
    toggle(first, false);
    expect(marked()).toBe(true);
    second.unmount();
    expect(marked()).toBe(false);
    first.unmount();
    elsewhere.unmount();
  });

  it('groups the items by project, the project and the item that waited longest first', () => {
    const h = open();
    expect(groups(h.value).map((g) => g.props['aria-label'])).toEqual(['Alpha', 'Beta']);
    const alpha = text(groups(h.value)[0]);
    expect(alpha.startsWith('Alpha2')).toBe(true);
    expect(alpha.indexOf(reasonText('milestone_ready_for_acceptance'))).toBeLessThan(
      alpha.indexOf('Fix login'),
    );
    expect(text(groups(h.value)[1])).toContain(reasonText('session_failed'));
  });

  it('lists two tasks of one plan that wait on a stuck upstream as two rows of their own', () => {
    const waiting = (taskId: string) =>
      item({
        source: { table: 'board_plans', id: 'lead-1', revision: 2 },
        kind: 'session.failed',
        session_id: 'lead-1',
        task_id: `lead-1:${taskId}`,
        status: 'queued',
        reason: 'task_upstream_stuck',
        upstream: { task_id: 'lead-1:schema', stuck: 'stopped' },
        actions: [],
      });
    const h = mount(() => NeedsPopover({ items: [waiting('api'), waiting('client')], trigger }));
    root(h.value).props.onOpenChange(true);
    h.render();
    const rows = nodes(groups(h.value)[0]).filter((n) => n.type === 'li');
    expect(new Set(rows.map((n) => n.key)).size).toBe(2);
  });

  it('puts the item that blocks the most tasks first, before the longer waits', () => {
    const h = mount(() =>
      NeedsPopover({
        items: [{ ...request, blocks: 1 }, { ...failed, blocks: 3 }, milestone],
        trigger,
      }),
    );
    root(h.value).props.onOpenChange(true);
    h.render();
    expect(groups(h.value).map((g) => g.props['aria-label'])).toEqual(['Beta', 'Alpha']);
    const alpha = text(groups(h.value)[1]);
    expect(alpha.indexOf('Fix login')).toBeLessThan(
      alpha.indexOf(reasonText('milestone_ready_for_acceptance')),
    );
  });

  it.each([
    ['the session of a request', 'Fix login', ['openProjectSession', 'alpha', 'session-login']],
    [
      'the session of a session item',
      reasonText('session_failed'),
      ['openProjectSession', 'beta', 'session-gone'],
    ],
    [
      'the project of an item without a session',
      reasonText('milestone_ready_for_acceptance'),
      ['openProject', 'alpha'],
    ],
  ])('opens %s from its row and closes', (_name, title, [method, ...args]) => {
    const h = open();
    button(h.value, title).props.onClick();
    expect(mock.shell[method!]).toHaveBeenCalledWith(...args);
    h.render();
    expect(root(h.value).props.open).toBe(false);
  });

  it('answers a permission request from its row and offers no answer elsewhere', async () => {
    const h = open();
    const allows = nodes(h.value).filter(
      (n) => n.type === 'button' && text(n) === zh('projects.needs.allow'),
    );
    expect(allows).toHaveLength(1);
    // Deny is the request's secondary action, in its row menu.
    expect(
      find(
        h.value,
        (n) => n.type !== 'button' && !!n.props.onClick && text(n) === zh('projects.needs.deny'),
      ),
    ).toBeTruthy();
    await allows[0]!.props.onClick();
    expect(runCommand).toHaveBeenCalledWith(
      'approval.respond',
      { approval_id: 'approval-1', decision: 'approve' },
      3,
    );
  });

  it.each([
    ['ArrowDown', 1, 2],
    ['j', 1, 2],
    ['ArrowUp', 1, 0],
    ['k', 1, 0],
  ])('moves the focus to the next row on %s', (key, from, to) => {
    const h = open();
    const opens = [0, 1, 2].map(() => ({ focus: vi.fn(), parentElement: { contains: vi.fn() } }));
    opens[from]!.parentElement.contains.mockReturnValue(true);
    const e = {
      key,
      target: {},
      currentTarget: { querySelectorAll: () => opens },
      preventDefault: vi.fn(),
    };
    find(h.value, (n) => !!n.props.onKeyDown).props.onKeyDown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(opens[to]!.focus).toHaveBeenCalled();
  });

  it('names a step that ended without a verdict No verdict, with Count as passed and Count as failed', () => {
    const step = item({
      source: { table: 'workflow_step_runs', id: 'step-run-1', revision: 2 },
      kind: 'workflow.approval',
      session_id: 'session-login',
      status: 'inconclusive',
      reason: 'workflow_approval',
      decision: 'other',
      primary: 'workflow.step.decide',
      actions: [
        { command: 'workflow.step.decide', allowed: true, decision: 'approve' },
        { command: 'workflow.step.decide', allowed: true, decision: 'reject' },
      ],
    });
    const h = mount(() => NeedsPopover({ items: [step], trigger }));
    root(h.value).props.onOpenChange(true);
    h.render();
    expect(text(button(h.value, zh('board.needs.kind.noVerdict')))).toBe(
      `${zh('board.needs.kind.noVerdict')}Fix login`,
    );
    expect(button(h.value, zh('board.needs.actions.countPassed'))).toBeTruthy();
    expect(
      find(
        h.value,
        (n) =>
          n.type !== 'button' &&
          !!n.props.onClick &&
          text(n) === zh('board.needs.actions.countFailed'),
      ),
    ).toBeTruthy();
  });

  it.each([
    ['lead', []],
    ['user', [zh('board.needs.actions.merge'), zh('board.needs.actions.gates')]],
  ] as const)('a failed gate on the %s rung offers %j', (rung, expected) => {
    const gate = item({
      source: { table: 'sessions', id: 'session-gate', revision: 1 },
      kind: 'session.gate_failed',
      reason: 'gate_failed',
      rung,
      actions: [
        { command: 'session.merge', allowed: true },
        { command: 'session.gates.run', allowed: true },
      ],
    });
    const h = mount(() => NeedsPopover({ items: [gate], trigger }));
    root(h.value).props.onOpenChange(true);
    h.render();
    const retries = [zh('board.needs.actions.merge'), zh('board.needs.actions.gates')];
    expect(
      nodes(h.value)
        .filter((n) => !!n.props.onClick && retries.includes(text(n)))
        .map(text),
    ).toEqual(expected);
  });

  it('lists plan decisions kept as notes and opens the plan entries of memory', () => {
    mock.shell.openProjectMemory = vi.fn();
    const notes = item({
      source: { table: 'memory_records', id: 'note-2', revision: 1 },
      kind: 'memory.decision_budget',
      status: 'over_budget',
      reason: 'plan_decisions_over_budget',
      decision: 'budget',
      actions: [],
      memory_notes: { count: 2, memory_ids: ['note-1', 'note-2'] },
    });
    const h = mount(() => NeedsPopover({ items: [notes], trigger }));
    root(h.value).props.onOpenChange(true);
    h.render();
    expect(text(groups(h.value)[0])).toContain(zhf('board.needs.memoryBudget', { count: 2 }));
    button(h.value, zh('board.needs.actions.memory')).props.onClick();
    expect(mock.shell.openProjectMemory).toHaveBeenCalledWith('alpha', 'entries');
    expect(useMemoryView.getState().askedFilters).toEqual({ origin: 'plan' });
  });
});

describe('running and ready lists', () => {
  const session = (over: Partial<WorkbenchSession>) =>
    ({
      id: 'session',
      title: 'Session',
      runtime: 'claude',
      state: 'idle',
      reconciling: false,
      changes: null,
      last_activity_at: new Date(NOW - 10 * MINUTE).toISOString(),
      ...over,
    }) as WorkbenchSession;

  let query: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    query = vi.fn(async () => ({
      ok: true,
      value: [
        session({ id: 'run', title: 'Run tests', state: 'running' }),
        session({ id: 'queued', title: 'Wait in line', last_turn: { id: 't', state: 'queued' } }),
        session({ id: 'rest', title: 'Resting' }),
        session({
          id: 'ready',
          title: 'Ship it',
          state: 'ready',
          changes: { files: 2, additions: 12, deletions: 3 },
          gate: { state: 'passed', passed: 4, failed: 0, running: 0 },
        }),
      ],
    }));
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: { query },
    });
  });

  const open = async (show: 'running' | 'ready') => {
    const h = mount(() => SessionsPopover({ show, projectIds: ['alpha'], trigger }));
    await h.flush();
    expect(query).not.toHaveBeenCalled();
    root(h.value).props.onOpenChange(true);
    h.render();
    await h.flush();
    expect(query).toHaveBeenCalledWith('session.list', { project_id: 'alpha' });
    return h;
  };

  it('lists the running and the queued sessions, the queued one with a hollow state', async () => {
    const h = await open('running');
    const listed = text(groups(h.value)[0]);
    expect(listed).toContain('Run tests');
    expect(listed).toContain('Wait in line');
    expect(listed).not.toContain('Resting');
    expect(listed).not.toContain('Ship it');
    expect(
      nodes(h.value)
        .filter((n) => n.type === StateGlyph)
        .map((n) => n.props.name),
    ).toEqual(['idle']);
  });

  it('lists the ready sessions with their diff and gate, and reviews one', async () => {
    const h = await open('ready');
    const listed = text(groups(h.value)[0]);
    expect(listed).toContain('Ship it');
    expect(listed).toContain('+12 −3');
    expect(listed).not.toContain('Run tests');
    expect(find(h.value, (n) => n.type === GateMark).props.gate.state).toBe('passed');
    button(h.value, zh('projects.ready.review')).props.onClick();
    expect(mock.shell.openProjectSession).toHaveBeenCalledWith('alpha', 'ready');
  });
});
