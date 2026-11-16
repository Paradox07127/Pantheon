import { afterEach, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {
    board: { session_turns: [] as any[], sessions: [] as any[] },
    events: [] as any[],
    status: { state: 'live' },
    cursor: 0,
  },
  history: { events: null as any[] | null, error: null as string | null, reload() {} },
  options: [] as any[],
  opened: [] as string[],
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/data/logs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEventHistory: (options: any) => {
    mock.options.push(options);
    return mock.history;
  },
}));
vi.mock('@/store', () => {
  const state = { openSession: (id: string) => mock.opened.push(id) };
  return { useShell: Object.assign((selector: any) => selector(state), { getState: () => state }) };
});
import { RecentActivity } from '@/components/RecentActivity';
import { zh } from './i18n-setup.js';

afterEach(() => {
  unmountAll();
  mock.options.length = 0;
  mock.opened.length = 0;
  mock.history.events = null;
  mock.history.error = null;
});

const session: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'Fix the parser',
  runtime: 'codex',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: null,
  workspace_kind: 'linked_worktree',
  state: 'merged',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
};

const show = () =>
  mount(() =>
    RecentActivity({
      projectId: 'project-a',
      sessions: [session],
      onOpen: (id) => mock.opened.push(id),
    }),
  );

it('shows merges that happened before the event stream connected and opens their session', () => {
  mock.history.events = [
    {
      sequence: 7,
      event_id: 'event-7',
      kind: 'session.merged',
      aggregate_id: 'session-a',
      aggregate_revision: 3,
      project_id: 'project-a',
      causation_id: '',
      created_at: Date.now() - 60_000,
      payload: {},
    },
  ];
  const h = show();
  expect(mock.options.at(-1)).toMatchObject({ project_id: 'project-a', after: 0 });
  expect(mock.options.at(-1).keep({ kind: 'agent.native' })).toBe(false);
  expect(mock.options.at(-1).keep({ kind: 'session.merged' })).toBe(true);
  expect(text(h.value)).toContain(zh('components.recentActivity.merged'));
  find(h.value, (n) => n.type === 'button' && text(n).includes(session.title)).props.onClick();
  expect(mock.opened).toEqual(['session-a']);
});

it('says the event history could not be read and retries it', () => {
  mock.history.error = 'history read failed';
  const reload = vi.spyOn(mock.history, 'reload');
  const alert = find(show().value, (n) => n.props.role === 'alert');
  expect(text(alert)).toContain('history read failed');
  find(alert, (n) => n.type === 'button').props.onClick();
  expect(reload).toHaveBeenCalled();
});
