import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { startDaemon } from '@pantheon/daemon';
import type {
  AgentMessage,
  AgentProfile,
  LeadNote,
  Principal,
  Project,
  Session,
  SessionSpec,
  Timer,
} from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { ensureAgents } from '../../packages/control/dist/agents.js';
import { TOOL_GROUP_MODULES } from '../../packages/control/dist/agent-prompts.js';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
});

const MINUTE = 60_000;

const lead = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60 * MINUTE,
});

/** A fixture whose store clock starts at 09:00 local time tomorrow and moves only by advance. */
async function clockFixture() {
  const f = await workbenchFixture();
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  let now = start.getTime();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  const as = <T = unknown>(type: Parameters<Fixture['call']>[0], input: Record<string, unknown>) =>
    f.call<T>(type, { project_id: f.project.id, ...input }, null, lead(f, assistant.id));
  return {
    f,
    assistant,
    as,
    start: start.getTime(),
    advance: (ms: number) => (now += ms),
  };
}

const timersOf = (f: Fixture, kind: string) =>
  f.store.list<Timer>('timers').filter((timer) => timer.kind === kind);
const notesOf = (f: Fixture, kind: LeadNote['kind']) =>
  f.store
    .events(0, f.project.id, 1000, ['lead.note_added'])
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);
const trackerTurns = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');

it('wakes the resident with its follow-up note once the follow-up is due, and refuses another lead', async () => {
  const { f, assistant, as, advance } = await clockFixture();
  const timer = as<Timer>('agent.follow_up', {
    after_minutes: 30,
    note: 'Check whether the export task merged',
  });
  expect(timer).toMatchObject({
    kind: 'agent-follow-up',
    subject_id: assistant.id,
    state: 'pending',
    due_at: f.store.now() + 30 * MINUTE,
  });
  await f.control.tick();
  expect(notesOf(f, 'follow_up')).toEqual([]);

  advance(31 * MINUTE);
  await f.control.tick();
  expect(f.store.must<Timer>('timers', timer.id).state).toBe('fired');
  expect(notesOf(f, 'follow_up').map((note) => note.text)).toEqual([
    'Check whether the export task merged',
  ]);
  const woken = trackerTurns(f, assistant.id);
  expect(woken).toHaveLength(1);
  expect(woken[0]!.input).toContain('Check whether the export task merged');

  const other = await f.create('Plan the export feature');
  expect(() =>
    f.call(
      'agent.follow_up',
      { project_id: f.project.id, after_minutes: 30, note: 'Not mine to set' },
      null,
      lead(f, other.id),
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(() => as('agent.follow_up', { note: 'No time given' })).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
});

it('runs a routine every hour on the same timer, inside its active hours, until it is cancelled', async () => {
  const { f, assistant, as, advance, start } = await clockFixture();
  const routine = as<{ id: string }>('agent.routine.set', {
    prompt: 'Look for stalled tasks',
    every_minutes: 60,
    enabled: true,
  });
  const profile = () => f.store.must<AgentProfile>('agents', assistant.resident!.agent_id!);
  expect(profile().routines).toEqual([
    { id: routine.id, prompt: 'Look for stalled tasks', every_ms: 60 * MINUTE, enabled: true },
  ]);
  const [timer] = timersOf(f, 'agent-routine');
  expect(timer).toMatchObject({
    subject_id: `${profile().id}:${routine.id}`,
    state: 'pending',
    due_at: start + 60 * MINUTE,
  });

  advance(60 * MINUTE);
  await f.control.tick();
  expect(notesOf(f, 'routine').map((note) => note.text)).toEqual(['Look for stalled tasks']);
  expect(f.store.must<Timer>('timers', timer!.id)).toMatchObject({
    state: 'pending',
    due_at: start + 120 * MINUTE,
  });
  await eventually(
    () => trackerTurns(f, assistant.id).length === 1,
    () => f.control.tick(),
  );

  // At 10:00 the next run, 11:00, is outside 13:00-17:00, so it waits for 13:00.
  as('agent.routine.set', {
    id: routine.id,
    prompt: 'Look for stalled tasks',
    every_minutes: 60,
    active_hours: { from: '13:00', to: '17:00' },
    enabled: true,
  });
  const pending = timersOf(f, 'agent-routine').filter((each) => each.state === 'pending');
  expect(pending).toHaveLength(1);
  expect(pending[0]!.due_at).toBe(start + 4 * 60 * MINUTE);
  expect(profile().routines).toHaveLength(1);

  as('agent.routine.cancel', { routine_id: routine.id });
  expect(f.store.must<Timer>('timers', pending[0]!.id).state).toBe('cancelled');
  expect(profile().routines).toEqual([]);

  for (let index = 0; index < 10; index++)
    as('agent.routine.set', {
      id: `routine-${index}`,
      prompt: 'Check',
      at: '18:00',
      enabled: true,
    });
  expect(() =>
    as('agent.routine.set', { id: 'routine-10', prompt: 'Check', at: '18:00', enabled: true }),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  expect(profile().routines).toHaveLength(10);
});

it('gives each routine note its routine id and the time the routine last ran', async () => {
  const { f, assistant, as, advance, start } = await clockFixture();
  const routine = as<{ id: string }>('agent.routine.set', {
    prompt: 'Look for stalled tasks',
    every_minutes: 60,
    enabled: true,
  });
  advance(60 * MINUTE);
  await f.control.tick();
  await eventually(
    () => trackerTurns(f, assistant.id).length === 1,
    () => f.control.tick(),
  );
  expect(trackerTurns(f, assistant.id)[0]!.input).toContain(
    `routine="${routine.id}">\nWhat happened: your routine "${routine.id}" is due. Its prompt: "Look for stalled tasks"\nLast run: never.`,
  );
  advance(60 * MINUTE);
  await f.control.tick();
  const notes = notesOf(f, 'routine');
  expect(notes).toMatchObject([
    { routine_id: routine.id },
    { routine_id: routine.id, last_run_at: start + 60 * MINUTE },
  ]);
  expect(notes[0]!.last_run_at).toBeUndefined();
});

it('keeps the due time of a routine an update leaves as it was, and reschedules the one it pauses', async () => {
  const { f, assistant, advance, start } = await clockFixture();
  const profile = () => f.store.must<AgentProfile>('agents', assistant.resident!.agent_id!);
  const routines = (paused: boolean) => [
    { id: 'hourly', prompt: 'Look for stalled tasks', every_minutes: 60, enabled: true },
    { id: 'daily', prompt: 'Sum up the day', every_minutes: 24 * 60, enabled: !paused },
  ];
  const update = (paused: boolean) =>
    f.call<AgentProfile>('agent.update', {
      agent_id: profile().id,
      revision: profile().revision,
      routines: routines(paused),
    });
  const due = (routineId: string) =>
    timersOf(f, 'agent-routine').find(
      (timer) => timer.state === 'pending' && timer.subject_id === `${profile().id}:${routineId}`,
    )?.due_at;
  update(false);
  advance(20 * MINUTE);
  update(true);
  expect(due('hourly')).toBe(start + 60 * MINUTE);
  expect(due('daily')).toBeUndefined();
  update(false);
  expect(due('hourly')).toBe(start + 60 * MINUTE);
  expect(due('daily')).toBe(start + 20 * MINUTE + 24 * 60 * MINUTE);
});

/** A clock fixture whose assistant has one hourly routine with the precheck the user gave it. */
async function precheckFixture(argv: string[]) {
  const fixture = await clockFixture();
  const { f, assistant } = fixture;
  const profile = () => f.store.must<AgentProfile>('agents', assistant.resident!.agent_id!);
  const setRoutine = (fields: Record<string, unknown> = {}) =>
    f.call<AgentProfile>('agent.update', {
      agent_id: profile().id,
      revision: profile().revision,
      routines: [
        {
          id: 'gated',
          prompt: 'Look for stalled tasks',
          every_minutes: 60,
          enabled: true,
          precheck: { argv },
          ...fields,
        },
      ],
    });
  setRoutine();
  const skipped = () =>
    f.store
      .events(0, f.project.id, 1000, ['agent.routine_skipped'])
      .map(
        (event) =>
          event.payload as { routine_id: string; exit_code: number | null; output_tail: string },
      );
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const settled = () =>
    eventually(
      () => ctx.completions.size === 0,
      () => f.control.tick(),
      20_000,
    );
  return { ...fixture, profile, setRoutine, skipped, settled, root: f.project.roots[0]! };
}

it('wakes the agent on a routine whose precheck exits 0', async () => {
  const { f, assistant, advance, skipped } = await precheckFixture(['sh', '-c', 'exit 0']);
  advance(60 * MINUTE);
  await f.control.tick();
  await eventually(
    () => trackerTurns(f, assistant.id).length === 1,
    () => f.control.tick(),
    20_000,
  );
  expect(notesOf(f, 'routine')).toMatchObject([
    { routine_id: 'gated', text: 'Look for stalled tasks' },
  ]);
  expect(trackerTurns(f, assistant.id)[0]!.wake?.causes).toContain('routine');
  expect(skipped()).toEqual([]);
});

it('runs a routine precheck without the GPU the project opens to its gate commands', async () => {
  const execute = vi.spyOn(validation, 'runValidationCommand');
  const { f, assistant, advance } = await precheckFixture(['sh', '-c', 'exit 0']);
  f.call(
    'project.gateGpu.set',
    { project_id: f.project.id, enabled: true },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  advance(60 * MINUTE);
  await f.control.tick();
  await eventually(
    () => trackerTurns(f, assistant.id).length === 1,
    () => f.control.tick(),
    20_000,
  );
  expect(
    execute.mock.calls
      .filter(([input]) => input.key.startsWith('routine-precheck:'))
      .map(([input]) => input.gpu ?? false),
  ).toEqual([false]);
  execute.mockRestore();
});

it('records a run its precheck skips, and opens no turn for it', async () => {
  const { f, assistant, advance, skipped, start } = await precheckFixture([
    'sh',
    '-c',
    'echo nothing new; exit 1',
  ]);
  const sessions = f.store.list<Session>('sessions').length;
  advance(60 * MINUTE);
  await f.control.tick();
  await eventually(
    () => skipped().length === 1,
    () => f.control.tick(),
    20_000,
  );
  expect(skipped()).toEqual([
    {
      agent_id: assistant.resident!.agent_id,
      routine_id: 'gated',
      exit_code: 1,
      output_tail: expect.stringContaining('nothing new'),
    },
  ]);
  expect(notesOf(f, 'routine')).toEqual([]);
  expect(trackerTurns(f, assistant.id)).toEqual([]);
  expect(f.store.list<Session>('sessions')).toHaveLength(sessions);
  expect(timersOf(f, 'agent-routine').find((timer) => timer.state === 'pending')!.due_at).toBe(
    start + 120 * MINUTE,
  );
});

it("keeps the user's precheck when the resident replaces the routine, and takes none from an agent", async () => {
  const { as, profile } = await precheckFixture(['sh', '-c', 'test -f ready']);
  as('agent.routine.set', {
    id: 'gated',
    prompt: 'Look for stale branches',
    at: '18:00',
    enabled: true,
  });
  expect(profile().routines).toEqual([
    {
      id: 'gated',
      prompt: 'Look for stale branches',
      at: '18:00',
      enabled: true,
      precheck: { argv: ['sh', '-c', 'test -f ready'] },
    },
  ]);
  const precheck = { argv: ['sh', '-c', 'exit 0'] };
  expect(() =>
    as('agent.routine.set', { id: 'gated', prompt: 'Check', at: '18:00', enabled: true, precheck }),
  ).toThrow(/Unrecognized key.*precheck/);
});

it('neither wakes nor records a routine disabled while its precheck runs, and runs one precheck at a time', async () => {
  const { f, assistant, advance, setRoutine, skipped, settled, root } = await precheckFixture([
    'sh',
    '-c',
    'echo run >> started; while [ ! -f go ]; do sleep 0.05; done',
  ]);
  const started = () =>
    existsSync(path.join(root, 'started'))
      ? readFileSync(path.join(root, 'started'), 'utf8').split('\n').filter(Boolean).length
      : 0;
  advance(60 * MINUTE);
  await f.control.tick();
  await eventually(
    () => started() === 1,
    () => f.control.tick(),
    20_000,
  );
  advance(60 * MINUTE);
  await f.control.tick();
  setRoutine({ enabled: false });
  writeFileSync(path.join(root, 'go'), '');
  await settled();
  expect(started()).toBe(1);
  expect(notesOf(f, 'routine')).toEqual([]);
  expect(skipped()).toEqual([]);
  expect(trackerTurns(f, assistant.id)).toEqual([]);
});

it("gives the precheck the time of the routine's last run, not of a skipped one", async () => {
  const { f, advance, skipped, start } = await precheckFixture([
    'sh',
    '-c',
    'echo "last=$ROUTINE_LAST_RUN_AT"; test -z "$ROUTINE_LAST_RUN_AT"',
  ]);
  advance(60 * MINUTE);
  await f.control.tick();
  await eventually(
    () => notesOf(f, 'routine').length === 1,
    () => f.control.tick(),
    20_000,
  );
  for (const runs of [1, 2]) {
    advance(60 * MINUTE);
    await f.control.tick();
    await eventually(
      () => skipped().length === runs,
      () => f.control.tick(),
      20_000,
    );
  }
  const ran = new Date(start + 60 * MINUTE).toISOString();
  expect(skipped().map((run) => run.output_tail.trim())).toEqual([`last=${ran}`, `last=${ran}`]);
  expect(notesOf(f, 'routine')).toHaveLength(1);
});

it('stores what the resident tells the user as a message with its event', async () => {
  const { f, assistant, as } = await clockFixture();
  const message = as<AgentMessage>('agent.tell_user', {
    text: 'The export task merged; nothing else waits on you.',
    urgency: 'normal',
  });
  expect(f.store.list<AgentMessage>('agent_messages')).toEqual([
    {
      id: message.id,
      revision: 1,
      project_id: f.project.id,
      agent_id: assistant.resident!.agent_id,
      session_id: assistant.id,
      text: 'The export task merged; nothing else waits on you.',
      urgency: 'normal',
      at: f.store.now(),
    },
  ]);
  const [event] = f.store.events(0, f.project.id, 1000, ['agent_message.created']);
  expect(event).toMatchObject({
    aggregate_id: message.id,
    payload: {
      session_id: assistant.id,
      text: 'The export task merged; nothing else waits on you.',
      agent_name: 'Assistant',
    },
  });
});

/** The MCP tool names of an assistant resident whose profile has tools, or its template's. */
async function residentToolNames(tools?: AgentProfile['tools']) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-always-on-'));
  mkdirSync(path.join(root, 'project'));
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [],
    intervalMs: 60_000,
  });
  cleanup.push(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = (await daemon.control.execute(
    user,
    command(user.id, 'project.open', { name: 'always-on', roots: [path.join(root, 'project')] }),
  )) as Project;
  const ctx = (daemon.control as unknown as { ctx: ControlContext }).ctx;
  ctx.store.transaction(() => ensureAgents(ctx, project.id));
  const profile = daemon.control
    .agentList(user, project.id)
    .find((agent) => agent.template === 'assistant')!;
  if (tools) daemon.store.update<AgentProfile>('agents', { ...profile, tools }, profile.revision);
  const session = daemon.store.insert<Session>('sessions', {
    id: 'assistant-session',
    revision: 1,
    project_id: project.id,
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
    resident: { kind: 'assistant', agent_id: profile.id },
  });
  const credential = ctx.issueSessionCredential!(session.id, 'lead');
  const client = new Client({ name: 'always-on-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), 'apps/cli/dist/index.js'), 'mcp'],
      env: {
        ...(process.env as Record<string, string>),
        PANTHEON_DAEMON_URL: credential.daemon_url,
        PANTHEON_SESSION_TOKEN_FILE: credential.token_file,
      },
    }),
  );
  cleanup.push(() => client.close());
  return (await client.listTools()).tools.map((tool) => tool.name);
}

/** The control instructions the resident's first turn started with. */
async function firstInstructions(tools?: AgentProfile['tools']) {
  const f = await workbenchFixture();
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  if (tools) {
    const profile = f.store.must<AgentProfile>('agents', assistant.resident!.agent_id!);
    f.store.update<AgentProfile>('agents', { ...profile, tools }, profile.revision);
  }
  f.call('session.send', { session_id: assistant.id, input: 'Hello' }, assistant.revision);
  await eventually(
    () => f.start.mock.calls.length + f.resume.mock.calls.length > 0,
    () => f.control.tick(),
  );
  return ((f.start.mock.calls[0] ?? f.resume.mock.calls[0])![0] as SessionSpec)
    .control_instructions!;
}

const ALWAYS_ON = ['follow_up', 'tell_user', 'routine_set', 'routine_cancel'];

it('gives a default assistant the always-on tools and lines, and a board-only profile neither', async () => {
  const names = await residentToolNames();
  expect(names).toEqual(expect.arrayContaining(ALWAYS_ON));
  const instructions = await firstInstructions();
  expect(instructions).toContain(TOOL_GROUP_MODULES.always_on);

  const narrow = await residentToolNames(['board']);
  for (const name of ALWAYS_ON) expect(narrow).not.toContain(name);
  const plain = await firstInstructions(['board']);
  expect(plain).not.toContain(TOOL_GROUP_MODULES.always_on);
});
