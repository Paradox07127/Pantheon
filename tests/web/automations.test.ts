import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AgentRoutineRow, AgentWake } from '@pantheon/protocol';
import { type HookHost, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
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
  vi.fn(async (..._args: unknown[]): Promise<any> => ({ ok: true, value: {} })),
);
vi.mock('@/data/commands', () => ({ runCommand }));
const data = vi.hoisted(() => ({
  agents: null as any,
  routines: null as any,
  wakes: null as any,
  wakesOf: [] as (string | null)[],
  wakesOfRoutine: [] as (string | undefined)[],
}));
const showAgentProfile = vi.hoisted(() => vi.fn());
vi.mock('@/data/agents', async (actual) => ({
  ...(await actual<object>()),
  useAgents: () => data.agents,
  showAgentProfile,
}));
vi.mock('@/data/automations', () => ({
  useRoutines: () => data.routines,
  useAgentWakes: (_projectId: string | null, agentId: string | null, routineId?: string) => {
    data.wakesOf.push(agentId);
    data.wakesOfRoutine.push(routineId);
    return agentId ? data.wakes : { data: null, loading: false, error: null, reload() {} };
  },
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', async (actual) => ({ ...(await actual<object>()), toast }));
import { ROUTINE_TEMPLATES } from '@pantheon/protocol/routine-catalog';
import { Sidebar } from '@/components/Sidebar';
import { failureText } from '@/data/needs-you';
import { setLocaleSync } from '@/i18n';
import { AutomationsScreen } from '@/screens/automations/AutomationsScreen';

setLocaleSync('en', {});

const HOUR = 3_600_000;
const NOW = Date.now();
const COVERAGE = ROUTINE_TEMPLATES.find((each) => each.id === 'test-coverage')!.prompt;
const REBASE = 'Rebase open task branches on main and report conflicts';
const SUMMARY = "Summarise the week's merged tasks";

const rows = (): AgentRoutineRow[] => [
  {
    agent_id: 'ag-assistant',
    agent_name: 'Assistant',
    agent_revision: 4,
    routine: { id: 'r-cover', prompt: COVERAGE, every_ms: 12 * HOUR, enabled: true },
    next_run_at: NOW + HOUR,
    last_run: { turn_id: 't-now', at: NOW - 60_000, state: 'running', outcome: 'nothing' },
  },
  {
    agent_id: 'ag-assistant',
    agent_name: 'Assistant',
    agent_revision: 4,
    routine: { id: 'r-rebase', prompt: REBASE, every_ms: 30 * 60_000, enabled: true },
  },
  {
    agent_id: 'ag-triage',
    agent_name: 'Triage',
    agent_revision: 7,
    routine: {
      id: 'r-sum',
      prompt: SUMMARY,
      at: '09:00',
      active_hours: { from: '09:00', to: '18:00' },
      enabled: false,
    },
    last_run: {
      turn_id: 't-sum',
      at: NOW - 6 * 24 * HOUR,
      state: 'completed',
      outcome: 'told_user',
    },
  },
];

const wake = (turn_id: string, extra: Partial<AgentWake> = {}): AgentWake => ({
  turn_id,
  session_id: 's-assistant-lead',
  at: NOW - HOUR,
  state: 'completed',
  causes: ['routine'],
  routine_ids: ['r-cover'],
  outcome: 'nothing',
  message_ids: [],
  question_ids: [],
  actions: 0,
  messages: [],
  questions: [],
  tasks_started: 0,
  ...extra,
});

const agent = (id: string, template: string, extra: object = {}) => ({
  id,
  template,
  name: template === 'assistant' ? 'Assistant' : 'Triage',
  role: 'AS',
  routines: [],
  created_by: { kind: 'user' },
  created_at: template === 'assistant' ? 1 : 2,
  project_id: 'alpha',
  revision: 1,
  ...extra,
});

const read = (value: AgentRoutineRow[] | null, extra: object = {}) => ({
  read: value,
  error: null,
  loading: false,
  unavailable: false,
  stale: false,
  reload: vi.fn(),
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
    screen: 'automations',
    sessionId: null,
    sessionGroup: null,
    renaming: null,
    openSession: vi.fn(),
    setScreen: vi.fn(),
  };
  runCommand.mockReset();
  runCommand.mockImplementation(async () => ({ ok: true, value: {} }));
  toast.mockClear();
  showAgentProfile.mockClear();
  data.agents = [agent('ag-assistant', 'assistant'), agent('ag-triage', 'triage')];
  data.routines = read(rows());
  data.wakes = { data: [], loading: false, error: null, reload: vi.fn() };
  data.wakesOf = [];
  data.wakesOfRoutine = [];
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

type Node = ReactElement<any>;
const roleOf = (n: Node) =>
  n.props.role ?? (n.type === 'button' ? 'button' : n.type === 'h1' ? 'heading' : undefined);
const nameOf = (n: Node) => String(n.props['aria-label'] ?? text(n)).trim();
const all = (tree: unknown, role: string, name?: string) =>
  nodes(tree as Node).filter(
    (n) => roleOf(n) === role && (name === undefined || nameOf(n) === name),
  );
const one = (tree: unknown, role: string, name: string) => {
  const found = all(tree, role, name);
  expect(found, `${role} "${name}"`).toHaveLength(1);
  return found[0]!;
};
/** The table row whose text holds `name`. */
const row = (tree: unknown, name: string) => {
  const found = all(tree, 'row').filter((n) => text(n).includes(name));
  expect(found, `row of ${name}`).toHaveLength(1);
  return found[0]!;
};
const press = async (h: HookHost<any>, button: Node) => {
  button.props.onClick();
  await h.flush();
  h.render();
};

const screen = () => host(() => AutomationsScreen({ projectId: 'alpha' }));

describe('automations page', () => {
  it('lists every routine of the project with its agent, schedule, next run and last run', () => {
    const tree = screen().value;
    expect(named(tree, 'TopBar').props).toMatchObject({ title: 'Automations', count: 3 });
    const table = one(tree, 'table', "Routines of this project's agents");
    expect(all(table, 'columnheader').map(nameOf)).toEqual([
      'Agent',
      'Routine',
      'Schedule',
      'Next run',
      'Last run',
    ]);
    const coverage = row(tree, 'Test coverage');
    expect(text(coverage)).toContain('Assistant');
    expect(text(coverage)).toContain('Every 12 hours');
    expect(all(coverage, 'img', 'Running')).toHaveLength(1);
    const rebase = row(tree, REBASE);
    expect(text(rebase)).toContain('Every 30 minutes');
    expect(text(rebase)).toContain('Never ran');
    const summary = row(tree, SUMMARY);
    expect(text(summary)).toContain('Triage');
    expect(text(summary)).toContain('Daily at 09:00');
    expect(text(summary)).toContain('09:00 to 18:00');
    expect(text(summary)).toContain('Paused');
    expect(all(summary, 'img', 'Told you')).toHaveLength(1);
  });

  it('runs a routine now, and not one that is paused or already running', async () => {
    const h = screen();
    expect(one(row(h.value, 'Test coverage'), 'button', 'Run now').props.disabled).toBe(true);
    expect(one(row(h.value, SUMMARY), 'button', 'Run now').props.disabled).toBe(true);
    const run = one(row(h.value, REBASE), 'button', 'Run now');
    expect(run.props.disabled).toBe(false);
    await press(h, run);
    expect(runCommand.mock.calls).toEqual([
      ['agent.routine.run', { agent_id: 'ag-assistant', routine_id: 'r-rebase' }, null],
    ]);
  });

  it('shows a refused command under its row until the next press on that row', async () => {
    const error = { code: 'invalid_state', message: 'Enable the routine before running it' };
    runCommand.mockImplementationOnce(async () => ({ ok: false, error }));
    const h = screen();
    await press(h, one(row(h.value, REBASE), 'button', 'Run now'));
    expect(all(h.value, 'alert').map(nameOf)).toEqual([failureText(error)]);
    await press(h, one(row(h.value, REBASE), 'button', 'Run now'));
    expect(all(h.value, 'alert')).toEqual([]);
  });

  it('says under its row when the project budget holds a run', async () => {
    runCommand.mockImplementationOnce(async () => ({
      ok: true,
      value: { session_id: 's-assistant', queued: 'budget' },
    }));
    const h = screen();
    await press(h, one(row(h.value, REBASE), 'button', 'Run now'));
    expect(all(h.value, 'alert').map(nameOf)).toEqual([
      'Queued until the project budget is raised or cleared',
    ]);
  });

  it('pauses a routine through agent.update at the row revision, with an undo', async () => {
    runCommand.mockImplementation(async () => ({ ok: true, value: { revision: 5 } }));
    const h = screen();
    await press(h, one(row(h.value, REBASE), 'button', 'Pause'));
    const routines = (rebase: boolean) => [
      { id: 'r-cover', prompt: COVERAGE, every_minutes: 720, enabled: true },
      { id: 'r-rebase', prompt: REBASE, every_minutes: 30, enabled: rebase },
    ];
    expect(runCommand.mock.calls).toEqual([
      ['agent.update', { agent_id: 'ag-assistant', revision: 4, routines: routines(false) }, null],
    ]);
    const shown = toast.mock.calls.at(-1)![0];
    expect(shown.title).toBe(`${REBASE} paused`);
    expect(shown.action.label).toBe('Undo');
    shown.action.run();
    await h.flush();
    expect(runCommand.mock.calls.at(-1)).toEqual([
      'agent.update',
      { agent_id: 'ag-assistant', revision: 5, routines: routines(true) },
      null,
    ]);
  });

  it('resumes a paused routine', async () => {
    const h = screen();
    await press(h, one(row(h.value, SUMMARY), 'button', 'Resume'));
    expect(runCommand.mock.calls).toEqual([
      [
        'agent.update',
        {
          agent_id: 'ag-triage',
          revision: 7,
          routines: [
            {
              id: 'r-sum',
              prompt: SUMMARY,
              at: '09:00',
              active_hours: { from: '09:00', to: '18:00' },
              enabled: true,
            },
          ],
        },
        null,
      ],
    ]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('opens a row on the newest five runs of its routine, with their outcome and size', async () => {
    data.wakes.data = [
      wake('t-1', {
        outcome: 'told_user',
        actions: 3,
        message_ids: ['m-1', 'm-2'],
        usage: { input_tokens: 38_200, output_tokens: 900 } as never,
      }),
      wake('t-other', { routine_ids: ['r-rebase'] }),
      wake('t-2', { state: 'failed' }),
      wake('t-3'),
      wake('t-4'),
      wake('t-5'),
      wake('t-6'),
    ];
    const h = screen();
    const open = one(row(h.value, 'Test coverage'), 'button', 'Show runs of Test coverage');
    expect(open.props['aria-expanded']).toBe(false);
    await press(h, open);
    expect(one(h.value, 'button', 'Hide runs of Test coverage').props['aria-expanded']).toBe(true);
    expect(data.wakesOf.at(-1)).toBe('ag-assistant');
    const runs = one(h.value, 'group', 'Recent runs of Test coverage');
    expect(all(runs, 'img').map(nameOf)).toEqual([
      'Told you',
      'Failed',
      'Nothing',
      'Nothing',
      'Nothing',
    ]);
    expect(text(runs)).toContain('3 actions');
    expect(text(runs)).toContain('2 messages');
    expect(text(runs)).toContain('38.2K');
    expect(all(runs, 'button', 'Make a task').map((b) => b.props.disabled)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it("reads the wakes of the open row's routine", async () => {
    const h = screen();
    await press(h, one(h.value, 'button', `Show runs of ${REBASE}`));
    expect([data.wakesOf.at(-1), data.wakesOfRoutine.at(-1)]).toEqual(['ag-assistant', 'r-rebase']);
  });

  it('makes a task of a run and then offers to open the Assistant', async () => {
    data.wakes.data = [wake('t-1', { outcome: 'told_user', message_ids: ['m-1'] })];
    runCommand.mockImplementation(async () => ({ ok: true, value: { session_id: 's-assistant' } }));
    const h = screen();
    await press(h, one(h.value, 'button', 'Show runs of Test coverage'));
    await press(h, one(h.value, 'button', 'Make a task'));
    expect(runCommand.mock.calls).toEqual([['agent.wake.to_task', { turn_id: 't-1' }, null]]);
    const runs = one(h.value, 'group', 'Recent runs of Test coverage');
    expect(all(runs, 'button', 'Make a task')).toEqual([]);
    expect(text(runs)).toContain('Sent to Assistant');
    await press(h, one(runs, 'button', 'Open'));
    expect(mock.shell.openSession).toHaveBeenCalledWith('s-assistant');
  });

  it('says so when an open routine has not run yet', async () => {
    data.wakes.data = [wake('t-other', { routine_ids: ['r-cover'] })];
    const h = screen();
    await press(h, one(h.value, 'button', `Show runs of ${REBASE}`));
    expect(text(one(h.value, 'group', `Recent runs of ${REBASE}`))).toContain('No runs yet');
  });

  it('keeps the table under aria-busy while the routines load', () => {
    data.routines = read(null, { loading: true });
    const table = one(screen().value, 'table', "Routines of this project's agents");
    expect(table.props['aria-busy']).toBe(true);
    expect(all(table, 'columnheader')).toHaveLength(5);
  });

  it('shows a failed read with a retry where the list would be', async () => {
    data.routines = read(null, { error: 'Could not read the routines' });
    const h = screen();
    expect(all(h.value, 'table')).toEqual([]);
    const alerts = all(h.value, 'alert');
    expect(alerts).toHaveLength(1);
    expect(text(alerts[0])).toContain('Could not read the routines');
    await press(h, one(h.value, 'button', 'Retry'));
    expect(data.routines.reload).toHaveBeenCalled();
  });

  it("opens the Assistant's profile from the empty page", async () => {
    data.routines = read([]);
    const h = screen();
    expect(text(h.value)).toContain('No agent in this project runs anything on a schedule.');
    await press(h, one(h.value, 'button', 'Add a routine'));
    expect(showAgentProfile).toHaveBeenCalledWith('ag-assistant', { addRoutine: true });
    expect(mock.shell.setScreen).toHaveBeenCalledWith('sessions');
  });
});

const sidebar = () =>
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
      list: { data: [], loading: false, error: null, reload() {} } as any,
      allNeeds: { items: [], error: null } as any,
    } as any),
  );

describe('sidebar entry', () => {
  it.each(['sessions', 'automations'] as const)(
    'has no automations entry on the %s screen while the project has agents with routines on',
    (screen) => {
      mock.shell.screen = screen;
      const tree = sidebar().value;
      expect(nodes(tree).filter((n) => n.props['data-stop'] === 'automations')).toEqual([]);
      expect(all(tree, 'button').filter((n) => nameOf(n).startsWith('Automations'))).toEqual([]);
    },
  );
});
