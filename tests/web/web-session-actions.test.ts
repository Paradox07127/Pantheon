import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import type { NeedsYouItem } from '@/data/needs-you';
import { find, named, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: (selector: any) => selector({ openSettings() {} }),
}));
vi.mock('@/data/feedback', async (actual) => ({
  ...(await actual<object>()),
  useFeedback: (selector: any) => selector({ items: {} }),
}));
import { ResolveButtons } from '@/screens/sessions/parts';
import { SessionInspector, SessionHeader } from '@/screens/sessions/SessionsScreen';
import { zh, zhf } from './i18n-setup.js';

const button = (tree: any, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n) === label);

let answers: Record<string, unknown>;
let commands: { type: string; input: unknown; expected_revision: number | null }[];

beforeEach(() => {
  answers = {};
  commands = [];
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [], workspaces: [], cursor: 1 },
    events: [],
    status: { state: 'live' },
    cursor: 1,
    resync: 0,
    refresh() {},
  };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => ({ ok: true, value: answers[method] })),
      command: vi.fn(async (command: any) => {
        commands.push(command);
        return { ok: true, value: {} };
      }),
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('closes a reconciling session at the revision of its needs-you item', async () => {
  const item: NeedsYouItem = {
    source: { table: 'sessions', id: 'session-a', revision: 4 },
    kind: 'session.reconciling',
    project_id: 'project-a',
    status: 'reconciling',
    created_at: 1,
    reason: 'reconciliation_required',
    actions: [{ command: 'session.resolve', allowed: true }],
  };
  const h = mount(() => ResolveButtons({ item, title: 'Release notes' }));
  button(h.value, zh('sessions.parts.closeSession')).props.onClick();
  await h.flush();
  expect(commands).toMatchObject([
    {
      type: 'session.resolve',
      input: { session_id: 'session-a', choice: 'close' },
      expected_revision: 4,
    },
  ]);
});

it('discards a reconciling session only after the confirmation, at the revision of its needs-you item', async () => {
  const item: NeedsYouItem = {
    source: { table: 'sessions', id: 'session-a', revision: 4 },
    kind: 'session.reconciling',
    project_id: 'project-a',
    status: 'reconciling',
    created_at: 1,
    reason: 'reconciliation_required',
    actions: [
      { command: 'session.resolve', allowed: false, disabled_reason: 'termination_unconfirmed' },
      { command: 'session.discard', allowed: true },
    ],
  };
  const h = mount(() => ResolveButtons({ item, title: 'Release notes' }));
  expect(named(h.value, 'DiscardDialog').props.open).toBe(false);
  button(h.value, zh('sessions.parts.discardChanges')).props.onClick();
  await h.flush();
  expect(commands).toEqual([]);
  const dialog = named(h.value, 'DiscardDialog');
  expect(dialog.props).toMatchObject({ open: true, title: 'Release notes' });
  const confirm = mount(() => (dialog.type as (props: unknown) => ReactNode)(dialog.props));
  button(confirm.value, zh('sessions.parts.discard')).props.onClick();
  await confirm.flush();
  await h.flush();
  expect(commands).toMatchObject([
    { type: 'session.discard', input: { session_id: 'session-a' }, expected_revision: 4 },
  ]);
  expect(named(h.value, 'DiscardDialog').props.open).toBe(false);
});

it('confirms discard of an ended baseline at its current revision and leaves its thread', async () => {
  const onDiscarded = vi.fn();
  const session: Session = {
    id: 'baseline-session',
    revision: 7,
    project_id: 'project-a',
    runtime: 'claude',
    state: 'open',
    turn_count: 1,
    baseline: { baseline_id: 'baseline-a' },
  };
  const listed: WorkbenchSession = {
    id: session.id,
    created_at: '2026-11-03T00:00:00.000Z',
    title: '摸底',
    runtime: 'claude',
    model: null,
    effort: null,
    permission_mode: 'ask',
    workspace_id: null,
    workspace_kind: 'linked_worktree',
    state: 'done',
    waiting: 0,
    reconciling: false,
    stopping: false,
    last_activity_at: '2026-11-03T00:00:00.000Z',
    changes: null,
    merge: null,
  };
  const h = mount(() =>
    SessionHeader({
      session,
      listed,
      title: '摸底',
      panels: [],
      onPanel() {},
      overview: true,
      onDiscarded,
    }),
  );
  const more = named(h.value, 'MoreMenu');
  const menu = mount(() => (more.type as (props: unknown) => ReactNode)(more.props));
  find(
    menu.value,
    (n) =>
      typeof n.type !== 'string' &&
      typeof n.props.onClick === 'function' &&
      text(n) === zh('sessions.model.menu.discard'),
  ).props.onClick();
  await menu.flush();
  await h.flush();
  const dialog = named(h.value, 'DiscardDialog');
  expect(dialog.props.open).toBe(true);
  expect(dialog.props.description).toBe(zh('sessions.screen.baselineDiscard'));
  const confirm = mount(() => (dialog.type as (props: unknown) => ReactNode)(dialog.props));
  button(confirm.value, zh('sessions.parts.discard')).props.onClick();
  await confirm.flush();
  await h.flush();
  expect(commands).toMatchObject([
    {
      type: 'session.discard',
      input: { session_id: session.id },
      expected_revision: 7,
    },
  ]);
  expect(onDiscarded).toHaveBeenCalledOnce();
  expect(named(h.value, 'DiscardDialog').props.open).toBe(false);
});

const worktreeSession: Session = {
  id: 'session-a',
  revision: 3,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
};
const worktreeListed: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'ready',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
};

it('confirms discard of a live worktree session and leaves its thread', async () => {
  const onDiscarded = vi.fn();
  const h = mount(() =>
    SessionHeader({
      session: worktreeSession,
      listed: worktreeListed,
      title: 'Release notes',
      panels: [],
      onPanel() {},
      overview: true,
      onDiscarded,
    }),
  );
  const more = named(h.value, 'MoreMenu');
  const menu = mount(() => (more.type as (props: unknown) => ReactNode)(more.props));
  find(
    menu.value,
    (n) =>
      typeof n.type !== 'string' &&
      typeof n.props.onClick === 'function' &&
      text(n) === zh('sessions.model.menu.discard'),
  ).props.onClick();
  await menu.flush();
  await h.flush();
  const dialog = named(h.value, 'DiscardDialog');
  const confirm = mount(() => (dialog.type as (props: unknown) => ReactNode)(dialog.props));
  button(confirm.value, zh('sessions.parts.discard')).props.onClick();
  await confirm.flush();
  await h.flush();
  expect(commands).toMatchObject([
    { type: 'session.discard', input: { session_id: 'session-a' }, expected_revision: 3 },
  ]);
  expect(onDiscarded).toHaveBeenCalledOnce();
});

it('keeps the typed title in the box when the rename is refused', async () => {
  (window as any).pantheon.command.mockResolvedValueOnce({
    ok: false,
    error: { code: 'revision_conflict', message: 'stale revision' },
  });
  const h = mount(() =>
    SessionHeader({
      session: worktreeSession,
      listed: worktreeListed,
      title: 'Release notes',
      panels: [],
      onPanel() {},
      overview: true,
    }),
  );
  find(h.value, (n) => n.props['aria-label'] === zh('sessions.screen.editTitle')).props.onClick();
  h.render();
  const input = () =>
    find(
      h.value,
      (n) => n.type === 'input' && n.props['aria-label'] === zh('sessions.screen.sessionTitle'),
    );
  input().props.onChange({ target: { value: 'Release notes, second pass' } });
  h.render();
  input().props.onKeyDown({
    key: 'Enter',
    nativeEvent: { isComposing: false },
    preventDefault() {},
  });
  await h.flush();
  expect(input().props.value).toBe('Release notes, second pass');
  expect(input().props.disabled).toBe(false);
  expect(find(h.value, (n) => n.props.role === 'alert')).toBeTruthy();
});

it.each([
  [true, true],
  [false, false],
])('turns merge off while the checks run: running %s, off %s', async (running, off) => {
  answers['session.gates'] = { configured: true, running };
  answers['session.diff'] = { files: [], patch: null, truncated: false };
  answers['session.reviews'] = [];
  answers['session.preflight'] = {
    target_branch: 'main',
    source_root: '/repo',
    commit_count: 1,
    files_changed: 1,
    worktree_clean: true,
    source_clean: true,
    conflicts: { state: 'none' },
    gate: { configured_total: 1, last: 'none' },
    can_merge: !running,
    ...(running ? { blocked_reason: 'resource_busy' } : {}),
  };
  const listed: WorkbenchSession = {
    id: 'session-a',
    created_at: '2026-11-03T00:00:00.000Z',
    title: 'title of session-a',
    runtime: 'claude',
    model: null,
    effort: null,
    permission_mode: 'ask',
    workspace_id: 'workspace-a',
    workspace_kind: 'linked_worktree',
    state: 'ready',
    waiting: 0,
    reconciling: false,
    stopping: false,
    last_activity_at: '2026-11-03T00:00:00.000Z',
    changes: null,
    merge: null,
  };
  const session: Session = {
    id: 'session-a',
    revision: 2,
    project_id: 'project-a',
    runtime: 'claude',
    state: 'open',
    turn_count: 1,
  };
  const h = mount(() =>
    SessionInspector({
      sessionId: 'session-a',
      listed,
      session,
      panels: ['changes'],
      onOpen() {},
      onClose() {},
      onView: () => {},
    }),
  );
  await h.flush();
  const bar = named(h.value, 'MergeBar');
  const row = mount(() => (bar.type as (props: unknown) => ReactNode)(bar.props));
  const merge = find(
    row.value,
    (n) =>
      n.type === 'button' && text(n) === zhf('sessions.panel.merge.mergeInto', { target: 'main' }),
  );
  expect(merge.props['aria-disabled'] === true).toBe(off);
});
