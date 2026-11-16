import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { SessionTurn } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
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
import { buildTranscript } from '@/data/transcript';
import { usePrefill } from '@/screens/sessions/parts';
import { ThreadTurn, useTurnScope } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

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
const sessionTurn = (extra: Partial<SessionTurn> = {}): SessionTurn =>
  ({
    id: 'turn-a',
    project_id: 'project-a',
    session_id: 'session-a',
    revision: 1,
    created_at: 1,
    updated_at: 1,
    input: 'Tighten the release notes',
    state: 'completed',
    ...extra,
  }) as SessionTurn;
const reply = (turnId: string, value: string) => ({
  sequence: 1,
  event_id: 'event-1',
  kind: 'agent.message.delta',
  aggregate_id: 'session-a',
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: 1_000,
  payload: { turn_id: turnId, text: value },
});

describe('message actions in the thread', () => {
  let results: { ok: boolean; value?: unknown; error?: { code: string; message: string } }[];
  let commands: { type: string; input: unknown; expected_revision: number | null }[];
  let copied: string[];
  const turnHost = (
    session: WorkbenchSession | null,
    turn: SessionTurn = sessionTurn(),
    extra: { events?: unknown[]; after?: string | null } = {},
  ) =>
    mount(() =>
      ThreadTurn({
        view: buildTranscript([turn], (extra.events ?? []) as any).turns[0]!,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: session,
        after: extra.after ?? null,
      }),
    );
  /** The body of a component the tree holds as an element. */
  const body = (tree: unknown, name: string) => {
    const node = named(tree as any, name);
    return mount(() => (node.type as (props: unknown) => ReactNode)(node.props));
  };
  // The copy button names itself; its label is read where it is clicked.
  const labels = (tree: unknown) =>
    nodes(tree as any).flatMap((n) =>
      n.type === 'button'
        ? [n.props['aria-label']]
        : (n.type as any)?.name === 'CopyButton'
          ? [zh('sessions.thread.copy')]
          : [],
    );
  const button = (tree: unknown, label: string): ReactElement<any> =>
    find(tree as any, (n) => n.type === 'button' && n.props['aria-label'] === label);
  const titled = (tree: unknown, label: string): ReactElement<any> =>
    find(tree as any, (n) => n.type === 'button' && text(n) === label);
  const openMenu = (h: HookHost<any>) => {
    const actions = body(h.value, 'TurnActions');
    button(actions.value, zh('sessions.screen.turnActions')).props.onClick();
    actions.render();
    return actions;
  };
  const menuItems = (tree: unknown) =>
    nodes(tree as any).filter((n) => typeof n.type !== 'string' && 'onClick' in n.props && text(n));
  const roots = (tree: unknown) =>
    nodes(tree as any).flatMap((n) =>
      typeof n.type === 'function' &&
      ['MenuRoot', 'RollbackDialog', 'ForkDialog'].includes(n.type.name)
        ? [n.type.name]
        : [],
    );

  beforeEach(() => {
    commands = [];
    results = [];
    copied = [];
    mock.board = {
      board: {
        sessions: [{ id: 'session-a', revision: 7, runtime: 'claude' }],
        session_turns: [],
        projects: [],
        workspaces: [],
        cursor: 1,
      },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    mock.shell = {};
    vi.stubGlobal('window', {
      pantheon: {
        command: vi.fn(async (command: any) => {
          commands.push(command);
          return results.shift() ?? { ok: true, value: {} };
        }),
        query: vi.fn(async () => ({ ok: true, value: {} })),
      },
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async (value: string) => void copied.push(value)) },
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  it('offers copy, rewrite, roll back, fork and the menu under an ended turn of a live worktree session', () => {
    for (const state of ['idle', 'ready', 'running'] as const)
      expect(labels(body(turnHost(listed(state)).value, 'TurnActions').value)).toEqual([
        zh('sessions.thread.copy'),
        zh('sessions.thread.rewrite'),
        zh('sessions.thread.rollback'),
        zh('sessions.thread.fork'),
        zh('sessions.screen.turnActions'),
      ]);
  });

  it('offers only copy and the menu on a rolled-back, queued or running turn', () => {
    for (const turn of [
      sessionTurn({ rolled_back: true }),
      sessionTurn({ state: 'running' }),
      sessionTurn({ state: 'queued' }),
    ])
      expect(labels(body(turnHost(listed('idle'), turn).value, 'TurnActions').value)).toEqual([
        zh('sessions.thread.copy'),
        zh('sessions.screen.turnActions'),
      ]);
  });

  it('offers only copy and the menu once the session is merged, discarded or done, or without a worktree', () => {
    for (const session of [
      listed('merged'),
      listed('discarded'),
      listed('done'),
      listed('idle', { workspace_id: null }),
      listed('idle', { workspace_kind: 'in_place' }),
      null,
    ])
      expect(labels(body(turnHost(session).value, 'TurnActions').value)).toEqual([
        zh('sessions.thread.copy'),
        zh('sessions.screen.turnActions'),
      ]);
  });

  it('copies what the user sent', async () => {
    const actions = body(turnHost(listed('idle')).value, 'TurnActions');
    const copy = body(actions.value, 'CopyButton');
    button(copy.value, zh('sessions.thread.copy')).props.onClick();
    await copy.flush();
    expect(copied).toEqual(['Tighten the release notes']);
    expect(labels(copy.value)).toEqual([zh('sessions.thread.copied')]);
  });

  it('mounts the menu only once it is reached and the dialogs only once one is asked for', () => {
    const actions = body(turnHost(listed('idle')).value, 'TurnActions');
    const more = button(actions.value, zh('sessions.screen.turnActions'));
    expect(more.props['aria-haspopup']).toBe('menu');
    expect(roots(actions.value)).toEqual([]);
    more.props.onClick();
    actions.render();
    expect(roots(actions.value)).toEqual(['MenuRoot']);
    button(actions.value, zh('sessions.thread.rollback')).props.onClick();
    actions.render();
    expect(roots(actions.value)).toEqual(['MenuRoot', 'RollbackDialog', 'ForkDialog']);
  });

  it('turns rollback and rewrite off while the session is running or merging, and keeps fork on', () => {
    for (const state of ['running', 'merging', 'waiting'] as const) {
      const actions = body(turnHost(listed(state)).value, 'TurnActions');
      expect(button(actions.value, zh('sessions.thread.rollback')).props.disabled).toBe(true);
      expect(button(actions.value, zh('sessions.thread.rewrite')).props.disabled).toBe(true);
      expect(button(actions.value, zh('sessions.thread.fork')).props.disabled).toBe(false);
    }
    const idle = body(turnHost(listed('idle')).value, 'TurnActions');
    expect(button(idle.value, zh('sessions.thread.rollback')).props.disabled).toBe(false);
  });

  it("offers the turn's changes and the search of the thread in the menu", () => {
    const opened: unknown[][] = [];
    mock.shell = { openSession: (...args: unknown[]) => opened.push(args) };
    useTurnScope.setState({ scopes: {} });
    const menu = openMenu(turnHost(listed('running')));
    expect(menuItems(menu.value).map(text)).toEqual([
      zh('sessions.screen.turnChanges'),
      zh('sessions.thread.find'),
    ]);
    menuItems(menu.value)[0]!.props.onClick();
    expect(opened).toEqual([['session-a', 'changes']]);
    expect(useTurnScope.getState().take('session-a')).toBe('turn-a');
  });

  it('keeps the changes out of the menu of a steer turn or a session without a worktree', () => {
    for (const h of [
      turnHost(listed('idle'), sessionTurn({ kind: 'steer' })),
      turnHost(listed('idle', { workspace_id: null })),
    ])
      expect(menuItems(openMenu(h).value).map(text)).toEqual([zh('sessions.thread.find')]);
  });

  it('turns rollback, rewrite and fork off on a steer turn, which has no checkpoint to go back to', () => {
    const actions = body(
      turnHost(listed('idle'), sessionTurn({ kind: 'steer' })).value,
      'TurnActions',
    );
    for (const action of ['rollback', 'rewrite', 'fork'])
      expect(button(actions.value, zh(`sessions.thread.${action}`)).props.disabled).toBe(true);
  });

  it('offers rollback, rewrite and fork on a steer that ran as a turn of its own', () => {
    const ran = {
      ...reply('turn-a', ''),
      kind: 'turn.running',
      aggregate_id: 'turn-a',
      payload: {},
    };
    const h = turnHost(listed('idle'), sessionTurn({ kind: 'steer' }), { events: [ran] });
    const actions = body(h.value, 'TurnActions');
    for (const action of ['rollback', 'rewrite', 'fork'])
      expect(button(actions.value, zh(`sessions.thread.${action}`)).props.disabled).toBeFalsy();
    expect(menuItems(openMenu(h).value).map(text)).toEqual([
      zh('sessions.screen.turnChanges'),
      zh('sessions.thread.find'),
    ]);
  });

  it('treats a reflection turn, which has no checkpoint either, like a steer turn', () => {
    const h = turnHost(listed('idle'), sessionTurn({ origin: 'reflection' }));
    const actions = body(h.value, 'TurnActions');
    for (const action of ['rollback', 'rewrite', 'fork'])
      expect(button(actions.value, zh(`sessions.thread.${action}`)).props.disabled).toBe(true);
    expect(menuItems(openMenu(h).value).map(text)).toEqual([zh('sessions.thread.find')]);
  });

  it('rolls the session back to before the turn once confirmed, at its revision by then', async () => {
    const actions = body(turnHost(listed('idle')).value, 'TurnActions');
    button(actions.value, zh('sessions.thread.rollback')).props.onClick();
    actions.render();
    mock.board = {
      ...mock.board,
      board: { ...mock.board.board, sessions: [{ id: 'session-a', revision: 9 }] },
    };
    const dialog = named(actions.value, 'RollbackDialog');
    expect(dialog.props.open).toBe(true);
    expect(dialog.props.rewrite).toBe(false);
    const confirm = body(actions.value, 'RollbackDialog');
    titled(confirm.value, zh('sessions.screen.rollback')).props.onClick();
    await confirm.flush();
    expect(commands).toMatchObject([
      {
        type: 'session.rollback',
        input: { session_id: 'session-a', turn_id: 'turn-a' },
        expected_revision: 9,
      },
    ]);
  });

  it('rewrites from the turn: rolls back, then hands its input, files and skills to the composer', async () => {
    usePrefill.setState({ prefill: {} });
    const attachment = {
      id: 'file-a',
      name: 'notes.txt',
      mime: 'text/plain',
      path: '/a/notes.txt',
    };
    const skill = { name: 'review', path: '/skills/review/SKILL.md' };
    const actions = body(
      turnHost(
        listed('idle'),
        sessionTurn({ handoff: 'Earlier record', attachments: [attachment], skills: [skill] }),
      ).value,
      'TurnActions',
    );
    button(actions.value, zh('sessions.thread.rewrite')).props.onClick();
    actions.render();
    const confirm = body(actions.value, 'RollbackDialog');
    expect(text(find(confirm.value, (n) => n.props.className === 'pj-dt'))).toBe(
      zh('sessions.screen.rewriteTitle'),
    );
    titled(confirm.value, zh('sessions.screen.rollbackRewrite')).props.onClick();
    await confirm.flush();
    expect(commands).toMatchObject([
      { type: 'session.rollback', input: { session_id: 'session-a', turn_id: 'turn-a' } },
    ]);
    expect(usePrefill.getState().take('session-a')).toEqual({
      text: 'Tighten the release notes',
      attachments: [attachment],
      skills: [skill],
    });
    expect(usePrefill.getState().take('session-a')).toBeUndefined();
  });

  it('rewrites with the sessions, pull requests and issues the turn referred to', async () => {
    usePrefill.setState({ prefill: {} });
    const other = listed('idle', { id: 'session-b', title: 'Changelog' });
    const refs = [
      { kind: 'session' as const, id: 'session-b' },
      { kind: 'pr' as const, number: 12 },
      { kind: 'issue' as const, number: 7 },
    ];
    const h = mount(() =>
      ThreadTurn({
        view: buildTranscript([sessionTurn({ refs })], []).turns[0]!,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: listed('idle'),
        sessions: () => [listed('idle'), other],
      }),
    );
    const actions = body(h.value, 'TurnActions');
    button(actions.value, zh('sessions.thread.rewrite')).props.onClick();
    actions.render();
    const confirm = body(actions.value, 'RollbackDialog');
    titled(confirm.value, zh('sessions.screen.rollbackRewrite')).props.onClick();
    await confirm.flush();
    expect(usePrefill.getState().take('session-a')).toEqual({
      text: 'Tighten the release notes',
      attachments: [],
      skills: [],
      refs: [other],
      github: [
        { kind: 'pr', number: 12, title: '' },
        { kind: 'issue', number: 7, title: '' },
      ],
    });
  });

  it('keeps the input out of the composer when the rewrite rollback is refused', async () => {
    usePrefill.setState({ prefill: {} });
    results.push({ ok: false, error: { code: 'invalid_state', message: 'native process live' } });
    const actions = body(turnHost(listed('idle')).value, 'TurnActions');
    button(actions.value, zh('sessions.thread.rewrite')).props.onClick();
    actions.render();
    const confirm = body(actions.value, 'RollbackDialog');
    titled(confirm.value, zh('sessions.screen.rollbackRewrite')).props.onClick();
    await confirm.flush();
    expect(usePrefill.getState().take('session-a')).toBeUndefined();
  });

  it('shows a refused rollback in the dialog', async () => {
    results.push({ ok: false, error: { code: 'invalid_state', message: 'native process live' } });
    const actions = body(turnHost(listed('idle')).value, 'TurnActions');
    button(actions.value, zh('sessions.thread.rollback')).props.onClick();
    actions.render();
    const confirm = body(actions.value, 'RollbackDialog');
    titled(confirm.value, zh('sessions.screen.rollback')).props.onClick();
    await confirm.flush();
    const error = find(confirm.value, (n) => n.props.className === 'pj-err');
    expect(text(error)).toBe('当前状态下不能这么做（native process live）');
  });

  it('forks from before the turn with its message and files, then opens the new session', async () => {
    const opened: unknown[][] = [];
    mock.shell = { openSession: (...args: unknown[]) => opened.push(args) };
    results.push({ ok: true, value: { id: 'session-fork' } });
    const attachment = { id: 'file-a', name: 'a.txt', mime: 'text/plain', path: '/a.txt' };
    const actions = body(
      turnHost(listed('idle'), sessionTurn({ attachments: [attachment] })).value,
      'TurnActions',
    );
    button(actions.value, zh('sessions.thread.fork')).props.onClick();
    actions.render();
    expect(named(actions.value, 'ForkDialog').props.open).toBe(true);
    const dialog = body(actions.value, 'ForkDialog');
    const input = find(dialog.value, (n) => n.type === 'textarea');
    expect(input.props.value).toBe('Tighten the release notes');
    input.props.onChange({ target: { value: 'Tighten the notes, keep the dates' } });
    dialog.render();
    titled(dialog.value, zh('sessions.thread.forkConfirm')).props.onClick();
    await dialog.flush();
    expect(commands).toMatchObject([
      {
        type: 'session.fork',
        input: {
          session_id: 'session-a',
          before_turn_id: 'turn-a',
          input: 'Tighten the notes, keep the dates',
          attachments: ['file-a'],
        },
        expected_revision: null,
      },
    ]);
    expect(opened).toEqual([['session-fork']]);
  });

  it('forks from before the turn with the sessions, pull requests and issues it referred to', async () => {
    const refs = [
      { kind: 'session' as const, id: 'session-b' },
      { kind: 'pr' as const, number: 12 },
    ];
    const actions = body(turnHost(listed('idle'), sessionTurn({ refs })).value, 'TurnActions');
    button(actions.value, zh('sessions.thread.fork')).props.onClick();
    actions.render();
    const dialog = body(actions.value, 'ForkDialog');
    titled(dialog.value, zh('sessions.thread.forkConfirm')).props.onClick();
    await dialog.flush();
    expect(commands).toMatchObject([{ type: 'session.fork', input: { refs } }]);
  });

  it('offers copy and fork under the reply of an ended turn, and only copy without a live worktree', () => {
    const events = [reply('turn-a', 'Notes tightened.')];
    const shown = body(turnHost(listed('idle'), sessionTurn(), { events }).value, 'ReplyActions');
    expect(labels(shown.value)).toEqual([zh('sessions.thread.copy'), zh('sessions.thread.fork')]);
    const plain = body(turnHost(listed('merged'), sessionTurn(), { events }).value, 'ReplyActions');
    expect(labels(plain.value)).toEqual([zh('sessions.thread.copy')]);
    const running = turnHost(listed('running'), sessionTurn({ state: 'running' }), { events });
    expect(nodes(running.value).some((n) => (n.type as any)?.name === 'ReplyActions')).toBe(false);
  });

  it("copies the agent's reply", async () => {
    const events = [reply('turn-a', 'Notes tightened.')];
    const actions = body(turnHost(listed('idle'), sessionTurn(), { events }).value, 'ReplyActions');
    const copy = body(actions.value, 'CopyButton');
    button(copy.value, zh('sessions.thread.copy')).props.onClick();
    await copy.flush();
    expect(copied).toEqual(['Notes tightened.']);
  });

  it('forks after the reply from the next turn, or from the current files after the last one', async () => {
    const events = [reply('turn-a', 'Notes tightened.')];
    const fork = async (after: string | null) => {
      const actions = body(
        turnHost(listed('idle'), sessionTurn(), { events, after }).value,
        'ReplyActions',
      );
      button(actions.value, zh('sessions.thread.fork')).props.onClick();
      actions.render();
      const dialog = body(actions.value, 'ForkDialog');
      expect(find(dialog.value, (n) => n.type === 'textarea').props.value).toBe('');
      find(dialog.value, (n) => n.type === 'textarea').props.onChange({
        target: { value: 'Try a row lock' },
      });
      dialog.render();
      titled(dialog.value, zh('sessions.thread.forkConfirm')).props.onClick();
      await dialog.flush();
    };
    await fork('turn-b');
    await fork(null);
    expect(commands.map((c) => c.input)).toEqual([
      { session_id: 'session-a', before_turn_id: 'turn-b', input: 'Try a row lock' },
      { session_id: 'session-a', input: 'Try a row lock' },
    ]);
  });

  it('offers the fork after the last reply while the session runs, and turns it off while it merges', () => {
    const events = [reply('turn-a', 'Notes tightened.')];
    const last = (state: WorkbenchSession['state']) =>
      button(
        body(turnHost(listed(state), sessionTurn(), { events }).value, 'ReplyActions').value,
        zh('sessions.thread.fork'),
      ).props.disabled;
    expect(last('running')).toBe(false);
    expect(last('waiting')).toBe(false);
    expect(last('merging')).toBe(true);
    const earlier = body(
      turnHost(listed('merging'), sessionTurn(), { events, after: 'turn-b' }).value,
      'ReplyActions',
    );
    expect(button(earlier.value, zh('sessions.thread.fork')).props.disabled).toBe(false);
  });

  it('keeps the handoff out of the bubble behind a collapsed disclosure', () => {
    const h = turnHost(
      listed('idle'),
      sessionTurn({ handoff: 'Earlier record: the notes were drafted' }),
    );
    const bubble = find(h.value, (n) => String(n.props.className).split(' ')[0] === 'ss-user');
    expect(text(bubble)).toBe('Tighten the release notes');
    const fold = find(h.value, (n) => n.props.className === 'ss-hof');
    expect(fold.props.open).toBeUndefined();
    expect(fold.props.defaultOpen).toBeFalsy();
    expect(text(find(fold, (n) => n.props.className === 'ss-hoft'))).toBe(
      zh('sessions.screen.handoff'),
    );
    expect(text(fold)).toContain('Earlier record: the notes were drafted');
  });

  it('shows no disclosure on a turn without a handoff', () => {
    const h = turnHost(listed('idle'));
    expect(nodes(h.value).some((n) => text(n).startsWith(zh('sessions.screen.handoff')))).toBe(
      false,
    );
  });

  it('marks a rolled-back turn for assistive technology', () => {
    const h = turnHost(listed('idle'), sessionTurn({ rolled_back: true }));
    const turn = find(h.value, (n) => n.props.className === 'ss-turn');
    expect(turn.props['data-rolled-back']).toBe(true);
    expect(text(find(turn, (n) => n.props.className === 'ss-vh'))).toBe(
      zh('sessions.screen.rolledBack'),
    );
    const plain = turnHost(listed('idle'));
    expect(nodes(plain.value).some((n) => n.props.className === 'ss-vh')).toBe(false);
  });
});
