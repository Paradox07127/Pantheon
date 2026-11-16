import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { mount, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      setState: (patch: object) => Object.assign(state(), patch),
    }),
);
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
import { Sidebar } from '@/components/Sidebar';

const session = (id: string): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
});

beforeEach(() => {
  mock.board = { board: null, status: { state: 'live' } };
  mock.shell = { screen: 'board', sessionId: null, sessionGroup: null };
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function order(data: WorkbenchSession[] | null) {
  const h = mount(() =>
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
      list: { data, loading: false, error: 'read failed', reload() {} } as any,
      allNeeds: { items: [] } as any,
    }),
  );
  return nodes(h.value).flatMap((n) =>
    n.props.role === 'alert'
      ? ['error']
      : typeof n.type === 'function' && n.type.name === 'SessionListRow'
        ? [n.props.session.id]
        : [],
  );
}

it.each([
  [
    'puts the read error below the sessions kept from the last read',
    [session('one'), session('two')],
    ['one', 'two', 'error'],
  ],
  ['shows the read error alone when no read has gone through yet', null, ['error']],
])('%s', (_name, data, shown) => {
  expect(order(data)).toEqual(shown);
});
