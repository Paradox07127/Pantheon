import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Review, ReviewFinding, Session } from '@pantheon/domain';
import type { SessionDiff, SessionGates, WorkbenchSession } from '@pantheon/protocol';
import {
  deferred,
  find,
  type HookHost,
  mount as host,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  diff: null as any,
  gates: null as any,
  reviews: [] as any[],
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
  useTurnDiff: () => ({ data: null, error: null, reload: () => {} }),
}));
vi.mock('@/data/session-panel', () => ({
  useSessionGates: () => ({ data: mock.gates, error: null, reload: () => {} }),
  useSessionReviews: () => ({ data: mock.reviews, error: null, reload: () => {} }),
  useSessionPreflight: () => ({ data: null, error: null, reload: () => {} }),
  useSessionGatesHistory: () => ({ data: null, error: null, reload: () => {} }),
}));
vi.mock('@/data/facts-read', () => ({
  useFactsRead: () => ({ read: null, error: null, loading: false, unavailable: false }),
}));
import { useFeedback, type FeedbackItem } from '@/data/feedback';
import { t } from '@/i18n';
import { useQueueDispatch, useQueued } from '@/screens/sessions/parts';
import { SessionCompose, SessionInspector } from '@/screens/sessions/SessionsScreen';
import { GateResults } from '@/screens/sessions/GateResults';
import { ChecksTab, ReviewTab } from '@/screens/sessions/panel';

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

const finding: ReviewFinding = {
  id: 'finding-a',
  review_id: 'review-a',
  runtime: 'codex',
  round: 1,
  location: 'src/answer.ts:11',
  quote: 'return base + 2',
  evidence: 'The caller expects 41',
  impact: 'Returns the wrong answer',
  status: 'open',
  blocking: true,
};
const review: Review = {
  id: 'review-a',
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-a',
  round: 1,
  runtimes: ['codex'],
  state: 'completed',
  session_ids: [],
  findings: [finding],
};
const failedGates: SessionGates = {
  configured: true,
  running: false,
  last: {
    commit: 'abcdef1234567890',
    checked_at: 1,
    results: [
      { name: 'Lint', exit_code: 0, timed_out: false, output_tail: '' },
      { name: 'Unit tests', exit_code: 1, timed_out: false, output_tail: '1 failed' },
      { name: 'Build', exit_code: 0, timed_out: true, output_tail: 'still building' },
    ],
  },
};

const FINDING_TEXT =
  'Please fix this review finding: Returns the wrong answer (src/answer.ts:11)\n\nQuote:\nreturn base + 2\n\nEvidence:\nThe caller expects 41';
const CHECK_TEXT =
  'The project gate "Unit tests" failed on this worktree:\n\n1 failed\n\nFix it and commit.';

const attachFinding = (id: string) =>
  t({ id, defaultMessage: 'Attach: {impact}' }, { impact: 'Returns the wrong answer' });
const attachConflict = t({
  id: 'sessions.screen.attachConflict',
  defaultMessage: 'Attach conflict',
});

let command: ReturnType<typeof vi.fn>;
const items = (): readonly FeedbackItem[] => useFeedback.getState().items['session-a'] ?? [];
const button = (tree: unknown, label: string) =>
  find(tree as any, (n) => n.type === 'button' && n.props['aria-label'] === label);

beforeEach(() => {
  useFeedback.setState({ items: {} });
  useQueued.setState({ queued: {} });
  mock.board = {
    board: {
      cursor: 1,
      projects: [],
      sessions: [],
      workspaces: [{ id: 'workspace-a', source: '/repo', path: '/work/a', base_sha: 'base' }],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.diff = diff;
  mock.gates = failedGates;
  mock.reviews = [review];
  command = vi.fn(async () => ({ ok: true, value: {} }));
  vi.stubGlobal('window', {
    pantheon: { command, query: vi.fn(async () => ({ ok: true, value: [] })) },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('inspector feedback', () => {
  const inspector = (row = listed(), view: 'diff' | 'review' = 'diff') =>
    host(() =>
      SessionInspector({
        sessionId: 'session-a',
        listed: row,
        session: open,
        panels: ['changes', 'checks'],
        view,
        onOpen: () => {},
        onClose: () => {},
        onView: () => {},
      }),
    );
  const anchored = (h: HookHost<any>) =>
    named(h.value, 'DiffFiles').props.notes.map((f: { node: unknown }) => f.node);

  it('stores a line comment instead of attaching or sending it', async () => {
    const h = inspector();
    const ok = await named(h.value, 'DiffFiles').props.onComment(
      { path: 'src/answer.ts', line: 11, kind: 'add', text: '  return base + 2;' },
      'Keep it at 1.',
    );
    expect(ok).toBe(true);
    expect(items()).toEqual([]);
    expect(command.mock.calls.map(([c]) => c.type)).toEqual(['session.comment.add']);
  });

  it('attaches a finding shown in the diff once and takes it off when pressed again', () => {
    const h = inspector();
    const attach = () => button(anchored(h), attachFinding('sessions.screen.attachFinding'));
    expect(attach().props['aria-pressed']).toBe(false);
    attach().props.onClick();
    h.render();
    expect(items()).toEqual([
      { id: expect.any(String), kind: 'finding', label: 'src/answer.ts:11', text: FINDING_TEXT },
    ]);
    expect(attach().props['aria-pressed']).toBe(true);
    useFeedback.getState().add('session-a', items()[0]!);
    expect(items()).toHaveLength(1);
    attach().props.onClick();
    h.render();
    expect(items()).toEqual([]);
    expect(command).not.toHaveBeenCalled();
  });

  it('attaches a finding from the review tab and has no checkbox or fix button', () => {
    const h = inspector(listed(), 'review');
    const tab = () => host(() => ReviewTab(named(h.value, 'ReviewTab').props)).value;
    expect(nodes(tab()).some((n) => n.props.type === 'checkbox')).toBe(false);
    button(tab(), attachFinding('sessions.panel.review.attachLabel')).props.onClick();
    h.render();
    expect(items().map((i) => [i.kind, i.text])).toEqual([['finding', FINDING_TEXT]]);
    expect(
      button(tab(), attachFinding('sessions.panel.review.attachLabel')).props['aria-pressed'],
    ).toBe(true);
    expect(command).not.toHaveBeenCalled();
  });

  it('attaches a failed or timed out check with its output', () => {
    const h = inspector();
    const latest = () =>
      named(host(() => ChecksTab(named(h.value, 'ChecksTab').props)).value, 'GateResults').props;
    let props = latest();
    const results = host(() => GateResults(props));
    // Opens the command's log, where its output is attached.
    const attach = (name: string) => {
      const row = nodes(results.value).find(
        (n) => n.props['aria-expanded'] === false && text(n).includes(name),
      );
      if (row) {
        row.props.onClick();
        results.render();
      }
      const log = named(results.value, 'Log');
      const tree = host(() => (log.type as (p: unknown) => unknown)(log.props)).value;
      return button(
        tree,
        t(
          {
            id: 'sessions.panel.checks.attachOutput',
            defaultMessage: 'Attach the output of {name}',
          },
          { name },
        ),
      );
    };
    expect(() => attach('Lint')).toThrow();
    attach('Unit tests').props.onClick();
    h.render();
    attach('Build').props.onClick();
    h.render();
    expect(items().map((i) => [i.kind, i.label])).toEqual([
      ['check', 'Unit tests'],
      ['check', 'Build'],
    ]);
    expect(items()[0]!.text).toBe(CHECK_TEXT);
    expect(items()[1]!.text).toContain('still building');
    props = latest();
    results.render();
    expect(attach('Unit tests').props['aria-pressed']).toBe(true);
    expect(command).not.toHaveBeenCalled();
  });

  it('attaches a merge conflict or a failed merge gate', () => {
    const h = inspector(
      listed({ merge: { state: 'blocked', reason: 'rebase_conflict', conflicts: ['src/a.ts'] } }),
    );
    button(h.value, attachConflict).props.onClick();
    h.render();
    expect(items().map((i) => i.kind)).toEqual(['conflict']);
    expect(items()[0]!.text).toContain('src/a.ts');
    useFeedback.setState({ items: {} });
    const gate = inspector(
      listed({
        merge: {
          state: 'blocked',
          reason: 'gate_failed',
          gate: { name: 'Unit tests', output: '2 failed' },
        },
      } as Partial<WorkbenchSession>),
    );
    button(gate.value, attachConflict).props.onClick();
    expect(items().map((i) => i.kind)).toEqual(['conflict']);
    expect(items()[0]!.text).toContain('2 failed');
    expect(command).not.toHaveBeenCalled();
  });

  it('offers no attach button for a block nothing in the worktree can fix', () => {
    const h = inspector(listed({ merge: { state: 'blocked', reason: 'local_changes' } }));
    expect(() => button(h.value, attachConflict)).toThrow();
  });
});

describe('composer feedback', () => {
  const item = (id: string, kind: FeedbackItem['kind'] = 'comment'): FeedbackItem => ({
    id,
    kind,
    label: `label of ${id}`,
    text: `text of ${id}`,
  });
  const mount = (session: () => Session) =>
    host(() =>
      SessionCompose({
        session: session(),
        listed: listed({ state: 'running' }),
        title: 'title of session-a',
      }),
    );
  const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
  const key = (extra: object = {}) => ({
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
    ...extra,
  });
  function type(h: HookHost<any>, input: string) {
    box(h).props.onChange({ target: { value: input } });
    h.render();
  }
  const sent = () => command.mock.calls.map(([c]) => c.input);

  it('shows each item in the attachment strip and removes it with its cross', () => {
    useFeedback.getState().add('session-a', item('a'));
    useFeedback.getState().add('session-a', item('b', 'check'));
    const h = mount(() => open);
    const strip = named(h.value, 'AttachmentStrip');
    expect(strip.props.feedback.map((i: FeedbackItem) => i.id)).toEqual(['a', 'b']);
    strip.props.onRemoveFeedback('a');
    expect(items().map((i) => i.id)).toEqual(['b']);
  });

  it('sends the text and every item in one message and clears them', async () => {
    useFeedback.getState().add('session-a', item('a'));
    useFeedback.getState().add('session-a', item('b', 'finding'));
    const h = mount(() => open);
    type(h, 'look at these');
    box(h).props.onKeyDown(key());
    await h.flush();
    expect(sent()).toEqual([
      { session_id: 'session-a', input: 'look at these\n\ntext of a\n\ntext of b' },
    ]);
    expect(items()).toEqual([]);
  });

  it.each([
    [
      'keeps an item added while the message was being sent',
      'comment',
      () => useFeedback.getState().add('session-a', item('c', 'conflict')),
      ['c'],
    ],
    [
      'keeps an item taken off and attached again while the message was being sent',
      'finding',
      () => {
        useFeedback.getState().remove('session-a', 'a');
        useFeedback.getState().add('session-a', item('a', 'finding'));
      },
      ['a'],
    ],
  ] as const)('%s', async (_name, kind, whileSending, kept) => {
    const answer = deferred<unknown>();
    command.mockImplementationOnce(() => answer.promise);
    useFeedback.getState().add('session-a', item('a', kind));
    const h = mount(() => open);
    type(h, 'first');
    box(h).props.onKeyDown(key());
    whileSending();
    answer.resolve({ ok: true, value: {} });
    await h.flush();
    expect(sent()).toEqual([{ session_id: 'session-a', input: 'first\n\ntext of a' }]);
    expect(items().map((i) => i.id)).toEqual(kept);
  });

  it('sends the items alone when the text box is empty', async () => {
    useFeedback.getState().add('session-a', item('a'));
    const h = mount(() => open);
    expect(named(h.value, 'SendButton').props.empty).toBe(false);
    named(h.value, 'SendButton').props.onPress();
    await h.flush();
    expect(sent()).toEqual([{ session_id: 'session-a', input: 'text of a' }]);
    expect(items()).toEqual([]);
  });

  it('queues the items with the message and sends them later', async () => {
    let session: Session = { ...open, state: 'running' };
    useFeedback.getState().add('session-a', item('a'));
    const h = mount(() => session);
    type(h, 'later');
    box(h).props.onKeyDown(key());
    h.render();
    expect(useQueued.getState().queued['session-a']).toEqual([
      { text: 'later\n\ntext of a', attachments: [], skills: [] },
    ]);
    expect(items()).toEqual([]);
    session = { ...open, state: 'open' };
    mock.board.board.sessions = [session];
    await host(() => useQueueDispatch()).flush();
    expect(sent()).toEqual([{ session_id: 'session-a', input: 'later\n\ntext of a' }]);
  });

  it('marks a queued stored comment sent once its message is sent, not when it is queued', async () => {
    let session: Session = { ...open, state: 'running' };
    useFeedback
      .getState()
      .add('session-a', { ...item('a'), comment: { id: 'comment-a', revision: 3 } });
    const h = mount(() => session);
    type(h, 'later');
    box(h).props.onKeyDown(key());
    h.render();
    expect(command).not.toHaveBeenCalled();
    session = { ...open, state: 'open' };
    mock.board.board.sessions = [session];
    await host(() => useQueueDispatch()).flush();
    expect(command.mock.calls.map(([c]) => [c.type, c.input, c.expected_revision])).toEqual([
      ['session.send', { session_id: 'session-a', input: 'later\n\ntext of a' }, 2],
      ['session.comment.resolve', { comment_id: 'comment-a', state: 'sent' }, 3],
    ]);
  });
});
