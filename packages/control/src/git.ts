import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { nativeEnvironment } from '@pantheon/adapters';
import { cachedDriverConfig, DRIVER_PATTERN } from './git-config-cache.js';

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
  const config = [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.autocrlf=false',
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
      maxBuffer: 64 * 1024 * 1024,
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
  const cached = Object.keys(execution.env ?? {}).some((key) => key.startsWith('GIT_'))
    ? undefined
    : cachedDriverConfig(cwd, execution.work_tree);
  if (!cached) return query();
  if ('overrides' in cached) return run(cached.overrides);
  return andThen(
    execute([
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
      '--git-common-dir',
      '--show-toplevel',
    ]),
    (located) => {
      if (located.exit_code !== 0 || !cached.located(located.stdout.toString())) return query();
      return andThen(execute(['config', '--null', '--show-origin', '--list']), (listed) => {
        const overrides = listed.exit_code === 0 ? cached.listed(listed.stdout) : undefined;
        return overrides ? run(overrides) : query();
      });
    },
  );
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

function andThen<T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>): U | Promise<U> {
  return value instanceof Promise ? value.then(next) : next(value);
}
