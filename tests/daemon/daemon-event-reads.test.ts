import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '@pantheon/daemon';
import { FixtureAdapter } from '@pantheon/adapters';
import { command } from '@pantheon/protocol';
import { eventually, user } from '../helpers.js';
import type { Project, Session } from '@pantheon/domain';

async function eventFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-event-reads-'));
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [new FixtureAdapter()],
  });
  const headers = { Authorization: `Bearer ${daemon.token}` };
  const open = async (name: string) => {
    mkdirSync(path.join(root, name));
    return (await daemon.control.execute(
      user,
      command(user.id, 'project.open', { name, roots: [path.join(root, name)] }),
    )) as Project;
  };
  const reader = (project: Project, id: string) =>
    daemon.auth.issueSession(
      daemon.store.insert<Session>('sessions', {
        id,
        revision: 1,
        project_id: project.id,
        runtime: 'fixture',
        state: 'open',
        turn_count: 0,
      }),
      'planner',
    );
  const get = async (route: string, init: RequestInit = { headers }) => {
    const response = await fetch(daemon.url + route, init);
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    daemon,
    open,
    reader,
    get,
    async close() {
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('refuses the events of another project or of every project to a session credential', async () => {
  const f = await eventFixture();
  try {
    const mine = await f.open('mine'),
      other = await f.open('other');
    const headers = { Authorization: `Bearer ${f.reader(mine, 'event-reader')}` };
    const denied = await f.get('/v1/events?after=0&project_id=' + other.id, { headers });
    expect(denied).toEqual({
      status: 403,
      body: {
        error: 'permission_denied',
        message: 'Project principal required',
        stack: expect.stringMatching(/^DomainError: /),
      },
    });
    expect(await f.get('/v1/events?after=0', { headers })).toEqual({
      status: 403,
      body: {
        error: 'permission_denied',
        message: 'Project scope required',
        stack: expect.stringMatching(/^DomainError: /),
      },
    });
    const own = await f.get('/v1/events?after=0&project_id=' + mine.id, { headers });
    expect(own.status).toBe(200);
    expect(own.body.events.every((e: any) => e.project_id === mine.id)).toBe(true);
  } finally {
    await f.close();
  }
});

it('checks access to events without building the board', async () => {
  const f = await eventFixture();
  try {
    const project = await f.open('watched');
    const snapshot = vi.spyOn(f.daemon.control, 'snapshot');
    expect((await f.get('/v1/events?after=0&project_id=' + project.id)).status).toBe(200);
    const ws = new WebSocket(f.daemon.url.replace('http:', 'ws:') + '/v1/events/ws');
    const incoming: { type: string }[] = [];
    ws.addEventListener('message', (e) => incoming.push(JSON.parse(String(e.data))));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.send(JSON.stringify({ token: f.daemon.token, project_id: project.id, cursor: 0 }));
    await eventually(
      () => incoming.some((x) => x.type === 'event'),
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );
    ws.close();
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('reads at most the requested number of events and refuses a limit out of range', async () => {
  const f = await eventFixture();
  try {
    for (const name of ['first', 'second', 'third']) await f.open(name);
    const page = await f.get('/v1/events?after=0&limit=2');
    expect(page.status).toBe(200);
    expect(page.body.events).toHaveLength(2);
    expect((await f.get('/v1/events?after=0')).body.events).toHaveLength(3);
    for (const limit of ['0', '2001', '1.5', 'many', ''])
      expect(await f.get('/v1/events?after=0&limit=' + limit)).toEqual({
        status: 400,
        body: {
          error: 'invalid_limit',
          message: 'Limit must be an integer from 1 to 2000',
          stack: expect.stringMatching(/^DomainError: /),
        },
      });
  } finally {
    await f.close();
  }
});

it('reads only the events of one session: its own, its turns and its approvals', async () => {
  const f = await eventFixture();
  try {
    const project = await f.open('sessions');
    const add = (session: string) => {
      const row = f.daemon.store.insert<Session>('sessions', {
        id: session,
        revision: 1,
        project_id: project.id,
        runtime: 'fixture',
        state: 'open',
        turn_count: 0,
      });
      const turn = f.daemon.store.insert('session_turns', {
        id: `${session}-turn`,
        revision: 1,
        session_id: session,
      });
      f.daemon.store.event('session.process_closed', row, project.id, {});
      f.daemon.store.event('agent.message.delta', turn, project.id, { text: session });
      f.daemon.store.event(
        'approval.requested',
        { id: `${session}-approval`, revision: 1 },
        project.id,
        { session_id: session },
      );
    };
    add('read-session');
    add('other-session');
    const read = await f.get(`/v1/events?after=0&project_id=${project.id}&session_id=read-session`);
    expect(read.status).toBe(200);
    expect(read.body.events.map((event: { aggregate_id: string }) => event.aggregate_id)).toEqual([
      'read-session',
      'read-session-turn',
      'read-session-approval',
    ]);
  } finally {
    await f.close();
  }
});
