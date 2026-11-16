import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
import { DEFAULT_LOOK, setLook } from '@/data/layout';
import { DEFAULT_SESSION_DISPLAY, setSessionDisplay } from '@/data/session-display';
import type { DaemonEvent } from '@/data/sync';
import {
  buildTranscript,
  type SessionTurn,
  type ToolItem,
  type TranscriptItem,
} from '@/data/transcript';
import { Items } from '@/screens/sessions/parts';
import { ThreadTurn } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const turn = (extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id: 'turn-1',
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-a',
  input: 'Check the webhook',
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
  ...extra,
});
const event = (sequence: number, kind: string, payload: object, aggregate = 'session-a') =>
  ({
    sequence,
    event_id: `event-${sequence}`,
    kind,
    aggregate_id: aggregate,
    aggregate_revision: sequence,
    project_id: 'project-a',
    causation_id: 'cause',
    created_at: new Date(2026, 10, 12, 10, 7, sequence).getTime(),
    payload: { turn_id: 'turn-1', ...payload },
  }) as DaemonEvent;

const body = (tree: unknown, name: string) => {
  const node = named(tree as any, name);
  return mount(() => (node.type as (props: unknown) => ReactNode)(node.props) as ReactElement<any>);
};
const isTaskRow = (n: ReactElement<any>) =>
  typeof n.type === 'function' && n.type.name === 'TaskRow';
// Each task row's own row, drawn from the props the fan gave it.
const taskRows = (tree: unknown) =>
  nodes(tree as any)
    .filter(isTaskRow)
    .map((n) =>
      find(
        mount(() => (n.type as (props: unknown) => ReactNode)(n.props) as ReactElement<any>).value,
        (row) => row.props.className === 'ss-fanrow',
      ),
    );

beforeEach(() => {
  mock.board = { board: { sessions: [{ id: 'session-a', runtime: 'claude', revision: 3 }] } };
});
afterEach(() => {
  unmountAll();
  setLook(DEFAULT_LOOK);
  setSessionDisplay(DEFAULT_SESSION_DISPLAY);
  vi.unstubAllGlobals();
});

describe('subagents dispatched together', () => {
  const call = (id: string, extra: Partial<ToolItem>): ToolItem => ({
    kind: 'tool',
    id,
    name: 'Read',
    input: { file_path: '/repo/a.ts' },
    ...extra,
  });
  const run = () => [
    call('read-1', { ok: true, started_at: 0, completed_at: 100 }),
    call('task-1', {
      name: 'Task',
      input: {
        subagent_type: 'Explore',
        description: 'Find the body middleware',
        prompt: 'Find where the body parser is registered.',
      },
      ok: true,
      output: [{ type: 'text', text: 'It is registered in app.ts.' }],
      started_at: 1_000,
      completed_at: 4_000,
    }),
    call('task-2', {
      name: 'Agent',
      input: { subagent_type: 'migrator', description: 'Move the secrets table' },
      started_at: 1_500,
    }),
    call('child-1', { parent: 'task-1', ok: true, started_at: 1_200, completed_at: 1_300 }),
  ];
  const fan = () => {
    const tree = Items({
      items: run(),
      verbose: false,
      ended: false,
      folders: [],
      sessionId: 'session-a',
      owner: 'turn-1',
    });
    return { tree, fan: body(tree, 'SubagentFan') };
  };

  it('draws the dispatched agents as one group with a row each, and keeps the other calls apart', () => {
    const { tree, fan: shown } = fan();
    const plain = named(tree, 'ToolCalls');
    expect(plain.props.calls.map((c: ToolItem) => c.id)).toEqual(['read-1']);
    expect(text(find(shown.value, (n) => n.props.className === 'ss-fant'))).toBe('派出 2 个 agent');
    expect(text(find(shown.value, (n) => n.props.className === 'ss-fanc'))).toBe('1 / 2 完成');
    const rows = taskRows(shown.value);
    expect(rows.map((n) => n.props['aria-label'])).toEqual([
      '探查，Find the body middleware，成功，3.0 秒',
      'migrator，Move the secrets table，运行中',
    ]);
  });

  it('marks each row with the runtime and the type, a known type by its icon and another by its letter', () => {
    const { fan: shown } = fan();
    const rows = taskRows(shown.value);
    expect(rows.map((row) => named(row, 'RuntimeGlyph').props.runtime)).toEqual([
      'claude',
      'claude',
    ]);
    const types = rows.map((row) => named(row, 'AgentTypeIcon').props.type);
    expect(types).toEqual(['Explore', 'migrator']);
    const icon = body(rows[0], 'AgentTypeIcon');
    expect(icon.value.props['aria-label']).toBe('类型：探查');
    const letter = body(rows[1], 'AgentTypeIcon');
    expect(letter.value.props['aria-label']).toBe('类型：migrator');
    expect(text(letter.value)).toBe('M');
  });

  it("folds out the agent's prompt, its own calls and its report as messages between the agents", () => {
    const { fan: shown } = fan();
    const [first] = nodes(shown.value).filter(isTaskRow);
    const messages = nodes(first)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'AgentMessage')
      .map((n) => [n.props.from, n.props.to, n.props.text]);
    expect(messages).toEqual([
      [
        zh('sessions.thread.main'),
        zh('sessions.agentType.explore'),
        'Find where the body parser is registered.',
      ],
      [zh('sessions.agentType.explore'), zh('sessions.thread.main'), 'It is registered in app.ts.'],
    ]);
    const own = nodes(first).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'ToolCall',
    );
    expect(own.map((n) => [n.props.item.id, n.props.depth])).toEqual([['child-1', 0]]);
  });
});

describe('Codex subagents', () => {
  const collab = (
    id: string,
    tool: string,
    states: object,
    extra: Partial<ToolItem>,
  ): ToolItem => ({
    kind: 'tool',
    id,
    name: 'collabAgentToolCall',
    input: { tool, senderThreadId: 'main-thread', receiverThreadIds: [], prompt: null },
    ok: true,
    output: { agentsStates: states, status: 'completed' },
    ...extra,
  });
  // Codex completes a spawn once the agent is dispatched; only the spawn's output names its thread.
  const spawn = collab(
    'spawn-1',
    'spawnAgent',
    { 'child-thread': { status: 'pendingInit', message: null } },
    {
      input: {
        tool: 'spawnAgent',
        senderThreadId: 'main-thread',
        receiverThreadIds: [],
        prompt: 'Check the migrations.',
      },
      started_at: 1_000,
      completed_at: 1_100,
    },
  );
  const wait = (status: string, message: string | null) =>
    collab(
      'wait-1',
      'wait',
      { 'child-thread': { status, message } },
      { started_at: 1_200, completed_at: 9_000 },
    );
  const row = (items: TranscriptItem[]) => {
    const tree = Items({
      items,
      verbose: false,
      ended: false,
      folders: [],
      sessionId: 'session-a',
      owner: 'turn-1',
    });
    const shown = body(tree, 'SubagentFan').value;
    return {
      label: taskRows(shown)[0]!.props['aria-label'],
      done: text(find(shown, (n) => n.props.className === 'ss-fanc')),
      messages: nodes(shown)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'AgentMessage')
        .map((n) => n.props.text),
    };
  };

  it('shows a dispatched agent as running until a later call reports its thread', () => {
    expect(row([spawn])).toEqual({
      label: '协作代理，Check the migrations.，运行中',
      done: '0 / 1 完成',
      messages: ['Check the migrations.'],
    });
  });

  it('shows the agent done when a later wait says its thread completed, timed up to that wait, with its report', () => {
    const shown = row([
      spawn,
      { kind: 'text', text: 'Waiting for the agent.' },
      wait('completed', 'The migrations are in order.'),
    ]);
    expect(shown).toEqual({
      label: '协作代理，Check the migrations.，成功，8.0 秒',
      done: '1 / 1 完成',
      messages: ['Check the migrations.', 'The migrations are in order.'],
    });
  });

  it('shows the agent failed when a later state says its thread errored', () => {
    expect(row([spawn, wait('errored', 'The sandbox refused the write.')]).label).toBe(
      '协作代理，Check the migrations.，失败，8.0 秒',
    );
  });
});

describe('who speaks in the thread', () => {
  const turnHost = (extra: Partial<SessionTurn>, events: DaemonEvent[]) =>
    mount(() =>
      ThreadTurn({
        view: buildTranscript([turn(extra)], events).turns[0]!,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: null,
      }),
    );

  it("puts the runtime, the main conversation, the model and the time before the agent's reply", () => {
    const h = turnHost({ reported_model: 'claude-opus-5-5' }, [
      event(1, 'turn.running', {}, 'turn-1'),
      event(2, 'agent.message.delta', { text: 'Reading the body.' }),
    ]);
    const who = find(h.value, (n) => n.props.className === 'ss-who');
    expect(named(who, 'RuntimeGlyph').props.runtime).toBe('claude');
    expect(text(who)).toBe('主对话claude-opus-5-510:07');
  });

  it('names the model the turn was set to when the runtime reported none, and shows no row before any reply', () => {
    const h = turnHost({ model: 'gpt-5.5' }, [event(1, 'agent.message.delta', { text: 'Hi.' })]);
    expect(text(find(h.value, (n) => n.props.className === 'ss-who'))).toContain('gpt-5.5');
    const quiet = turnHost({}, []);
    expect(nodes(quiet.value).some((n) => n.props.className === 'ss-who')).toBe(false);
  });
});

describe('notices in the thread', () => {
  it('says the context was compacted, with its size before', () => {
    const items = buildTranscript(
      [turn()],
      [event(1, 'agent.context.compacted', { trigger: 'auto', pre_tokens: 186_400 })],
    ).turns[0]!.items;
    const tree = Items({ items, verbose: false, ended: true, folders: [], sessionId: 'session-a' });
    const notice = body(body(tree, 'CompactNotice').value, 'ThreadMark');
    expect(notice.value.props.role).toBe('note');
    expect(text(notice.value)).toBe('已压缩上下文压缩前 186k token10:07');
    const bare = Items({
      items: buildTranscript([turn()], [event(1, 'agent.context.compacted', {})]).turns[0]!.items,
      verbose: false,
      ended: true,
      folders: [],
      sessionId: 'session-a',
    });
    expect(text(body(body(bare, 'CompactNotice').value, 'ThreadMark').value)).toBe(
      '已压缩上下文10:07',
    );
  });

  const ended = (events: DaemonEvent[], retry = false) =>
    mount(() =>
      ThreadTurn({
        view: buildTranscript([turn()], events).turns[0]!,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: null,
        retry,
      }),
    );

  it('says when the turn was interrupted and that its changes are kept', () => {
    const h = ended([event(1, 'turn.cancelled', {}, 'turn-1')]);
    const notice = find(h.value, (n) => n.props.role === 'note');
    expect(text(notice)).toBe('已打断已保留改动10:07');
  });

  it('shows the error of a failed turn and sends its input again from the retry', async () => {
    const commands: any[] = [];
    vi.stubGlobal('window', {
      pantheon: {
        command: vi.fn(async (command: any) => {
          commands.push(command);
          return { ok: true, value: {} };
        }),
      },
    });
    const failed = [event(1, 'turn.failed', { error: 'runtime exited with code 1' }, 'turn-1')];
    const notice = body(ended(failed, true).value, 'FailedNotice');
    expect(text(notice.value)).toContain('出错runtime exited with code 1');
    find(
      notice.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.screen.retry'),
    ).props.onClick();
    await notice.flush();
    expect(commands).toMatchObject([
      {
        type: 'session.send',
        input: { session_id: 'session-a', input: 'Check the webhook' },
        expected_revision: 3,
      },
    ]);
    const plain = body(ended(failed).value, 'FailedNotice');
    expect(nodes(plain.value).some((n) => n.type === 'button')).toBe(false);
  });

  it('sends the references of a failed turn again with its retry', async () => {
    const commands: any[] = [];
    vi.stubGlobal('window', {
      pantheon: {
        command: vi.fn(async (command: any) => {
          commands.push(command);
          return { ok: true, value: {} };
        }),
      },
    });
    const refs = [
      { kind: 'session' as const, id: 'session-b' },
      { kind: 'pr' as const, number: 42 },
    ];
    const h = mount(() =>
      ThreadTurn({
        view: buildTranscript(
          [turn({ refs })],
          [event(1, 'turn.failed', { error: 'runtime exited with code 1' }, 'turn-1')],
        ).turns[0]!,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: null,
        retry: true,
      }),
    );
    const notice = body(h.value, 'FailedNotice');
    find(
      notice.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.screen.retry'),
    ).props.onClick();
    await notice.flush();
    expect(commands).toMatchObject([
      {
        type: 'session.send',
        input: { session_id: 'session-a', input: 'Check the webhook', refs },
      },
    ]);
  });
});

describe('tool calls and reasoning as chosen in Session display', () => {
  const call = (id: string, ok: boolean): ToolItem => ({
    kind: 'tool',
    id,
    name: 'Bash',
    input: { command: `run ${id}` },
    ok,
    output: 'done',
  });
  const items = () => [
    { kind: 'reasoning' as const, text: 'Look at the failing test first.', summary: false },
    call('passed', true),
    call('broke', false),
  ];
  const tree = () =>
    Items({ items: items(), verbose: false, ended: true, folders: [], sessionId: 'session-a' });
  /** Whether each call, and the run that holds them, is drawn open. */
  const opened = () => {
    const shown = tree();
    const calls = nodes(shown).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'ToolCall',
    );
    return {
      run: body(shown, 'ToolCalls').value.props.open,
      calls: calls.map((n) => {
        const h = mount(() => (n.type as (props: unknown) => ReactElement<any>)(n.props));
        return [n.props.item.id, h.value.props.open];
      }),
    };
  };

  it('folds every call by default', () => {
    expect(opened()).toEqual({
      run: false,
      calls: [
        ['passed', false],
        ['broke', false],
      ],
    });
  });

  it('opens only the failed call, and its run, when failures open', () => {
    setLook({ transcript: 'open-failed' });
    expect(opened()).toEqual({
      run: true,
      calls: [
        ['passed', false],
        ['broke', true],
      ],
    });
  });

  it("opens a finished turn's folded work when a call in it failed", () => {
    const run = (failed: boolean) =>
      mount(() =>
        ThreadTurn({
          view: buildTranscript(
            [turn()],
            [
              event(1, 'agent.message.delta', { text: 'Running the tests.' }),
              event(2, 'agent.tool.started', {
                tool_call_id: 'call-1',
                name: 'Bash',
                input: { command: 'pnpm test' },
              }),
              event(3, 'agent.tool.completed', { tool_call_id: 'call-1', ok: !failed }),
              event(4, 'agent.message.delta', { text: 'Done.' }),
            ],
          ).turns[0]!,
          folders: [],
          status: { kind: 'ended', tool: null, since: null },
          fresh: new Set(),
          request: () => null,
          listed: null,
        }),
      );
    const work = (failed: boolean) => body(run(failed).value, 'TurnWork').value.props.defaultOpen;
    expect(work(true)).toBeFalsy();
    setLook({ transcript: 'open-failed' });
    expect(work(true)).toBe(true);
    expect(work(false)).toBeFalsy();
  });

  it('shows the reasoning by default and leaves it out when switched off', () => {
    const reasoning = () =>
      nodes(tree()).some((n) => typeof n.type === 'function' && n.type.name === 'Reasoning');
    expect(reasoning()).toBe(true);
    setSessionDisplay({ reasoning: false });
    expect(reasoning()).toBe(false);
  });
});
