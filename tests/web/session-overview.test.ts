import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { SessionGates, SessionPreflight, WorkbenchSession } from '@pantheon/protocol';
import { FakeElement } from './web-fake-dom.js';
import { find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  diff: null as unknown,
  preflight: null as SessionPreflight | null,
  gates: null as SessionGates | null,
  statuses: [] as unknown[],
}));
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
vi.mock('@/data/feedback', async (actual) => ({
  ...(await actual<object>()),
  useFeedback: (selector: any) => selector({ items: {} }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionDiff: () => ({ data: mock.diff, error: null, reload: () => {} }),
}));
vi.mock('@/data/session-panel', async (actual) => ({
  ...(await actual<object>()),
  useSessionGates: () => ({ data: mock.gates, error: null, reload: () => {} }),
  useSessionPreflight: () => ({ data: mock.preflight, error: null, reload: () => {} }),
}));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({ read: { state: 'ready', statuses: mock.statuses } }),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => ({
    read: null,
    error: null,
    loading: false,
    unavailable: false,
    reload() {},
  }),
}));
import { DEFAULT_SESSION_DISPLAY, setSessionDisplay } from '@/data/session-display';
import { ContextBreakdown } from '@/screens/sessions/ContextBreakdown';
import { SessionCard } from '@/screens/sessions/SessionsScreen';
import { showThreadTurns } from '@/screens/sessions/trace';
import { dispatchedAgents, planSteps, toolTally } from '@/screens/sessions/overview-model';
import { zh } from './i18n-setup.js';

const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Webhook signatures',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const session: Session = {
  id: 'session-a',
  revision: 4,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 2,
  workspace_id: 'workspace-a',
};
const preflight: SessionPreflight = {
  target_branch: 'main',
  source_root: '/repo',
  commit_count: 2,
  files_changed: 3,
  worktree_clean: true,
  source_clean: true,
  conflicts: { state: 'none' },
  gate: { configured_total: 1, last: 'passed' },
  can_merge: true,
};
const passed: SessionGates = {
  configured: true,
  running: false,
  last: {
    commit: 'abcdef1234567890',
    checked_at: 1,
    results: [{ name: 'Unit tests', exit_code: 0, timed_out: false, output_tail: '' }],
  },
};

const tool = (id: string, name: string, extra: object = {}) => ({
  kind: 'tool',
  id,
  name,
  input: {},
  ok: true,
  ...extra,
});
const agent = (id: string, type: string, extra: object = {}) =>
  tool(id, 'Task', {
    input: { subagent_type: type, description: `${type} work`, prompt: '' },
    ...extra,
  });
const turn = (id: string, state: string, items: object[], usage: unknown = null) => ({
  turn: { id, session_id: 'session-a', state },
  at: 1,
  started_at: 1,
  ended_at: null,
  text: '',
  usage,
  end: state === 'running' ? null : { kind: 'turn.completed' },
  items,
});
const usage = {
  context_tokens: 184_000,
  context_window: 400_000,
  input_tokens: 1_200_000,
  output_tokens: 38_000,
  cached_input_tokens: 1_092_000,
};
const step = (title: string, status: string) => ({ content: title, status });
const fullPlan = () => [
  step('Read the raw body', 'completed'),
  step('Compare in constant time', 'completed'),
  step('Reject stale timestamps', 'completed'),
  step('Rotate the signing keys', 'in_progress'),
  step('Migrate the secrets table', 'pending'),
  step('Document the header', 'pending'),
  step('Announce the change', 'pending'),
];
const todoWrite = (id: string, todos: object[], extra: object = {}) =>
  tool(id, 'TodoWrite', { input: { todos }, ...extra });
const fullTurns = () => [
  turn('turn-a', 'completed', [
    tool('r1', 'Read'),
    tool('r2', 'Grep'),
    tool('e1', 'Edit'),
    agent('a1', 'Explore', { started_at: 0, completed_at: 48_000 }),
    agent('a2', 'test-runner', { ok: false, started_at: 0, completed_at: 182_000 }),
    tool('r3', 'Read', { parent: 'a1' }),
  ]),
  turn(
    'turn-b',
    'running',
    [
      tool('b1', 'Bash'),
      tool('b2', 'Bash'),
      tool('w1', 'WebFetch'),
      agent('a3', 'reviewer', { ok: undefined, started_at: 0 }),
      todoWrite('t1', fullPlan()),
    ],
    usage,
  ),
];

let stored: Map<string, string>;
let commands: { type: string; input: unknown; expected_revision: number | null }[];
/** What the bridge answers each query with; null for the rest. */
let replies: Record<string, unknown>;
const card = (row: WorkbenchSession = listed(), onTab = vi.fn()) =>
  mount(() => SessionCard({ sessionId: 'session-a', listed: row, session, onTab }));
const classed = (tree: ReactNode, name: string) =>
  nodes(tree).filter((n) =>
    String(n.props.className ?? '')
      .split(' ')
      .includes(name),
  );
const caps = (tree: ReactNode) => classed(tree, 'ov-cap').map(text);
const cap = {
  plan: zh('sessions.overview.plan'),
  agents: zh('sessions.overview.agents'),
  tools: zh('sessions.overview.tools'),
};
const section = (tree: ReactNode, cap: string) =>
  classed(tree, 'ov-sec').find((s) => classed(s, 'ov-cap').some((c) => text(c) === cap))!;
const labelled = (tree: ReactNode, label: string) =>
  nodes(tree).find((n) => n.props['aria-label'] === label);
const title = {
  environment: zh('sessions.overview.environment'),
  context: zh('sessions.overview.context'),
  connectors: zh('sessions.overview.connectors'),
  outputs: zh('sessions.overview.outputs'),
};
/** The overview's named sections, in order. */
const regions = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.type === 'section')
    .map((n) => n.props['aria-label']);
const region = (tree: ReactNode, name: string) =>
  nodes(tree).find((n) => n.type === 'section' && n.props['aria-label'] === name)!;

beforeEach(() => {
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.preflight = preflight;
  mock.gates = passed;
  mock.statuses = [];
  mock.shell = { openSession: vi.fn() };
  mock.diff = null;
  showThreadTurns({ sessionId: 'session-a', turns: fullTurns() as never });
  stored = new Map();
  commands = [];
  replies = {};
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  vi.stubGlobal('window', {
    pantheon: {
      command: vi.fn(async (command: any) => {
        commands.push(command);
        return { ok: true, value: {} };
      }),
      query: vi.fn(async (method: string) => ({ ok: true, value: replies[method] ?? null })),
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  setSessionDisplay(DEFAULT_SESSION_DISPLAY);
  showThreadTurns(null);
  vi.unstubAllGlobals();
});

describe('session overview', () => {
  it('stacks context, then plan, agents and tools under one header, the merge bar last', () => {
    const h = card();
    expect(h.value!.props['aria-label']).toBe(zh('sessions.overview.title'));
    expect(regions(h.value)).toEqual([title.context]);
    expect(caps(h.value)).toEqual([cap.plan, cap.agents, cap.tools]);
    const all = nodes(h.value);
    expect(all.indexOf(region(h.value, title.context))).toBeLessThan(
      all.indexOf(section(h.value, cap.plan)),
    );
    const sections = (h.value!.props.children as ReactNode[])
      .flat()
      .filter(Boolean) as ReactElement<any>[];
    expect(sections.at(-1)!.props.className).toBe('ss-pf');
    expect(
      nodes(sections.at(-1)).some((n) => (n.type as { name?: string }).name === 'MergeBar'),
    ).toBe(true);
  });

  it("counts the main agent's newest todo steps done and names the step under way", () => {
    const shown = section(card().value, cap.plan);
    expect(text(shown)).toContain('3 / 7');
    expect(text(shown)).toContain('Rotate the signing keys');
    expect(labelled(shown, zh('sessions.parts.callRunning'))).toBeTruthy();
    expect(text(shown)).not.toContain('Migrate the secrets table');
  });

  it('opens the plan panel from the plan section', () => {
    const onTab = vi.fn();
    const shown = section(card(listed(), onTab).value, cap.plan);
    expect(shown.type).toBe('button');
    shown.props.onClick();
    expect(onTab.mock.calls).toEqual([['plan']]);
  });

  it('marks the step under way as waiting while the session waits for the user', () => {
    const shown = section(card(listed({ state: 'waiting' })).value, cap.plan);
    expect(text(shown)).toContain('Rotate the signing keys');
    expect(labelled(shown, zh('sessions.card.waiting'))).toBeTruthy();
    expect(labelled(shown, zh('sessions.parts.callRunning'))).toBeUndefined();
  });

  it('names the next pending step without a running mark when none is under way', () => {
    showThreadTurns({
      sessionId: 'session-a',
      turns: [
        turn('turn-a', 'completed', [
          todoWrite('t1', [step('Read the raw body', 'completed'), step('Ship it', 'pending')]),
        ]),
      ] as never,
    });
    const shown = section(card().value, cap.plan);
    expect(text(shown)).toContain('1 / 2');
    expect(text(shown)).toContain('Ship it');
    expect(labelled(shown, zh('sessions.parts.callRunning'))).toBeUndefined();
  });

  it('draws no current step once every todo step is done', () => {
    showThreadTurns({
      sessionId: 'session-a',
      turns: [
        turn('turn-a', 'completed', [
          todoWrite('t1', [step('Read the raw body', 'completed'), step('Ship it', 'completed')]),
        ]),
      ] as never,
    });
    const shown = section(card().value, cap.plan);
    expect(text(shown)).toContain('2 / 2');
    expect(classed(shown, 'ov-row')).toHaveLength(1);
  });

  it('gives each dispatched agent a row with its name, state and time', () => {
    const rows = classed(section(card().value, cap.agents), 'ov-row').slice(1);
    expect(text(classed(section(card().value, cap.agents), 'ov-row')[0])).toContain('3');
    expect(
      rows.map((row) => [
        text(classed(row, 'ov-name')[0]),
        classed(row, 'ov-glyph').at(-1)!.props['aria-label'],
        text(classed(row, 'ov-time')[0]),
      ]),
    ).toEqual([
      [zh('sessions.agentType.explore'), zh('sessions.parts.callOk'), '48.0 秒'],
      [zh('sessions.agentType.test'), zh('sessions.parts.callFailed'), '3 分 2 秒'],
      [zh('sessions.agentType.review'), zh('sessions.parts.callRunning'), ''],
    ]);
  });

  it('splits the tool calls into read, edit, run and the rest as other', () => {
    const shown = section(card().value, cap.tools);
    expect(text(shown)).toContain('11 次');
    const bar = nodes(shown).find((n) => n.props.role === 'img')!;
    expect(bar.props['aria-label']).toBe('工具调用：读取 3，编辑 1，运行 2，其他 5');
    expect(nodes(bar).filter((n) => n.type === 'i')).toHaveLength(4);
  });

  it('shows the context used of the window, its breakdown and the token counts', () => {
    const shown = region(card().value, title.context);
    expect(named(shown, 'ContextBreakdown').props.usage).toEqual(usage);
    const breakdown = mount(() => ContextBreakdown(named(shown, 'ContextBreakdown').props));
    expect(text(breakdown.value)).toContain('已用 46%');
    expect(text(breakdown.value)).toContain('184k / 400k');
    expect(text(shown)).toContain('输入 1.2M');
    expect(text(shown)).toContain('输出 38k');
    expect(text(shown)).toContain('缓存 91%');
  });

  it("heads the context breakdown with the session's model and meters its runtime's quota", () => {
    mock.statuses = [
      {
        runtime: 'claude',
        quota: { seen_at: 1, windows: [{ window: 'five_hour', used_percent: 38 }] },
      },
    ];
    const reported = { ...session, reported_model: 'claude-opus-4-5' } as Session;
    const h = mount(() =>
      SessionCard({ sessionId: 'session-a', listed: listed(), session: reported, onTab: vi.fn() }),
    );
    const breakdown = mount(() =>
      ContextBreakdown(named(region(h.value, title.context), 'ContextBreakdown').props),
    );
    expect(text(breakdown.value)).toContain('claude-opus-4-5');
    const meters = nodes(breakdown.value).filter((n) => n.props.role === 'meter');
    expect(meters.map((m) => [m.props['aria-label'], m.props['aria-valuenow']])).toEqual([
      ['5 小时已用额度', 38],
    ]);
  });

  it('leaves out each section that has nothing to show', () => {
    showThreadTurns({
      sessionId: 'session-a',
      turns: [turn('turn-a', 'completed', [tool('r1', 'Read')])] as never,
    });
    expect(caps(card().value)).toEqual([cap.tools]);
    expect(regions(card().value)).toEqual([]);
    showThreadTurns({
      sessionId: 'session-a',
      turns: [turn('turn-a', 'completed', [agent('a1', 'Explore')], usage)] as never,
    });
    expect(caps(card().value)).toEqual([cap.agents, cap.tools]);
    expect(regions(card().value)).toEqual([title.context]);
  });

  it('draws nothing without any section or merge bar', () => {
    showThreadTurns(null);
    expect(card(listed({ workspace_kind: 'in_place' })).value).toBeNull();
  });

  it('marks the root while an overview is in the page, until the last one leaves', () => {
    vi.stubGlobal('document', { documentElement: new FakeElement(1, 'HTML', null) });
    const marked = () => document.documentElement.hasAttribute('data-session-overview');
    const [first, second] = [card().value!, card().value!];
    expect(marked()).toBe(false);
    const leaveFirst = first.props.ref(first);
    const leaveSecond = second.props.ref(second);
    expect(marked()).toBe(true);
    leaveFirst();
    expect(marked()).toBe(true);
    leaveSecond();
    expect(marked()).toBe(false);
  });

  it('folds to its header and remembers that per session', () => {
    const h = card();
    const toggle = () =>
      labelled(h.value, zh('sessions.overview.collapse')) ??
      labelled(h.value, zh('sessions.overview.expand'))!;
    expect(toggle().props['aria-expanded']).toBe(true);
    toggle().props.onClick();
    h.render();
    expect(stored.get('pantheon.overview.session-a')).toBe('folded');
    expect(toggle().props['aria-label']).toBe(zh('sessions.overview.expand'));
    expect(toggle().props['aria-expanded']).toBe(false);
    expect(classed(h.value, 'ov-sec')).toEqual([]);
    expect(classed(h.value, 'ss-pf')).toEqual([]);
    expect(caps(card().value)).toEqual([]);
    expect(regions(card().value)).toEqual([]);
    toggle().props.onClick();
    h.render();
    expect(stored.get('pantheon.overview.session-a')).toBe('open');
    expect(regions(h.value)).toEqual([title.context]);
    expect(caps(h.value)).toEqual([cap.plan, cap.agents, cap.tools]);
  });

  it('starts folded to its header when the overview is set to fold, unless the session was opened', () => {
    setSessionDisplay({ overview: 'folded' });
    const toggle = labelled(card().value, zh('sessions.overview.expand'))!;
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(caps(card().value)).toEqual([]);
    expect(regions(card().value)).toEqual([]);
    stored.set('pantheon.overview.session-a', 'open');
    expect(regions(card().value)).toEqual([title.context]);
    expect(caps(card().value)).toEqual([cap.plan, cap.agents, cap.tools]);
  });

  it('leaves the context section out when context and usage are off', () => {
    setSessionDisplay({ context_usage: false });
    expect(regions(card().value)).toEqual([]);
    expect(caps(card().value)).toEqual([cap.plan, cap.agents, cap.tools]);
  });

  it('heads the overview with the machine, the folder with where it sits, and the branch the session runs on', async () => {
    mock.board.board.workspaces = [{ id: 'workspace-a', path: '/Users/me/code/pantheon' }];
    replies['device.list'] = [
      {
        id: 'local',
        name: 'Studio',
        home: '/Users/me',
        online: true,
        load: { active_sessions: [] },
      },
    ];
    const h = card(listed({ branch: 'webhook-signatures' }));
    await h.flush();
    expect(regions(h.value)).toEqual([title.environment, title.context]);
    const shown = region(h.value, title.environment);
    expect(text(shown)).toContain('Studio');
    expect(text(shown)).toContain('pantheon');
    expect(text(shown)).toContain('~/code');
    expect(text(shown)).toContain('webhook-signatures');
    for (const id of ['machine', 'folder', 'branch'])
      expect(labelled(shown, zh(`sessions.overview.${id}`))).toBeTruthy();
  });

  it('lists the MCP servers the session can use, leaving out the disabled ones', async () => {
    replies['session.mcp_servers'] = [
      { name: 'codegraph', state: 'connected' },
      { name: 'switched-off', state: 'disabled' },
      { name: 'openviking', state: 'failed' },
    ];
    const h = card();
    await h.flush();
    expect(window.pantheon!.query).toHaveBeenCalledWith('session.mcp_servers', {
      session_id: 'session-a',
    });
    expect(window.pantheon!.query).not.toHaveBeenCalledWith('mcp.status', expect.anything());
    const shown = region(h.value, title.connectors);
    expect(text(shown)).toContain('codegraph');
    expect(text(shown)).toContain('openviking');
    expect(text(shown)).not.toContain('switched-off');
  });

  it('lists the files the session changed after its context, each opening its changes', () => {
    mock.diff = {
      files: [
        { path: 'docs/bug-list.md', additions: 12, deletions: 0, untracked: true },
        { path: 'src/verify.ts', additions: 3, deletions: 1, untracked: false },
      ],
    };
    const onTab = vi.fn();
    const h = card(listed(), onTab);
    expect(regions(h.value)).toEqual([title.context, title.outputs]);
    const shown = region(h.value, title.outputs);
    const open = labelled(shown, 'docs/bug-list.md')!;
    expect(open.type).toBe('button');
    expect(text(open)).toBe('bug-list.md');
    open.props.onClick();
    expect(onTab).toHaveBeenCalledExactlyOnceWith('diff');
    expect(mock.shell.openSession).not.toHaveBeenCalled();
    expect(labelled(shown, 'src/verify.ts')).toBeTruthy();
  });

  it('opens the changes of a deleted file, and of every file once the session merged', () => {
    mock.diff = {
      files: [
        { path: 'src/gone.ts', additions: 0, deletions: 2, untracked: false },
        { path: 'src/verify.ts', additions: 1, deletions: 0, untracked: false },
      ],
      patch: [
        'diff --git a/src/gone.ts b/src/gone.ts',
        'deleted file mode 100644',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-one',
        '-two',
        'diff --git a/src/verify.ts b/src/verify.ts',
        '--- a/src/verify.ts',
        '+++ b/src/verify.ts',
        '@@ -1 +1,2 @@',
        ' keep',
        '+added',
      ].join('\n'),
      truncated: false,
    };
    const onTab = vi.fn();
    const outputs = (row: WorkbenchSession) => region(card(row, onTab).value, title.outputs);
    labelled(outputs(listed()), 'src/gone.ts')!.props.onClick();
    expect(onTab.mock.calls).toEqual([['diff']]);
    expect(mock.shell.openSession).not.toHaveBeenCalled();
    labelled(outputs(listed({ state: 'merged' })), 'src/verify.ts')!.props.onClick();
    expect(onTab.mock.calls).toEqual([['diff'], ['diff']]);
    expect(mock.shell.openSession).not.toHaveBeenCalled();
    labelled(outputs(listed()), 'src/verify.ts')!.props.onClick();
    expect(onTab.mock.calls).toEqual([['diff'], ['diff'], ['diff']]);
    expect(mock.shell.openSession).not.toHaveBeenCalled();
  });

  it('shows the merge bar only where it showed before', () => {
    const has = (row: WorkbenchSession) => classed(card(row).value, 'ss-pf').length > 0;
    expect(has(listed())).toBe(true);
    expect(has(listed({ workspace_kind: 'in_place' }))).toBe(false);
    mock.gates = null;
    expect(has(listed({ state: 'merged' }))).toBe(false);
    mock.gates = passed;
    expect(has(listed({ state: 'merged' }))).toBe(true);
  });

  it('sends the same merge command from its merge bar', async () => {
    const h = card();
    const bar = mount(() => {
      const element = named(h.value, 'MergeBar');
      return (element.type as (props: unknown) => ReactNode)(element.props);
    });
    find(bar.value, (n) => n.type === 'button' && n.props.className === 'btn pri').props.onClick();
    await bar.flush();
    const dialog = mount(() => {
      const element = named(bar.value, 'MergeDialog');
      return (element.type as (props: unknown) => ReactNode)(element.props);
    });
    mock.preflight = { ...preflight };
    h.render();
    bar.render();
    dialog.render();
    find(
      dialog.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.panel.mergeDialog.merge'),
    ).props.onClick();
    await dialog.flush();
    expect(commands).toMatchObject([
      { type: 'session.merge', input: { session_id: 'session-a' }, expected_revision: 4 },
    ]);
  });
});

describe('overview model', () => {
  it('counts tool calls by kind, subagent calls included, the rest as other', () => {
    expect(toolTally(fullTurns() as never)).toEqual([
      { kind: 'read', count: 3 },
      { kind: 'edit', count: 1 },
      { kind: 'run', count: 2 },
      { kind: 'other', count: 5 },
    ]);
    expect(toolTally([turn('t', 'completed', [tool('x', 'mcp__docs__search')])] as never)).toEqual([
      { kind: 'other', count: 1 },
    ]);
    const dsh = ['read', 'glob', 'grep', 'edit', 'write', 'bash', 'todo_write'];
    expect(
      toolTally([
        turn(
          't',
          'completed',
          dsh.map((name) => tool(name, name)),
        ),
      ] as never),
    ).toEqual([
      { kind: 'read', count: 3 },
      { kind: 'edit', count: 2 },
      { kind: 'run', count: 1 },
      { kind: 'other', count: 1 },
    ]);
    expect(toolTally([])).toEqual([]);
  });

  it('lists the dispatched agents with whether their turn ended', () => {
    const agents = dispatchedAgents(fullTurns() as never);
    expect(agents.map((a) => [a.agent.id, a.ended])).toEqual([
      ['a1', true],
      ['a2', true],
      ['a3', false],
    ]);
  });

  it("reads the steps of the main agent's newest todo list", () => {
    const steps = planSteps(fullTurns() as never)!;
    expect(steps).toHaveLength(7);
    expect(steps.filter((s) => s.status === 'completed')).toHaveLength(3);
    expect(steps.find((s) => s.status === 'in_progress')).toEqual({
      status: 'in_progress',
      title: 'Rotate the signing keys',
    });
    const turns = [
      turn('turn-a', 'completed', [todoWrite('t1', [step('Older', 'completed')])]),
      turn('turn-b', 'running', [
        todoWrite('t2', [step('Newer', 'in_progress'), step('Odd', 'blocked')]),
        todoWrite('t3', [step('From a subagent', 'pending')], { parent: 'a3' }),
      ]),
    ];
    expect(planSteps(turns as never)).toEqual([
      { status: 'in_progress', title: 'Newer' },
      { status: 'pending', title: 'Odd' },
    ]);
    expect(planSteps([turn('t', 'completed', [todoWrite('t1', [])])] as never)).toBeNull();
    expect(planSteps([turn('t', 'completed', [tool('r1', 'Read')])] as never)).toBeNull();
  });
});
