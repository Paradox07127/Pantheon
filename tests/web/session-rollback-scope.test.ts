import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { SessionTurn } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
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
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => ({ read: null, error: null, loading: false, reload() {} }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
import { buildTranscript } from '@/data/transcript';
import { Items, usePrefill } from '@/screens/sessions/parts';
import { ThreadTurn } from '@/screens/sessions/SessionsScreen';
import { Thread } from '@/screens/sessions/Thread';
import { RollbackDialog } from '@/screens/sessions/TurnMenu';
import { zh } from './i18n-setup.js';

const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-14T09:00:00.000Z',
  title: 'Signed callbacks',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-14T09:00:00.000Z',
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
    input: 'Verify the callback signature',
    state: 'completed',
    ...extra,
  }) as SessionTurn;
const toolStarted = {
  sequence: 1,
  event_id: 'event-1',
  kind: 'agent.tool.started',
  aggregate_id: 'session-a',
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: 1_000,
  payload: {
    turn_id: 'turn-a',
    tool_call_id: 'call-a',
    name: 'Bash',
    input: { command: 'pnpm test' },
  },
};

let commands: { type: string; input: unknown; expected_revision: number | null }[];
let answers: Record<string, unknown>;
/** The body of a component the tree holds as an element. */
const body = (tree: unknown, name: string) => {
  const node = named(tree as any, name);
  return mount(() => (node.type as (props: unknown) => ReactNode)(node.props));
};
const button = (tree: unknown, label: string): ReactElement<any> =>
  find(tree as any, (n) => n.type === 'button' && n.props['aria-label'] === label);
const labelled = (tree: unknown, label: string) =>
  nodes(tree as any).some((n) => n.type === 'button' && n.props['aria-label'] === label);

beforeEach(() => {
  commands = [];
  answers = {};
  mock.board = {
    board: {
      sessions: [{ id: 'session-a', revision: 7, runtime: 'claude', project_id: 'project-a' }],
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
  mock.shell = { openSession: vi.fn() };
  usePrefill.setState({ prefill: {} });
  vi.stubGlobal('window', {
    pantheon: {
      command: vi.fn(async (command: any) => {
        commands.push(command);
        return { ok: true, value: {} };
      }),
      query: vi.fn(async (method: string) => ({ ok: true, value: answers[method] ?? [] })),
    },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('document', { activeElement: null });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('what a rollback puts back', () => {
  const dialog = (ask: string) => {
    const turn = mount(() =>
      ThreadTurn({
        view: buildTranscript([sessionTurn()], []).turns[0]!,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: listed(),
      }),
    );
    const actions = body(turn.value, 'TurnActions');
    button(actions.value, ask).props.onClick();
    actions.render();
    return body(actions.value, 'RollbackDialog');
  };
  const scopes = (h: HookHost<any>) =>
    find(h.value, (n) => typeof n.props.onValueChange === 'function');
  const choose = (h: HookHost<any>, scope: string) => {
    scopes(h).props.onValueChange(scope);
    h.render();
  };
  const confirm = (h: HookHost<any>) =>
    find(h.value, (n) => n.type === 'button' && n.props.className === 'btn dng');

  it('offers files and conversation, files only and conversation only, files and conversation first', () => {
    const h = dialog(zh('sessions.thread.rollback'));
    const group = scopes(h);
    expect(group.props.value).toBe('both');
    expect(
      nodes(group)
        .filter((n) => n.props.value !== undefined && n !== group)
        .map((n) => [n.props.value, text(n)]),
    ).toEqual([
      ['both', zh('sessions.screen.rollbackBoth')],
      ['files', zh('sessions.screen.rollbackFiles')],
      ['conversation', zh('sessions.screen.rollbackConversation')],
    ]);
  });

  it('says what each choice puts back', () => {
    const h = dialog(zh('sessions.thread.rollback'));
    const said = () => text(find(h.value, (n) => n.props.className === 'pj-rm-body'));
    expect(said()).toContain('对话也回到这一回合之前');
    choose(h, 'files');
    expect(said()).toContain('对话保持不变');
    choose(h, 'conversation');
    expect(said()).toContain('文件保持不变');
  });

  it('sends the chosen scope', async () => {
    for (const scope of ['both', 'files', 'conversation']) {
      const h = dialog(zh('sessions.thread.rollback'));
      choose(h, scope);
      confirm(h).props.onClick();
      await h.flush();
    }
    expect(commands.map((c) => c.input)).toEqual([
      { session_id: 'session-a', turn_id: 'turn-a', scope: 'both' },
      { session_id: 'session-a', turn_id: 'turn-a', scope: 'files' },
      { session_id: 'session-a', turn_id: 'turn-a', scope: 'conversation' },
    ]);
  });

  it('rewrites only when the conversation goes back too', async () => {
    const h = dialog(zh('sessions.thread.rewrite'));
    expect(text(confirm(h))).toBe(zh('sessions.screen.rollbackRewrite'));
    choose(h, 'conversation');
    expect(text(confirm(h))).toBe(zh('sessions.screen.rollbackRewrite'));
    choose(h, 'files');
    expect(text(confirm(h))).toBe(zh('sessions.screen.rollback'));
    confirm(h).props.onClick();
    await h.flush();
    expect(commands.map((c) => c.input)).toEqual([
      { session_id: 'session-a', turn_id: 'turn-a', scope: 'files' },
    ]);
    expect(usePrefill.getState().take('session-a')).toBeUndefined();
  });
});

describe('the checkpoint rollback of the session header', () => {
  it('offers no choice and restores the files only, as its words say', async () => {
    const h = mount(() =>
      RollbackDialog({
        open: true,
        rewrite: false,
        copy: { title: 'Back to the checkpoint', body: 'The conversation stays as it is.' },
        sessionId: 'session-a',
        turnId: 'turn-a',
        input: '',
        attachments: [],
        skills: [],
        onClose() {},
      }),
    );
    expect(nodes(h.value).some((n) => typeof n.props.onValueChange === 'function')).toBe(false);
    find(h.value, (n) => n.type === 'button' && n.props.className === 'btn dng').props.onClick();
    await h.flush();
    expect(commands.map((c) => c.input)).toEqual([
      { session_id: 'session-a', turn_id: 'turn-a', scope: 'files' },
    ]);
  });
});

describe('retry and compaction events', () => {
  const event = (kind: string, payload: object) => ({
    ...toolStarted,
    event_id: kind,
    kind,
    payload: { turn_id: 'turn-a', ...payload },
  });
  it('are not rows of the turn', () => {
    const view = buildTranscript(
      [sessionTurn({ state: 'running' })],
      [
        event('agent.turn.retrying', { attempt: 2, reason: 'rate_limit' }),
        event('agent.context.compacting', { trigger: 'auto' }),
      ],
    ).turns[0]!;
    const h = mount(() =>
      Items({
        items: view.items,
        verbose: false,
        ended: false,
        folders: [],
        sessionId: 'session-a',
        owner: 'turn-a',
        request: () => null,
      } as any),
    );
    expect(nodes(h.value).filter((n) => n.props?.event)).toEqual([]);
  });
});

describe('a fork from before one step of a turn', () => {
  const items = (forkSteps: boolean) =>
    mount(() =>
      Items({
        items: buildTranscript([sessionTurn()], [toolStarted] as any).turns[0]!.items,
        verbose: false,
        ended: true,
        folders: [],
        sessionId: 'session-a',
        forkSteps,
      }),
    );

  it('is offered on a tool call only where the runtime forks within a turn', () => {
    expect(
      labelled(body(items(true).value, 'ToolCall').value, zh('sessions.thread.forkStep')),
    ).toBe(true);
    expect(
      labelled(body(items(false).value, 'ToolCall').value, zh('sessions.thread.forkStep')),
    ).toBe(false);
  });

  it("forks before the call's span with the message written in the dialog", async () => {
    const call = body(items(true).value, 'ToolCall');
    button(call.value, zh('sessions.thread.forkStep')).props.onClick();
    call.render();
    expect(named(call.value, 'ForkDialog').props.open).toBe(true);
    const dialog = body(call.value, 'ForkDialog');
    find(dialog.value, (n) => n.type === 'textarea').props.onChange({
      target: { value: 'Run the tests with the old key' },
    });
    dialog.render();
    find(
      dialog.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.thread.forkConfirm'),
    ).props.onClick();
    await dialog.flush();
    expect(commands).toMatchObject([
      {
        type: 'session.fork',
        input: {
          session_id: 'session-a',
          before_span_id: 'call-a',
          input: 'Run the tests with the old key',
        },
        expected_revision: null,
      },
    ]);
    expect((commands[0]!.input as Record<string, unknown>).before_turn_id).toBeUndefined();
  });

  it('is turned on for the turns of a live worktree session whose runtime reports it', async () => {
    const forks = async (
      support: 'supported' | 'unsupported',
      row: WorkbenchSession,
      source: Record<string, unknown> = {},
    ) => {
      answers['runtime.status'] = [
        {
          runtime: 'claude',
          enabled: true,
          installed: true,
          auth: { state: 'logged_in' },
          capabilities: { fork_within_turn: { status: support } },
        },
      ];
      mock.board.board = {
        ...mock.board.board,
        sessions: [
          {
            id: 'session-a',
            revision: 7,
            runtime: 'claude',
            project_id: 'project-a',
            state: 'open',
            ...source,
          },
        ],
        session_turns: [sessionTurn()],
      };
      const h = mount(() =>
        Thread({
          board: mock.board.board,
          sessionId: 'session-a',
          listed: row,
          needs: { items: [] } as any,
          parent: null,
          panels: [],
          onPanel() {},
          overview: false,
          onDiscarded() {},
        }),
      );
      await h.flush();
      return nodes(h.value)
        .filter((n) => 'view' in n.props && 'status' in n.props)
        .map((n) => n.props.forkSteps);
    };
    expect(await forks('supported', listed())).toEqual([true]);
    expect(await forks('unsupported', listed())).toEqual([false]);
    expect(await forks('supported', listed({ state: 'merged' }))).toEqual([false]);
    // The daemon forks from before a step only off the current files of an idle session.
    expect(await forks('supported', listed(), { state: 'running' })).toEqual([false]);
    expect(await forks('supported', listed(), { stop_pending: true })).toEqual([false]);
    expect(
      await forks('supported', listed(), {
        rollback_pending: { checkpoint: 'abc1234', turn_id: 'turn-a' },
      }),
    ).toEqual([false]);
    expect(await forks('supported', listed(), { merge: { state: 'running' } })).toEqual([false]);
  });
});
