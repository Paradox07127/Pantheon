import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  id,
  type HarnessAdapter,
  type SessionSpec,
  type AgentEventSink,
  type SessionHandle,
  type UserTurn,
  type DeliveryReceipt,
  type NativeStatus,
  type CancelReceipt,
  type Receipt,
  type PermissionDecision,
  type RuntimeModel,
  permissionRule,
} from '@pantheon/domain';
import { nativeEnvironment, report, terminate, validateSessionSpec } from './process.js';

interface FixtureSession {
  spec: SessionSpec;
  emit: AgentEventSink;
  sequence: number;
  state: NativeStatus['state'];
  child?: ChildProcessWithoutNullStreams;
  exited?: Promise<void>;
  turn?: FixtureTurn;
  /** The stop of a cancelled turn whose processes were not confirmed gone; close tries it again. */
  unconfirmedStop?: (deadline?: number) => Promise<CancelReceipt>;
}
interface FixtureTurn {
  interrupted: boolean;
  error?: string;
  error_code?: string;
  resets_at?: number;
  /** The context usage a usage step set, reported when the turn ends. */
  usage?: ScriptUsage;
  finish: (code: number | null) => void;
  /** Set for a script turn: ends its processes and its later steps. */
  stop?: (deadline?: number) => Promise<CancelReceipt>;
  /** Answers to the pending permission requests of a script turn, by request id. */
  permissions?: Map<string, (decision: PermissionDecision, cancelled?: boolean) => void>;
}
type ScriptCall = { tool: string; input: Record<string, unknown> };
type ScriptUsage = {
  context_tokens: number;
  context_window: number;
  auto_compact_at_tokens?: number;
};
type ScriptStep =
  | { say: string }
  | { write: { path: string; text: string } }
  | { write_outside: { path: string; text: string } }
  | { commit: string }
  | { tool: { name: string; arguments: Record<string, unknown> } }
  | { fail: string | { message: string; error_code?: string; resets_at?: number } }
  | { ask: ScriptCall }
  | { try: ScriptCall & { error: string } }
  | { trace: ScriptCall & { ok?: boolean; open?: boolean } }
  | { wait: number }
  | { hang: true }
  | { compact: 'auto' | 'manual' }
  | { usage: ScriptUsage };
type ScriptEvent =
  | { kind: 'message.delta'; text: string }
  | { kind: 'tool.started'; tool_call_id: string; name: string; input?: unknown }
  | { kind: 'tool.completed'; tool_call_id: string; ok: boolean; output?: unknown }
  | {
      kind: 'permission.requested';
      request_id: string;
      tool: string;
      rule: string;
      project_rule_supported: true;
      detail: unknown;
    }
  | { kind: 'context.compacted'; trigger: 'auto' | 'manual' };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const lstatIfExists = (file: string) =>
  lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
const within = (base: string, target: string): boolean => {
  const relative = path.relative(base, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
/** The path with its longest existing ancestor resolved through links. */
const realTarget = (target: string): string => {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      return realTarget(path.resolve(path.dirname(absolute), readlinkSync(absolute)));
    } catch (linkError) {
      if (!['ENOENT', 'EINVAL'].includes((linkError as NodeJS.ErrnoException).code ?? ''))
        throw linkError;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(realTarget(parent), path.basename(absolute));
  }
};
const groupEmpty = (child: ChildProcessWithoutNullStreams): boolean => {
  if (!child.pid) return true;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};
/** Why a read-only turn or the session sandbox refuses writes to these resolved paths, if it does. */
function writeRefusal(spec: SessionSpec, turn: UserTurn, targets: string[]): string | undefined {
  if (turn.read_only || spec.permission_mode === 'plan')
    return 'Fixture writes are refused in a read-only turn';
  if (!spec.sandbox) return;
  const inside = (root: string, target: string) => {
    const real = realTarget(root);
    return target === real || within(real, target);
  };
  for (const target of targets) {
    if (spec.sandbox.protected_entries.some((entry) => inside(entry.path, target)))
      return `Fixture write target is protected: ${target}`;
    if (!spec.sandbox.writable_roots.some((root) => inside(root, target)))
      return `Fixture write is outside the writable roots: ${target}`;
  }
}

/** Steps of a script turn (the first line that is `fixture-script`, then a JSON array on the next line; other lines ignored), or undefined for any other input. */
function scriptSteps(input: string): ScriptStep[] | Error | undefined {
  const lines = input.split('\n');
  const marker = lines.indexOf('fixture-script');
  if (marker === -1) return undefined;
  const line = lines[marker + 1];
  let steps: unknown;
  try {
    steps = JSON.parse(line ?? '');
  } catch {
    return new Error('Fixture script is not a JSON array');
  }
  if (!Array.isArray(steps)) return new Error('Fixture script is not a JSON array');
  const text = (value: unknown) => typeof value === 'string';
  const optional = (value: unknown, type: 'boolean' | 'number' | 'string') =>
    value === undefined || typeof value === type;
  const call = (value: unknown): value is Record<string, unknown> =>
    record(value) && text(value.tool) && record(value.input);
  const tokens = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  for (const step of steps)
    if (
      !record(step) ||
      Object.keys(step).length !== 1 ||
      !(
        text(step.say) ||
        text(step.commit) ||
        text(step.fail) ||
        (record(step.fail) &&
          text(step.fail.message) &&
          optional(step.fail.error_code, 'string') &&
          optional(step.fail.resets_at, 'number')) ||
        (record(step.write) && text(step.write.path) && text(step.write.text)) ||
        (record(step.write_outside) &&
          text(step.write_outside.path) &&
          path.isAbsolute(step.write_outside.path as string) &&
          text(step.write_outside.text)) ||
        (record(step.tool) && text(step.tool.name) && record(step.tool.arguments)) ||
        call(step.ask) ||
        (call(step.try) && text(step.try.error)) ||
        (call(step.trace) &&
          optional(step.trace.ok, 'boolean') &&
          optional(step.trace.open, 'boolean')) ||
        (typeof step.wait === 'number' &&
          Number.isFinite(step.wait) &&
          step.wait >= 0 &&
          step.wait <= 2147483647) ||
        step.hang === true ||
        step.compact === 'auto' ||
        step.compact === 'manual' ||
        (record(step.usage) &&
          Object.keys(step.usage).every((key) =>
            ['context_tokens', 'context_window', 'auto_compact_at_tokens'].includes(key),
          ) &&
          tokens(step.usage.context_tokens) &&
          tokens(step.usage.context_window) &&
          (step.usage.auto_compact_at_tokens === undefined ||
            tokens(step.usage.auto_compact_at_tokens)))
      )
    )
      return new Error(`Unknown fixture script step: ${JSON.stringify(step)}`);
  return steps as ScriptStep[];
}

export class FixtureAdapter implements HarnessAdapter {
  name = 'fixture';
  report = report('fixture', '1', true, {
    manual_compaction: {
      status: 'supported',
      evidence: 'Deterministic fixture emits a manual compaction in a maintenance turn',
    },
    compaction_instructions: {
      status: 'supported',
      evidence: 'Deterministic fixture ignores the instructions',
    },
    turn_write_unlock: {
      status: 'unsupported',
      evidence:
        'A fixture turn refuses writes by the read_only flag of the UserTurn it started with',
    },
  });
  backendProtocols = ['anthropic', 'openai-responses'] as const;
  private sessions = new WeakMap<SessionHandle, FixtureSession>();
  constructor(
    readonly delay = 40,
    readonly writeSentinel = false,
    readonly traceEvents = false,
    readonly stepTimeout = 30000,
  ) {}
  async probe() {
    return this.report;
  }
  async models(): Promise<RuntimeModel[]> {
    return [
      {
        id: 'fixture',
        label: 'Fixture',
        permission_modes: ['plan', 'ask', 'auto_edit'],
        efforts: ['low', 'high'],
        default_effort: 'low',
        default: true,
      },
    ];
  }
  async start(spec: SessionSpec, emit: AgentEventSink): Promise<SessionHandle> {
    return this.resume(spec, id(), emit);
  }
  async resume(
    spec: SessionSpec,
    native_session_id: string,
    emit: AgentEventSink,
  ): Promise<SessionHandle> {
    validateSessionSpec(spec, this.report.version);
    const handle: SessionHandle = {
      platform_session_id: spec.platform_session_id,
      native_session_id,
      adapter_version: this.report.version,
      device_id: spec.device_id,
    };
    this.sessions.set(handle, { spec, emit, sequence: 1, state: 'idle' });
    emit({ key: '1', provider_sequence: 1, kind: 'session.started', native_session_id });
    return handle;
  }
  async send(handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> {
    const session = this.sessions.get(handle);
    if (!session || session.state !== 'idle')
      return { turn_id: turn.turn_id, status: 'unsupported', reason: 'Session is not idle' };
    session.state = 'running';
    const current: FixtureTurn = {
      interrupted: false,
      finish: (code: number | null) => finish(code),
    };
    session.turn = current;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null): void => {
      if (session.turn !== current) return;
      clearTimeout(timer);
      session.turn = undefined;
      if (session.state === 'running') session.state = 'idle';
      session.emit({
        key: String(++session.sequence),
        provider_sequence: session.sequence,
        turn_id: turn.turn_id,
        kind: 'usage.updated',
        cost_source: 'unknown',
        ...(this.traceEvents ? { input_tokens: 10, output_tokens: 5 } : {}),
        ...current.usage,
      });
      session.emit({
        key: String(++session.sequence),
        provider_sequence: session.sequence,
        turn_id: turn.turn_id,
        kind: 'turn.completed',
        status:
          current.error !== undefined
            ? 'failed'
            : current.interrupted
              ? 'interrupted'
              : code === 0
                ? 'completed'
                : 'failed',
        error:
          current.error ??
          (code !== 0 && !current.interrupted ? `fixture exit ${code}` : undefined),
        ...(current.error !== undefined && current.error_code !== undefined
          ? { error_code: current.error_code }
          : {}),
        ...(current.error !== undefined && current.resets_at !== undefined
          ? { resets_at: current.resets_at }
          : {}),
      });
    };
    timer = setTimeout(() => {
      current.error = 'Fixture turn deadline exceeded';
      current.error_code = 'turn_deadline';
      session.state = 'unknown';
      if (current.stop) {
        void current.stop().then((receipt) => {
          if (receipt.stopped) finish(null);
        });
        return;
      }
      finish(null);
      if (session.child && session.exited) void terminate(session.child, session.exited);
    }, session.spec.budget.wall_time_ms);
    const steps: ScriptStep[] | Error | undefined = turn.compact
      ? [{ wait: this.delay }, { compact: 'manual' }]
      : scriptSteps(turn.input);
    if (steps !== undefined) {
      current.stop = this.runScript(session, turn, current, steps);
      return { turn_id: turn.turn_id, status: 'delivered' };
    }
    if (this.traceEvents) {
      const tool_call_id = `${turn.turn_id}:read`;
      session.emit({
        key: String(++session.sequence),
        provider_sequence: session.sequence,
        turn_id: turn.turn_id,
        kind: 'tool.started',
        tool_call_id,
        name: 'fixture.read',
        input: { path: 'fixture.txt' },
      });
      session.emit({
        key: String(++session.sequence),
        provider_sequence: session.sequence,
        turn_id: turn.turn_id,
        kind: 'tool.completed',
        tool_call_id,
        ok: true,
        output: { text: 'fixture contents' },
      });
    }
    try {
      const refusal = this.writeSentinel
        ? writeRefusal(session.spec, turn, [
            realTarget(path.join(session.spec.cwd, 'fixture-output.txt')),
          ])
        : undefined;
      if (refusal) {
        current.error = refusal;
        finish(null);
        return { turn_id: turn.turn_id, status: 'delivered' };
      }
      if (
        this.writeSentinel &&
        lstatSync(path.join(session.spec.cwd, 'fixture-output.txt'), {
          throwIfNoEntry: false,
        })?.isSymbolicLink()
      )
        throw new Error('Fixture write target is a symbolic link: fixture-output.txt');
      // Fixed program, never evaluates a prompt or receives arbitrary shell text.
      // A write sentinel opens its file once, never following a link put in its place later.
      const source = `const fs=require('node:fs');const c=fs.constants;const f=process.argv[1]==='write'?fs.openSync('fixture-output.txt',c.O_WRONLY|c.O_APPEND|c.O_CREAT|c.O_NOFOLLOW):undefined;const t=setInterval(()=>{if(f!==undefined)fs.writeSync(f,'tick\\n')},10);setTimeout(()=>{clearInterval(t);process.stdout.write('fixture completed\\n')},Number(process.argv[2]));`;
      // A read turn only waits, and a shell starts far faster than Node.
      const shell = !this.writeSentinel && process.platform !== 'win32';
      const child = spawn(
        shell ? '/bin/sh' : process.execPath,
        shell
          ? ['-c', 'sleep "$1" && echo fixture completed', 'fixture', String(this.delay / 1000)]
          : ['-e', source, this.writeSentinel ? 'write' : 'read', String(this.delay)],
        {
          cwd: session.spec.cwd,
          env: { ...session.spec.env, ...nativeEnvironment(session.spec.env_allowlist) },
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      session.child = child;
      if (child.pid) handle.process_identity = { pid: child.pid };
      child.stdout.on('data', (chunk) => {
        if (session.turn === current)
          session.emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id: turn.turn_id,
            kind: 'message.delta',
            text: String(chunk),
          });
      });
      child.stderr.resume();
      session.exited = new Promise<void>((resolve) => {
        child.once('error', (error) => {
          current.error = error.message || String(error);
          session.state = 'unknown';
          finish(null);
        });
        child.once('close', (code, signal) => {
          if (groupEmpty(child)) {
            session.child = undefined;
            session.exited = undefined;
            delete handle.process_identity;
          }
          if (signal === 'SIGINT') current.interrupted = true;
          finish(code);
          resolve();
        });
      });
    } catch (error) {
      current.error = String(error);
      finish(null);
    }
    return { turn_id: turn.turn_id, status: 'delivered' };
  }
  /** Runs the steps in order and finishes the turn; the returned stop ends its processes and later steps. */
  private runScript(
    session: FixtureSession,
    turn: UserTurn,
    current: FixtureTurn,
    steps: ScriptStep[] | Error,
  ): (deadline?: number) => Promise<CancelReceipt> {
    const cwd = session.spec.cwd;
    const environment = { ...session.spec.env, ...nativeEnvironment(session.spec.env_allowlist) };
    const children = new Set<{
      child: ChildProcessWithoutNullStreams;
      exited: Promise<string | undefined>;
    }>();
    let stopping = false;
    let writing: Promise<void> | undefined;
    const halted = new AbortController();
    const permissions: NonNullable<FixtureTurn['permissions']> = new Map();
    current.permissions = permissions;
    const live = (): boolean => session.turn === current && !stopping;
    const emit = (event: ScriptEvent): void => {
      if (live())
        session.emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          turn_id: turn.turn_id,
          ...event,
        });
    };
    const stop = async (deadline = Date.now() + 10000): Promise<CancelReceipt> => {
      stopping = true;
      halted.abort();
      for (const answer of permissions.values()) answer('deny', true);
      let written = true;
      if (writing) {
        let timer: NodeJS.Timeout | undefined;
        try {
          written = await Promise.race([
            // The script reports write failures; stop only waits for them to settle.
            writing.then(
              () => true,
              () => true,
            ),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      const receipts = await Promise.all(
        [...children].map(async (entry) => {
          const receipt = await terminate(entry.child, entry.exited, deadline);
          if (receipt.stopped) children.delete(entry);
          return receipt;
        }),
      );
      const stopped = written && receipts.every((receipt) => receipt.stopped);
      if (!stopped) session.state = 'unknown';
      return {
        stopped,
        deadline,
        finished_at: new Date().toISOString(),
        evidence: {
          method: receipts.some((receipt) => receipt.evidence.method === 'process_group')
            ? 'process_group'
            : 'none',
          members: receipts.flatMap((receipt) => receipt.evidence.members),
          live_count:
            receipts.length && receipts.every((receipt) => receipt.evidence.live_count === 0)
              ? 0
              : undefined,
          signals: receipts.flatMap((receipt) => receipt.evidence.signals ?? []),
        },
        reason:
          receipts.find((receipt) => receipt.reason)?.reason ??
          (written ? undefined : 'Process stop not confirmed by deadline'),
      };
    };
    /** exited resolves to undefined on exit code 0, otherwise to the reason with the stderr tail. */
    const launch = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
      if (!live()) throw new Error('Fixture script stopped');
      const child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      let failure: Error | undefined;
      child.stderr.on('data', (chunk) => (stderr = (stderr + String(chunk)).slice(-2000)));
      child.stdin.on('error', () => {});
      child.on('error', (error) => (failure ??= error));
      const exited = new Promise<string | undefined>((resolve) =>
        child.once('close', (code, signal) => {
          const tail = stderr.trim();
          resolve(
            code === 0
              ? undefined
              : `${failure?.message ?? `exited with ${signal ?? code}`}${tail ? `: ${tail}` : ''}`,
          );
        }),
      );
      const entry = { child, exited };
      children.add(entry);
      void exited.then(() => {
        if (!stopping && groupEmpty(child)) children.delete(entry);
      });
      return entry;
    };
    const writeRegular = async (destination: string, text: string) => {
      const file = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await file.stat();
        if (!opened.isFile()) throw new Error(`Fixture write target is protected: ${destination}`);
        // The checks resolved the path before the open, which follows a directory swapped for a link
        // since; the file opened must still be the one at the checked path.
        const parent = await realpath(path.dirname(destination));
        const there = await lstatIfExists(destination);
        if (
          parent !== path.dirname(destination) ||
          there?.dev !== opened.dev ||
          there?.ino !== opened.ino
        )
          throw new Error(`Fixture write target moved while it was opened: ${destination}`);
        if (!live()) throw new Error('Fixture script stopped');
        await file.truncate(0);
        await file.writeFile(text);
      } finally {
        await file.close();
      }
    };
    const write = async ({ path: file, text }: { path: string; text: string }) => {
      const base = path.resolve(cwd);
      const target = path.resolve(base, file);
      if (!within(base, target))
        throw new Error(`Fixture write is outside the working directory: ${file}`);
      const root = await realpath(base);
      let ancestor = path.dirname(target);
      // Validate before mkdir, so an outside directory link cannot create any directories.
      while (!(await lstatIfExists(ancestor))) ancestor = path.dirname(ancestor);
      const existing = await realpath(ancestor);
      if (existing !== root && !within(root, existing))
        throw new Error(`Fixture write is outside the working directory: ${file}`);
      const directory = path.join(existing, path.relative(ancestor, path.dirname(target)));
      // The first directory mkdir creates must be writable as well as the file itself.
      const created = path.join(existing, path.relative(ancestor, target).split(path.sep)[0]!);
      const refusal = writeRefusal(session.spec, turn, [
        created,
        path.join(directory, path.basename(target)),
      ]);
      if (refusal) throw new Error(refusal);
      if (!live()) throw new Error('Fixture script stopped');
      await mkdir(directory, { recursive: true });
      const parent = await realpath(directory);
      if (parent !== root && !within(root, parent))
        throw new Error(`Fixture write is outside the working directory: ${file}`);
      const destination = path.join(parent, path.basename(target));
      if ((await lstatIfExists(destination))?.isSymbolicLink())
        throw new Error(`Fixture write target is a symbolic link: ${file}`);
      if (!live()) throw new Error('Fixture script stopped');
      await writeRegular(destination, text);
    };
    /** Writes an absolute path judged only by the session sandbox, not by the working directory. */
    const writeOutside = async ({ path: file, text }: { path: string; text: string }) => {
      const target = path.resolve(file);
      let ancestor = path.dirname(target);
      while (!(await lstatIfExists(ancestor))) ancestor = path.dirname(ancestor);
      const existing = await realpath(ancestor);
      const directory = path.join(existing, path.relative(ancestor, path.dirname(target)));
      const created = path.join(existing, path.relative(ancestor, target).split(path.sep)[0]!);
      const refusal = writeRefusal(session.spec, turn, [
        created,
        path.join(directory, path.basename(target)),
      ]);
      if (refusal) throw new Error(refusal);
      if (!live()) throw new Error('Fixture script stopped');
      await mkdir(directory, { recursive: true });
      const destination = path.join(await realpath(directory), path.basename(target));
      const linked = writeRefusal(session.spec, turn, [destination]);
      if (linked) throw new Error(linked);
      if (!live()) throw new Error('Fixture script stopped');
      await writeRegular(destination, text);
    };
    /** Resolves after ms, or never without ms; either ends at once when the script stops. */
    const pause = (ms?: number) =>
      new Promise<void>((resolve) => {
        const timer = ms === undefined ? undefined : setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          halted.signal.removeEventListener('abort', done);
          resolve();
        }
        halted.signal.addEventListener('abort', done, { once: true });
      });
    const ask = ({ tool, input }: ScriptCall, tool_call_id: string) =>
      new Promise<PermissionDecision>((resolve) => {
        const request_id = id();
        permissions.set(request_id, (decision: PermissionDecision, cancelled?: boolean) => {
          if (!permissions.delete(request_id)) return;
          // A request withdrawn by stop is still resolved before the turn completes.
          if (session.turn === current)
            session.emit({
              key: String(++session.sequence),
              provider_sequence: session.sequence,
              turn_id: turn.turn_id,
              kind: 'permission.resolved',
              request_id,
              decision,
              ...(cancelled ? { cancelled: true as const } : {}),
            });
          resolve(decision);
        });
        emit({
          kind: 'permission.requested',
          request_id,
          tool,
          rule: permissionRule(tool, input),
          project_rule_supported: true,
          detail: { input, tool_call_id },
        });
      });
    const git = async (args: string[]): Promise<string> => {
      const { child, exited } = launch('git', args, environment);
      let output = '';
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      const failure = await exited;
      if (failure !== undefined) throw new Error(`git ${args[0]} ${failure}`);
      return output;
    };
    const commit = async (message: string) => {
      // A commit writes the git directory and its object store.
      const metadata = await git(['rev-parse', '--absolute-git-dir', '--git-path', 'objects']);
      const refusal = writeRefusal(
        session.spec,
        turn,
        metadata
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => realTarget(path.resolve(cwd, line))),
      );
      if (refusal) throw new Error(refusal);
      await git(['add', '-A']);
      await git(['commit', '-m', message]);
    };
    let mcp: Promise<(method: string, params: unknown) => Promise<unknown>> | undefined;
    const connect = async () => {
      const server = session.spec.pantheon_mcp;
      if (!server) throw new Error('Session has no Pantheon MCP server');
      const { child, exited } = launch(server.command, server.args, {
        ...environment,
        ...server.env,
      });
      const pending = new Map<
        number,
        { resolve: (result: unknown) => void; reject: (error: Error) => void }
      >();
      let closed: Error | undefined;
      let sequence = 0;
      createInterface({ input: child.stdout }).on('line', (line) => {
        let frame: { id?: unknown; result?: unknown; error?: { message?: unknown } } | null;
        try {
          frame = JSON.parse(line);
        } catch {
          return;
        }
        const waiter = typeof frame?.id === 'number' ? pending.get(frame.id) : undefined;
        if (!frame || !waiter) return;
        pending.delete(frame.id as number);
        if (frame.error)
          waiter.reject(new Error(String(frame.error.message ?? JSON.stringify(frame.error))));
        else waiter.resolve(frame.result);
      });
      void exited.then((reason) => {
        closed = new Error(`Pantheon MCP server ${reason ?? 'exited'}`);
        for (const waiter of pending.values()) waiter.reject(closed);
        pending.clear();
      });
      const send = (frame: object) =>
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
      const request = (method: string, params: unknown) =>
        closed
          ? Promise.reject(closed)
          : new Promise<unknown>((resolve, reject) => {
              const id = ++sequence;
              pending.set(id, { resolve, reject });
              send({ id, method, params });
            });
      try {
        await request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'pantheon-fixture', version: this.report.version },
        });
      } catch (error) {
        throw new Error(`Pantheon MCP initialize failed: ${messageOf(error)}`);
      }
      send({ method: 'notifications/initialized' });
      return request;
    };
    const call = async ({ name, arguments: input }: { name: string; arguments: unknown }) => {
      const request = await (mcp ??= connect());
      const result = (await request('tools/call', { name, arguments: input })) as
        { isError?: boolean; content?: { type?: string; text?: string }[] } | undefined;
      const text = (result?.content ?? [])
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      if (result?.isError) throw new Error(`${name} returned an error: ${text}`);
      return text;
    };
    const perform = async (step: ScriptStep, tool_call_id: string): Promise<void> => {
      if ('say' in step) return emit({ kind: 'message.delta', text: step.say });
      if ('fail' in step) {
        if (typeof step.fail === 'string') throw new Error(step.fail);
        current.error_code = step.fail.error_code;
        current.resets_at = step.fail.resets_at;
        throw new Error(step.fail.message);
      }
      if ('compact' in step) return emit({ kind: 'context.compacted', trigger: step.compact });
      if ('usage' in step) {
        current.usage = step.usage;
        return;
      }
      if ('wait' in step) return pause(step.wait);
      if ('hang' in step) return pause();
      if ('ask' in step || 'try' in step || 'trace' in step) {
        const { tool, input } = 'ask' in step ? step.ask : 'try' in step ? step.try : step.trace;
        emit({ kind: 'tool.started', tool_call_id, name: tool, input });
        if ('trace' in step) {
          if (!step.trace.open)
            emit({ kind: 'tool.completed', tool_call_id, ok: step.trace.ok ?? true });
          return;
        }
        if ('try' in step)
          return emit({ kind: 'tool.completed', tool_call_id, ok: false, output: step.try.error });
        const decision = await ask(step.ask, tool_call_id);
        return emit(
          decision === 'deny'
            ? { kind: 'tool.completed', tool_call_id, ok: false, output: 'Tool request denied' }
            : { kind: 'tool.completed', tool_call_id, ok: true },
        );
      }
      if ('write_outside' in step) {
        emit({ kind: 'tool.started', tool_call_id, name: 'fixture.write_outside', input: step });
        try {
          await (writing = writeOutside(step.write_outside));
          return emit({ kind: 'tool.completed', tool_call_id, ok: true });
        } catch (error) {
          // A refused or failed write is a failed call; the script goes on.
          return emit({
            kind: 'tool.completed',
            tool_call_id,
            ok: false,
            output: messageOf(error),
          });
        }
      }
      const name =
        'write' in step ? 'fixture.write' : 'commit' in step ? 'fixture.commit' : step.tool.name;
      emit({
        kind: 'tool.started',
        tool_call_id,
        name,
        input: 'tool' in step ? step.tool.arguments : step,
      });
      try {
        const output =
          'write' in step
            ? await (writing = write(step.write))
            : 'commit' in step
              ? await commit(step.commit)
              : await call(step.tool);
        emit({ kind: 'tool.completed', tool_call_id, ok: true, ...(output ? { output } : {}) });
      } catch (error) {
        emit({ kind: 'tool.completed', tool_call_id, ok: false, output: messageOf(error) });
        throw error;
      }
    };
    const run = async () => {
      if (steps instanceof Error) throw steps;
      for (const [index, step] of steps.entries()) {
        if (!live()) return;
        // Waiting is the point of these steps; the turn deadline and stop still end them.
        if ('wait' in step || 'hang' in step || 'ask' in step) {
          await perform(step, `${turn.turn_id}:${index}`);
          continue;
        }
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            perform(step, `${turn.turn_id}:${index}`),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Fixture script step ${index + 1} timed out`)),
                this.stepTimeout,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    };
    void run()
      .catch((error: unknown) => {
        if (live()) current.error = messageOf(error);
      })
      .then(async () => {
        if (!live()) return;
        const receipt = await stop();
        if (receipt.stopped) current.finish(0);
      });
    return stop;
  }
  async inspect(handle: SessionHandle): Promise<NativeStatus> {
    return {
      state: this.sessions.get(handle)?.state ?? 'unknown',
      native_session_id: handle.native_session_id,
      process_identity: this.sessions.has(handle) ? handle.process_identity : undefined,
      observed_at: new Date().toISOString(),
    };
  }
  async answerPermission(
    handle: SessionHandle,
    request_id: string,
    decision: PermissionDecision,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle),
      answer = session?.turn?.permissions?.get(request_id);
    if (!answer)
      return {
        ok: false,
        reason: 'No pending permission request with this id',
        ...(session ? { unknown_request: true } : {}),
      };
    answer(decision);
    return { ok: true };
  }
  /** Stops only the turn's own fixture process; the session stays idle for the next send. */
  async interrupt(handle: SessionHandle): Promise<Receipt> {
    const session = this.sessions.get(handle);
    const current = session?.turn;
    if (!session || !current) return { ok: false, reason: 'No fixture turn is running' };
    current.interrupted = true;
    if (current.stop) {
      const receipt = await current.stop();
      if (!receipt.stopped) return { ok: false, reason: receipt.reason };
    } else if (session.child && session.exited) {
      const receipt = await terminate(session.child, session.exited);
      if (!receipt.stopped) {
        session.state = 'unknown';
        return { ok: false, reason: receipt.reason };
      }
      delete handle.process_identity;
    }
    current.finish(null);
    return { ok: true };
  }
  async cancel(handle: SessionHandle, deadline: number): Promise<CancelReceipt> {
    const session = this.sessions.get(handle);
    if (!session)
      return {
        stopped: false,
        deadline,
        finished_at: new Date().toISOString(),
        evidence: { method: 'none', members: [] },
        reason: 'Unknown handle',
      };
    session.state = 'unknown';
    const current = session.turn;
    if (current) current.interrupted = true;
    const stop = current?.stop ?? session.unconfirmedStop;
    const receipt = stop
      ? await stop(deadline)
      : session.child && session.exited
        ? await terminate(session.child, session.exited, deadline)
        : {
            stopped: true,
            deadline,
            finished_at: new Date().toISOString(),
            evidence: { method: 'none' as const, members: [] },
          };
    session.unconfirmedStop = receipt.stopped ? undefined : stop;
    current?.finish(null);
    session.state = receipt.stopped ? 'exited' : 'unknown';
    if (receipt.stopped) delete handle.process_identity;
    return receipt;
  }
  async close(handle: SessionHandle, deadline: number): Promise<CancelReceipt> {
    return this.cancel(handle, deadline);
  }
}
