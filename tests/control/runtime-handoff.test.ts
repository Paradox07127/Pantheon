import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { BoardPlan, LeadNote, Principal, Session, SessionTurn } from '@pantheon/domain';
import { Store } from '@pantheon/store';
import { buildHandoff } from '../../packages/control/dist/handoff.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const HANDOFF_LINE =
  '[Pantheon] You continue work that a fixture session did in this worktree. Its record follows, cut to fit; entries left out are marked. Check the files and git log for anything it does not show.';

const stores: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of stores.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A stored session record written the way turns and adapter events are stored. */
function storedRecord() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-handoff-'));
  const store = new Store(path.join(directory, 'control.sqlite'));
  stores.push({ store, directory });
  const session = {
    id: 'session-1',
    revision: 1,
    project_id: 'project-1',
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
  } as Session;
  let sequence = 0;
  const agent = (turn: SessionTurn, event: Record<string, unknown>) =>
    store.event(`agent.${event.kind as string}`, session, session.project_id, {
      key: String(++sequence),
      provider_sequence: sequence,
      turn_id: turn.id,
      ...event,
    });
  return {
    ctx: { store } as unknown as ControlContext,
    session,
    turn(input: string, attachments?: SessionTurn['attachments']): SessionTurn {
      const turn: SessionTurn = {
        id: `turn-${++sequence}`,
        revision: 1,
        project_id: session.project_id,
        session_id: session.id,
        input,
        ...(attachments ? { attachments } : {}),
        kind: 'send',
        delivery: 'delivered',
        state: 'completed',
      };
      store.insert('session_turns', turn);
      store.event('turn.queued', turn, session.project_id, turn);
      store.event('turn.running', turn, session.project_id, {});
      return turn;
    },
    say(turn: SessionTurn, text: string) {
      agent(turn, { kind: 'message.delta', text });
    },
    tool(turn: SessionTurn, name: string, input: unknown, ok: boolean, output: unknown) {
      const tool_call_id = `call-${++sequence}`;
      agent(turn, { kind: 'tool.started', tool_call_id, name, input });
      agent(turn, { kind: 'tool.completed', tool_call_id, ok, output });
    },
    fail(turn: SessionTurn, error: string) {
      agent(turn, { kind: 'turn.completed', status: 'failed', error });
    },
  };
}

it('keeps the latest input, the latest answer and the first input first, then newer entries in time order', () => {
  const r = storedRecord();
  const first = r.turn('Start the export');
  r.say(first, 'Short note');
  const middle = r.turn('b'.repeat(6000));
  r.say(middle, 'c'.repeat(6000));
  const latest = r.turn('d'.repeat(3000));
  r.say(latest, 'e'.repeat(3000));

  const handoff = buildHandoff(r.ctx, r.session);
  expect(handoff.split('\n')[0]).toBe(HANDOFF_LINE);
  expect(Buffer.byteLength(handoff)).toBeLessThan(16_500);
  expect(handoff).not.toContain('b'.repeat(6000));
  const order = ['Start the export', 'Short note', '[… 1 entries left out …]', 'c'.repeat(6000)]
    .concat(['d'.repeat(3000), 'e'.repeat(3000)])
    .map((text) => handoff.indexOf(text));
  expect(order.every((at) => at > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

it('counts the budget in UTF-8 bytes', () => {
  const r = storedRecord();
  r.turn('Start the export');
  const middle = r.turn('漢'.repeat(2000));
  r.say(middle, 'Done with the middle');
  const latest = r.turn('字'.repeat(2000));
  r.say(latest, 'x'.repeat(4000));

  const handoff = buildHandoff(r.ctx, r.session);
  expect(handoff).toContain('Start the export');
  expect(handoff).toContain('字'.repeat(2000));
  expect(handoff).toContain('x'.repeat(4000));
  expect(handoff).not.toContain('漢'.repeat(2000));
  expect(handoff).toContain('[… 1 entries left out …]');
});

it('records shell commands with their exit code or result and leaves out other tool calls', () => {
  const r = storedRecord();
  const turn = r.turn('Run the tests');
  r.tool(turn, 'commandExecution', { command: 'pnpm test', cwd: '/work' }, false, {
    text: 'one test failed',
    exitCode: 1,
    status: 'failed',
  });
  r.tool(turn, 'Bash', { command: 'git status' }, true, { content: 'nothing to commit' });
  r.tool(turn, 'Read', { file_path: '/work/secret-notes.txt' }, true, { content: 'hidden text' });
  r.fail(turn, 'Model stopped');

  const handoff = buildHandoff(r.ctx, r.session);
  expect(handoff).toContain('pnpm test');
  expect(handoff).toContain('exit 1');
  expect(handoff).toContain('one test failed');
  expect(handoff).toContain('git status');
  expect(handoff).toContain('ok');
  expect(handoff).toContain('nothing to commit');
  expect(handoff).toContain('Model stopped');
  expect(handoff).not.toContain('secret-notes');
  expect(handoff).not.toContain('hidden text');
});

it('lists the paths of the files and images attached to an input', () => {
  const r = storedRecord();
  const turn = r.turn('Implement the attached design', [
    {
      id: 'design',
      name: 'design.png',
      mime: 'image/png',
      path: '/work/tmp/attachments/design-design.png',
    },
    {
      id: 'notes',
      name: 'notes.md',
      mime: 'text/markdown',
      path: '/work/tmp/attachments/notes.md',
    },
  ]);
  r.say(turn, 'Done');

  expect(buildHandoff(r.ctx, r.session)).toContain(
    'User:\nImplement the attached design\n\nAttached files:\n- /work/tmp/attachments/design-design.png\n- /work/tmp/attachments/notes.md\n\nAssistant:\nDone',
  );
});

it('leaves out the given turn and the turns after it', () => {
  const r = storedRecord();
  const first = r.turn('Start the export');
  r.say(first, 'Export started');
  const second = r.turn('Add a header row');
  r.say(second, 'Header added');
  const third = r.turn('Add a footer row');
  r.say(third, 'Footer added');

  const handoff = buildHandoff(r.ctx, r.session, second.id);
  expect(handoff).toContain('Start the export');
  expect(handoff).toContain('Export started');
  for (const text of ['Add a header row', 'Header added', 'Add a footer row', 'Footer added'])
    expect(handoff).not.toContain(text);
});

it('leaves out rolled back turns and their output', () => {
  const r = storedRecord();
  const first = r.turn('Start the export');
  r.say(first, 'Export started');
  const second = r.turn('Add a header row');
  r.say(second, 'Header added');
  r.ctx.store.update('session_turns', { ...second, rolled_back: true }, second.revision);
  const third = r.turn('Add a footer row');
  r.say(third, 'Footer added');
  const fourth = r.turn('Add a summary row');

  const full = buildHandoff(r.ctx, r.session);
  for (const text of ['Start the export', 'Export started', 'Add a footer row', 'Footer added'])
    expect(full).toContain(text);
  expect(full).not.toContain('Add a header row');
  expect(full).not.toContain('Header added');
  expect(full).not.toContain('entries left out …]');

  const before = buildHandoff(r.ctx, r.session, fourth.id);
  expect(before).toContain('Footer added');
  expect(before).not.toContain('Header added');
  expect(before).not.toContain('Add a summary row');
});

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

const planTask = (fields: Partial<PlanTask> = {}): PlanTask => ({
  id: 'a',
  title: 'Serve exports over HTTP',
  goal: 'Exports download',
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: ['src/export'],
  acceptance: ['pnpm test'],
  ...fields,
});

function writePlan(f: Fixture, leadId: string, task: PlanTask) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, leadId),
  );
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** Gives the restart the stored identity of the session's exited process. */
const exitedProcess = (f: Fixture, sessionId: string) => {
  const session = current(f, sessionId);
  f.store.update(
    'sessions',
    { ...session, process_identity: { pid: 2_000_000_000 } },
    session.revision,
  );
};

/** A fixture project with a second writer runtime and an idle task session on the first one. */
async function idleTaskSession(task: PlanTask = planTask({ model: 'fixture' })) {
  const f = await workbenchFixture();
  const second = new FixtureAdapter(200);
  second.name = 'second';
  f.control.adapters.set(second.name, second);
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, task);
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    model: task.model,
    input: 'Build the export endpoint',
    task_id: `${lead.id}:a`,
  });
  await settle(f, worker);
  return { f, second, lead, worker };
}

const runtimeEvents = (f: Fixture) =>
  f.store
    .events(0, undefined, 10000)
    .filter((event) => event.kind === 'session.runtime_changed')
    .map((event) => event.payload);

const tellTask = (f: Fixture, leadId: string, text: string) =>
  f.call<SessionTurn>(
    'task.message',
    { project_id: f.project.id, task_id: 'a', text },
    null,
    leadOf(f, leadId),
  );

it('moves inputs queued before the runtime change in order after the old process closes', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const before = f.turns(worker.id).length;
  const order: string[] = [];
  const close = f.adapter.close.bind(f.adapter);
  vi.spyOn(f.adapter, 'close').mockImplementation(async (handle, deadline) => {
    const receipt = await close(handle, deadline);
    if (handle.platform_session_id === worker.id) order.push('old closed');
    return receipt;
  });
  const start = second.start.bind(second);
  vi.spyOn(second, 'start').mockImplementation(async (...args) => {
    order.push('new starts');
    return start(...args);
  });
  const oldSend = vi.spyOn(f.adapter, 'send');
  const newSend = vi.spyOn(second, 'send');
  const first = f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Keep the CSV header' },
    current(f, worker.id).revision,
  );
  const next = tellTask(f, lead.id, 'Then cover empty exports');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));

  await settle(f, worker);
  expect(order).toEqual(['old closed', 'new starts']);
  expect(oldSend).not.toHaveBeenCalled();
  expect(newSend.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id, next.id]);
  expect(newSend.mock.calls[0]![1].input).toContain(HANDOFF_LINE);
  expect(newSend.mock.calls[0]![1].input.match(/Keep the CSV header/g)).toHaveLength(1);
  expect(newSend.mock.calls[0]![1].input).not.toContain('Then cover empty exports');
  expect(newSend.mock.calls[1]![1].input).toBe('[Lead] Then cover empty exports');
  expect(f.turns(worker.id)).toHaveLength(before + 2);
  expect(current(f, worker.id).runtime).toBe('second');
});

it('finishes the executing turn on its runtime and moves only its undelivered successors', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  (f.adapter as { delay: number }).delay = 500;
  const active = f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Finish the in-flight check' },
    current(f, worker.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', active.id).state === 'running',
    () => f.control.tick(),
  );
  const queued = tellTask(f, lead.id, 'Prepare the next export');
  const last = tellTask(f, lead.id, 'Check the final format');
  const oldSend = vi.spyOn(f.adapter, 'send');
  const newSend = vi.spyOn(second, 'send');
  const close = vi.spyOn(f.adapter, 'close');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  await f.control.tick();
  expect(current(f, worker.id).runtime).toBe('fixture');
  expect(close).not.toHaveBeenCalled();
  expect(newSend).not.toHaveBeenCalled();

  await settle(f, worker);
  expect(f.store.must<SessionTurn>('session_turns', active.id).state).toBe('completed');
  expect(oldSend).not.toHaveBeenCalled();
  expect(newSend.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([queued.id, last.id]);
  expect(newSend.mock.calls[0]![1].input).toContain('Finish the in-flight check');
  expect(newSend.mock.calls[1]![1].input).not.toContain(HANDOFF_LINE);
});

it('keeps queued inputs until the old runtime confirms its stop', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const close = f.adapter.close.bind(f.adapter);
  let confirmed = false;
  vi.spyOn(f.adapter, 'close').mockImplementation(async (handle, deadline) =>
    confirmed
      ? close(handle, deadline)
      : {
          stopped: false,
          deadline,
          finished_at: new Date().toISOString(),
          evidence: { method: 'none', members: [] },
          reason: 'The old process has not stopped',
        },
  );
  const sent = vi.spyOn(second, 'send');
  const first = tellTask(f, lead.id, 'Continue the queued export');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  await eventually(
    () => current(f, worker.id).stop_pending === true,
    () => f.control.tick(),
  );
  expect(sent).not.toHaveBeenCalled();
  expect(f.store.must<SessionTurn>('session_turns', first.id)).toMatchObject({
    state: 'queued',
    delivery: 'pending',
  });
  expect(current(f, worker.id).runtime).toBe('fixture');

  confirmed = true;
  await settle(f, worker);
  expect(sent.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id]);
  expect(current(f, worker.id).runtime).toBe('second');
});

it('preserves the original queued turns when a restart precedes the runtime handoff', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const first = tellTask(f, lead.id, 'Continue the first export');
  const next = tellTask(f, lead.id, 'Then check its header');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  exitedProcess(f, worker.id);
  f.control.handles.clear();
  await f.restart(() => undefined);
  f.control.adapters.set(second.name, second);
  const sent = vi.spyOn(second, 'send');
  await settle(f, worker);

  expect(sent.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id, next.id]);
  expect(f.turns(worker.id).filter((turn) => turn.origin === 'continuation')).toEqual([]);
  expect(f.store.must<SessionTurn>('session_turns', first.id).state).toBe('completed');
  expect(sent.mock.calls[0]![1].input.match(/Continue the first export/g)).toHaveLength(1);
});

it('reconciles a held input whose delivery receipt was lost across restart before running successors', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const first = tellTask(f, lead.id, 'Continue the first export');
  const next = tellTask(f, lead.id, 'Then check its header');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  const session = current(f, worker.id);
  f.store.update(
    'sessions',
    {
      ...session,
      queued_handoff: { first_turn_id: first.id },
      process_identity: { pid: 2_000_000_000 },
    },
    session.revision,
  );
  f.store.update('session_turns', { ...first, state: 'running' }, first.revision);
  f.control.handles.clear();
  await f.restart(() => undefined);
  const sent = vi.spyOn(second, 'send');
  for (let index = 0; index < 3; index++) await f.control.tick();
  expect(current(f, worker.id)).toMatchObject({
    state: 'reconciling',
    queued_handoff: { first_turn_id: first.id, blocked: 'delivery_unknown' },
  });
  expect(f.store.must<SessionTurn>('session_turns', first.id).state).toBe('failed');
  expect(f.store.must<SessionTurn>('session_turns', next.id).state).toBe('queued');
  expect(sent).not.toHaveBeenCalled();

  const blocked = current(f, worker.id);
  f.store.update(
    'sessions',
    {
      ...blocked,
      stop_requested: { reason: 'Discard requested before restart', at: f.store.now(), by: 'user' },
    },
    blocked.revision,
  );
  await f.restart(() => undefined);
  expect(current(f, worker.id).outcome).toBe('discarded');
  expect(f.store.must<SessionTurn>('session_turns', next.id).state).toBe('failed');
});

it('keeps the held queue through graceful shutdown after the old process starts closing', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const first = tellTask(f, lead.id, 'Continue the first export');
  const next = tellTask(f, lead.id, 'Then check its header');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  await f.control.tick();
  expect(current(f, worker.id).queued_handoff?.first_turn_id).toBe(first.id);
  await f.control.shutdown();
  expect(f.store.must<SessionTurn>('session_turns', first.id).state).toBe('queued');
  exitedProcess(f, worker.id);
  await f.restart(() => undefined);
  const sent = vi.spyOn(second, 'send');
  await settle(f, worker);

  expect(sent.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id, next.id]);
  expect(f.turns(worker.id).filter((turn) => turn.origin === 'continuation')).toEqual([]);
});

it('retries the same queued input after a native launch failure and a daemon restart', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const first = tellTask(f, lead.id, 'Continue the first export');
  const next = tellTask(f, lead.id, 'Then check its header');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second', goal: 'Export as JSON' }));
  const start = vi.spyOn(second, 'start').mockRejectedValueOnce(new Error('Launch unavailable'));
  await eventually(
    () => start.mock.calls.length === 1,
    () => f.control.tick(),
  );
  expect(f.store.must<SessionTurn>('session_turns', first.id)).toMatchObject({
    state: 'queued',
    delivery: 'pending',
  });
  expect(current(f, worker.id).task?.generation ?? 1).toBe(1);
  const handoff = f.store.must<SessionTurn>('session_turns', first.id).handoff;
  expect(handoff).toContain(HANDOFF_LINE);
  await f.restart(() => undefined);
  f.control.adapters.set(second.name, second);
  const later = f.store.now() + 2000;
  vi.spyOn(f.store, 'now').mockImplementation(() => later);
  const sent = vi.spyOn(second, 'send');
  await settle(f, worker);

  expect(sent.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id, next.id]);
  expect(f.store.must<SessionTurn>('session_turns', first.id).handoff).toBe(handoff);
  expect(current(f, worker.id).task?.generation).toBe(2);
  expect(f.store.must<BoardPlan>('board_plans', lead.id).contract_changed).toEqual([]);
});

it('retries an explicitly refused input before sending any later queued message', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const first = tellTask(f, lead.id, 'Continue the first export');
  const next = tellTask(f, lead.id, 'Then check its header');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second', goal: 'Export as JSON' }));
  const delivered: string[] = [];
  const send = second.send.bind(second);
  const sent = vi.spyOn(second, 'send').mockImplementationOnce(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'unsupported',
    reason: 'Not delivered',
  }));
  sent.mockImplementation(async (handle, turn) => {
    delivered.push(turn.turn_id);
    return send(handle, turn);
  });
  await eventually(
    () => sent.mock.calls.length === 1,
    () => f.control.tick(),
  );
  expect(delivered).toEqual([]);
  expect(current(f, worker.id).task?.generation ?? 1).toBe(1);
  const later = f.store.now() + 2000;
  vi.spyOn(f.store, 'now').mockImplementation(() => later);
  await settle(f, worker);
  expect(sent.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id, first.id, next.id]);
  expect(delivered).toEqual([first.id, next.id]);
  expect(current(f, worker.id).task?.generation).toBe(2);
});

it('keeps an unknown delivery for reconciliation without replaying it or its successors', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const first = tellTask(f, lead.id, 'Continue the first export');
  const next = tellTask(f, lead.id, 'Then check its header');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  const sent = vi
    .spyOn(second, 'send')
    .mockRejectedValueOnce(new Error('Transport lost after send'));
  await eventually(
    () => current(f, worker.id).state === 'reconciling',
    () => f.control.tick(),
  );
  const later = f.store.now() + 60_000;
  vi.spyOn(f.store, 'now').mockImplementation(() => later);
  for (let index = 0; index < 4; index++) await f.control.tick();
  expect(sent.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id]);
  expect(current(f, worker.id).queued_handoff?.blocked).toBe('delivery_unknown');
  expect(f.store.must<SessionTurn>('session_turns', first.id).state).toBe('failed');
  expect(f.store.must<SessionTurn>('session_turns', next.id).state).toBe('queued');
});

it('accepts a new user message after explicit reconciliation of an unknown handoff delivery', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const first = tellTask(f, lead.id, 'Continue the first export');
  const next = tellTask(f, lead.id, 'Then check its header');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  const sent = vi
    .spyOn(second, 'send')
    .mockRejectedValueOnce(new Error('Transport lost after send'));
  await eventually(
    () => current(f, worker.id).state === 'reconciling',
    () => f.control.tick(),
  );
  const held = current(f, worker.id);
  f.store.update('sessions', { ...held, process_identity: { pid: 2_000_000_000 } }, held.revision);
  second.report.capabilities.resume = { status: 'supported', evidence: 'Fixture native history' };
  f.call(
    'session.resolve',
    { session_id: worker.id, choice: 'resume_session' },
    current(f, worker.id).revision,
  );
  await eventually(
    () => current(f, worker.id).state === 'open',
    () => f.control.tick(),
  );
  expect(current(f, worker.id).queued_handoff).toBeUndefined();
  const followup = f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Check the repository before continuing' },
    current(f, worker.id).revision,
  );
  await settle(f, worker);

  expect(sent.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id, followup.id]);
  expect(f.store.must<SessionTurn>('session_turns', first.id).state).toBe('failed');
  expect(f.store.must<SessionTurn>('session_turns', next.id).state).toBe('failed');
  expect(f.store.must<SessionTurn>('session_turns', followup.id).state).toBe('completed');
});

it('uses the latest runtime if the contract changes again during native startup', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const third = new FixtureAdapter(200);
  third.name = 'third';
  f.control.adapters.set(third.name, third);
  const first = tellTask(f, lead.id, 'Continue the first export');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  const start = second.start.bind(second);
  vi.spyOn(second, 'start').mockImplementationOnce(async (...args) => {
    writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'third' }));
    return start(...args);
  });
  const skipped = vi.spyOn(second, 'send');
  const sent = vi.spyOn(third, 'send');
  await settle(f, worker);

  expect(skipped).not.toHaveBeenCalled();
  expect(sent.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id]);
  expect(sent.mock.calls[0]![1].input).toContain(HANDOFF_LINE);
  expect(current(f, worker.id).runtime).toBe('third');
});

it('ends a repeatedly refused handoff without executing later queued messages', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const first = tellTask(f, lead.id, 'Continue the first export');
  const next = tellTask(f, lead.id, 'Then check its header');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  const sent = vi.spyOn(second, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'unsupported',
    reason: 'Input cannot be accepted',
  }));
  for (let count = 1; count <= 3; count++) {
    await eventually(
      () => sent.mock.calls.length === count,
      () => f.control.tick(),
    );
    skew += 4000;
  }
  await eventually(() => current(f, worker.id).state === 'open');
  expect(sent.mock.calls.map(([, turn]) => turn.turn_id)).toEqual([first.id, first.id, first.id]);
  expect(f.store.must<SessionTurn>('session_turns', first.id).state).toBe('failed');
  expect(f.store.must<SessionTurn>('session_turns', next.id).state).toBe('failed');
  expect(current(f, worker.id).queued_handoff).toBeUndefined();
});

it('moves an idle task session to the runtime its lead changed and starts it with a handoff', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const oldNative = current(f, worker.id).native_id;
  expect(oldNative).toBeDefined();

  const delivered = vi.spyOn(second, 'send');

  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  expect(f.store.must<BoardPlan>('board_plans', lead.id).contract_changed).toEqual([worker.id]);
  // The idle process of the old runtime closes before the session moves.
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.origin === 'lead'),
    () => f.control.tick(),
  );
  const told = f.turns(worker.id).filter((turn) => turn.origin === 'lead');
  expect(told).toHaveLength(1);
  expect(told[0]!.input.startsWith('[Pantheon] The lead changed this task.')).toBe(true);
  expect(told[0]!.handoff!.split('\n')[0]).toBe(HANDOFF_LINE);
  expect(told[0]!.handoff).toContain('Build the export endpoint');
  expect(runtimeEvents(f)).toEqual([{ from: 'fixture', to: 'second' }]);

  await settle(f, worker);
  expect(f.turns(worker.id).at(-1)).toMatchObject({ id: told[0]!.id, state: 'completed' });
  expect(delivered.mock.calls.map(([, turn]) => turn.input)).toEqual([
    `${told[0]!.handoff}\n\n${told[0]!.input}`,
  ]);
  const moved = current(f, worker.id);
  expect(moved.runtime).toBe('second');
  expect(moved.native_id).toBeDefined();
  expect(moved.native_id).not.toBe(oldNative);
});

it('refuses a lead message to an idle task session until it has moved to the runtime its lead changed', async () => {
  const { f, lead, worker } = await idleTaskSession();
  const message = () =>
    f.call<SessionTurn>(
      'task.message',
      { project_id: f.project.id, task_id: 'a', text: 'Continue on the new runtime' },
      null,
      leadOf(f, lead.id),
    );

  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  expect(message).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  expect(f.turns(worker.id).filter((turn) => turn.origin === 'lead')).toEqual([]);
  expect(current(f, worker.id).runtime).toBe('fixture');

  await eventually(
    () => f.turns(worker.id).some((turn) => turn.origin === 'lead'),
    () => f.control.tick(),
  );
  await settle(f, worker);
  expect(current(f, worker.id).runtime).toBe('second');
  expect(message()).toMatchObject({ input: '[Lead] Continue on the new runtime' });
});

it('refuses user input until an idle task session has moved to its changed runtime', async () => {
  const { f, lead, worker } = await idleTaskSession();
  const before = f.turns(worker.id).length;
  const delivered = vi.spyOn(f.adapter, 'send');
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));

  expect(() =>
    f.call<SessionTurn>(
      'session.send',
      { session_id: worker.id, input: 'Continue on the new runtime' },
      current(f, worker.id).revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  expect(f.turns(worker.id)).toHaveLength(before);
  expect(current(f, worker.id).state).toBe('open');
  expect(f.store.must<BoardPlan>('board_plans', lead.id).contract_changed).toEqual([worker.id]);
  expect(delivered).not.toHaveBeenCalled();

  await eventually(
    () => current(f, worker.id).runtime === 'second',
    () => f.control.tick(),
  );
  await settle(f, worker);
  expect(delivered).not.toHaveBeenCalled();
});

it('refuses lead messages queued behind a turn while the task waits to move runtime', async () => {
  const { f, lead, worker } = await idleTaskSession();
  (f.adapter as { delay: number }).delay = 1000;
  f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Finish the current check' },
    current(f, worker.id).revision,
  );
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  const before = f.turns(worker.id).length;

  expect(() =>
    f.call<SessionTurn>(
      'task.message',
      { project_id: f.project.id, task_id: 'a', text: 'Continue on the new runtime' },
      null,
      leadOf(f, lead.id),
    ),
  ).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  expect(f.turns(worker.id)).toHaveLength(before);
  expect(current(f, worker.id).runtime).toBe('fixture');
});

it('moves a task session to the default runtime when its lead removes the runtime override', async () => {
  const f = await workbenchFixture();
  const second = new FixtureAdapter(200);
  second.name = 'second';
  f.control.adapters.set(second.name, second);
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: 'second',
    model: 'fixture',
    input: 'Build the export endpoint',
    task_id: `${lead.id}:a`,
  });
  await settle(f, worker);

  writePlan(f, lead.id, planTask({ model: 'fixture' }));
  expect(f.store.must<BoardPlan>('board_plans', lead.id).contract_changed).toEqual([worker.id]);
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.origin === 'lead'),
    () => f.control.tick(),
  );
  await settle(f, worker);
  expect(runtimeEvents(f)).toEqual([{ from: 'second', to: 'fixture' }]);
  expect(current(f, worker.id).runtime).toBe('fixture');
  const told = f.turns(worker.id).filter((turn) => turn.origin === 'lead');
  expect(told).toHaveLength(1);
  expect(told[0]!.input).not.toContain('is not available');
});

it('leaves a task session on its runtime when the runtime its task names is not available', async () => {
  const { f, lead, worker } = await idleTaskSession();

  // A lead's own write of an unavailable runtime is refused, so the user's edit names it and the lead applies it.
  const planNow = () => f.store.must<BoardPlan>('board_plans', lead.id);
  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      lead_session_id: lead.id,
      base_version: planNow().plan_version,
      ops: [{ type: 'set_task', task_id: 'a', patch: { model: 'fixture', runtime: 'missing' } }],
    },
    null,
    user,
  );
  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      base_version: planNow().plan_version,
      ops: [
        { type: 'resolve_edit', edit_id: planNow().pending_edits[0]!.edit_id, decision: 'apply' },
      ],
    },
    null,
    leadOf(f, lead.id),
  );
  await f.control.tick();
  const told = f.turns(worker.id).filter((turn) => turn.origin === 'lead');
  expect(told).toHaveLength(1);
  expect(told[0]!.input.startsWith('[Pantheon] The lead changed this task.')).toBe(true);
  expect(told[0]!.input).toContain('missing');
  expect(current(f, worker.id).runtime).toBe('fixture');
  expect(runtimeEvents(f)).toEqual([]);
});

it('tells the lead in its inbox when the runtime its plan names is not available', async () => {
  const { f, lead, worker } = await idleTaskSession();
  const planNow = () => f.store.must<BoardPlan>('board_plans', lead.id);
  // A lead's own write of an unavailable runtime is refused, so the user's edit names it and the lead applies it.
  const editTask = async (patch: Partial<PlanTask>) => {
    f.call(
      'board.plan.edit',
      {
        project_id: f.project.id,
        lead_session_id: lead.id,
        base_version: planNow().plan_version,
        ops: [{ type: 'set_task', task_id: 'a', patch }],
      },
      null,
      user,
    );
    // An edit of the runtime waits for the lead; one of the title is in effect at once.
    const edit = planNow().pending_edits.find((pending) => pending.status === 'pending');
    if (edit)
      f.call(
        'board.plan.edit',
        {
          project_id: f.project.id,
          base_version: planNow().plan_version,
          ops: [{ type: 'resolve_edit', edit_id: edit.edit_id, decision: 'apply' }],
        },
        null,
        leadOf(f, lead.id),
      );
    await eventually(
      () => !planNow().contract_changed?.includes(worker.id),
      () => f.control.tick(),
    );
    await settle(f, worker);
  };
  const runtimeNotes = () =>
    f.store
      .kindEvents(f.project.id, ['lead.note_added'])
      .filter((event) => event.aggregate_id === lead.id)
      .map((event) => event.payload as LeadNote)
      .filter((note) => note.kind !== 'user_edit');

  await editTask({ model: 'fixture', runtime: 'missing' });
  expect(current(f, worker.id).runtime).toBe('fixture');
  const notes = runtimeNotes();
  expect(notes).toEqual([
    expect.objectContaining({ session_id: worker.id, task_id: 'a', kind: 'runtime_unavailable' }),
  ]);
  expect(notes[0]!.text).toContain('Runtime missing, which task a names, is not available');
  expect(notes[0]!.text).toContain('stays on fixture');
  expect(planNow().inbox.map((note) => note.id)).toContain(notes[0]!.id);

  await editTask({ title: 'Serve CSV exports over HTTP' });
  expect(f.turns(worker.id).filter((turn) => turn.origin === 'lead')).toHaveLength(2);
  expect(runtimeNotes()).toHaveLength(1);
});

const compact = (f: Fixture, sessionId: string) =>
  f.call<SessionTurn>('session.compact', { session_id: sessionId }, current(f, sessionId).revision);

it('refuses a compaction until an idle task session has moved to its changed runtime', async () => {
  const { f, lead, worker } = await idleTaskSession();
  const before = f.turns(worker.id).length;
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  expect(() => compact(f, worker.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  expect(f.turns(worker.id)).toHaveLength(before);
  expect(current(f, worker.id).state).toBe('open');
});

it('runs a compaction queued before the runtime change on the runtime it was asked on', async () => {
  const { f, second, lead, worker } = await idleTaskSession();
  const old = vi.spyOn(f.adapter, 'send');
  const moved = vi.spyOn(second, 'send');
  const turn = compact(f, worker.id);
  writePlan(f, lead.id, planTask({ model: 'fixture', runtime: 'second' }));
  await eventually(
    () => current(f, worker.id).runtime === 'second',
    () => f.control.tick(),
  );
  await settle(f, worker);
  expect(old.mock.calls.map(([, sent]) => sent)).toEqual([
    { turn_id: turn.id, input: '', compact: true },
  ]);
  expect(moved.mock.calls.every(([, sent]) => !sent.compact)).toBe(true);
  expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('completed');
});

it('keeps a changed model pending while a compaction queued before the change runs', async () => {
  const { f, lead, worker } = await idleTaskSession();
  (f.adapter as { delay: number }).delay = 400;
  const turn = compact(f, worker.id);
  writePlan(f, lead.id, planTask({ model: 'fixture-next' }));
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', turn.id).state === 'running',
    () => f.control.tick(),
  );
  expect(current(f, worker.id).requested_model).toBe('fixture');
  await settle(f, worker);
  await f.control.tick();
  await settle(f, worker);
  expect(current(f, worker.id).requested_model).toBe('fixture-next');
});

it('keeps a task session on its runtime and native session when only its model changed', async () => {
  const { f, lead, worker } = await idleTaskSession();
  const oldNative = current(f, worker.id).native_id;

  writePlan(f, lead.id, planTask({ model: 'fixture-next' }));
  await f.control.tick();
  const told = f.turns(worker.id).filter((turn) => turn.origin === 'lead');
  expect(told).toHaveLength(1);
  expect(told[0]!.input.startsWith('[Pantheon] The lead changed this task.')).toBe(true);
  expect(told[0]!.input).toContain('Model: fixture-next');
  expect(current(f, worker.id)).toMatchObject({
    runtime: 'fixture',
    native_id: oldNative,
    requested_model: 'fixture-next',
  });
  expect(runtimeEvents(f)).toEqual([]);
  await settle(f, worker);
  expect(f.turns(worker.id).at(-1)).toMatchObject({ id: told[0]!.id, state: 'completed' });
});

it('keeps the changed model pending while a message already queued on the old model runs', async () => {
  const { f, lead, worker } = await idleTaskSession();
  (f.adapter as { delay: number }).delay = 400;
  f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Finish the current check' },
    current(f, worker.id).revision,
  );
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );
  writePlan(f, lead.id, planTask({ model: 'fixture-next' }));
  f.call<SessionTurn>(
    'task.message',
    { project_id: f.project.id, task_id: 'a', text: 'Keep the export header' },
    null,
    leadOf(f, lead.id),
  );

  await settle(f, worker);
  await f.control.tick();
  await settle(f, worker);
  expect(current(f, worker.id).requested_model).toBe('fixture-next');
  expect(f.store.must<BoardPlan>('board_plans', lead.id).contract_changed).toEqual([]);
});
