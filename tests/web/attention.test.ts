import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import type { NeedsYouItem } from '@/data/needs-you';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';

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
    setState: () => {},
  }),
  resolveTheme: () => 'light',
}));
vi.mock('@/data/commands', () => ({
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));
import { NeedsPopover } from '@/components/NeedsPopover';
import { nextKey } from '@/data/attention';
import { runCommand } from '@/data/commands';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.now();
const MINUTE = 60_000;

const need = (over: Partial<NeedsYouItem>): NeedsYouItem => ({
  source: { table: 'approvals', id: 'approval-1', revision: 3 },
  kind: 'permission',
  project_id: 'alpha',
  session_id: 'session-login',
  status: 'pending',
  created_at: NOW - 5 * MINUTE,
  reason: 'permission_requested',
  decision: 'permission',
  primary: 'approval.respond',
  actions: [{ command: 'approval.respond', allowed: true }],
  ...over,
});

const gate = need({
  source: { table: 'sessions', id: 'session-login', revision: 4 },
  kind: 'session.gate_failed',
  session_id: undefined,
  status: 'failed',
  created_at: NOW - 25 * MINUTE,
  reason: 'gate_failed',
  decision: 'repeated_failure',
  primary: 'session.merge',
  actions: [
    { command: 'session.merge', allowed: true },
    { command: 'session.gates.run', allowed: true },
  ],
});
const asked = need({
  source: { table: 'approvals', id: 'approval-2', revision: 1 },
  created_at: NOW - 20 * MINUTE,
});
const allowed = need({});

const trigger = createElement('button', { type: 'button' }, 'count');
const root = (tree: unknown) => find(tree as never, (n) => !!n.props.onOpenChange);
const rows = (tree: unknown) => nodes(tree as never).filter((n) => n.type === 'li');
const buttons = (row: ReactElement) => nodes(row).filter((n) => n.type === 'button');

const open = (items: readonly NeedsYouItem[]) => {
  const h = mount(() => NeedsPopover({ items, trigger }));
  root(h.value).props.onOpenChange(true);
  h.render();
  return h;
};

beforeEach(() => {
  mock.board = {
    board: {
      projects: [{ id: 'alpha', name: 'Alpha' }],
      sessions: [{ id: 'session-login', project_id: 'alpha', title: 'Fix login' }],
      session_turns: [],
    },
    events: [],
    resync: 0,
  };
  mock.shell = {
    openProjectSession: vi.fn(),
    openProject: vi.fn(),
    openProjectSessions: vi.fn(),
    askedNeed: null,
  };
  vi.mocked(runCommand).mockClear();
  // The open needs-you list reads what was approved today.
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

describe('what needs you, by the decision it asks', () => {
  it('goes to the item after the one settled, else the one before, else to none', () => {
    expect(nextKey(['a', 'b', 'c'], 'a')).toBe('b');
    expect(nextKey(['a', 'b', 'c'], 'c')).toBe('b');
    expect(nextKey(['a'], 'a')).toBeNull();
  });

  it('lists the items, the longest wait first, with what to decide', () => {
    const h = open([gate, asked, allowed]);
    const [first, second, third] = rows(h.value);
    expect(text(first)).toContain(zh('data.attention.decision.repeatedFailure'));
    expect(text(second)).toContain(zh('data.attention.decision.permission'));
    expect(text(buttons(third!)[0])).toBe(`${zh('data.attention.decision.permission')}Fix login`);
  });

  it('gives each row one button, named by the action that settles it, and the rest in its menu', () => {
    const h = open([gate, asked]);
    expect(
      rows(h.value).map((row) =>
        buttons(row)
          .slice(1)
          .map((b) => text(b)),
      ),
    ).toEqual([[zh('board.needs.actions.merge')], [zh('projects.needs.allow')]]);
    const more = find(
      rows(h.value)[1],
      (n) =>
        n.props['aria-label'] ===
        zhf('components.needsPopover.more', { name: zh('data.attention.decision.permission') }),
    );
    expect(more).toBeTruthy();
    expect(text(rows(h.value)[1])).toContain(zh('projects.needs.deny'));
  });

  it('moves the focus to the next item once one is settled, and back to the opener after the last', async () => {
    const h = open([asked, allowed]);
    const opener = { focus: vi.fn() };
    find(h.value, (n) => n.props.render === trigger).props.ref.current = opener;
    const primaries = rows(h.value).map((row) => {
      const target = { focus: vi.fn() };
      buttons(row)[1]!.props.ref(target);
      return target;
    });
    buttons(rows(h.value)[0]!)[1]!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'approval.respond',
      { approval_id: 'approval-2', decision: 'approve' },
      1,
    );
    expect(primaries[1]!.focus).toHaveBeenCalled();
    expect(opener.focus).not.toHaveBeenCalled();
    expect(rows(h.value)).toHaveLength(1);
    buttons(rows(h.value)[0]!)[1]!.props.onClick();
    await h.flush();
    expect(opener.focus).toHaveBeenCalled();
    expect(rows(h.value)).toHaveLength(0);
  });

  it('says in one sentence that nothing needs you', () => {
    const h = open([]);
    expect(text(find(h.value, (n) => !!n.props.onKeyDown))).toBe(
      zh('components.needsPopover.empty'),
    );
  });
});
