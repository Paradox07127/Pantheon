import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  DeliveryReceipt,
  Principal,
  Project,
  Review,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import { insideSandbox, awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function readyFixture(commands = passing) {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  await f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  return f;
}

/** A session whose first turn has ended, so it is idle. */
async function idle(f: Fixture, session: Session) {
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'completed' && current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session: current(f, session.id), workspace };
}

const openConductor = async (f: Fixture) =>
  idle(
    f,
    await f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Ship the answer',
      purpose: 'conductor',
    }),
  );

/** A plain session the conductor spawned. */
async function spawnedBy(f: Fixture, conductorId: string) {
  const { session, workspace } = await idle(f, await f.create('Write the docs'));
  const spawned = f.store.transaction(() =>
    f.store.update<Session>(
      'sessions',
      { ...session, spawned_by: { session_id: conductorId } },
      session.revision,
    ),
  );
  return { session: spawned, workspace };
}

const credential = (f: Fixture, sessionId: string): Principal => ({
  id: `credential-${sessionId}`,
  role: 'conductor',
  session_id: sessionId,
  project_id: f.project.id,
  expires_at: Date.now() + 3_600_000,
});

const ready = (f: Fixture, conductorId: string, input: Record<string, unknown> = {}) =>
  Promise.resolve().then(() => f.call('conductor.ready', input, null, credential(f, conductorId)));

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function commit(repository: string, name: string, contents: string) {
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

const send = (f: Fixture, sessionId: string, input = 'Finish the answer') =>
  f.call<SessionTurn>(
    'session.send',
    { session_id: sessionId, input },
    current(f, sessionId).revision,
  );

const payloads = (f: Fixture, sessionId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(sessionId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

/** The messages Pantheon sent the session as turns of their own. */
const messages = (f: Fixture, sessionId: string) =>
  f
    .turns(sessionId)
    .map((turn) => turn.input)
    .filter((input) => input.startsWith('[Pantheon]'));

// A spawned session's turn end tells the conductor too, and a message that waits takes the next one in.
const landings = (f: Fixture, sessionId: string) =>
  messages(f, sessionId)
    .flatMap((input) => input.split('\n\n'))
    .filter((part) => part.startsWith('[Pantheon]') && !part.includes('which you spawned'));

const passing = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];
const failing = [
  {
    name: 'Always fails',
    argv: [process.execPath, '-e', "process.stderr.write('gate broke'); process.exit(3)"],
  },
];

/**
 * Runs `during` while the session's next turn is running, as a tool call of that turn would, then
 * lets the turn go on or ends it with `receipt`.
 */
function duringNextTurn(
  f: Fixture,
  during: () => Promise<unknown>,
  receipt?: (turnId: string) => DeliveryReceipt,
) {
  const deliver = f.adapter.send.bind(f.adapter);
  const seen: { merges_started: number; declared: boolean; result: unknown }[] = [];
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    let result: unknown;
    try {
      result = await during();
    } catch (error) {
      result = { error: (error as { code?: string }).code };
    }
    seen.push({
      merges_started: payloads(f, handle.platform_session_id, 'session.merge_started').length,
      declared: 'ready' in current(f, handle.platform_session_id),
      result,
    });
    return receipt ? receipt(turn.turn_id) : deliver(handle, turn);
  });
  return seen;
}

/** Waits until the turn ended in state and the session is idle, then ticks a few times. */
async function settle(f: Fixture, sessionId: string, turnId: string, state = 'completed') {
  await eventually(
    () =>
      f.store.must<SessionTurn>('session_turns', turnId).state === state &&
      current(f, sessionId).state !== 'running',
    () => f.control.tick(),
  );
  for (let i = 0; i < 3; i++) await f.control.tick();
}

function review(
  f: Fixture,
  sessionId: string,
  id: string,
  blocking: boolean,
  status: 'open' | 'stale' = 'open',
) {
  f.store.transaction(() =>
    f.store.insert<Review>('reviews', {
      id,
      revision: 1,
      project_id: f.project.id,
      session_id: sessionId,
      round: 1,
      runtimes: ['codex'],
      session_ids: [],
      state: 'completed',
      findings: blocking
        ? [
            {
              id: `${id}-finding`,
              review_id: id,
              runtime: 'codex',
              round: 1,
              location: 'answer.txt:1',
              quote: 'ready',
              evidence: 'The answer is wrong',
              impact: 'Users read a wrong answer',
              status,
              blocking: true,
            },
          ]
        : [],
    }),
  );
}

it.skipIf(insideSandbox)(
  "lands a conductor's own work after the turn it declared it ready in, without auto-merge, and tells it where",
  async () => {
    const f = await readyFixture();
    const { session, workspace } = await openConductor(f);
    expect(f.store.must<Project>('projects', f.project.id).auto_merge).not.toBe(true);
    const head = commit(workspace.path, 'answer.txt', 'ready\n');
    const seen = duringNextTurn(f, () => ready(f, session.id));
    send(f, session.id);
    await eventually(
      () => messages(f, session.id).length > 0,
      () => f.control.tick(),
      10000,
    );
    expect(seen).toEqual([
      {
        merges_started: 0,
        declared: true,
        result: expect.objectContaining({ next: expect.stringContaining('when this turn ends') }),
      },
    ]);
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([{}]);
    expect(messages(f, session.id)).toEqual([expect.stringContaining(`landed on main at ${head}`)]);
    expect(current(f, session.id)).not.toHaveProperty('ready');
    expect(current(f, session.id).outcome).toBeUndefined();
  },
);

it.skipIf(insideSandbox)(
  'keeps a conductor in the project folder open once its work lands',
  async () => {
    const f = await readyFixture();
    const { session } = await idle(
      f,
      await f.call<Promise<Session>>('session.create', {
        project_id: f.project.id,
        runtime: f.adapter.name,
        input: 'Ship the answer',
        purpose: 'conductor',
        workspace: 'in_place',
      }),
    );
    expect(session.in_place).toBeDefined();
    const head = commit(f.source, 'answer.txt', 'in place\n');
    await f.call('session.gates.run', { session_id: session.id }, current(f, session.id).revision);
    await eventually(
      () => f.control.sessionGates(user, session.id).last?.commit === head,
      () => f.control.tick(),
      10000,
    );
    duringNextTurn(f, () => ready(f, session.id));
    send(f, session.id);
    await eventually(
      () => payloads(f, session.id, 'session.merged').length > 0,
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(current(f, session.id).state).not.toBe('closed');
    expect(current(f, session.id).outcome).toBeUndefined();
  },
);

it.skipIf(insideSandbox)(
  'tells a conductor once that the gate blocked its work and leaves the target branch',
  async () => {
    const f = await readyFixture(failing);
    const { session, workspace } = await openConductor(f);
    const sourceHead = git(f.source, 'rev-parse', 'main');
    commit(workspace.path, 'answer.txt', 'blocked\n');
    duringNextTurn(f, () => ready(f, session.id));
    send(f, session.id);
    await eventually(
      () => messages(f, session.id).length > 0,
      () => f.control.tick(),
      10000,
    );
    for (let i = 0; i < 5; i++) await f.control.tick();
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
    expect(messages(f, session.id)).toEqual([expect.stringContaining('gate_failed')]);
    expect(messages(f, session.id)[0]).toContain('Always fails');
    expect(messages(f, session.id)[0]).toContain('exit code 3');
    expect(messages(f, session.id)[0]).toContain('gate broke');
  },
);

it.each([
  { name: 'fails', state: 'failed' },
  { name: 'is cancelled', state: 'cancelled' },
])(
  'does not land when the turn that declared the work ready $name, nor after a later turn',
  async ({ state }) => {
    const f = await readyFixture();
    const { session, workspace } = await openConductor(f);
    commit(workspace.path, 'answer.txt', 'not landed\n');
    const seen = duringNextTurn(
      f,
      () => ready(f, session.id),
      state === 'failed'
        ? (turn_id) => ({ turn_id, status: 'unsupported', reason: 'Refused by the test' })
        : undefined,
    );
    if (state === 'cancelled') (f.adapter as { delay: number }).delay = 30000;
    const turn = send(f, session.id);
    await eventually(
      () => seen.length > 0,
      () => f.control.tick(),
    );
    if (state === 'cancelled')
      f.call('session.interrupt', { session_id: session.id }, current(f, session.id).revision);
    await settle(f, session.id, turn.id, state);
    (f.adapter as { delay: number }).delay = 0;
    expect(seen).toEqual([expect.objectContaining({ merges_started: 0, declared: true })]);
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
    const next = send(f, session.id, 'Look again');
    await settle(f, session.id, next.id);
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
    expect(current(f, session.id)).not.toHaveProperty('ready');
    expect(messages(f, session.id)).toEqual([]);
  },
);

it.skipIf(insideSandbox)('lands once when a turn declares its work ready twice', async () => {
  const f = await readyFixture();
  const { session, workspace } = await openConductor(f);
  const head = commit(workspace.path, 'answer.txt', 'twice\n');
  const seen = duringNextTurn(f, async () => [
    await ready(f, session.id),
    await ready(f, session.id),
  ]);
  send(f, session.id);
  await eventually(
    () => messages(f, session.id).length > 0,
    () => f.control.tick(),
    10000,
  );
  for (let i = 0; i < 5; i++) await f.control.tick();
  expect(seen).toEqual([expect.objectContaining({ merges_started: 0, declared: true })]);
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  expect(payloads(f, session.id, 'session.merge_started')).toHaveLength(1);
  expect(messages(f, session.id)).toHaveLength(1);
});

it.skipIf(insideSandbox)(
  'refuses work whose latest review has open blocking findings until a later review has none',
  async () => {
    const f = await readyFixture();
    const { session, workspace } = await openConductor(f);
    const head = commit(workspace.path, 'answer.txt', 'reviewed\n');
    review(f, session.id, 'first-review', true);
    const seen = duringNextTurn(f, async () => [
      await refusal(() => ready(f, session.id)),
      review(f, session.id, 'second-review', false),
      await refusal(() => ready(f, session.id)),
    ]);
    send(f, session.id);
    await eventually(
      () => messages(f, session.id).length > 0,
      () => f.control.tick(),
      10000,
    );
    expect(seen.map((each) => each.result)).toEqual([
      ['review_blocking_open', undefined, undefined],
    ]);
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  },
);

it.skipIf(insideSandbox).each(['open', 'stale'] as const)(
  "refuses a spawned session's work with an unresolved %s blocking finding to its conductor but not to the user's merge",
  async (status) => {
    const f = await readyFixture();
    const { session: conductor } = await openConductor(f);
    const { session, workspace } = await spawnedBy(f, conductor.id);
    const head = commit(workspace.path, 'answer.txt', 'by the user\n');
    review(f, session.id, 'spawned-review', true, status);
    expect(await refusal(() => ready(f, conductor.id, { session_id: session.id }))).toBe(
      'review_blocking_open',
    );
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
    await f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
    await eventually(
      () => current(f, session.id).outcome === 'merged',
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  },
);

it.skipIf(insideSandbox)(
  'lands an idle session the conductor spawned at once and tells the conductor',
  async () => {
    const f = await readyFixture();
    const { session: conductor } = await openConductor(f);
    const { session, workspace } = await spawnedBy(f, conductor.id);
    const head = commit(workspace.path, 'answer.txt', 'spawned\n');
    await ready(f, conductor.id, { session_id: session.id });
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([{}]);
    await eventually(
      () => landings(f, conductor.id).length > 0,
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(current(f, session.id).outcome).toBe('merged');
    expect(landings(f, conductor.id)).toEqual([
      expect.stringContaining(`(${session.id}) landed on main at ${head}`),
    ]);
  },
);

it('refuses a session another conductor spawned and a spawned session taking a turn', async () => {
  const f = await readyFixture();
  const { session: conductor } = await openConductor(f);
  const { session: other } = await spawnedBy(f, 'another-conductor');
  const { session: plain } = await idle(f, await f.create('Write the tests'));
  expect(await refusal(() => ready(f, conductor.id, { session_id: other.id }))).toBe(
    'permission_denied',
  );
  expect(await refusal(() => ready(f, conductor.id, { session_id: plain.id }))).toBe(
    'permission_denied',
  );
  const { session: spawned } = await spawnedBy(f, conductor.id);
  (f.adapter as { delay: number }).delay = 30000;
  const turn = send(f, spawned.id);
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', turn.id).state === 'running',
    () => f.control.tick(),
  );
  expect(await refusal(() => ready(f, conductor.id, { session_id: spawned.id }))).toBe(
    'resource_busy',
  );
  expect(payloads(f, spawned.id, 'session.merge_started')).toEqual([]);
});

it.skipIf(insideSandbox)(
  'tells the conductor when the user merges a session it spawned',
  async () => {
    const f = await readyFixture();
    const { session: conductor } = await openConductor(f);
    const { session, workspace } = await spawnedBy(f, conductor.id);
    const head = commit(workspace.path, 'answer.txt', 'merged by the user\n');
    await f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
    await eventually(
      () => landings(f, conductor.id).length > 0,
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(landings(f, conductor.id)).toEqual([
      expect.stringContaining(`(${session.id}) landed on main at ${head}`),
    ]);
  },
);
