import { expect, it, vi } from 'vitest';
import { id, type Principal, type Session, type SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, waitOutStatusReuse } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const row = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

const principalOf = (f: Fixture, sessionId: string, role: Principal['role']): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

async function openConductor(f: Fixture) {
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the export',
    purpose: 'conductor',
  });
  await settle(f, session);
  return session;
}

/** Sends the command as the session's credential; role conductor unless named. */
const asSession = <T = unknown>(
  f: Fixture,
  sessionId: string,
  type: Parameters<Fixture['call']>[0],
  input: Record<string, unknown>,
  role: Principal['role'] = 'conductor',
) => f.call<T>(type, input, null, principalOf(f, sessionId, role));

const spawn = async (f: Fixture, conductorId: string, input: string, extra = {}) =>
  (
    await asSession<Promise<{ session_id: string }>>(f, conductorId, 'conductor.spawn', {
      runtime: f.adapter.name,
      input,
      ...extra,
    })
  ).session_id;

function refusal(fn: () => unknown): { code?: string; message?: string; name?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string; name?: string };
  }
  throw new Error('Expected the command to fail');
}

async function running(f: Fixture, sessionId: string) {
  await awaitWorkspaceReady(f.control, row(f, sessionId).workspace_id!);
  await eventually(
    () => f.turns(sessionId).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
}

it('sends a message to a session the conductor spawned, at most twice a minute to one session', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await spawn(f, conductor.id, 'Port the parser');
  const other = await spawn(f, conductor.id, 'Write the docs');
  await settle(f, row(f, spawned));
  await settle(f, row(f, other));
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  const message = (sessionId: string, text: string) =>
    asSession<{ session_id: string; turn_id: string }>(f, conductor.id, 'conductor.message', {
      session_id: sessionId,
      text,
      mode: 'send',
    });

  for (const text of ['Add the tests', 'Cover the errors']) {
    const receipt = message(spawned, text);
    expect(receipt.session_id).toBe(spawned);
    expect(f.turns(spawned).at(-1)).toMatchObject({
      id: receipt.turn_id,
      input: text,
      kind: 'send',
    });
    await settle(f, row(f, spawned));
  }
  const limited = refusal(() => message(spawned, 'One more thing'));
  expect(limited.code).toBe('rate_limited');
  expect(f.turns(spawned).at(-1)!.input).toBe('Cover the errors');
  // The limit counts each spawned session on its own.
  expect(message(other, 'Add the index').session_id).toBe(other);

  skew += 60_001;
  expect(message(spawned, 'One more thing').session_id).toBe(spawned);
});

it('steers the running turn of a session the conductor spawned', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await spawn(f, conductor.id, script({ wait: 3000 }, { say: 'Done' }));
  await running(f, spawned);

  asSession(f, conductor.id, 'conductor.message', {
    session_id: spawned,
    text: 'Cover the tests too',
    mode: 'steer',
  });

  expect(f.turns(spawned).at(-1)).toMatchObject({ input: 'Cover the tests too', kind: 'steer' });
});

it('interrupts the running turn of a session the conductor spawned, then closes the session', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await spawn(f, conductor.id, script({ wait: 5000 }, { say: 'Done' }));
  await running(f, spawned);

  asSession(f, conductor.id, 'conductor.stop', { session_id: spawned });
  await settle(f, row(f, spawned));
  expect(f.turns(spawned)[0]!.state).toBe('cancelled');
  expect(row(f, spawned).outcome).toBeUndefined();

  asSession(f, conductor.id, 'conductor.stop', { session_id: spawned, close: true });
  await eventually(
    () => row(f, spawned).outcome === 'discarded',
    () => f.control.tick(),
  );
});

it('refuses to message or stop a session the conductor did not spawn, and refuses other roles', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const second = await openConductor(f);
  const theirs = await spawn(f, second.id, 'Port the parser');
  const opened = await f.create('Plan the export');
  await settle(f, row(f, theirs));
  await settle(f, opened);
  const ownSpawned = await spawn(f, conductor.id, 'Write the docs');
  await settle(f, row(f, ownSpawned));

  for (const target of [theirs, opened.id, conductor.id]) {
    expect(
      refusal(() =>
        asSession(f, conductor.id, 'conductor.message', { session_id: target, text: 'Hello' }),
      ).code,
      target,
    ).toBe('permission_denied');
    expect(
      refusal(() => asSession(f, conductor.id, 'conductor.stop', { session_id: target })).code,
      target,
    ).toBe('permission_denied');
  }
  expect(
    refusal(() => f.call('conductor.message', { session_id: ownSpawned, text: 'Hello' })).code,
  ).toBe('permission_denied');
  expect(
    refusal(() => asSession(f, opened.id, 'conductor.stop', { session_id: ownSpawned }, 'writer'))
      .code,
  ).toBe('permission_denied');
  expect(f.turns(ownSpawned)).toHaveLength(1);
});

it('opens a spawned session in the permission mode it is given, at most auto_edit', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);

  const editing = await spawn(f, conductor.id, 'Port the parser', { permission_mode: 'auto_edit' });
  const asking = await spawn(f, conductor.id, 'Write the docs');

  expect(row(f, editing).permission_mode).toBe('auto_edit');
  expect(row(f, asking).permission_mode).toBe('ask');
  for (const mode of ['auto', 'full_access', 'plan'])
    expect(
      refusal(() =>
        asSession(f, conductor.id, 'conductor.spawn', {
          runtime: f.adapter.name,
          input: 'Delete everything',
          permission_mode: mode,
        }),
      ).name,
      mode,
    ).toBe('ZodError');
});

it('refuses to spawn a session once the project spent its budget', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  let now = f.store.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  f.call('workflow.policy.set', {
    project_id: f.project.id,
    project_budget: { input_tokens: 100 },
  });
  now += 1000;
  const spent = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: conductor.id,
    input: 'A message',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    usage: { input_tokens: 150, output_tokens: 0 },
  });
  f.store.event('turn.completed', spent, f.project.id, {});
  now += 1000;
  const sessions = f.store.list<Session>('sessions').length;

  const error = refusal(() =>
    asSession(f, conductor.id, 'conductor.spawn', { runtime: f.adapter.name, input: 'More' }),
  );

  expect(error).toMatchObject({
    code: 'budget_exceeded',
    message: 'Project runtime budget is exhausted',
  });
  expect(f.store.list<Session>('sessions')).toHaveLength(sessions);
});

it('lists the items waiting for the user to a conductor without the actions that answer them', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const stopping = await f.create('Stop the stuck run');
  await settle(f, stopping);
  // A stop the runtime never confirmed is an item waiting for the user.
  f.store.update(
    'sessions',
    { ...row(f, stopping.id), stop_requested: { reason: 'stuck', at: 0, by: 'user' } },
    row(f, stopping.id).revision,
  );

  const { items } = asSession<{ items: Record<string, unknown>[] }>(
    f,
    conductor.id,
    'conductor.needs_you',
    {},
  );

  expect(items).toContainEqual(
    expect.objectContaining({
      kind: 'session.failed',
      reason: 'stop_unconfirmed',
      session_id: stopping.id,
      created_at: expect.any(Number),
    }),
  );
  for (const item of items) {
    expect(item).not.toHaveProperty('actions');
    expect(item).not.toHaveProperty('primary');
    expect(item).not.toHaveProperty('binding');
  }
  expect(refusal(() => asSession(f, stopping.id, 'conductor.needs_you', {}, 'writer')).code).toBe(
    'permission_denied',
  );
  expect(refusal(() => f.call('conductor.needs_you', {})).code).toBe('permission_denied');
});

it('reads the project and its memory and proposes memory as a conductor', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);

  const read = asSession<{ project: { id: string }; you: { session_id: string; role: string } }>(
    f,
    conductor.id,
    'project.read',
    { project_id: f.project.id },
  );
  expect(read.project.id).toBe(f.project.id);
  expect(read.you).toEqual({ session_id: conductor.id, role: 'conductor' });

  const { signature } = asSession<{ signature: string }>(f, conductor.id, 'memory.context', {
    project_id: f.project.id,
  });
  const note = asSession<{ id: string; state: string }>(f, conductor.id, 'memory.propose', {
    project_id: f.project.id,
    key: 'parser/strategy',
    kind: 'note',
    text: 'The parser splits tokens on whitespace first.',
    based_on: signature,
  });
  expect(note.state).toBe('active');
  const found = asSession<{ items: { id: string }[] }>(f, conductor.id, 'memory.search', {
    project_id: f.project.id,
    q: 'parser',
  });
  expect(found.items.map((item) => item.id)).toContain(note.id);
  expect(asSession<{ id: string }>(f, conductor.id, 'memory.get', { memory_id: note.id }).id).toBe(
    note.id,
  );
  const decision = asSession<{ state: string }>(f, conductor.id, 'memory.propose', {
    project_id: f.project.id,
    key: 'parser/rule',
    kind: 'decision',
    text: 'Never parse in place.',
    based_on: asSession<{ signature: string }>(f, conductor.id, 'memory.context', {
      project_id: f.project.id,
    }).signature,
  });
  expect(decision.state).toBe('draft');
});

it('tells a conductor the usage of each session it spawned in read_state', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await spawn(
    f,
    conductor.id,
    script({ write: { path: 'docs.txt', text: 'docs\n' } }, { commit: 'Write the docs' }),
  );
  await settle(f, row(f, spawned));
  f.store.update<Session>(
    'sessions',
    {
      ...row(f, spawned),
      usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 },
    },
    row(f, spawned).revision,
  );
  const [turn] = f.turns(spawned);
  const at = (kind: string) =>
    f.store.events(0, f.project.id, 10000, [kind]).find((event) => event.aggregate_id === turn!.id)!
      .created_at;

  waitOutStatusReuse();
  await f.prefetch();
  const state = await asSession<Promise<{ changes: Record<string, unknown>[] }>>(
    f,
    conductor.id,
    'conductor.state',
    {},
  );

  expect(state.changes.find((each) => each.id === `session:${spawned}`)).toMatchObject({
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cached_input_tokens: 800,
      turns: 1,
      wall_ms: at('turn.completed') - at('turn.running'),
    },
  });
  const own = state.changes.find((each) => each.id === `session:${conductor.id}`);
  expect(own ?? {}).not.toHaveProperty('usage');
});
