import { expect, it } from 'vitest';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  externalSourceStatuses,
  pollExternalSources,
  type ExternalSource,
} from '../../packages/control/dist/external-sources.js';
import { eventually, fixture } from '../helpers.js';
import { createVirtualClock } from '../acceptance/lib/clock.mjs';

const MINUTE = 60_000;

/** A project that takes external events and sources that count their polls. */
async function sourceFixture(mode: 'approve' | null, ...sources: ExternalSource[]) {
  const clock = createVirtualClock(1700000000000),
    f = await fixture({ now: clock.now, controlOptions: { externalSources: sources } }),
    ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  if (mode)
    f.call('project.externalEvents.set', { project_id: f.project.id, mode }, f.project.revision);
  return {
    ...f,
    clock,
    poll: () => pollExternalSources(ctx),
    statuses: () => externalSourceStatuses(ctx),
  };
}
function counting(id: string, wait = MINUTE) {
  const source = {
    id,
    polls: [] as string[][],
    failure: undefined as string | undefined,
    async poll(_ctx: ControlContext, projects: { id: string }[]) {
      source.polls.push(projects.map((project) => project.id));
      if (source.failure) throw new Error(source.failure);
      return wait;
    },
  };
  return source;
}

it('polls a source with the projects that take external events, then waits the time the source asked for', async () => {
  const source = counting('mail', 5 * MINUTE),
    f = await sourceFixture('approve', source);
  try {
    await f.poll();
    expect(source.polls).toEqual([[f.project.id]]);
    f.clock.advance(4 * MINUTE);
    await f.poll();
    expect(source.polls).toHaveLength(1);
    f.clock.advance(MINUTE);
    await f.poll();
    expect(source.polls).toHaveLength(2);
    expect(f.statuses()).toEqual([{ id: 'mail', polled_at: f.clock.now() }]);
  } finally {
    await f.close();
  }
});

it('polls no source while no project takes external events', async () => {
  const source = counting('mail'),
    f = await sourceFixture(null, source);
  try {
    await f.poll();
    expect(source.polls).toEqual([]);
    expect(f.statuses()).toEqual([{ id: 'mail' }]);
  } finally {
    await f.close();
  }
});

it('keeps the error of a source that failed, polls the other sources, and asks the failed one again a minute later', async () => {
  const broken = counting('mail'),
    working = counting('github'),
    f = await sourceFixture('approve', broken, working);
  try {
    broken.failure = 'gh: not logged in';
    await f.poll();
    expect(working.polls).toHaveLength(1);
    expect(f.statuses()).toEqual([
      { id: 'mail', error: 'gh: not logged in' },
      { id: 'github', polled_at: f.clock.now() },
    ]);
    broken.failure = undefined;
    f.clock.advance(MINUTE);
    await f.poll();
    expect(broken.polls).toHaveLength(2);
    expect(f.statuses()[0]).toEqual({ id: 'mail', polled_at: f.clock.now() });
  } finally {
    await f.close();
  }
});

it('polls the sources from the daemon tick without waiting for them', async () => {
  const source = counting('mail'),
    f = await sourceFixture('approve', source);
  try {
    await eventually(
      () => source.polls.length === 1,
      () => f.control.tick(),
    );
  } finally {
    await f.close();
  }
});
