import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { SessionTask } from '@pantheon/domain';
import { type HookHost, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
import { MonitorPanel } from '@/screens/sessions/MonitorPanel';
import { zh } from './i18n-setup.js';

const task = (id: string, extra: Partial<SessionTask>): SessionTask => ({
  id,
  session_id: 'session-a',
  kind: 'agent',
  description: `describe ${id}`,
  background: false,
  state: 'running',
  started_at: 1_000,
  ...extra,
});

let tasks: SessionTask[];

beforeEach(() => {
  vi.useFakeTimers();
  tasks = [];
  mock.board = {
    board: { sessions: [{ id: 'session-a', runtime: 'claude' }] },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = { showRuns: vi.fn() };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async () => ({ ok: true, value: { cursor: 3, tasks } })),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const rows = (h: HookHost<any>) =>
  nodes(h.value)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'TaskRow')
    .map((n) => [n.props.description, n.props.state]);
const button = (h: HookHost<any>, id: string) =>
  nodes(h.value).find((n) => n.type === 'button' && text(n) === zh(id)) as ReactElement<any>;

async function panel() {
  const h = mount(() => MonitorPanel({ sessionId: 'session-a' }));
  await h.flush();
  return h;
}

it('lists the running tasks before the finished ones, agents and background commands alike', async () => {
  tasks = [
    task('explore', { state: 'completed', ended_at: 4_000 }),
    task('tests', { kind: 'shell', background: true }),
    task('lint', { kind: 'shell', background: true, state: 'failed', ended_at: 5_000 }),
    task('review', { agent_type: 'reviewer' }),
  ];
  const h = await panel();
  expect(rows(h)).toEqual([
    ['describe tests', 'running'],
    ['describe review', 'running'],
    ['describe explore', 'ok'],
    ['describe lint', 'failed'],
  ]);
  expect(
    nodes(h.value)
      .filter((n) => n.type === 'section')
      .map((n) => n.props['aria-label']),
  ).toEqual([
    zh('sessions.panel.monitor.runningGroup'),
    zh('sessions.panel.monitor.finishedGroup'),
  ]);
});

it('hides the finished rows once the user clears them and keeps the running ones', async () => {
  tasks = [
    task('explore', { state: 'completed', ended_at: 4_000 }),
    task('tests', { kind: 'shell', background: true }),
  ];
  const h = await panel();
  button(h, 'sessions.panel.monitor.clearFinished').props.onClick();
  await h.flush();
  expect(rows(h)).toEqual([['describe tests', 'running']]);
  expect(button(h, 'sessions.panel.monitor.clearFinished').props.disabled).toBe(true);
});

it('says in one sentence that the session has no tasks and opens its runs', async () => {
  const h = await panel();
  expect(rows(h)).toEqual([]);
  expect(nodes(h.value).some((n) => text(n) === zh('sessions.panel.monitor.empty'))).toBe(true);
  button(h, 'sessions.panel.monitor.openRuns').props.onClick();
  expect(mock.shell.showRuns).toHaveBeenCalledExactlyOnceWith('session-a');
});
