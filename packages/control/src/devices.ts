import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  requireThat,
  type Entity,
  type Principal,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas, type DeviceStatus, type SshHost, type UserConfig } from '@pantheon/protocol';
import { userOnly, type ControlContext, type Handlers } from './context.js';
import { readUserConfig, writeUserConfig } from './user-config.js';

type DeviceConfig = NonNullable<UserConfig['devices']>[string];
type DeviceSave = ReturnType<(typeof inputSchemas)['device.save']['parse']>;
/** What a probe finds on a device. */
export type DeviceProbe = Pick<
  DeviceStatus,
  | 'os'
  | 'os_version'
  | 'arch'
  | 'cpus'
  | 'memory_bytes'
  | 'load_1m'
  | 'home'
  | 'path'
  | 'labels'
  | 'runtimes'
  | 'tools'
>;
export type DeviceProbeResult = ({ online: true } & DeviceProbe) | { online: false; error: string };

type DeviceObservation = Entity & { last_online_at: string };

const PROBE_TIMEOUT_MS = 20_000;
const refreshing = new WeakMap<ControlContext, Promise<void>>();
/** The latest probe of each device id while it runs; an older one finishing later is not kept. */
const latestProbes = new WeakMap<ControlContext, Map<string, Promise<DeviceStatus>>>();

/** The command a probe runs before its script, reaching the device over SSH. */
export function deviceTransport(ssh: string): string[] {
  // A device that stops answering ends the connection after a minute instead of holding it open.
  return [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    ssh,
  ];
}

/** Device commands over SSH, and git reaching the device's repositories at `<ssh>:<path>`. */
export function sshDeviceLink(ssh: string) {
  return {
    transport: deviceTransport(ssh),
    gitUrl: (path: string) => `${ssh}:${path}`,
    /** A transport whose command can reach the local socket at the device socket while it runs. */
    withSocket: (localSocket: string, deviceSocket: string) => ({
      transport: [
        ...deviceTransport(ssh).slice(0, -1),
        '-o',
        'ExitOnForwardFailure=yes',
        '-R',
        `${deviceSocket}:${localSocket}`,
        ssh,
      ],
      socket: deviceSocket,
    }),
  };
}

/**
 * Prints one `key=value` per line. Non-interactive SSH leaves the user's tool directories off PATH,
 * so the script takes the login shell's PATH and adds the usual install directories.
 */
const DEVICE_PROBE_SCRIPT = String.raw`login_path=$("${'$'}{SHELL:-/bin/sh}" -lc 'printf "\n%s" "$PATH"' 2>/dev/null | tail -n 1)
export PATH="${'$'}{login_path:+$login_path:}$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
case "$(uname -s)" in
Darwin)
  echo os=macos
  echo "os_version=$(sw_vers -productVersion)"
  echo "cpus=$(sysctl -n hw.ncpu)"
  echo "memory_bytes=$(sysctl -n hw.memsize)"
  echo "load_1m=$(sysctl -n vm.loadavg | awk '{ print $2 }')"
  ;;
Linux)
  echo os=linux
  [ -r /etc/os-release ] && (. /etc/os-release && echo "os_version=$PRETTY_NAME")
  echo "cpus=$(nproc)"
  echo "memory_bytes=$(($(awk '/^MemTotal:/ { print $2 }' /proc/meminfo) * 1024))"
  echo "load_1m=$(cut -d ' ' -f 1 /proc/loadavg)"
  ;;
esac
echo "arch=$(uname -m)"
echo "home=$HOME"
echo "path=$PATH"
for name in claude codex; do
  binary=$(command -v "$name") || continue
  case "$name" in
  claude) "$binary" auth status 2>/dev/null | grep -q '"loggedIn": true' && login=1 || login=0 ;;
  codex) "$binary" login status 2>&1 | grep -q '^Logged in' && login=1 || login=0 ;;
  esac
  printf 'runtime.%s=%s\t%s\t%s\n' "$name" "$binary" "$("$binary" --version 2>/dev/null | head -n 1)" "$login"
done
for name in git node pnpm docker; do
  command -v "$name" >/dev/null && echo "tool.$name=$("$name" --version 2>/dev/null | head -n 1)"
done
command -v nvidia-smi >/dev/null && echo label.gpu=1
# /usr/bin/xcodebuild exists without Xcode; only an installed Xcode answers -version.
xcodebuild -version >/dev/null 2>&1 && echo label.xcode=1
exit 0
`;

/** Reads the probe script's output; lines it does not know and empty values are skipped. */
export function parseDeviceProbe(output: string): DeviceProbe {
  const found: DeviceProbe = { labels: [], runtimes: {}, tools: {} };
  const labels: string[] = [];
  for (const line of output.split('\n')) {
    const at = line.indexOf('=');
    const key = line.slice(0, at),
      value = line.slice(at + 1).trim(),
      number = Number(value);
    if (at < 1 || value === '') continue;
    if (key === 'os' && (value === 'macos' || value === 'linux')) found.os = value;
    else if (key === 'os_version' || key === 'arch' || key === 'home' || key === 'path')
      found[key] = value;
    else if ((key === 'cpus' || key === 'memory_bytes' || key === 'load_1m') && !isNaN(number))
      found[key] = number;
    else if (key.startsWith('runtime.')) {
      const [binary = '', version = '', login] = value.split('\t');
      found.runtimes[key.slice('runtime.'.length)] = { binary, version, logged_in: login === '1' };
    } else if (key.startsWith('tool.')) found.tools[key.slice('tool.'.length)] = value;
    else if (key.startsWith('label.') && value === '1') labels.push(key.slice('label.'.length));
  }
  found.labels = [...labels, ...(found.tools.docker ? ['docker'] : [])];
  return found;
}

/** Whether the device has the label; `os=…` and `arch=…` name its system and architecture. */
export function deviceHasLabel(
  device: Pick<DeviceStatus, 'labels' | 'os' | 'arch'>,
  label: string,
): boolean {
  return (
    device.labels.includes(label) ||
    (device.os !== undefined && label === `os=${device.os}`) ||
    (device.arch !== undefined && label === `arch=${device.arch}`)
  );
}

/** Runs the probe script through the transport; a failed or timed-out run is an offline device. */
export function probeDevice(transport: string[]): Promise<DeviceProbeResult> {
  const [command, ...args] = transport;
  return new Promise((resolve) => {
    const child = spawn(command!, [...args, DEVICE_PROBE_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => resolve({ online: false, error: error.message }));
    child.on('close', (code) => {
      if (code === 0) resolve({ online: true, ...parseDeviceProbe(stdout) });
      else if (child.killed)
        resolve({
          online: false,
          error: `Probe timed out after ${PROBE_TIMEOUT_MS / 1000} seconds`,
        });
      else
        resolve({
          online: false,
          error: stderr.trim().split('\n').at(-1) || `Probe exited with code ${code}`,
        });
    });
  });
}

/** This machine, read from node:os rather than probed. */
function localDevice(): DeviceStatus {
  const platform =
    process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined;
  const arch = os.machine(),
    cpus = os.cpus().length;
  return {
    id: 'local',
    name: os.hostname(),
    labels: [],
    resources: {},
    max_sessions: cpus,
    online: true,
    checked_at: new Date().toISOString(),
    ...(platform && { os: platform }),
    arch,
    cpus,
    memory_bytes: os.totalmem(),
    load_1m: os.loadavg()[0],
    home: os.homedir(),
    runtimes: {},
    tools: {},
  };
}

function deviceStatus(
  id: string,
  config: DeviceConfig,
  found: DeviceProbeResult,
  checkedAt: string,
): DeviceStatus {
  const { name = id, labels = [], resources = {}, max_sessions, ...described } = config;
  const probed = found.online ? found : { ...found, labels: [], runtimes: {}, tools: {} };
  return {
    id,
    name,
    ...described,
    ...probed,
    labels: [...new Set([...labels, ...probed.labels])],
    resources,
    max_sessions: max_sessions ?? (found.online ? found.cpus : undefined) ?? 1,
    checked_at: checkedAt,
  };
}

function probeAndKeep(
  ctx: ControlContext,
  id: string,
  config: DeviceConfig,
  transport: (ssh: string) => string[],
): Promise<DeviceStatus> {
  const latest = latestProbes.get(ctx) ?? new Map<string, Promise<DeviceStatus>>();
  latestProbes.set(ctx, latest);
  const keep = async () => {
    const found = await probeDevice(transport(config.ssh));
    const status = deviceStatus(id, config, found, new Date(ctx.store.now()).toISOString());
    const previous = ctx.store.get<DeviceObservation>('device_observations', id);
    if (found.online) {
      const observation = { id, revision: 1, last_online_at: status.checked_at };
      if (previous) ctx.store.update('device_observations', observation, previous.revision);
      else ctx.store.insert('device_observations', observation);
      status.last_online_at = status.checked_at;
    } else if (previous) status.last_online_at = previous.last_online_at;
    if (latest.get(id) === probe) ctx.devices?.set(id, status);
    return status;
  };
  const probe = keep().finally(() => {
    if (latest.get(id) === probe) latest.delete(id);
  });
  latest.set(id, probe);
  return probe;
}

/** Probes every configured device; a refresh still running is shared instead of starting another. */
export function refreshDevices(
  ctx: ControlContext,
  transport: (ssh: string) => string[] = deviceTransport,
): Promise<void> {
  const running = refreshing.get(ctx);
  if (running) return running;
  const refresh = (async () => {
    const devices = readUserConfig(ctx.userConfigDir).devices ?? {};
    for (const id of ctx.devices?.keys() ?? [])
      if (!Object.hasOwn(devices, id)) ctx.devices?.delete(id);
    await Promise.all(
      Object.entries(devices).map(([id, config]) => probeAndKeep(ctx, id, config, transport)),
    );
  })().finally(() => refreshing.delete(ctx));
  refreshing.set(ctx, refresh);
  return refresh;
}

/** Probes the one configured device again unless a probe of it still runs; this machine is read. */
export async function reprobeDevice(
  ctx: ControlContext,
  id: string,
  transport: (ssh: string) => string[] = deviceTransport,
): Promise<void> {
  if (id === 'local') return;
  const devices = readUserConfig(ctx.userConfigDir).devices ?? {};
  requireThat(Object.hasOwn(devices, id), 'invalid_input', `Unknown device ${id}`);
  await (latestProbes.get(ctx)?.get(id) ?? probeAndKeep(ctx, id, devices[id]!, transport));
}

type SshConfigHost = Omit<SshHost, 'device_id'>;

/** Splits arguments as OpenSSH does: quotes join words, and a word starting with `#` ends the line. */
function sshArguments(text: string): string[] {
  const args: string[] = [];
  for (const [, word] of text.matchAll(/((?:"[^"]*"|'[^']*'|[^\s"'])+)/g)) {
    if (word!.startsWith('#')) break;
    args.push(word!.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
  }
  return args;
}

/**
 * The hosts an OpenSSH config names without wildcards or negation, in file order, each with the
 * HostName and User of the first block naming it; Include is followed one level deep.
 */
export function sshConfigHosts(file: string): SshConfigHost[] {
  const hosts = new Map<string, SshConfigHost>();
  // Include paths are relative to the directory of the user's config, ~/.ssh.
  const expand = (pattern: string): string[] => {
    const full = path.resolve(path.dirname(file), pattern.replace(/^~(?=\/)/, os.homedir()));
    const name = path.basename(full);
    if (!/[*?]/.test(name)) return [full];
    const glob = name
      .replace(/[.+^$()|[\]{}\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.');
    try {
      return readdirSync(path.dirname(full))
        .filter((entry) => new RegExp(`^${glob}$`).test(entry))
        .sort()
        .map((entry) => path.join(path.dirname(full), entry));
    } catch {
      return [];
    }
  };
  const read = (at: string, included: boolean) => {
    let text: string;
    try {
      text = readFileSync(at, 'utf8');
    } catch {
      return;
    }
    let block: SshConfigHost[] = [];
    for (const line of text.split('\n')) {
      const match = /^([^\s=]+)\s*[\s=]\s*(.+)$/.exec(line.trim());
      if (!match || match[1]!.startsWith('#')) continue;
      const keyword = match[1]!.toLowerCase(),
        args = sshArguments(match[2]!);
      if (keyword === 'host')
        block = args
          .filter((pattern) => !/[*?]|^!/.test(pattern))
          .map((host) => hosts.get(host) ?? hosts.set(host, { host }).get(host)!);
      else if (keyword === 'match') block = [];
      else if (keyword === 'hostname' || keyword === 'user')
        for (const host of block) host[keyword] ??= args[0];
      else if (keyword === 'include' && !included)
        for (const pattern of args) for (const entry of expand(pattern)) read(entry, true);
    }
  };
  read(file, false);
  return [...hosts.values()];
}

/** The hosts of the user's SSH config, each with the configured device that reaches it. */
export function sshHosts(
  ctx: ControlContext,
  file = path.join(os.homedir(), '.ssh', 'config'),
): SshHost[] {
  const devices = Object.entries(readUserConfig(ctx.userConfigDir).devices ?? {});
  return sshConfigHosts(file).map((host) => {
    const device = devices.find(([, config]) => config.ssh === host.host);
    return device ? { ...host, device_id: device[0] } : host;
  });
}

/** This machine first, then the configured devices by id with their last probe. */
export function listDevices(ctx: ControlContext): DeviceStatus[] {
  const config = readUserConfig(ctx.userConfigDir),
    devices = config.devices ?? {};
  const now = new Date(ctx.store.now()).toISOString();
  const local = localDevice(),
    { labels = [], resources = {}, max_sessions } = config.local_device ?? {};
  return [
    {
      ...local,
      labels: [...new Set([...local.labels, ...labels])],
      resources,
      ...(max_sessions === undefined ? {} : { max_sessions }),
    },
    ...Object.keys(devices)
      .sort()
      .map((id) => {
        const last = ctx.store.get<DeviceObservation>('device_observations', id);
        return (
          ctx.devices?.get(id) ?? {
            ...deviceStatus(id, devices[id]!, { online: false, error: 'Not probed yet' }, now),
            ...(last && { last_online_at: last.last_online_at }),
          }
        );
      }),
  ];
}

function configDirectory(ctx: ControlContext): string {
  requireThat(
    ctx.userConfigDir !== undefined,
    'unsupported_capability',
    'This daemon has no user configuration directory',
  );
  return ctx.userConfigDir;
}

/** Refuses while a session keeps a worktree on the device: its sync reaches it through the configured SSH target. */
function deviceUnused(ctx: ControlContext, id: string): void {
  const user = ctx.store.list<Session>('sessions').find((session) => {
    const workspace =
      session.device_id === id && session.workspace_id !== undefined
        ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
        : undefined;
    return workspace !== undefined && workspace.removed_at === undefined;
  });
  requireThat(!user, 'resource_busy', `Session ${user?.id} still has a worktree on device ${id}`);
}

/** Writes the device into the user configuration, then probes it once. */
export function saveDevice(
  ctx: ControlContext,
  principal: Principal,
  input: DeviceSave,
  transport: (ssh: string) => string[] = deviceTransport,
): Promise<DeviceStatus> {
  userOnly(principal);
  const directory = configDirectory(ctx);
  const { id, ...config } = input;
  const devices = readUserConfig(directory).devices;
  if (devices?.[id] && devices[id].ssh !== config.ssh) deviceUnused(ctx, id);
  writeUserConfig(directory, { devices: { ...devices, [id]: config } });
  return probeAndKeep(ctx, id, config, transport);
}

export function removeDevice(ctx: ControlContext, principal: Principal, id: string): void {
  userOnly(principal);
  const directory = configDirectory(ctx);
  const devices = readUserConfig(directory).devices ?? {};
  requireThat(Object.hasOwn(devices, id), 'invalid_input', `Unknown device ${id}`);
  deviceUnused(ctx, id);
  writeUserConfig(directory, {
    devices: Object.fromEntries(Object.entries(devices).filter(([other]) => other !== id)),
  });
  // A probe still running then keeps its result out of ctx.devices.
  latestProbes.get(ctx)?.delete(id);
  ctx.devices?.delete(id);
}

export const deviceHandlers: Handlers = {
  'device.save': (ctx, p, c) => {
    const input = inputSchemas['device.save'].parse(c.input);
    // The receipt does not wait for the probe; device.list shows its result.
    void saveDevice(ctx, p, input);
    ctx.store.event('device.saved', { id: input.id, revision: 1 }, '', input, c.command_id);
    return input;
  },
  'device.remove': (ctx, p, c) => {
    const input = inputSchemas['device.remove'].parse(c.input);
    removeDevice(ctx, p, input.id);
    ctx.store.event('device.removed', { id: input.id, revision: 1 }, '', input, c.command_id);
    return input;
  },
};
