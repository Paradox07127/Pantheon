import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, DeviceListItem } from '@pantheon/protocol';
import type { DevicesRead } from '@/data/devices';
const devices = vi.hoisted(() => ({ read: { state: 'loading' } as DevicesRead }));
vi.mock('@/data/devices', () => ({
  useDevices: () => ({ read: devices.read, reload: async () => {} }),
}));
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { TaskGroups } from '@/screens/board/TaskGroups';

type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 12, 12);

const task = (id: string, planned?: Task['planned']): Task =>
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
    dispatch_wait: 'device_resource',
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
    ...(planned && { planned }),
  }) as Task;

const row = (t: Task) =>
  renderToStaticMarkup(
    createElement(TaskGroups, { model: { tasks: [t], needs: [] }, onOpenTask() {} }),
  );

const drawer = (t: Task) =>
  renderToStaticMarkup(
    createElement(TaskDrawer, {
      model: {
        since: NOW - 86_400_000,
        now: NOW,
        lanes: [],
        edges: [],
        merges: [],
        milestones: [],
        tasks: [t],
        leads: [],
      } as unknown as BoardModel,
      taskId: t.id,
      onSelect() {},
      onOpenSession() {},
      onOpenStory() {},
    }),
  );

const sent = task('sent', {
  device: 'ws',
  device_reason: 'the benchmark needs a gpu',
  needs: ['gpu', 'docker'],
  uses: { gpu: 1, 'test-db': 2 },
});

describe('task row device', () => {
  it('shows the device a task is sent to', () => {
    expect(row(task('remote', { device: 'ws' }))).toContain('<span class="chip mono">ws</span>');
  });

  it('shows no device for a task on this computer', () => {
    expect(row(task('plain'))).not.toContain('chip mono');
    expect(row(task('here', { device: 'local' }))).not.toContain('chip mono');
  });

  it('says what the task waits for on the device, without the queued prefix', () => {
    const html = row(task('ws-gpu', { device: 'ws', uses: { gpu: 1 } }));
    expect(html).toContain('<span class="btl-why">等ws的gpu</span>');
    expect(html).not.toContain('排队中');
  });
});

describe('task drawer device state', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    devices.read = { state: 'loading' };
  });
  const ws: DeviceListItem = {
    id: 'ws',
    name: 'ws',
    ssh: 'ws.lan',
    labels: ['gpu', 'os=linux', 'arch=x86_64'],
    resources: { gpu: 1 },
    max_sessions: 2,
    online: true,
    checked_at: new Date(NOW).toISOString(),
    os: 'linux',
    os_version: 'Ubuntu 24.04',
    arch: 'x86_64',
    cpus: 32,
    runtimes: {},
    tools: {},
    load: {
      sessions: 1,
      uses: { gpu: 1 },
      active_sessions: [
        {
          id: 'session-9',
          title: 'refund idempotency',
          runtime: 'codex',
          started_at: new Date(NOW - 12 * 60_000).toISOString(),
        },
      ],
      resource_sessions: { gpu: ['session-9'] },
    },
  };

  it("shows the device's state and system, and which needs the device meets", () => {
    devices.read = { state: 'ready', devices: [ws] };
    const html = drawer(sent);
    expect(html).toContain(
      '<span class="bdv-dot" data-s="ok" role="img" aria-label="在线"></span><span class="chip mono">ws</span>',
    );
    expect(html).toContain(
      '<span class="bdv-sys"><span>Ubuntu 24.04</span><span>x86_64</span><span>32 核</span></span>',
    );
    expect(html).toContain(
      '<span class="chip"><span class="bdv-dot" data-s="ok" role="img" aria-label="设备有"></span>gpu</span>',
    );
    expect(html).toContain(
      '<span class="chip"><span class="bdv-dot" data-s="bad" role="img" aria-label="设备没有"></span>docker</span>',
    );
  });

  it('says the device cannot connect when it is offline', () => {
    devices.read = { state: 'ready', devices: [{ ...ws, online: false }] };
    const html = drawer(sent);
    expect(html).toContain('data-s="bad" role="img" aria-label="连不上"');
    expect(html).toContain('<span class="bdv-sys">连不上</span>');
  });

  it('draws each resource with its meter and total, and the sessions holding it', () => {
    devices.read = { state: 'ready', devices: [ws] };
    const html = drawer(sent);
    expect(html).toMatch(
      /<span class="mono">gpu<\/span><span class="bd-dnum">1<\/span><span class="meter bdv-meter" role="meter"[^>]*aria-label="ws 的 gpu：1 个里占用 1 个" data-full="true"><i style="--v:100%"><\/i><\/span><span class="bdv-n">1 \/ 1<\/span>/,
    );
    // A resource the device does not list gets no meter.
    expect(html).toMatch(/<span class="mono">test-db<\/span><span class="bd-dnum">2<\/span><\/li>/);
    expect(html).toContain('refund idempotency');
    expect(html).toContain('在用，跑了 12 分');
  });

  it('draws no holding sessions when the device names none for the resource', () => {
    const { resource_sessions: _, ...load } = ws.load;
    devices.read = { state: 'ready', devices: [{ ...ws, load }] };
    const html = drawer(sent);
    expect(html).toContain('1 / 1');
    expect(html).not.toContain('refund idempotency');
  });
});

describe('task drawer device', () => {
  it('shows the device, why it was chosen, what the task needs and what it uses', () => {
    const html = drawer(sent);
    expect(html).toContain('设备</h3>');
    expect(html).toContain('<span class="chip mono">ws</span>');
    expect(html).toContain('the benchmark needs a gpu');
    expect(html).toContain('需要</h3>');
    expect(html).toContain('<span class="chip">gpu</span>');
    expect(html).toContain('<span class="chip">docker</span>');
    expect(html).toContain('占用</h3>');
    expect(html).toMatch(/<span class="mono">gpu<\/span><span class="[^"]*">1<\/span>/);
    expect(html).toMatch(/<span class="mono">test-db<\/span><span class="[^"]*">2<\/span>/);
  });

  it('leaves the three sections out when the plan names none of them', () => {
    for (const t of [task('plain'), task('here', { device: 'local', needs: [], uses: {} })]) {
      const html = drawer(t);
      expect(html).not.toContain('设备</h3>');
      expect(html).not.toContain('需要</h3>');
      expect(html).not.toContain('占用</h3>');
    }
  });
});
