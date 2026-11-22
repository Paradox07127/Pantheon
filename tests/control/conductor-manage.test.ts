import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import {
  id,
  type Principal,
  type Project,
  type Review,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, waitOutStatusReuse } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

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

/** The input a spawned session receives for the conductor's message. */
const fromConductor = (f: Fixture, conductorId: string, text: string) =>
  `[Pantheon] From the main agent "${row(f, conductorId).title ?? ''}":\n${text}`;

/** Sets a budget of 100 input tokens and spends 150 of them in a turn of the session. */
function spendBudget(f: Fixture, sessionId: string) {
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
    session_id: sessionId,
    input: 'A message',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    usage: { input_tokens: 150, output_tokens: 0 },
  });
  f.store.event('turn.completed', spent, f.project.id, {});
  now += 1000;
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
      input: fromConductor(f, conductor.id, text),
      kind: 'send',
    });
    await settle(f, row(f, spawned));
  }
  const limited = refusal(() => message(spawned, 'One more thing'));
  expect(limited.code).toBe('rate_limited');
  expect(f.turns(spawned).at(-1)!.input).toBe(fromConductor(f, conductor.id, 'Cover the errors'));
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

  expect(f.turns(spawned).at(-1)).toMatchObject({
    input: fromConductor(f, conductor.id, 'Cover the tests too'),
    kind: 'steer',
  });
});

it('refuses to steer a spawned session that has no running turn and still sends to it', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await spawn(f, conductor.id, 'Port the parser');
  await settle(f, row(f, spawned));
  const message = (mode: 'send' | 'steer') =>
    asSession<{ turn_id: string }>(f, conductor.id, 'conductor.message', {
      session_id: spawned,
      text: 'Cover the tests too',
      mode,
    });

  const steer = refusal(() => message('steer'));

  expect(steer).toMatchObject({ code: 'invalid_state', message: expect.stringContaining('send') });
  expect(f.turns(spawned)).toHaveLength(1);
  expect(message('send').turn_id).toBe(f.turns(spawned).at(-1)!.id);
  expect(f.turns(spawned).at(-1)!.kind).toBe('send');
});

it('refuses a send that would give a fifth spawned session a turn to take', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const idle = await spawn(f, conductor.id, 'Write the docs');
  await settle(f, row(f, idle));
  const busy: string[] = [];
  for (const input of ['Task one', 'Task two', 'Task three', 'Task four'])
    busy.push(await spawn(f, conductor.id, input));

  const error = refusal(() =>
    asSession(f, conductor.id, 'conductor.message', { session_id: idle, text: 'Add the index' }),
  );

  expect(error.code).toBe('resource_busy');
  expect(error.message).toContain('At most 4 spawned sessions take a turn at a time');
  for (const sessionId of busy) expect(error.message).toContain(sessionId);
  expect(f.turns(idle)).toHaveLength(1);
});

it.each(['send', 'steer'] as const)(
  'refuses to %s a message to a spawned session once the project spent its budget',
  async (mode) => {
    const f = await workbenchFixture();
    const conductor = await openConductor(f);
    const spawned = await spawn(f, conductor.id, 'Port the parser');
    await settle(f, row(f, spawned));
    spendBudget(f, conductor.id);

    const error = refusal(() =>
      asSession(f, conductor.id, 'conductor.message', {
        session_id: spawned,
        text: 'More',
        mode,
      }),
    );

    expect(error).toMatchObject({
      code: 'budget_exceeded',
      message: 'Project runtime budget is exhausted',
    });
    expect(f.turns(spawned)).toHaveLength(1);
  },
);

it('marks the message of the conductor as the main agent writing, not the user', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await spawn(f, conductor.id, 'Port the parser');
  await settle(f, row(f, spawned));

  const { turn_id } = asSession<{ turn_id: string }>(f, conductor.id, 'conductor.message', {
    session_id: spawned,
    text: 'Add the tests',
  });

  const turn = f.store.must<SessionTurn>('session_turns', turn_id);
  expect(turn.origin).toBe('agent');
  expect(turn.input).toBe(
    `[Pantheon] From the main agent "${row(f, conductor.id).title ?? ''}":\nAdd the tests`,
  );
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
  spendBudget(f, conductor.id);
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
  const state = await asSession<Promise<State>>(f, conductor.id, 'conductor.state', {});

  expect(state.spawned).toEqual([
    {
      session_id: spawned,
      title: row(f, spawned).title ?? '',
      runtime: f.adapter.name,
      state: 'open',
      usage: {
        input_tokens: 1200,
        output_tokens: 300,
        cached_input_tokens: 800,
        turns: 1,
        wall_ms: at('turn.completed') - at('turn.running'),
      },
    },
  ]);
  expect(state.changes.find((each) => each.id === `session:${spawned}`)).toBeDefined();
  for (const change of state.changes) expect(change).not.toHaveProperty('usage');
});

type State = {
  changes: Record<string, unknown>[];
  spawned: {
    session_id: string;
    usage: Record<string, unknown>;
    group?: string;
    outside_owns?: string[];
    outside_owns_unknown?: true;
  }[];
};

it('lists a spawned session with no commits in read_state with its usage', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await spawn(f, conductor.id, 'Answer the question');
  await settle(f, row(f, spawned));
  f.store.update<Session>(
    'sessions',
    { ...row(f, spawned), usage: { input_tokens: 500, output_tokens: 40 } },
    row(f, spawned).revision,
  );

  const state = await asSession<Promise<State>>(f, conductor.id, 'conductor.state', {});

  expect(state.changes.map((each) => each.id)).not.toContain(`session:${spawned}`);
  expect(state.spawned).toEqual([
    expect.objectContaining({
      session_id: spawned,
      runtime: f.adapter.name,
      usage: { input_tokens: 500, output_tokens: 40, turns: 1, wall_ms: expect.any(Number) },
    }),
  ]);
});

it('shows a spawned session that reported only cost as tokens unreported, with no token counts', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await spawn(f, conductor.id, 'Answer the question');
  await settle(f, row(f, spawned));
  f.store.update<Session>(
    'sessions',
    {
      ...row(f, spawned),
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0.25, tokens_unreported: true },
    },
    row(f, spawned).revision,
  );

  const state = await asSession<Promise<State>>(f, conductor.id, 'conductor.state', {});

  const { usage } = state.spawned.find((each) => each.session_id === spawned)!;
  expect(usage).toMatchObject({ tokens_unreported: true, turns: 1 });
  for (const count of ['input_tokens', 'output_tokens', 'cached_input_tokens'])
    expect(usage, count).not.toHaveProperty(count);
});

it('shows a session the names of the project environment variables without their values', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>(
    'projects',
    { ...project, env: { API_TOKEN: 'secret-value' } },
    project.revision,
  );
  type Read = { project: { env?: Record<string, string> } };

  const read = asSession<Read>(f, conductor.id, 'project.read', { project_id: f.project.id });

  expect(read.project.env).toEqual({ API_TOKEN: '' });
  expect(f.call<Read>('project.read', { project_id: f.project.id }).project.env).toEqual({
    API_TOKEN: 'secret-value',
  });
});

it('ends the first message of a spawned session with what done means and reviews it item by item', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const acceptance = ['The parser keeps comments', 'Empty input gives an empty list'];
  const input = script({ write: { path: 'parser.txt', text: 'parser\n' } }, { commit: 'Port it' });

  const spawned = await spawn(f, conductor.id, input, { acceptance });
  await settle(f, row(f, spawned));
  const { review_id } = await asSession<Promise<{ review_id: string }>>(
    f,
    conductor.id,
    'conductor.review',
    { runtimes: [f.adapter.name], session_id: spawned },
  );

  expect(f.turns(spawned)[0]!.input).toBe(
    `${input}\n\nDone when:\n- The parser keeps comments\n- Empty input gives an empty list`,
  );
  const [reviewer] = f.store.must<Review>('reviews', review_id).session_ids;
  const prompt = f.turns(reviewer!)[0]!.input;
  const focus = prompt.slice(prompt.indexOf('Review focus:\n'), prompt.indexOf('\nChanges:\n'));
  expect(focus).toContain('verdict');
  for (const item of acceptance) expect(focus).toContain(`\n- ${item}\n`);
});

it('lists the changed files of a spawned session that lie outside the paths it owns', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const owning = await spawn(
    f,
    conductor.id,
    script(
      { write: { path: 'src/parser.txt', text: 'parser\n' } },
      { write: { path: 'README.md', text: 'readme\n' } },
      { commit: 'Port the parser' },
      { write: { path: 'src/lexer.txt', text: 'lexer\n' } },
      { write: { path: 'docs/notes.txt', text: 'notes\n' } },
    ),
    { owns: ['src/**'] },
  );
  const unbounded = await spawn(
    f,
    conductor.id,
    script({ write: { path: 'README.md', text: 'readme\n' } }),
  );
  await settle(f, row(f, owning));
  await settle(f, row(f, unbounded));

  const state = await asSession<Promise<State>>(f, conductor.id, 'conductor.state', {});

  const listed = (sessionId: string) =>
    state.spawned.find((each) => each.session_id === sessionId)!;
  expect([...(listed(owning).outside_owns as string[])].sort()).toEqual([
    'README.md',
    'docs/notes.txt',
  ]);
  expect(listed(unbounded)).not.toHaveProperty('outside_owns');
});

it('lists a file a spawned session moved out of the paths it does not own', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const owning = await spawn(
    f,
    conductor.id,
    script({ write: { path: 'src/parser.txt', text: 'parser\n' } }),
    { owns: ['src/**'] },
  );
  await settle(f, row(f, owning));
  const worktree = f.store.must<Workspace>('workspaces', row(f, owning).workspace_id!).path;
  git(worktree, 'mv', 'answer.txt', 'src/answer.txt');
  git(worktree, 'commit', '--quiet', '-m', 'Move the answer');

  const state = await asSession<Promise<State>>(f, conductor.id, 'conductor.state', {});

  const listed = state.spawned.find((each) => each.session_id === owning)!;
  expect(listed.outside_owns).toEqual(['answer.txt']);
});

it('says the owned paths of a spawned session could not be checked when its worktree cannot be read', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const owning = await spawn(
    f,
    conductor.id,
    script({ write: { path: 'src/a.txt', text: 'a\n' } }),
    {
      owns: ['src/**'],
    },
  );
  await settle(f, row(f, owning));
  const workspace = f.store.must<Workspace>('workspaces', row(f, owning).workspace_id!);
  f.store.update<Workspace>(
    'workspaces',
    { ...workspace, base_sha: '0'.repeat(40) },
    workspace.revision,
  );

  const state = await asSession<Promise<State>>(f, conductor.id, 'conductor.state', {});

  const listed = state.spawned.find((each) => each.session_id === owning)!;
  expect(listed).toMatchObject({ outside_owns_unknown: true });
  expect(listed).not.toHaveProperty('outside_owns');
});

it('starts one spawned session on each named runtime in one group, only when all of them fit', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const runtimes = [f.adapter.name, 'second-runtime', 'third-runtime'];
  for (const name of runtimes.slice(1)) {
    const adapter = new FixtureAdapter();
    adapter.name = name;
    f.control.adapters.set(name, adapter);
  }
  const busy = [await spawn(f, conductor.id, 'Task one'), await spawn(f, conductor.id, 'Task two')];
  const sessions = f.store.list<Session>('sessions').length;
  const many = (names: string[]) =>
    asSession<Promise<{ session_ids: string[] }>>(f, conductor.id, 'conductor.spawn', {
      runtimes: names,
      input: 'Port the parser',
      acceptance: ['The parser keeps comments'],
      owns: ['src/**'],
    });

  const refused = refusal(() => many(runtimes));
  expect(refused.code).toBe('resource_busy');
  expect(f.store.list<Session>('sessions')).toHaveLength(sessions);

  const { session_ids } = await many(runtimes.slice(1));
  expect(session_ids.map((sessionId) => row(f, sessionId).runtime)).toEqual(runtimes.slice(1));
  const [first, second] = session_ids.map((sessionId) => row(f, sessionId));
  expect(first!.contract).toEqual({
    acceptance: ['The parser keeps comments'],
    owns: ['src/**'],
    group: expect.any(String),
  });
  expect(second!.contract).toEqual(first!.contract);
  for (const sessionId of session_ids) {
    expect(row(f, sessionId).spawned_by).toEqual({ session_id: conductor.id });
    expect(f.turns(sessionId)[0]!.input).toBe(
      'Port the parser\n\nChange only these paths:\n- src/**\n\nDone when:\n- The parser keeps comments',
    );
  }
  for (const sessionId of [...busy, ...session_ids]) await settle(f, row(f, sessionId));
  const state = await asSession<Promise<State>>(f, conductor.id, 'conductor.state', {});
  const groups = new Map(state.spawned.map((each) => [each.session_id, each.group]));
  expect(session_ids.map((sessionId) => groups.get(sessionId))).toEqual([
    first!.contract!.group,
    first!.contract!.group,
  ]);
  for (const sessionId of busy) expect(groups.get(sessionId)).toBeUndefined();
});

it.each([
  ['both runtime and runtimes', { runtime: 'fixture', runtimes: ['fixture', 'second-runtime'] }],
  ['neither runtime nor runtimes', {}],
  ['the same runtime twice', { runtimes: ['fixture', 'fixture'] }],
  ['a model with runtimes', { runtimes: ['fixture', 'second-runtime'], model: 'model' }],
])('refuses a spawn naming %s as invalid input', async (_, named) => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const sessions = f.store.list<Session>('sessions').length;

  const error = refusal(() =>
    asSession(f, conductor.id, 'conductor.spawn', { input: 'Port the parser', ...named }),
  );

  expect(error.code).toBe('invalid_input');
  expect(f.store.list<Session>('sessions')).toHaveLength(sessions);
});
