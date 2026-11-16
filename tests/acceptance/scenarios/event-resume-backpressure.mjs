import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { TokenStreamAdapter } from '../fixtures/token-stream-adapter.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import {
  createEventProjection,
  slowEventSocket,
  subscribeEvents,
  waitFor,
} from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';

export const title = '事件续传、去重与回压';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WAIT_MS = 40000;
/** Text deltas of the virtual stream: count events of size characters, about 10 MB in all. */
const TOKENS = { count: 2400, size: 4096 };
const TOKEN_KIND = 'agent.message.delta';
/** Events a reconnecting client asks for again although it already holds them. */
const REPLAY_OVERLAP = 3;
/** The most events createEventProjection keeps. */
const PROJECTION_LIMIT = 2000;
/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);

export async function run({ workspace, evidenceDir }) {
  const adapter = new TokenStreamAdapter();
  const managed = createWorkspaceRoot('event-resume-backpressure');
  const fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [adapter], {
    intervalMs: 50,
    workspaceRoot: managed.root,
  });
  const { daemon } = fixture;
  const followers = [],
    probes = {},
    observations = {};
  let projectId, slow, failure, evidence;

  const call = async (type, input, revision = null) => {
    const result = await fixture.submit(command(USER_PRINCIPAL_ID, type, input, revision));
    if (result.status !== 200) throw new Error(`${type}: ${JSON.stringify(result.data)}`);
    return result.data.receipt;
  };
  const get = async (method, params) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const snapshot = () => get('board', { project_id: projectId });
  const events = async () => {
    const all = [];
    for (let after = 0; ;) {
      const page = await get('events', { after: String(after), project_id: projectId });
      if (page.snapshot_required) throw new Error('Event log no longer reaches the first event');
      if (!page.events.length) return all;
      all.push(...page.events);
      after = page.events.at(-1).sequence;
    }
  };
  const latest = async () => (await events()).at(-1)?.sequence ?? 0;
  const settle = (sessionId, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const session = board.sessions.find((row) => row.id === sessionId);
        const turns = board.session_turns.filter((turn) => turn.session_id === sessionId);
        return session?.state === 'open' && turns.length && turns.every(ended) ? session : false;
      },
      description,
      WAIT_MS,
    );
  /** A client that keeps its projection current and, after a 1013 close, reconnects from its cursor. */
  const follower = (name, projection) => {
    const state = { name, projection, connections: [], stopped: true, socket: undefined };
    const connect = async (cursor) => {
      state.stopped = false;
      const record = { cursor, frames: 0, first_frame: null, ended: null };
      state.connections.push(record);
      const socket = await subscribeEvents(daemon, cursor, projectId, (frame) => {
        record.frames++;
        record.first_frame ??= frame.type === 'event' ? 'event' : frame;
        projection.receive(frame);
      });
      state.socket = socket;
      void socket.closed.then((end) => {
        record.ended = end;
        if (!state.stopped && end.code === 1013) void connect(projection.cursor);
      });
      return socket;
    };
    const client = {
      state,
      connect,
      async stop() {
        state.stopped = true;
        await state.socket?.close();
      },
      caughtUp: (target, description) =>
        waitFor(async () => projection.cursor >= target, description, WAIT_MS),
    };
    followers.push(client);
    return client;
  };
  const missing = (projection, controls) =>
    controls
      .filter((event) => projection.coverage(event) === 'missing')
      .map(({ sequence, kind }) => ({ sequence, kind }));
  const inspect = (projection) => {
    const { board, snapshots, ...rest } = projection.inspect();
    return { ...rest, snapshots: snapshots.map((value) => value.cursor) };
  };

  try {
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Event Resume');
    git(repo, 'config', 'user.email', 'event-resume@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Event resume\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const project = await call('project.open', { name: 'Event resume', roots: [repo] });
    projectId = project.id;

    // Two clients follow the project from one snapshot; a third will come back after retention.
    const first = await snapshot();
    const clients = {};
    for (const name of ['A', 'B', 'stale']) {
      const projection = createEventProjection();
      projection.snapshot(first);
      clients[name] = follower(name, projection);
      await clients[name].connect(first.cursor);
    }
    const opening = await call('session.create', {
      project_id: projectId,
      runtime: adapter.name,
      input: script({ say: 'Opening the stream' }),
    });
    await settle(opening.id, 'the opening session to settle');
    let target = await latest();
    for (const client of Object.values(clients))
      await client.caughtUp(target, `client ${client.state.name} to catch up`);

    // B and the stale client disconnect; a slow client subscribes and stops reading.
    await clients.B.stop();
    await clients.stale.stop();
    const disconnectedAt = { B: clients.B.state.projection.cursor };
    disconnectedAt.stale = clients.stale.state.projection.cursor;
    const slowBoard = await snapshot();
    slow = await slowEventSocket(daemon, slowBoard.cursor, projectId);
    await waitFor(
      async () => slow.frames.some((frame) => frame.type === 'subscribed'),
      'the slow client to subscribe',
      WAIT_MS,
    );
    slow.pause();

    // Control events and a large token stream while B is away.
    const streaming = await call('session.create', {
      project_id: projectId,
      runtime: adapter.name,
      input: `token-stream\n${JSON.stringify(TOKENS)}`,
    });
    const streamed = await settle(streaming.id, 'the token stream to end');
    await call(
      'session.rename',
      { session_id: streaming.id, title: 'Token stream' },
      streamed.revision,
    );
    const milestone = await call('milestone.create', {
      project_id: projectId,
      title: 'Stream delivered',
      required_sessions: [streaming.id],
      criteria: ['Every control event reaches every client'],
    });
    target = await latest();
    await clients.A.caughtUp(target, 'client A to follow the stream');

    // B reconnects from a cursor older than the last event it processed.
    await clients.B.connect(disconnectedAt.B - REPLAY_OVERLAP);
    await clients.B.caughtUp(target, 'client B to replay what it missed');

    // The slow client reads again: the daemon closed it when its send buffer filled.
    slow.resume();
    let slowTimer;
    const slowEnd = await Promise.race([
      slow.closed,
      new Promise((resolve) => (slowTimer = setTimeout(resolve, WAIT_MS, null))),
    ]);
    clearTimeout(slowTimer);
    const slowEvents = slow.frames.filter((frame) => frame.type === 'event');
    const slowProjection = createEventProjection();
    slowProjection.snapshot(slowBoard);
    for (const frame of slow.frames) slowProjection.receive(frame);
    const resumed = follower('slow', slowProjection);
    await resumed.connect(slowProjection.cursor);
    await resumed.caughtUp(target, 'the slow client to resume from its cursor');

    const all = await events();
    const controls = all.filter((event) => event.kind !== TOKEN_KIND);
    const tokens = all.filter((event) => event.kind === TOKEN_KIND);
    const followed = {
      A: clients.A.state.projection,
      B: clients.B.state.projection,
      slow: slowProjection,
    };
    const missingBy = Object.fromEntries(
      Object.entries(followed).map(([name, projection]) => [name, missing(projection, controls)]),
    );
    const inspections = Object.fromEntries(
      Object.entries(followed).map(([name, projection]) => [name, inspect(projection)]),
    );
    observations.events = {
      missing_control_events: Object.values(missingBy).reduce((sum, list) => sum + list.length, 0),
    };
    observations.ui = {
      duplicate_logical_items: Object.values(inspections).reduce(
        (sum, value) => sum + value.duplicate_logical_items,
        0,
      ),
    };
    observations.buffers = {
      bounded:
        slowEnd?.code === 1013 &&
        slowEvents.length < tokens.length &&
        all.length > PROJECTION_LIMIT &&
        Object.values(inspections).every(
          (value) =>
            value.max_buffered_events <= PROJECTION_LIMIT &&
            value.max_seen_event_ids <= PROJECTION_LIMIT,
        ),
    };
    Object.assign(probes, {
      events: { total: all.length, control: controls.length, tokens: tokens.length },
      disconnected_at: disconnectedAt,
      replay_overlap: REPLAY_OVERLAP,
      slow: {
        subscribed_at: slowBoard.cursor,
        ended: slowEnd,
        bytes_read: slow.bytes,
        event_frames: slowEvents.length,
        first_sequence: slowEvents[0]?.event.sequence ?? null,
        last_sequence: slowEvents.at(-1)?.event.sequence ?? null,
      },
      missing_control_events: missingBy,
    });

    // The stale client's cursor falls before the retained events: it falls back to the snapshot.
    const horizon = target - 1;
    daemon.store.pruneEvents(horizon);
    const http = await get('events', {
      after: String(disconnectedAt.stale),
      project_id: projectId,
    });
    const staleSocket = await subscribeEvents(daemon, disconnectedAt.stale, projectId, (frame) =>
      clients.stale.state.projection.receive(frame),
    );
    const staleEnd = await staleSocket.closed;
    const fresh = await snapshot();
    clients.stale.state.projection.snapshot(fresh);
    const restarted = await clients.stale.connect(fresh.cursor);
    await call(
      'milestone.revise',
      {
        milestone_id: milestone.id,
        title: 'Stream delivered after the snapshot',
        required_sessions: [streaming.id],
        criteria: ['Every control event reaches every client'],
      },
      milestone.revision,
    );
    const later = (await get('events', { after: String(target), project_id: projectId })).events;
    const after = later.at(-1)?.sequence ?? target;
    await clients.stale.caughtUp(after, 'the stale client to follow after its snapshot');
    const staleMissing = missing(
      clients.stale.state.projection,
      [...controls, ...later].filter(
        (event) => event.sequence > disconnectedAt.stale && event.kind !== TOKEN_KIND,
      ),
    );
    probes.snapshot_fallback = {
      pruned_before: horizon,
      cursor: disconnectedAt.stale,
      http,
      websocket_frames: staleSocket.frames,
      websocket_end: staleEnd,
      snapshot_cursor: fresh.cursor,
      resubscribed: restarted.frames[0] ?? null,
      followed_to: clients.stale.state.projection.cursor,
      missing_control_events: staleMissing,
    };
    observations.events.snapshot_fallback =
      http.snapshot_required === true &&
      staleSocket.frames[0]?.type === 'snapshot_required' &&
      staleEnd.code === 1000 &&
      restarted.frames[0]?.type === 'subscribed' &&
      clients.stale.state.projection.cursor === after &&
      staleMissing.length === 0;
    inspections.stale = inspect(clients.stale.state.projection);
    probes.inspections = inspections;
  } catch (error) {
    failure = error;
  } finally {
    try {
      evidence = collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    for (const client of followers) await client.stop();
    slow?.destroy();
    await fixture.close();
    managed.remove();
  }
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...evidence,
      'failure.txt': String(failure?.stack ?? failure),
    });
    throw failure;
  }
  return {
    observations,
    evidence,
    adapters: [`${adapter.name}@${adapter.report.version}`],
  };

  function collectEvidence() {
    const clientsSeen = Object.fromEntries(
      followers.map(({ state }) => [
        state.name,
        {
          connections: state.connections,
          projection: inspect(state.projection),
          board: state.projection.inspect().board && {
            cursor: state.projection.inspect().board.cursor,
            sessions: state.projection
              .inspect()
              .board.sessions.map(({ id, revision, state: status }) => ({ id, revision, status })),
            milestones: (state.projection.inspect().board.milestones ?? []).map(
              ({ id, revision }) => ({ id, revision }),
            ),
          },
        },
      ]),
    );
    return {
      'event-probes.json': probes,
      'client-snapshot.json': clientsSeen,
      'observations.json': observations,
    };
  }
}
