import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanItemView, ProjectPlanView, SessionThreadEntry } from '@pantheon/protocol';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  thread: { data: null, loading: false, error: null } as any,
  asked: [] as (string | null)[],
  reload: () => {},
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', async (actual) => ({
  ...(await actual<object>()),
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/session-thread', () => ({
  useSessionThread: (sessionId: string | null) => {
    mock.asked.push(sessionId);
    return { ...mock.thread, reload: mock.reload };
  },
}));
import { ItemInspector } from '@/screens/project/ItemInspector';
import type { ShownPlanItem } from '@/screens/project/project-model';
import { zh, zhf } from './i18n-setup.js';

type Plan = NonNullable<ProjectPlanView['plan']>;

const NOW = Date.parse('2026-11-26T09:00:00.000Z');

const item = (extra: Partial<PlanItemView> = {}): ShownPlanItem =>
  ({
    id: 'webhook',
    title: 'Reject stale webhooks',
    stage: 'write',
    status: 'running',
    gate_runs: [],
    ...extra,
  }) as ShownPlanItem;

const plan = (items: PlanItemView[]): Plan => ({
  session_id: 'lead',
  conductor_open: true,
  revision: 4,
  updated_at: '2026-11-26T09:00:00.000Z',
  milestones: [],
  items,
});

const inspector = (shown: ShownPlanItem) =>
  mount(
    () =>
      ItemInspector({
        item: shown,
        plan: plan([shown]),
        projectId: 'alpha',
        sessions: [],
        onClose() {},
      }) as ReactElement,
  );

const threadSection = (tree: unknown) =>
  nodes(tree as ReactElement).find(
    (n) => n.type === 'section' && n.props['aria-label'] === zh('project.inspector.thread'),
  );
/** The entry rows: list items that start with their time. */
const rows = (tree: unknown) =>
  nodes(threadSection(tree)).filter(
    (n) => n.type === 'li' && nodes(n.props.children).some((c) => c.type === 'time'),
  );
const button = (tree: unknown, name: string) =>
  nodes(tree as ReactElement).find(
    (n) => n.type === 'button' && (text(n) === name || n.props['aria-label'] === name),
  );

const at = (minutesAgo: number) => NOW - minutesAgo * 60_000;
const entry = (fields: Record<string, unknown>, minutesAgo = 5): SessionThreadEntry =>
  ({ id: `entry-${String(fields.kind)}-${minutesAgo}`, at: at(minutesAgo), ...fields }) as never;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    events: [],
    reads: {},
    status: { state: 'live' },
    resync: 0,
  };
  mock.thread = { data: null, loading: false, error: null };
  mock.asked = [];
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe('what happened to the session of a plan item', () => {
  it.each([
    ['started by you', { kind: 'started', by: 'user' }, ['你起的']],
    [
      'started by the main agent, with its reason',
      {
        kind: 'started',
        by: 'main_agent',
        main_agent_session_id: 'lead',
        reason: 'The webhook needs a stale check',
      },
      ['主 agent 起的', 'The webhook needs a stale check'],
    ],
    [
      'a message of the main agent, its first line',
      {
        kind: 'message',
        main_agent_session_id: 'lead',
        turn_id: 'turn-1',
        text: 'Add the timestamp check\nThen run the unit tests',
      },
      ['主 agent', 'Add the timestamp check'],
    ],
    [
      'a completed turn',
      { kind: 'turn_ended', turn_id: 'turn-1', state: 'completed' },
      ['回合完成'],
    ],
    [
      'a failed turn, with its error',
      { kind: 'turn_ended', turn_id: 'turn-1', state: 'failed', error: 'Process exited with 1' },
      ['回合失败', 'Process exited with 1'],
    ],
    [
      'a cancelled turn',
      { kind: 'turn_ended', turn_id: 'turn-1', state: 'cancelled' },
      ['回合取消'],
    ],
    [
      'the main agent told',
      { kind: 'spawner_notified', main_agent_session_id: 'lead', turn_id: 'turn-1' },
      ['主 agent 已收到'],
    ],
    [
      'a question the main agent answered',
      {
        kind: 'question',
        state: 'approved',
        answered_by: 'main_agent',
        questions: ['Keep the old header?'],
      },
      ['主 agent 答了', 'Keep the old header?'],
    ],
    [
      'a review round, with each verdict and the blocking count',
      {
        kind: 'review',
        round: 2,
        state: 'completed',
        verdicts: [
          { runtime: 'claude', verdict: 'fail' },
          { runtime: 'codex', verdict: 'pass' },
        ],
        blocking: [{ id: 'f1', location: 'src/webhook.ts:40', impact: 'Replays pass' }],
      },
      ['第 2 轮审查', 'Claude 不通过', 'Codex 通过', '1 个阻断'],
    ],
    [
      'a review round whose reviewers all failed before a verdict',
      { kind: 'review', round: 1, state: 'failed', verdicts: [], blocking: [] },
      ['第 1 轮审查', '审查没跑完'],
    ],
    [
      'a review round still running, with the verdicts so far',
      {
        kind: 'review',
        round: 1,
        state: 'running',
        verdicts: [{ runtime: 'codex', verdict: 'pass' }],
        blocking: [],
      },
      ['第 1 轮审查', '审查中', 'Codex 通过'],
    ],
    [
      'a failed gate, with its steps',
      { kind: 'gate', state: 'failed', failed_steps: ['Unit tests', 'Lint'] },
      ['门禁失败', 'Unit tests', 'Lint'],
    ],
    ['a passed gate', { kind: 'gate', state: 'passed', failed_steps: [] }, ['门禁通过']],
    [
      'a landing, with the short sha',
      { kind: 'landing', state: 'landed', commit: '0123456789abcdef' },
      ['已落地', '0123456'],
    ],
    [
      'a blocked landing, with its reason',
      { kind: 'landing', state: 'blocked', reason: 'The base moved' },
      ['落地被挡', 'The base moved'],
    ],
    [
      'a main agent handing it to land, with its reason',
      {
        kind: 'main_agent_action',
        action: 'ready',
        main_agent_session_id: 'lead',
        reason: 'Gate and review passed',
      },
      ['主 agent 交去落地', 'Gate and review passed'],
    ],
    [
      'a main agent interrupting it',
      { kind: 'main_agent_action', action: 'interrupt', main_agent_session_id: 'lead' },
      ['主 agent 打断了它'],
    ],
  ] as const)('writes %s in one row after its time', (_name, fields, words) => {
    mock.thread.data = { entries: [entry(fields)] };
    const h = inspector(item({ session_id: 'worker' }));
    expect(mock.asked).toContain('worker');
    const shown = rows(h.value);
    expect(shown).toHaveLength(1);
    expect(text(shown[0])).toContain(zhf('data.age.minutes', { count: 5 }));
    for (const word of words) expect(text(shown[0])).toContain(word);
  });

  it('shows the eight newest entries and opens the earlier ones from a line above them', () => {
    mock.thread.data = {
      entries: Array.from({ length: 11 }, (_, i) =>
        entry({ kind: 'turn_ended', turn_id: `turn-${i}`, state: 'completed' }, 60 - i),
      ),
    };
    const h = inspector(item({ session_id: 'worker' }));
    const earlier = zhf('project.inspector.thread.earlier', { count: 3 });
    expect(earlier).toBe('更早的 3 条');
    expect(rows(h.value).map((row) => row.key)).toEqual(
      Array.from({ length: 8 }, (_, i) => `entry-turn_ended-${57 - i}`),
    );
    const more = button(h.value, earlier)!;
    expect(more.props['aria-expanded']).toBe(false);
    more.props.onClick();
    h.render();
    expect(rows(h.value)).toHaveLength(11);
    expect(button(h.value, earlier)!.props['aria-expanded']).toBe(true);
  });

  it('shows the eight newest entries again when the item turns to another session', () => {
    mock.thread.data = {
      entries: Array.from({ length: 11 }, (_, i) =>
        entry({ kind: 'turn_ended', turn_id: `turn-${i}`, state: 'completed' }, 60 - i),
      ),
    };
    let shown = item({ session_id: 'worker' });
    const h = mount(
      () =>
        ItemInspector({
          item: shown,
          plan: plan([shown]),
          projectId: 'alpha',
          sessions: [],
          onClose() {},
        }) as ReactElement,
    );
    button(h.value, zhf('project.inspector.thread.earlier', { count: 3 }))!.props.onClick();
    h.render();
    expect(rows(h.value)).toHaveLength(11);
    shown = item({ session_id: 'retry' });
    h.render();
    expect(rows(h.value)).toHaveLength(8);
  });

  it('lists where each blocking finding is and what it breaks once the review row opens', () => {
    mock.thread.data = {
      entries: [
        entry({
          kind: 'review',
          round: 1,
          state: 'completed',
          verdicts: [{ runtime: 'claude', verdict: 'fail' }],
          blocking: [
            { id: 'f1', location: 'src/webhook.ts:40', impact: 'Replays pass the check' },
            { id: 'f2', location: 'src/clock.ts:12', impact: 'Skew is ignored' },
          ],
        }),
      ],
    };
    const h = inspector(item({ session_id: 'worker' }));
    expect(text(threadSection(h.value))).not.toContain('src/webhook.ts:40');
    const round = button(h.value, '第 1 轮审查')!;
    expect(round.props['aria-expanded']).toBe(false);
    round.props.onClick();
    h.render();
    const shown = text(threadSection(h.value));
    for (const word of [
      'src/webhook.ts:40',
      'Replays pass the check',
      'src/clock.ts:12',
      'Skew is ignored',
    ])
      expect(shown).toContain(word);
  });

  it('shows the whole message of the main agent once its row opens', () => {
    mock.thread.data = {
      entries: [
        entry({
          kind: 'message',
          main_agent_session_id: 'lead',
          turn_id: 'turn-1',
          text: 'Add the timestamp check\nThen run the unit tests',
        }),
      ],
    };
    const h = inspector(item({ session_id: 'worker' }));
    expect(text(threadSection(h.value))).not.toContain('Then run the unit tests');
    button(h.value, '主 agent')!.props.onClick();
    h.render();
    expect(text(threadSection(h.value))).toContain('Then run the unit tests');
  });

  it('says the read failed and reads again on retry', () => {
    const reload = vi.fn();
    mock.reload = reload;
    mock.thread = { data: null, loading: false, error: 'daemon gone' };
    const h = inspector(item({ session_id: 'worker' }));
    const section = threadSection(h.value)!;
    const alert = nodes(section).find((n) => n.props.role === 'alert');
    expect(text(alert)).toContain(zhf('project.inspector.thread.failed', { error: 'daemon gone' }));
    button(section, zh('components.retry'))!.props.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('has no such section for an item without a session', () => {
    mock.thread.data = { entries: [entry({ kind: 'started', by: 'user' })] };
    const h = inspector(item());
    expect(threadSection(h.value)).toBeUndefined();
    expect(mock.asked.every((id) => id === null)).toBe(true);
  });
});
