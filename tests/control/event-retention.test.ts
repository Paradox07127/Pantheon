import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../../packages/store/src/index.js';
import { startFixtureDaemon } from '../acceptance/lib/daemon.mjs';
import { subscribeEvents } from '../acceptance/lib/event-client.mjs';

function workspace() {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  return mkdtempSync(path.join(cache, 'event-retention-'));
}

it('keeps the retained boundary and later events across a reopen', () => {
  const root = workspace(),
    file = path.join(root, 'store.sqlite');
  let store = new Store(file);
  try {
    expect(store.eventHorizon()).toBe(1);
    const events = Array.from({ length: 4 }, (_, i) =>
      store.event('session.renamed', { id: `task-${i}`, revision: 1 }, 'project', { i }),
    );
    store.close();
    store = new Store(file);
    expect(store.eventHorizon()).toBe(1);
    store.pruneEvents(events[2]!.sequence);
    expect(store.events()).toEqual(events.slice(2));
    expect(store.eventHorizon()).toBe(events[2]!.sequence);
    store.close();
    store = new Store(file);
    expect(store.eventHorizon()).toBe(events[2]!.sequence);
    expect(store.events()).toEqual(events.slice(2));
    store.pruneEvents(1);
    expect(store.eventHorizon()).toBe(events[2]!.sequence);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves the cursor and next available sequence when pruning every event', () => {
  const root = workspace(),
    file = path.join(root, 'store.sqlite');
  let store = new Store(file);
  try {
    store.pruneEvents(100);
    expect(store.eventHorizon()).toBe(1);
    expect(store.cursor()).toBe(0);
    const event = store.event('session.renamed', { id: 'task', revision: 1 }, 'project', {});
    store.pruneEvents(event.sequence + 100);
    expect(store.events()).toEqual([]);
    expect(store.eventHorizon()).toBe(event.sequence + 1);
    expect(store.cursor()).toBe(event.sequence);
    store.close();
    store = new Store(file);
    expect(store.eventHorizon()).toBe(event.sequence + 1);
    expect(store.cursor()).toBe(event.sequence);
    store.pruneEvents(0);
    expect(store.eventHorizon()).toBe(event.sequence + 1);
    const next = store.event('session.renamed', { id: 'next-task', revision: 1 }, 'project', {});
    expect(next.sequence).toBe(event.sequence + 1);
    expect(store.events(event.sequence)).toEqual([next]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function retainedDaemon(root: string) {
  const current = await startFixtureDaemon(root, []);
  for (let i = 0; i < 3; i++) {
    const projectRoot = path.join(root, `project-${i}`);
    mkdirSync(projectRoot);
    await current.call('project.open', {
      name: `Retained project ${i}`,
      roots: [projectRoot],
    });
  }
  current.daemon.store.pruneEvents(3);
  return current;
}

it('requires an HTTP snapshot below the horizon and replays at its boundary', async () => {
  const root = workspace();
  let current: Awaited<ReturnType<typeof startFixtureDaemon>> | undefined;
  try {
    current = await retainedDaemon(root);
    const { daemon } = current;
    const read = async (after: number, project?: string) => {
      const query = new URLSearchParams({ after: String(after) });
      if (project) query.set('project_id', project);
      const response = await fetch(`${daemon.url}/v1/events?${query}`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const retained = daemon.store.events();
    for (const cursor of [0, 1, 4])
      expect(await read(cursor)).toEqual({ snapshot_required: true, cursor: 3, events: [] });
    expect(await read(2)).toEqual({ cursor: 3, events: retained });
    expect(await read(3)).toEqual({ cursor: 3, events: [] });
    expect(await read(2, retained[0]!.project_id)).toEqual({ cursor: 3, events: retained });
    expect(await read(2, 'other-project')).toEqual({ cursor: 3, events: [] });
    expect(await read(1, 'other-project')).toEqual({
      snapshot_required: true,
      cursor: 3,
      events: [],
    });
    daemon.store.pruneEvents(4);
    expect(await read(2)).toEqual({ snapshot_required: true, cursor: 3, events: [] });
    expect(await read(3)).toEqual({ cursor: 3, events: [] });
  } finally {
    await current?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires a WebSocket snapshot below the horizon and replays at its boundary', async () => {
  const root = workspace();
  let current: Awaited<ReturnType<typeof startFixtureDaemon>> | undefined;
  try {
    current = await retainedDaemon(root);
    const { daemon } = current;
    for (const cursor of [0, 1, 2, 3, 4]) {
      const client = await subscribeEvents(daemon, cursor);
      try {
        const first = await client.waitFor((frames: any[]) => frames[0]);
        if ([0, 1, 4].includes(cursor)) {
          expect(first).toEqual({ type: 'snapshot_required', cursor: 3 });
          expect(await client.closed).toEqual({ code: 1000, reason: '' });
          expect(client.frames).toHaveLength(1);
        } else {
          expect(first).toEqual({ type: 'subscribed', cursor });
          if (cursor === 2) {
            const event = await client.waitFor((frames: any[]) =>
              frames.find((frame) => frame.type === 'event'),
            );
            expect(event.event).toEqual(daemon.store.events()[0]);
          }
        }
      } finally {
        await client.close();
      }
    }
  } finally {
    await current?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
