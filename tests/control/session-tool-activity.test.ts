import { expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '@pantheon/daemon';
import { command } from '@pantheon/protocol';
import type { Principal, Project, Session } from '@pantheon/domain';
import { agentEvent } from '../../packages/control/dist/agent.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

it('buckets the tool calls the adapter reported for the session in the last hour', async () => {
  const f = workbenchFixture();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const base = 1_700_000_000_000;
  let clock = base;
  vi.spyOn(f.store, 'now').mockImplementation(() => clock);

  const session = f.create('Task 1');
  const turn = f.turns(session.id)[0]!;
  const otherSession = f.create('Task 2');
  let sequence = 0;
  const completed = (sessionId: string, minutesAgo: number) => {
    clock = base - minutesAgo * 60 * 1000;
    sequence++;
    agentEvent(ctx, sessionId, {
      key: `tool-completed-${sequence}`,
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'tool.completed',
      tool_call_id: `tool-${sequence}`,
      ok: true,
    });
  };

  completed(session.id, 61);
  completed(session.id, 7);
  completed(session.id, 7);
  completed(session.id, 2);
  completed(otherSession.id, 2);

  clock = base;
  const activity = f.control.sessionToolActivity(user, session.id);
  expect(activity).toEqual({
    bucket_ms: 300000,
    from: new Date(base - 12 * 300_000).toISOString(),
    tools_completed: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1],
  });

  const otherActivity = f.control.sessionToolActivity(user, otherSession.id);
  expect(otherActivity).toEqual({
    bucket_ms: 300000,
    from: new Date(base - 12 * 300_000).toISOString(),
    tools_completed: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  });
});

it('refuses a principal of another project', async () => {
  const f = workbenchFixture();
  const session = f.create('Task 1');
  const foreign: Principal = {
    id: 'session:foreign',
    role: 'planner',
    session_id: 'foreign',
    project_id: 'other-project',
    expires_at: f.store.now() + 60000,
  };
  expect(() => f.control.sessionToolActivity(foreign, session.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('serves session activity at GET /v1/session.activity', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-activity-'));
  const work = path.join(root, 'project');
  mkdirSync(work);
  const base = 1_700_000_000_000;
  let clock = base;
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [],
    intervalMs: 60000,
    now: () => clock,
  });
  try {
    const project = daemon.control.execute(
      user,
      command(user.id, 'project.open', { name: 'Activity project', roots: [work] }, null),
    ) as Project;
    const session = daemon.store.insert<Session>('sessions', {
      id: 'activity-session',
      revision: 1,
      project_id: project.id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 1,
    });
    clock = base - 2 * 60 * 1000;
    daemon.store.event('agent.tool.completed', session, project.id, {});
    clock = base;
    const res = await fetch(`${daemon.url}/v1/session.activity?session_id=${session.id}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bucket_ms: 300000,
      from: new Date(base - 12 * 300_000).toISOString(),
      tools_completed: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    });
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});
