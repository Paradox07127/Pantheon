import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { PANTHEON_VERSION } from '@pantheon/domain/version';
import { verifiedCapabilities } from './capabilities.js';
import {
  NATIVE_ENV_ALLOWLIST,
  requireThat,
  type Capability,
  type CapabilityReport,
  type CancelReceipt,
  type SessionSpec,
  type ProcessIdentity,
  type RemoteLaunch,
} from '@pantheon/domain';

export function nativeEnvironment(allowlist = NATIVE_ENV_ALLOWLIST): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
// sysctl {CTL_KERN, KERN_PROC, KERN_PROC_PID} and sizeof(struct kinfo_proc) from <sys/sysctl.h>.
const KINFO_PROC_SIZE = 648;
let sysctl:
  | ((
      name: Int32Array,
      length: number,
      out: Buffer,
      outLength: BigUint64Array,
      input: null,
      inputLength: bigint,
    ) => number)
  | undefined;
/**
 * Reads a process start time from the kernel, as ps does, since sandboxes cannot run setuid ps.
 * An exited process not yet reaped still reports its start time.
 */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (process.platform === 'linux') return readLinuxProcessIdentity(pid);
  if (!sysctl) {
    const ffi = process.getBuiltinModule('node:ffi');
    if (!ffi) throw new Error('node:ffi is unavailable, so process start times cannot be read');
    sysctl = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      sysctl: {
        arguments: ['buffer', 'uint32', 'buffer', 'buffer', 'pointer', 'uint64'],
        return: 'int32',
      },
    }).functions.sysctl;
  }
  const info = Buffer.alloc(KINFO_PROC_SIZE);
  const length = new BigUint64Array([BigInt(KINFO_PROC_SIZE)]);
  if (sysctl(new Int32Array([1, 14, 1, pid]), 4, info, length, null, 0n) !== 0)
    throw new Error(`Process ${pid} start time could not be read`);
  // The kernel returns no entry for a pid that does not exist.
  if (length[0] === 0n) return undefined;
  // kp_proc.p_pid at 40; kp_proc.p_starttime (tv_sec int64, tv_usec int32) at 0.
  if (length[0] !== BigInt(KINFO_PROC_SIZE) || info.readInt32LE(40) !== pid)
    throw new Error(`Process ${pid} start time could not be read`);
  return {
    pid,
    start_time_us: Number(info.readBigInt64LE(0)) * 1_000_000 + info.readInt32LE(8),
  };
}
// USER_HZ, the unit of /proc starttime, is fixed at 100 by the kernel ABI on x86 and arm64.
const LINUX_TICKS_PER_SECOND = 100;
function readLinuxProcessIdentity(pid: number): ProcessIdentity | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  // The command name may hold spaces and parentheses; fields after its last ")" start at state.
  const starttime = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
  if (!Number.isSafeInteger(starttime))
    throw new Error(`Process ${pid} start time could not be read`);
  return { pid, start_time_us: linuxStartMicros(starttime) };
}
/** The epoch microseconds of a /proc starttime, in clock ticks since boot. */
export function linuxStartMicros(ticks: number): number {
  const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
  if (!Number.isSafeInteger(btime)) throw new Error('Boot time could not be read');
  return btime * 1_000_000 + ticks * (1_000_000 / LINUX_TICKS_PER_SECOND);
}
export function processIdentity(pid: number): ProcessIdentity {
  // A child can exit before it is observed; a PID alone is not a verified start time.
  return readProcessIdentity(pid) ?? { pid };
}
export function validateSessionSpec(spec: SessionSpec, version: string): void {
  for (const [supported, name] of [
    [spec.skills.length === 0, 'skills'],
    [spec.remote === undefined || spec.mcp_servers.length === 0, 'MCP servers on a remote device'],
    [spec.account_ref === undefined, 'account reference'],
    [(spec.device_id === 'local') === (spec.remote === undefined), 'remote device'],
    // A backend key would have to appear on the device command line.
    [spec.remote === undefined || spec.backend === undefined, 'backend on a remote device'],
    [spec.locked_version === undefined || spec.locked_version === version, 'locked version'],
  ] as const)
    requireThat(supported, 'unsupported_capability', `Cannot honor ${name}`);
}
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
const DEVICE_GROUP = 'pantheon-device-group';
/** The local transport command that runs command on the device in cwd with the device env. */
export function remoteSpawn(
  remote: RemoteLaunch,
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
): { command: string; args: string[] } {
  const variables = Object.entries({ ...remote.env, ...env }).map(
    ([key, value]) => `${key}=${quote(value)}`,
  );
  const script = [
    // sshd starts a command without a terminal in a new session, so this pid names its process group.
    `printf '${DEVICE_GROUP} %s\\n' "$$" >&2;`,
    ...(cwd === undefined ? [] : [`cd ${quote(cwd)} &&`]),
    'exec',
    ...(variables.length ? ['env', ...variables] : []),
    ...[command, ...args].map(quote),
  ].join(' ');
  return { command: remote.transport[0]!, args: [...remote.transport.slice(1), script] };
}
/** The device process group a remoteSpawn command reports on its standard error; undefined if it never does. */
export function deviceGroupOf(child: ChildProcessWithoutNullStreams): Promise<number | undefined> {
  return new Promise((resolve) => {
    let head = '';
    const read = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      const found = new RegExp(`^${DEVICE_GROUP} (\\d+)\\n`, 'm').exec(head);
      if (!found && head.length <= 65536) return;
      child.stderr.off('data', read);
      resolve(found ? Number(found[1]) : undefined);
    };
    child.stderr.on('data', read);
    child.stderr.once('close', () => resolve(undefined));
  });
}
/** A process group a runtime leads on another device, and what stops of it have learned. */
export interface DeviceProcess {
  remote: RemoteLaunch;
  group: Promise<number | undefined>;
  allowlist: readonly string[];
  stopped?: boolean;
  /** A stop saw the group empty; its number may since name another group, so it is never signalled again. */
  emptied?: boolean;
  /** "pid start-time" of the processes stops saw in or under the group; once it emptied, those still running. */
  seen?: string[];
}
/**
 * Stops a device process group over the device link: closing the transport does not, as sshd sends
 * a command without a terminal no hang-up. Returns why the stop is not confirmed.
 */
export async function stopOnDevice(
  device: DeviceProcess,
  deadline: number,
): Promise<string | undefined> {
  let wait: NodeJS.Timeout | undefined;
  const group = await Promise.race([
    device.group,
    new Promise<undefined>((resolve) => {
      wait = setTimeout(() => resolve(undefined), deadline - Date.now());
    }),
  ]);
  clearTimeout(wait);
  if (group === undefined) return 'Device process group was not reported';
  const [command, ...args] = device.remote.plain_transport ?? device.remote.transport;
  const seen = device.seen ?? [];
  // As on this machine: descendants that left the group are listed while it has members, then checked.
  // Linux signals a group whose members have all exited but are not reaped; that group has stopped.
  // A group an earlier stop left running is signalled only while a process that stop saw is still in it.
  // Each process seen is printed before any signal, so a link cut at the deadline still reports it.
  const script = `g=${group}
known=${quote(seen.join('\n'))}
start() { set -- $(ps -o lstart= -p "$1" 2>/dev/null); echo "$*"; }
same() { printf '%s\\n' "$known" | while read -r p s; do [ -n "$p" ] && [ "$(start "$p")" = "$s" ] && ps -o stat= -p "$p" 2>/dev/null | grep -q '^ *[^Z ]' && echo "$p $s"; done; }
live() { kill -0 -$g 2>/dev/null && ! ps -axo pgid=,stat= | awk -v g=$g '$1 == g { n++; if ($2 ~ /^Z/) z++ } END { exit !(n && n == z) }'; }
if ${device.emptied ? 'false' : 'live'}; then
  if [ -n "$known" ]; then
    owned=
    for p in $(same | cut -d ' ' -f 1); do [ "$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')" = "$g" ] && owned=1; done
    [ -n "$owned" ] || exit 4
  fi
  for p in $(ps -axo pid=,ppid=,pgid= | awk -v g=$g '{ up[$1] = $2; if ($3 == g) print $1 } END { for (p in up) { q = up[p]; while (q > 1 && q != g && (q in up)) q = up[q]; if (q == g) print p } }' | sort -u); do
    s=$(start "$p")
    [ -n "$s" ] && echo "k $p $s" && known="$known
$p $s"
  done
  kill -TERM -$g 2>/dev/null
  n=0
  while live; do
    n=$((n + 1))
    [ $n -eq 20 ] && kill -KILL -$g 2>/dev/null
    [ $n -gt 100 ] && exit 2
    sleep 0.1
  done
fi
left=$(same)
echo e
[ -z "$left" ] && exit 0
printf '%s\\n' "$left" | sed 's/^/s /'
exit 3`;
  const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(command!, [...args, script], {
      env: transportEnvironment(device.allowlist),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(0, deadline - Date.now()));
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ code: null, output });
    });
    child.once('close', (exit) => {
      clearTimeout(timer);
      resolve({ code: exit, output });
    });
  });
  const lines = output.split('\n');
  const listed = (tag: string) =>
    lines.filter((line) => line.startsWith(`${tag} `)).map((line) => line.slice(tag.length + 1));
  if (code === 0 || code === 3) {
    device.emptied = true;
    device.seen = listed('s');
  } else device.seen = [...new Set([...seen, ...listed('k')])];
  return code === 0
    ? undefined
    : code === 2
      ? 'Device process group still has members after the deadline'
      : code === 3
        ? 'Descendants that left the device process group are still running'
        : code === 4
          ? 'Device process group number may now belong to another process group'
          : 'Device process stop could not be checked over the device link';
}
/**
 * The real paths on the device of absolute paths, a missing tail kept as written, as toolPath does
 * on this machine. Undefined when the device link fails or the deadline passes.
 */
export async function realPathsOnDevice(
  remote: RemoteLaunch,
  paths: readonly string[],
  allowlist: readonly string[],
  deadline: number,
): Promise<string[] | undefined> {
  if (paths.some((item) => item.includes('\n'))) return undefined;
  const script = `r() {
  p=$1 rest= n=0
  while :; do
    if [ -L "$p" ]; then
      n=$((n + 1)); [ $n -gt 40 ] && exit 1
      t=$(readlink "$p") || exit 1
      case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac
    elif [ -d "$p" ]; then
      d=$(cd -P "$p" && pwd -P) || exit 1
      printf '%s%s\\0' "$d" "$rest"; return
    elif [ -e "$p" ]; then
      d=$(cd -P "$(dirname "$p")" && pwd -P) || exit 1
      printf '%s/%s%s\\0' "$d" "$(basename "$p")" "$rest"; return
    else
      rest=/$(basename "$p")$rest; p=$(dirname "$p")
    fi
  done
}
for p in ${paths.map(quote).join(' ')}; do r "$p" || exit 1; done`;
  const output = await runOnDevice(remote, script, allowlist, deadline);
  const real = output
    ?.split('\0')
    .slice(0, -1)
    .map((item) => path.posix.normalize(item));
  return real?.length === paths.length ? real : undefined;
}
/**
 * What a sandbox on the device rests on: whether it is Linux, its home, which of paths exist and
 * the text of each of files that is a regular file there; a file under `~/` is in that home.
 * Undefined when the device link fails or the deadline passes.
 */
export async function sandboxFactsOnDevice(
  remote: RemoteLaunch,
  paths: readonly string[],
  files: readonly string[],
  allowlist: readonly string[],
  deadline: number,
): Promise<
  { linux: boolean; home: string; present: boolean[]; files: (string | undefined)[] } | undefined
> {
  if ([...paths, ...files].some((item) => item.includes('\n'))) return undefined;
  const file = (item: string) =>
    item.startsWith('~/') ? `"$HOME"/${quote(item.slice(2))}` : quote(item);
  const script = `s=$(uname -s) || exit 1
printf '%s\\0%s\\0' "$s" "$HOME"
for p in ${paths.map(quote).join(' ')}; do if [ -e "$p" ]; then printf 1; else printf 0; fi; done
printf '\\0'
for f in ${files.map(file).join(' ')}; do
  if [ -f "$f" ]; then printf '%s' +; cat "$f" || exit 1; else printf '%s' -; fi; printf '\\0'
done`;
  const parts = (await runOnDevice(remote, script, allowlist, deadline))?.split('\0');
  if (parts?.length !== files.length + 4) return undefined;
  const [system, home, flags] = parts as [string, string, string];
  if (flags.length !== paths.length || /[^01]/.test(flags)) return undefined;
  return {
    linux: system === 'Linux',
    home,
    present: [...flags].map((flag) => flag === '1'),
    files: parts.slice(3, -1).map((text) => (text.startsWith('+') ? text.slice(1) : undefined)),
  };
}
/** The standard output of a POSIX shell script run over the device link; undefined when it fails. */
async function runOnDevice(
  remote: RemoteLaunch,
  script: string,
  allowlist: readonly string[],
  deadline: number,
): Promise<string | undefined> {
  const [command, ...args] = remote.plain_transport ?? remote.transport;
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(command!, [...args, script], {
      env: transportEnvironment(allowlist),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let text = '';
    // A multi-byte character can straddle two pipe reads.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (text += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(0, deadline - Date.now()));
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('close', (exit) => {
      clearTimeout(timer);
      resolve(exit === 0 ? text : undefined);
    });
  });
}
/** The local environment of a transport process: the allowlist plus the SSH agent socket. */
export function transportEnvironment(allowlist: readonly string[]): NodeJS.ProcessEnv {
  return {
    ...nativeEnvironment(allowlist),
    ...(process.env.SSH_AUTH_SOCK !== undefined
      ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
      : {}),
  };
}
/** own holds capabilities that follow from the adapter's code rather than from a probe of the runtime. */
export function report(
  runtime: string,
  version: string,
  fixture = false,
  own: Record<string, Capability> = {},
  platform: NodeJS.Platform = process.platform,
): CapabilityReport {
  const capabilities: CapabilityReport['capabilities'] = {};
  for (const name of [
    'text_execution',
    'resume',
    'reattach',
    'steer',
    'read_isolation',
    'write_isolation',
    'tool_allowlist',
    'cost_reporting',
    'budget_limit',
    'native_fanout',
  ])
    capabilities[name] = { status: 'unknown', evidence: 'Not verified with this runtime/version' };
  const verified = Object.hasOwn(verifiedCapabilities, runtime)
    ? verifiedCapabilities[runtime]
    : undefined;
  if (verified?.platforms.includes(platform))
    for (const [name, capability] of Object.entries(verified.capabilities))
      capabilities[name] = { ...capability };
  if (fixture)
    for (const name of ['text_execution', 'write_isolation', 'read_isolation'])
      capabilities[name] = {
        status: 'supported',
        evidence: 'Deterministic fixture only; no model or arbitrary command execution',
      };
  capabilities.manual_compaction = {
    status: 'unsupported',
    evidence: 'This adapter does not implement manual context compaction',
  };
  for (const name of ['conversation_rollback', 'fork_within_turn'])
    capabilities[name] = {
      status: 'unsupported',
      evidence: 'This adapter does not implement native history forks',
    };
  capabilities.reattach = {
    status: 'unsupported',
    evidence: 'Current adapter owns an ephemeral stdio transport',
  };
  capabilities.turn_model_change = {
    status: 'unsupported',
    evidence: 'This adapter changes the model only between turns',
  };
  Object.assign(capabilities, own);
  return { runtime, version, checked_at: new Date().toISOString(), capabilities };
}
export interface LeftoverProcess {
  pid: number;
  start_time_us: number;
  command: string;
}
export type TerminateReceipt = CancelReceipt & { leftovers: LeftoverProcess[] };
export function descendants(root: number): LeftoverProcess[] {
  let listing: string;
  try {
    listing = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    // A sandbox refuses the setuid ps; the group is still signalled, without a leftover check.
    return [];
  }
  const rows = listing
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command: command! }));
  const found: LeftoverProcess[] = [];
  const parents = [root];
  for (let parent = parents.shift(); parent !== undefined; parent = parents.shift())
    for (const row of rows.filter((candidate) => candidate.ppid === parent)) {
      parents.push(row.pid);
      const started = readProcessIdentity(row.pid)?.start_time_us;
      if (started !== undefined)
        found.push({ pid: row.pid, start_time_us: started, command: row.command });
    }
  return found;
}
/** The processes of earlier with those of found it does not already hold; a reused pid is another process. */
export function mergeProcesses(
  earlier: LeftoverProcess[],
  found: LeftoverProcess[],
): LeftoverProcess[] {
  return [
    ...earlier,
    ...found.filter((entry) => !earlier.some((seen) => sameProcess(seen, entry))),
  ];
}
function sameProcess(one: ProcessIdentity, other: ProcessIdentity): boolean {
  return one.pid === other.pid && one.start_time_us === other.start_time_us;
}
/** An exited descendant its parent has not reaped keeps its identity but runs nothing. */
export function descendantRuns(entry: LeftoverProcess): boolean {
  if (readProcessIdentity(entry.pid)?.start_time_us !== entry.start_time_us) return false;
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(entry.pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z');
  } catch {
    return true;
  }
}
/** Whether one of members is still in process group pgid; false when the process list cannot be read. */
export function groupHolds(pgid: number, members: ProcessIdentity[]): boolean {
  return !!groupMembers(pgid)?.some((member) => members.some((seen) => sameProcess(seen, member)));
}
/** The members of process group pgid; undefined when the process list cannot be read. */
export function groupMembers(pgid: number): ProcessIdentity[] | undefined {
  let listing: string;
  try {
    listing = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  return listing.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    const identity =
      row && Number(row[2]) === pgid ? readProcessIdentity(Number(row[1])) : undefined;
    return identity ? [identity] : [];
  });
}
const stoppedChildren = new WeakSet<ChildProcessWithoutNullStreams>();
// A later stop sees an empty group, so it re-checks the processes an earlier stop saw leave it.
const childLeftovers = new WeakMap<ChildProcessWithoutNullStreams, LeftoverProcess[]>();
// The members of a group a stop left running: once its leader exits, the group may empty and its
// number pass to another group, so a later stop signals it only while one of them is still in it.
const childMembers = new WeakMap<ChildProcessWithoutNullStreams, ProcessIdentity[]>();
export async function terminate(
  child: ChildProcessWithoutNullStreams,
  done: Promise<unknown>,
  deadline = Date.now() + 10000,
): Promise<TerminateReceipt> {
  let closed = false;
  void done.then(
    () => (closed = true),
    () => (closed = true),
  );
  const signals: NonNullable<CancelReceipt['evidence']['signals']> = [];
  const alive = (): boolean => {
    if (!child.pid || stoppedChildren.has(child)) return false;
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
      if (process.platform !== 'win32') stoppedChildren.add(child);
      return false;
    }
  };
  const members = childMembers.get(child);
  // While the leader is unreaped, its pid and so its group number are still its own.
  const foreign =
    members !== undefined &&
    (child.exitCode !== null || child.signalCode !== null) &&
    alive() &&
    !groupHolds(child.pid!, members);
  const kill = (signal: NodeJS.Signals): void => {
    // An empty group must never be signalled again, even if transport close is pending.
    if (foreign || !alive()) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
      if (child.pid) signals.push({ pid: child.pid, signal, at: new Date().toISOString() });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH' && process.platform !== 'win32')
        stoppedChildren.add(child);
    }
  };
  // Snapshot only a live group: an exited leader's pid may already belong to another process.
  const snapshot = mergeProcesses(
    childLeftovers.get(child) ?? [],
    process.platform !== 'win32' && !foreign && alive() ? descendants(child.pid!) : [],
  );
  kill('SIGTERM');
  const forceAt = Date.now() + Math.min(2000, Math.max(0, (deadline - Date.now()) / 2));
  let forced = false;
  while (!foreign && (!closed || alive()) && Date.now() < deadline) {
    if (!forced && Date.now() >= forceAt) {
      kill('SIGKILL');
      forced = true;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(10, deadline - Date.now()))),
    );
  }
  const empty = !alive();
  const observedGroup = !!child.pid && process.platform !== 'win32';
  // A transport still open after the group is empty is held by a process that left the group.
  const confirmed = observedGroup && empty && closed;
  // Once the group is empty, a surviving snapshot member must have left it; it is reported, never signalled.
  const leftovers = confirmed ? snapshot.filter(descendantRuns) : [];
  childLeftovers.set(child, confirmed ? leftovers : snapshot);
  if (observedGroup && !empty && !foreign) {
    const left = groupMembers(child.pid!);
    if (left?.length) childMembers.set(child, left);
  }
  const stopped = !child.pid || (confirmed && leftovers.length === 0);
  return {
    stopped,
    leftovers,
    deadline,
    finished_at: new Date().toISOString(),
    evidence: {
      method: observedGroup ? 'process_group' : 'none',
      members: child.pid ? [{ pid: child.pid }] : [],
      // Signal 0 establishes emptiness, not the number of members in a live group.
      live_count: confirmed ? 0 : undefined,
      reaped: observedGroup && empty ? true : undefined,
      signals,
    },
    reason: stopped
      ? undefined
      : foreign
        ? 'Process group number may now belong to another process group'
        : leftovers.length
          ? 'Descendants that left the process group are still running'
          : observedGroup && empty
            ? 'Process group is empty but its transport is still open'
            : 'Process stop not confirmed by deadline',
  };
}

export const CLIENT_INFO = { name: 'pantheon', title: 'Pantheon', version: PANTHEON_VERSION };

/**
 * Calls onLine with each line of stream, split only at "\n". readline also ends a line at U+2028
 * and U+2029, which JSON leaves unescaped inside strings, and so cuts a frame in two.
 */
export function splitLines(stream: Readable, onLine: (line: string) => void): void {
  let rest: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      rest.push(chunk.subarray(start, end));
      const line = Buffer.concat(rest).toString('utf8');
      rest = [];
      start = end + 1;
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (start < chunk.length) rest.push(chunk.subarray(start));
  });
  stream.on('end', () => {
    if (rest.length) onLine(Buffer.concat(rest).toString('utf8'));
    rest = [];
  });
  stream.on('close', () => {
    rest = [];
  });
}

export class JsonRpcProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout | undefined;
    }
  >();
  private closed = false;
  private readonly jsonrpc: boolean;
  private readonly device?: DeviceProcess;
  constructor(
    binary: string,
    args: string[],
    cwd?: string,
    allowlist = NATIVE_ENV_ALLOWLIST,
    environment: NodeJS.ProcessEnv = {},
    /** Stamps every outgoing frame with "jsonrpc": "2.0". */
    /** With remote, environment and cwd apply on the device, not to the local transport. */
    /** maxLine caps one stdout frame, in UTF-16 code units, and its unterminated part in bytes. */
    options: { jsonrpc?: boolean; remote?: RemoteLaunch; maxLine?: number } = {},
  ) {
    super();
    this.jsonrpc = options.jsonrpc === true;
    const maxLine = options.maxLine ?? 4 * 1024 * 1024;
    if (options.remote) {
      const launch = remoteSpawn(
        options.remote,
        binary,
        args,
        cwd,
        environment as Record<string, string>,
      );
      this.child = spawn(launch.command, launch.args, {
        env: transportEnvironment(allowlist),
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.device = { remote: options.remote, group: deviceGroupOf(this.child), allowlist };
    } else
      this.child = spawn(binary, args, {
        cwd,
        env: { ...nativeEnvironment(allowlist), ...environment },
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    // A request cannot be written or answered once either pipe fails, though the runtime may live on.
    const fail = (error: Error): void => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      this.emit('protocolError', error);
    };
    this.child.stdin.on('error', fail);
    this.child.stderr.resume();
    let partial = 0;
    // splitLines buffers an unterminated line without limit.
    this.child.stdout.on('data', (chunk: Buffer) => {
      const end = chunk.lastIndexOf(10);
      partial = end < 0 ? partial + chunk.length : chunk.length - end - 1;
      if (partial <= maxLine) return;
      this.emit('protocolError', new Error('Oversized protocol frame'));
      this.child.stdout.destroy();
    });
    this.child.stdout.once('close', () => fail(new Error('Protocol transport closed')));
    splitLines(this.child.stdout, (line) => {
      if (line.length > maxLine) {
        this.emit('protocolError', new Error('Oversized protocol frame'));
        return;
      }
      try {
        const frame = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: unknown;
        };
        if (
          !frame ||
          typeof frame !== 'object' ||
          (!frame.method && frame.id === undefined) ||
          (frame.method !== undefined && typeof frame.method !== 'string') ||
          (frame.id !== undefined && typeof frame.id !== 'number' && typeof frame.id !== 'string')
        )
          throw new Error('Invalid protocol frame');
        if (frame.id !== undefined && !frame.method) {
          const pending = this.pending.get(Number(frame.id));
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(Number(frame.id));
            if (frame.error) pending.reject(new Error(JSON.stringify(frame.error)));
            else pending.resolve(frame.result);
          }
        } else if (frame.method && frame.id !== undefined) {
          let answered = false;
          const reply = (
            response: { result: unknown } | { error: { code: number; message: string } },
          ): void => {
            if (answered) return;
            answered = true;
            this.write({ id: frame.id, ...response });
          };
          // Registering a request listener opts into owning the reply, including deferred replies.
          if (!this.emit('request', frame, reply)) {
            reply({
              error: { code: -32601, message: 'Pantheon has not granted this server request' },
            });
            this.emit('deniedRequest', frame);
          }
        } else this.emit('notification', frame);
      } catch (error) {
        this.emit('protocolError', error);
      }
    });
    this.exited = new Promise<void>((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', () => resolve());
    });
    void this.exited
      .catch(() => {})
      .finally(() => {
        this.closed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('Protocol transport closed'));
        }
        this.pending.clear();
        this.emit('closed');
      });
  }
  private write(value: object): void {
    this.child.stdin.write(
      JSON.stringify(this.jsonrpc ? { jsonrpc: '2.0', ...value } : value) + '\n',
    );
  }
  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }
  /** A null timeout waits until the response or the transport closes. */
  request<T = unknown>(
    method: string,
    params: unknown = {},
    timeout: number | null = 5000,
  ): Promise<T> {
    const key = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new Error('Protocol transport closed'));
      const timer =
        timeout === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(key);
              reject(new Error(`RPC timeout: ${method}`));
            }, timeout);
      this.pending.set(key, { resolve: (value) => resolve(value as T), reject, timer });
      this.write({ id: key, method, params });
    });
  }
  /** Defaults to the Codex handshake; a null notification sends nothing after the response. */
  async initialize(
    params: unknown = {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: false },
    },
    initialized: string | null = 'initialized',
    timeout?: number,
  ): Promise<unknown> {
    const result = await this.request('initialize', params, timeout);
    if (initialized !== null) this.notify(initialized);
    return result;
  }
  async close(deadline = Date.now() + 10000): Promise<CancelReceipt> {
    const device = this.device;
    // An empty device group is never signalled again; its id may pass to another process.
    const unconfirmed =
      device && !device.stopped ? await stopOnDevice(device, deadline) : undefined;
    if (device && unconfirmed === undefined) device.stopped = true;
    const receipt = await terminate(this.child, this.exited, deadline);
    return receipt.stopped && unconfirmed !== undefined
      ? { ...receipt, stopped: false, reason: unconfirmed }
      : receipt;
  }
}

export function versionOf(binary: string): string {
  return execFileSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    env: nativeEnvironment(),
  }).trim();
}
