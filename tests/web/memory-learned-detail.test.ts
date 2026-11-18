import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Retrospective } from '@pantheon/domain';
import type { BridgeResult, ImprovementListItem, ImprovementSession } from '@pantheon/protocol';
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
  retrospectives: [] as Retrospective[],
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
    return method === 'retrospective.list'
      ? { ok: true, value: bridge.retrospectives }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.answer ?? { ok: true, value: {} };
  },
};

const hour = 3_600_000;
// Noon today, so an hour either side is still today whenever the test runs.
const noon = new Date().setHours(12, 0, 0, 0);

const retro = (id: string, extra: Partial<Retrospective> = {}): Retrospective => ({
  id,
  revision: 1,
  project_id: 'pay',
  lead_session_id: 'lead-1',
  task_id: `task-${id}`,
  session_ids: [],
  outcome: 'merged',
  recorded_at: noon - hour,
  ...extra,
});

const improvement = (extra: Partial<ImprovementListItem> = {}): ImprovementListItem => ({
  id: 'imp-1',
  revision: 1,
  project_id: 'pay',
  lead_session_id: 'lead-1',
  source: 'lead',
  signal: 'repeat_gate_failure',
  retrospective_ids: ['r1', 'r2', 'r3'],
  status: 'candidate',
  grade: 'trial',
  change: {
    type: 'experience',
    domain: 'backend-logic',
    tier: 't2',
    runtime: 'codex',
    procedure: 'Run `pnpm test:integration webhook` before the gate',
    countercondition: 'Only docs or type definitions changed',
  },
  proposed_at: noon - 2 * hour,
  ...extra,
});

const policyTrial = (extra: Partial<ImprovementListItem> = {}) =>
  improvement({
    id: 'imp-2',
    source: 'daemon',
    lead_session_id: undefined,
    signal: 'queue_wait',
    retrospective_ids: ['q1', 'q2'],
    status: 'trial',
    status_reason: 'no_baseline',
    change: { type: 'policy_change', param: 'max_parallel', from: 3, to: 4 },
    trial_started_at: Date.now() - 30 * hour,
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
const buttons = (t: ReactNode) => nodes(t).filter((n) => n.type === 'button');
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

const trial = (
  extra: Partial<NonNullable<ImprovementListItem['trial']>> = {},
): NonNullable<ImprovementListItem['trial']> => ({
  tasks_seen: 3,
  tasks_required: 5,
  baseline_tasks: 3,
  metrics: [],
  ...extra,
});
const experienceTrial = (extra: Partial<ImprovementListItem> = {}) =>
  improvement({
    status: 'trial',
    trial_started_at: noon - 3 * 24 * hour,
    trial: trial(),
    ...extra,
  });
const sessionQueries = () => bridge.queries.filter((q) => q.method === 'improvement.sessions');

beforeEach(() => {
  bridge.retrospectives = [
    retro('r1', {
      task_id: 'replay',
      gate_passed_on_attempt: 3,
      gate_failed_checks: ['pnpm test:integration'],
    }),
    retro('r2', { gate_passed_on_attempt: 2, gate_failed_checks: ['pnpm test:integration'] }),
    retro('r3', {
      gate_passed_on_attempt: 2,
      gate_failed_checks: ['pnpm test:integration'],
      recorded_at: new Date(2024, 10, 11, 9, 0).getTime(),
    }),
    retro('q1', { task_id: 'replay', stage_ms: { dispatch_wait: 6 * 60_000 } }),
    retro('q2', { stage_ms: { dispatch_wait: 4.2 * 60_000 } }),
  ];
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
    board: {
      cursor: 1,
      projects: [],
      sessions: [
        { id: 'lead-1', runtime: 'claude' },
        {
          id: 'w1',
          runtime: 'codex',
          title: 'Replay protection',
          task: { id: 'replay', lead_session_id: 'lead-1' },
        },
      ],
    },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('learned improvement detail', () => {
  it('heads the panel with the status, when it was proposed and a close button', async () => {
    const onClose = vi.fn();
    const h = await mount({ onClose });
    const head = byClass(tree(h), 'mld-head')[0]!;
    expect(text(head)).toMatch(/^等你确认\d\d:\d\d 提出/);
    find(
      tree(h),
      (n) => n.props['aria-label'] === zh('memory.learnedDetail.close'),
    ).props.onClick();
    expect(onClose).toHaveBeenCalled();
    expect(find(tree(h), (n) => n.type === 'aside').props['aria-label']).toBe(
      zh('memory.learnedDetail.label'),
    );
  });

  it('sets the commands of a rule as inline code and shows when it does not apply', async () => {
    const h = await mount();
    expect(byClass(tree(h), 'mld-inl').map((n) => text(n))).toContain(
      'pnpm test:integration webhook',
    );
    expect(text(byClass(tree(h), 'mld-rule')[0]!)).toBe(
      'Run pnpm test:integration webhook before the gate',
    );
    expect(all(h)).toContain('不适用Only docs or type definitions changed');
  });

  it.each([
    [
      'lays out the scope of an experience as domain, tier and runtime cells',
      improvement(),
      ['领域后端逻辑', '档位T2', 'runtimeCodex'],
    ],
    [
      'says the whole scope when an experience names no domain, tier or runtime',
      improvement({ change: { type: 'experience', procedure: 'Read the state table' } }),
      ['范围全部任务'],
    ],
    [
      'heads a policy trial with the tasks it has seen of those it needs',
      policyTrial({ trial: trial({ tasks_seen: 2, status_reason: 'no_baseline' }) }),
      ['范围整个项目', '已试用2 天', '任务2 / 5'],
    ],
  ])('%s', async (_name, item, cells) => {
    const h = await mount({ item });
    expect(byClass(tree(h), 'mld-cell').map((n) => text(n))).toEqual(cells);
  });

  it('says which sessions the experience goes to', async () => {
    const h = await mount();
    expect(all(h)).toContain(
      '会注入给开始试用后，后端逻辑 T2 的 Codex 会话每轮发送前，上下文预算放得下时会带上这条，标为试用。',
    );
  });

  it('lists the retrospectives it rests on with task, gate attempt and date, and opens one', async () => {
    const onOpenRetro = vi.fn();
    const h = await mount({ onOpenRetro });
    const chips = byClass(tree(h), 'chip').map((n) => text(n));
    expect(chips).toEqual([
      zh('data.workflowPolicy.source.lead'),
      zh('data.workflowPolicy.signal.repeatGateFailure'),
    ]);
    const rows = byClass(tree(h), 'mld-rr');
    expect(rows.map((r) => text(r))).toEqual([
      expect.stringMatching(/^Replay protection第 3 次过门禁今天$/),
      expect.stringMatching(/^task-r2第 2 次过门禁今天$/),
      expect.stringMatching(/^task-r3第 2 次过门禁(11月11日|2024年11月11日)$/),
    ]);
    rows[1]!.props.onClick();
    expect(onOpenRetro).toHaveBeenCalledWith('r2');
    expect(text(byClass(tree(h), 'mld-check')[0]!)).toBe('3 次都先挂在pnpm test:integration');
  });

  it('names the signals over the last 7 days of events in the evidence chip', async () => {
    for (const [signal, label] of [
      ['always_approved_command', zh('data.workflowPolicy.signal.alwaysApprovedCommand')],
      ['late_gate_failure', zh('data.workflowPolicy.signal.lateGateFailure')],
    ] as const) {
      const h = await mount({ item: improvement({ signal }) });
      expect(byClass(tree(h), 'chip').map((n) => text(n))).toEqual([
        zh('data.workflowPolicy.source.lead'),
        label,
      ]);
    }
  });

  it('starts the trial with a busy button, then shows the failure above the buttons', async () => {
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
    expect(text(alert)).toMatch(/^没能开始试用：/);
    expect(children.indexOf(alert)).toBeLessThan(children.findIndex((n) => n.type === 'button'));
    expect(button(tree(h), zh('memory.learnedDetail.confirm')).props['aria-busy']).toBeUndefined();
  });

  it('heads a policy on trial with its start, scope, days tried and the missing baseline', async () => {
    const h = await mount({
      item: policyTrial({ trial: trial({ status_reason: 'no_baseline' }) }),
    });
    const out = all(h);
    expect(text(byClass(tree(h), 'mld-head')[0]!)).toMatch(/^试用中(昨天 \d\d:\d\d|.*) 开始/);
    expect(text(byClass(tree(h), 'mld-rule')[0]!)).toBe('并发上限从 3 改成 4');
    expect(byClass(tree(h), 'mld-mono').map((n) => text(n))).toEqual(['3', '4', '3 / 5']);
    expect(byClass(tree(h), 'mld-cell').map((n) => text(n))).toEqual([
      '范围整个项目',
      '已试用2 天',
      '任务3 / 5',
    ]);
    expect(out).toContain(zh('memory.learnedDetail.noBaseline'));
    expect(out).toContain('怎么生效改的是流程参数，不注入会话；派发新任务会话时按 4 个并发算。');
    expect(byClass(tree(h), 'chip').map((n) => text(n))).toEqual([
      zh('data.workflowPolicy.source.retrospective'),
      zh('data.workflowPolicy.signal.queueWait'),
    ]);
    expect(byClass(tree(h), 'mld-rr').map((r) => text(r))).toEqual([
      expect.stringMatching(/^Replay protection排队 6 分/),
      expect.stringMatching(/^task-q2排队 4 分/),
    ]);
    expect(byClass(tree(h), 'mld-check')).toEqual([]);
  });

  it('pins or reverts a policy on trial', async () => {
    const h = await mount({ item: policyTrial() });
    expect(actionLabels(tree(h))).toEqual([
      zh('memory.learnedDetail.pin'),
      zh('memory.learnedDetail.revert'),
    ]);
    button(tree(h), zh('memory.learnedDetail.pin')).props.onClick();
    await h.flush();
    expect(bridge.commands.map((c) => c.input.decision)).toEqual(['pin']);
  });

  it('offers only a revert for an experience in force and no action once it ended', async () => {
    const active = await mount({
      item: improvement({ status: 'active', decided_at: noon - hour }),
    });
    expect(text(byClass(tree(active), 'mld-head')[0]!)).toMatch(/^生效中\d\d:\d\d 生效/);
    expect(actionLabels(tree(active))).toEqual([zh('memory.learnedDetail.revert')]);
    for (const status of ['reverted', 'rejected'] as const) {
      const ended = await mount({ item: improvement({ status, decided_at: noon - hour }) });
      expect(byClass(tree(ended), 'mld-foot')).toEqual([]);
      expect(byClass(tree(ended), 'mld-cell')).toHaveLength(3);
      expect(byClass(tree(ended), 'mld-rr')).toHaveLength(3);
    }
  });

  it('shows how many of the trial tasks are done, the bar full once they are all in', async () => {
    const h = await mount({ item: experienceTrial() });
    const progress = byClass(tree(h), 'mld-sec').find((n) =>
      text(n).startsWith(zh('memory.learnedDetail.progress')),
    )!;
    expect(text(progress)).toBe('试用进度3 / 5个任务');
    const meter = byClass(progress, 'meter')[0]!;
    expect(meter.props.style['--v']).toBe('60%');
    expect(meter.props.role).toBe('img');
    expect(meter.props['aria-label']).toBe('试用进度：5 个任务里做完 3 个');
    const over = await mount({ item: experienceTrial({ trial: trial({ tasks_seen: 7 }) }) });
    expect(byClass(tree(over), 'meter')[0]!.props.style['--v']).toBe('100%');
  });

  it('compares the measured values before and during the trial per task', async () => {
    const h = await mount({
      item: experienceTrial({
        trial: trial({
          metrics: [
            { name: 'first_pass', unit: 'tasks', baseline: 1, trial: 3 },
            { name: 'input_tokens', unit: 'tokens', baseline: 552_000, trial: 453_000 },
            { name: 'wall_ms', unit: 'milliseconds', baseline: 7_560_000, trial: 6_300_000 },
            {
              name: 'wakes_without_decision_per_task',
              unit: 'wakes/task',
              baseline: 2,
              trial: 1.5,
            },
            { name: 'signal_findings', unit: 'findings', trial: 2 },
          ],
        }),
      }),
    });
    expect(byClass(tree(h), 'mld-cmp').map((n) => text(n))).toEqual([
      '对照试用前试用中',
      '一次过门禁1 / 33 / 3',
      '输入 token184k151k',
      '用时42 分钟35 分钟',
      '空唤醒2.01.5',
    ]);
  });

  it.each([
    [
      'leaves the comparison out of a trial without a baseline',
      experienceTrial({
        status_reason: 'no_baseline',
        trial: trial({
          status_reason: 'no_baseline',
          metrics: [{ name: 'first_pass', unit: 'tasks', baseline: 1, trial: 3 }],
        }),
      }),
    ],
    [
      'explains a missing baseline from the trial read before the stored reason is set',
      experienceTrial({
        trial: trial({
          tasks_seen: 2,
          status_reason: 'no_baseline',
          metrics: [{ name: 'first_pass', unit: 'tasks', baseline: 1, trial: 2 }],
        }),
      }),
    ],
  ])('%s', async (_name, item) => {
    const h = await mount({ item });
    expect(byClass(tree(h), 'mld-cmp')).toEqual([]);
    expect(all(h)).toContain(zh('memory.learnedDetail.noBaseline'));
  });

  /** Text a screen reader reads, without what is hidden from it, its parts joined by spaces. */
  const spoken = (t: ReactNode): string => {
    if (Array.isArray(t)) return t.map(spoken).filter(Boolean).join(' ');
    if (t && typeof t === 'object' && 'props' in t) {
      const node = t as { props: Record<string, any> };
      return node.props['aria-hidden'] ? '' : spoken(node.props.children);
    }
    return typeof t === 'string' || typeof t === 'number' ? String(t) : '';
  };
  it.each([
    [
      'shows the folder and the commands before and after a gate change in effect',
      improvement({
        status: 'active',
        change: {
          type: 'gate_command',
          root: '/repo/pay',
          from: [{ name: 'test', argv: ['pnpm', 'test'] }],
          to: [],
        },
      }),
      { label: '/repo/pay 的门禁', 现在: ['− test pnpm test'], 提议: ['没有门禁'] },
    ],
    [
      'marks a command in effect that became skippable and off on each side',
      improvement({
        status: 'active',
        change: {
          type: 'gate_command',
          root: '/repo/pay',
          from: [{ name: 'test', argv: ['pnpm', 'test'] }],
          to: [{ name: 'test', argv: ['pnpm', 'test'], skippable: true, enabled: false }],
        },
      }),
      {
        label: '/repo/pay 的门禁',
        现在: ['− test pnpm test'],
        提议: ['+ test pnpm test 不运行 失败算跳过'],
      },
    ],
    [
      'reads the setup a worktree setup proposal would replace from the project',
      improvement({
        change: { type: 'worktree_setup', to: { copy_paths: ['.env', 'certs/dev.pem'] } },
      }),
      { label: '工作树 setup', 现在: ['.env'], 提议: ['.env', '+ certs/dev.pem'] },
    ],
  ])('%s', async (_name, item, expected) => {
    useBoard.setState({
      board: {
        ...useBoard.getState().board!,
        projects: [{ id: 'pay', roots: ['/repo/pay'], worktree: { copy_paths: ['.env'] } }],
      },
    } as never);
    const h = await mount({ item });
    const diff = named(tree(h), 'LearnedChangeDiff');
    const drawn = (diff.type as (props: unknown) => ReactNode)(diff.props);
    expect({
      label: find(drawn, (n) => n.props.role === 'group').props['aria-label'],
      ...Object.fromEntries(
        nodes(drawn)
          .filter((n) => n.type === 'ul')
          .map((n) => [
            n.props['aria-label'],
            nodes(n.props.children)
              .filter((li) => li.type === 'li')
              .map(spoken),
          ]),
      ),
    }).toEqual(expected);
    if (item.change.type === 'gate_command') expect(spoken(drawn)).toContain('/repo/pay');
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
    await mount({ item: policyTrial({ trial: trial() }) });
    expect(sessionQueries()).toEqual([]);
    await mount({ item: improvement({ status: 'active', decided_at: noon - hour }) });
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

  it('heads a rejection with the reason the user gave', async () => {
    const head = async (extra: Partial<ImprovementListItem>) =>
      text(
        byClass(
          tree(
            await mount({
              item: improvement({ status: 'rejected', decided_at: noon - hour, ...extra }),
            }),
          ),
          'mld-status',
        )[0]!,
      );
    expect(await head({ reject_reason: 'duplicate' })).toBe('拒绝：规则重复');
    expect(await head({ reject_reason: 'not_useful' })).toBe('拒绝：没有用');
    expect(await head({})).toBe(zh('memory.learnedDetail.status.rejected'));
  });
});
