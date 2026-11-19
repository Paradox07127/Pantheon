import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, ImprovementSession, LearnedItem } from '@pantheon/protocol';
import {
  HookHost,
  deferred,
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
import { MenuItem } from '@/components/Menu';
import { useBoard } from '@/data/board';
import { useShell } from '@/store';
import { LearnedDetail, type LearnedDetailProps } from '@/screens/memory/LearnedDetail';
import { zh } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown> };

const bridge = {
  sessions: [] as ImprovementSession[] | null,
  queries: [] as { method: string; params: Record<string, string> }[],
  commands: [] as Command[],
  answer: null as Promise<BridgeResult<unknown>> | null,
  async query(method: string, params: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    if (method === 'improvement.sessions' && bridge.sessions)
      return { ok: true, value: bridge.sessions };
    if (method === 'session.list')
      return { ok: true, value: [{ id: 'w1', state: 'running', runtime: 'codex' }] };
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.answer ?? { ok: true, value: {} };
  },
};

const hour = 3_600_000;
// Noon today, so an hour either side is still today whenever the test runs.
const noon = new Date().setHours(12, 0, 0, 0);

const decide = (...decisions: string[]) =>
  decisions.map((decision) => ({ command: 'improvement.decide', decision }));

const improvement = (extra: Partial<LearnedItem> = {}): LearnedItem => ({
  kind: 'experience',
  id: 'imp-1',
  title: 'Run `pnpm test:integration webhook` before the gate.',
  grade: 'trial',
  status: 'candidate',
  group: 'needs_you',
  diff: {
    from: '',
    to: 'Run `pnpm test:integration webhook` before the gate.\nOnly docs or type definitions changed',
  },
  evidence: [
    { kind: 'retrospective', id: 'r1' },
    { kind: 'retrospective', id: 'r2' },
  ],
  actions: decide('confirm', 'reject'),
  at: noon - 2 * hour,
  ...extra,
});

const policyTrial = (extra: Partial<LearnedItem> = {}) =>
  improvement({
    id: 'imp-2',
    kind: 'policy_change',
    title: 'max_parallel',
    status: 'trial',
    group: 'on_trial',
    diff: { from: '3', to: '4' },
    n: 3,
    tasks_required: 5,
    actions: decide('revert', 'pin'),
    ...extra,
  });

const experienceTrial = (extra: Partial<LearnedItem> = {}) =>
  improvement({
    status: 'trial',
    group: 'on_trial',
    n: 3,
    tasks_required: 5,
    actions: decide('revert'),
    ...extra,
  });

async function mount(props: Partial<LearnedDetailProps> = {}) {
  const h = mountHost(() =>
    LearnedDetail({
      projectId: 'pay',
      item: improvement(),
      onClose: () => {},
      onOpenRetro: () => {},
      ...props,
    }),
  );
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const all = (h: HookHost<any>) => text(tree(h));
const button = (t: ReactNode, label: string) =>
  find(t, (n) => n.type === 'button' && text(n.props.children) === label);
const byClass = (t: ReactNode, name: string) =>
  nodes(t).filter((n) =>
    String(n.props.className ?? '')
      .split(' ')
      .includes(name),
  );
const rejectMenu = (t: ReactNode) => named(t, 'Menu');
const rejectItems = (t: ReactNode) =>
  nodes(rejectMenu(t).props.children).filter((n) => n.type === MenuItem);
const actionLabels = (t: ReactNode) =>
  byClass(t, 'mld-acts').flatMap((n) =>
    nodes(n.props.children)
      .map((b) =>
        b.type === 'button'
          ? b
          : typeof b.type === 'function' && b.type.name === 'Menu'
            ? b.props.trigger
            : null,
      )
      .filter(Boolean)
      .map((b) => text(b.props.children)),
  );

const sessionQueries = () => bridge.queries.filter((q) => q.method === 'improvement.sessions');

beforeEach(() => {
  bridge.commands = [];
  bridge.queries = [];
  bridge.sessions = [];
  bridge.answer = null;
  vi.stubGlobal('window', {
    pantheon: bridge,
    addEventListener() {},
    removeEventListener() {},
  });
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

describe('learned change detail', () => {
  it('heads the panel with the group, when it was proposed and a close button', async () => {
    const onClose = vi.fn();
    const h = await mount({ onClose });
    const head = byClass(tree(h), 'mld-head')[0]!;
    expect(text(head)).toMatch(/^需要你\d\d:\d\d 提出/);
    find(
      tree(h),
      (n) => n.props['aria-label'] === zh('memory.learnedDetail.close'),
    ).props.onClick();
    expect(onClose).toHaveBeenCalled();
    expect(find(tree(h), (n) => n.type === 'aside').props['aria-label']).toBe(
      zh('memory.learnedDetail.label'),
    );
  });

  it('confirms with a busy button, then shows the failure above the buttons', async () => {
    const answer = deferred<BridgeResult<unknown>>();
    bridge.answer = answer.promise;
    const h = await mount();
    expect(actionLabels(tree(h))).toEqual([
      zh('memory.learnedDetail.confirm'),
      zh('memory.learnedDetail.reject'),
    ]);
    button(tree(h), zh('memory.learnedDetail.confirm')).props.onClick();
    await h.flush();
    expect(bridge.commands).toEqual([
      expect.objectContaining({
        type: 'improvement.decide',
        input: { project_id: 'pay', improvement_id: 'imp-1', decision: 'confirm' },
      }),
    ]);
    const busy = button(tree(h), zh('memory.learnedDetail.confirm'));
    expect(busy.props['aria-busy']).toBe(true);
    expect(busy.props.className).toContain('btn-busy');
    expect(rejectMenu(tree(h)).props.trigger.props['aria-disabled']).toBe(true);
    rejectItems(tree(h))[0]!.props.onClick();
    await h.flush();
    expect(bridge.commands).toHaveLength(1);

    answer.resolve({ ok: false, error: { code: 'daemon_down', message: 'no answer' } });
    await h.flush();
    const foot = byClass(tree(h), 'mld-foot')[0]!;
    const children = nodes(foot.props.children);
    const alert = children.find((n) => n.props.role === 'alert')!;
    expect(text(alert)).toMatch(/^没能确认：/);
    expect(children.indexOf(alert)).toBeLessThan(children.findIndex((n) => n.type === 'button'));
    expect(button(tree(h), zh('memory.learnedDetail.confirm')).props['aria-busy']).toBeUndefined();
  });

  it('reverts or pins a policy on trial', async () => {
    const h = await mount({ item: policyTrial() });
    expect(actionLabels(tree(h))).toEqual([
      zh('memory.learnedDetail.revert'),
      zh('memory.learnedDetail.pin'),
    ]);
    button(tree(h), zh('memory.learnedDetail.pin')).props.onClick();
    await h.flush();
    expect(bridge.commands.map((c) => c.input.decision)).toEqual(['pin']);
  });

  it('offers only a revert for an experience in force and no action once it ended', async () => {
    const active = await mount({
      item: improvement({ status: 'active', group: 'in_force', actions: decide('revert') }),
    });
    expect(text(byClass(tree(active), 'mld-head')[0]!)).toMatch(/^生效中\d\d:\d\d 提出/);
    expect(actionLabels(tree(active))).toEqual([zh('memory.learnedDetail.revert')]);
    for (const status of ['reverted', 'rejected'] as const) {
      const ended = await mount({ item: improvement({ status, group: 'reverted', actions: [] }) });
      expect(byClass(tree(ended), 'mld-foot')).toEqual([]);
      expect(byClass(tree(ended), 'mld-ev')).toHaveLength(2);
    }
  });

  it.each<[string, LearnedItem, string[]]>([
    [
      'the root of a gate change',
      improvement({ kind: 'gate_command', title: '/repo/app', scope: { root: '/repo/app' } }),
      ['/repo/app'],
    ],
    ['the tier of a policy change', policyTrial({ scope: { tier: 't2' } }), ['T2']],
    [
      'the runtime, domain and tier of an experience',
      improvement({ scope: { runtime: 'codex', domain: 'frontend-ui', tier: 't1' } }),
      ['Codex', '前端界面', 'T1'],
    ],
  ])('shows %s above the change', async (_, item, values) => {
    const h = await mount({ item });
    const parts = ([] as ReactNode[])
      .concat(find(tree(h), (n) => n.type === 'aside').props.children)
      .filter((n): n is ReactElement<any> => !!n && typeof n === 'object' && 'props' in n);
    const scope = parts.findIndex((n) => values.every((v) => text(n).includes(v)));
    expect(scope).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(parts.findIndex((n) => n.type === 'ul'));
    expect(parts[scope]!.props['aria-label']).toBe(zh('memory.learnedDetail.scope'));
  });

  it('lists the sessions an experience on trial goes to and opens one', async () => {
    const openSession = vi.fn();
    const before = useShell.getState().openSession;
    useShell.setState({ openSession });
    bridge.sessions = [
      { session_id: 'w1', title: 'Replay protection', delivered: true },
      { session_id: 'w2abcdef99', delivered: false },
    ];
    try {
      const h = await mount({ item: experienceTrial() });
      expect(sessionQueries()).toEqual([
        { method: 'improvement.sessions', params: { project_id: 'pay', improvement_id: 'imp-1' } },
      ]);
      const used = byClass(tree(h), 'mld-sec').find((n) =>
        text(n).startsWith(zh('memory.learnedDetail.usedIn')),
      )!;
      expect(text(byClass(used, 'mld-eh')[0]!)).toBe('用在这些会话2');
      const rows = byClass(used, 'mld-rr');
      expect(rows.map((r) => text(r))).toEqual([
        'Replay protection已带上',
        '会话 w2abcdef下一轮带上',
      ]);
      expect(named(rows[0]!, 'SessionStateIcon').props.session.id).toBe('w1');
      rows[1]!.props.onClick();
      expect(openSession).toHaveBeenCalledWith('w2abcdef99');
    } finally {
      useShell.setState({ openSession: before });
    }
  });

  it('reads the sessions only for an experience on trial or in force', async () => {
    await mount({ item: improvement() });
    await mount({ item: policyTrial() });
    expect(sessionQueries()).toEqual([]);
    await mount({ item: improvement({ status: 'active', group: 'in_force' }) });
    expect(sessionQueries()).toHaveLength(1);
  });

  it('shows no sessions block for an empty list and an alert when the read fails', async () => {
    const empty = await mount({ item: experienceTrial({ id: 'imp-empty' }) });
    expect(all(empty)).not.toContain(zh('memory.learnedDetail.usedIn'));
    bridge.sessions = null;
    const failed = await mount({ item: experienceTrial({ id: 'imp-failed' }) });
    const used = byClass(tree(failed), 'mld-sec').find((n) =>
      text(n).startsWith(zh('memory.learnedDetail.usedIn')),
    )!;
    expect(text(find(used, (n) => n.props.role === 'alert'))).toMatch(/^读不到会话：/);
  });

  it('rejects a candidate with the reason picked from the menu, or with none', async () => {
    const h = await mount();
    const menu = rejectMenu(tree(h));
    expect(menu.props.label).toBe(zh('memory.learnedDetail.rejectMenu'));
    const items = rejectItems(tree(h));
    expect(items.map((n) => text(n))).toEqual([
      zh('memory.learnedDetail.rejectDuplicate'),
      zh('memory.learnedDetail.rejectNotUseful'),
      zh('memory.learnedDetail.rejectNoReason'),
    ]);
    for (const i of [0, 1, 2]) {
      rejectItems(tree(h))[i]!.props.onClick();
      await h.flush();
    }
    expect(bridge.commands.map((c) => c.input)).toEqual([
      {
        project_id: 'pay',
        improvement_id: 'imp-1',
        decision: 'reject',
        reject_reason: 'duplicate',
      },
      {
        project_id: 'pay',
        improvement_id: 'imp-1',
        decision: 'reject',
        reject_reason: 'not_useful',
      },
      { project_id: 'pay', improvement_id: 'imp-1', decision: 'reject' },
    ]);
  });
});
