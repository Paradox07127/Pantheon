import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTurn } from '@pantheon/domain';
import type { DaemonEvent } from '@/data/sync';
import { mount, nodes, text as textOf, unmountAll } from './web-hook-host.js';
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
import {
  buildTranscript,
  foldTurn,
  type RequestItem,
  type ToolItem,
  type TranscriptItem,
  type TurnView,
} from '@/data/transcript';
import { Items, StateMark, TurnWork } from '@/screens/sessions/parts';
import { ThreadTurn } from '@/screens/sessions/SessionsScreen';

const call = (id: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool',
  id,
  name: 'Bash',
  input: { command: `run ${id}` },
  ok: true,
  ...extra,
});
const plan = (id: string): ToolItem =>
  call(id, { name: 'mcp__pantheon__accept_task', input: { task_id: 'task-a' } });
const say = (value: string): TranscriptItem => ({ kind: 'text', text: value });
const ask = (id: string, extra: Partial<RequestItem> = {}): RequestItem => ({
  kind: 'request',
  id,
  tool: 'Bash',
  input: {},
  questions: [],
  ...extra,
});
const note: TranscriptItem = {
  kind: 'event',
  event: {
    sequence: 1,
    event_id: 'event-1',
    kind: 'agent.notice',
    aggregate_id: 'session-a',
    aggregate_revision: 1,
    project_id: 'project-a',
    causation_id: 'cause',
    created_at: 1,
    payload: {},
  } as DaemonEvent,
};

describe('folding a finished turn', () => {
  it('keeps the opening text and the conclusion out of the work', () => {
    const items = [say('looking'), call('a'), say('found it'), call('b'), say('done')];
    expect(foldTurn(items)).toEqual({
      head: [items[0]],
      work: [items[1], items[2], items[3]],
      kept: [],
      tail: [items[4]],
    });
  });

  it('takes no opening text that follows a call or is the conclusion itself', () => {
    const late = [call('a'), say('mid'), call('b'), say('done')];
    expect(foldTurn(late)).toMatchObject({ head: [], work: late.slice(0, 3), tail: [late[3]] });
    const single = [say('done'), call('a')];
    expect(foldTurn(single)).toMatchObject({ head: [], work: [single[1]], tail: [single[0]] });
  });

  it('keeps plan calls and waiting requests visible and folds answered requests and events', () => {
    const answered = ask('r1', { outcome: 'approve' });
    const waiting = ask('r2');
    const items = [call('a'), plan('p'), answered, waiting, note];
    expect(foldTurn(items)).toEqual({
      head: [],
      work: [items[0], answered, note],
      kept: [items[1], waiting],
      tail: [],
    });
  });

  it('does not fold a turn whose work holds no plain call', () => {
    expect(foldTurn([say('done')])).toBeNull();
    expect(foldTurn([say('go'), plan('p'), note, say('done')])).toBeNull();
  });
});

const view = (items: TranscriptItem[], extra: Partial<TurnView> = {}): TurnView => ({
  ...buildTranscript(
    [
      {
        id: 'turn-a',
        project_id: 'project-a',
        session_id: 'session-a',
        revision: 1,
        input: 'Tighten the release notes',
        kind: 'send',
        delivery: 'delivered',
        state: 'completed',
      } satisfies SessionTurn,
    ],
    [],
  ).turns[0]!,
  started_at: 1_000,
  ended_at: 4_400,
  end: { state: 'completed', error: null },
  items,
  ...extra,
});

describe('the work row', () => {
  beforeEach(() => {
    mock.board = {
      board: { sessions: [], session_turns: [], projects: [], workspaces: [], cursor: 1 },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    mock.shell = {};
  });
  afterEach(() => {
    unmountAll();
  });

  const thread = (v: TurnView) =>
    mount(() =>
      ThreadTurn({
        view: v,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: null,
      }),
    );
  const shown = (tree: unknown) =>
    nodes(tree as any)
      .filter((n) => n.type === TurnWork || (n.type === Items && n.props.items.length > 0))
      .map((n) => (n.type === TurnWork ? 'work' : n.props.items));

  it('shows the opening text, the work row, the kept items and the conclusion of a finished turn', () => {
    const items = [say('looking'), call('a'), plan('p'), call('b'), say('done')];
    const h = thread(view(items));
    expect(shown(h.value)).toEqual([
      [items[0]],
      'work',
      [items[1], items[3]],
      [items[2]],
      [items[4]],
    ]);
  });

  it('names a part of the turn by its place in the whole turn, so its entry plays once', () => {
    const items = [call('a'), say('done')];
    const part = (all?: TranscriptItem[]) =>
      nodes(
        mount(() =>
          Items({
            items: [items[1]!],
            all,
            verbose: false,
            ended: true,
            folders: [],
            sessionId: 'session-a',
            owner: 'turn-a',
            fresh: new Set(['text:tool:a']),
          }),
        ).value as any,
      ).find(
        (n) => typeof n.props.className === 'string' && n.props.className.startsWith('tr-msg'),
      )!.props.className;
    expect(part(items)).toBe('tr-msg tr-in');
    expect(part()).toBe('tr-msg');
  });

  it('folds a rolled-back turn the same way', () => {
    const items = [call('a'), say('done')];
    const v = view(items);
    const h = thread({ ...v, turn: { ...v.turn, rolled_back: true } });
    expect(shown(h.value)).toEqual(['work', [items[0]], [items[1]]]);
  });

  it('shows a running turn or one without plain calls whole', () => {
    const items = [call('a'), say('done')];
    const v = view(items);
    expect(shown(thread({ ...v, turn: { ...v.turn, state: 'running' } }).value)).toEqual([items]);
    const plain = [say('go'), plan('p'), say('done')];
    expect(shown(thread(view(plain)).value)).toEqual([plain]);
  });

  const row = (v: TurnView, work: TranscriptItem[]) =>
    mount(() =>
      TurnWork({ work, end: v.end, started_at: v.started_at, ended_at: v.ended_at, children: 'x' }),
    );
  const trigger = (tree: unknown) =>
    nodes(tree as any).find((n) => typeof n.props['aria-label'] === 'string')!;

  it('says how long the turn worked and what it did, folded by default', () => {
    const work = [call('a'), call('b')];
    const h = row(view(work), work);
    const root = nodes(h.value)[0]!;
    expect(root.props.open ?? root.props.defaultOpen ?? false).toBe(false);
    expect(trigger(h.value).props['aria-label']).toBe('工作了 3.4 秒，运行 2 条命令，成功');
    expect(textOf(trigger(h.value))).toContain('工作了 3.4 秒');
  });

  it('says when the user stopped the turn and marks a failed call', () => {
    const work = [call('a', { ok: false })];
    const cancelled = view(work, { end: { state: 'cancelled', error: null } });
    expect(trigger(row(cancelled, work).value).props['aria-label']).toBe(
      '你在 3.4 秒 后停止，运行 1 条命令，失败',
    );
    const untimed = view(work, { started_at: null, end: { state: 'cancelled', error: null } });
    expect(trigger(row(untimed, work).value).props['aria-label']).toBe(
      '你停止了，运行 1 条命令，失败',
    );
    expect(trigger(row(view(work, { ended_at: null }), work).value).props['aria-label']).toBe(
      '工作了，运行 1 条命令，失败',
    );
  });

  it('keeps a call in place and its group open as it was left when a second call joins it', () => {
    const shown = (items: TranscriptItem[]) =>
      Items({ items, verbose: false, ended: false, folders: [], sessionId: 'session-a' }) as any[];
    const where = (tree: any, id: string): unknown[] | null => {
      if (Array.isArray(tree)) {
        for (const [i, child] of tree.entries()) {
          const at = where(child, id);
          if (at) return [i, ...at];
        }
        return null;
      }
      if (!tree || typeof tree !== 'object' || !('props' in tree)) return null;
      if (tree.props.item?.id === id) return [tree.type, tree.key];
      const at = where(tree.props.children, id);
      return at && [tree.type, tree.key, ...at];
    };
    const lone = shown([call('a', { ok: undefined })])[0];
    const grown = shown([call('a', { ok: undefined }), call('b', { ok: undefined })])[0];
    expect([grown.type, grown.key]).toEqual([lone.type, lone.key]);
    let run = lone;
    const h = mount(() => run.type(run.props));
    const before = where(h.value, 'a');
    nodes(h.value)
      .find((n) => n.props.item?.id === 'a')!
      .props.onOpenChange(true);
    h.render();
    run = grown;
    h.render();
    expect(where(h.value, 'a')).toEqual(before);
    expect(nodes(h.value)[0]!.props.open).toBe(true);
  });

  it('marks a turn that failed after its calls succeeded as failed', () => {
    const work = [call('a')];
    const h = row(view(work, { end: { state: 'failed', error: 'runtime exited' } }), work);
    expect(trigger(h.value).props['aria-label']).toBe('工作了 3.4 秒，运行 1 条命令，失败');
    expect(nodes(h.value).find((n) => n.type === StateMark)!.props.state).toBe('failed');
  });

  it('marks a finished turn with a call that got no result as without result', () => {
    const work = [call('a'), call('b', { ok: undefined })];
    const h = row(view(work), work);
    expect(trigger(h.value).props['aria-label']).toBe('工作了 3.4 秒，运行 2 条命令，无结果');
    expect(nodes(h.value).find((n) => n.type === StateMark)!.props.state).toBe('none');
  });
});
