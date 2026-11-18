import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import {
  deferred,
  type HookHost,
  mount as host,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
import { zh } from './i18n-setup.js';
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
  vi.fn(async (..._args: unknown[]): Promise<any> => ({ ok: true, value: { id: 'personal-1' } })),
);
vi.mock('@/data/commands', () => ({ runCommand }));
vi.mock('@/data/agents', async (actual) => ({
  ...(await actual<object>()),
  useAgents: () => null,
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', async (actual) => ({ ...(await actual<object>()), toast }));
import { Sidebar } from '@/components/Sidebar';
import { StateGlyph } from '@/components/SessionStateIcon';
import { currentProject } from '@/data/current-project';
import { failureText } from '@/data/needs-you';
import { visibleProjects } from '@/data/projects';
import { PersonalAgentScreen } from '@/screens/sessions/PersonalAgentScreen';

const AT = '2026-11-18T10:00:00.000Z';
const HOME = { id: 'home', revision: 1, name: 'Personal', roots: [], kind: 'personal' as const };
const ALPHA = { id: 'alpha', revision: 1, name: 'Alpha', roots: ['/work/alpha'] };
const session = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: AT,
  title: 'Personal',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: null,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: AT,
  changes: null,
  merge: null,
  resident: { kind: 'personal' },
  ...extra,
});

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { hasFocus: () => false, visibilityState: 'hidden' });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [ALPHA, HOME], workspaces: [], cursor: 1 },
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
    openPersonal: vi.fn(),
  };
  runCommand.mockClear();
  toast.mockClear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('the personal agent’s home project', () => {
  it('is left out of the visible projects, as a removed project is', () => {
    const listed: { id: string; removed_at?: number; kind?: 'personal' }[] = [
      ALPHA,
      HOME,
      { ...ALPHA, id: 'old', removed_at: 5 },
    ];
    expect(visibleProjects(listed).map((p) => p.id)).toEqual(['alpha']);
  });

  it('leaves the only real project the current one', () => {
    expect(currentProject(mock.board.board, null)?.id).toBe('alpha');
  });
});

const sidebar = (personal?: WorkbenchSession) =>
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
      projects: [ALPHA],
      currentProjectId: 'alpha',
      onChooseProject: () => {},
      list: { data: [], loading: false, error: null, reload() {} } as any,
      allNeeds: { items: [], error: null } as any,
      ...(personal ? { personal } : {}),
    }),
  );

const THIS_PROJECT = zh('components.sidebar.residents');
const PERSONAL_GROUP = zh('components.sidebar.personalGroup');
const PERSONAL = zh('components.sidebar.personalAgent');
const groupIndex = (h: HookHost<any>, name: string) =>
  nodes(h.value).findIndex((n) => n.props.role === 'group' && n.props['aria-label'] === name);
const personalRows = (h: HookHost<any>) =>
  nodes(nodes(h.value)[groupIndex(h, PERSONAL_GROUP)]!.props.children).filter(
    (n) => n.type === 'button',
  );
const personalRow = (h: HookHost<any>) => personalRows(h)[0]!;

describe('personal agent entry in a project’s sidebar', () => {
  it('names the groups 本项目 and 个人级 and the row 个人级智能体', () => {
    expect([THIS_PROJECT, PERSONAL_GROUP, PERSONAL]).toEqual(['本项目', '个人级', '个人级智能体']);
  });

  it('lists this project’s agents, then a Personal group with one Personal agent row', () => {
    const h = sidebar();
    expect(groupIndex(h, THIS_PROJECT)).toBeGreaterThan(-1);
    expect(groupIndex(h, PERSONAL_GROUP)).toBeGreaterThan(groupIndex(h, THIS_PROJECT));
    const rows = personalRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.props['aria-label']).toBe(
      [PERSONAL, zh('components.sidebar.residentNotStarted')].join(zh('sessions.screen.separator')),
    );
  });

  it('shows the state of the personal session on its row', () => {
    const h = sidebar(session('personal-1', { state: 'running' }));
    expect(personalRow(h).props['aria-label']).toBe(
      [PERSONAL, zh('components.sessionState.running')].join(zh('sessions.screen.separator')),
    );
  });

  it('opens the personal agent through resident.open, showing the row as starting until it answers', async () => {
    const answer = deferred<any>();
    runCommand.mockImplementationOnce(() => answer.promise);
    const h = sidebar();
    personalRow(h).props.onClick();
    h.render();
    expect(runCommand.mock.calls).toEqual([['resident.open', { kind: 'personal' }, null]]);
    expect(personalRow(h).props['aria-busy']).toBe(true);
    expect(
      nodes(personalRow(h).props.children).find((n) => n.type === StateGlyph)?.props.name,
    ).toBe('starting');
    expect(mock.shell.openPersonal).not.toHaveBeenCalled();
    answer.resolve({ ok: true, value: { id: 'personal-1' } });
    await h.flush();
    expect(mock.shell.openPersonal).toHaveBeenCalledWith('personal-1');
    h.render();
    expect(personalRow(h).props['aria-busy']).toBeUndefined();
  });

  it('marks the row current on the personal screen and keeps the project’s sidebar', () => {
    mock.shell.screen = 'personal';
    const h = sidebar(session('personal-1'));
    expect(personalRow(h).props['aria-current']).toBe(true);
    expect(groupIndex(h, THIS_PROJECT)).toBeGreaterThan(-1);
    expect(
      nodes(h.value).some((n) => n.type === 'button' && text(n) === zh('app.screenName.board')),
    ).toBe(true);
  });

  it('shows a refused open’s failure text and stays on the screen it was on', async () => {
    const error = { code: 'permission_denied', message: 'Only the user opens the personal agent' };
    runCommand.mockResolvedValueOnce({ ok: false, error });
    const h = sidebar();
    personalRow(h).props.onClick();
    await h.flush();
    expect(toast).toHaveBeenCalledWith({ title: failureText(error), kind: 'failure' });
    expect(mock.shell.openPersonal).not.toHaveBeenCalled();
    h.render();
    expect(personalRow(h).props['aria-busy']).toBeUndefined();
  });
});

describe('personal agent conversation', () => {
  const needs = { items: [], loading: false, error: null, reload() {} };
  const screen = (data: WorkbenchSession[] | null) =>
    host(() =>
      PersonalAgentScreen({
        needs,
        list: { data, loading: data === null, error: null, reload() {} } as any,
      }),
    );

  it('shows the newest open personal session under a bar named Personal agent with an All projects chip', () => {
    mock.board.board.sessions = [{ id: 'personal-2', project_id: 'home', revision: 1 }];
    const h = screen([
      session('personal-1', { archived_at: AT }),
      session('personal-2', { created_at: '2026-11-18T11:00:00.000Z' }),
    ]);
    const thread = named(h.value, 'Thread');
    expect(thread.props.sessionId).toBe('personal-2');
    // The composer and the thread name the agent as the bar does.
    expect(thread.props.listed.title).toBe(zh('app.screenName.personal'));
    const head = nodes(thread.props.head);
    expect(text(head.find((n) => n.type === 'h1'))).toBe('个人级智能体');
    expect(head.some((n) => n.props.className === 'chip' && text(n) === '全部项目')).toBe(true);
  });

  it('keeps the bar while the session list loads', () => {
    const h = screen(null);
    expect(nodes(h.value).some((n) => (n.type as { name?: string }).name === 'Thread')).toBe(false);
    expect(text(nodes(h.value).find((n) => n.type === 'h1'))).toBe(zh('app.screenName.personal'));
    expect(nodes(h.value).some((n) => n.props['aria-busy'] === 'true')).toBe(true);
  });
});
