import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Entity, Project, Workspace } from '@pantheon/domain';
import type { BridgeResult, EventFrame } from '@pantheon/protocol';
import type { Table } from '@pantheon/store';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { registerInPlaceWorkspace } from '../../packages/control/dist/workspace.js';
import { startSync, type SyncView } from '@/data/sync';
import { fixture, user } from '../helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

const TABLES = [
  'project_briefs',
  'milestones',
  'sessions',
  'session_turns',
  'workspaces',
  'reviews',
] as const satisfies readonly Table[];

it('merges the board read of each project an event names into the same board a read of every project gives', async () => {
  const f = await fixture();
  const secondRoot = path.join(f.root, 'second');
  mkdirSync(secondRoot);
  const second = await f.call<Promise<Project>>('project.open', {
    name: 'second',
    roots: [secondRoot],
  });
  const insert = (table: Table, project_id: string, name: string) =>
    f.store.insert<Entity & { project_id: string }>(table, {
      id: `${project_id}-${name}`,
      revision: 1,
      project_id,
    });
  for (const project of [f.project, second])
    for (const table of TABLES) {
      insert(table, project.id, `${table}-a`);
      insert(table, project.id, `${table}-b`);
    }

  vi.useFakeTimers();
  const asked: (string | undefined)[] = [];
  let push!: (frame: EventFrame) => void;
  const views: SyncView[] = [];
  // Answers as the daemon does, a JSON copy of what it reads now.
  const read = (project_id?: string) =>
    JSON.parse(JSON.stringify(f.control.snapshot(user, project_id)));
  const sync = startSync(
    {
      query: async (_method, params): Promise<BridgeResult<unknown>> => {
        asked.push(params?.project_id as string | undefined);
        return { ok: true, value: read(params?.project_id as string | undefined) };
      },
      subscribe: (_options, listener) => {
        push = listener;
        return () => {};
      },
    },
    {},
    (view) => views.push(view),
  );
  let delivered = f.store.cursor();
  const announce = async (...projects: Project[]) => {
    for (const project of projects)
      f.store.event(
        'session.renamed',
        { id: `${project.id}-sessions-a`, revision: 1 },
        project.id,
        {},
      );
    for (const event of f.store.events(delivered)) push({ type: 'event', event });
    delivered = f.store.cursor();
    await vi.advanceTimersByTimeAsync(100);
  };
  try {
    await vi.advanceTimersByTimeAsync(0);
    push({ type: 'subscribed', cursor: delivered });

    // One project's rows change in place, one is added and one removed, and the project itself changes.
    const session = f.store.must<Entity>('sessions', `${second.id}-sessions-b`);
    f.store.update('sessions', { ...session, revision: 2, title: 'renamed' }, 1);
    insert('session_turns', second.id, 'added');
    f.store.remove('milestones', `${second.id}-milestones-a`, 1);
    const project = f.store.must<Project>('projects', second.id);
    f.store.update(
      'projects',
      { ...project, revision: project.revision + 1, name: 'renamed' },
      project.revision,
    );
    await announce(second);
    expect(views.at(-1)!.board).toEqual(read());

    // Both projects change in one read.
    insert('workspaces', f.project.id, 'added');
    insert('reviews', second.id, 'added');
    f.store.remove('sessions', `${f.project.id}-sessions-b`, 1);
    await announce(f.project, second);
    expect(views.at(-1)!.board).toEqual(read());

    // A removed project's in-place workspace moves to the project that holds its folder now, and
    // only that project's event names it.
    const goneRoot = path.join(f.root, 'gone');
    mkdirSync(goneRoot);
    const gone = await f.call<Promise<Project>>('project.open', {
      name: 'gone',
      roots: [goneRoot],
    });
    const folder = path.join(f.projectRoot, 'folder');
    mkdirSync(folder);
    f.store.insert<Workspace>('workspaces', {
      id: 'moved-workspace',
      revision: 1,
      project_id: gone.id,
      kind: 'in_place',
      path: realpathSync(folder),
      source: realpathSync(goneRoot),
      owner: 'none',
      ownership_epoch: 0,
    });
    await announce(gone);
    f.call(
      'project.remove',
      { project_id: gone.id },
      f.store.must<Project>('projects', gone.id).revision,
    );
    await announce();
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    ctx.store.transaction(() =>
      registerInPlaceWorkspace(ctx, { project_id: f.project.id, cwd: folder }, ''),
    );
    await announce();
    expect(views.at(-1)!.board).toEqual(read());

    // A project and all of its rows go away.
    for (const table of TABLES)
      for (const row of f.store.list<Entity & { project_id: string }>(table))
        if (row.project_id === second.id) f.store.remove(table, row.id, row.revision);
    f.store.remove('projects', second.id, f.store.must<Project>('projects', second.id).revision);
    await announce(second);
    expect(views.at(-1)!.board).toEqual(read());

    expect(asked).toEqual([
      undefined,
      second.id,
      f.project.id,
      second.id,
      gone.id,
      gone.id,
      f.project.id,
      second.id,
    ]);
  } finally {
    sync.stop();
    vi.useRealTimers();
    await f.close();
  }
});
