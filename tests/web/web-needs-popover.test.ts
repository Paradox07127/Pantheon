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
import { reasonText } from '@/data/needs-you';
import { useSettingsView } from '@/screens/settings/view';
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
const undelivered = item({
  source: { table: 'approvals', id: 'approval-2', revision: 1 },
  status: 'undelivered',
  created_at: NOW - 40 * MINUTE,
  reason: 'answer_undelivered',
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
  mock.shell = { openProjectSession: vi.fn(), openProject: vi.fn(), openSettings: vi.fn() };
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
    const h = mount(() => NeedsPopover({ items: [request, failed, undelivered], trigger }));
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
    expect(alpha.indexOf(reasonText('answer_undelivered'))).toBeLessThan(
      alpha.indexOf('Fix login'),
    );
    expect(text(groups(h.value)[1])).toContain(reasonText('session_failed'));
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
      reasonText('answer_undelivered'),
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

  it('offers a retried merge and a rerun of the gates on a failed gate', () => {
    const gate = item({
      source: { table: 'sessions', id: 'session-gate', revision: 1 },
      kind: 'session.gate_failed',
      reason: 'gate_failed',
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
    ).toEqual(retries);
  });

  it.each([
    ['five files', 5],
    ['seven files', 7],
  ])('names every protected file a held merge changes: %s', (_name, count) => {
    const files = Array.from({ length: count }, (_, i) => `scripts/check-${i + 1}.cjs`);
    const held = item({
      source: { table: 'sessions', id: 'session-login', revision: 2 },
      kind: 'session.merge_blocked',
      reason: 'merge_blocked',
      primary: 'session.merge',
      actions: [{ command: 'session.merge', allowed: true }],
      files,
    });
    const h = mount(() => NeedsPopover({ items: [held], trigger }));
    root(h.value).props.onOpenChange(true);
    h.render();
    const row = text(button(h.value, 'Fix login'));
    for (const file of files) expect(row).toContain(file);
  });

  it("names a project over its budget and opens the project's settings from its button", async () => {
    const budget = item({
      source: { table: 'workflow_policies', id: 'alpha', revision: 2 },
      kind: 'project.over_budget',
      status: 'over_budget',
      reason: 'project_over_budget',
      decision: 'budget',
      primary: 'workflow.policy.set',
      actions: [{ command: 'workflow.policy.set', allowed: true }],
    });
    const h = mount(() => NeedsPopover({ items: [budget], trigger }));
    root(h.value).props.onOpenChange(true);
    h.render();
    expect(text(h.value)).toContain(zh('data.attention.decision.budget'));
    expect(text(h.value)).toContain(zh('data.reason.projectOverBudget'));
    await button(h.value, zh('board.needs.actions.projectSettings')).props.onClick();
    expect(useSettingsView.getState()).toMatchObject({ page: 'project', detail: 'alpha' });
    expect(mock.shell.openSettings).toHaveBeenCalledWith('alpha');
    expect(mock.shell.openProject).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['changed gate files', 'gate_files_changed', 'session.merge_blocked', true],
    ['a failed gate', 'gate_failed', 'session.merge_blocked', false],
    ['changed gate files after a failed gate', 'gate_files_changed', 'session.gate_failed', true],
    [
      'fewer tests',
      'tests_dropped: check: passed 10→9, skipped 0→0',
      'session.merge_blocked',
      true,
    ],
  ] as const)(
    'offers to land a merge blocked by %s anyway: %s',
    async (_name, reason, kind, offered) => {
      mock.board.board.sessions.push({
        id: 'session-gate',
        project_id: 'alpha',
        title: 'Edit the gate',
        merge: { state: 'blocked', reason },
      });
      const blocked = item({
        source: { table: 'sessions', id: 'session-gate', revision: 4 },
        kind,
        reason: kind === 'session.gate_failed' ? 'gate_failed' : 'merge_blocked',
        primary: 'session.merge',
        actions: [{ command: 'session.merge', allowed: true }],
      });
      const h = mount(() => NeedsPopover({ items: [blocked], trigger }));
      root(h.value).props.onOpenChange(true);
      h.render();
      const anyway = nodes(h.value).find(
        (n) => !!n.props.onClick && text(n) === zh('board.needs.actions.mergeAnyway'),
      );
      expect(!!anyway).toBe(offered);
      if (!anyway) return;
      await anyway.props.onClick();
      expect(runCommand).toHaveBeenCalledWith(
        'session.merge',
        { session_id: 'session-gate', allow_gate_change: true },
        4,
      );
    },
  );
});

describe('a settings change the main agent proposes', () => {
  const respond = (decision: 'approve' | 'reject', allowed = true) => ({
    command: 'setting.proposal.respond',
    allowed,
    decision,
    ...(allowed ? {} : { disabled_reason: 'permission_denied' }),
  });
  const proposal = (over: Partial<NeedsYouItem> = {}) =>
    item({
      source: { table: 'setting_change_proposals', id: 'proposal-1', revision: 2 },
      kind: 'setting.proposed',
      session_id: 'session-login',
      reason: 'setting_proposed',
      decision: 'other',
      primary: 'setting.proposal.respond',
      actions: [respond('approve'), respond('reject')],
      setting: {
        command: 'project.gate.set',
        root: '/repo/app',
        before: { commands: ['pnpm test'], timeout_ms: null },
        after: { commands: ['pnpm test', 'pnpm lint'], timeout_ms: 60000, env: { CI: '1' } },
        reason: 'Lint failures only show up in review',
      },
      ...over,
    });
  const show = (proposed: NeedsYouItem) => {
    const h = mount(() => NeedsPopover({ items: [proposed], trigger }));
    root(h.value).props.onOpenChange(true);
    h.render();
    return h;
  };
  const approve = (tree: unknown) =>
    find(
      tree as never,
      (n) => n.type === 'button' && text(n) === zh('board.needs.actions.approveSetting'),
    );
  const reject = (tree: unknown) =>
    find(
      tree as never,
      (n) =>
        n.type !== 'button' &&
        !!n.props.onClick &&
        text(n) === zh('board.needs.actions.rejectSetting'),
    );
  const gateName = zh('components.needsPopover.setting.gate');

  it.each([
    ['approves', 'approve', approve],
    ['rejects', 'reject', reject],
  ] as const)(
    '%s the change from its row at the proposal revision',
    async (_name, decision, press) => {
      const h = show(proposal());
      await press(h.value).props.onClick();
      expect(runCommand).toHaveBeenCalledWith(
        'setting.proposal.respond',
        { proposal_id: 'proposal-1', decision },
        2,
      );
    },
  );

  it('keeps approve off with the reason the backend gives', async () => {
    const h = show(proposal({ actions: [respond('approve', false), respond('reject')] }));
    expect(approve(h.value).props['aria-disabled']).toBe(true);
    expect(find(h.value, (n) => n.props.content === reasonText('permission_denied'))).toBeTruthy();
    await approve(h.value).props.onClick();
    expect(runCommand).not.toHaveBeenCalled();
    expect(reject(h.value).props.disabled).toBe(false);
  });

  it('names the setting and its root, gives the reason and lists each field now and after', () => {
    const h = show(proposal());
    expect(text(button(h.value, gateName))).toContain('Fix login');
    expect(text(h.value)).toContain('/repo/app');
    expect(text(h.value)).toContain('Lint failures only show up in review');
    const table = find(
      h.value,
      (n) =>
        n.type === 'table' &&
        n.props['aria-label'] === zhf('components.needsPopover.setting.change', { name: gateName }),
    );
    const cells = (n: unknown) =>
      nodes(n as never)
        .filter((c) => c.type === 'th' || c.type === 'td')
        .map(text);
    const rows = nodes(table).filter((n) => n.type === 'tr');
    expect(cells(rows[0])).toEqual([
      '',
      zh('components.needsPopover.setting.now'),
      zh('components.needsPopover.setting.after'),
    ]);
    expect(rows.slice(1).map(cells)).toEqual([
      ['commands', 'pnpm test', 'pnpm test, pnpm lint'],
      ['timeout_ms', '—', '60000'],
      ['env', '—', '{"CI":"1"}'],
    ]);
  });

  it('shows a change without before and after by its reason and buttons alone', () => {
    const h = show(
      proposal({
        setting: { command: 'workflow.policy.set', reason: 'The budget runs out daily' },
      }),
    );
    expect(text(h.value)).toContain(zh('components.needsPopover.setting.budget'));
    expect(text(h.value)).toContain('The budget runs out daily');
    expect(nodes(h.value).some((n) => n.type === 'table')).toBe(false);
    expect(approve(h.value)).toBeTruthy();
    expect(reject(h.value)).toBeTruthy();
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
