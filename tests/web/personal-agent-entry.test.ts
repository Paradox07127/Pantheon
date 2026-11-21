import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { type HookHost, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
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
import { currentProject } from '@/data/current-project';
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
    screen: 'sessions',
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

const sidebar = ({ projects = [ALPHA], items = [] as unknown[] } = {}) =>
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
      projects,
      currentProjectId: 'alpha',
      onChooseProject: () => {},
      list: { data: [], loading: false, error: null, reload() {} } as any,
      allNeeds: { items, error: null } as any,
    }),
  );

describe('a project’s sidebar', () => {
  const waiting = (project_id: string, id: string) => ({
    source: { table: 'approvals', id, revision: 1 },
    kind: 'permission',
    project_id,
    session_id: `${id}-session`,
    status: 'pending',
    created_at: 0,
    reason: 'permission_requested',
    actions: [],
  });

  it('has no personal agent row and no group of agents, also while other projects wait', () => {
    const h = sidebar({ items: [waiting('alpha', 'a-1'), waiting('home', 'h-1')] });
    const tree = nodes(h.value);
    expect(tree.filter((n) => n.props.role === 'group')).toEqual([]);
    expect(tree.filter((n) => String(n.props['data-stop'] ?? '').startsWith('resident:'))).toEqual(
      [],
    );
    expect(
      tree.filter(
        (n) => text(n).includes('个人级') || String(n.props['aria-label'] ?? '').includes('个人级'),
      ),
    ).toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('marks the project menu only for what waits in a visible project', () => {
    const dot = (h: HookHost<any>) =>
      nodes(h.value).some(
        (n) => n.props.className === 'sb-dot' && n.props['aria-label'] === ATTENTION,
      );
    const ATTENTION = zh('components.sidebar.attention');
    expect(dot(sidebar({ items: [waiting('home', 'h-1')] }))).toBe(false);
    expect(dot(sidebar({ items: [waiting('alpha', 'a-1')] }))).toBe(true);
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
