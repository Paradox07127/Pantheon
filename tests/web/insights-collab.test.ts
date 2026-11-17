import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BoardModel, BridgeResult, TaskTraceEntry } from '@pantheon/protocol';
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import { HookHost, find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { CollabControls, CollabTab } from '@/screens/insights/CollabTab';
import { useInsightsSection } from '@/screens/insights/InsightsScreen';
import { useSettingsView } from '@/screens/settings/view';
import { zh } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const NOW = Date.UTC(2026, 10, 12, 10);
const MINUTE = 60_000;
const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };

const policy = (patch: Partial<WorkflowPolicy> = {}): WorkflowPolicy => ({
  id: 'alpha',
  revision: 2,
  project_id: 'alpha',
  policy_version: 2,
  improvement_mode: 'confirm',
  plan_changes: 'auto',
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'each_merge',
  max_parallel: 3,
  max_parallel_limit: 4,
  handback_limit: 3,
  budget: {},
  pinned: [],
  runtime_parallel: { codex: 2 },
  dispatch_paused: false,
  ...patch,
});

const task = (id: string, runtime: string, extra: Partial<Task> = {}): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
    goal: '',
    scope: [],
    lane_id: null,
    milestone_id: null,
    status: 'running',
    state: 'running',
    blockers: [],
    segments: [],
    additions: null,
    deletions: null,
    checks: 'none',
    started_at: null,
    ended_at: null,
    last_progress_at: null,
    blocked_since: null,
    turn_running: true,
    claim: { session_id: `session-${id}`, runtime, model: null },
    ...extra,
  }) as Task;

const waitingSince = NOW - 40 * MINUTE;
const board = (extra: Partial<BoardModel> = {}): BoardModel =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [],
    slots: { limit: 3, used: 2, queued: 1 },
    tasks: [
      task('parser', 'codex', {
        claim: { session_id: 'session-parser', runtime: 'codex', model: 'gpt-5', effort: 'low' },
        context: { used_tokens: 46_000, window_tokens: 100_000 },
        external_review: { rounds: 1, verdict: 'pending' },
        gate_steps: [
          { name: 'lint', state: 'passed' },
          { name: 'test', state: 'running' },
          { name: 'build', state: 'pending' },
        ],
      }),
      task('lexer', 'claude', {
        state: 'waiting_approval',
        status: 'waiting',
        turn_running: false,
        activity: {
          phase: 'waiting_approval',
          since: waitingSince,
          waiting: {
            kind: 'approval',
            summary: 'pnpm db:migrate',
            approval_id: 'a1',
            since: waitingSince,
          },
          health: 'fresh',
          attempt: 1,
        },
      }),
      task('docs', 'codex', { state: 'merged', status: 'done' }),
      task('queued', 'codex', {
        claim: undefined,
        state: 'waiting_upstream',
        status: 'todo',
        blocked_since: NOW - 12 * MINUTE,
      }),
    ],
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state: 'idle',
        inbox: 0,
        updated_at: 0,
        messages_today: [
          { session_id: 'session-parser', lead: 4, tracker: 2, handbacks: 1 },
          { session_id: 'session-docs', lead: 1, tracker: 0, handbacks: 0 },
        ],
      },
    ],
    ...extra,
  }) as BoardModel;

const session = (id: string, runtime: string, extra: Record<string, unknown> = {}) => ({
  id,
  revision: 3,
  project_id: 'alpha',
  runtime,
  state: 'running',
  turn_count: 1,
  workspace_id: `workspace-${id}`,
  ...extra,
});
const leadSession = (usage?: object) =>
  session('lead-1', 'claude', { state: 'open', ...(usage && { usage }) });

const models = [
  { id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'], default_effort: 'high', default: true },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', efforts: ['low'], default_effort: null, default: false },
];

const bridge = {
  policy: policy(),
  trace: [] as TaskTraceEntry[],
  queries: [] as [string, unknown][],
  commands: [] as Command[],
  refusal: null as { code: string; message: string } | null,
  statuses: null as unknown[] | null,
  async query(method: string, params?: unknown): Promise<BridgeResult<unknown>> {
    bridge.queries.push([method, params]);
    if (method === 'workflow.policy') return { ok: true, value: bridge.policy };
    if (method === 'runtime.status' && bridge.statuses) return { ok: true, value: bridge.statuses };
    if (method === 'runtime.models') return { ok: true, value: models };
    if (method === 'task.trace') return { ok: true, value: bridge.trace };
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.refusal ? { ok: false, error: bridge.refusal } : { ok: true, value: {} };
  },
};

const opened: string[] = [];
async function mount(model: BoardModel = board(), readOnly?: boolean) {
  const h = host(() =>
    CollabTab({ model, projectId: 'alpha', onOpenSession: (id) => opened.push(id), readOnly }),
  );
  await h.flush();
  return h;
}
async function mountControls() {
  const h = host(() => CollabControls({ projectId: 'alpha' }));
  await h.flush();
  return h;
}
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const button = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n) === label);
const sent = () => bridge.commands.map((c) => [c.type, c.input, c.expected_revision]);
const sessionNodes = (tree: unknown) =>
  nodes(tree as never).filter((n) => n.type === 'button' && n.props['data-session']);
async function pick(h: HookHost<any>, sessionId: string) {
  find(h.value, (n) => n.props['data-session'] === sessionId).props.onClick();
  await h.flush();
  return h.value;
}
const side = (tree: unknown) => find(tree as never, (n) => n.type === 'aside');

beforeEach(() => {
  bridge.policy = policy();
  bridge.trace = [];
  bridge.queries = [];
  bridge.commands = [];
  bridge.refusal = null;
  bridge.statuses = null;
  opened.length = 0;
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: {
      cursor: 1,
      projects: [project],
      sessions: [
        session('session-parser', 'codex'),
        session('session-lexer', 'claude', { state: 'open' }),
        leadSession(),
      ],
      session_turns: [],
    },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('dispatch controls', () => {
  it('sits at the top of the tab, which draws no panel heading of its own', async () => {
    const h = await mount();
    expect(find(h.value, (n) => n.type === CollabControls).props.projectId).toBe('alpha');
    expect(h.value.props['aria-label']).toBe(zh('insights.sections.collab'));
    expect(nodes(h.value).some((n) => n.type === 'h2')).toBe(false);
  });

  it('names the flow paths the policy sends tasks down and opens the workflow tab on them', async () => {
    const h = await mountControls();
    const paths = find(
      h.value,
      (n) => n.type === 'button' && text(n).includes(zh('data.workflowPolicy.path.direct')),
    );
    expect(text(paths).split(zh('data.workflowPolicy.path.dispatch'))).toHaveLength(2);
    paths.props.onClick();
    expect(new HookHost(() => useInsightsSection('alpha')).render()).toBe('workflow');
  });

  it('shows the project concurrency read only, with a link to change it on the project’s settings page', async () => {
    const h = await mountControls();
    const group = labelled(h.value, zh('insights.collab.concurrency'));
    expect(text(find(group, (n) => n.type === 'output'))).toBe('3');
    expect(nodes(h.value).some((n) => n.props['aria-label'] === '并发加一')).toBe(false);
    button(group, zh('insights.collab.editConcurrency')).props.onClick();
    expect(useSettingsView.getState()).toMatchObject({
      open: true,
      page: 'projects',
      detail: 'alpha',
    });
    expect(sent()).toEqual([]);
  });

  it('leaves the runtime limits to the workflow settings', async () => {
    const h = await mount();
    expect(nodes(h.value).some((n) => n.props['aria-label'] === 'Codex')).toBe(false);
  });

  it('pauses and resumes dispatch with workflow.policy.set', async () => {
    let h = await mountControls();
    button(h.value, zh('insights.collab.pause')).props.onClick();
    await h.flush();
    bridge.policy = policy({ dispatch_paused: true });
    h = await mountControls();
    expect(nodes(h.value).some((n) => text(n) === zh('insights.collab.pause'))).toBe(false);
    button(h.value, zh('insights.collab.resume')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      ['workflow.policy.set', { project_id: 'alpha', dispatch_paused: true }, 2],
      ['workflow.policy.set', { project_id: 'alpha', dispatch_paused: false }, 2],
    ]);
  });
});

describe('relation graph', () => {
  it("joins the lead to each task session of today, labelled with the lead's messages", async () => {
    const h = await mount();
    const graph = labelled(h.value, zh('insights.collab.graph'));
    expect(sessionNodes(graph).map((n) => n.props['data-session'])).toEqual([
      'session-parser',
      'session-lexer',
      'session-docs',
    ]);
    expect(labelled(graph, '打开 lead（空闲）')).toBeDefined();
    const counts = nodes(graph).filter((n) => n.type === 'text');
    expect(counts.map((n) => text(n))).toEqual(['4', '1']);
    expect(sessionNodes(graph)[0]!.props['aria-label']).toBe(
      'task parser，运行中，今天 lead 发来 4 条消息',
    );
  });

  it('puts the external review and the checks of a task to its right', async () => {
    const h = await mount();
    expect(text(labelled(h.value, zh('insights.collab.review')))).toContain('第 1 轮');
    expect(text(labelled(h.value, zh('insights.collab.gate')))).toContain('3 步里的第 2 步');
  });

  it('names the role of each node at the end of its second line', async () => {
    const h = await mount();
    const role = (node: unknown) =>
      text(find(node as never, (n) => n.props.className === 'clb-nr'));
    expect(role(labelled(h.value, '打开 lead（空闲）'))).toBe(zh('insights.collab.roleLead'));
    expect(role(find(h.value, (n) => n.props['data-session'] === 'session-parser'))).toBe(
      zh('insights.collab.roleTask'),
    );
    expect(role(labelled(h.value, zh('insights.collab.review')))).toBe(
      zh('insights.collab.roleReview'),
    );
    expect(role(labelled(h.value, zh('insights.collab.gate')))).toBe(
      zh('insights.collab.roleCheck'),
    );
  });

  it('rings the context window a task session has filled', async () => {
    const h = await mount();
    const parser = find(h.value, (n) => n.props['data-session'] === 'session-parser');
    expect(labelled(parser, '上下文已用 46%').props.role).toBe('img');
  });

  it('says so when no task session ran today', async () => {
    const h = await mount(board({ tasks: [], leads: [] }));
    expect(nodes(h.value).some((n) => n.props.text === zh('insights.collab.noSessions'))).toBe(
      true,
    );
    expect(nodes(h.value).some((n) => n.props['aria-label'] === zh('insights.collab.graph'))).toBe(
      false,
    );
  });
});

describe('picked task session', () => {
  it("shows the session's model, context and today's messages until it is picked again", async () => {
    const h = await mount();
    expect(nodes(h.value).some((n) => n.type === 'aside')).toBe(false);
    const tree = await pick(h, 'session-parser');
    const panel = side(tree);
    expect(panel.props['aria-label']).toBe('task parser');
    expect(text(panel)).toContain('gpt-5');
    expect(text(panel)).toContain('46%');
    expect(text(panel)).toContain('和 lead 4 条消息，交回 1 次，上限 3');
    expect(text(panel)).toContain('tracker 发来 2 条消息');
    expect(
      find(tree, (n) => n.props['data-session'] === 'session-parser').props['aria-pressed'],
    ).toBe(true);
    await pick(h, 'session-parser');
    expect(nodes(h.value).some((n) => n.type === 'aside')).toBe(false);
  });

  it('opens the session, or its approval while it waits for one', async () => {
    const h = await mount();
    button(side(await pick(h, 'session-parser')), zh('insights.collab.open')).props.onClick();
    button(side(await pick(h, 'session-lexer')), zh('insights.collab.approve')).props.onClick();
    expect(opened).toEqual(['session-parser', 'session-lexer']);
  });

  it('steers the session with a message while its turn runs', async () => {
    const h = await mount();
    button(side(await pick(h, 'session-parser')), zh('insights.collab.message')).props.onClick();
    await h.flush();
    labelled(h.value, zh('insights.collab.messageText')).props.onChange({
      target: { value: ' use the row lock ' },
    });
    await h.flush();
    button(h.value, zh('insights.collab.send')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      ['session.steer', { session_id: 'session-parser', input: 'use the row lock' }, 3],
    ]);
  });

  it('hands the task back to its lead with a reason', async () => {
    const h = await mount();
    button(side(await pick(h, 'session-parser')), zh('insights.collab.handBack')).props.onClick();
    await h.flush();
    expect(button(h.value, zh('insights.collab.handBackSend')).props.disabled).toBe(true);
    labelled(h.value, zh('insights.collab.handBackReason')).props.onChange({
      target: { value: 'tests fail on main' },
    });
    await h.flush();
    button(h.value, zh('insights.collab.handBackSend')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      [
        'task.handback',
        { lead_session_id: 'lead-1', task_id: 'parser', reason: 'tests fail on main' },
        null,
      ],
    ]);
  });

  it('interrupts the running turn of the picked session, and only while one runs', async () => {
    const h = await mount();
    expect(
      button(side(await pick(h, 'session-lexer')), zh('insights.collab.interrupt')).props.disabled,
    ).toBe(true);
    button(side(await pick(h, 'session-parser')), zh('insights.collab.interrupt')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([['session.interrupt', { session_id: 'session-parser' }, 3]]);
  });

  it("offers a lead's direct task its interrupt but no hand back to itself", async () => {
    const direct = task('inline', 'claude', {
      claim: { session_id: 'lead-1', runtime: 'claude', model: null },
    });
    useBoard.setState((s: any) => ({
      board: {
        ...s.board,
        sessions: [
          ...s.board.sessions.filter((x: { id: string }) => x.id !== 'lead-1'),
          session('lead-1', 'claude'),
        ],
      },
    }));
    const h = await mount(board({ tasks: [direct] }));
    const panel = side(await pick(h, 'lead-1'));
    expect(
      nodes(panel).some((n) => n.type === 'button' && text(n) === zh('insights.collab.handBack')),
    ).toBe(false);
    button(panel, zh('insights.collab.interrupt')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([['session.interrupt', { session_id: 'lead-1' }, 3]]);
  });

  it('offers no session action while the board shown is a retained read', async () => {
    const h = await mount(board(), true);
    const panel = side(await pick(h, 'session-parser'));
    expect(
      nodes(panel)
        .filter((n) => n.type === 'button')
        .map((n) => text(n)),
    ).toEqual([zh('insights.collab.open')]);
    expect(nodes(panel).some((n) => n.type === Menu.Root)).toBe(false);
  });

  it.each([
    ['merged', { outcome: 'merged' }],
    ['without a worktree', { workspace_id: undefined }],
  ])('offers no model change for a session %s', async (_, extra) => {
    useBoard.setState((s: any) => ({
      board: {
        ...s.board,
        sessions: s.board.sessions.map((x: { id: string }) =>
          x.id === 'session-parser' ? { ...x, ...extra } : x,
        ),
      },
    }));
    const h = await mount();
    const panel = side(await pick(h, 'session-parser'));
    expect(find(panel, (n) => n.type === Menu.Root).props.disabled).toBe(true);
  });

  it('offers no model change while a turn runs on a runtime that cannot change it then', async () => {
    bridge.statuses = [
      {
        runtime: 'codex',
        enabled: true,
        installed: true,
        auth: { state: 'logged_in' },
        capabilities: {
          turn_model_change: { status: 'unsupported', evidence: 'between turns only' },
        },
      },
    ];
    const h = await mount();
    const menu = async () =>
      find(side(await pick(h, 'session-parser')), (n) => n.type === Menu.Root).props.disabled;
    expect(await menu()).toBe(true);
    useBoard.setState((s: any) => ({
      board: {
        ...s.board,
        sessions: s.board.sessions.map((x: { id: string }) =>
          x.id === 'session-parser' ? { ...x, state: 'open' } : x,
        ),
      },
    }));
    h.render();
    expect(find(side(h.value), (n) => n.type === Menu.Root).props.disabled).toBe(false);
  });

  it("lists what happened on the session's line with the time of each step", async () => {
    const clock = (at: number) =>
      [new Date(at).getHours(), new Date(at).getMinutes()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':');
    bridge.trace = [
      { at: NOW - 62 * MINUTE, kind: 'dispatched', session_id: 'session-parser' },
      { at: NOW - 50 * MINUTE, kind: 'dispatched', session_id: 'session-earlier' },
      { at: NOW - 30 * MINUTE, kind: 'gate_failed', session_id: 'session-parser', text: 'test' },
    ];
    const h = await mount();
    await pick(h, 'session-parser');
    await h.flush();
    expect(bridge.queries).toContainEqual([
      'task.trace',
      { project_id: 'alpha', lead_session_id: 'lead-1', task_id: 'parser' },
    ]);
    const events = labelled(side(h.value), zh('insights.collab.events'));
    expect(
      nodes(events)
        .filter((n) => n.type === 'li')
        .map((n) => text(n)),
    ).toEqual([`${clock(NOW - 62 * MINUTE)}派发`, `${clock(NOW - 30 * MINUTE)}门禁失败test`]);
  });

  it("shows the daemon's refusal in the panel", async () => {
    bridge.refusal = { code: 'task_not_found', message: 'no such task' };
    const h = await mount();
    button(side(await pick(h, 'session-parser')), zh('insights.collab.interrupt')).props.onClick();
    await h.flush();
    expect(text(find(side(h.value), (n) => n.props.role === 'alert'))).toContain('no such task');
  });

  it('switches the session to another model of its runtime with session.setModel', async () => {
    const h = await mount();
    await pick(h, 'session-parser');
    await h.flush();
    const item = find(
      side(h.value),
      (n) => typeof n.props.onClick === 'function' && text(n).includes('GPT-5 mini'),
    );
    item.props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      ['session.setModel', { session_id: 'session-parser', model: 'gpt-5-mini', effort: 'low' }, 3],
    ]);
  });
});

describe('collaboration summary', () => {
  const summary = (tree: unknown) => labelled(tree, zh('insights.collab.summary'));

  it('fills one segment per slot in use in the state of its task and counts the queue', async () => {
    const h = await mount();
    const bar = labelled(summary(h.value), '槽位 2/3：1 个运行，1 个等待，0 个失败');
    const segments = nodes(bar).filter((n) => n.type === 'i');
    expect(segments.map((s) => !!s.props['data-on'])).toEqual([true, true, false]);
    expect(segments.map((s) => s.props['data-tone'])).toEqual(['run', 'wait', undefined]);
    expect(text(summary(h.value))).toContain('排队 1');
  });

  it('marks the slots in use past the limit and says how many are over', async () => {
    const h = await mount(board({ slots: { limit: 1, used: 2, queued: 0 } }));
    const bar = labelled(summary(h.value), '槽位 2/1，超出上限 1 个：1 个运行，1 个等待，0 个失败');
    const segments = nodes(bar).filter((n) => n.type === 'i');
    expect(segments.map((s) => !!s.props['data-over'])).toEqual([false, true]);
  });

  it('takes the slot states from the sessions that hold slots, not from task rows', async () => {
    const h = await mount(
      board({
        slots: { limit: 3, used: 2, queued: 0 },
        tasks: [
          task('inline', 'claude', {
            claim: { session_id: 'lead-1', runtime: 'claude', model: null },
            status: 'waiting',
          }),
          task('split', 'codex', {
            parallel: [
              { title: 'part a', session_id: 'session-split-a', status: 'running' },
              { title: 'part b', session_id: 'session-split', status: 'running' },
              { title: 'part c' },
            ],
          }),
        ],
      }),
    );
    const bar = find(summary(h.value), (n) => n.props.className === 'clb-bar');
    expect(bar.props['aria-label']).toBe('槽位 2/3：2 个运行，0 个等待，0 个失败');
    const segments = nodes(bar).filter((n) => n.type === 'i');
    expect(segments.map((s) => s.props['data-tone'])).toEqual(['run', 'run', undefined]);
  });

  it('counts a lead waiting on its direct task once', async () => {
    const waiting = {
      kind: 'approval' as const,
      summary: 'pnpm db:migrate',
      approval_id: 'a7',
      since: waitingSince,
    };
    const h = await mount(
      board({
        tasks: [
          task('inline', 'claude', {
            claim: { session_id: 'lead-1', runtime: 'claude', model: null },
            state: 'waiting_approval',
            status: 'waiting',
            activity: {
              phase: 'waiting_approval',
              since: waitingSince,
              waiting,
              health: 'fresh',
              attempt: 1,
            },
          }),
        ],
        leads: [
          {
            session_id: 'lead-1',
            title: 'lead',
            state: 'waiting',
            inbox: 0,
            updated_at: 0,
            waiting,
          },
        ],
      }),
    );
    expect(text(summary(h.value))).toContain('1 个会话在等你');
  });

  it('leaves the slots out when the board has none', async () => {
    const h = await mount(board({ slots: undefined }));
    expect(nodes(h.value).some((n) => String(n.props['aria-label']).startsWith('槽位'))).toBe(
      false,
    );
  });

  it("counts today's handback and model change events, not each session's handbacks", async () => {
    const h = await mount();
    expect(text(summary(h.value))).toContain('今天 0 次');
  });

  it('counts the sessions waiting for the user and the tasks waiting upstream, with the longest wait', async () => {
    const h = await mount();
    const shown = text(summary(h.value));
    expect(shown).toContain('1 个会话在等你');
    expect(shown).toContain('最久 40 分');
    expect(shown).toContain('1 个任务在等上游');
    expect(shown).toContain('最久 12 分');
  });

  it("shows how full the lead's context window is only when its session reports it", async () => {
    let h = await mount();
    expect(text(summary(h.value))).not.toContain(zh('insights.collab.leadContext'));
    useBoard.setState((s: any) => ({
      board: {
        ...s.board,
        sessions: [
          ...s.board.sessions.filter((x: { id: string }) => x.id !== 'lead-1'),
          leadSession({
            input_tokens: 1,
            output_tokens: 1,
            context_tokens: 82_000,
            context_window: 100_000,
          }),
        ],
      },
    }));
    h = await mount();
    expect(text(summary(h.value))).toContain(zh('insights.collab.leadContext'));
    expect(labelled(summary(h.value), '上下文已用 82%')).toBeDefined();
  });
});
