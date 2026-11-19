import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.fn(async (..._args: unknown[]) => ({ ok: true, value: {} as unknown }) as any),
);
vi.mock('@/data/commands', () => ({ runCommand }));
const data = vi.hoisted(() => ({
  agents: null as any,
  wakes: null as any,
  routines: null as any,
  ledger: null as any,
}));
vi.mock('@/data/agents', async (actual) => ({
  ...(await actual<object>()),
  useAgents: () => data.agents,
  useAgentWakes: () => data.wakes,
  useAgentRoutines: () => data.routines,
  useAgentLedger: () => data.ledger,
}));
import { ROUTINE_TEMPLATES } from '@pantheon/protocol/routine-catalog';
import { AgentProfilePanel } from '@/screens/sessions/AgentProfile';
import { ChapterMark } from '@/screens/sessions/items';
import { buildTranscript } from '@/data/transcript';

const BUG_HUNT = ROUTINE_TEMPLATES.find((each) => each.id === 'bug-hunt')!.prompt;
const read = (value: unknown, extra: object = {}) => ({
  data: value,
  loading: false,
  error: null,
  reload: vi.fn(),
  ...extra,
});
const triage = (extra: object = {}) => ({
  id: 'agent-triage',
  revision: 7,
  project_id: 'alpha',
  template: 'triage',
  name: 'Triage',
  role: 'Bugs',
  instructions: 'Never start a task for a flaky test.',
  role_prompt: 'Built-in role of triage',
  routines: [],
  effective_tools: ['board'],
  effective_listens: ['github'],
  created_by: { kind: 'user' },
  created_at: 1,
  contract: {
    weekly_input_tokens: 2_000_000,
    loudest: 'notify',
    quiet_hours: { from: '22:00', to: '08:00' },
  },
  ...extra,
});
const week = (extra: object = {}) => ({
  from: 0,
  to: 1,
  wakes: 14,
  causes: { routine: 9, signal: 3, user_message: 2, external: 1, answer: 1 },
  outcomes: { nothing: 3, acted: 6, told_user: 4, asked: 1 },
  tasks_started: 3,
  tasks_merged: 2,
  input_tokens: 1_240_000,
  prompts_auto_approved: 5,
  ...extra,
});

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  mock.board = { board: null, events: [], status: { state: 'live' }, refresh() {} };
  mock.shell = {
    openSession: vi.fn(),
    setScreen: vi.fn(),
    setMemoryTab: vi.fn(),
  };
  runCommand.mockReset();
  runCommand.mockImplementation(async () => ({ ok: true, value: {} }));
  data.agents = [triage()];
  data.wakes = read([]);
  data.routines = read([]);
  data.ledger = read(week());
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const panel = () =>
  host(() => AgentProfilePanel({ projectId: 'alpha', agentId: 'agent-triage', onClose: () => {} }));
/** The part of the panel drawn by the component of that name, rendered on its own. */
const part = (name: string) => {
  const element = nodes(panel().value).find(
    (n) => typeof n.type === 'function' && n.type.name === name,
  )!;
  return host(() => (element.type as (props: unknown) => any)(element.props));
};
/** The section a visible caption names, through its aria-labelledby. */
const section = (tree: unknown, name: string) => {
  const caption = nodes(tree as never).find((n) => n.type === 'span' && text(n) === name);
  return nodes(tree as never).find(
    (n) => n.type === 'section' && caption && n.props['aria-labelledby'] === caption.props.id,
  );
};
const labelled = (tree: unknown, name: string) => {
  const label = nodes(tree as never).find((n) => n.type === 'label' && text(n) === name)!;
  return nodes(tree as never).find((n) => n.props.id === label.props.htmlFor && n !== label)!;
};
const named = (tree: unknown, name: string) =>
  nodes(tree as never).find((n) => n.props['aria-label'] === name);
const buttons = (tree: unknown) => nodes(tree as never).filter((n) => n.type === 'button');
const alerts = (tree: unknown) =>
  nodes(tree as never)
    .filter((n) => n.props.role === 'alert')
    .map(text);

describe('agent profile sections', () => {
  it('adds Contract, Recent wakes, Routine runs and This week after the instructions, in that order', () => {
    const tree = panel().value;
    const parts = nodes(tree)
      .filter((n) => typeof n.type === 'function')
      .map((n) => (n.type as { name: string }).name)
      .filter((name) =>
        ['AgentContract', 'RecentWakes', 'RoutineRuns', 'WeekLedger'].includes(name),
      );
    expect(parts).toEqual(['AgentContract', 'RecentWakes', 'RoutineRuns', 'WeekLedger']);
    const all = nodes(tree);
    const own = section(tree, zh('sessions.agents.field.instructions'))!;
    expect(all.indexOf(own)).toBeLessThan(
      all.findIndex((n) => (n.type as { name?: string }).name === 'AgentContract'),
    );
  });

  it.each([
    ['AgentContract', 'sessions.agents.contract.title'],
    ['RecentWakes', 'sessions.agents.wakes.title'],
    ['RoutineRuns', 'sessions.agents.runs.title'],
    ['WeekLedger', 'sessions.agents.week.title'],
  ])('names the %s section by its caption', (name, caption) => {
    expect(section(part(name).value, zh(caption))).toBeTruthy();
  });
});

describe('contract', () => {
  const update = () => runCommand.mock.calls.findLast((call) => call[0] === 'agent.update');

  it('saves a new weekly budget on blur and keeps the other limits', async () => {
    const h = part('AgentContract');
    const budget = () => labelled(h.value, zh('sessions.agents.contract.budget'));
    expect(budget().props.value).toBe('2000000');
    budget().props.onChange({ target: { value: '500000' } });
    h.render();
    budget().props.onBlur();
    await h.flush();
    expect(update()).toEqual([
      'agent.update',
      {
        agent_id: 'agent-triage',
        revision: 7,
        contract: {
          weekly_input_tokens: 500000,
          loudest: 'notify',
          quiet_hours: { from: '22:00', to: '08:00' },
        },
      },
      null,
    ]);
  });

  it('shows a refused budget under it and keeps what was typed', async () => {
    runCommand.mockImplementation(async () => ({
      ok: false,
      error: { code: 'invalid_input', message: 'Too small: expected number to be >0' },
    }));
    const h = part('AgentContract');
    const budget = () => labelled(h.value, zh('sessions.agents.contract.budget'));
    budget().props.onChange({ target: { value: '-5' } });
    h.render();
    budget().props.onBlur();
    await h.flush();
    expect(alerts(h.value).join()).toContain('Too small');
    expect(budget().props.value).toBe('-5');
    expect(budget().props['aria-invalid']).toBe(true);
  });

  it('saves the loudest way on choice, and shows Ask for an agent without a contract', async () => {
    data.agents = [triage({ contract: undefined })];
    const h = part('AgentContract');
    const group = nodes(h.value).find(
      (n) =>
        n.props.role === 'radiogroup' &&
        text(nodes(h.value).find((c) => c.props.id === n.props['aria-labelledby'])) ===
          zh('sessions.agents.contract.loudest'),
    )!;
    const radios = nodes(group).filter((n) => n.props.role === 'radio');
    expect(radios.map(text)).toEqual([
      zh('sessions.agents.contract.feed'),
      zh('sessions.agents.contract.notify'),
      zh('sessions.agents.contract.ask'),
    ]);
    expect(radios.map((n) => n.props['aria-checked'])).toEqual([false, false, true]);
    radios[0]!.props.onClick();
    await h.flush();
    expect(update()![1]).toEqual({
      agent_id: 'agent-triage',
      revision: 7,
      contract: { loudest: 'feed' },
    });
  });

  it('turns quiet hours off and on through its switch', async () => {
    const h = part('AgentContract');
    const toggle = () => named(h.value, zh('sessions.agents.contract.quiet'))!;
    expect(toggle().props.checked).toBe(true);
    expect(named(h.value, zh('sessions.agents.contract.quietFrom'))!.props.value).toBe('22:00');
    expect(named(h.value, zh('sessions.agents.contract.quietUntil'))!.props.value).toBe('08:00');
    toggle().props.onChange({ target: { checked: false } });
    await h.flush();
    expect(update()![1]).toEqual({
      agent_id: 'agent-triage',
      revision: 7,
      contract: { weekly_input_tokens: 2_000_000, loudest: 'notify' },
    });
  });

  it('saves changed quiet hours on blur', async () => {
    const h = part('AgentContract');
    const until = () => named(h.value, zh('sessions.agents.contract.quietUntil'))!;
    until().props.onChange({ target: { value: '07:30' } });
    h.render();
    until().props.onBlur();
    await h.flush();
    expect((update()![1] as any).contract.quiet_hours).toEqual({ from: '22:00', to: '07:30' });
  });

  it('sends a second quiet hours edit only once the first save returns, at the revision it made', async () => {
    let profile = triage();
    const contractOf = nodes(panel().value).find(
      (n) => typeof n.type === 'function' && n.type.name === 'AgentContract',
    )!.type as (props: unknown) => any;
    const h = host(() => contractOf({ profile }));
    let answer!: (result: unknown) => void;
    runCommand.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const end = (name: string) => named(h.value, zh(`sessions.agents.contract.${name}`))!;
    end('quietFrom').props.onChange({ target: { value: '21:00' } });
    h.render();
    end('quietFrom').props.onBlur();
    end('quietUntil').props.onChange({ target: { value: '07:30' } });
    h.render();
    end('quietUntil').props.onBlur();
    await h.flush();
    expect(runCommand.mock.calls.filter((call) => call[0] === 'agent.update')).toHaveLength(1);

    const saved = triage({
      revision: 8,
      contract: { ...triage().contract, quiet_hours: { from: '21:00', to: '08:00' } },
    });
    answer({ ok: true, value: saved });
    await h.flush();
    const sent = runCommand.mock.calls.filter((call) => call[0] === 'agent.update');
    expect(sent.map((call) => (call[1] as any).revision)).toEqual([7, 8]);
    expect((sent[1]![1] as any).contract.quiet_hours).toEqual({ from: '21:00', to: '07:30' });
    profile = saved;
    h.render();
    expect(end('quietUntil').props.value).toBe('07:30');
    expect(alerts(h.value)).toEqual([]);
  });

  it('shows what this week spent against the budget, and that wakes are held once it is spent', () => {
    data.ledger = read(week({ input_tokens: 1_240_000 }));
    let h = part('AgentContract');
    expect(
      named(h.value, zhf('sessions.agents.contract.spentMeter', { percent: 62 })),
    ).toBeTruthy();
    expect(text(h.value)).not.toContain(zh('sessions.agents.contract.held'));
    unmountAll();
    data.ledger = read(week({ input_tokens: 2_060_000 }));
    h = part('AgentContract');
    expect(
      named(h.value, zhf('sessions.agents.contract.spentMeter', { percent: 100 })),
    ).toBeTruthy();
    expect(text(h.value)).toContain(zh('sessions.agents.contract.held'));
  });

  it('shows the number alone without a budget', () => {
    data.agents = [triage({ contract: { loudest: 'ask' } })];
    const h = part('AgentContract');
    expect(labelled(h.value, zh('sessions.agents.contract.budget')).props.value).toBe('');
    expect(nodes(h.value).some((n) => String(n.props['aria-label'] ?? '').includes('%'))).toBe(
      false,
    );
    expect(text(h.value)).toContain('1.2M');
  });
});

describe('recent wakes', () => {
  const NOW = Date.now();
  const wake = (extra: object) => ({
    turn_id: 'turn-1',
    session_id: 'res-triage',
    at: NOW,
    state: 'completed',
    causes: ['routine'],
    routine_ids: ['r-bug'],
    usage: { input_tokens: 38_200 },
    outcome: 'acted',
    message_ids: ['m-1'],
    question_ids: [],
    actions: 2,
    messages: [{ id: 'm-1', text: 'Started a task for reconcile.diff' }],
    questions: [],
    tasks_started: 1,
    ...extra,
  });

  it('lists each wake with its causes, outcome and the first line of what it told or asked', () => {
    data.agents = [
      triage({
        routines: [{ id: 'r-bug', prompt: BUG_HUNT, every_ms: 21_600_000, enabled: true }],
      }),
    ];
    data.wakes = read([
      wake({}),
      wake({
        turn_id: 'turn-2',
        causes: ['signal', 'user_message'],
        routine_ids: undefined,
        outcome: 'asked',
        actions: 0,
        message_ids: [],
        messages: [],
        question_ids: ['q-1'],
        questions: [{ id: 'q-1', text: 'Should the flaky test get a task?' }],
      }),
      wake({
        turn_id: 'turn-3',
        state: 'failed',
        outcome: 'nothing',
        messages: [],
        causes: ['external'],
      }),
    ]);
    const h = part('RecentWakes');
    const rows = buttons(h.value);
    expect(rows).toHaveLength(3);
    const [opens] = zh('sessions.agents.wakes.open').split('{time}');
    expect(rows.every((n) => String(n.props['aria-label']).startsWith(opens!))).toBe(true);
    const first = text(rows[0]);
    expect(first).toContain(zh('sessions.agents.cause.routine'));
    expect(first).toContain(zh('sessions.agents.routineTemplate.bug-hunt'));
    expect(first).toContain(zh('sessions.agents.outcome.acted'));
    expect(first).toContain(zhf('sessions.agents.wakes.actions', { count: 2 }));
    expect(first).toContain('Started a task for reconcile.diff');
    const second = text(rows[1]);
    expect(second).toContain(zh('sessions.agents.cause.signal'));
    expect(second).toContain(zh('sessions.agents.cause.userMessage'));
    expect(second).toContain(zh('sessions.agents.outcome.asked'));
    expect(second).toContain('Should the flaky test get a task?');
    expect(text(rows[2])).toContain(zh('sessions.agents.wakeState.failed'));
    expect(
      nodes(rows[2]).some(
        (n) =>
          n.props.role === 'img' &&
          n.props['aria-label'] === zh('sessions.agents.wakeState.failed'),
      ),
    ).toBe(true);
    rows[1]!.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('res-triage');
  });

  it('says so when the agent has not woken yet', () => {
    expect(text(part('RecentWakes').value)).toContain(zh('sessions.agents.wakes.empty'));
  });

  it('shows a failed read with Retry', () => {
    data.wakes = read(null, { error: 'The daemon did not answer' });
    const h = part('RecentWakes');
    expect(alerts(h.value).join()).toContain('The daemon did not answer');
    nodes(h.value)
      .find((n) => n.type === 'button' && text(n) === zh('components.retry'))!
      .props.onClick();
    expect(data.wakes.reload).toHaveBeenCalled();
  });
});

describe('routine runs', () => {
  const row = (extra: object) => ({
    agent_id: 'agent-triage',
    agent_name: 'Triage',
    agent_revision: 7,
    routine: { id: 'r-bug', prompt: BUG_HUNT, every_ms: 21_600_000, enabled: true },
    next_run_at: Date.now() + 3_600_000,
    last_run: {
      turn_id: 'turn-1',
      at: Date.now() - 3_600_000,
      state: 'completed',
      outcome: 'acted',
    },
    ...extra,
  });
  const groups = (h: HookHost<any>) =>
    nodes(h.value).filter((n) => n.props.role === 'group' && n.props['aria-label']);

  it('lists each routine with its schedule and last run, and runs one now', async () => {
    data.routines = read([
      row({}),
      row({
        routine: {
          id: 'r-night',
          prompt: 'Nightly summary\nof the day',
          at: '09:00',
          enabled: false,
        },
        next_run_at: undefined,
        last_run: { turn_id: 'turn-2', at: Date.now(), state: 'running', outcome: 'nothing' },
      }),
    ]);
    const h = part('RoutineRuns');
    expect(groups(h).map((n) => n.props['aria-label'])).toEqual([
      zh('sessions.agents.routineTemplate.bug-hunt'),
      'Nightly summary',
    ]);
    const [bug, night] = groups(h);
    expect(text(bug)).toContain(zhf('sessions.agents.runs.everyHours', { count: 6 }));
    expect(text(bug)).toContain(zh('sessions.agents.outcome.acted'));
    expect(text(night)).toContain(zhf('sessions.agents.runs.daily', { time: '09:00' }));
    expect(text(night)).toContain(zh('sessions.agents.runs.paused'));
    expect(buttons(h.value).map(text)).toEqual([
      zh('sessions.agents.runs.runNow'),
      zh('sessions.agents.runs.runNow'),
    ]);
    expect(buttons(night)[0]!.props.disabled).toBe(true);
    expect(buttons(bug)[0]!.props.disabled).toBeFalsy();
    buttons(bug)[0]!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith(
      'agent.routine.run',
      { agent_id: 'agent-triage', routine_id: 'r-bug' },
      null,
    );
  });

  it('shows a refused run under its routine', async () => {
    runCommand.mockImplementation(async () => ({
      ok: false,
      error: { code: 'invalid_state', message: 'The runtime is signed out' },
    }));
    data.routines = read([row({})]);
    const h = part('RoutineRuns');
    buttons(groups(h)[0])[0]!.props.onClick();
    await h.flush();
    expect(alerts(groups(h)[0]).join()).toContain('The runtime is signed out');
  });

  it('says so when the agent has no routines', () => {
    expect(text(part('RoutineRuns').value)).toContain(zh('sessions.agents.runs.empty'));
  });
});

describe('this week', () => {
  it('counts the wakes by cause, what they came to, the tasks, tokens and prompts approved', () => {
    const shown = text(part('WeekLedger').value);
    expect(shown).toContain('14');
    expect(shown).toContain(`${zh('sessions.agents.cause.routine')}9`);
    expect(shown).toContain(`${zh('sessions.agents.cause.signal')}3`);
    expect(shown).toContain(`${zh('sessions.agents.cause.userMessage')}2`);
    expect(shown).toContain(`${zh('sessions.agents.week.other')}2`);
    for (const [n, id] of [
      [3, 'sessions.agents.outcome.nothing'],
      [6, 'sessions.agents.outcome.acted'],
      [4, 'sessions.agents.outcome.toldUser'],
      [1, 'sessions.agents.outcome.asked'],
      [2, 'sessions.agents.week.merged'],
    ] as const)
      expect(shown).toContain(`${n}${zh(id)}`);
    expect(shown).toContain(`3${zhf('sessions.agents.week.started', { count: 3 })}`);
    expect(shown).toContain(`1.2M${zh('sessions.agents.week.tokens')}`);
    expect(shown).toContain(`5${zhf('sessions.agents.week.approved', { count: 5 })}`);
  });

  it('says so when the agent did not wake this week', () => {
    data.ledger = read(week({ wakes: 0, causes: {} }));
    expect(text(part('WeekLedger').value)).toContain(zh('sessions.agents.week.empty'));
  });
});

describe('chapter mark', () => {
  const started = (payload: object) => ({
    sequence: 1,
    event_id: 'event-chapter',
    kind: 'agent.chapter_started',
    aggregate_id: 'res-triage-3',
    aggregate_revision: 1,
    project_id: 'alpha',
    causation_id: '',
    created_at: Date.now(),
    payload,
  });

  it('heads the thread of a rotated session instead of trailing it', () => {
    const event = started({ chapter: 3 });
    const view = buildTranscript([], [event as any]);
    expect(view.chapter).toBe(event);
    expect(view.loose.items).toEqual([]);
  });

  it('opens the line diff of the handoff note against the one it replaced', async () => {
    runCommand.mockImplementation(async (type: unknown) =>
      type === 'memory.get'
        ? {
            ok: true,
            value: { id: 'note-3', key: 'handoff/agent-triage', text: '## Open\n- a\n- b\n' },
          }
        : {
            ok: true,
            value: {
              items: [
                { id: 'note-3', text: '## Open\n- a\n- b\n' },
                { id: 'note-2', text: '## Open\n- old\n' },
              ],
            },
          },
    );
    const h = host(() =>
      ChapterMark({
        event: started({
          chapter: 3,
          handoff_memory_id: 'note-3',
          previous_memory_id: 'note-2',
        }) as any,
      }),
    );
    expect(text(h.value)).toContain(zhf('sessions.thread.chapter', { chapter: 3 }));
    expect(text(h.value)).toContain(zh('sessions.thread.handoffChanges'));
    nodes(h.value)
      .find((n) => typeof n.props.onOpenChange === 'function')!
      .props.onOpenChange(true);
    await h.flush();
    expect(runCommand.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['memory.get', { memory_id: 'note-3' }],
      ['memory.history', { project_id: 'alpha', key: 'handoff/agent-triage', limit: 50 }],
    ]);
    const popup = named(h.value, zh('sessions.thread.handoffDiff'))!;
    expect(text(popup)).toContain('+2');
    expect(text(popup)).toContain('−1');
    expect(text(popup)).toContain('- old');
    expect(named(popup, zh('sessions.thread.handoffClose'))).toBeTruthy();
  });

  it('opens a first handoff note in Memory, and offers nothing without a note', () => {
    let h = host(() =>
      ChapterMark({ event: started({ chapter: 2, handoff_memory_id: 'note-1' }) as any }),
    );
    const open = buttons(h.value).find((n) => text(n) === zh('sessions.thread.handoffNote'))!;
    open.props.onClick();
    expect(mock.shell.setScreen).toHaveBeenCalledWith('memory');
    h = host(() => ChapterMark({ event: started({ chapter: 4 }) as any }));
    expect(text(h.value)).toContain(zhf('sessions.thread.chapter', { chapter: 4 }));
    expect(buttons(h.value)).toEqual([]);
  });
});
