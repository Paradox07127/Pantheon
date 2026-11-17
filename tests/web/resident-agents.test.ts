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
import { Sidebar } from '@/components/Sidebar';
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
