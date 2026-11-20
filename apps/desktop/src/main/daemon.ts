import { execFile, spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  PROTOCOL_VERSION,
  type AttachmentMeta,
  type BoardSnapshot,
  type BridgeResult,
  type Command,
  type DaemonInfo,
  type EventFrame,
  type TerminalFrame,
} from '@pantheon/protocol';
import { defaultDataDirectory } from '@pantheon/protocol/paths';
import { INTERACTIVE_PATH_SCRIPT, runWsl, type RunWsl } from './wsl.js';

export const dataDirectory = (): string => process.env.PANTHEON_DATA_DIR ?? defaultDataDirectory();

export const userDataDirectory = (appData: string): string =>
  process.env.PANTHEON_DATA_DIR
    ? path.join(process.env.PANTHEON_DATA_DIR, 'desktop')
    : path.join(appData, 'Pantheon Desktop');

/** How a packaged app starts the daemon it bundles. */
export interface DaemonLaunch {
  node: string;
  entry: string;
  env: Record<string, string>;
}

/** The bundled node, daemon and CLI in a packaged app's Resources folder. */
export const packagedLaunch = (resources: string, PATH: string | undefined): DaemonLaunch => ({
  node: path.join(resources, 'node/bin/node'),
  entry: path.join(resources, 'daemon/dist/main.js'),
  env: {
    ...(PATH === undefined ? {} : { PATH }),
    PANTHEON_MCP_ENTRY: path.join(resources, 'cli/dist/index.js'),
  },
});

export interface BridgeOptions {
  directory: string;
  /** A packaged app starts a daemon only with a launch. */
  packaged: boolean;
  repo: string;
  logFile: string;
  launch?: DaemonLaunch;
  /** Runs the daemon inside a WSL distro from a runtime archive; the paths are Windows paths. */
  wsl?: {
    distro: string;
    runtimeArchive: string;
    runtimeVersion: string;
    desktopDataDir: string;
    run?: RunWsl;
  };
  /** Why no daemon can run here; set, every request fails with it as daemon_unavailable. */
  unavailable?: string;
  /** Runs while a reason is set, before each connection; its reason and WSL options replace the ones set. */
  recheck?: () => Promise<Pick<BridgeOptions, 'unavailable' | 'wsl'>>;
  /** The packaged app's version; set, a daemon of another version this bridge can stop is replaced. */
  version?: string;
}
interface Connection extends DaemonInfo {
  token: string;
}
type Launcher = (directory: string) => Promise<BridgeResult<null>>;
/** The unpacked runtime and the daemon's data folder inside the distro. */
interface WslRuntime {
  root: string;
  data: string;
}

/**
 * Unpacks the archive at the Windows path $1 into the runtime folder of version $2 unless it is there;
 * unpacking beside it and moving it in keeps a half-unpacked runtime from counting as installed.
 * Its last two lines are the runtime folder and the data folder.
 */
export const INSTALL_RUNTIME_SCRIPT = `set -e
base="\${XDG_DATA_HOME:-$HOME/.local/share}/pantheon"
target="$base/runtime/$2"
if [ ! -f "$target/daemon/dist/main.js" ]; then
  archive="$(wslpath -u "$1")"
  mkdir -p "$base/runtime"
  staging="$(mktemp -d "$base/runtime/.$2.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  tar -xzf "$archive" -C "$staging"
  rm -rf "$target"
  mv "$staging" "$target"
  for old in "$base/runtime"/*; do
    # An earlier runtime a process still runs from, such as a daemon left running, stays until the next install.
    [ "$old" = "$target" ] || grep -qasF -- "$old/" /proc/[0-9]*/cmdline || rm -rf "$old"
  done
fi
printf '%s\\n%s\\n' "$target" "$base/data"
`;

export const MANIFEST_START = '--- pantheon manifest ---';
export const MANIFEST_SEPARATOR = '--- pantheon token ---';

/** Prints the start line, daemon.json of the data folder $1, the separator line and the token the daemon writes beside it. */
export const READ_MANIFEST_SCRIPT = `set -e
printf '%s\\n' '${MANIFEST_START}'
cat "$1/daemon.json"
printf '\\n%s\\n' '${MANIFEST_SEPARATOR}'
cat "$1/user.token"
`;

/** The manifest and token READ_MANIFEST_SCRIPT prints; login profile output before them is ignored. */
export const parseManifestOutput = (
  stdout: string,
): { manifest: { url: string; token_file: string; pid: number }; token: string } => {
  const at = stdout.lastIndexOf(`\n${MANIFEST_SEPARATOR}\n`);
  if (at < 0) throw new Error(`No ${MANIFEST_SEPARATOR} line in ${JSON.stringify(stdout)}`);
  const start = stdout.lastIndexOf(`${MANIFEST_START}\n`, at);
  if (start < 0) throw new Error(`No ${MANIFEST_START} line in ${JSON.stringify(stdout)}`);
  return {
    manifest: JSON.parse(stdout.slice(start + MANIFEST_START.length + 1, at)),
    token: stdout.slice(at + MANIFEST_SEPARATOR.length + 2).trim(),
  };
};

// `bash -lc` arguments: node, daemon entry, data folder, Windows desktop data folder, CLI entry, flags.
const WSL_LAUNCH_SCRIPT = `${INTERACTIVE_PATH_SCRIPT}; export PANTHEON_DESKTOP_DATA_DIR="$(wslpath -u "$3")"; export PANTHEON_MCP_ENTRY="$4"; exec "$0" "$1" --data-dir "$2" "\${@:5}"`;

const failure = (
  code: string,
  message: string,
  status?: number,
  details?: Record<string, unknown>,
  stack?: string,
) =>
  ({
    ok: false,
    error: {
      code,
      message,
      ...(status === undefined ? {} : { status }),
      ...(details === undefined ? {} : { details }),
      ...(stack === undefined ? {} : { stack }),
    },
  }) as const;

/** The daemon's upload limit for one attachment. */
export const attachmentLimit = 20 * 1024 * 1024;

const mimes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.csv': 'text/csv',
};
export const attachmentMime = (file: string): string =>
  mimes[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * Whether a `ps` command line is the daemon this repo's bridge starts for this data directory.
 * `ps` joins arguments with spaces, so only the exact lines `start` produces are unambiguous.
 */
export const ownsDaemon = (command: string, repo: string, directory: string): boolean =>
  startedAs(command, `node ${path.join(repo, 'apps/daemon/dist/main.js')} --data-dir ${directory}`);

const startedAs = (command: string, line: string): boolean =>
  command === line || command === `${line} --allow-fixture`;

/** The command line `ps` in the distro shows for the daemon startInWsl starts. */
const wslLine = ({ root, data }: WslRuntime): string =>
  `${path.posix.join(root, 'node/bin/node')} ${path.posix.join(root, 'daemon/dist/main.js')} --data-dir ${data}`;

/** Whether a `ps` command line in the distro is the daemon of `runtime`'s data folder run from any runtime beside it. */
export const wslOwns = (command: string, runtime: WslRuntime): boolean => {
  const base = path.posix.dirname(runtime.root);
  const version = command.startsWith(`${base}/`)
    ? command.slice(base.length + 1).split('/', 1)[0]!
    : '';
  return (
    !['', '.', '..'].includes(version) &&
    startedAs(command, wslLine({ root: `${base}/${version}`, data: runtime.data }))
  );
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class DaemonBridge {
  /** Pid of the daemon process this bridge spawned. */
  startedPid: number | undefined;
  /** This bridge has spawned the daemon, or is spawning it, and waits for it to come up. */
  starting = false;
  private connection: Connection | undefined;
  private connecting: Promise<BridgeResult<Connection>> | undefined;
  private runtime: Promise<WslRuntime> | undefined;
  /** A daemon of another version was found and its replacement began. */
  private replacing = false;
  constructor(private options: BridgeOptions) {}

  async daemon(): Promise<BridgeResult<DaemonInfo>> {
    const found = await this.connect();
    if (!found.ok) return found;
    const { url, version, protocol_version, started_here, data_dir } = found.value;
    return { ok: true, value: { url, version, protocol_version, started_here, data_dir } };
  }

  async command(command: Command): Promise<BridgeResult<unknown>> {
    const result = await this.request('POST', '/v1/commands', JSON.stringify(command), 5000);
    return result.ok ? { ok: true, value: (result.value as { receipt: unknown }).receipt } : result;
  }

  async query(
    method: string,
    params: Record<string, string | string[]> = {},
  ): Promise<BridgeResult<unknown>> {
    if (!/^[a-z][a-z._]*$/.test(method))
      return failure('invalid_query', `Query method ${JSON.stringify(method)} is not allowed`);
    // Inventory and the model list include the runtime's discovery and the daemon's deadline;
    // the runtime status waits for the runtime preflight's version probe and account check;
    // a device probe waits for ssh and a login shell, and MCP status for the adapters' server start.
    return this.request(
      'GET',
      `/v1/${method}?${new URLSearchParams(
        Object.entries(params).flatMap(([name, value]) => [value].flat().map((one) => [name, one])),
      )}`,
      undefined,
      method === 'runtime.status'
        ? 45_000
        : method === 'mcp.status'
          ? 65_000
          : method === 'device.probe' || (method === 'device.list' && params.refresh !== undefined)
            ? 25_000
            : method === 'extensions.inventory' || method === 'runtime.models'
              ? 15_000
              : 5000,
    );
  }

  async attach(
    project_id: string,
    name: string,
    mime: string,
    bytes: Uint8Array,
  ): Promise<BridgeResult<AttachmentMeta>> {
    return this.request(
      'POST',
      `/v1/attachments?${new URLSearchParams({ project_id, name })}`,
      // Bytes from readFile or a structured clone over IPC never sit in a SharedArrayBuffer.
      bytes as Uint8Array<ArrayBuffer>,
      30_000,
      mime || 'application/octet-stream',
    ) as Promise<BridgeResult<AttachmentMeta>>;
  }

  subscribe(
    options: { cursor?: number; project_id?: string; browser?: boolean },
    listener: (frame: EventFrame) => void,
  ): () => void {
    let socket: WebSocket | undefined,
      ended = false,
      closed = false;
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      listener({ type: 'closed', code, reason });
    };
    void this.connect().then((found) => {
      if (!found.ok) return close(1006, found.error.message);
      if (ended) return close(1000, '');
      const { url, token } = found.value;
      socket = new WebSocket(url.replace(/^http/, 'ws') + '/v1/events/ws');
      socket.addEventListener('open', () =>
        socket!.send(
          JSON.stringify({
            token,
            project_id: options.project_id,
            cursor: options.cursor,
            browser: options.browser,
          }),
        ),
      );
      socket.addEventListener('message', (e) => {
        if (!closed) listener(JSON.parse(String(e.data)) as EventFrame);
      });
      socket.addEventListener('error', () => {
        if (this.connection?.url === url) this.connection = undefined;
      });
      socket.addEventListener('close', (e) => close(e.code, e.reason));
    });
    return () => {
      ended = true;
      socket?.close(1000);
    };
  }

  terminalSubscribe(terminal_id: string, listener: (frame: TerminalFrame) => void): () => void {
    let socket: WebSocket | undefined,
      ended = false,
      last = false;
    void this.connect().then((found) => {
      if (ended) return;
      if (!found.ok) return listener({ closed: true });
      const { url, token } = found.value;
      socket = new WebSocket(
        `${url.replace(/^http/, 'ws')}/v1/terminals/${encodeURIComponent(terminal_id)}/ws`,
      );
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => socket!.send(JSON.stringify({ token })));
      socket.addEventListener('message', (e) => {
        if (ended) return;
        // Output is binary; the only text frame is the exit.
        if (typeof e.data !== 'string') listener({ data: new Uint8Array(e.data as ArrayBuffer) });
        else {
          last = true;
          listener({ exit: (JSON.parse(e.data) as { code: number }).code });
        }
      });
      const lost = () => {
        if (ended || last) return;
        last = true;
        listener({ closed: true });
      };
      socket.addEventListener('error', lost);
      socket.addEventListener('close', lost);
    });
    return () => {
      ended = true;
      socket?.close(1000);
    };
  }

  /** Opens a registered workspace; the renderer is not trusted with paths. */
  async openWorkspace(
    workspace_id: string,
    launch: Launcher,
    /** Maps the workspace's path to one this process can stat. */
    local = (path: string) => path,
  ): Promise<BridgeResult<null>> {
    const board = await this.query('board');
    if (!board.ok) return board;
    const workspace = (
      board.value as { workspaces: { id: string; path: string }[] }
    ).workspaces.find((w) => w.id === workspace_id);
    if (!workspace) return failure('not_found', `workspaces/${workspace_id}`);
    let directory = false;
    try {
      directory = statSync(local(workspace.path)).isDirectory();
    } catch {}
    if (!directory)
      return failure('workspace_missing', `${workspace.path} is not an existing directory`);
    return launch(workspace.path);
  }

  /** Every project root and workspace path; the renderer may open files only inside these. */
  async roots(): Promise<BridgeResult<string[]>> {
    const board = await this.query('board');
    if (!board.ok) return board;
    const { projects, workspaces } = board.value as {
      projects: { roots: string[] }[];
      workspaces: { path: string }[];
    };
    return {
      ok: true,
      value: [...projects.flatMap((p) => p.roots), ...workspaces.map((w) => w.path)],
    };
  }

  /** In development, reloads the daemon after its compiled code changes; returns the stop function. */
  watchBuilds(): () => void {
    if (this.options.packaged || this.options.wsl) return () => {};
    const packages = path.join(this.options.repo, 'packages');
    const roots = [
      path.join(this.options.repo, 'apps/daemon/dist'),
      ...readdirSync(packages).map((name) => path.join(packages, name, 'dist')),
    ].filter((root) => existsSync(root));
    let timer: ReturnType<typeof setTimeout> | undefined,
      reloading = false,
      again = false,
      stopped = false;
    const reload = async (): Promise<void> => {
      if (reloading) {
        again = true;
        return;
      }
      reloading = true;
      do {
        again = false;
        await this.reloadDaemon(() => stopped);
      } while (again && !stopped);
      reloading = false;
    };
    const watchers = roots.map((root) =>
      watch(root, { recursive: true }, (_event, file) => {
        if (!file?.endsWith('.js')) return;
        clearTimeout(timer);
        timer = setTimeout(() => void reload(), 1000);
      }),
    );
    // A build written while no app watched gives no change event, so compare it with the daemon start.
    const built = Math.max(
      ...roots.flatMap((root) =>
        readdirSync(root, { recursive: true, encoding: 'utf8' })
          .filter((file) => file.endsWith('.js'))
          .map((file) => statSync(path.join(root, file)).mtimeMs),
      ),
    );
    let started = NaN;
    try {
      started = Date.parse(
        JSON.parse(readFileSync(path.join(this.options.directory, 'daemon.json'), 'utf8'))
          .started_at,
      );
    } catch {}
    if (built > started) void reload();
    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
  }

  /** Restarts this directory's daemon, if this bridge's own build or launch runs it, once no session is active. */
  async reloadDaemon(stopped: () => boolean = () => false): Promise<void> {
    let deferred = false;
    while (!stopped()) {
      const pid = await this.ownedDaemon();
      if (pid === undefined) return;
      const board = await this.query('board');
      if (!board.ok) return;
      const active = (board.value as BoardSnapshot).sessions.filter(
        (s) =>
          s.state === 'running' ||
          s.state === 'reconciling' ||
          s.stop_pending ||
          s.process_identity,
      ).length;
      if (active === 0) return this.restart(pid);
      if (!deferred) this.log(`daemon reload deferred: ${active} sessions active`);
      deferred = true;
      await sleep(5000);
    }
  }

  private async ownedDaemon(): Promise<number | undefined> {
    let pid: unknown;
    try {
      pid = this.options.wsl
        ? (await this.wslManifest()).manifest.pid
        : JSON.parse(readFileSync(path.join(this.options.directory, 'daemon.json'), 'utf8')).pid;
    } catch {
      return undefined;
    }
    // Zero and negative pids address process groups.
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (this.options.wsl) {
      const command = await this.inWsl(['ps', '-ww', '-o', 'command=', '-p', String(pid)]).then(
        (stdout) => stdout.toString('utf8').trim(),
        () => '',
      );
      return wslOwns(command, await this.installed()) ? pid : undefined;
    }
    const command = await new Promise<string>((resolve) =>
      execFile('ps', ['-ww', '-o', 'command=', '-p', String(pid)], (error, stdout) =>
        resolve(error ? '' : stdout.trim()),
      ),
    );
    const { launch, repo, directory } = this.options;
    return (
      launch
        ? startedAs(command, `${launch.node} ${launch.entry} --data-dir ${directory}`)
        : ownsDaemon(command, repo, directory)
    )
      ? pid
      : undefined;
  }

  private async restart(pid: number): Promise<void> {
    // A daemon in WSL has a Linux pid, so only the distro may signal it.
    const { wsl } = this.options;
    try {
      if (wsl) await this.inWsl(['kill', '-TERM', String(pid)]);
      else process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    const deadline = Date.now() + 10_000;
    while (
      wsl
        ? await this.inWsl(['kill', '-0', String(pid)]).then(
            () => true,
            () => false,
          )
        : alive(pid)
    ) {
      if (Date.now() >= deadline)
        return this.log(`daemon reload: pid ${pid} did not exit within 10 s`);
      await sleep(100);
    }
    // A request that failed meanwhile may already be starting the replacement.
    await this.connecting;
    this.connection = undefined;
    const found = await this.connect();
    this.log(
      found.ok
        ? `daemon reloaded: pid ${pid} stopped, now live at ${found.value.url}`
        : `daemon reload failed: ${found.error.message}`,
    );
  }

  /** Runs a command in the distro as its default user. */
  private inWsl(args: string[], input?: string): Promise<Buffer> {
    const { distro, run = runWsl } = this.options.wsl!;
    return run('wsl.exe', ['-d', distro, '--exec', ...args], input);
  }

  /** Installs the runtime once per bridge; a failed install runs again on the next call. */
  private installed(): Promise<WslRuntime> {
    const { runtimeArchive, runtimeVersion } = this.options.wsl!;
    this.runtime ??= this.inWsl(
      ['bash', '-l', '-s', '--', runtimeArchive, runtimeVersion],
      INSTALL_RUNTIME_SCRIPT,
    ).then((stdout) => {
      const [root, data] = stdout.toString('utf8').trim().split(/\r?\n/).slice(-2);
      if (!root?.startsWith('/') || !data?.startsWith('/'))
        throw new Error(`The runtime install printed ${JSON.stringify(stdout.toString('utf8'))}`);
      return { root, data };
    });
    this.runtime.catch(() => (this.runtime = undefined));
    return this.runtime;
  }

  private async wslManifest(): Promise<ReturnType<typeof parseManifestOutput>> {
    const { data } = await this.installed();
    const stdout = await this.inWsl(['bash', '-l', '-s', '--', data], READ_MANIFEST_SCRIPT);
    return parseManifestOutput(stdout.toString('utf8'));
  }

  private log(line: string): void {
    mkdirSync(path.dirname(this.options.logFile), { recursive: true });
    appendFileSync(this.options.logFile, `${line}\n`);
  }

  private async request(
    method: 'GET' | 'POST',
    route: string,
    body?: string | Uint8Array<ArrayBuffer>,
    timeout = 5000,
    contentType = 'application/json',
  ): Promise<BridgeResult<unknown>> {
    const found = await this.connect();
    if (!found.ok) return found;
    const { url, token } = found.value;
    let response: Response, payload: unknown;
    try {
      response = await fetch(new URL(route, url), {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
        body,
        signal: AbortSignal.timeout(timeout),
      });
      payload = await response.json();
    } catch (error) {
      // A slow answer is a busy daemon, not a lost one; it runs a command to the end once it has it.
      if ((error as Error).name === 'TimeoutError')
        return failure(
          method === 'POST' ? 'command_timeout' : 'query_timeout',
          `${method} ${route} did not answer within ${timeout} ms`,
        );
      if (this.connection?.url === url) this.connection = undefined;
      return failure('daemon_unavailable', String(error));
    }
    if (response.ok) return { ok: true, value: payload };
    const { error, message, details, stack } = payload as {
      error: string;
      message?: string;
      details?: Record<string, unknown>;
      stack?: string;
    };
    return failure(error, message ?? error, response.status, details, stack);
  }

  private connect(): Promise<BridgeResult<Connection>> {
    if (this.connection) return Promise.resolve({ ok: true, value: this.connection });
    this.connecting ??= this.find().finally(() => {
      this.connecting = undefined;
      this.starting = false;
    });
    return this.connecting;
  }

  private async find(): Promise<BridgeResult<Connection>> {
    if (this.options.unavailable && this.options.recheck)
      this.options = { ...this.options, ...(await this.options.recheck()) };
    if (this.options.unavailable) return failure('daemon_unavailable', this.options.unavailable);
    let live = await this.probe();
    if (!live.ok && live.busy) {
      // A live daemon holds the data directory, so a second one would only exit.
      live = await this.probe(20_000);
      if (!live.ok)
        return failure('daemon_busy', `The daemon did not answer within 20 s (${live.reason})`);
    }
    if (!live.ok && (this.options.launch || this.options.wsl || !this.options.packaged)) {
      this.starting = true;
      const started = await this.start();
      if (!started.ok) return started;
      const deadline = Date.now() + 10_000;
      while (!(live = await this.probe()).ok && Date.now() < deadline) await sleep(100);
      if (!live.ok)
        return failure(
          'daemon_unavailable',
          `The daemon did not become live within 10 s (${live.reason}); see ${this.options.logFile}`,
        );
      // The spawned wsl.exe has a Windows pid; the daemon is known by its pid in the distro.
      if (this.options.wsl) this.startedPid = live.pid;
    }
    if (!live.ok)
      return failure('daemon_unavailable', `No Pantheon daemon is running: ${live.reason}`);
    try {
      const health = (await (
        await fetch(new URL('/health', live.url), { signal: AbortSignal.timeout(5000) })
      ).json()) as { version: string; protocol_version: number };
      // Not kept as the connection, so the next request checks a replaced daemon again.
      if (health.protocol_version !== PROTOCOL_VERSION)
        return failure(
          'protocol_mismatch',
          `daemon protocol ${health.protocol_version}, app ${PROTOCOL_VERSION}`,
        );
      this.connection = {
        url: live.url,
        token: live.token,
        version: health.version,
        protocol_version: health.protocol_version,
        started_here: live.pid === this.startedPid,
        data_dir: this.options.wsl ? (await this.installed()).data : this.options.directory,
      };
      const { version } = this.options;
      // Serves meanwhile; the replacement waits for running sessions as a development reload does.
      if (
        version !== undefined &&
        health.version !== version &&
        !this.connection.started_here &&
        !this.replacing
      ) {
        this.replacing = true;
        this.log(`daemon ${health.version} is not app ${version}`);
        void this.reloadDaemon();
      }
      return { ok: true, value: this.connection };
    } catch (error) {
      return failure(
        (error as Error).name === 'TimeoutError' ? 'daemon_busy' : 'daemon_unavailable',
        `GET /health failed: ${String(error)}`,
      );
    }
  }

  /** busy: the daemon's process is alive but did not answer in time; known only outside WSL. */
  private async probe(
    timeout = 5000,
  ): Promise<
    | { ok: true; url: string; token: string; pid: number }
    | { ok: false; reason: string; busy?: boolean }
  > {
    let manifest: { url: string; token_file: string; pid: number }, token: string;
    try {
      if (this.options.wsl) ({ manifest, token } = await this.wslManifest());
      else {
        manifest = JSON.parse(
          readFileSync(path.join(this.options.directory, 'daemon.json'), 'utf8'),
        );
        token = readFileSync(manifest.token_file, 'utf8').trim();
      }
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
    try {
      const response = await fetch(new URL('/v1/capabilities', manifest.url), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeout),
      });
      if (response.status !== 200)
        return { ok: false, reason: `${manifest.url} answered ${response.status}` };
    } catch (error) {
      const { pid } = manifest;
      return {
        ok: false,
        reason: `${manifest.url}: ${String(error)}`,
        // Zero and negative pids address process groups.
        busy:
          !this.options.wsl &&
          (error as Error).name === 'TimeoutError' &&
          Number.isInteger(pid) &&
          pid > 0 &&
          alive(pid),
      };
    }
    return { ok: true, url: manifest.url, token, pid: manifest.pid };
  }

  private async start(): Promise<BridgeResult<null>> {
    if (this.options.wsl) return this.startInWsl();
    const { launch } = this.options;
    const node = launch?.node ?? 'node';
    const entry = launch?.entry ?? path.join(this.options.repo, 'apps/daemon/dist/main.js');
    if (launch) {
      const missing = [node, entry].find((file) => !existsSync(file));
      if (missing)
        return failure(
          'daemon_unavailable',
          `${missing} does not exist; the app is damaged, package it again`,
        );
    } else if (!existsSync(entry))
      return failure('daemon_unavailable', `${entry} does not exist; run pnpm build`);
    mkdirSync(path.dirname(this.options.logFile), { recursive: true });
    const log = openSync(this.options.logFile, 'a');
    try {
      // The fixture runtime runs scripted turns without a sandbox, so only test runs opt in.
      const fixture = process.env.PANTHEON_ALLOW_FIXTURE === '1' ? ['--allow-fixture'] : [];
      const child = spawn(node, [entry, '--data-dir', this.options.directory, ...fixture], {
        detached: true,
        stdio: ['ignore', log, log],
        ...(launch && { env: { ...process.env, ...launch.env } }),
      });
      const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
        child.once('spawn', () => resolve(undefined));
        child.once('error', resolve);
      });
      if (error)
        return failure(
          'daemon_unavailable',
          error.code === 'ENOENT' && !launch ? '`node` is not on PATH' : String(error),
        );
      child.unref();
      this.startedPid = child.pid;
      return { ok: true, value: null };
    } finally {
      closeSync(log);
    }
  }

  /** Runs the daemon as the foreground of a wsl.exe, since the distro stops soon after its last wsl.exe. */
  private async startInWsl(): Promise<BridgeResult<null>> {
    let runtime: WslRuntime;
    try {
      runtime = await this.installed();
    } catch (error) {
      return failure(
        'daemon_unavailable',
        `Installing the runtime in WSL failed: ${String(error)}`,
      );
    }
    const { distro, desktopDataDir } = this.options.wsl!;
    mkdirSync(path.dirname(this.options.logFile), { recursive: true });
    const log = openSync(this.options.logFile, 'a');
    try {
      const fixture = process.env.PANTHEON_ALLOW_FIXTURE === '1' ? ['--allow-fixture'] : [];
      // System32's wsl.exe is a stub that starts the WSL app's wsl.exe; detached, the stub has no
      // console, so that wsl.exe opens one, and Windows shows it, often in Windows Terminal.
      const own = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WSL', 'wsl.exe');
      // A login shell gives the daemon the user's PATH, where claude and codex are.
      const child = spawn(
        existsSync(own) ? own : 'wsl.exe',
        [
          '-d',
          distro,
          '--exec',
          'bash',
          '-lc',
          WSL_LAUNCH_SCRIPT,
          path.posix.join(runtime.root, 'node/bin/node'),
          path.posix.join(runtime.root, 'daemon/dist/main.js'),
          runtime.data,
          desktopDataDir,
          path.posix.join(runtime.root, 'cli/dist/index.js'),
          ...fixture,
        ],
        { detached: true, windowsHide: true, stdio: ['ignore', log, log] },
      );
      const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
        child.once('spawn', () => resolve(undefined));
        child.once('error', resolve);
      });
      if (error) return failure('daemon_unavailable', String(error));
      child.unref();
      return { ok: true, value: null };
    } finally {
      closeSync(log);
    }
  }
}
