import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel, PlanReplayFrame } from '@pantheon/protocol';
import { deferred, find, mount, nodes, text, unmountAll, type HookHost } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'replay-id' }),
);
import { usePlanReplay } from '@/data/plan-replay';
import { listText } from '@/lib/list-text';
import { dayText } from '@/lib/time-text';
import { PlanReplay, ReplaySwitch } from '@/screens/board/PlanReplay';
import { zh, zhf } from './i18n-setup.js';

type Status = PlanReplayFrame['tasks'][number]['status'];
const MIN = 60_000;
const NOW = new Date(2026, 10, 19, 12, 0).getTime();
const T0 = NOW - 3 * 24 * 60 * MIN;
const END = String(Number.MAX_SAFE_INTEGER);

const tasks = (api: Status, web: Status): PlanReplayFrame['tasks'] => [
  { id: 'api', title: 'Refund API', lane: 'backend', depends_on: [], status: api },
  { id: 'web', title: 'Refund list', lane: 'web', depends_on: ['api'], status: web },
];
const frame = (sequence: number, over: Partial<PlanReplayFrame> = {}): PlanReplayFrame => ({
  sequence,
  at: T0 + sequence * MIN,
  kind: 'task.dispatched',
  task_id: 'api',
  tasks: tasks('dispatched', 'planned'),
  ...over,
});
const range = (count: number) => Array.from({ length: count }, (_, i) => frame(i + 1));

const lead = (session_id: string, title: string) => ({ session_id, title, updated_at: 1 });
const board = (leads = [lead('lead-1', 'Payments lead')]) =>
  ({
    now: NOW,
    lanes: [{ id: 'lead-1:backend', title: 'Backend' }],
    leads,
  }) as unknown as BoardModel;

/** Answers plan replay reads as the daemon pages them; `hold` keeps a read out until released. */
function daemon(
  frames: PlanReplayFrame[],
  options: {
    hold?: (params: Record<string, string>) => boolean;
    fail?: (params: Record<string, string>) => boolean;
  } = {},
) {
  const held: { resolve: () => void }[] = [];
  const query = vi.fn(async (_method: string, params: Record<string, string>) => {
    if (options.fail?.(params))
      return { ok: false, error: { code: 'ipc_failed', message: 'socket closed' } };
    if (options.hold?.(params)) {
      const wait = deferred<void>();
      held.push({ resolve: () => wait.resolve() });
      await wait.promise;
    }
    const limit = Number(params.limit);
    const page =
      params.before !== undefined
        ? frames.filter((f) => f.sequence < Number(params.before)).slice(-limit)
        : frames.filter((f) => f.sequence > Number(params.after ?? 0)).slice(0, limit);
    const last = page.at(-1);
    return {
      ok: true,
      value: {
        frames: page,
        next_after: last && last !== frames.at(-1) ? last.sequence : null,
        total: frames.length,
        last_at: frames.at(-1)?.at ?? null,
      },
    };
  });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: { query },
  });
  return { query, held, asked: () => query.mock.calls.map(([, params]) => params) };
}

const settle = async <T>(h: HookHost<T>) => {
  for (let i = 0; i < 6; i++) await h.flush();
  return h.value;
};
const slider = (tree: ReactNode) => find(tree, (n) => n.props.role === 'slider');
const named = (tree: ReactNode, name: string) => find(tree, (n) => n.props['aria-label'] === name);
const items = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.props.role === 'listitem')
    .map((n) => n.props['aria-label']);
const node = (title: string, status: Status) =>
  zhf('board.replay.node', { title, status: zh(`board.replay.status.${status}`) });
const key = (target: ReactElement<any>, name: string) =>
  target.props.onKeyDown({ key: name, preventDefault: vi.fn() });
const eventRows = (tree: ReactNode) =>
  nodes(find(tree, (n) => n.type === 'ol')).filter((n) => n.type === 'button');

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('plan replay read', () => {
  it('reads the last page and the first frame, then earlier pages before the loaded ones', async () => {
    const { asked } = daemon(range(650));
    const h = mount(() => usePlanReplay('lead-1'));
    const read = await settle(h);
    expect(asked()).toEqual([
      { lead_session_id: 'lead-1', before: END, limit: '100' },
      { lead_session_id: 'lead-1', after: '0', limit: '1' },
      { lead_session_id: 'lead-1', before: '551', limit: '500' },
      { lead_session_id: 'lead-1', before: '51', limit: '500' },
    ]);
    expect(read.frames.map((f) => f.sequence)).toEqual(range(650).map((f) => f.sequence));
    expect(read.total).toBe(650);
    expect(read.firstAt).toBe(frame(1).at);
    expect(read.loadingEarlier).toBe(false);
  });

  it('stops loading by itself after 2000 frames and loads one page per request after that', async () => {
    daemon(range(2700));
    const h = mount(() => usePlanReplay('lead-1'));
    let read = await settle(h);
    expect(read.frames).toHaveLength(2100);
    expect(read.held).toBe(true);
    read.loadEarlier();
    h.render();
    read = await settle(h);
    expect(read.frames).toHaveLength(2600);
    read.loadEarlier();
    h.render();
    read = await settle(h);
    expect(read.frames).toHaveLength(2700);
    expect(read.held).toBe(false);
  });

  it('keeps the loaded frames when an earlier page fails and repeats that read on Retry', async () => {
    let down = true;
    const { asked } = daemon(range(300), { fail: (p) => down && p.before === '201' });
    const h = mount(() => usePlanReplay('lead-1'));
    let read = await settle(h);
    expect(read.frames).toHaveLength(100);
    expect(read.earlierError?.before.sequence).toBe(201);
    down = false;
    read.retry();
    h.render();
    read = await settle(h);
    expect(asked().filter((p) => p.before === '201')).toHaveLength(2);
    expect(read.frames).toHaveLength(300);
    expect(read.earlierError).toBeNull();
  });
});

describe('plan replay', () => {
  const story = [
    frame(1, {
      kind: 'board.plan_updated',
      text: 'Refunds v1',
      task_id: undefined,
      tasks: tasks('planned', 'planned'),
    }),
    frame(2),
    frame(3, { kind: 'board.replan_triggered', text: 'api stalled', task_id: undefined }),
    frame(4, { kind: 'board.plan_updated', replan: true, text: 'Refunds v2', task_id: undefined }),
    frame(5, { kind: 'session.merged', tasks: tasks('merged', 'planned') }),
  ];
  const open = async (model = board(), onClose = vi.fn()) => {
    const h = mount(() => PlanReplay({ model, onClose }));
    await settle(h);
    return h;
  };

  it('opens on the newest event with the tasks as they stood then', async () => {
    daemon(story);
    const h = await open();
    const s = slider(h.value);
    expect(s.props['aria-label']).toBe(zh('board.replay.slider'));
    expect([s.props['aria-valuemin'], s.props['aria-valuenow'], s.props['aria-valuemax']]).toEqual([
      1, 5, 5,
    ]);
    expect(items(h.value)).toEqual([node('Refund API', 'merged'), node('Refund list', 'planned')]);
    expect(find(h.value, (n) => n.props.role === 'list').props['aria-label']).toBe(
      zhf('board.replay.chart', {
        time: dayText(frame(5).at, NOW, { time: true }),
        count: 2,
        states: listText(
          zhf('board.replay.count.merged', { count: 1 }),
          zhf('board.replay.count.planned', { count: 1 }),
        ),
      }),
    );
  });

  it('steps one event with the arrows, ten with the page keys, and to the ends with Home and End', async () => {
    daemon(story);
    const h = await open();
    key(slider(h.value), 'ArrowLeft');
    h.render();
    expect(slider(h.value).props['aria-valuenow']).toBe(4);
    expect(items(h.value)).toEqual([
      node('Refund API', 'dispatched'),
      node('Refund list', 'planned'),
    ]);
    key(slider(h.value), 'Home');
    h.render();
    expect(slider(h.value).props['aria-valuenow']).toBe(1);
    expect(items(h.value)).toEqual([node('Refund API', 'planned'), node('Refund list', 'planned')]);
    expect(named(h.value, zh('board.replay.previous')).props.disabled).toBe(true);
    key(slider(h.value), 'PageUp');
    h.render();
    expect(slider(h.value).props['aria-valuenow']).toBe(5);
    key(slider(h.value), 'PageDown');
    h.render();
    expect(slider(h.value).props['aria-valuenow']).toBe(1);
    key(slider(h.value), 'End');
    h.render();
    expect(slider(h.value).props['aria-valuenow']).toBe(5);
    expect(named(h.value, zh('board.replay.next')).props.disabled).toBe(true);
    named(h.value, zh('board.replay.previous')).props.onClick();
    h.render();
    expect(slider(h.value).props['aria-valuenow']).toBe(4);
  });

  it('marks a re-plan and a plan update on the track', async () => {
    daemon(story);
    const h = await open();
    const marks = nodes(slider(h.value)).map((n) => n.props['data-mark']);
    expect(marks.filter((m) => m === 'replan')).toHaveLength(2);
    expect(marks.filter((m) => m === 'plan')).toHaveLength(1);
  });

  it('lists the events up to the playhead, newest first, and a row moves the playhead to it', async () => {
    daemon(story);
    const h = await open();
    const section = find(h.value, (n) => n.type === 'section' && !!n.props['aria-labelledby']);
    const head = find(section, (n) => n.props.id === section.props['aria-labelledby']);
    expect(text(head)).toBe(zh('board.replay.events'));
    let rows = eventRows(h.value);
    expect(rows.map((r) => r.props['aria-current'])).toEqual([
      true,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(text(rows[0])).toContain(zh('board.replay.kind.merged'));
    expect(text(rows[1])).toContain(zh('board.replay.kind.replanned'));
    rows[2]!.props.onClick();
    h.render();
    expect(slider(h.value).props['aria-valuenow']).toBe(3);
    rows = eventRows(h.value);
    expect(rows).toHaveLength(3);
    expect(text(rows[0])).toContain('api stalled');
  });

  it('keeps every drawn position while an earlier page lands, with the gap dashed until then', async () => {
    const { held } = daemon(range(600), { hold: (p) => p.before === '501' });
    const h = await open();
    let s = slider(h.value);
    expect([s.props['aria-valuemin'], s.props['aria-valuenow'], s.props['aria-valuemax']]).toEqual([
      501, 600, 600,
    ]);
    expect(s.props['aria-busy']).toBe(true);
    expect(nodes(s).some((n) => n.props['data-unloaded'] !== undefined)).toBe(true);
    expect(named(h.value, zh('board.replay.loadingEarlier')).props.role).toBe('img');
    const lefts = (tree: ReactNode) =>
      new Map(
        nodes(slider(tree))
          .filter((n) => n.key !== null)
          .map((n) => [n.key, n.props.style.left]),
      );
    const before = lefts(h.value);
    held[0]!.resolve();
    await settle(h);
    s = slider(h.value);
    expect(s.props['aria-valuemin']).toBe(1);
    expect(s.props['aria-valuenow']).toBe(600);
    expect(s.props['aria-busy']).toBeUndefined();
    expect(nodes(s).some((n) => n.props['data-unloaded'] !== undefined)).toBe(false);
    const after = lefts(h.value);
    expect([...before].every(([k, left]) => after.get(k) === left)).toBe(true);
  });

  it('shows a failed first read in the chart place with Retry, and an empty plan as such', async () => {
    let down = true;
    daemon(story, { fail: () => down });
    const h = await open();
    const alert = find(h.value, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain('socket closed');
    down = false;
    find(alert, (n) => n.type === 'button').props.onClick();
    h.render();
    await settle(h);
    expect(slider(h.value).props['aria-valuenow']).toBe(5);

    daemon([]);
    const none = await open();
    expect(text(none.value)).toContain(zh('board.replay.empty'));
    expect(slider(none.value).props['aria-disabled']).toBe(true);
  });

  it('picks the plan by lead and reads that lead from its last page', async () => {
    const { asked } = daemon(story);
    const h = await open(board([lead('lead-1', 'Payments lead'), lead('lead-2', 'Ledger lead')]));
    const picker = named(h.value, zhf('board.replay.plan', { title: 'Payments lead' }));
    picker.props.onChange('lead-2');
    h.render();
    await settle(h);
    expect(asked().filter((p) => p.lead_session_id === 'lead-2')[0]).toEqual({
      lead_session_id: 'lead-2',
      before: END,
      limit: '100',
    });
    expect(named(h.value, zhf('board.replay.plan', { title: 'Ledger lead' }))).toBeTruthy();
  });

  it('leaves on Escape', async () => {
    daemon(story);
    const onClose = vi.fn();
    const h = await open(board(), onClose);
    h.value.props.onKeyDown({
      key: 'Escape',
      target: {},
      currentTarget: { contains: () => true },
      preventDefault: vi.fn(),
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('replay toggle', () => {
  const bar = { nodeType: 1 } as unknown as HTMLElement;
  // The toggle is portaled into the board bar.
  const toggle = (tree: ReactElement<any>) =>
    find(
      (tree.props.children as unknown[]).flatMap((c) =>
        c && typeof c === 'object' && 'containerInfo' in c
          ? [(c as unknown as { children: ReactNode }).children]
          : [],
      ),
      (n) => n.type === 'button',
    );

  it('shows the replay in place of the history while it is pressed', () => {
    const h = mount(() => ReplaySwitch({ model: board(), bar, children: 'history' }));
    expect(toggle(h.value).props['aria-label']).toBe(zh('board.replay.toggle'));
    expect(toggle(h.value).props['aria-pressed']).toBe(false);
    expect(h.value.props.children[1]).toBe('history');
    toggle(h.value).props.onClick();
    h.render();
    expect(toggle(h.value).props['aria-pressed']).toBe(true);
    expect((h.value.props.children[1] as ReactElement).type).toBe(PlanReplay);
    (h.value.props.children[1] as ReactElement<any>).props.onClose();
    h.render();
    expect(h.value.props.children[1]).toBe('history');
  });

  it('cannot be pressed without a lead plan', () => {
    const h = mount(() => ReplaySwitch({ model: board([]), bar, children: 'history' }));
    expect(toggle(h.value).props['aria-disabled']).toBe(true);
    toggle(h.value).props.onClick();
    h.render();
    expect(h.value.props.children[1]).toBe('history');
  });
});
