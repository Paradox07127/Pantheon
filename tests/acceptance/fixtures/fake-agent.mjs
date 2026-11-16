import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const { readProcessIdentity } =
  process.platform === 'linux' ? await import('@pantheon/adapters') : {};
const self = fileURLToPath(import.meta.url);
const DEADLINE = 'Fake agent turn deadline exceeded';

const append = (ledger, entry) =>
  appendFileSync(ledger, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n');

// Arguments: marker ledger file lifetime_ms stop. The marker only tags the command line.
function writer(_marker, ledger, file, lifetime, stop) {
  const started = Date.now();
  const exit = () => {
    append(ledger, { type: 'writer_exit', pid: process.pid });
    process.exit(0);
  };
  process.on('SIGTERM', exit);
  setInterval(() => {
    if (existsSync(stop) || Date.now() - started >= Number(lifetime)) exit();
    else appendFileSync(file, 'tick\n');
  }, 10);
  process.send?.('ready', () => process.disconnect());
}

function intermediate(...args) {
  const escaped = spawn(process.execPath, [self, 'writer', ...args], {
    detached: true,
    stdio: ['ignore', 'inherit', 'ignore'],
  });
  escaped.unref();
  process.send(escaped.pid, () => process.exit(0));
}

function agent(marker, config) {
  const {
    dir,
    sockets,
    native_session_id,
    resumed,
    script,
    gates: opened,
    wall_time_ms,
  } = JSON.parse(config);
  const ledger = path.join(dir, `${native_session_id}.ledger.jsonl`);
  const stop = path.join(dir, 'stop');
  // Report the kernel's start time through proc_pidinfo (/proc on Linux), as real adapters do;
  // the JS clock starts later and would not match a process table read.
  let start_time_us;
  if (process.platform === 'linux') start_time_us = readProcessIdentity(process.pid).start_time_us;
  else {
    const info = Buffer.alloc(136);
    process
      .getBuiltinModule('node:ffi')
      .dlopen('/usr/lib/libSystem.B.dylib', {
        proc_pidinfo: {
          arguments: ['int32', 'int32', 'uint64', 'buffer', 'int32'],
          return: 'int32',
        },
      })
      .functions.proc_pidinfo(process.pid, 3, 0n, info, info.length);
    start_time_us = Number(info.readBigUInt64LE(120) * 1_000_000n + info.readBigUInt64LE(128));
  }
  const gates = new Set(opened);
  const gateWaiters = new Map();
  const permissions = new Map();
  // Writer children of write_child steps, with the turn that started each.
  const children = [];
  // Every event ever emitted; its cursor is its 1-based position.
  const events = [];
  // Where events go; undefined while no adapter is attached.
  let client = process.stdout;
  let tools = 0;
  let turn;

  const write = (stream, frame) => stream?.write(JSON.stringify(frame) + '\n');
  const publish = (event) => {
    const frame = { cursor: String(events.length + 1), event };
    events.push(frame);
    write(client, frame);
  };
  const emit = (current, event) => {
    if (!current.ended) publish({ turn_id: current.id, ...event });
  };
  const end = (current, status, error) => {
    if (current.ended) return;
    append(ledger, { type: 'turn_end', turn_id: current.id, status });
    emit(current, { kind: 'turn.completed', status, error });
    current.ended = true;
    clearTimeout(current.timer);
    permissions.clear();
    if (turn === current) turn = undefined;
    current.abort();
  };
  const gate = (name) =>
    gates.has(name)
      ? Promise.resolve()
      : new Promise((resolve) =>
          gateWaiters.set(name, [...(gateWaiters.get(name) ?? []), resolve]),
        );
  const writerArgs = ({ file, lifetime_ms }, limit) => [
    marker,
    ledger,
    file,
    String(Math.min(lifetime_ms, limit)),
    stop,
  ];

  const steps = {
    message: (current, text) => emit(current, { kind: 'message.delta', text }),
    tool(current, { name, input, output, ok = true }) {
      const tool_call_id = `tool-${++tools}`;
      emit(current, { kind: 'tool.started', tool_call_id, name, input });
      emit(current, { kind: 'tool.completed', tool_call_id, ok, output });
    },
    usage(current, usage) {
      emit(current, {
        kind: 'usage.updated',
        ...usage,
        cost_source: usage.cost_usd === undefined ? 'unknown' : 'provider_reported',
      });
    },
    async permission(current, { request_id, tool, detail }) {
      emit(current, { kind: 'permission.requested', request_id, tool, detail });
      const decision = await Promise.race([
        new Promise((resolve) => permissions.set(request_id, resolve)),
        current.aborted,
      ]);
      emit(current, { kind: 'permission.resolved', request_id, decision });
    },
    gate: (current, name) => Promise.race([gate(name), current.aborted]),
    sleep_ms: (current, ms) => Promise.race([delay(Math.min(ms, 1000)), current.aborted]),
    async write_child(_current, step) {
      const child = spawn(process.execPath, [self, 'writer', ...writerArgs(step, Infinity)], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      // The writer must have its SIGTERM handler before a group stop can reach it.
      await new Promise((resolve) => child.once('message', resolve));
      children.push({ turn_id: _current.id, child });
      append(ledger, {
        type: 'child',
        pid: child.pid,
        file: step.file,
        marker,
        turn_id: _current.id,
      });
    },
    async write_escaped(_current, step) {
      const args = writerArgs(step, 10000);
      let pid;
      if (step.double_fork) {
        const middle = spawn(process.execPath, [self, 'intermediate', ...args], {
          stdio: ['ignore', 'inherit', 'ignore', 'ipc'],
        });
        pid = await new Promise((resolve) => middle.once('message', resolve));
      } else
        pid = spawn(process.execPath, [self, 'writer', ...args], {
          detached: true,
          stdio: ['ignore', 'inherit', 'ignore'],
        }).pid;
      append(ledger, { type: 'escaped', pid, file: step.file, marker });
    },
  };

  const run = async (current, { steps: script = [], status = 'completed', error }) => {
    emit(current, { kind: 'turn.started' });
    for (const step of script) {
      if (current.ended) return;
      const [[kind, value]] = Object.entries(step);
      await steps[kind](current, value);
    }
    end(current, status, status === 'failed' ? error : undefined);
  };

  const ops = {
    started() {
      publish({ kind: 'session.started', native_session_id });
      return { ok: true };
    },
    send({ turn_id, input }) {
      const inputs = readFileSync(ledger, 'utf8')
        .split('\n')
        .filter((line) => line && JSON.parse(line).type === 'input').length;
      const turns = script.turns ?? [];
      const spec = turns[Math.min(inputs, turns.length - 1)] ?? {};
      if (spec.deliver === 'unsupported') {
        append(ledger, { type: 'input_rejected', turn_id, input });
        return { status: 'unsupported', reason: 'Scripted delivery failure' };
      }
      append(ledger, { type: 'input', turn_id, input });
      const current = { id: turn_id, ended: false };
      current.aborted = new Promise((resolve) => (current.abort = resolve));
      current.timer = setTimeout(() => end(current, 'failed', DEADLINE), wall_time_ms);
      turn = current;
      queueMicrotask(() => void run(current, spec));
      return { status: 'delivered' };
    },
    steer({ turn_id, input }) {
      if (!turn) return { status: 'unsupported', reason: 'No turn in flight' };
      append(ledger, { type: 'steer', turn_id, input });
      emit(turn, { kind: 'message.delta', text: `steer: ${input}` });
      return { status: 'delivered' };
    },
    permission({ request_id, decision }) {
      const resolve = permissions.get(request_id);
      if (!resolve) return { ok: false, reason: 'Unknown permission request' };
      permissions.delete(request_id);
      append(ledger, { type: 'permission_answer', request_id, decision });
      resolve(decision);
      return { ok: true };
    },
    interrupt({ turn_id }) {
      if (!turn) return { ok: false, reason: 'No turn in flight' };
      append(ledger, { type: 'interrupt', turn_id });
      end(turn, 'interrupted');
      return { ok: true };
    },
    // Ends the turn only after the script's interrupt gate opens and the turn's writers exited.
    interrupt_turn({ turn_id }) {
      const current = turn;
      if (!current || current.id !== turn_id)
        return { ok: false, reason: 'No such turn in flight' };
      append(ledger, { type: 'interrupt', turn_id });
      void (async () => {
        if (script.interrupt?.gate) await gate(script.interrupt.gate);
        for (const { child } of children.filter((entry) => entry.turn_id === turn_id))
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill('SIGTERM');
            await exited;
          }
        append(ledger, { type: 'stop_confirmed', turn_id });
        end(current, 'interrupted');
      })();
      return { ok: true };
    },
    open({ name }) {
      gates.add(name);
      for (const resolve of gateWaiters.get(name) ?? []) resolve();
      gateWaiters.delete(name);
    },
    status: () => ({
      ok: true,
      native_session_id,
      pid: process.pid,
      start_time_us,
      state: turn ? 'running' : 'idle',
    }),
    // Replays and switches in one step, so no event falls between the replay and the live stream.
    attach({ after }, connection) {
      append(ledger, { type: 'attach', after });
      client = connection;
      return {
        ok: true,
        cursor: String(events.length),
        events: events.slice(Number(after)),
        turn: turn?.id,
        permissions: [...permissions.keys()],
      };
    },
  };

  const serve = (input, output) => {
    const lines = createInterface({ input });
    lines.on('line', (line) => {
      const { id, op, ...params } = JSON.parse(line);
      const reply = ops[op](params, output);
      if (id !== undefined) write(output, { id, ...reply });
    });
    return lines;
  };

  append(ledger, {
    type: resumed ? 'resume' : 'start',
    native_session_id,
    pid: process.pid,
    marker,
  });
  // A vanished adapter turns writes into EPIPE; the events stay in the log for a later attach.
  process.stdout.on('error', () => {});
  // Without its adapter nobody can stop this process, so it ends with its transport unless it can be reattached.
  serve(process.stdin, process.stdout).on('close', () => {
    if (!sockets) {
      append(ledger, { type: 'agent_exit', pid: process.pid });
      process.exit(0);
    }
    if (client === process.stdout) client = undefined;
  });
  if (!sockets) write(process.stdout, { ready: true, start_time_us });
  else
    createServer((connection) => {
      connection.on('error', () => {});
      serve(connection, connection).on('close', () => {
        if (client === connection) client = undefined;
      });
    }).listen(path.join(sockets, `${process.pid}.sock`), () =>
      write(process.stdout, { ready: true, start_time_us }),
    );
}

const [mode, ...args] = process.argv.slice(2);
({ agent, writer, intermediate })[mode](...args);
