import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTurn } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { type HookHost, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
    setState: (patch: object) => Object.assign(mock.shell, patch),
  }),
}));
const runCommand = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ ok: true, value: { id: 'new-assistant' } as unknown })),
);
vi.mock('@/data/commands', () => ({ runCommand }));
const agentMock = vi.hoisted(() => ({
  agents: null as any,
  templates: null as any,
  proposal: (_id: string): any => null,
}));
vi.mock('@/data/agents', async (actual) => ({
  ...(await actual<object>()),
  useAgents: () => agentMock.agents,
  useAgentTemplates: () => agentMock.templates,
  useAgentProposal: (id: string | null) => (id ? agentMock.proposal(id) : null),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', async (actual) => ({ ...(await actual<object>()), toast }));
import { Sidebar } from '@/components/Sidebar';
import { AgentProfilePanel, NewAgentDialog } from '@/screens/sessions/AgentForm';
import { AgentProposalCall } from '@/screens/sessions/AgentProposal';
import type { ToolItem } from '@/data/transcript';
import { runtimeName } from '@/components/RuntimeGlyph';
import { buildTranscript } from '@/data/transcript';
import { SessionListRow, SessionRowButton } from '@/screens/sessions/SessionRow';
import { ThreadTurn } from '@/screens/sessions/Thread';
import { WorkerStrip, workerCountsText } from '@/screens/sessions/WorkerStrip';

const AT = '2026-11-16T10:00:00.000Z';
const session = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: AT,
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: AT,
  changes: null,
  merge: null,
  ...extra,
});
const resident = (id: string, kind: 'assistant' | 'triage') =>
  session(id, { resident: { kind }, workspace_id: null, title: kind });
const worker = (id: string, lane: string, extra: Partial<WorkbenchSession> = {}) =>
  session(id, {
    lead: 'res-assistant',
    task: { id: `task-${id}`, title: `task ${id}`, lane, lane_title: `Lane ${lane}` },
    ...extra,
  });

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { hasFocus: () => false, visibilityState: 'hidden' });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [], workspaces: [], cursor: 1 },
    events: [],
    status: { state: 'live' },
    refresh() {},
  };
  mock.shell = {
    screen: 'board',
    sessionId: null,
    sessionGroup: null,
    renaming: null,
    openSession: vi.fn(),
  };
  runCommand.mockClear();
  toast.mockClear();
  agentMock.agents = null;
  agentMock.templates = null;
  agentMock.proposal = () => null;
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const sidebar = (list: WorkbenchSession[]) =>
  host(() =>
    Sidebar({
      layout: {
        collapsed: false,
        width: 264,
        resize: () => {},
        commit: () => {},
        reset: () => {},
        toggle: () => {},
      },
      projects: [{ id: 'alpha', name: 'Alpha' }],
      currentProjectId: 'alpha',
      onChooseProject: () => {},
      list: { data: list, loading: false, error: null, reload() {} } as any,
      allNeeds: { items: [], error: null } as any,
    }),
  );

const ASSISTANT = zh('components.sidebar.residentAssistant');
const TRIAGE = zh('components.sidebar.residentTriage');
/** The resident row's name, the first part of its accessible name. */
const residentName = (n: ReturnType<typeof nodes>[number]) =>
  n.type === 'button'
    ? [ASSISTANT, TRIAGE].find((name) =>
        String(n.props['aria-label'] ?? '').startsWith(`${name}${zh('sessions.screen.separator')}`),
      )
    : undefined;
/** The resident rows and listed session rows, top to bottom, by name or session id. */
const order = (h: HookHost<any>) =>
  nodes(h.value).flatMap((n) =>
    n.type === SessionListRow ? [n.props.session.id as string] : (residentName(n) ?? []),
  );
const residentRow = (h: HookHost<any>, name: string) =>
  nodes(h.value).find((n) => residentName(n) === name)!;

describe('resident zone', () => {
  it('lists Assistant then Triage above every session, also before either is opened', () => {
    const list = [
      session('direct', { last_activity_at: '2026-11-16T12:00:00.000Z' }),
      resident('res-triage', 'triage'),
    ];
    expect(order(sidebar(list))).toEqual([ASSISTANT, TRIAGE, 'direct']);
  });

  it('opens a resident that does not exist yet through resident.open and shows it', async () => {
    const h = sidebar([]);
    residentRow(h, ASSISTANT).props.onClick();
    await h.flush();
    expect(runCommand.mock.calls).toEqual([
      ['resident.open', { project_id: 'alpha', kind: 'assistant' }, null],
    ]);
    expect(mock.shell.openSession).toHaveBeenCalledWith('new-assistant');
  });

  it('lists workers and the user’s own sessions under Sessions, not under the resident row', () => {
    const h = sidebar([
      resident('res-assistant', 'assistant'),
      worker('w-run', 'a', { state: 'running' }),
      session('mine'),
    ]);
    expect(order(h)).toEqual([ASSISTANT, TRIAGE, 'w-run', 'mine']);
    const row = residentRow(h, ASSISTANT);
    expect(nodes(row.props.children).some((n) => n.type === SessionListRow)).toBe(false);
    const titles = nodes(h.value).filter(
      (n) => n.type === 'span' && n.props.children === zh('app.screenName.sessions'),
    );
    expect(titles).toHaveLength(1);
  });

  it('counts the resident’s running, awaiting review and gate failed workers on its row', () => {
    const h = sidebar([
      resident('res-assistant', 'assistant'),
      worker('w-run', 'a', { state: 'running' }),
      worker('w-ready', 'a', { state: 'ready' }),
      worker('w-gate', 'b', { gate: { state: 'failed', passed: 1, failed: 1, running: 0 } }),
      worker('w-merged', 'b', { state: 'merged' }),
    ]);
    expect(residentRow(h, ASSISTANT).props['aria-label']).toContain(
      workerCountsText({ running: 1, review: 1, failed: 1 }),
    );
  });

  it('lists the agents agent.list returns without the archived ones, and opens a not started one by its id', async () => {
    agentMock.agents = [
      agent('agent-ideas', 'ideas', { name: 'Idea box', created_at: 3 }),
      agent('agent-triage', 'triage', { created_at: 1 }),
      agent('agent-old', 'custom', { name: 'Release notes', created_at: 2, archived_at: 5 }),
      agent('agent-assistant', 'assistant', { created_at: 1 }),
    ];
    const h = sidebar([resident('res-assistant', 'assistant')]);
    const rows = agentRows(h);
    expect(rows.map(rowName)).toEqual([ASSISTANT, TRIAGE, 'Idea box']);
    const ideas = rows[2]!;
    expect(ideas.props['aria-label']).toContain(zh('components.sidebar.residentNotStarted'));
    ideas.props.onClick();
    await h.flush();
    expect(runCommand.mock.calls).toEqual([['resident.open', { agent_id: 'agent-ideas' }, null]]);
    expect(mock.shell.openSession).toHaveBeenCalledWith('new-assistant');
  });
});

const NAMES = { assistant: 'Assistant', triage: 'Triage', ideas: 'Ideas', goals: 'Goals' } as const;
const agent = (id: string, template: string, extra: Record<string, unknown> = {}) => ({
  id,
  revision: 1,
  project_id: 'alpha',
  template,
  name: NAMES[template as keyof typeof NAMES] ?? 'Agent',
  role: template,
  instructions: `Instructions of ${id}`,
  role_prompt: `Built-in role of ${template}`,
  routines: [],
  created_by: { kind: 'user' },
  created_at: 1,
  ...extra,
});
/** The rows of the Agents zone, top to bottom. */
const agentRows = (h: HookHost<any>) => {
  const zone = nodes(h.value).find(
    (n) => n.props.role === 'group' && n.props['aria-label'] === zh('components.sidebar.residents'),
  )!;
  return nodes(zone.props.children).filter(
    (n) => n.type === 'button' && typeof n.props['aria-label'] === 'string',
  );
};
const rowName = (n: ReturnType<typeof nodes>[number]) =>
  String(n.props['aria-label']).split(zh('sessions.screen.separator'))[0];
/** The control a visible label names, through its htmlFor. */
const labelled = (tree: unknown, name: string) => {
  const label = nodes(tree as never).find((n) => n.type === 'label' && text(n) === name)!;
  return nodes(tree as never).find((n) => n.props.id === label.props.htmlFor && n !== label)!;
};
const pressed = (tree: unknown, name: string) =>
  nodes(tree as never).find((n) => n.type === 'button' && text(n) === name);

describe('new agent dialog', () => {
  const WEEK_MS = 7 * 24 * 60 * 60_000;
  const template = (name: 'ideas' | 'goals' | 'custom', extra: object = {}) => ({
    template: name,
    name: NAMES[name as keyof typeof NAMES] ?? 'Agent',
    role: name,
    instructions: `Instructions of ${name}`,
    tools: ['board'],
    listens: [],
    routines: [],
    ...extra,
  });

  it('prefills the weekly routine of the goals template as 7 days and creates it in minutes', async () => {
    agentMock.templates = [
      template('ideas'),
      template('goals', {
        routines: [{ id: 'weekly-review', prompt: 'Review', every_ms: WEEK_MS, enabled: true }],
      }),
      template('custom'),
    ];
    const h = host(() => NewAgentDialog({ projectId: 'alpha', open: true, onClose: () => {} }));
    const goals = nodes(h.value).find(
      (n) => n.props.role === 'radio' && text(n) === zh('sessions.agents.template.goals'),
    )!;
    goals.props.onClick();
    h.render();
    const routine = nodes(h.value).find(
      (n) => n.props['aria-label'] === zhf('sessions.agents.routine.label', { number: 1 }),
    )!;
    const control = (name: string) =>
      nodes(routine.props.children).find((n) => n.props['aria-label'] === zh(name))!;
    expect(control('sessions.agents.routine.interval').props.value).toBe('7');
    expect(control('sessions.agents.routine.unit').props.value).toBe('days');
    expect(labelled(h.value, zh('sessions.agents.field.name')).props.value).toBe('Goals');
    nodes(h.value)
      .find((n) => n.type === 'form')!
      .props.onSubmit({ preventDefault() {} });
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'agent.create',
      expect.objectContaining({
        project_id: 'alpha',
        template: 'goals',
        name: 'Goals',
        routines: [expect.objectContaining({ id: 'weekly-review', every_minutes: 10080 })],
      }),
      null,
    );
  });

  it('shows the built-in role of the template read-only above the user’s instructions, and none for custom', () => {
    agentMock.templates = [
      template('ideas', { role_prompt: 'Built-in role of ideas' }),
      template('goals', { role_prompt: 'Built-in role of goals' }),
      template('custom', { role_prompt: '' }),
    ];
    const h = host(() => NewAgentDialog({ projectId: 'alpha', open: true, onClose: () => {} }));
    const builtIn = () =>
      nodes(h.value).find((n) => n.type === 'span' && text(n) === zh('sessions.agents.builtin'));
    expect(builtIn()).toBeTruthy();
    expect(text(h.value)).toContain('Built-in role of ideas');
    expect(
      nodes(h.value).some(
        (n) =>
          (n.type === 'input' || n.type === 'textarea') &&
          n.props.value === 'Built-in role of ideas',
      ),
    ).toBe(false);
    const pick = (name: string) => {
      nodes(h.value)
        .find(
          (n) => n.props.role === 'radio' && text(n) === zh(`sessions.agents.template.${name}`),
        )!
        .props.onClick();
      h.render();
    };
    pick('goals');
    expect(text(h.value)).toContain('Built-in role of goals');
    pick('custom');
    expect(builtIn()).toBeUndefined();
  });
});

describe('agent profile', () => {
  const profile = (agentId: string) =>
    host(() => AgentProfilePanel({ projectId: 'alpha', agentId, onClose: () => {} }));

  it('saves an edited role at the profile’s revision, archives it, and undoes the archive', async () => {
    agentMock.agents = [
      agent('agent-assistant', 'assistant', { revision: 4 }),
      agent('agent-ideas', 'ideas', { revision: 3 }),
    ];
    const h = profile('agent-ideas');
    labelled(h.value, zh('sessions.agents.field.role')).props.onChange({
      target: { value: 'Keeper' },
    });
    h.render();
    pressed(h.value, zh('sessions.agents.save'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith(
      'agent.update',
      { agent_id: 'agent-ideas', revision: 3, role: 'Keeper' },
      null,
    );
    pressed(h.value, zh('sessions.agents.archive'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith('agent.archive', { agent_id: 'agent-ideas' }, null);
    const notice = toast.mock.calls.at(-1)![0];
    expect(notice.action.label).toBe(zh('sessions.agents.undo'));
    notice.action.run();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith(
      'agent.unarchive',
      { agent_id: 'agent-ideas' },
      null,
    );
  });

  /** The section a visible caption names, through its aria-labelledby. */
  const section = (tree: unknown, name: string) => {
    const caption = nodes(tree as never).find(
      (n) => (n.type === 'span' || n.type === 'label') && text(n) === name,
    );
    return nodes(tree as never).find(
      (n) => n.type === 'section' && caption && n.props['aria-labelledby'] === caption.props.id,
    );
  };

  it('shows the built-in role read-only and saves the user’s instructions through agent.update', async () => {
    agentMock.agents = [
      agent('agent-assistant', 'assistant', { revision: 6, instructions: undefined }),
    ];
    const h = profile('agent-assistant');
    const builtIn = section(h.value, zh('sessions.agents.builtin'))!;
    expect(text(builtIn)).toContain('Built-in role of assistant');
    expect(nodes(builtIn).filter((n) => n.type === 'textarea' || n.type === 'input')).toEqual([]);
    const own = section(h.value, zh('sessions.agents.field.instructions'))!;
    pressed(own, zh('sessions.agents.instructions.add'))!.props.onClick();
    h.render();
    labelled(h.value, zh('sessions.agents.field.instructions')).props.onChange({
      target: { value: '  Reply in Chinese.  ' },
    });
    h.render();
    pressed(
      section(h.value, zh('sessions.agents.field.instructions')),
      zh('sessions.agents.save'),
    )!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith(
      'agent.update',
      { agent_id: 'agent-assistant', revision: 6, instructions: 'Reply in Chinese.' },
      null,
    );
    expect(text(section(h.value, zh('sessions.agents.builtin')))).toContain(
      'Built-in role of assistant',
    );
  });

  it('shows Add instructions while the agent has no instructions of the user', () => {
    agentMock.agents = [agent('agent-triage', 'triage', { instructions: undefined })];
    const own = section(profile('agent-triage').value, zh('sessions.agents.field.instructions'))!;
    expect(pressed(own, zh('sessions.agents.instructions.add'))).toBeTruthy();
    expect(nodes(own).some((n) => n.type === 'textarea')).toBe(false);
  });

  it('shows a custom agent only the user’s instructions, without a built-in section', () => {
    agentMock.agents = [agent('agent-custom', 'custom', { name: 'Release notes' })];
    const h = profile('agent-custom');
    expect(section(h.value, zh('sessions.agents.builtin'))).toBeUndefined();
    expect(text(h.value)).not.toContain('Built-in role of custom');
    const own = section(h.value, zh('sessions.agents.field.instructions'))!;
    expect(text(own)).toContain('Instructions of agent-custom');
    expect(pressed(own, zh('sessions.agents.instructions.add'))).toBeUndefined();
    nodes(own)
      .find((n) => n.props['aria-label'] === zh('sessions.agents.instructions.edit'))!
      .props.onClick();
    h.render();
    labelled(h.value, zh('sessions.agents.field.instructions')).props.onChange({
      target: { value: ' ' },
    });
    h.render();
    const save = pressed(
      section(h.value, zh('sessions.agents.field.instructions')),
      zh('sessions.agents.save'),
    )!;
    expect(save.props.disabled).toBe(true);
  });

  it('lists six listens switches and saves the picked sources through agent.update', async () => {
    const sources = [
      'github',
      'gate_failures',
      'flaky_tests',
      'app_errors',
      'session_failures',
      'trace_findings',
    ];
    agentMock.agents = [
      agent('agent-ideas', 'ideas', { revision: 2, listens: [], effective_listens: [] }),
    ];
    const h = profile('agent-ideas');
    const caption = nodes(h.value).find(
      (n) => n.type === 'span' && text(n) === zh('sessions.agents.field.listens'),
    )!;
    const group = () =>
      nodes(h.value).find((n) => n.props['aria-labelledby'] === caption.props.id)!;
    const switches = () => nodes(group()).filter((n) => n.type === 'label');
    expect(switches().map(text)).toEqual([
      zh('sessions.agents.listen.github'),
      zh('sessions.agents.listen.gateFailures'),
      zh('sessions.agents.listen.flakyTests'),
      zh('sessions.agents.listen.appErrors'),
      zh('sessions.agents.listen.sessionFailures'),
      zh('sessions.agents.listen.traceFindings'),
    ]);
    for (let i = 0; i < sources.length; i++) {
      nodes(switches()[i])
        .find((n) => n.props.type === 'checkbox')!
        .props.onChange({ target: { checked: true } });
      h.render();
    }
    pressed(h.value, zh('sessions.agents.save'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith(
      'agent.update',
      { agent_id: 'agent-ideas', revision: 2, listens: sources },
      null,
    );
  });

  it('shows the effective tools and listens of a built-in agent and saves only what the user changed', async () => {
    agentMock.agents = [
      agent('agent-triage', 'triage', {
        revision: 5,
        effective_tools: ['board', 'memory'],
        effective_listens: ['github', 'gate_failures'],
      }),
    ];
    const h = profile('agent-triage');
    const group = (key: string) => {
      const caption = nodes(h.value).find(
        (n) => n.type === 'span' && text(n) === zh(`sessions.agents.field.${key}`),
      )!;
      return nodes(h.value).find((n) => n.props['aria-labelledby'] === caption.props.id)!;
    };
    const checked = (key: string) =>
      nodes(group(key))
        .filter((n) => n.type === 'label')
        .filter((n) => nodes(n).find((c) => c.props.type === 'checkbox')!.props.checked)
        .map(text);
    expect(checked('tools')).toEqual(['board', 'memory']);
    expect(checked('listens')).toEqual([
      zh('sessions.agents.listen.github'),
      zh('sessions.agents.listen.gateFailures'),
    ]);
    const flaky = nodes(group('listens')).find(
      (n) => n.type === 'label' && text(n) === zh('sessions.agents.listen.flakyTests'),
    )!;
    nodes(flaky)
      .find((n) => n.props.type === 'checkbox')!
      .props.onChange({ target: { checked: true } });
    h.render();
    pressed(h.value, zh('sessions.agents.save'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith(
      'agent.update',
      {
        agent_id: 'agent-triage',
        revision: 5,
        listens: ['github', 'gate_failures', 'flaky_tests'],
      },
      null,
    );
  });

  it('offers no archive for the assistant', () => {
    agentMock.agents = [agent('agent-assistant', 'assistant')];
    const h = profile('agent-assistant');
    expect(labelled(h.value, zh('sessions.agents.field.name'))).toBeTruthy();
    expect(pressed(h.value, zh('sessions.agents.archive'))).toBeUndefined();
  });
});

describe('agent proposal', () => {
  const proposal = (id: string) => ({
    id,
    revision: 1,
    project_id: 'alpha',
    session_id: 'res-assistant',
    fields: {
      template: 'ideas',
      name: 'Ideas',
      role: 'Ideas',
      instructions: 'Keep the ideas.',
      tools: ['board', 'memory'],
    },
    state: 'pending',
    at: 1,
  });
  const call = (id: string, receipt: object = {}) =>
    host(() =>
      AgentProposalCall({
        item: {
          kind: 'tool',
          id: `call-${id}`,
          name: 'mcp__pantheon__propose_agent',
          input: { project_id: 'alpha', ...proposal(id).fields },
          output: JSON.stringify({ receipt: { ...proposal(id), ...receipt } }),
          ok: true,
        } as ToolItem,
        state: 'ok',
        depth: 0,
        open: false,
        enter: '',
        sessionId: 'res-assistant',
      }),
    );
  beforeEach(() => {
    mock.board.board.sessions = [{ id: 'res-assistant', project_id: 'alpha', revision: 1 }];
    agentMock.proposal = proposal;
  });

  it('offers Create, Edit and Decline, and creates with the name edited in place', async () => {
    const h = call('proposal-a');
    for (const name of [
      'sessions.agents.create',
      'sessions.agents.proposal.edit',
      'sessions.agents.proposal.decline',
    ])
      expect(pressed(h.value, zh(name)), name).toBeTruthy();
    pressed(h.value, zh('sessions.agents.proposal.edit'))!.props.onClick();
    h.render();
    labelled(h.value, zh('sessions.agents.field.name')).props.onChange({
      target: { value: 'Idea box' },
    });
    h.render();
    pressed(h.value, zh('sessions.agents.create'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith(
      'agent.proposal.resolve',
      { proposal_id: 'proposal-a', decision: 'create', fields: { name: 'Idea box' } },
      null,
    );
  });

  it('leaves one line once declined', async () => {
    runCommand.mockResolvedValueOnce({
      ok: true,
      value: { ...proposal('proposal-b'), state: 'declined', resolved_at: 2 },
    });
    const h = call('proposal-b');
    pressed(h.value, zh('sessions.agents.proposal.decline'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith(
      'agent.proposal.resolve',
      { proposal_id: 'proposal-b', decision: 'decline' },
      null,
    );
    expect(pressed(h.value, zh('sessions.agents.create'))).toBeUndefined();
    expect(text(h.value)).toContain(zhf('sessions.agents.proposal.declined', { name: 'Ideas' }));
  });

  it('shows a just made proposal the daemon has as created as one line, without Create', () => {
    agentMock.proposal = (id) => ({ ...proposal(id), state: 'created', resolved_at: Date.now() });
    const h = call('proposal-c', { at: Date.now() });
    expect(pressed(h.value, zh('sessions.agents.create'))).toBeUndefined();
    expect(text(h.value)).toContain(zhf('sessions.agents.proposal.created', { name: 'Ideas' }));
  });

  it('names the agent by the name the user edited once created', async () => {
    runCommand.mockResolvedValueOnce({
      ok: true,
      value: {
        ...proposal('proposal-d'),
        state: 'created',
        edited_fields: { name: 'Idea box' },
        resolved_at: 2,
      },
    });
    const h = call('proposal-d');
    pressed(h.value, zh('sessions.agents.proposal.edit'))!.props.onClick();
    h.render();
    labelled(h.value, zh('sessions.agents.field.name')).props.onChange({
      target: { value: 'Idea box' },
    });
    h.render();
    pressed(h.value, zh('sessions.agents.create'))!.props.onClick();
    await h.flush();
    expect(text(h.value)).toContain(zhf('sessions.agents.proposal.created', { name: 'Idea box' }));
  });
});

describe('type and runtime filters', () => {
  const LIST = [
    resident('res-assistant', 'assistant'),
    worker('w-claude', 'a'),
    worker('w-codex', 'a', { runtime: 'codex' }),
    session('mine'),
    session('analysis', { runtime_review: true }),
  ];
  /** Sets one checkbox of the view menu as the user would, then draws the sidebar again. */
  const pick = (h: HookHost<any>, label: string, checked: boolean) => {
    const menu = nodes(h.value).find((n) => (n.type as any)?.name === 'ViewMenu')!;
    const drawn = host(() => (menu.type as (props: object) => any)(menu.props)).value;
    const item = nodes(drawn).find(
      (n) => 'onCheckedChange' in n.props && text(n.props.children) === label,
    )!;
    item.props.onCheckedChange(checked);
    h.render();
  };

  it('names the menu for grouping, sorting and filtering, with a Type and a Runtime group', () => {
    const h = sidebar(LIST);
    const menu = nodes(h.value).find((n) => (n.type as any)?.name === 'ViewMenu')!;
    const drawn = host(() => (menu.type as (props: object) => any)(menu.props)).value;
    expect(
      nodes(drawn).some((n) => n.props['aria-label'] === zh('components.sidebar.viewMenu')),
    ).toBe(true);
    expect(zh('components.sidebar.viewMenu')).toBe('分组、排序与筛选');
    const labels = nodes(drawn).map((n) => text(n.props.children));
    expect(labels).toContain(zh('components.sidebar.types'));
    expect(labels).toContain(zh('components.sidebar.runtimes'));
  });

  it('keeps only the worker rows with only Worker checked, and still after a remount', () => {
    const h = sidebar(LIST);
    for (const type of ['typeResident', 'typeDirect', 'typeReview'])
      pick(h, zh(`components.sidebar.${type}`), false);
    expect(order(h)).toEqual(['w-claude', 'w-codex']);
    unmountAll();
    expect(order(sidebar(LIST))).toEqual(['w-claude', 'w-codex']);
  });

  it('leaves out the sessions of an unchecked runtime, and still after a remount', () => {
    const h = sidebar(LIST);
    pick(h, runtimeName('codex'), false);
    expect(order(h)).not.toContain('w-codex');
    expect(order(h)).toContain('w-claude');
    unmountAll();
    expect(order(sidebar(LIST))).not.toContain('w-codex');
  });
});

describe('resident conversation', () => {
  const turn = (extra: Partial<SessionTurn>) =>
    ({
      id: 'turn-a',
      project_id: 'alpha',
      session_id: 'res-assistant',
      revision: 1,
      created_at: 1,
      updated_at: 1,
      input: 'Task Runtime filter: gate failed, 2 unit tests',
      kind: 'send',
      delivery: 'delivered',
      state: 'completed',
      ...extra,
    }) as unknown as SessionTurn;
  const draw = (extra: Partial<SessionTurn>) =>
    host(() =>
      ThreadTurn({
        view: buildTranscript([turn(extra)], []).turns[0]!,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: resident('res-assistant', 'assistant'),
      }),
    );
  const folds = (h: HookHost<any>) =>
    nodes(h.value).filter((n) => n.type === 'button' && 'aria-expanded' in n.props);

  it('folds a turn its workers woke to one line and shows the text once opened', () => {
    const h = draw({ origin: 'tracker' });
    const [line] = folds(h);
    expect(line!.props['aria-expanded']).toBe(false);
    expect(text(line!.props.children)).toContain(zh('sessions.residents.wake.tracker'));
    expect(text(h.value)).not.toContain('2 unit tests');
    line!.props.onClick();
    h.render();
    expect(folds(h)[0]!.props['aria-expanded']).toBe(true);
    expect(text(h.value)).toContain('Task Runtime filter: gate failed, 2 unit tests');
  });

  it('shows what a woken turn told the user as its reply, outside the folded work', () => {
    const event = (sequence: number, kind: string, payload: object) => ({
      sequence,
      event_id: `event-${sequence}`,
      kind,
      aggregate_id: 'res-assistant',
      aggregate_revision: 1,
      project_id: 'alpha',
      causation_id: '',
      created_at: sequence,
      payload: { turn_id: 'turn-a', ...payload },
    });
    const call = (sequence: number, id: string, name: string, input: object) => [
      event(sequence, 'agent.tool.started', { tool_call_id: id, name, input }),
      event(sequence + 1, 'agent.tool.completed', { tool_call_id: id, ok: true, output: 'ok' }),
    ];
    const view = buildTranscript(
      [turn({ origin: 'tracker' })],
      [
        ...call(1, 'call-read', 'Bash', { command: 'git log -1' }),
        ...call(3, 'call-tell', 'mcp__pantheon__tell_user', {
          text: 'The runtime filter merged.',
          urgency: 'normal',
        }),
        event(5, 'agent.message.delta', { text: 'Told the user.' }),
      ],
    ).turns[0]!;
    const h = host(() =>
      ThreadTurn({
        view,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: resident('res-assistant', 'assistant'),
      }),
    );
    const named = (tree: unknown, name: string) =>
      nodes(tree as any).filter((n) => (n.type as { name?: string }).name === name);
    const [work] = named(h.value, 'TurnWork');
    const folded = named(work!.props.children, 'Items').flatMap((n) => n.props.items);
    const shown = named(h.value, 'Items')
      .flatMap((n) => n.props.items)
      .filter((item) => !folded.includes(item));
    expect(folded.map((item: any) => item.name)).toEqual(['Bash']);
    expect(shown).toContainEqual({ kind: 'text', text: 'The runtime filter merged.' });
  });

  it('shows the user’s own turn as it is, without folding it', () => {
    const h = draw({ input: 'Add a runtime filter' });
    expect(folds(h)).toEqual([]);
    expect(text(h.value)).toContain('Add a runtime filter');
  });
});

describe('workers bar', () => {
  const WORKERS = [
    worker('w-run', 'filters', { state: 'running' }),
    worker('w-merged', 'filters', { state: 'merged' }),
    worker('w-old-1', 'readme', { state: 'merged' }),
    worker('w-old-2', 'readme', { state: 'merged' }),
  ];
  const bar = () => host(() => WorkerStrip({ workers: WORKERS }));
  const lanes = (h: HookHost<any>) =>
    nodes(h.value)
      .filter((n) => n.type === 'section')
      .map((lane) => [
        lane.props['aria-label'],
        nodes(lane.props.children).find((n) => n.type === 'button')!.props['aria-expanded'],
        nodes(lane.props.children)
          .filter((n) => n.type === SessionRowButton)
          .map((n) => n.props.session.id),
      ]);

  it('counts the workers and, opened, lists them by lane with fully finished lanes folded', () => {
    const h = bar();
    const toggle = () =>
      nodes(h.value).find((n) => n.type === 'button' && 'aria-expanded' in n.props)!;
    expect(toggle().props['aria-label']).toBe(
      zhf('sessions.residents.workers', { running: 1, review: 0, failed: 0 }),
    );
    expect(lanes(h)).toEqual([]);
    toggle().props.onClick();
    h.render();
    expect(lanes(h)).toEqual([
      ['Lane filters', true, ['w-run', 'w-merged']],
      ['Lane readme', false, []],
    ]);
  });
});
