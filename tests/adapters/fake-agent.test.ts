import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  NATIVE_ENV_ALLOWLIST,
  SessionStartError,
  type AgentEvent,
  type Project,
  type Session,
  type SessionHandle,
  type SessionSpec,
  type SessionTurn,
} from '@pantheon/domain';
import { Control } from '@pantheon/control';
import { command } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import { FakeAgentAdapter } from '../acceptance/fixtures/fake-agent-adapter.mjs';
import { eventually, user } from '../helpers.js';

type Adapter = InstanceType<typeof FakeAgentAdapter>;
type Ledger = Record<string, unknown>[];

let root: string;
let work: string;
let opened: { adapter: Adapter; handle: SessionHandle }[];
let adapters: Adapter[];
let abandoned: { dir: string; handle: SessionHandle }[];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-fake-agent-'));
  work = path.join(root, 'work');
  mkdirSync(work);
  opened = [];
  adapters = [];
  abandoned = [];
});
afterEach(async () => {
  for (const adapter of adapters) await adapter.stopWriters();
  for (const { adapter, handle } of opened) await adapter.close(handle, Date.now() + 5000);
  // An agent left without an adapter waits for one forever; reattach and close it.
  for (const { dir, handle } of abandoned) {
    const rescuer = new FakeAgentAdapter({ dir, script: {}, capabilities: { reattach: true } });
    if ((await rescuer.attach!(handle, undefined, () => {})).ok)
      await rescuer.close(handle, Date.now() + 5000);
  }
  rmSync(root, { recursive: true, force: true });
});

const spec = (budget: Partial<SessionSpec['budget']> = {}): SessionSpec => ({
  platform_session_id: 'session-1',
  project_id: 'project-1',
  runtime: 'fake-agent',
  device_id: 'local',
  role: 'writer',
  cwd: work,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 10000, ...budget },
});
const make = (
  script: unknown,
  capabilities: Record<string, boolean> = {},
  dir = path.join(root, `agent-${adapters.length}`),
): Adapter => {
  const adapter = new FakeAgentAdapter({ dir, script, capabilities });
  adapters.push(adapter);
  return adapter;
};
const start = async (adapter: Adapter, events: AgentEvent[], options = spec()) => {
  const handle: SessionHandle = await adapter.start(options, (e: AgentEvent) => events.push(e));
  opened.push({ adapter, handle });
  return handle;
};
const send = (adapter: Adapter, handle: SessionHandle, turn_id = 'turn-1', input = 'Go') =>
  adapter.send(handle, { turn_id, input });
const completed = (events: AgentEvent[]) =>
  events.filter(
    (e): e is Extract<AgentEvent, { kind: 'turn.completed' }> => e.kind === 'turn.completed',
  );
const finished = (events: AgentEvent[]) => eventually(() => completed(events).length > 0);
const types = (ledger: Ledger) => ledger.map((entry) => entry.type);
const size = (file: string) => (existsSync(file) ? statSync(file).size : 0);
const growing = async (file: string) => {
  const before = size(file);
  await eventually(() => size(file) > before);
};

it('emits one scripted turn in order with exactly one completion and gapless sequences', async () => {
  const script = {
    turns: [
      {
        steps: [
          { message: 'Reading the module' },
          { tool: { name: 'read_file', input: { path: 'a.ts' }, output: 'contents' } },
          { usage: { input_tokens: 12, output_tokens: 4, context_tokens: 2048 } },
        ],
      },
    ],
  };
  const runs: AgentEvent[][] = [];
  for (const adapter of [make(script), make(script)]) {
    const events: AgentEvent[] = [];
    const handle = await start(adapter, events);
    expect(await send(adapter, handle)).toEqual({ turn_id: 'turn-1', status: 'delivered' });
    await finished(events);
    await adapter.close(handle, Date.now() + 5000);
    runs.push(events);
  }
  const events = runs[0]!;
  expect(events.map((e) => e.kind)).toEqual([
    'session.started',
    'turn.started',
    'message.delta',
    'tool.started',
    'tool.completed',
    'usage.updated',
    'turn.completed',
  ]);
  expect(events[0]).toMatchObject({ native_session_id: 'fake-session-1' });
  expect(events[3]).toMatchObject({ tool_call_id: 'tool-1', name: 'read_file' });
  expect(events[4]).toMatchObject({ tool_call_id: 'tool-1', ok: true, output: 'contents' });
  expect(events[5]).toMatchObject({ context_tokens: 2048, input_tokens: 12, output_tokens: 4 });
  expect(completed(events)).toEqual([expect.objectContaining({ status: 'completed' })]);
  expect(events.map((e) => e.provider_sequence)).toEqual(events.map((_, i) => i + 1));
  expect(new Set(events.map((e) => e.key)).size).toBe(events.length);
  expect(events.map((e) => e.key)).toEqual(events.map((e) => String(e.provider_sequence)));
  expect(events.slice(1).every((e) => e.turn_id === 'turn-1')).toBe(true);
  expect(runs[1], 'the same script yields the same events').toEqual(runs[0]);
});

it('reports cost only when the script provides it', async () => {
  const adapter = make({
    turns: [{ steps: [{ usage: { input_tokens: 3 } }, { usage: { cost_usd: 0.25 } }] }],
  });
  const events: AgentEvent[] = [];
  const handle = await start(adapter, events);
  await send(adapter, handle);
  await finished(events);
  const [unknown, reported] = events.filter((e) => e.kind === 'usage.updated');
  expect(unknown).toMatchObject({ cost_source: 'unknown', input_tokens: 3 });
  expect(unknown).not.toHaveProperty('cost_usd');
  expect(reported).toMatchObject({ cost_source: 'provider_reported', cost_usd: 0.25 });
});

it('holds a permission step until it is answered and records the answer first', async () => {
  const adapter = make({
    turns: [
      {
        steps: [
          { permission: { request_id: 'perm-1', tool: 'shell', detail: { command: 'ls' } } },
          { message: 'after the answer' },
        ],
      },
    ],
  });
  const events: AgentEvent[] = [];
  const handle = await start(adapter, events);
  await send(adapter, handle);
  await eventually(() => events.some((e) => e.kind === 'permission.requested'));
  await sleep(150);
  expect(events.at(-1)).toMatchObject({
    kind: 'permission.requested',
    request_id: 'perm-1',
    tool: 'shell',
    detail: { command: 'ls' },
  });
  expect(await adapter.answerPermission(handle, 'perm-unknown', 'allow')).toEqual({
    ok: false,
    reason: 'Unknown permission request',
  });
  expect(await adapter.answerPermission(handle, 'perm-1', 'deny')).toEqual({ ok: true });
  expect(await adapter.ledger('fake-session-1')).toContainEqual(
    expect.objectContaining({ type: 'permission_answer', request_id: 'perm-1', decision: 'deny' }),
  );
  await finished(events);
  expect(events.slice(-4).map((e) => e.kind)).toEqual([
    'permission.requested',
    'permission.resolved',
    'message.delta',
    'turn.completed',
  ]);
  expect(events.at(-3)).toMatchObject({ request_id: 'perm-1', decision: 'deny' });
  expect(completed(events)[0]).toMatchObject({ status: 'completed' });
});

it('rejects a scripted delivery failure without any turn events', async () => {
  const adapter = make({ turns: [{ deliver: 'unsupported' }] });
  const events: AgentEvent[] = [];
  const handle = await start(adapter, events);
  expect(await send(adapter, handle, 'turn-1', 'Refused')).toEqual({
    turn_id: 'turn-1',
    status: 'unsupported',
    reason: 'Scripted delivery failure',
  });
  await sleep(150);
  expect(events.map((e) => e.kind)).toEqual(['session.started']);
  const ledger = await adapter.ledger('fake-session-1');
  expect(ledger).toContainEqual(
    expect.objectContaining({ type: 'input_rejected', turn_id: 'turn-1', input: 'Refused' }),
  );
  expect(types(ledger)).not.toContain('input');
  expect((await adapter.inspect(handle)).state).toBe('idle');
});

it('exposes steer and resume only when configured, and steers only a turn in flight', async () => {
  const plain = make({ turns: [{}] });
  expect(plain.steer).toBeUndefined();
  expect(plain.resume).toBeUndefined();
  expect((plain as { attach?: unknown }).attach).toBeUndefined();
  for (const capability of ['steer', 'resume', 'cost_reporting', 'budget_limit'])
    expect(plain.report.capabilities[capability]).toEqual({
      status: 'unsupported',
      evidence: 'Fake agent configuration',
    });
  expect(plain.report.capabilities.text_execution!.status).toBe('supported');

  const adapter = make(
    { turns: [{ steps: [{ gate: 'hold' }, { message: 'done' }] }] },
    { steer: true },
  );
  expect(adapter.report.capabilities.steer!.status).toBe('supported');
  const events: AgentEvent[] = [];
  const handle = await start(adapter, events);
  const nudge = { turn_id: 'steer-1', input: 'Focus' };
  expect(await adapter.steer!(handle, nudge)).toEqual({
    turn_id: 'steer-1',
    status: 'unsupported',
    reason: 'No turn in flight',
  });
  await send(adapter, handle);
  await eventually(() => events.some((e) => e.kind === 'turn.started'));
  expect(await adapter.steer!(handle, nudge)).toEqual({ turn_id: 'steer-1', status: 'delivered' });
  expect(await adapter.ledger('fake-session-1')).toContainEqual(
    expect.objectContaining({ type: 'steer', turn_id: 'steer-1', input: 'Focus' }),
  );
  await eventually(() => events.some((e) => e.kind === 'message.delta'));
  expect(events.at(-1)).toMatchObject({
    kind: 'message.delta',
    text: 'steer: Focus',
    turn_id: 'turn-1',
  });
  adapter.open('hold');
  await finished(events);
  expect(completed(events)[0]).toMatchObject({ status: 'completed' });
});

it('resumes the same native session in a new process and continues the script', async () => {
  const adapter = make(
    { turns: [{ steps: [{ message: 'first' }] }, { steps: [{ message: 'second' }] }] },
    { resume: true },
  );
  const first: AgentEvent[] = [];
  const handle = await start(adapter, first);
  await send(adapter, handle);
  await finished(first);
  const pid = handle.process_identity!.pid;
  expect((await adapter.close(handle, Date.now() + 5000)).stopped).toBe(true);

  const second: AgentEvent[] = [];
  const resumed: SessionHandle = await adapter.resume!(spec(), 'fake-session-1', (e: AgentEvent) =>
    second.push(e),
  );
  opened.push({ adapter, handle: resumed });
  expect(resumed.native_session_id).toBe('fake-session-1');
  expect(resumed.process_identity!.pid).not.toBe(pid);
  expect(second[0]).toMatchObject({ key: '1', kind: 'session.started' });
  await send(adapter, resumed, 'turn-2');
  await finished(second);
  expect(second.find((e) => e.kind === 'message.delta')).toMatchObject({ text: 'second' });
  const ledger = await adapter.ledger('fake-session-1');
  expect(types(ledger).filter((t) => t === 'start' || t === 'resume')).toEqual(['start', 'resume']);
  expect(ledger.filter((e) => e.type === 'start' || e.type === 'resume')).toEqual([
    expect.objectContaining({ pid, native_session_id: 'fake-session-1' }),
    expect.objectContaining({ pid: resumed.process_identity!.pid }),
  ]);
});

it('holds start behind its gate and stops the process of a scripted start failure', async () => {
  const gated = make({ start: { gate: 'boot' }, turns: [{}] });
  const events: AgentEvent[] = [];
  let returned = false;
  const pending = start(gated, events).then((handle) => ((returned = true), handle));
  await sleep(400);
  expect(returned).toBe(false);
  expect(events).toEqual([]);
  gated.open('boot');
  await pending;
  expect(events.map((e) => e.kind)).toEqual(['session.started']);

  const failing = make({ start: { fail: 'Scripted start failure' }, turns: [{}] });
  const error = await failing.start(spec(), () => {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SessionStartError);
  expect((error as SessionStartError).message).toBe('Scripted start failure');
  expect((error as SessionStartError).stop.stopped).toBe(true);
});

it('delivers the interrupted completion before the cancel receipt and stops the writer', async () => {
  const adapter = make({
    turns: [
      { steps: [{ write_child: { file: 'child.txt', lifetime_ms: 1500 } }, { gate: 'never' }] },
    ],
  });
  const events: AgentEvent[] = [];
  const handle = await start(adapter, events);
  await send(adapter, handle);
  const file = path.join(work, 'child.txt');
  await growing(file);
  const receipt = await adapter.cancel(handle, Date.now() + 5000);
  expect(completed(events), 'completion precedes the receipt').toEqual([
    expect.objectContaining({ status: 'interrupted', turn_id: 'turn-1' }),
  ]);
  expect(receipt.stopped).toBe(true);
  const stoppedAt = size(file);
  await sleep(150);
  expect(size(file)).toBe(stoppedAt);
  const ledger = await adapter.ledger('fake-session-1');
  expect(ledger).toContainEqual(expect.objectContaining({ type: 'interrupt', turn_id: 'turn-1' }));
  expect(ledger).toContainEqual(
    expect.objectContaining({ type: 'turn_end', turn_id: 'turn-1', status: 'interrupted' }),
  );
});

it('waits for the cancel gate without signalling and gives up at the deadline', async () => {
  const adapter = make({
    cancel: { gate: 'release' },
    turns: [
      { steps: [{ write_child: { file: 'child.txt', lifetime_ms: 1500 } }, { gate: 'never' }] },
    ],
  });
  const events: AgentEvent[] = [];
  const handle = await start(adapter, events);
  await send(adapter, handle);
  const file = path.join(work, 'child.txt');
  await growing(file);
  const early = await adapter.cancel(handle, Date.now() + 150);
  expect(early).toMatchObject({
    stopped: false,
    reason: 'Cancel gate still closed at the deadline',
  });
  expect(early.evidence.signals ?? []).toEqual([]);
  await growing(file);

  let returned = false;
  const pending = adapter.cancel(handle, Date.now() + 5000).then((r) => ((returned = true), r));
  const before = size(file);
  await sleep(150);
  expect(returned).toBe(false);
  expect(size(file)).toBeGreaterThan(before);
  adapter.open('release');
  expect((await pending).stopped).toBe(true);
});

it.each([false, true])(
  'does not confirm a stop while an escaped writer holds the transport (double fork %s)',
  async (double_fork) => {
    const adapter = make({
      turns: [
        { steps: [{ write_escaped: { file: 'escaped.txt', lifetime_ms: 1500, double_fork } }] },
      ],
    });
    const events: AgentEvent[] = [];
    const handle = await start(adapter, events);
    await send(adapter, handle);
    await finished(events);
    expect(completed(events)[0]).toMatchObject({ status: 'completed' });
    const receipt = await adapter.close(handle, Date.now() + 300);
    expect(receipt.stopped).toBe(false);
    expect(receipt.reason).toBe('Process group is empty but its transport is still open');
    const escaped = (await adapter.ledger('fake-session-1')).find((e) => e.type === 'escaped');
    expect(escaped).toMatchObject({ file: 'escaped.txt', marker: expect.any(String) });
    await adapter.stopWriters();
    expect(await adapter.ledger('fake-session-1')).toContainEqual(
      expect.objectContaining({ type: 'writer_exit', pid: escaped!.pid }),
    );
  },
);

it('does not confirm a stop after reattach while an escaped writer is still running', async () => {
  const first = make(
    { turns: [{ steps: [{ write_escaped: { file: 'escaped.txt', lifetime_ms: 3000 } }] }] },
    { reattach: true },
  );
  const before: AgentEvent[] = [];
  const handle = await start(first, before);
  await send(first, handle);
  await finished(before);
  const second = crash(first, handle);
  expect(await attach(second, handle, before.at(-1)!.key, [])).toEqual({ ok: true });
  const receipt = await second.close(handle, Date.now() + 300);
  expect(receipt.stopped).toBe(false);
  await second.stopWriters();
});

it('fails a turn that outlives its wall time', async () => {
  const adapter = make({ turns: [{ steps: [{ gate: 'never' }] }] });
  const events: AgentEvent[] = [];
  const handle = await start(adapter, events, spec({ wall_time_ms: 200 }));
  await send(adapter, handle);
  await finished(events);
  expect(completed(events)).toEqual([
    expect.objectContaining({ status: 'failed', error: 'Fake agent turn deadline exceeded' }),
  ]);
});

it('feeds late events into a closed session sink with continuing keys', async () => {
  const adapter = make({ turns: [{ steps: [{ message: 'on time' }] }] });
  const events: AgentEvent[] = [];
  const handle = await start(adapter, events);
  await send(adapter, handle);
  await finished(events);
  expect((await adapter.close(handle, Date.now() + 5000)).stopped).toBe(true);
  const last = events.at(-1)!.provider_sequence;
  adapter.emitLate(handle, [
    { turn_id: 'turn-1', kind: 'message.delta', text: 'late' },
    { turn_id: 'turn-1', kind: 'turn.completed', status: 'completed' },
  ]);
  expect(events.slice(-2)).toEqual([
    {
      key: String(last + 1),
      provider_sequence: last + 1,
      turn_id: 'turn-1',
      kind: 'message.delta',
      text: 'late',
    },
    {
      key: String(last + 2),
      provider_sequence: last + 2,
      turn_id: 'turn-1',
      kind: 'turn.completed',
      status: 'completed',
    },
  ]);
});

/** Drops the adapter as a crashed daemon would and returns a fresh one on the same directory. */
const crash = (adapter: Adapter, handle: SessionHandle): Adapter => {
  adapter.abandon();
  abandoned.push({ dir: adapter.dir, handle });
  return make(adapter.script, { reattach: true }, adapter.dir);
};
const attach = async (
  adapter: Adapter,
  handle: SessionHandle,
  cursor: string | undefined,
  events: AgentEvent[],
) => {
  const receipt = await adapter.attach!(handle, cursor, (e: AgentEvent) => events.push(e));
  if (receipt.ok) opened.push({ adapter, handle });
  return receipt;
};
/** Neither inspect nor attach of a fresh adapter reaches the agent behind this handle. */
const unreachable = async (dir: string, handle: SessionHandle) => {
  const probe = new FakeAgentAdapter({ dir, script: {}, capabilities: { reattach: true } });
  expect(await probe.inspect(handle)).toMatchObject({
    state: 'unknown',
    process_identity: undefined,
  });
  expect(await probe.attach!(handle, undefined, () => {})).toEqual({
    ok: false,
    reason: 'No agent of this handle behind its socket',
  });
};
const untilLedger = async (adapter: Adapter, found: (ledger: Ledger) => boolean) => {
  let ledger: Ledger = [];
  await eventually(
    () => found(ledger),
    async () => (ledger = await adapter.ledger('fake-session-1')),
  );
};

it('outlives its adapter and replays to a new adapter what that adapter missed', async () => {
  const script = {
    turns: [
      {
        steps: [
          { message: 'before the crash' },
          { sleep_ms: 500 },
          { message: 'while detached' },
          { tool: { name: 'read_file', input: { path: 'a.ts' } } },
        ],
      },
      {
        steps: [
          { permission: { request_id: 'perm-1', tool: 'shell' } },
          { message: 'after the reattach' },
        ],
      },
    ],
  };
  const first = make(script, { reattach: true });
  expect(first.report.capabilities.reattach).toEqual({
    status: 'supported',
    evidence: 'Fake agent configuration',
  });
  expect(statSync(path.join(first.dir, 'run')).mode & 0o777).toBe(0o700);
  const before: AgentEvent[] = [];
  const handle = await start(first, before);
  await send(first, handle);
  await eventually(() => before.some((e) => e.kind === 'message.delta'));
  const second = crash(first, handle);
  await untilLedger(first, (ledger) => types(ledger).includes('turn_end'));
  expect(before.map((e) => e.kind)).not.toContain('turn.completed');
  expect(await second.inspect(handle)).toMatchObject({
    state: 'idle',
    process_identity: handle.process_identity,
  });

  const after: AgentEvent[] = [];
  expect(await attach(second, handle, before.at(-1)!.key, after)).toEqual({ ok: true });
  const all = [...before, ...after];
  expect(all.map((e) => e.provider_sequence)).toEqual(all.map((_, i) => i + 1));
  expect(new Set(all.map((e) => e.key)).size).toBe(all.length);
  expect(after.map((e) => e.kind)).toEqual([
    'message.delta',
    'tool.started',
    'tool.completed',
    'turn.completed',
  ]);
  expect(after[0]).toMatchObject({ text: 'while detached', turn_id: 'turn-1' });
  expect(after.at(-1)).toMatchObject({ status: 'completed', turn_id: 'turn-1' });

  expect(await send(second, handle, 'turn-2')).toEqual({ turn_id: 'turn-2', status: 'delivered' });
  await eventually(() => after.some((e) => e.kind === 'permission.requested'));
  expect(await second.answerPermission(handle, 'perm-1', 'allow')).toEqual({ ok: true });
  await eventually(() => completed(after).length === 2);
  expect(after.at(-2)).toMatchObject({ kind: 'message.delta', text: 'after the reattach' });
  expect(after.map((e) => e.provider_sequence)).toEqual(after.map((_, i) => before.length + i + 1));

  const located = structuredClone(handle);
  expect((await second.close(handle, Date.now() + 5000)).stopped).toBe(true);
  await unreachable(first.dir, located);
});

it('replays only the events after the cursor it is given', async () => {
  const first = make(
    { turns: [{ steps: [{ message: 'one' }, { message: 'two' }, { message: 'three' }] }] },
    { reattach: true },
  );
  const before: AgentEvent[] = [];
  const handle = await start(first, before);
  await send(first, handle);
  await finished(before);
  const second = crash(first, handle);
  const replayed: AgentEvent[] = [];
  expect(await attach(second, handle, before[1]!.key, replayed)).toEqual({ ok: true });
  expect(replayed).toEqual(before.slice(2));
  expect(await second.inspect(handle)).toMatchObject({ state: 'idle' });
  const located = structuredClone(handle);
  expect((await second.close(handle, Date.now() + 5000)).stopped).toBe(true);
  await unreachable(first.dir, located);
});

it('cancels a reattached turn with the same receipt rules', async () => {
  const first = make(
    {
      cancel: { gate: 'release' },
      turns: [
        { steps: [{ write_child: { file: 'child.txt', lifetime_ms: 5000 } }, { gate: 'never' }] },
      ],
    },
    { reattach: true },
  );
  const before: AgentEvent[] = [];
  const handle = await start(first, before);
  await send(first, handle);
  const file = path.join(work, 'child.txt');
  await growing(file);
  const second = crash(first, handle);
  const after: AgentEvent[] = [];
  expect(await attach(second, handle, before.at(-1)!.key, after)).toEqual({ ok: true });
  expect((await second.inspect(handle)).state).toBe('running');

  const early = await second.cancel(handle, Date.now() + 300);
  expect(completed(after), 'completion precedes the receipt').toEqual([
    expect.objectContaining({ status: 'interrupted', turn_id: 'turn-1' }),
  ]);
  expect(early).toMatchObject({
    stopped: false,
    reason: 'Cancel gate still closed at the deadline',
  });
  expect(early.evidence.signals ?? []).toEqual([]);
  await growing(file);

  second.open('release');
  const located = structuredClone(handle);
  const receipt = await second.cancel(handle, Date.now() + 5000);
  expect(receipt).toMatchObject({ stopped: true, evidence: { method: 'process_group' } });
  expect(receipt.evidence.members).toEqual([{ pid: located.process_identity!.pid }]);
  const stoppedAt = size(file);
  await sleep(150);
  expect(size(file)).toBe(stoppedAt);
  expect(completed(after)).toHaveLength(1);
  expect(await second.ledger('fake-session-1')).toContainEqual(
    expect.objectContaining({ type: 'interrupt', turn_id: 'turn-1' }),
  );
  await unreachable(first.dir, located);
});

it('refuses to attach a handle that does not match the agent behind its socket', async () => {
  const script = { turns: [{ steps: [{ message: 'still mine' }] }] };
  const owner = make(script, { reattach: true });
  const mine: AgentEvent[] = [];
  const theirs: AgentEvent[] = [];
  const handle = await start(owner, mine);
  const other = await start(owner, theirs, { ...spec(), platform_session_id: 'session-2' });
  const identity = handle.process_identity!;
  const intruder = make(script, { reattach: true }, owner.dir);
  for (const forged of [
    { ...handle, native_session_id: other.native_session_id },
    { ...handle, process_identity: other.process_identity },
    { ...handle, process_identity: { ...identity, start_time_us: identity.start_time_us! + 1 } },
    { ...handle, process_identity: { pid: identity.pid } },
    { ...handle, process_identity: undefined },
  ]) {
    const events: AgentEvent[] = [];
    expect(await intruder.attach!(forged, undefined, (e: AgentEvent) => events.push(e))).toEqual({
      ok: false,
      reason: 'No agent of this handle behind its socket',
    });
    expect((await intruder.inspect(forged)).state).toBe('unknown');
    expect(await send(intruder, forged)).toMatchObject({ status: 'unsupported' });
    expect(events).toEqual([]);
  }
  for (const id of ['fake-session-1', 'fake-session-2'])
    expect(types(await owner.ledger(id))).not.toContain('attach');
  await send(owner, handle);
  await finished(mine);
  expect(mine.find((e) => e.kind === 'message.delta')).toMatchObject({ text: 'still mine' });
});

it('drives a conversation turn through Control', async () => {
  const adapter = make({
    turns: [
      {
        steps: [
          { tool: { name: 'search', input: { query: 'release notes' } } },
          { usage: { input_tokens: 30, output_tokens: 8, cost_usd: 0.01 } },
          { message: 'Found it' },
        ],
      },
    ],
  });
  const cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  // Worktree sessions need a managed workspace root outside temporary directories.
  const workspaceRoot = mkdtempSync(path.join(cache, 'pantheon-fake-agent-')),
    source = path.join(root, 'source');
  mkdirSync(source);
  const store = new Store(path.join(root, 'state/control.sqlite')),
    files = new ArtifactFiles(path.join(root, 'state/artifacts')),
    control = new Control(store, files, [adapter], undefined, { workspaceRoot });
  const call = <T>(type: 'project.open' | 'session.create', input: Record<string, unknown>) =>
    control.execute(user, command(user.id, type, input, null)) as T;
  try {
    const project = call<Project>('project.open', { name: 'fake agent', roots: [source] });
    const session = call<Session>('session.create', {
      project_id: project.id,
      runtime: adapter.name,
      input: 'Find the notes',
    });
    const turn = store.list<SessionTurn>('session_turns').find((t) => t.session_id === session.id)!;
    await eventually(
      () => store.must<SessionTurn>('session_turns', turn.id).state === 'completed',
      () => control.tick(),
    );
    const kinds = store.events().map((e) => e.kind);
    expect(kinds).toContain('agent.tool.started');
    expect(kinds).toContain('agent.usage.updated');
    expect(store.must<Session>('sessions', session.id).state).toBe('open');
  } finally {
    await control.shutdown();
    store.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
