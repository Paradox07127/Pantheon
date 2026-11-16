import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Session, SessionComment, SessionTurn } from '@pantheon/domain';
import type { SessionDiff, WorkbenchSession } from '@pantheon/protocol';
import { find, HookHost, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  diff: null as any,
  comments: [] as any[],
  toasts: [] as any[],
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionDiff: () => ({ data: mock.diff, error: null, reload: () => {} }),
  useTurnDiff: () => ({ data: mock.diff, error: null, reload: () => {} }),
}));
vi.mock('@/data/session-panel', () => ({
  useSessionGates: () => ({ data: null, error: null, reload: () => {} }),
  useSessionReviews: () => ({ data: [], error: null, reload: () => {} }),
  useSessionPreflight: () => ({ data: null, error: null, reload: () => {} }),
  useSessionGatesHistory: () => ({ data: null, error: null, reload: () => {} }),
}));
vi.mock('@/data/facts-read', () => ({
  useFactsRead: () => ({ read: null, error: null, loading: false, unavailable: false }),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => {
    mock.toasts.push(options);
    return 'toast';
  },
}));
import { useFeedback } from '@/data/feedback';
import { failureText } from '@/data/needs-you';
import { markCommentsSent } from '@/data/session-comments';
import { DiffFiles } from '@/components/DiffReview';
import { SessionCompose, SessionInspector, useTurnScope } from '@/screens/sessions/SessionsScreen';

const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T08:00:00.000Z',
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
  last_activity_at: '2026-11-03T08:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const open: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
};
const diff: SessionDiff = {
  session_id: 'session-a',
  base_sha: 'base',
  head_sha: 'head',
  files: [{ path: 'src/answer.ts', additions: 1, deletions: 1, untracked: false }],
  patch: [
    'diff --git a/src/answer.ts b/src/answer.ts',
    '--- a/src/answer.ts',
    '+++ b/src/answer.ts',
    '@@ -10,3 +10,3 @@ export function answer() {',
    '   const base = 40;',
    '-  return base + 1;',
    '+  return base + 2;',
    '   // done',
  ].join('\n'),
  truncated: false,
};
const comment = (extra: Partial<SessionComment> = {}): SessionComment => ({
  id: 'comment-a',
  revision: 3,
  session_id: 'session-a',
  path: 'src/answer.ts',
  line: 11,
  side: 'new',
  text: 'Keep it at 1.\nThe caller expects 41.',
  created_at: 1,
  state: 'open',
  ...extra,
});
const turn = { id: 'turn-1', session_id: 'session-a', kind: 'send', state: 'completed' };

let command: ReturnType<typeof vi.fn>;
const items = () => useFeedback.getState().items['session-a'] ?? [];
const sent = () =>
  command.mock.calls.map(([c]) => ({
    type: c.type,
    input: c.input,
    expected_revision: c.expected_revision,
  }));

beforeEach(() => {
  useFeedback.setState({ items: {} });
  useTurnScope.setState({ scopes: {} });
  mock.board = {
    board: {
      cursor: 1,
      projects: [],
      sessions: [],
      session_turns: [turn as unknown as SessionTurn],
      workspaces: [{ id: 'workspace-a', source: '/repo', path: '/work/a', base_sha: 'base' }],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.diff = diff;
  mock.comments = [];
  mock.toasts = [];
  command = vi.fn(async () => ({ ok: true, value: {} }));
  vi.stubGlobal('window', {
    pantheon: {
      command,
      query: vi.fn(async (method: string) => ({
        ok: true,
        value: method === 'session.comments' ? mock.comments : [],
      })),
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

async function inspector(row = listed()) {
  const h = mount(() =>
    SessionInspector({
      sessionId: 'session-a',
      listed: row,
      session: open,
      panels: ['changes'],
      view: 'diff',
      onOpen: () => {},
      onClose: () => {},
      onView: () => {},
    }),
  );
  await h.flush();
  return h;
}
const diffProps = (h: HookHost<any>) => named(h.value, 'DiffFiles').props;
const commentNotes = (h: HookHost<any>) =>
  diffProps(h).notes.filter((n: { id: string }) => n.id.startsWith('comment:'));
/** The comment's card as the inspector hands it to the diff, rendered again with the inspector. */
const card = (h: HookHost<any>, id = 'comment-a', loose = false) =>
  mount(() => {
    const note = commentNotes(h).find((n: { id: string }) => n.id === `comment:${id}`);
    const element = (loose ? note.loose : note.node) as ReactElement<any>;
    return (element.type as (props: unknown) => ReactNode)(element.props);
  });
const buttons = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.type === 'button')
    .map((n) => text(n));
const press = async (c: HookHost<any>, h: HookHost<any>, label: string) => {
  find(c.value, (n) => n.type === 'button' && text(n) === label).props.onClick();
  await c.flush();
  await h.flush();
  h.render();
  c.render();
};

describe('diff comments', () => {
  it('stores a draft as a comment on the side of its line', async () => {
    const h = await inspector();
    const onComment = diffProps(h).onComment;
    await expect(
      onComment(
        { path: 'src/answer.ts', line: 11, kind: 'add', text: '  return base + 2;' },
        ' Keep it at 1. ',
      ),
    ).resolves.toBe(true);
    await onComment(
      { path: 'src/answer.ts', line: 11, kind: 'del', text: '  return base + 1;' },
      'Was right',
    );
    expect(sent()).toEqual([
      {
        type: 'session.comment.add',
        input: {
          session_id: 'session-a',
          path: 'src/answer.ts',
          line: 11,
          side: 'new',
          text: 'Keep it at 1.',
          line_text: '  return base + 2;',
        },
        expected_revision: null,
      },
      {
        type: 'session.comment.add',
        input: {
          session_id: 'session-a',
          path: 'src/answer.ts',
          line: 11,
          side: 'old',
          text: 'Was right',
          line_text: '  return base + 1;',
        },
        expected_revision: null,
      },
    ]);
    expect(items()).toEqual([]);
  });

  it("stores a comment made in a turn's view with that turn", async () => {
    useTurnScope.getState().set('session-a', 'turn-1');
    const h = await inspector();
    await diffProps(h).onComment(
      { path: 'src/answer.ts', line: 11, kind: 'add', text: '  return base + 2;' },
      'Keep it at 1.',
    );
    expect(sent().map((c) => c.input)).toEqual([
      {
        session_id: 'session-a',
        path: 'src/answer.ts',
        line: 11,
        side: 'new',
        text: 'Keep it at 1.',
        line_text: '  return base + 2;',
        turn_id: 'turn-1',
      },
    ]);
  });

  it('rejects a refused comment with the reason', async () => {
    command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_input', message: 'text too long' },
    });
    const h = await inspector();
    await expect(
      diffProps(h).onComment(
        { path: 'src/answer.ts', line: 11, kind: 'add', text: '  return base + 2;' },
        'Keep it at 1.',
      ),
    ).rejects.toThrow('text too long');
  });

  it('shows each comment under its line with the actions its state allows', async () => {
    mock.comments = [
      comment(),
      comment({ id: 'comment-b', line: 10, state: 'kept', text: 'Fine' }),
      comment({ id: 'comment-c', side: 'old', state: 'sent', text: 'Why' }),
    ];
    const h = await inspector();
    expect(
      commentNotes(h).map((n: any) => ({ id: n.id, path: n.path, side: n.side, line: n.line })),
    ).toEqual([
      { id: 'comment:comment-a', path: 'src/answer.ts', side: 'new', line: 11 },
      { id: 'comment:comment-b', path: 'src/answer.ts', side: 'new', line: 10 },
      { id: 'comment:comment-c', path: 'src/answer.ts', side: 'old', line: 11 },
    ]);
    const shown = nodes(mount(() => DiffFiles(diffProps(h))).value);
    const at = (pick: (n: ReactElement<any>) => boolean) => shown.findIndex(pick);
    const added = at(
      (n) => n.props.className === 'ss-code' && n.props.children === '  return base + 2;',
    );
    const placed = at((n) => n.props.comment?.id === 'comment-a');
    expect(placed).toBeGreaterThan(added);
    expect(placed).toBeLessThan(
      at((n) => n.props.className === 'ss-code' && n.props.children === '  // done'),
    );
    const first = card(h);
    expect(text(first.value)).toContain(zh('sessions.screen.commentAuthor'));
    expect(text(first.value)).toContain('第 11 行');
    expect(text(find(first.value, (n) => n.type === 'p'))).toBe(
      'Keep it at 1.\nThe caller expects 41.',
    );
    expect(buttons(first.value)).toEqual([
      zh('sessions.screen.commentAsk'),
      zh('sessions.screen.commentKeep'),
      zh('sessions.screen.commentDelete'),
    ]);
    const kept = card(h, 'comment-b');
    expect(buttons(kept.value)).toEqual([zh('sessions.screen.commentDelete')]);
    expect(text(kept.value)).toContain(zh('sessions.screen.commentKept'));
    const done = card(h, 'comment-c');
    expect(buttons(done.value)).toEqual([zh('sessions.screen.commentDelete')]);
    expect(text(done.value)).toContain(zh('sessions.screen.commentSent'));
  });

  it('shows the comments of a read-only session without actions', async () => {
    mock.comments = [comment(), comment({ id: 'comment-b', state: 'kept' })];
    const h = await inspector(listed({ state: 'merged' }));
    expect(diffProps(h).onComment).toBeUndefined();
    expect(buttons(card(h).value)).toEqual([]);
    expect(buttons(card(h, 'comment-b').value)).toEqual([]);
    expect(text(card(h, 'comment-b').value)).toContain(zh('sessions.screen.commentKept'));
  });

  it('keeps a comment as a note at its revision', async () => {
    mock.comments = [comment()];
    const h = await inspector();
    await press(card(h), h, zh('sessions.screen.commentKeep'));
    expect(sent()).toEqual([
      {
        type: 'session.comment.resolve',
        input: { comment_id: 'comment-a', state: 'kept' },
        expected_revision: 3,
      },
    ]);
  });

  it('takes a comment kept as a note off the next message', async () => {
    mock.comments = [comment()];
    const h = await inspector();
    const c = card(h);
    await press(c, h, zh('sessions.screen.commentAsk'));
    expect(items()).toHaveLength(1);
    await press(c, h, zh('sessions.screen.commentKeep'));
    expect(items()).toEqual([]);
  });

  it('says in the card why a command on it failed', async () => {
    mock.comments = [comment()];
    command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_state', message: 'Session has ended' },
    });
    const h = await inspector();
    const c = card(h);
    await press(c, h, zh('sessions.screen.commentKeep'));
    expect(text(find(c.value, (n) => n.props.role === 'alert'))).toContain('Session has ended');
    expect(mock.toasts).toEqual([]);
  });

  it('deletes a comment, takes it off the next message and offers to add it back', async () => {
    mock.comments = [comment()];
    const h = await inspector();
    const c = card(h);
    await press(c, h, zh('sessions.screen.commentAsk'));
    expect(items()).toHaveLength(1);
    await press(c, h, zh('sessions.screen.commentDelete'));
    expect(items()).toEqual([]);
    expect(mock.toasts.map((t) => [t.title, t.action?.label])).toEqual([
      [zh('sessions.screen.commentDeleted'), zh('sessions.screen.commentUndo')],
    ]);
    mock.toasts[0].action.run();
    await h.flush();
    expect(sent()).toEqual([
      {
        type: 'session.comment.delete',
        input: { comment_id: 'comment-a' },
        expected_revision: 3,
      },
      {
        type: 'session.comment.add',
        input: {
          session_id: 'session-a',
          path: 'src/answer.ts',
          line: 11,
          side: 'new',
          text: 'Keep it at 1.\nThe caller expects 41.',
        },
        expected_revision: null,
      },
    ]);
  });

  const undoDelete = async (stored: SessionComment, attach: boolean) => {
    mock.comments = [stored];
    const added = comment({ id: 'comment-b', revision: 1, state: 'open' });
    command.mockImplementation(async (c: { type: string }) => ({
      ok: true,
      value: c.type === 'session.comment.add' ? added : {},
    }));
    const h = await inspector();
    const c = card(h);
    if (attach) await press(c, h, zh('sessions.screen.commentAsk'));
    await press(c, h, zh('sessions.screen.commentDelete'));
    mock.toasts[0].action.run();
    await h.flush();
    await h.flush();
  };

  it.each(['sent', 'kept'] as const)(
    'brings a deleted comment back %s, as it was before the delete',
    async (state) => {
      await undoDelete(comment({ state }), false);
      expect(sent().slice(1)).toEqual([
        expect.objectContaining({ type: 'session.comment.add' }),
        {
          type: 'session.comment.resolve',
          input: { comment_id: 'comment-b', state },
          expected_revision: 1,
        },
      ]);
    },
  );

  it('puts a deleted comment back on the next message when the undo brings it back', async () => {
    await undoDelete(comment(), true);
    expect(sent().map((c) => c.type)).toEqual(['session.comment.delete', 'session.comment.add']);
    expect(items()).toEqual([
      expect.objectContaining({
        id: 'comment:comment-b',
        kind: 'comment',
        comment: { id: 'comment-b', revision: 1 },
      }),
    ]);
  });

  it('says when the comments could not be read and reads them again on Retry', async () => {
    const error = { code: 'ipc_failed', message: 'socket closed' };
    let fails = true;
    (window as any).pantheon.query = vi.fn(async (method: string) =>
      method === 'session.comments' && fails
        ? { ok: false, error }
        : { ok: true, value: method === 'session.comments' ? [comment()] : [] },
    );
    const h = await inspector();
    const alert = find(h.value, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain(failureText(error));
    fails = false;
    find(
      alert,
      (n) => n.type === 'button' && text(n) === zh('sessions.screen.retry'),
    ).props.onClick();
    await h.flush();
    h.render();
    expect(commentNotes(h)).toHaveLength(1);
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
  });

  it('attaches a comment for the agent and takes it off when pressed again', async () => {
    mock.comments = [comment()];
    const h = await inspector();
    const c = card(h);
    const ask = () =>
      find(c.value, (n) => n.type === 'button' && text(n) === zh('sessions.screen.commentAsk'));
    expect(ask().props['aria-pressed']).toBe(false);
    await press(c, h, zh('sessions.screen.commentAsk'));
    expect(items()).toEqual([
      {
        id: 'comment:comment-a',
        kind: 'comment',
        label: 'src/answer.ts:11',
        text: 'src/answer.ts:11\n> +  return base + 2;\n\nKeep it at 1.\nThe caller expects 41.',
        comment: { id: 'comment-a', revision: 3 },
      },
    ]);
    expect(ask().props['aria-pressed']).toBe(true);
    await press(c, h, zh('sessions.screen.commentAsk'));
    expect(items()).toEqual([]);
    expect(ask().props['aria-pressed']).toBe(false);
    expect(sent()).toEqual([]);
  });

  it('marks an attached comment sent once the message carrying it is sent, not when it fails', async () => {
    mock.comments = [comment()];
    const h = await inspector();
    await press(card(h), h, zh('sessions.screen.commentAsk'));
    const compose = () =>
      mount(() =>
        SessionCompose({
          session: open,
          listed: listed({ state: 'running' }),
          title: 'title of session-a',
        }),
      );
    command.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_state', message: 'busy' } });
    let box = compose();
    named(box.value, 'SendButton').props.onPress();
    await box.flush();
    expect(sent().map((c) => c.type)).toEqual(['session.send']);
    expect(items()).toHaveLength(1);
    box = compose();
    named(box.value, 'SendButton').props.onPress();
    await box.flush();
    expect(sent().slice(1)).toEqual([
      expect.objectContaining({ type: 'session.send' }),
      {
        type: 'session.comment.resolve',
        input: { comment_id: 'comment-a', state: 'sent' },
        expected_revision: 3,
      },
    ]);
    expect(items()).toEqual([]);
  });

  it('shows a failure toast when a comment a sent message carried cannot be marked sent', async () => {
    command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'revision_conflict', message: 'Comment changed' },
    });
    markCommentsSent([
      { id: 'comment:comment-a', kind: 'comment', label: '', text: '', comment: comment() },
    ]);
    await vi.waitFor(() =>
      expect(mock.toasts).toEqual([
        expect.objectContaining({
          kind: 'failure',
          title: expect.stringContaining('Comment changed'),
        }),
      ]),
    );
  });

  it('lists the comments the diff cannot place above the files, on the whole branch only', async () => {
    mock.comments = [
      comment(),
      comment({ id: 'comment-gone', path: 'src/gone.ts', line: 3 }),
      comment({ id: 'comment-far', line: 99 }),
    ];
    const h = await inspector();
    const shown = nodes(mount(() => DiffFiles(diffProps(h))).value);
    const group = shown.findIndex((n) => n.props.className === 'df-loose');
    expect(group).toBeGreaterThan(-1);
    expect(group).toBeLessThan(shown.findIndex((n) => n.props.className === 'ss-fd'));
    const loose = nodes(shown[group]!)
      .filter((n) => n.props.comment)
      .map((n) => n.props.comment.id);
    expect(loose).toEqual(['comment-gone', 'comment-far']);
    expect(text(card(h, 'comment-gone', true).value)).toContain('src/gone.ts:3');
    expect(text(card(h, 'comment-a').value)).not.toContain('src/answer.ts:11');

    useTurnScope.getState().set('session-a', 'turn-1');
    const turnView = await inspector();
    const inTurn = nodes(mount(() => DiffFiles(diffProps(turnView))).value);
    expect(inTurn.some((n) => n.props.className === 'df-loose')).toBe(false);
    expect(inTurn.some((n) => n.props.comment?.id === 'comment-a')).toBe(true);
  });

  it('follows the commented line by its text when a line above it was added since', async () => {
    mock.diff = {
      ...diff,
      patch: [
        'diff --git a/src/answer.ts b/src/answer.ts',
        '--- a/src/answer.ts',
        '+++ b/src/answer.ts',
        '@@ -10,3 +10,4 @@ export function answer() {',
        '   const base = 40;',
        '-  return base + 1;',
        '+  const step = 2;',
        '+  return base + 2;',
        '   // done',
      ].join('\n'),
    };
    mock.comments = [comment({ line_text: '  return base + 2;' })];
    const h = await inspector();
    const shown = nodes(mount(() => DiffFiles(diffProps(h))).value);
    const at = (pick: (n: ReactElement<any>) => boolean) => shown.findIndex(pick);
    const code = (line: string) =>
      at((n) => n.props.className === 'ss-code' && n.props.children === line);
    const placed = at((n) => n.props.comment?.id === 'comment-a');
    expect(placed).toBeGreaterThan(code('  return base + 2;'));
    expect(placed).toBeLessThan(code('  // done'));
    expect(shown.some((n) => n.props.className === 'df-loose')).toBe(false);
    const c = card(h);
    await press(c, h, zh('sessions.screen.commentAsk'));
    expect(items()[0]!.text).toBe(
      'src/answer.ts:12\n> +  return base + 2;\n\nKeep it at 1.\nThe caller expects 41.',
    );
  });

  it('follows the commented line by its text when its old number is past every hunk', async () => {
    mock.comments = [comment({ line: 30, line_text: '  return base + 2;' })];
    const h = await inspector();
    const shown = nodes(mount(() => DiffFiles(diffProps(h))).value);
    const at = (pick: (n: ReactElement<any>) => boolean) => shown.findIndex(pick);
    const placed = at((n) => n.props.comment?.id === 'comment-a');
    expect(placed).toBeGreaterThan(
      at((n) => n.props.className === 'ss-code' && n.props.children === '  return base + 2;'),
    );
    expect(shown.some((n) => n.props.className === 'df-loose')).toBe(false);
  });

  it('lists a comment whose line changed as outdated and quotes the line it was made on', async () => {
    mock.comments = [
      comment({ line_text: '  return base + 3;' }),
      comment({ id: 'comment-twice', line: 10, line_text: '  // done' }),
    ];
    mock.diff = {
      ...diff,
      patch: `${diff.patch}\n+  // done`.replace('@@ -10,3 +10,3 @@', '@@ -10,3 +10,4 @@'),
    };
    const h = await inspector();
    const shown = nodes(mount(() => DiffFiles(diffProps(h))).value);
    const group = shown.find((n) => n.props.className === 'df-loose');
    expect(
      nodes(group!)
        .filter((n) => n.props.comment)
        .map((n) => n.props.comment.id),
    ).toEqual(['comment-a', 'comment-twice']);
    expect(shown.filter((n) => n.props.comment)).toHaveLength(2);
    const c = card(h, 'comment-a', true);
    expect(text(c.value)).toContain(zh('sessions.screen.commentOutdated'));
    await press(c, h, zh('sessions.screen.commentAsk'));
    expect(items()[0]!.text).toBe(
      'src/answer.ts:11\n>   return base + 3;\n\nKeep it at 1.\nThe caller expects 41.',
    );
  });
});
