import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { onTestFinished, vi } from 'vitest';
import { Store, ArtifactFiles } from '@pantheon/store';
import { Control, type ControlOptions } from '@pantheon/control';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, type CommandType } from '@pantheon/protocol';
import {
  id,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
  type Workspace,
  type HarnessAdapter,
} from '@pantheon/domain';
import type { ControlContext } from '../packages/control/dist/context.js';
import {
  registerWorkspace as registerInControl,
  type WorkspaceRegistration,
} from '../packages/control/dist/workspace.js';

/**
 * True inside a macOS sandbox, such as a project gate, where Seatbelt cannot apply another
 * profile and the pnpm store is not writable; tests that need either are skipped there.
 */
export const insideSandbox =
  process.platform === 'darwin' &&
  spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])
    .status !== 0;

/** False inside a macOS sandbox, which refuses to run the setuid `ps` some tests read processes with. */
export const psUsable = spawnSync('ps', ['-p', String(process.pid)]).status === 0;

/** False where a pseudo-terminal cannot be opened, such as inside a macOS sandbox. */
export const ptyUsable = (() => {
  try {
    closeSync(openSync('/dev/ptmx', constants.O_RDWR | constants.O_NOCTTY));
    return true;
  } catch {
    return false;
  }
})();

/**
 * A folder a project gate can read while it runs, and the argv of a gate that runs the source.
 * Seatbelt lets a gate read any file; bubblewrap mounts only the installed package holding the
 * gate's command, so on Linux the folder is such a package and each gate runs a script in it.
 */
export function gateFolder(root: string): { dir: string; argv: (source: string) => string[] } {
  if (process.platform !== 'linux')
    return { dir: root, argv: (source) => [process.execPath, '-e', source] };
  const dir = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'pantheon-gate-')),
    'node_modules',
    'gate',
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{}');
  let scripts = 0;
  return {
    dir,
    argv(source) {
      const file = path.join(dir, `gate-${++scripts}.cjs`);
      writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
      return [file];
    },
  };
}

export const user: Principal = { id: 'local-user', role: 'user' };
export async function fixture(
  options: {
    adapter?: HarnessAdapter;
    failpoint?: (name: string) => void;
    now?: () => number;
    controlOptions?: ControlOptions;
    /** Give Control a managed workspace root, for linked worktrees. */
    managedWorkspaces?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-test-')),
    projectRoot = path.join(root, 'project'),
    cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(projectRoot);
  // Managed workspaces may not live in temporary directories.
  if (options.managedWorkspaces) mkdirSync(cache, { recursive: true });
  const workspaceRoot = options.managedWorkspaces
    ? mkdtempSync(path.join(cache, 'pantheon-managed-'))
    : undefined;
  const store = new Store(path.join(root, 'state/control.sqlite'), options.now),
    files = new ArtifactFiles(path.join(root, 'state/artifacts')),
    adapter = options.adapter ?? new FixtureAdapter(),
    controlOptions = workspaceRoot
      ? { ...options.controlOptions, workspaceRoot }
      : options.controlOptions;
  // A commit survives a process crash in WAL mode without the disk sync the daemon asks for.
  store.db.exec('PRAGMA synchronous=NORMAL');
  const control = new Control(store, files, [adapter], options.failpoint, controlOptions);
  const call = <T = unknown>(
    type: CommandType,
    input: Record<string, unknown>,
    revision: number | null = null,
    principal = user,
  ): T => control.execute(principal, command(principal.id, type, input, revision)) as T;
  const project = await call<Project>('project.open', { name: 'fixture', roots: [projectRoot] });
  return {
    root,
    projectRoot,
    controlOptions,
    store,
    files,
    control,
    adapter,
    call,
    project,
    async close() {
      await control.shutdown();
      store.close();
      rmSync(root, { recursive: true, force: true });
      if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}
/** Registers a workspace in its own transaction, through the function session.create uses. */
export function registerWorkspace(control: Control, input: WorkspaceRegistration): Workspace {
  const ctx = (control as unknown as { ctx: ControlContext }).ctx;
  const git = gitTopLevel(input.source);
  return ctx.store.transaction(() => registerInControl(ctx, input, crypto.randomUUID(), git));
}
/** gitFolderAsync's answer read with a plain git, so a fixture registers without awaiting. */
function gitTopLevel(root: string): boolean {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return false;
  }
  const located = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: real,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    encoding: 'utf8',
  });
  return located.status === 0 && realpathSync(located.stdout.trim()) === real;
}
export async function eventually(
  fn: () => boolean,
  step: () => Promise<unknown> = async () => {},
  timeout = 5000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timed out waiting for observable state');
    await step();
    await sleep(10);
  }
}

/** Worktree registration returns a reservation; wait before using its files or Git metadata. */
export async function awaitWorkspaceReady(
  control: Control,
  workspace: Workspace | string,
  timeout = 10000,
): Promise<Workspace> {
  const workspaceId = typeof workspace === 'string' ? workspace : workspace.id;
  await eventually(
    () => {
      const current = control.store.must<Workspace>('workspaces', workspaceId);
      const state = current.provisioning?.state;
      if (state && !['queued', 'running', 'ready'].includes(state))
        throw new Error(current.provisioning?.error ?? `Workspace provisioning ${state}`);
      return state === undefined || state === 'ready';
    },
    () => control.tick(),
    timeout,
  );
  return control.store.must<Workspace>('workspaces', workspaceId);
}

/** Waits for the session's workspace, then for the session to be open with no turn left to run. */
export async function settle(
  f: { control: Control; store: Store; turns: (sessionId: string) => SessionTurn[] },
  session: Session,
) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.store.must<Session>('sessions', session.id).state === 'open' &&
      f.turns(session.id).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );
}

/** Inserts an open session row on a newly registered linked worktree of the fixture's project. */
export function insertSession(
  f: Awaited<ReturnType<typeof fixture>>,
  extra: Partial<Session> = {},
) {
  const workspace = registerWorkspace(f.control, {
    project_id: f.project.id,
    kind: 'linked_worktree',
    source: f.store.must<Project>('projects', f.project.id).roots[0]!,
    base_ref: 'HEAD',
  });
  return f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
    ...extra,
  });
}

/**
 * Puts a git first on PATH that logs each run as `cwd|GIT_ALLOW_PROTOCOL|arguments`, without the
 * leading `-c` options. A run whose arguments contain the text given to slowOn logs `slow start`,
 * sleeps a second and logs `slow done` before git runs.
 */
export function countingGit() {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/counting-git-')),
    log = path.join(bin, 'runs.log'),
    slow = path.join(bin, 'slow');
  writeFileSync(log, '');
  writeFileSync(slow, '');
  writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      `printf '%s|%s|%s\\n' "$PWD" "$GIT_ALLOW_PROTOCOL" "$*" >> '${log}'`,
      `pattern=$(cat '${slow}')`,
      `if [ -n "$pattern" ]; then case "$*" in *"$pattern"*) echo 'slow start' >> '${log}'; sleep 1; echo 'slow done' >> '${log}';; esac; fi`,
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    runs: () =>
      lines()
        .filter((line) => line.includes('|'))
        .map((line) => line.replace(/(^[^|]*\|[^|]*\|)(?:-c \S+ )*/, '$1')),
    log: lines,
    reset: () => writeFileSync(log, ''),
    slowOn: (text: string) => writeFileSync(slow, text),
    restore: () => {
      process.env.PATH = PATH;
      // A git the test left running can still append its log line while the folder is removed.
      rmSync(bin, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** The arguments of each logged run whose subcommand is name. */
export const gitRunsOf = (runs: string[], name: string) =>
  runs
    .map((run) => run.split('|').slice(2).join('|'))
    .filter((args) => args.replace(/^--literal-pathspecs /, '').split(' ')[0] === name);

/**
 * Puts a git first on PATH that, on the first run whose arguments contain ` ${trigger} `, takes the
 * repository's index lock as another git would and gives it up 300 ms later; restore undoes it.
 */
export function heldIndexLock(trigger: string) {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/held-index-lock-')),
    taken = path.join(bin, 'taken');
  writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      `case " $* " in *" ${trigger} "*)`,
      `  if [ ! -e '${taken}' ]; then`,
      `    : > '${taken}'; lock="\${GIT_DIR:-.git}/index.lock"; : > "$lock"`,
      `    (sleep 0.3; rm -f "$lock") </dev/null >/dev/null 2>&1 &`,
      '  fi;;',
      'esac',
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  return {
    restore: () => {
      process.env.PATH = PATH;
      rmSync(bin, { recursive: true, force: true });
    },
  };
}

const passed = new WeakMap<Store, { ms: number }>();

/** Moves the store's clock on by ms, as waiting that long would. */
export function passTime(store: Store, ms: number): void {
  let offset = passed.get(store);
  if (!offset) {
    const now = store.now;
    const added = { ms: 0 };
    passed.set(store, (offset = added));
    vi.spyOn(store, 'now').mockImplementation(() => now() + added.ms);
  }
  offset.ms += ms;
}

let waited = 0;

/** Moves Date.now on past the 2 s a finished git status is reused for, as waiting that long would. */
export function waitOutStatusReuse(): void {
  if (!waited) {
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + waited);
    onTestFinished(() => {
      waited = 0;
      clock.mockRestore();
    });
  }
  waited += 2001;
}
