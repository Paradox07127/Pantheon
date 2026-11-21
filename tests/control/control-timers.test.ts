import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Control,
  scheduleTimer,
  cancelTimer,
  fireDueTimers,
  timerHandlers,
} from '@pantheon/control';
import type { Project, Timer } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import { fixture } from '../helpers.js';
import { createVirtualClock } from '../acceptance/lib/clock.mjs';
import { startFixtureDaemon } from '../acceptance/lib/daemon.mjs';

function context(control: Control): ControlContext {
  return {
    store: control.store,
    files: control.files,
    managedWorkspaceRoots: [],
    adapters: control.adapters,
    readProcess: () => undefined,
    handles: control.handles,
    completions: new Set(),
    cancelling: new Map(),
    endTurns: new Map(),
    idleConversations: new Map(),
    runtimeStatus: new Map(),
    runtimeModels: new Map(),
    toolRelays: new Map(),
    localCommand: async () => ({ stdout: '', stderr: '', exit_code: 0 }),
    failpoint: control.failpoint,
    busy: false,
    closing: false,
    changed: () => {},
    diagnostic: () => {},
  };
}

async function timerFixture() {
  const clock = createVirtualClock(1700000000000),
    f = await fixture({ now: clock.now });
  return {
    ...f,
    clock,
    ctx: context(f.control),
    input: {
      id: `project-reminder:${f.project.id}`,
      project_id: f.project.id,
      kind: 'project-reminder',
      subject_id: f.project.id,
      due_at: clock.now() + 1000,
    },
  };
}

afterEach(() => timerHandlers.clear());

it('fires every due timer once with its handler writes and a revisioned event', async () => {
  const f = await timerFixture();
  try {
    const handler = vi.fn((ctx: ControlContext, timer: Timer) => {
      const project = ctx.store.must<Project>('projects', timer.subject_id);
      ctx.store.update('projects', { ...project, name: timer.id }, project.revision);
    });
    timerHandlers.set(f.input.kind, handler);
    const first = scheduleTimer(f.ctx, f.input),
      second = scheduleTimer(f.ctx, {
        ...f.input,
        id: 'another-reminder',
        due_at: f.input.due_at - 1,
      });
    f.clock.advance(1000);
    fireDueTimers(f.ctx);
    fireDueTimers(f.ctx);
    expect(handler).toHaveBeenCalledTimes(2);
    for (const timer of [first, second]) {
      expect(f.store.must<Timer>('timers', timer.id)).toEqual({
        ...timer,
        revision: 2,
        state: 'fired',
        fired_at: f.clock.now(),
      });
      expect(f.store.events().filter((event) => event.aggregate_id === timer.id)).toEqual([
        expect.objectContaining({
          kind: 'timer.fired',
          aggregate_revision: 2,
          project_id: timer.project_id,
          created_at: f.clock.now(),
        }),
      ]);
    }
    expect(f.store.must<Project>('projects', f.project.id)).toMatchObject({
      name: second.id,
      revision: f.project.revision + 2,
    });
  } finally {
    await f.close();
  }
});

it('leaves a timer pending until the injected clock reaches its deadline', async () => {
  const f = await timerFixture();
  try {
    const handler = vi.fn();
    timerHandlers.set(f.input.kind, handler);
    const timer = scheduleTimer(f.ctx, f.input);
    f.clock.advance(999);
    fireDueTimers(f.ctx);
    expect(handler).not.toHaveBeenCalled();
    expect(f.store.must<Timer>('timers', timer.id)).toEqual(timer);
    expect(f.store.events().filter((event) => event.kind === 'timer.fired')).toEqual([]);
    f.clock.advance(1);
    fireDueTimers(f.ctx);
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('keeps the original timer unchanged when its stable key is scheduled again', async () => {
  const f = await timerFixture();
  try {
    timerHandlers.set(f.input.kind, () => {});
    const timer = scheduleTimer(f.ctx, f.input),
      replacement = {
        ...f.input,
        project_id: 'another-project',
        kind: 'another-kind',
        subject_id: 'another-subject',
        due_at: f.clock.now(),
      };
    expect(scheduleTimer(f.ctx, replacement)).toEqual(timer);
    f.clock.advance(1000);
    fireDueTimers(f.ctx);
    const fired = f.store.must<Timer>('timers', timer.id);
    expect(scheduleTimer(f.ctx, replacement)).toEqual(fired);
    expect(fired.state).toBe('fired');
    expect(f.store.list('timers')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('cancels pending timers and leaves missing or terminal timers unchanged', async () => {
  const f = await timerFixture();
  try {
    const handler = vi.fn();
    timerHandlers.set(f.input.kind, handler);
    const timer = scheduleTimer(f.ctx, f.input);
    cancelTimer(f.ctx, 'missing-timer');
    cancelTimer(f.ctx, timer.id);
    cancelTimer(f.ctx, timer.id);
    expect(f.store.must<Timer>('timers', timer.id)).toEqual({
      ...timer,
      revision: 2,
      state: 'cancelled',
    });
    expect(scheduleTimer(f.ctx, f.input).state).toBe('cancelled');
    f.clock.advance(1000);
    fireDueTimers(f.ctx);
    expect(handler).not.toHaveBeenCalled();
    expect(f.store.events().filter((event) => event.kind === 'timer.fired')).toEqual([]);
    const other = scheduleTimer(f.ctx, { ...f.input, id: 'uncancelled-reminder' });
    fireDueTimers(f.ctx);
    const fired = f.store.must<Timer>('timers', other.id);
    cancelTimer(f.ctx, other.id);
    expect(f.store.must<Timer>('timers', other.id)).toEqual(fired);
    expect(f.store.list('timers')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

it('rolls back handler writes, events and outbox on failure and retries the pending timer', async () => {
  const f = await timerFixture();
  try {
    let fail = true;
    timerHandlers.set(f.input.kind, (ctx, timer) => {
      const project = ctx.store.must<Project>('projects', timer.subject_id),
        next = ctx.store.update('projects', { ...project, name: 'reminded' }, project.revision);
      ctx.store.event('project.reminded', next, project.id, {});
      ctx.store.enqueue('reminder.deliver', { project_id: project.id });
      if (fail) throw new Error('Reminder failed');
    });
    const timer = scheduleTimer(f.ctx, f.input),
      cursor = f.store.cursor();
    f.clock.advance(1000);
    await expect(f.control.tick()).rejects.toThrow('Reminder failed');
    expect(f.store.must<Timer>('timers', timer.id)).toEqual(timer);
    expect(f.store.must<Project>('projects', f.project.id)).toEqual(f.project);
    expect(f.store.cursor()).toBe(cursor);
    expect(f.store.pending()).toEqual([]);
    fail = false;
    await f.control.tick();
    await f.control.tick();
    expect(f.store.must<Timer>('timers', timer.id)).toMatchObject({ state: 'fired', revision: 2 });
    expect(f.store.must<Project>('projects', f.project.id)).toMatchObject({
      name: 'reminded',
      revision: f.project.revision + 1,
    });
    expect(f.store.events(cursor).map((event) => event.kind)).toEqual([
      'project.reminded',
      'timer.fired',
    ]);
    // The tick marks an outbox kind nothing handles done, so read the row itself.
    expect(
      f.store.db.prepare("SELECT id FROM outbox WHERE kind='reminder.deliver'").all(),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('keeps firing other timers when one timer handler throws', async () => {
  const f = await timerFixture();
  try {
    timerHandlers.set('broken-reminder', () => {
      throw new Error('Reminder failed');
    });
    timerHandlers.set(f.input.kind, () => {});
    const broken = scheduleTimer(f.ctx, { ...f.input, id: 'a-broken', kind: 'broken-reminder' }),
      healthy = scheduleTimer(f.ctx, { ...f.input, id: 'b-healthy' });
    f.clock.advance(1000);
    await expect(f.control.tick()).rejects.toThrow('Reminder failed');
    expect(f.store.must<Timer>('timers', broken.id).state).toBe('pending');
    expect(f.store.must<Timer>('timers', healthy.id).state).toBe('fired');
  } finally {
    await f.close();
  }
});

it('allows scheduling and cancellation inside the caller transaction', async () => {
  const f = await timerFixture();
  try {
    expect(() =>
      f.store.transaction(() => {
        scheduleTimer(f.ctx, f.input);
        throw new Error('Command failed');
      }),
    ).toThrow('Command failed');
    expect(f.store.list('timers')).toEqual([]);
    const timer = f.store.transaction(() => scheduleTimer(f.ctx, f.input));
    expect(() =>
      f.store.transaction(() => {
        cancelTimer(f.ctx, timer.id);
        throw new Error('Command failed');
      }),
    ).toThrow('Command failed');
    expect(f.store.must<Timer>('timers', timer.id)).toEqual(timer);
    f.store.transaction(() => cancelTimer(f.ctx, timer.id));
    expect(f.store.must<Timer>('timers', timer.id).state).toBe('cancelled');
  } finally {
    await f.close();
  }
});

it('rechecks pending state when an earlier handler cancels another due timer', async () => {
  const f = await timerFixture();
  try {
    const handler = vi.fn((ctx: ControlContext) => cancelTimer(ctx, 'later-reminder'));
    timerHandlers.set(f.input.kind, handler);
    scheduleTimer(f.ctx, f.input);
    scheduleTimer(f.ctx, { ...f.input, id: 'later-reminder' });
    f.clock.advance(1000);
    fireDueTimers(f.ctx);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.store.must<Timer>('timers', 'later-reminder').state).toBe('cancelled');
    expect(f.store.events().filter((event) => event.kind === 'timer.fired')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('cancels a due timer of a kind no handler takes and never fires it later', async () => {
  const f = await timerFixture();
  try {
    const timer = scheduleTimer(f.ctx, f.input);
    f.clock.advance(1000);
    fireDueTimers(f.ctx);
    expect(f.store.must<Timer>('timers', timer.id)).toEqual({
      ...timer,
      revision: 2,
      state: 'cancelled',
    });
    const handler = vi.fn();
    timerHandlers.set(f.input.kind, handler);
    fireDueTimers(f.ctx);
    expect(handler).not.toHaveBeenCalled();
    expect(f.store.events().filter((event) => event.kind === 'timer.fired')).toEqual([]);
  } finally {
    await f.close();
  }
});

it('fires timers on control ticks without duplicating them on overlapping ticks', async () => {
  const f = await timerFixture();
  try {
    const handler = vi.fn();
    timerHandlers.set(f.input.kind, handler);
    scheduleTimer(f.ctx, f.input);
    f.clock.advance(1000);
    await Promise.all([f.control.tick(), f.control.tick(), f.control.tick()]);
    await f.control.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.store.events().filter((event) => event.kind === 'timer.fired')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('fires a timer overdue during downtime on the first restart tick and never on a second restart', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-timer-')),
    clock = createVirtualClock(1700000000000);
  mkdirSync(path.join(root, 'project'));
  let f = await startFixtureDaemon(root, [], { now: clock.now });
  try {
    const project = await f.call('project.open', {
      name: 'reminder project',
      roots: [path.join(root, 'project')],
    });
    const timer = scheduleTimer(context(f.daemon.control), {
      id: `project-reminder:${project.id}`,
      project_id: project.id,
      kind: 'project-reminder',
      subject_id: project.id,
      due_at: clock.now() + 3600000,
    });
    const handler = vi.fn((ctx: ControlContext, due: Timer) => {
      const current = ctx.store.must<Project>('projects', due.subject_id);
      ctx.store.update('projects', { ...current, name: 'reminded' }, current.revision);
    });
    timerHandlers.set(timer.kind, handler);
    await f.daemon.control.tick();
    expect(handler).not.toHaveBeenCalled();
    await f.close();
    clock.advance(3600001);
    f = await startFixtureDaemon(root, [], { now: clock.now });
    expect(f.daemon.store.must<Timer>('timers', timer.id)).toEqual(timer);
    await f.daemon.control.tick();
    const fired = f.daemon.store.must<Timer>('timers', timer.id),
      events = f.daemon.store.events().filter((event) => event.kind === 'timer.fired');
    expect(fired).toEqual({ ...timer, state: 'fired', revision: 2, fired_at: clock.now() });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    await f.close();
    f = await startFixtureDaemon(root, [], { now: clock.now });
    await f.daemon.control.tick();
    await f.daemon.control.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.daemon.store.must<Timer>('timers', timer.id)).toEqual(fired);
    expect(f.daemon.store.events().filter((event) => event.kind === 'timer.fired')).toEqual(events);
    expect(f.daemon.store.must<Project>('projects', project.id)).toMatchObject({
      name: 'reminded',
      revision: project.revision + 1,
    });
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
