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
import type { DaemonEvent } from '@/data/sync';
import { buildTranscript, type SessionTurn, type ToolItem } from '@/data/transcript';
import { Items } from '@/screens/sessions/parts';
import { RequestIndex, ThreadTurn } from '@/screens/sessions/SessionsScreen';
import type { TimelineNode } from '@/screens/sessions/thread-model';
import { zh } from './i18n-setup.js';

const at = (hour: number, minute: number) => new Date(2026, 10, 12, hour, minute).getTime();
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
const byClass = (tree: unknown, name: string) =>
  nodes(tree as ReactNode).filter((n) => n.props.className === name);

beforeEach(() => {
  mock.board = { board: { sessions: [{ id: 'session-a', runtime: 'claude', revision: 3 }] } };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('timeline beside the thread', () => {
  /** Every element of the tree, with the elements a trigger renders in place of itself. */
  const all = (tree: unknown): ReactElement<any>[] =>
    nodes(tree as ReactElement).flatMap((n) => [n, ...(n.props.render ? all(n.props.render) : [])]);
  const marks = (tree: unknown) =>
    all(tree).filter((n) => n.type === 'button' && n.props.className === 'ss-tlm');
  const node = (id: string, kind: TimelineNode['kind'], time: number, turn: string | null) => ({
    id,
    kind,
    at: time,
    label: `label of ${id}`,
    name: `name of ${id}`,
    turn,
  });
  const shown = [
    node('task:a', 'task', at(10, 14), 'turn-1'),
    node('milestone:m', 'milestone', at(10, 36), 'turn-2'),
    node('wait:w', 'wait', at(10, 39), null),
  ];
  /** A thread whose marks' targets start `tops` pixels into its content. */
  const scroller = (scrollTop: number, clientHeight: number) => {
    const tops: Record<string, number> = {
      '[data-turn="turn-1"]': 0,
      '[data-turn="turn-2"]': 400,
      '[data-approval="w"]': 900,
    };
    return {
      current: {
        scrollTop,
        clientHeight,
        firstElementChild: {},
        getBoundingClientRect: () => ({ top: 100 }),
        querySelector: (selector: string) => ({
          getBoundingClientRect: () => ({ top: 100 - scrollTop + tops[selector]! }),
        }),
        addEventListener() {},
        removeEventListener() {},
      },
    };
  };
  const rail = (scrollTop: number, clientHeight: number) => {
    const thread = scroller(scrollTop, clientHeight) as any;
    return mount(() => RequestIndex({ nodes: shown, scroller: thread })).value;
  };

  it('names each mark by its time and label, and marks the last one the visible thread has reached', () => {
    const tree = rail(300, 400);
    expect(marks(tree).map((n) => n.props['aria-label'])).toEqual([
      '10:14 name of task:a',
      '10:36 name of milestone:m',
      '10:39 name of wait:w',
    ]);
    expect(marks(tree).map((n) => n.props['aria-current'])).toEqual([undefined, 'true', undefined]);
    expect(marks(rail(600, 400)).map((n) => n.props['aria-current'])).toEqual([
      undefined,
      undefined,
      'true',
    ]);
  });

  it('draws the visible part of the thread as a block behind the marks it covers', () => {
    const [block] = all(rail(0, 2000)).filter((n) => n.props.className === 'ss-tlv');
    // The first mark starts 24px down, the lines are 53px and 64px, and each mark is 20px high.
    expect(block!.props.style).toEqual({ transform: 'translateY(20px)', height: 185 });
  });
});

describe('the turn as the thread shows it', () => {
  const turnHost = (view: ReturnType<typeof buildTranscript>['turns'][number], extra = {}) =>
    mount(() =>
      ThreadTurn({
        view,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: null,
        ...extra,
      }),
    );

  it('heads the reply with the runtime, the name, the crown, the model and the time, in that order', () => {
    const h = turnHost(
      buildTranscript(
        [turn({ reported_model: 'claude-opus-5-5' })],
        [
          event(1, 'turn.running', {}, 'turn-1'),
          event(2, 'agent.message.delta', { text: 'Reading the body.' }),
        ],
      ).turns[0]!,
    );
    const who = find(h.value, (n) => n.props.className === 'ss-who');
    const shown = (who.props.children as ReactElement<any>[]).filter(Boolean);
    const parts = shown.map((n) =>
      n.props.className === 'lead-crown'
        ? 'crown'
        : typeof n.type === 'function'
          ? n.type.name
          : `${String(n.type)} ${text(n)}`,
    );
    expect(parts).toEqual([
      'RuntimeGlyph',
      `b ${zh('sessions.thread.main')}`,
      'crown',
      'span claude-opus-5-5',
      'span 10:07',
    ]);
    // The crown marks the main agent, which the name beside it already says; the session need not be a lead.
    const crown = shown[2]!;
    expect(crown.props['aria-hidden']).toBe('true');
    expect(crown.props['aria-label']).toBeUndefined();
  });

  it('draws a finished task and a reached milestone as centred marks with their time', () => {
    const h = turnHost(buildTranscript([turn()], []).turns[0]!, {
      marks: [
        {
          id: 'task:a',
          kind: 'task',
          at: at(10, 14),
          label: 'Sign the raw body',
          name: '任务完成：Sign the raw body',
          turn: 'turn-1',
        },
        {
          id: 'milestone:m',
          kind: 'milestone',
          at: at(10, 36),
          label: 'Signatures checked',
          name: '里程碑：Signatures checked',
          turn: 'turn-1',
        },
      ],
    });
    const marks = nodes(h.value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'ThreadMark',
    );
    expect(marks.map((n) => text(body(n, 'ThreadMark').value))).toEqual([
      '任务完成：Sign the raw body10:14',
      '里程碑：Signatures checked10:36',
    ]);
  });

  it('draws the compacted context as a centred mark with its time', () => {
    const items = buildTranscript(
      [turn()],
      [event(1, 'agent.context.compacted', { trigger: 'auto', pre_tokens: 186_400 })],
    ).turns[0]!.items;
    const tree = Items({ items, verbose: false, ended: true, folders: [], sessionId: 'session-a' });
    const notice = body(body(tree, 'CompactNotice').value, 'ThreadMark');
    expect(notice.value.props.className).toBe('ss-mark');
    expect(text(notice.value)).toBe('已压缩上下文压缩前 186k token10:07');
  });

  it('leaves the status line to the composer when the composer already says it', () => {
    const view = buildTranscript(
      [turn({ state: 'running' })],
      [event(1, 'turn.running', {}, 'turn-1')],
    ).turns[0]!;
    const status = { kind: 'approval' as const, tool: null, since: null };
    const line = (statusInCompose: boolean) =>
      nodes(turnHost(view, { status, statusInCompose }).value).some(
        (n) => typeof n.type === 'function' && n.type.name === 'TurnStatusLine',
      );
    expect(line(true)).toBe(false);
    expect(line(false)).toBe(true);
  });
});

describe('tool rows', () => {
  it('shows the verb, the object, the state and the time, and folds a long output after its first lines', () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const call: ToolItem = {
      kind: 'tool',
      id: 'read-1',
      name: 'Bash',
      input: { command: 'pnpm test' },
      ok: true,
      output,
      started_at: 0,
      completed_at: 200,
    };
    const tree = Items({ items: [call], verbose: false, ended: true, folders: [], sessionId: 's' });
    const row = body(body(tree, 'ToolCalls').value, 'ToolCall');
    expect(text(byClass(row.value, 'ss-tn')[0])).toBe('Bash');
    expect(text(byClass(row.value, 'ss-ta mono')[0])).toBe('pnpm test');
    expect(named(row.value, 'StateMark').props.state).toBe('ok');
    expect(text(byClass(row.value, 'ss-td mono')[0])).toBe('0.2 秒');
    const out = find(row.value, (n) => n.props.label === zh('sessions.parts.output'));
    const shown = mount(() => (out.type as (props: unknown) => ReactElement<any>)(out.props));
    expect(text(find(shown.value, (n) => n.type === 'pre')).split('\n')).toHaveLength(12);
    const more = find(shown.value, (n) => n.type === 'button');
    expect(text(more)).toBe('还有 8 行');
    more.props.onClick();
    shown.render();
    expect(text(find(shown.value, (n) => n.type === 'pre'))).toBe(output);
    expect(nodes(shown.value).some((n) => n.type === 'button')).toBe(false);
  });
});

describe('the card of dispatched agents', () => {
  const agent = (id: string, extra: Partial<ToolItem>): ToolItem => ({
    kind: 'tool',
    id,
    name: 'Task',
    input: { subagent_type: 'Explore', description: `describe ${id}` },
    ...extra,
  });
  const card = (agents: ToolItem[]) =>
    body(
      Items({
        items: agents,
        verbose: false,
        ended: false,
        folders: [],
        sessionId: 'session-a',
        owner: 'turn-1',
      }),
      'SubagentFan',
    ).value;

  it('heads the card with the count, whether they ran together, and how many are done', () => {
    const shown = card([
      agent('a', { ok: true, started_at: 1_000, completed_at: 4_000 }),
      agent('b', {
        input: { subagent_type: 'migrator', description: 'Move the table' },
        started_at: 1_500,
      }),
    ]);
    expect(text(byClass(shown, 'ss-fant')[0])).toBe('派出 2 个 agent');
    expect(text(byClass(shown, 'ss-fanm')[0])).toBe(zh('sessions.thread.fanTogether'));
    expect(text(byClass(shown, 'ss-fanc')[0])).toBe('1 / 2 完成');
    const types = nodes(shown)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'TaskRow')
      .map((row) => body(body(row, 'TaskRow').value, 'AgentTypeIcon').value.props['aria-label']);
    expect(types).toEqual(['类型：探查', '类型：migrator']);
    const after = card([
      agent('a', { ok: true, started_at: 1_000, completed_at: 2_000 }),
      agent('b', { ok: true, started_at: 2_000, completed_at: 3_000 }),
    ]);
    expect(text(byClass(after, 'ss-fanm')[0])).toBe(zh('sessions.thread.fanInTurn'));
  });
});
