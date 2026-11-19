import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { hash, requireThat, type TestCounts } from '@pantheon/domain';
import { inside, type ControlContext } from './context.js';
import { trackChildProcess } from './child-processes.js';
import { copyDependencyFolders } from './dependency-folders.js';
import { textLimit } from './files.js';
import { protectedInputs } from './sources.js';
import { GateTestCounts } from './gate-test-counts.js';

export interface ValidationInput {
  ctx: ControlContext;
  key: string;
  argv: string[];
  cwd: string;
  root: string;
  /** The root is a clone Pantheon made for this check, so protected paths the run created are removed. */
  disposable?: boolean;
  readFiles?: string[];
  env?: NodeJS.ProcessEnv;
  /** On macOS, the command may open the GPU driver and the Metal compiler and video decode services. */
  gpu?: boolean;
  timeoutMs: number;
  cancelled?: () => boolean;
}

export interface ValidationResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  stdout: Buffer;
  stderr: Buffer;
  log: Buffer;
  tail: string;
  tests?: TestCounts;
  timedOut: boolean;
  stdout_sha256: string;
  stderr_sha256: string;
  output_truncated: boolean;
  error?: string;
  cleanup_error?: string;
  boundary: {
    kind: 'macos-seatbelt' | 'linux-bubblewrap';
    network: 'loopback';
    policy_sha256?: string;
    supported: boolean;
    stop_scope: 'process-group';
    environment?: { names: string[]; sha256: string };
  };
  stopped?: {
    reason: 'timeout' | 'shutdown' | 'cancelled';
    signal: NodeJS.Signals | null;
    descendants: 'unconfirmed';
  };
}

// A writable hardlink can modify an inode outside a path sandbox. Managed verifier
// clones use --no-hardlinks; reject any remaining multiply-linked regular files.
async function rejectHardlinks(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const stat = await lstat(target);
    requireThat(
      !stat.isFile() || stat.nlink === 1,
      'scope_violation',
      'Verifier workspace contains a hardlink',
    );
    if (stat.isDirectory()) await rejectHardlinks(target);
  }
}

async function executable(argv0: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  for (const candidate of argv0.includes(path.sep)
    ? [path.resolve(cwd, argv0)]
    : (env.PATH ?? '/usr/bin:/bin')
        .split(path.delimiter)
        .filter(path.isAbsolute)
        .map((dir) => path.join(dir, argv0))) {
    try {
      await access(candidate, constants.X_OK);
      // A folder passes the execute check too.
      if (!(await stat(candidate)).isFile()) continue;
      return await realpath(candidate);
    } catch {
      /* Try the next fixed PATH entry. */
    }
  }
  throw new Error('validation_executable_unavailable');
}

/**
 * The installed node_modules package or Homebrew keg (`Cellar/<formula>/<version>`) holding the
 * file, whose other files the tool or a script's interpreter loads.
 */
async function installedPackage(file: string): Promise<string | undefined> {
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (path.basename(path.dirname(path.dirname(dir))) === 'Cellar') return dir;
    const parent = path.dirname(dir);
    const folder = path.basename(parent).startsWith('@') ? path.dirname(parent) : parent;
    if (path.basename(folder) !== 'node_modules') continue;
    try {
      await access(path.join(dir, 'package.json'));
      return dir;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The PATH folders a gate command's shell searches, outside the system folders, and the installed
 * packages or files their links point to. A folder or target that is protected or holds a
 * protected path is left out, so a PATH entry such as HOME mounts nothing.
 */
async function pathTools(
  PATH: string | undefined,
  skipped: string[],
  protectedPaths: string[],
): Promise<{ folders: string[]; files: string[] }> {
  const folders = new Set<string>(),
    files = new Set<string>();
  const allowed = (target: string) =>
    !skipped.some((dir) => inside(dir, target)) &&
    !protectedPaths.some((denied) => inside(denied, target) || inside(target, denied));
  for (const entry of (PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    const dir = await realpath(entry).catch(() => undefined);
    if (!dir || !(await lstat(dir)).isDirectory() || !allowed(dir)) continue;
    folders.add(dir);
    for (const link of await readdir(dir, { withFileTypes: true })) {
      if (!link.isSymbolicLink()) continue;
      const target = await realpath(path.join(dir, link.name)).catch(() => undefined);
      if (!target || inside(dir, target)) continue;
      const installed = await installedPackage(target);
      if (installed ? allowed(installed) : allowed(target))
        (installed ? folders : files).add(installed ?? target);
    }
  }
  return { folders: [...folders], files: [...files] };
}

/** The developer folder `xcode-select -p` reports for each DEVELOPER_DIR, absent without developer tools. */
const developerFolders = new Map<string | undefined, Promise<string | undefined>>();

/**
 * bubblewrap arguments matching the Seatbelt profile: system files, the command and its package
 * read-only, the candidate and scratch folders writable, everything else unmounted.
 */
async function bubblewrapArguments(
  root: string,
  scratch: string,
  cwd: string,
  files: string[],
  packages: string[],
  protectedPaths: string[],
): Promise<string[]> {
  const present = (target: string) => lstat(target).catch(() => undefined);
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr'];
  const system = ['/usr'];
  for (const dir of ['/bin', '/lib', '/lib64', '/sbin']) {
    const stat = await present(dir);
    if (stat?.isSymbolicLink()) args.push('--symlink', await readlink(dir), dir);
    else if (stat) {
      args.push('--ro-bind', dir, dir);
      system.push(dir);
    }
  }
  for (const entry of [
    '/etc/ssl',
    '/etc/ca-certificates',
    '/etc/passwd',
    '/etc/group',
    '/etc/nsswitch.conf',
    '/etc/hosts',
    '/etc/localtime',
    // git and node may be reached through Debian alternatives links.
    '/etc/alternatives',
  ]) {
    if (!(await present(entry))) continue;
    args.push('--ro-bind', entry, entry);
    system.push(entry);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const dir of [root, scratch]) args.push('--bind', dir, dir);
  for (const file of [...files, ...packages]) args.push('--ro-bind', file, file);
  const mounted = [...system, scratch, ...packages];
  for (const denied of protectedPaths) {
    const stat = await present(denied);
    if (!stat) continue;
    // The candidate is a clone of committed files, so its own protected entries stay readable.
    if (inside(root, denied)) args.push('--ro-bind', denied, denied);
    // Protected state elsewhere is unmounted unless it lies inside a mounted folder.
    else if (mounted.some((dir) => inside(dir, denied)))
      args.push(
        ...(stat.isDirectory()
          ? ['--tmpfs', denied, '--remount-ro', denied]
          : ['--ro-bind', '/dev/null', denied]),
      );
  }
  // Mount points bubblewrap created for the binds above stay unwritable, as under Seatbelt.
  args.push('--remount-ro', '/tmp', '--remount-ro', '/', '--chdir', cwd);
  return args;
}

/** The git metadata a linked worktree's .git file points to, outside the worktree. */
async function linkedGitDirs(root: string): Promise<string[]> {
  const link = await readFile(path.join(root, '.git'), 'utf8').catch(() => '');
  const gitdir = /^gitdir: (.+)$/m.exec(link)?.[1];
  if (!gitdir) return [];
  const dir = await realpath(path.resolve(root, gitdir));
  const common = await readFile(path.join(dir, 'commondir'), 'utf8').catch(() => undefined);
  return [dir, ...(common ? [await realpath(path.resolve(dir, common.trim()))] : [])];
}

/** By path, the runs that use the empty folder there as a stand-in for a missing protected entry. */
const placeholderRuns = new Map<string, number>();

/** Ends a run's use of a stand-in folder, which the last run removes; true while the folder is still empty. */
async function releasePlaceholder(folder: string): Promise<boolean> {
  const runs = placeholderRuns.get(folder)! - 1;
  if (runs) placeholderRuns.set(folder, runs);
  else placeholderRuns.delete(folder);
  if (!runs)
    return rmdir(folder).then(
      () => true,
      () => false,
    );
  return readdir(folder).then(
    (entries) => !entries.length,
    () => false,
  );
}

/** Returns false when shutdown stopped the copy before it finished. */
export async function copyCandidateDependencies(
  ctx: ControlContext,
  key: string,
  source: string,
  clone: string,
  cancelled?: () => boolean,
): Promise<boolean> {
  const copying = new AbortController();
  const poll = setInterval(() => {
    if (ctx.closing || cancelled?.()) copying.abort();
  }, 50);
  try {
    await copyDependencyFolders(source, clone, copying.signal);
    return true;
  } catch (error) {
    if (copying.signal.aborted) return false;
    throw error;
  } finally {
    clearInterval(poll);
  }
}

export async function runValidationCommand(input: ValidationInput): Promise<ValidationResult> {
  const started = performance.now();
  const boundary: ValidationResult['boundary'] = {
    kind: process.platform === 'linux' ? 'linux-bubblewrap' : 'macos-seatbelt',
    network: 'loopback',
    supported: process.platform === 'darwin' || process.platform === 'linux',
    stop_scope: 'process-group',
  };
  const unavailable = (error: unknown): ValidationResult => ({
    exit_code: null,
    signal: null,
    duration_ms: performance.now() - started,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: '',
    timedOut: false,
    stdout_sha256: createHash('sha256').digest('hex'),
    stderr_sha256: createHash('sha256').digest('hex'),
    output_truncated: false,
    error: String(error),
    boundary,
  });
  if (!boundary.supported)
    return unavailable(
      'validation_isolation_unavailable: macOS Seatbelt or Linux bubblewrap required',
    );
  const linux = process.platform === 'linux';
  const launcher = linux ? '/usr/bin/bwrap' : '/usr/bin/sandbox-exec';
  let temporary: string | undefined;
  let completed: ValidationResult | undefined;
  const absent: string[] = [];
  const placeholders: string[] = [];
  try {
    await access(launcher, constants.X_OK);
    const root = await realpath(input.root),
      cwd = await realpath(input.cwd);
    requireThat(inside(root, cwd), 'scope_violation', 'Verifier cwd is outside the candidate');
    // Any other root is a folder a session already writes under its own sandbox, and package
    // managers such as pnpm hardlink installed files there.
    if (input.disposable) await rejectHardlinks(root);
    // macOS caps a Unix socket path at 104 bytes, too few for sockets under the per-user tmpdir.
    temporary = await mkdtemp(
      path.join(
        process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(),
        'pantheon-validation-',
      ),
    );
    const scratch = await realpath(temporary);
    await mkdir(path.join(scratch, 'home'));
    await mkdir(path.join(scratch, 'tmp'));
    // The sandbox hides the user's git identity; commits made by the candidate's tests need one.
    await writeFile(
      path.join(scratch, 'home', '.gitconfig'),
      '[user]\n\tname = Pantheon Gate\n\temail = gate@example.invalid\n',
    );
    // Never inherit daemon/session credentials, loader injections or native-agent settings.
    const supplied = Object.fromEntries(
      Object.entries(input.env ?? {}).filter(
        ([name]) =>
          !/^(?:DYLD_|LD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|PANTHEON_|CODEX_|CLAUDE_|GIT_CONFIG)/.test(
            name,
          ),
      ),
    );
    const env = {
      ...supplied,
      HOME: path.join(scratch, 'home'),
      TMPDIR: path.join(scratch, 'tmp'),
      OPENSSL_CONF: '/dev/null',
      // The system git config lies outside the sandbox; git aborts when it cannot read it.
      GIT_CONFIG_NOSYSTEM: '1',
    };
    boundary.environment = { names: Object.keys(env).sort(), sha256: hash(env) };
    const command = await executable(input.argv[0]!, cwd, env);
    const files = await Promise.all(
      [command, ...(input.readFiles ?? [])].map((file) => realpath(file)),
    );
    const installed = await installedPackage(command);
    // Read-only, so git in a linked worktree finds its repository.
    const packages = [...(installed ? [installed] : []), ...(await linkedGitDirs(root))];
    const protectedPaths = protectedInputs(input.ctx, [root]);
    requireThat(
      ![...files, ...packages].some((file) =>
        protectedPaths.some((denied) => inside(denied, file)),
      ),
      'scope_violation',
      'Verifier input is protected',
    );
    requireThat(
      !protectedPaths.some((denied) => inside(denied, root)),
      'scope_violation',
      'Verifier candidate overlaps protected state',
    );
    // Gate commands run through /bin/sh and find tools such as node and npm on PATH: on Linux often
    // under HOME, on macOS under Homebrew.
    const tools = await pathTools(
      input.env?.PATH,
      linux
        ? // WSL mounts the Windows drives under /mnt and puts their folders on PATH.
          ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/mnt', root, scratch]
        : [
            '/System',
            '/usr/bin',
            '/usr/sbin',
            '/usr/lib',
            '/usr/share',
            '/bin',
            '/sbin',
            root,
            scratch,
          ],
      protectedPaths,
    );
    let launch: string[];
    // bubblewrap mounts over existing paths only, so each protected candidate folder missing at the
    // start is an empty folder during the run, mounted read-only below. Missing protected files stay
    // absent, since tools read them as optional files, and are checked after the run.
    if (linux) {
      for (const denied of protectedPaths)
        if (
          inside(root, denied) &&
          (!(await lstat(denied).catch(() => undefined)) || placeholderRuns.has(denied))
        ) {
          absent.push(denied);
          if (!['.git', '.claude', '.codex'].includes(path.relative(root, denied))) continue;
          // Held before the mkdir, so a run that ends meanwhile leaves the folder standing.
          placeholderRuns.set(denied, (placeholderRuns.get(denied) ?? 0) + 1);
          placeholders.push(denied);
          await mkdir(denied).catch(async (error: NodeJS.ErrnoException) => {
            // A parallel run in this root made it first.
            if (error.code !== 'EEXIST' || (await readdir(denied)).length) throw error;
          });
        }
      const args = await bubblewrapArguments(
        root,
        scratch,
        cwd,
        [...files, ...tools.files],
        [...packages, ...tools.folders],
        protectedPaths,
      );
      boundary.policy_sha256 = createHash('sha256').update(args.join('\n')).digest('hex');
      launch = [...args, '--', command, ...input.argv.slice(1)];
    } else {
      const quote = (value: string) => JSON.stringify(value);
      const { DEVELOPER_DIR } = supplied;
      if (!developerFolders.has(DEVELOPER_DIR))
        developerFolders.set(
          DEVELOPER_DIR,
          promisify(execFile)('/usr/bin/xcode-select', ['-p'], { env })
            .then(({ stdout }) => realpath(stdout.trim()))
            .catch(() => undefined),
        );
      const developer = await developerFolders.get(DEVELOPER_DIR);
      // The xcrun shims such as make and git load the whole Xcode bundle, not only its developer folder.
      const toolchain = developer?.match(/^(.+\.app)\/Contents\/Developer$/)?.[1] ?? developer;
      const profile = [
        '(version 1)',
        '(deny default)',
        '(allow process-exec process-fork)',
        '(allow signal (target same-sandbox))',
        '(allow sysctl-read)',
        // Metadata is needed to traverse parent directories; their contents remain unreadable.
        '(allow file-read-metadata)',
        '(allow file-read* (literal "/"))',
        ...[
          '/System/Library',
          '/usr/lib',
          '/usr/share',
          '/usr/bin',
          '/bin',
          '/private/var/db/dyld',
        ].map((dir) => `(allow file-read* (subpath ${quote(dir)}))`),
        // Homebrew dynamic libraries only, not its configuration, home directories or cellar data.
        '(allow file-read* (regex #"^/(opt/homebrew|usr/local)/(Cellar|opt)/.*[.]dylib$"))',
        // Homebrew git's repository templates, which git init copies into every new .git.
        '(allow file-read* (regex #"^/(opt/homebrew|usr/local)/Cellar/git/[^/]+/share/git-core/templates(/|$)"))',
        ...['/dev/null', '/dev/random', '/dev/urandom'].map(
          (file) => `(allow file-read* (literal ${quote(file)}))`,
        ),
        '(allow file-write* (literal "/dev/null"))',
        // A shell's process substitution reads and writes its own descriptors there.
        '(allow file-read* file-write* (subpath "/dev/fd"))',
        // diff copies a pipe input to /tmp/diff.XXXXXXXX, ignoring TMPDIR, and unlinks it at once.
        '(allow file-read* file-write* (regex #"^/private/tmp/diff[.][^/]+$"))',
        ...[root, scratch].map((dir) => `(allow file-read* file-write* (subpath ${quote(dir)}))`),
        ...[...files, ...tools.files].map((file) => `(allow file-read* (literal ${quote(file)}))`),
        // Read-only, so a script command such as npm can load its own installed package.
        ...[...packages, ...tools.folders].map(
          (dir) => `(allow file-read* (subpath ${quote(dir)}))`,
        ),
        // xcodebuild, which a shim runs to find its tool, reads the accepted Xcode license there.
        ...(toolchain
          ? [
              `(allow file-read* (subpath ${quote(toolchain)}))`,
              '(allow file-read* (literal "/Library/Preferences/com.apple.dt.Xcode.plist"))',
            ]
          : []),
        // The candidate is a clone of committed files, so its own protected entries stay readable.
        ...protectedPaths.map(
          (dir) =>
            `(deny ${inside(root, dir) ? 'file-write*' : 'file-read* file-write*'} (subpath ${quote(dir)}))`,
        ),
        // Loopback only, so candidate tests can run local servers; every other address stays denied.
        '(allow network-bind network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))',
        ...[root, scratch].flatMap((dir) => [
          `(allow network-bind network-inbound (local unix-socket (subpath ${quote(dir)})))`,
          `(allow network-outbound (remote unix-socket (subpath ${quote(dir)})))`,
        ]),
        // Recursive fs.watch on macOS goes through the FSEvents service.
        '(allow mach-lookup (global-name "com.apple.FSEvents"))',
        // Any GPU driver's user client, not only Apple Silicon's AGXDeviceUserClient, so Intel and AMD Macs work too.
        ...(input.gpu
          ? [
              '(allow iokit-open-user-client (iokit-connection "IOAccelerator"))',
              '(allow iokit-open-user-client (iokit-user-client-class "IOSurfaceRootUserClient"))',
              '(allow mach-lookup (xpc-service-name "com.apple.MTLCompilerService"))',
              '(allow mach-lookup (xpc-service-name "com.apple.coremedia.videodecoder"))',
            ]
          : []),
      ].join('\n');
      boundary.policy_sha256 = createHash('sha256').update(profile).digest('hex');
      launch = ['-p', profile, command, ...input.argv.slice(1)];
    }

    if (input.cancelled?.()) return unavailable('cancelled');

    const result = await new Promise<ValidationResult>((resolve) => {
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [],
        log: Buffer[] = [];
      const tests = new GateTestCounts();
      const outHash = createHash('sha256'),
        errHash = createHash('sha256');
      let outSize = 0,
        errSize = 0,
        logSize = 0,
        timedOut = false,
        cancelled = false,
        error: string | undefined,
        tail = '';
      const child = spawn(launcher, launch, {
        cwd,
        env,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stop = trackChildProcess(input.ctx, input.key, child, (failure) => {
        error = String(failure);
      });
      let drain: NodeJS.Timeout | undefined;
      // A descendant in its own session can keep the output pipes open after the group is
      // stopped, and the run settles only once they close.
      const halt = () => {
        stop();
        drain ??= setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, 1000);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        halt();
      }, input.timeoutMs);
      const cancellation = setInterval(() => {
        if (input.cancelled?.()) {
          cancelled = true;
          halt();
        }
      }, 50);
      const collect = (bytes: Buffer, channel: 'stdout' | 'stderr') => {
        tests.write(bytes.toString('utf8'), channel);
        tail = (tail + bytes.toString('utf8')).slice(-4000);
        const size = channel === 'stdout' ? outSize : errSize;
        (channel === 'stdout' ? outHash : errHash).update(bytes);
        const kept = bytes.subarray(0, Math.max(0, textLimit - size));
        if (kept.length) (channel === 'stdout' ? stdout : stderr).push(Buffer.from(kept));
        const combined = bytes.subarray(0, Math.max(0, textLimit - logSize));
        if (combined.length) log.push(Buffer.from(combined));
        if (channel === 'stdout') outSize += bytes.length;
        else errSize += bytes.length;
        logSize += bytes.length;
      };
      child.stdout.on('data', (bytes: Buffer) => collect(bytes, 'stdout'));
      child.stderr.on('data', (bytes: Buffer) => collect(bytes, 'stderr'));
      child.on('error', (failure) => {
        error = String(failure);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(drain);
        clearInterval(cancellation);
        // Reap ordinary background children even when they closed their stdio and
        // the leader exited successfully. Deliberately detached groups remain unconfirmed.
        stop();
        const counts = tests.finish();
        resolve({
          ...(counts ? { tests: counts } : {}),
          exit_code: error ? null : code,
          signal,
          duration_ms: performance.now() - started,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          log: Buffer.concat(log),
          tail,
          timedOut,
          stdout_sha256: outHash.digest('hex'),
          stderr_sha256: errHash.digest('hex'),
          output_truncated: outSize > textLimit || errSize > textLimit || logSize > textLimit,
          error,
          boundary,
          ...(timedOut || input.ctx.closing || cancelled
            ? {
                stopped: {
                  reason: cancelled
                    ? ('cancelled' as const)
                    : timedOut
                      ? ('timeout' as const)
                      : ('shutdown' as const),
                  signal,
                  descendants: 'unconfirmed' as const,
                },
              }
            : {}),
        });
      });
    });
    const created: string[] = [];
    for (const denied of absent) {
      // Only a folder still empty is removed; anything in it was written from outside the sandbox.
      if (placeholders.includes(denied)) {
        placeholders.splice(placeholders.indexOf(denied), 1);
        if (await releasePlaceholder(denied)) continue;
      }
      if (!(await lstat(denied).catch(() => undefined))) continue;
      // The path did not exist when the run started, so removing it restores that state. In any
      // other root someone besides the command may have created it.
      if (input.disposable) await rm(denied, { recursive: true, force: true });
      created.push(path.relative(root, denied));
    }
    completed = created.length
      ? {
          ...result,
          exit_code: null,
          error: `validation_scope_violation: the command created protected ${created.join(', ')}`,
        }
      : result;
    return completed;
  } catch (error) {
    return unavailable(error);
  } finally {
    // A run that stopped before its check leaves the empty folders standing in for absent entries.
    for (const denied of placeholders) await releasePlaceholder(denied);
    if (temporary) {
      try {
        await rm(temporary, { recursive: true, force: true });
      } catch (error) {
        if (completed) completed.cleanup_error = String(error);
      }
    }
  }
}
