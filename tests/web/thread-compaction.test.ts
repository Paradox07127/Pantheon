import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { mount, named, nodes, text, unmountAll } from './web-hook-host.js';
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
import { buildTranscript, type SessionTurn } from '@/data/transcript';
import { sessionMarkdown } from '@/screens/sessions/export-markdown';
import { ThreadTurn } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const turn = (extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id: 'turn-1',
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-a',
  input: '',
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
  origin: 'compaction',
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
const named_ = (tree: unknown, name: string) =>
  nodes(tree as ReactNode).filter((n) => typeof n.type === 'function' && n.type.name === name);
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

beforeEach(() => {
  mock.board = { board: { sessions: [{ id: 'session-a', runtime: 'claude', revision: 3 }] } };
});
afterEach(unmountAll);

describe('a compaction turn in the thread', () => {
  const running = (input = '') =>
    buildTranscript([turn({ state: 'running', input })], [event(1, 'turn.running', {}, 'turn-1')])
      .turns[0]!;

  it('draws a running compaction as one mark, with no message and no turn actions', () => {
    const h = turnHost(running());
    const tree = h.value;
    expect(nodes(tree).some((n) => /\bss-(user|sys|lead)\b/.test(n.props.className ?? ''))).toBe(
      false,
    );
    expect(named_(tree, 'TurnActions')).toEqual([]);
    const marks = named_(tree, 'ThreadMark');
    expect(marks).toHaveLength(1);
    const mark = body(marks[0], 'ThreadMark').value;
    expect(text(mark)).toBe(zh('sessions.thread.compacting'));
    expect(nodes(mark).some((n) => /\bsi-spin\b/.test(n.props.className ?? ''))).toBe(true);
  });

  it('shows the instructions beside the running mark, cut to one line with the whole in its title', () => {
    const h = turnHost(running('keep the plan'));
    const mark = body(named_(h.value, 'ThreadMark')[0], 'ThreadMark').value;
    const said = nodes(mark).find((n) => n.props.className === 'ss-marki');
    expect(text(said!)).toBe('keep the plan');
    expect(said!.props.title).toBe('keep the plan');
  });

  it('draws a finished compaction as the compacted mark only', () => {
    const view = buildTranscript(
      [turn()],
      [
        event(1, 'turn.running', {}, 'turn-1'),
        event(2, 'agent.context.compacted', { trigger: 'manual', pre_tokens: 186_400 }),
      ],
    ).turns[0]!;
    const h = turnHost(view);
    expect(named_(h.value, 'TurnActions')).toEqual([]);
    expect(named_(h.value, 'ThreadMark')).toEqual([]);
    expect(nodes(h.value).some((n) => n.props.className === 'ss-who')).toBe(false);
    const items = body(h.value, 'Items').value;
    const notice = body(body(items, 'CompactNotice').value, 'ThreadMark');
    expect(text(notice.value)).toBe('已压缩上下文压缩前 186k token10:07');
  });

  it('draws a failed compaction as a failed turn with no retry', () => {
    const view = buildTranscript(
      [turn({ state: 'failed' })],
      [event(1, 'turn.failed', { error: 'compaction failed' }, 'turn-1')],
    ).turns[0]!;
    const h = turnHost(view, { retry: true });
    const failed = named_(h.value, 'FailedNotice');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.props.retry).toBeNull();
  });
});

describe('a compaction turn in the Markdown export', () => {
  it('is one line, not a message', () => {
    const view = buildTranscript([turn({ input: 'keep the plan' })], []).turns[0]!;
    const markdown = sessionMarkdown(
      { title: 'Notes', runtime: 'claude', turns: [view] },
      new Date(2026, 10, 13, 14, 30).getTime(),
    );
    expect(markdown.split('\n\n').slice(2)).toEqual([`${zh('sessions.thread.compacted')}\n`]);
  });

  it('leaves out a compaction that failed', () => {
    const view = buildTranscript(
      [turn({ state: 'failed' })],
      [event(1, 'turn.failed', { error: 'compaction failed' }, 'turn-1')],
    ).turns[0]!;
    const markdown = sessionMarkdown(
      { title: 'Notes', runtime: 'claude', turns: [view] },
      new Date(2026, 10, 13, 14, 30).getTime(),
    );
    expect(markdown).not.toContain(zh('sessions.thread.compacted'));
  });
});
