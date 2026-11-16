import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { SessionPreflight, WorkbenchSession } from '@pantheon/protocol';
import { type HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
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
}));
import { t } from '@/i18n';
import { sessionMenu, type SessionMenuEntry } from '@/screens/sessions/model';
import { MoreMenu } from '@/screens/sessions/SessionHeader';
import { SessionHeader, SessionListRow } from '@/screens/sessions/SessionsScreen';

const listed = (
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const workspace = { id: 'workspace-a', path: '/work/a', base_sha: 'abc1234' };
const shape = (groups: SessionMenuEntry[][]) =>
  groups.map((group) =>
    group.map((entry) =>
      'items' in entry
        ? `${entry.label} ▸ ${entry.items.map((i) => i.label).join(', ')}`
        : entry.label,
    ),
  );
const entry = (groups: SessionMenuEntry[][], label: string) =>
  groups
    .flat()
    .flatMap((e) => ('items' in e ? [e, ...e.items] : [e]))
    .find((e) => e.label === label);

const m = (key: string) => zh(`sessions.model.menu.${key}`);
const rowMenu = (key: string) => zh(`sessions.rowMenu.${key}`);
const COPY = [
  m('copyWorktreePath'),
  m('copySessionId'),
  m('copyBaseCommit'),
  zh('sessions.export.copyMarkdown'),
  zh('sessions.export.exportMarkdown'),
];
const TOP = [[rowMenu('open')], ['rename', 'pin', 'snooze', 'markUnread'].map(m)];
const OPEN = ['editor', 'terminal', 'fileManager'].map(rowMenu);
const WHERE = [`${rowMenu('openIn')} ▸ ${OPEN.join(', ')}`, `${m('copy')} ▸ ${COPY.join(', ')}`];
const NO_WORKTREE = zh('sessions.model.worktree.none');
const REMOVED = zh('sessions.model.worktree.removed');
const MERGE_MAIN = t(
  { id: 'sessions.model.menu.mergeInto', defaultMessage: 'Merge into {target}…' },
  { target: 'main' },
);

describe('session menu groups', () => {
  it.each([
    [
      'lists a running worktree session with stop, checks and merge',
      'running',
      [['stopTurn', 'runChecks', 'merge']],
      ['delete'],
    ],
    [
      'lists an idle worktree session with archive',
      'idle',
      [['runChecks', 'merge']],
      ['archive', 'delete'],
    ],
    [
      'lists an ended session with archive and without checks or merge',
      'done',
      [],
      ['archive', 'delete'],
    ],
  ] as const)('%s', (_name, state, middle, last) => {
    expect(shape(sessionMenu(listed(state), { workspace }))).toEqual([
      ...TOP,
      ...middle.map((group) => group.map(m)),
      WHERE,
      last.map(m),
    ]);
  });

  it('lists a ready session without stop, with discard when offered', () => {
    expect(
      shape(sessionMenu(listed('ready'), { workspace, discardable: true, unread: true })),
    ).toEqual([
      [rowMenu('open')],
      ['rename', 'pin', 'snooze', 'markRead'].map(m),
      ['runChecks', 'merge'].map(m),
      WHERE,
      ['archive', 'discard', 'delete'].map(m),
    ]);
  });

  it('lists an archived session with restore', () => {
    const archived = listed('merged', {
      archived_at: '2026-11-03T00:00:00.000Z',
      pinned_at: '2026-11-03T00:00:00.000Z',
    });
    expect(shape(sessionMenu(archived, { workspace }))).toEqual([
      [rowMenu('open')],
      ['rename', 'unpin', 'markUnread'].map(m),
      WHERE,
      ['unarchive', 'delete'].map(m),
    ]);
  });

  it('turns rename and the worktree items off for a baseline session', () => {
    const groups = sessionMenu(listed('done', { workspace_id: null }), { workspace: null });
    expect(shape(groups)).toEqual([...TOP, WHERE, ['archive', 'delete'].map(m)]);
    expect(entry(groups, m('rename'))).toMatchObject({ reason: m('baselineNoRename') });
    for (const label of OPEN) expect(entry(groups, label)).toMatchObject({ reason: NO_WORKTREE });
    const copy = entry(groups, m('copy')) as { items: { label: string; reason?: string }[] };
    expect(copy.items.map((i) => i.reason)).toEqual([
      NO_WORKTREE,
      undefined,
      NO_WORKTREE,
      undefined,
      undefined,
    ]);
    expect(copy.items.map((i) => i.label)).toEqual(COPY);
  });

  it('opens the lead only from a board task session', () => {
    const groups = sessionMenu(listed('idle', { lead: 'lead-a' }), { workspace });
    expect(shape(groups)).toEqual([
      ...TOP,
      ['runChecks', 'merge', 'openLead'].map(m),
      WHERE,
      ['archive', 'delete'].map(m),
    ]);
    expect(entry(groups, m('openLead'))).toMatchObject({
      command: 'session.open_lead',
      input: { session_id: 'lead-a' },
    });
    for (const state of ['running', 'ready', 'done'] as const)
      expect(entry(sessionMenu(listed(state), { workspace }), m('openLead'))).toBeUndefined();
  });

  it('offers stop only while running, and turns it off while stopping', () => {
    for (const state of ['idle', 'ready', 'waiting', 'merging', 'done'] as const)
      expect(entry(sessionMenu(listed(state), { workspace }), m('stopTurn'))).toBeUndefined();
    expect(entry(sessionMenu(listed('running'), { workspace }), m('stopTurn'))).toMatchObject({
      command: 'session.interrupt',
      input: { session_id: 'session-a' },
    });
    expect(
      entry(sessionMenu(listed('running', { stopping: true }), { workspace }), m('stopTurn')),
    ).toMatchObject({ reason: m('stopping') });
  });

  it('names the merge target and its blocked reason', () => {
    const blocked = sessionMenu(listed('ready'), {
      workspace,
      merge: { target: 'main', reason: '没有新提交' },
    });
    expect(entry(blocked, MERGE_MAIN)).toMatchObject({
      command: 'session.merge',
      reason: '没有新提交',
    });
    const open = sessionMenu(listed('ready'), {
      workspace,
      merge: { target: 'main', reason: null },
    });
    expect(entry(open, MERGE_MAIN)).not.toHaveProperty('reason');
    expect(entry(sessionMenu(listed('ready'), { workspace }), m('merge'))).toMatchObject({
      reason: m('readingMerge'),
    });
  });

  it('turns merge off while the session merges', () => {
    const merge = { target: 'main', reason: null };
    for (const row of [
      listed('merging'),
      listed('ready', { merge: { state: 'running' } as WorkbenchSession['merge'] }),
    ])
      expect(entry(sessionMenu(row, { workspace, merge }), MERGE_MAIN)).toMatchObject({
        reason: m('merging'),
      });
  });

  it('turns the worktree items off once the board marks the worktree removed', () => {
    const groups = sessionMenu(listed('merged'), {
      workspace: { ...workspace, removed_at: 1 },
    });
    for (const label of OPEN) expect(entry(groups, label)).toMatchObject({ reason: REMOVED });
    const copy = entry(groups, m('copy')) as { items: { label: string; reason?: string }[] };
    expect(copy.items.map((i) => i.reason)).toEqual([
      REMOVED,
      undefined,
      REMOVED,
      undefined,
      undefined,
    ]);
    expect(copy.items.map((i) => i.label)).toEqual(COPY);
  });

  it('turns checks off when the project has no gate commands', () => {
    expect(
      entry(sessionMenu(listed('ready'), { workspace, gated: false }), m('runChecks')),
    ).toMatchObject({ reason: m('noGates') });
    expect(
      entry(sessionMenu(listed('ready'), { workspace, gated: true }), m('runChecks')),
    ).not.toHaveProperty('reason');
  });

  it('gives the reasons the list row can know for delete and the base commit', () => {
    expect(entry(sessionMenu(listed('merged'), { workspace }), m('delete'))).toMatchObject({
      danger: true,
      reason: m('mergedArchiveOnly'),
    });
    for (const busy of [
      listed('merging'),
      listed('ready', { merge: { state: 'running' } }),
      listed('ready', { gate: { state: 'running', passed: 0, failed: 0, running: 0 } }),
    ])
      expect(entry(sessionMenu(busy, { workspace }), m('delete'))).toMatchObject({
        reason: m('mergingOrChecking'),
      });
    expect(entry(sessionMenu(listed('discarded'), { workspace }), m('delete'))).not.toHaveProperty(
      'reason',
    );
    const copy = entry(
      sessionMenu(listed('ready'), { workspace: { id: 'w', path: '/w' } }),
      m('copy'),
    );
    expect((copy as { items: { label: string; reason?: string }[] }).items[2]).toMatchObject({
      label: m('copyBaseCommit'),
      reason: m('noBaseCommit'),
    });
  });
});

describe('session menu in the row and the header', () => {
  let commands: { type: string; input: unknown }[];
  let clipboard: ReturnType<typeof vi.fn>;
  let preflight: SessionPreflight;
  const items = (tree: unknown): ReactElement<any>[] =>
    nodes(tree as any).filter(
      (n) =>
        typeof n.type !== 'string' &&
        (typeof n.props.onClick === 'function' || n.props.disabled === true) &&
        n.props['aria-label'] === undefined,
    );
  const item = (tree: unknown, label: string) => items(tree).find((n) => text(n) === label)!;
  const menuRoot = (tree: unknown) =>
    find(tree as any, (n) => typeof n.props.onOpenChange === 'function' && 'open' in n.props);

  beforeEach(() => {
    commands = [];
    preflight = {
      target_branch: 'main',
      source_root: '/repo',
      commit_count: 2,
      files_changed: 3,
      worktree_clean: true,
      source_clean: true,
      conflicts: { state: 'none' },
      gate: { configured_total: 1, last: 'passed' },
      can_merge: false,
      blocked_reason: 'no_changes',
    };
    mock.board = {
      board: {
        sessions: [{ id: 'session-a', revision: 5 }],
        session_turns: [],
        projects: [],
        workspaces: [workspace],
        cursor: 1,
      },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    mock.shell = { sessionId: 'session-a', followFirstSession: vi.fn(), openSession: vi.fn() };
    clipboard = vi.fn(async () => {});
    vi.stubGlobal('window', {
      pantheon: {
        command: vi.fn(async (command: any) => {
          commands.push(command);
          return { ok: true, value: {} };
        }),
        query: vi.fn(async () => ({ ok: true, value: preflight })),
      },
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  const row = (s: WorkbenchSession) =>
    mount(() => SessionListRow({ session: s, on: true, now: 0, onSelect() {} }));

  it('separates the groups in the row menu', () => {
    const h = row(listed('ready'));
    const popup = find(h.value, (n) => n.props.className === 'mn mn-menu pop');
    const separators = nodes(popup).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'MenuSeparator',
    );
    // Four between the groups, one inside the copy submenu.
    expect(separators).toHaveLength(5);
  });

  it('reads the preflight only once the menu opens and names its branch and reason', async () => {
    const h = row(listed('ready'));
    expect(window.pantheon!.query).not.toHaveBeenCalled();
    menuRoot(h.value).props.onOpenChange(true);
    await h.flush();
    expect(window.pantheon!.query).toHaveBeenCalledWith('session.preflight', {
      session_id: 'session-a',
    });
    const tip = nodes(h.value).find(
      (n) => typeof n.type === 'function' && n.type.name === 'Tip' && text(n) === MERGE_MAIN,
    )!;
    expect(tip.props.content).toBe(zh('sessions.panel.blocked.noChanges'));
    const merge = tip.props.children;
    expect(merge.props.disabled).toBe(true);
    const described = find(h.value, (n) => n.props.id === merge.props['aria-describedby']);
    expect(text(described)).toBe(zh('sessions.panel.blocked.noChanges'));
  });

  it('names why the preflight read failed on the merge entry', async () => {
    vi.mocked(window.pantheon!.query).mockResolvedValue({
      ok: false,
      error: { code: 'command_timeout', message: 'preflight timed out' },
    });
    const h = row(listed('ready'));
    menuRoot(h.value).props.onOpenChange(true);
    await h.flush();
    const tip = nodes(h.value).find(
      (n) => typeof n.type === 'function' && n.type.name === 'Tip' && text(n) === m('merge'),
    )!;
    expect(tip.props.content).toContain('preflight timed out');
    expect(tip.props.children.props.disabled).toBe(true);
  });

  it('opens the merge confirmation when the preflight allows it', async () => {
    preflight = { ...preflight, can_merge: true, blocked_reason: undefined };
    const h = row(listed('ready'));
    menuRoot(h.value).props.onOpenChange(true);
    await h.flush();
    item(h.value, MERGE_MAIN).props.onClick();
    await h.flush();
    const dialog = named(h.value, 'MergeDialog');
    expect(dialog.props).toMatchObject({ open: true, sessionId: 'session-a', preflight });
  });

  it('keeps the merge confirmation open with the failure when its preflight read fails', async () => {
    preflight = { ...preflight, can_merge: true, blocked_reason: undefined };
    const h = row(listed('ready'));
    menuRoot(h.value).props.onOpenChange(true);
    await h.flush();
    vi.mocked(window.pantheon!.query).mockResolvedValue({
      ok: false,
      error: { code: 'command_timeout', message: 'preflight timed out' },
    });
    item(h.value, MERGE_MAIN).props.onClick();
    await h.flush();
    const dialog = named(h.value, 'MergeDialog');
    expect(dialog.props).toMatchObject({ open: true, preflight: null });
    expect(dialog.props.error).toContain('preflight timed out');
  });

  it('turns checks off in the row menu once the preflight finds no gate commands', async () => {
    preflight = { ...preflight, gate: { configured_total: 0, last: 'none' } };
    const h = row(listed('ready'));
    expect(item(h.value, m('runChecks')).props.disabled).toBeFalsy();
    menuRoot(h.value).props.onOpenChange(true);
    await h.flush();
    expect(item(h.value, m('runChecks')).props.disabled).toBe(true);
  });

  it('reads the preflight again when the merge confirmation opens', async () => {
    preflight = { ...preflight, can_merge: true, blocked_reason: undefined };
    const h = row(listed('ready'));
    menuRoot(h.value).props.onOpenChange(true);
    await h.flush();
    const reads = vi.mocked(window.pantheon!.query).mock.calls.length;
    item(h.value, MERGE_MAIN).props.onClick();
    await h.flush();
    expect(vi.mocked(window.pantheon!.query).mock.calls.length).toBe(reads + 1);
  });

  it('turns the open items of the header menu off once the board marks the worktree removed', () => {
    mock.board.board.workspaces = [{ ...workspace, removed_at: 1 }];
    const header = mount(() =>
      SessionHeader({
        session: {
          id: 'session-a',
          revision: 5,
          project_id: 'project-a',
          runtime: 'claude',
          state: 'closed',
          turn_count: 1,
          workspace_id: 'workspace-a',
        } as Session,
        listed: listed('merged'),
        title: 'Release notes',
        panels: ['changes'],
        onPanel() {},
        overview: true,
      }),
    );
    const more = named(header.value, 'MoreMenu');
    const inMore = mount(() => (more.type as (props: unknown) => ReactNode)(more.props));
    const editor = item(inMore.value, rowMenu('editor'));
    expect(editor.props.disabled).toBe(true);
  });

  it('leaves opening the worktree to the Open menu beside the more menu of the sheet', () => {
    const more = (place?: 'sheet') =>
      mount(() =>
        MoreMenu({ session: listed('ready'), discardable: false, ...(place ? { place } : {}) }),
      ).value;
    const submenus = (tree: ReactNode) =>
      nodes(tree as ReactElement)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'SubMenu')
        .map((n) => n.props.label);
    expect(submenus(more())).toEqual([rowMenu('openIn'), m('copy')]);
    expect(submenus(more('sheet'))).toEqual([m('copy')]);
  });

  it('copies the worktree path, the session id and the base commit', async () => {
    const h = row(listed('ready'));
    const sub = find(h.value, (n) => n.props.label === m('copy'));
    for (const label of COPY.slice(0, 3)) item(sub, label).props.onClick();
    await h.flush();
    expect(clipboard.mock.calls).toEqual([['/work/a'], ['session-a'], ['abc1234']]);
  });

  it('stops the running turn and runs checks at the board revision', async () => {
    const h = row(listed('running'));
    item(h.value, m('stopTurn')).props.onClick();
    item(h.value, m('runChecks')).props.onClick();
    await h.flush();
    expect(commands).toMatchObject([
      { type: 'session.interrupt', input: { session_id: 'session-a' }, expected_revision: 5 },
      { type: 'session.gates.run', input: { session_id: 'session-a' }, expected_revision: 5 },
    ]);
  });

  it('opens the lead of a board task session', () => {
    const h = row(listed('idle', { lead: 'lead-a' }));
    item(h.value, m('openLead')).props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('lead-a');
  });

  it('shows the same items in the header menu as in the row', () => {
    const s = listed('ready');
    const fromRow = row(s);
    const header = mount(() =>
      SessionHeader({
        session: {
          id: 'session-a',
          revision: 5,
          project_id: 'project-a',
          runtime: 'claude',
          state: 'open',
          turn_count: 1,
          workspace_id: 'workspace-a',
        } as Session,
        listed: s,
        title: 'Release notes',
        panels: ['changes'],
        onPanel() {},
        overview: true,
      }),
    );
    const more = named(header.value, 'MoreMenu');
    const fromHeader = mount(() => (more.type as (props: unknown) => ReactNode)(more.props));
    const popup = (h: HookHost<any>) =>
      find(h.value, (n) => n.props.className === 'mn mn-menu pop');
    const labels = (h: HookHost<any>) => items(popup(h)).map((n) => text(n));
    // The header shows the session already, so only the row offers to open it.
    expect(labels(fromRow)[0]).toBe(rowMenu('open'));
    // The header's own session actions come first.
    const own = [
      'sessions.header.fork',
      'sessions.thread.find',
      'sessions.header.checkpoint',
      'sessions.header.createPull',
    ].map((id) => zh(id));
    expect(labels(fromHeader)).toEqual([...own, ...labels(fromRow).slice(1)]);
    expect(labels(fromRow)).toContain(m('discard'));
  });

  it('returns the focus to the row once the menu button closes its menu', () => {
    const h = row(listed('ready'));
    // The row box is what the row's preview trigger renders.
    const box = find(h.value, (n) => n.props.render?.props.className === 'sb-row').props.render;
    const rowButton = { dataset: { session: 'session-a' } };
    box.props.ref.current = {
      querySelector: (selector: string) => (selector === '[data-session]' ? rowButton : null),
    };
    const popup = nodes(h.value).find(
      (n) => n.props.className === 'mn mn-menu pop' && n.props.finalFocus !== undefined,
    )!;
    expect(popup.props.finalFocus('keyboard')).toBe(rowButton);
  });

  it('caps the row menu at the room the window leaves and scrolls the rest in the browser', () => {
    // The desktop app opens the row's context menu natively; the browser draws both menus.
    vi.stubGlobal('window', { ...window, pantheon: undefined });
    const h = row(listed('ready'));
    const menus = nodes(h.value).filter(
      (n) => n.props.style?.zIndex === 40 && n.props.side !== 'right',
    );
    expect(menus).toHaveLength(2);
    // A context menu shifts over its row unless told to flip.
    expect(menus[0]!.props.collisionAvoidance).toEqual({ side: 'flip', fallbackAxisSide: 'none' });
    for (const menu of menus)
      expect(menu.props.children.props.style).toEqual({
        maxHeight: 'var(--available-height)',
        overflowY: 'auto',
      });
  });
});
