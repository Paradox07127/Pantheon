import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SessionStartError, requireThat } from '@pantheon/domain';
import { nativeEnvironment, report, terminate } from '@pantheon/adapters';

const agentPath = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const CONFIGURABLE = ['steer', 'resume', 'reattach', 'cost_reporting', 'budget_limit'];
const EXITED = { ok: false, status: 'unsupported', reason: 'Fake agent exited' };

const turnState = (id, delivered) => {
  const turn = { id, delivered };
  turn.completed = new Promise((resolve) => (turn.done = resolve));
  return turn;
};

export class FakeAgentAdapter {
  #sessions = new WeakMap();
  #live = new Set();
  #gates = new Set();
  #gateWaiters = new Set();
  #marker = randomUUID();
  /** Private directory of the agents' attach sockets, named <pid>.sock; only with reattach. */
  #sockets;
  #recovery;

  constructor({ dir, script, name = 'fake-agent', capabilities = {}, recovery = false }) {
    mkdirSync(dir, { recursive: true });
    this.#recovery = recovery;
    if (capabilities.reattach || (recovery && recovery.survive !== false)) {
      this.#sockets = path.join(dir, 'run');
      mkdirSync(this.#sockets, { mode: 0o700, recursive: true });
      chmodSync(this.#sockets, 0o700);
    }
    this.dir = dir;
    this.script = script;
    this.name = name;
    this.report = report(name, '1', true);
    for (const capability of CONFIGURABLE)
      this.report.capabilities[capability] = {
        status: capabilities[capability] ? 'supported' : 'unsupported',
        evidence: 'Fake agent configuration',
      };
    this.steer = capabilities.steer ? (handle, turn) => this.#steer(handle, turn) : undefined;
    this.resume = capabilities.resume
      ? (spec, native_session_id, sink) => this.#open(spec, native_session_id, sink, true)
      : undefined;
    this.attach = capabilities.reattach
      ? (handle, cursor, sink) => this.#attach(handle, cursor, sink)
      : undefined;
    this.interrupt = capabilities.interrupt ? (handle) => this.#interrupt(handle) : undefined;
  }

  /** Asks the agent to end the running turn; the stop is confirmed by its interrupted completion. */
  async #interrupt(handle) {
    const session = this.#sessions.get(handle);
    if (!session?.turn) return { ok: false, reason: 'No turn in flight' };
    const reply = await this.#call(session, { op: 'interrupt_turn', turn_id: session.turn.id });
    return reply.ok ? { ok: true } : { ok: false, reason: reply.reason };
  }

  async probe() {
    return this.report;
  }

  start(spec, sink) {
    return this.#open(spec, `fake-${spec.platform_session_id}`, sink, false);
  }

  async #open(spec, native_session_id, emit, resumed) {
    for (const [supported, name] of [
      [spec.skills.length === 0, 'skills'],
      [spec.mcp_servers.length === 0, 'MCP servers'],
      [spec.account_ref === undefined, 'account reference'],
      [spec.device_id === 'local', 'remote device'],
      [
        spec.locked_version === undefined || spec.locked_version === this.report.version,
        'locked version',
      ],
    ])
      requireThat(supported, 'unsupported_capability', `Cannot honor ${name}`);
    const child = spawn(
      process.execPath,
      [
        agentPath,
        'agent',
        this.#marker,
        JSON.stringify({
          dir: this.dir,
          sockets: this.#sockets,
          native_session_id,
          resumed,
          script: this.script,
          gates: [...this.#gates],
          wall_time_ms: spec.budget.wall_time_ms,
        }),
      ],
      {
        cwd: spec.cwd,
        env: nativeEnvironment(spec.env_allowlist),
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const session = this.#track(
      emit,
      child.stdout,
      (line) => child.stdin.write(line),
      new Promise((resolve) => child.once('close', resolve)),
    );
    session.child = child;
    session.drop = () => {
      child.removeAllListeners();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      child.unref();
    };
    this.#live.add(session);
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.once('exit', () => {
      this.#live.delete(session);
      const lost = () => this.#lost(session);
      session.lines.once('close', lost);
      // Lines already in the pipe arrive within this grace; an escaped writer can hold it open longer.
      setTimeout(lost, 50);
    });
    const handle = {
      platform_session_id: spec.platform_session_id,
      native_session_id,
      adapter_version: this.report.version,
      device_id: spec.device_id,
    };
    if (child.pid) handle.process_identity = { pid: child.pid };
    const ready = await session.ready;
    if (session.gone)
      throw new SessionStartError('Fake agent exited', await terminate(child, session.exited));
    handle.process_identity.start_time_us = ready.start_time_us;
    if (!resumed && this.script.start?.gate) await this.#gate(this.script.start.gate, Infinity);
    if (!resumed && this.script.start?.fail)
      throw new SessionStartError(this.script.start.fail, await terminate(child, session.exited));
    session.handle = handle;
    if (this.#recovery)
      writeFileSync(
        path.join(this.dir, `${native_session_id}.handle.json`),
        JSON.stringify(handle),
      );
    this.#sessions.set(handle, session);
    await this.#call(session, { op: 'started' });
    return handle;
  }

  #track(emit, input, write, exited) {
    const session = {
      emit,
      sequence: 0,
      state: 'idle',
      write,
      exited,
      gone: false,
      turn: undefined,
      pending: new Set(),
      calls: new Map(),
      callSequence: 0,
      lines: createInterface({ input }),
    };
    session.ready = new Promise((resolve) => (session.onReady = resolve));
    session.lines.on('line', (line) => {
      const frame = JSON.parse(line);
      if (frame.ready) session.onReady(frame);
      else if (frame.event) this.#deliver(session, frame.event, frame.cursor);
      else {
        session.calls.get(frame.id)(frame);
        session.calls.delete(frame.id);
      }
    });
    return session;
  }

  /** Agent events carry their cursor as sequence; events made up here continue after the last one. */
  #emit(session, event, cursor) {
    session.sequence = cursor === undefined ? session.sequence + 1 : Number(cursor);
    const value = { key: String(session.sequence), provider_sequence: session.sequence, ...event };
    if (this.#recovery && session.handle)
      appendFileSync(
        path.join(
          this.dir,
          `${session.handle.native_session_id}.${session.handle.process_identity?.pid}.events.jsonl`,
        ),
        JSON.stringify(value) + '\n',
      );
    session.emit(value);
  }

  #deliver(session, event, cursor) {
    if (event.kind === 'session.started') return this.#emit(session, event, cursor);
    const turn = session.turn;
    if (!turn || event.turn_id !== turn.id) return;
    if (event.kind === 'permission.requested') session.pending.add(event.request_id);
    this.#emit(session, event, cursor);
    if (event.kind === 'turn.completed') this.#finish(session);
  }

  #finish(session) {
    const turn = session.turn;
    session.turn = undefined;
    session.pending.clear();
    if (session.state === 'running') session.state = 'idle';
    turn.done();
  }

  #lost(session) {
    if (session.gone) return;
    session.gone = true;
    session.state = 'exited';
    session.onReady();
    for (const resolve of session.calls.values()) resolve(EXITED);
    session.calls.clear();
    if (session.turn?.delivered) {
      this.#emit(session, {
        turn_id: session.turn.id,
        kind: 'turn.completed',
        status: 'failed',
        error: 'Fake agent exited',
      });
      this.#finish(session);
    }
  }

  /** onReply runs as the reply line is read, before any line after it. */
  #call(session, frame, onReply = () => {}) {
    if (session.gone) return Promise.resolve(EXITED);
    const id = ++session.callSequence;
    return new Promise((resolve) => {
      session.calls.set(id, (reply) => {
        onReply(reply);
        resolve(reply);
      });
      session.write(JSON.stringify({ id, ...frame }) + '\n');
    });
  }

  /** The agent behind the handle's socket, only if it is the handle's very process. */
  async #reach(handle, emit) {
    const identity = handle.process_identity;
    const socket = connect(path.join(this.#sockets, `${identity?.pid}.sock`));
    socket.on('error', () => {});
    const session = this.#track(
      emit,
      socket,
      (line) => socket.write(line),
      new Promise((resolve) => socket.once('close', resolve)),
    );
    // readline re-emits socket errors; a refused or lost socket shows up as close.
    session.lines.on('error', () => {});
    session.child = { pid: identity?.pid };
    session.drop = () => socket.destroy();
    socket.once('close', () => {
      this.#live.delete(session);
      this.#lost(session);
    });
    const status = await this.#call(session, { op: 'status' });
    if (
      status.ok &&
      status.native_session_id === handle.native_session_id &&
      status.pid === identity?.pid &&
      status.start_time_us === identity?.start_time_us
    )
      return { session, status };
    socket.destroy();
    return {};
  }

  async #attach(handle, cursor, emit) {
    const { session } = await this.#reach(handle, emit);
    if (!session) {
      if (this.#recovery && (await this.#recordedHandle(handle))) {
        const text = await readFile(
          path.join(
            this.dir,
            `${handle.native_session_id}.${handle.process_identity?.pid}.events.jsonl`,
          ),
          'utf8',
        );
        for (const event of text
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)))
          if (event.provider_sequence > Number(cursor ?? '0')) emit(event);
        return { ok: true };
      }
      return { ok: false, reason: 'No agent of this handle behind its socket' };
    }
    const reply = await this.#call(session, { op: 'attach', after: cursor ?? '0' }, (reply) => {
      if (!reply.ok) return;
      session.handle = handle;
      session.reattached = true;
      this.#live.add(session);
      this.#sessions.set(handle, session);
      for (const { cursor, event } of reply.events) this.#emit(session, event, cursor);
      session.sequence = Number(reply.cursor);
      if (reply.turn) {
        session.turn = turnState(reply.turn, true);
        session.state = 'running';
      }
      for (const request_id of reply.permissions) session.pending.add(request_id);
    });
    if (!reply.ok) session.drop();
    return reply.ok ? { ok: true } : { ok: false, reason: reply.reason };
  }

  /** Resolves true once the gate is open, false at the deadline (epoch ms). */
  #gate(name, deadline) {
    if (this.#gates.has(name)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { name, resolve };
      this.#gateWaiters.add(waiter);
      if (deadline !== Infinity)
        waiter.timer = setTimeout(
          () => {
            this.#gateWaiters.delete(waiter);
            resolve(false);
          },
          Math.max(0, deadline - Date.now()),
        );
    });
  }

  /** @returns {Promise<import('@pantheon/domain').DeliveryReceipt>} */
  async send(handle, turn) {
    const session = this.#sessions.get(handle);
    if (!session || session.state !== 'idle')
      return { turn_id: turn.turn_id, status: 'unsupported', reason: 'Session is not idle' };
    session.state = 'running';
    const current = turnState(turn.turn_id, false);
    session.turn = current;
    const reply = await this.#call(session, {
      op: 'send',
      turn_id: turn.turn_id,
      input: turn.input,
    });
    if (reply.status === 'delivered') {
      current.delivered = true;
      return { turn_id: turn.turn_id, status: 'delivered' };
    }
    if (session.turn === current) {
      session.turn = undefined;
      if (session.state === 'running') session.state = 'idle';
    }
    current.done();
    return { turn_id: turn.turn_id, status: 'unsupported', reason: reply.reason };
  }

  /** @returns {Promise<import('@pantheon/domain').DeliveryReceipt>} */
  async #steer(handle, turn) {
    const session = this.#sessions.get(handle);
    if (!session?.turn)
      return { turn_id: turn.turn_id, status: 'unsupported', reason: 'No turn in flight' };
    const reply = await this.#call(session, {
      op: 'steer',
      turn_id: turn.turn_id,
      input: turn.input,
    });
    return reply.status === 'delivered'
      ? { turn_id: turn.turn_id, status: 'delivered' }
      : { turn_id: turn.turn_id, status: 'unsupported', reason: reply.reason };
  }

  async answerPermission(handle, request_id, decision) {
    const session = this.#sessions.get(handle);
    if (!session?.pending.has(request_id))
      return { ok: false, reason: 'Unknown permission request' };
    session.pending.delete(request_id);
    const reply = await this.#call(session, { op: 'permission', request_id, decision });
    return reply.ok ? { ok: true } : { ok: false, reason: reply.reason };
  }

  /** With reattach, a handle of another adapter is asked at its socket without attaching. */
  async inspect(handle) {
    let state = this.#sessions.get(handle)?.state;
    if (!state && this.#sockets && (this.attach || this.#recovery)) {
      const { session, status } = await this.#reach(handle, () => {});
      session?.drop();
      state = status?.state;
    }
    if (!state && this.#recovery && (await this.#recordedHandle(handle))) state = 'exited';
    return {
      state: state ?? 'unknown',
      native_session_id: handle.native_session_id,
      process_identity: state ? handle.process_identity : undefined,
      observed_at: new Date().toISOString(),
    };
  }

  async #recordedHandle(handle) {
    const saved = await readFile(
      path.join(this.dir, `${handle.native_session_id}.handle.json`),
      'utf8',
    )
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    return (
      saved &&
      saved.native_session_id === handle.native_session_id &&
      saved.process_identity?.pid === handle.process_identity?.pid &&
      saved.process_identity?.start_time_us === handle.process_identity?.start_time_us
    );
  }

  /** @returns {Promise<import('@pantheon/domain').CancelReceipt>} */
  async cancel(handle, deadline) {
    let session = this.#sessions.get(handle);
    if (!session && this.#recovery && this.#sockets) {
      ({ session } = await this.#reach(handle, () => {}));
      if (session) {
        session.handle = handle;
        session.reattached = true;
        this.#live.add(session);
        this.#sessions.set(handle, session);
      }
    }
    if (!session)
      return {
        stopped: false,
        deadline,
        finished_at: new Date().toISOString(),
        evidence: { method: 'none', members: [] },
        reason: 'Unknown handle',
      };
    session.state = 'unknown';
    const turn = session.turn;
    if (turn) {
      void this.#call(session, { op: 'interrupt', turn_id: turn.id });
      await Promise.race([turn.completed, delay(Math.max(0, deadline - Date.now()))]);
    }
    if (this.script.cancel?.gate && !(await this.#gate(this.script.cancel.gate, deadline)))
      return {
        stopped: false,
        deadline,
        finished_at: new Date().toISOString(),
        evidence: { method: 'none', members: [] },
        reason: 'Cancel gate still closed at the deadline',
      };
    let receipt = await terminate(session.child, session.exited, deadline);
    // A reattached session has no stdio pipe, so an escaped writer is only visible in the ledger.
    if (receipt.stopped && session.reattached) {
      const running = await this.#runningWriters(handle.native_session_id);
      if (running.length)
        receipt = {
          ...receipt,
          stopped: false,
          reason: `Writers outside the process group still running: ${running.join(', ')}`,
        };
    }
    if (session.turn === turn && turn) {
      this.#emit(session, { turn_id: turn.id, kind: 'turn.completed', status: 'interrupted' });
      this.#finish(session);
    }
    session.state = receipt.stopped ? 'exited' : 'unknown';
    if (receipt.stopped) delete handle.process_identity;
    return receipt;
  }

  /** @returns {Promise<import('@pantheon/domain').CancelReceipt>} */
  close(handle, deadline) {
    return this.cancel(handle, deadline);
  }

  /** Opens the gate for this adapter and every agent process, now and later. */
  open(name) {
    this.#gates.add(name);
    for (const waiter of this.#gateWaiters)
      if (waiter.name === name) {
        clearTimeout(waiter.timer);
        this.#gateWaiters.delete(waiter);
        waiter.resolve(true);
      }
    for (const session of this.#live) session.write(JSON.stringify({ op: 'open', name }) + '\n');
  }

  /** Drops every agent transport and forgets its handle without stopping a process, as a crashed daemon does. */
  abandon() {
    for (const session of this.#live) {
      session.gone = true;
      session.drop();
      this.#sessions.delete(session.handle);
    }
    this.#live.clear();
  }

  async ledger(nativeSessionId) {
    const text = await readFile(path.join(this.dir, `${nativeSessionId}.ledger.jsonl`), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /** Feeds events to the handle's sink regardless of turn or session state. */
  emitLate(handle, events) {
    const session = this.#sessions.get(handle);
    for (const event of events) this.#emit(session, event);
  }

  /** Like emitLate, but under keys of their own, so the agent's later events keep their keys. */
  emitStale(handle, events) {
    const session = this.#sessions.get(handle);
    for (const event of events)
      session.emit({ key: `stale-${randomUUID()}`, provider_sequence: session.sequence, ...event });
  }

  async #runningWriters(nativeSessionId) {
    const entries = await this.ledger(nativeSessionId).catch(() => []);
    const exited = new Set(entries.filter((e) => e.type === 'writer_exit').map((e) => e.pid));
    return entries
      .filter((e) => (e.type === 'child' || e.type === 'escaped') && !exited.has(e.pid))
      .map((e) => e.pid);
  }

  async stopWriters() {
    writeFileSync(path.join(this.dir, 'stop'), '');
    const end = Date.now() + 10000;
    for (;;) {
      const running = [];
      for (const file of await readdir(this.dir))
        if (file.endsWith('.ledger.jsonl'))
          running.push(...(await this.#runningWriters(file.slice(0, -'.ledger.jsonl'.length))));
      if (running.length === 0) return;
      if (Date.now() > end) throw new Error(`Writers still running: ${running.join(', ')}`);
      await delay(20);
    }
  }
}
