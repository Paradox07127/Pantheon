import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import { activityLine, taskBadges } from '@/screens/board/activity';
import { TaskList } from '@/screens/board/TaskList';
import { zh } from './i18n-setup.js';

const queuedText = (key: string, values: Record<string, string> = {}) =>
  Object.entries(values).reduce(
    (said, [name, value]) => said.replace(`{${name}}`, value),
    zh(`daemon.blocker.queued.${key}`),
  );

type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 12, 12);

const queued = (id: string, wait: Task['dispatch_wait']): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
    goal: '',
    scope: [],
    lane_id: null,
    milestone_id: null,
    status: 'todo',
    state: 'todo',
    dispatch_wait: wait,
    blockers: ['Queued'],
    blocker_codes: [{ code: 'queued' }],
    segments: [],
    additions: null,
    deletions: null,
    checks: 'none',
    started_at: null,
    ended_at: null,
    last_progress_at: null,
    blocked_since: null,
    turn_running: false,
    activity: { phase: 'queued', since: NOW, health: 'fresh', attempt: 1 },
  }) as Task;

const list = (tasks: Task[]) =>
  renderToStaticMarkup(
    createElement(TaskList, { model: { tasks, needs: [], now: NOW }, onOpenTask() {}, bar: null }),
  );

const paused = queued('paused', 'paused');
const full = queued('full', 'runtime_capacity');

describe('dispatch paused and runtime capacity waits', () => {
  it('words both on the flow node and the progress table', () => {
    expect(activityLine(paused, NOW)).toContain(queuedText('paused'));
    expect(activityLine(full, NOW)).toContain(queuedText('runtimeCapacity'));
    expect(taskBadges(paused).map((b) => b.label)).toContain(queuedText('paused'));
    expect(taskBadges(full).map((b) => b.label)).toContain(queuedText('runtimeCapacity'));
  });

  it('words both in the task list', () => {
    const html = list([paused, full]);
    expect(html).toContain(queuedText('paused'));
    expect(html).toContain(queuedText('runtimeCapacity'));
  });
});

describe('device waits', () => {
  const on = (task: Task, planned: Task['planned']): Task => ({ ...task, planned });
  const here = { device: zh('daemon.blocker.queued.thisComputer') };
  const ws = { device: 'ws' };
  const waits = [
    [queued('offline', 'device_offline'), queuedText('deviceOffline', here)],
    [queued('busy', 'device_capacity'), queuedText('deviceCapacity', here)],
    [queued('gpu', 'device_resource'), queuedText('deviceResource')],
    [on(queued('here', 'device_offline'), { device: 'local' }), queuedText('deviceOffline', here)],
    [on(queued('ws-offline', 'device_offline'), ws), queuedText('deviceOffline', ws)],
    [on(queued('ws-busy', 'device_capacity'), ws), queuedText('deviceCapacity', ws)],
    [
      on(queued('ws-gpu', 'device_resource'), { device: 'ws', uses: { gpu: 1, docker: 2 } }),
      queuedText('deviceResources', { device: 'ws', resources: 'gpu, docker' }),
    ],
    [on(queued('ws-any', 'device_resource'), ws), queuedText('deviceResource')],
  ] as const;

  it('words each on the flow node and the progress table, without the queued prefix', () => {
    for (const [task, text] of waits) {
      expect(activityLine(task, NOW)).toBe(text);
      expect(taskBadges(task).map((b) => b.label)).toContain(text);
    }
  });

  it('words each in the task list', () => {
    const html = list(waits.map(([task]) => task));
    for (const [, text] of waits) expect(html).toContain(text);
    expect(html).not.toContain('排队中');
  });
});
