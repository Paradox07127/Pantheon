import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { nativeEnvironment } from '@pantheon/adapters';
import {
  cachedDriverConfig,
  type ConfigMiss,
  DRIVER_PATTERN,
  RECHECK_INTERVAL_MS,
} from './git-config-cache.js';
import { onWslAutomount, wslAutomountRoot, wslDrivePath } from './wsl-mount.js';

export interface GitResult {
  exit_code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  error?: string;
}

export interface GitExecutionOptions {
  before_spawn?: () => void;
  on_spawn?: (child: ChildProcess) => void;
  timeout_ms?: number;
  max_buffer?: number;
  work_tree?: string;
  env?: NodeJS.ProcessEnv;
}

// All Pantheon-owned git operations treat writable repository configuration as untrusted.
export function runGit(
  cwd: string,
  args: string[],
  input?: Buffer,
  asynchronous?: false,
  options?: GitExecutionOptions,
): GitResult;
export function runGit(
  cwd: string,
  args: string[],
  input: Buffer | undefined,
  asynchronous: true,
  options?: GitExecutionOptions,
): Promise<GitResult>;
export function runGit(
  cwd: string,
  args: string[],
  input?: Buffer,
  asynchronous = false,
  execution: GitExecutionOptions = {},
): GitResult | Promise<GitResult> {
  // An in-place session can write beside the protected .git/config; a commondir there would point
  // git at configuration it wrote. A main checkout never has one, so git keeps to this .git.
  const metadata = execution.env?.GIT_DIR === undefined ? ownMetadata(cwd) : undefined;
  if (metadata && existsSync(path.join(metadata, 'commondir'))) {
    const error = `sandbox_path_replaced: The checkout's .git has a commondir file: ${metadata}`;
    const refused = { exit_code: null, stdout: Buffer.alloc(0), stderr: Buffer.from(error), error };
    return asynchronous ? Promise.resolve(refused) : refused;
  }
  const linked = execution.env?.GIT_DIR === undefined ? driveLinkedWorktree(cwd) : undefined;
  const config = [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    // Windows git writes the index with stat data drvfs reports differently, and checks out CRLF.
    ...(onDriveMount(cwd)
      ? ['-c', 'core.autocrlf=input', '-c', 'core.checkStat=minimal', '-c', 'core.trustctime=false']
      : ['-c', 'core.autocrlf=false']),
    // Automatic maintenance can prune worktrees registered under paths this system cannot see.
    '-c',
    'maintenance.auto=false',
    '-c',
    'gc.auto=0',
    // A signature check prints gpg output into parsed log formats and runs gpg.program.
    '-c',
    'log.showSignature=false',
    // Commands that check signatures run these programs; the repository's own would run unsandboxed.
    '-c',
    'gpg.program=/usr/bin/false',
    '-c',
    'gpg.openpgp.program=/usr/bin/false',
    '-c',
    'gpg.x509.program=/usr/bin/false',
    '-c',
    'gpg.ssh.program=/usr/bin/false',
  ];
  const env = {
    ...nativeEnvironment(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ...(metadata ? { GIT_DIR: metadata, GIT_COMMON_DIR: metadata } : {}),
    ...linked,
    ...(execution.work_tree ? { GIT_WORK_TREE: execution.work_tree } : {}),
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Pantheon Check',
    GIT_AUTHOR_EMAIL: 'check@example.invalid',
    GIT_COMMITTER_NAME: 'Pantheon Check',
    GIT_COMMITTER_EMAIL: 'check@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    ...execution.env,
  };
  const execute = (
    command: string[],
    data?: Buffer,
    overrides: string[] = [],
  ): GitResult | Promise<GitResult> => {
    const options = {
      cwd,
      // -c splits at the first '=', so a driver name containing '=' needs the environment form.
      env: {
        ...env,
        GIT_CONFIG_COUNT: String(overrides.length),
        ...Object.fromEntries(
          overrides.flatMap((key, index) => [
            [`GIT_CONFIG_KEY_${index}`, key],
            [
              `GIT_CONFIG_VALUE_${index}`,
              key.endsWith('.required')
                ? 'false'
                : // A failing merge driver leaves its files as conflicts.
                  key.startsWith('merge.')
                  ? '/usr/bin/false'
                  : '',
            ],
          ]),
        ),
      },
      shell: false,
      timeout: execution.timeout_ms ?? 120000,
      killSignal: 'SIGKILL' as const,
    };
    if (asynchronous && execution.on_spawn)
      return new Promise((resolve) => {
        execution.before_spawn?.();
        const child = spawn('git', [...config, ...command], {
          cwd,
          env: options.env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const output: Buffer[] = [],
          errors: Buffer[] = [];
        let outputSize = 0,
          errorSize = 0,
          failure: string | undefined;
        const limit = execution.max_buffer ?? 64 * 1024 * 1024;
        const kill = (reason: string) => {
          failure ??= reason;
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Close records failure. */
          }
        };
        const timer =
          options.timeout > 0
            ? setTimeout(() => kill('Git operation timed out'), options.timeout)
            : undefined;
        child.stdout.on('data', (chunk: Buffer) => {
          outputSize += chunk.length;
          if (outputSize > limit) kill('Git output exceeded its bound');
          else output.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          errorSize += chunk.length;
          if (errorSize > limit) kill('Git output exceeded its bound');
          else errors.push(chunk);
        });
        child.on('error', (error) => {
          failure = String(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve({
            exit_code: failure ? null : code,
            stdout: Buffer.concat(output),
            stderr: Buffer.concat(errors),
            error: failure,
          });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(data);
        try {
          execution.on_spawn!(child);
        } catch (error) {
          kill(String(error));
        }
      });
    if (asynchronous)
      return new Promise((resolve) => {
        execution.before_spawn?.();
        const child = execFile(
          'git',
          [...config, ...command],
          {
            ...options,
            encoding: 'buffer',
            maxBuffer: execution.max_buffer ?? 64 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            resolve({
              exit_code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
              stdout,
              stderr,
              error: error ? String(error) : undefined,
            });
          },
        );
        child.stdin?.on('error', () => {});
        child.stdin?.end(data);
        execution.on_spawn?.(child);
      });
    const result = spawnSync('git', [...config, ...command], {
      ...options,
      maxBuffer: execution.max_buffer ?? 64 * 1024 * 1024,
      stdio: [data ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      input: data,
    });
    return {
      exit_code: result.error ? null : result.status,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr ?? Buffer.alloc(0),
      error: result.error ? String(result.error) : undefined,
    };
  };
  const command = [...args];
  // --literal-pathspecs is a global option, so it precedes the subcommand.
  const subcommand = command[command[0] === '--literal-pathspecs' ? 1 : 0]!;
  // Blame accepts --no-textconv but not --no-ext-diff.
  const neutralized = [
    'diff',
    'diff-files',
    'diff-index',
    'diff-tree',
    'show',
    'log',
    'format-patch',
  ].includes(subcommand)
    ? ['--no-ext-diff', '--no-textconv']
    : subcommand === 'blame'
      ? ['--no-textconv']
      : [];
  if (neutralized.length) {
    const separator = command.indexOf('--');
    command.splice(separator === -1 ? command.length : separator, 0, ...neutralized);
  }
  const run = (overrides: string[]) => execute(command, input, overrides);
  // Attributes can select arbitrary drivers, including from .git/info/attributes.
  // Read names only (including included config), then neutralize every filter and merge driver.
  const query = () =>
    andThen(
      execute(['config', '--null', '--name-only', '--get-regexp', DRIVER_PATTERN]),
      (result) =>
        // A missing match is status 1. Any other failure must prevent the operation.
        result.exit_code !== 0 && result.exit_code !== 1
          ? result
          : run([...new Set(result.stdout.toString().split('\0').filter(Boolean))]),
    );
  // Caller environment can point git at other config, which the cache does not track.
  const cached = Object.keys(execution.env ?? {}).some(
    (key) =>
      key.startsWith('GIT_') &&
      key !== 'GIT_INDEX_FILE' &&
      key !== 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  )
    ? undefined
    : cachedDriverConfig(cwd, execution.work_tree);
  if (!cached) return query();
  if ('overrides' in cached) return run(cached.overrides);
  const probe = (miss: ConfigMiss, learned = () => {}) =>
    andThen(
      execute([
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--git-common-dir',
        '--show-toplevel',
      ]),
      (located) => {
        if (located.exit_code !== 0 || !miss.located(located.stdout.toString())) {
          learned();
          return query();
        }
        return andThen(execute(['config', '--null', '--show-origin', '--list']), (listed) => {
          const overrides = listed.exit_code === 0 ? miss.listed(listed.stdout) : undefined;
          learned();
          return overrides ? run(overrides) : query();
        });
      },
    );
  if (!asynchronous) return probe(cached);
  // Parallel calls that miss on the same repository wait for one probe instead of each running it.
  const pending = learning.get(cached.key);
  if (pending)
    return pending.then(() => {
      const again = cachedDriverConfig(cwd, execution.work_tree);
      if (!again) return query();
      return 'overrides' in again ? run(again.overrides) : probe(again);
    });
  let finish!: () => void;
  const learned = new Promise<void>((resolve) => (finish = resolve));
  learning.set(cached.key, learned);
  const done = () => {
    if (learning.get(cached.key) === learned) learning.delete(cached.key);
    finish();
  };
  const result = Promise.resolve(probe(cached, done));
  result.then(done, done);
  return result;
}

/** The probe each repository's config is being learned by, keyed as the config cache keys it. */
const learning = new Map<string, Promise<void>>();

const driveMounts = new Map<string, { value: boolean; checked: number }>();

/** onWslAutomount for cwd, asked again once its last answer is older than the recheck interval. */
function onDriveMount(cwd: string): boolean {
  const root = wslAutomountRoot();
  if (root === undefined) return false;
  const now = performance.now();
  const previous = driveMounts.get(cwd);
  if (previous && now - previous.checked < RECHECK_INTERVAL_MS) return previous.value;
  const value = onWslAutomount(cwd, root);
  driveMounts.delete(cwd);
  if (driveMounts.size >= 256) driveMounts.delete(driveMounts.keys().next().value!);
  driveMounts.set(cwd, { value, checked: now });
  return value;
}

/** The checkout's own .git directory in cwd; undefined when git finds its repository elsewhere. */
function ownMetadata(cwd: string): string | undefined {
  const metadata = path.resolve(cwd, '.git');
  try {
    return statSync(metadata).isDirectory() ? metadata : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The git directory of a worktree in cwd that a Windows tool made, whose .git names it by drive
 * letter, which git in WSL reads as a relative path.
 */
function driveLinkedWorktree(cwd: string): Record<string, string> | undefined {
  const root = wslAutomountRoot();
  if (root === undefined) return undefined;
  const dotGit = path.resolve(cwd, '.git');
  try {
    if (!statSync(dotGit).isFile()) return undefined;
    const link = /^gitdir: (.+?)[\r\n]*$/s.exec(readFileSync(dotGit, 'utf8'))?.[1];
    const mapped = link && wslDrivePath(link, root);
    if (!mapped) return undefined;
    // Resolved as git resolves a relative commondir, so config origins match the config cache.
    const gitdir = realpathSync(mapped);
    const commondir = path.join(gitdir, 'commondir');
    const common = existsSync(commondir)
      ? wslDrivePath(readFileSync(commondir, 'utf8').replace(/[\r\n]+$/, ''), root)
      : undefined;
    return {
      GIT_DIR: gitdir,
      GIT_WORK_TREE: path.resolve(cwd),
      ...(common ? { GIT_COMMON_DIR: realpathSync(common) } : {}),
    };
  } catch {
    return undefined;
  }
}

function andThen<T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>): U | Promise<U> {
  return value instanceof Promise ? value.then(next) : next(value);
}

// Waits before each new attempt; another git, such as an editor's status refresh, holds it briefly.
const INDEX_LOCK_WAITS_MS = [200, 400, 800];

/**
 * Runs `attempt` again while its git exited because another git held the index lock. That git
 * refuses before changing anything, so the attempt can run again as it was.
 */
export async function retryingIndexLock<T>(
  attempt: () => Promise<T>,
  /** The failure text git printed; empty when it succeeded. */
  output: (result: T) => string,
): Promise<T> {
  let result = await attempt();
  for (const wait of INDEX_LOCK_WAITS_MS) {
    if (!/index\.lock': File exists/.test(output(result))) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
    result = await attempt();
  }
  return result;
}
