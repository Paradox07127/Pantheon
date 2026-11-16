import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Improvement, WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import {
  HookHost,
  find,
  named,
  nodes,
  text,
  unmountAll,
  mount as mountHost,
} from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { LearnedPage } from '@/screens/memory/LearnedPage';
import { zh } from './i18n-setup.js';

const item = (over: Partial<Improvement> & { id: string }): Improvement => ({
  revision: 1,
  project_id: 'pay',
  source: 'daemon',
  retrospective_ids: ['r1'],
  status: 'candidate',
  change: { type: 'experience', procedure: `rule ${over.id}` },
  proposed_at: 1,
  ...over,
});

const policy: WorkflowPolicy = {
  id: 'pay',
  revision: 2,
  project_id: 'pay',
  policy_version: 2,
  improvement_mode: 'confirm',
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'each_merge',
  max_parallel: 3,
  max_parallel_limit: 4,
  handback_limit: 3,
  budget: {},
  pinned: ['max_parallel'],
  runtime_parallel: {},
  dispatch_paused: false,
} as WorkflowPolicy;

const bridge = {
  items: [] as Improvement[],
  fail: null as string | null,
  reads: 0,
  async query(method: string): Promise<BridgeResult<unknown>> {
    if (method === 'improvement.list') {
      bridge.reads++;
      return bridge.fail
        ? { ok: false, error: { code: 'daemon_down', message: bridge.fail } }
        : { ok: true, value: bridge.items };
    }
    if (method === 'workflow.policy') return { ok: true, value: policy };
    if (method === 'retrospective.list') return { ok: true, value: [] };
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(): Promise<BridgeResult<unknown>> {
    return { ok: true, value: {} };
  },
};

async function mount(onOpenRetros = () => {}) {
  const h = mountHost(() => LearnedPage({ projectId: 'pay', onOpenRetros }));
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const list = (h: HookHost<any>) => named(tree(h), 'LearnedList');
const details = (h: HookHost<any>) =>
  nodes(tree(h)).filter((n) => typeof n.type === 'function' && n.type.name === 'LearnedDetail');
const alerts = (h: HookHost<any>) => nodes(tree(h)).filter((n) => n.props.role === 'alert');
const button = (t: ReactNode, label: string) =>
  find(t, (n) => n.type === 'button' && text(n.props.children) === label);
const moveBoard = async (h: HookHost<any>) => {
  useBoard.setState((s) => ({
    board: { ...s.board!, cursor: s.board!.cursor + 1 },
    changed: s.changed + 1,
  }));
  h.render();
  await h.flush();
};

beforeEach(() => {
  bridge.items = [
    item({ id: 'a1', status: 'active' }),
    item({ id: 't1', status: 'trial' }),
    item({ id: 'c1' }),
    item({ id: 'c2' }),
  ];
  bridge.fail = null;
  bridge.reads = 0;
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('learned rules page', () => {
  it('opens on the first rule of the list, beside its details', async () => {
    const h = await mount();
    expect(list(h).props.selected).toBe('c1');
    expect(list(h).props.pinned).toEqual(['max_parallel']);
    expect(details(h).map((d) => d.props.item.id)).toEqual(['c1']);
  });

  it('shows the details of the row picked and folds them away on close', async () => {
    const h = await mount();
    list(h).props.onSelect('t1');
    h.render();
    expect(list(h).props.selected).toBe('t1');
    expect(details(h)[0]!.props.item.id).toBe('t1');
    details(h)[0]!.props.onClose();
    h.render();
    expect(list(h).props.selected).toBeNull();
    expect(details(h)).toEqual([]);
  });

  it('falls back to the first rule when the one picked leaves the list', async () => {
    const h = await mount();
    list(h).props.onSelect('t1');
    h.render();
    bridge.items = bridge.items.filter((i) => i.id !== 't1');
    await moveBoard(h);
    expect(list(h).props.selected).toBe('c1');
    expect(details(h)[0]!.props.item.id).toBe('c1');
  });

  it('moves the selection with the arrow keys across the groups', async () => {
    const h = await mount();
    const row = () => ({ focus: vi.fn(), click: vi.fn() });
    const rows = [row(), row(), row()];
    const keys = find(tree(h), (n) => typeof n.props.onKeyDown === 'function');
    const press = (key: string, target: unknown) => {
      const event = {
        key,
        target,
        currentTarget: { querySelectorAll: () => rows },
        preventDefault: vi.fn(),
      };
      keys.props.onKeyDown(event);
      return event;
    };
    expect(press('ArrowDown', rows[1]).preventDefault).toHaveBeenCalled();
    expect(rows[2]!.focus).toHaveBeenCalled();
    expect(rows[2]!.click).toHaveBeenCalled();
    press('ArrowUp', rows[1]);
    expect(rows[0]!.click).toHaveBeenCalled();
    expect(press('ArrowDown', rows[2]).preventDefault).not.toHaveBeenCalled();
    expect(press('ArrowDown', {}).preventDefault).not.toHaveBeenCalled();
  });

  it('sends the evidence rows of the details to the retrospectives', async () => {
    const onOpenRetros = vi.fn();
    const h = await mount(onOpenRetros);
    details(h)[0]!.props.onOpenRetro('r1');
    expect(onOpenRetros).toHaveBeenCalledWith('r1');
  });

  it('holds the list as a busy skeleton until the first read lands', async () => {
    const query = bridge.query;
    const pending = new Promise<BridgeResult<unknown>>(() => {});
    bridge.query = (method: string) =>
      method === 'improvement.list' ? pending : query.call(bridge, method);
    // A resync drops the reads earlier mounts cached, so no list was ever read.
    useBoard.setState((s) => ({ resync: s.resync + 1 }));
    try {
      const h = await mount();
      expect(() => list(h)).toThrow();
      expect(details(h)).toEqual([]);
      const busy = find(tree(h), (n) => n.props['aria-busy'] === 'true');
      expect(busy.props['aria-label']).toBe(zh('memory.learned.label'));
    } finally {
      bridge.query = query;
    }
  });

  it('says the list could not be read and reads it again on retry', async () => {
    bridge.fail = 'no answer';
    // A resync drops the reads earlier mounts cached, so no list was ever read.
    useBoard.setState((s) => ({ resync: s.resync + 1 }));
    const h = await mount();
    const [alert] = alerts(h);
    expect(text(alert)).toMatch(/^读不到经验列表：.*no answer/);
    expect(details(h)).toEqual([]);
    const reads = bridge.reads;
    button(alert, zh('memory.learnedPage.retry')).props.onClick();
    h.render();
    await h.flush();
    expect(bridge.reads).toBe(reads + 1);
  });

  it('keeps the list it read when a later read fails', async () => {
    const h = await mount();
    bridge.fail = 'no answer';
    await moveBoard(h);
    expect(list(h).props.items).toHaveLength(4);
    expect(text(alerts(h)[0])).toMatch(/^读不到经验列表：/);
  });

  it('points an empty project to the retrospectives', async () => {
    bridge.items = [];
    const onOpenRetros = vi.fn();
    const h = await mount(onOpenRetros);
    expect(() => list(h)).toThrow();
    const empty = named(tree(h), 'EmptyState');
    expect(empty.props.title).toBe(zh('memory.learnedPage.empty'));
    expect(text(tree(h))).toContain(zh('memory.learnedPage.searchHint'));
    expect(empty.props.action.label).toBe(zh('memory.learnedPage.openRetros'));
    empty.props.action.onClick();
    expect(onOpenRetros).toHaveBeenCalled();
  });
});
