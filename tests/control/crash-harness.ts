import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import type { Principal } from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import { user } from '../helpers.js';
import { git } from './workbench-fixture.js';

const child = fileURLToPath(new URL('./crash-child.mjs', import.meta.url));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A daemon in this process on the bench's data directory. */
export interface BenchDaemon {
  store: Store;
  control: Control;
  call<T = unknown>(
    type: CommandType,
    input: Record<string, unknown>,
    revision?: number | null,
    principal?: Principal,
  ): T;
  /** Stops the daemon the normal way and closes its store. */
  stop(): Promise<void>;
}

/** What the crashing daemon runs once it has recovered. */
export interface CrashScenario {
  failpoint: string;
  commands: {
    type: CommandType;
    input: Record<string, unknown>;
    /** Sends the current revision of this session as the expected revision. */
    revision_of?: string;
    principal?: Principal;
  }[];
  /** How long the child ticks before it gives up on reaching the failpoint. */
  timeout_ms?: number;
}

/**
 * A data directory and a git source repository that daemons open one after another: in this
 * process for setup and recovery, and in a child process that a failpoint kills with SIGKILL.
 */
export function crashBench(options: { delay?: number } = {}) {
  const cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  // Managed workspaces may not live in temporary directories.
  const root = mkdtempSync(path.join(cache, 'pantheon-crash-')),
    source = path.join(root, 'project/source'),
    workspaceRoot = path.join(root, 'managed'),
    storeFile = path.join(root, 'state/control.sqlite'),
    artifacts = path.join(root, 'state/artifacts'),
    delay = options.delay ?? 200,
    controlOptions = {
      workspaceRoot,
      protectionPaths: {
        dataDir: path.join(root, 'state'),
        desktopUserDataDir: path.join(root, 'desktop'),
        backupDir: path.join(root, 'backups'),
        home: path.join(root, 'home'),
        codexHome: path.join(root, 'codex'),
      },
    };
  mkdirSync(source, { recursive: true });
  mkdirSync(workspaceRoot);
  git(source, 'init', '--quiet', '--initial-branch=main');
  git(source, 'config', 'user.name', 'Source User');
  git(source, 'config', 'user.email', 'source@example.invalid');
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Initial files');
  const open: BenchDaemon[] = [];
  cleanups.push(async () => {
    for (const daemon of open.splice(0)) await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  /** Opens a daemon here; no process-table recovery, so it signals no process it finds recorded. */
  const start = (): BenchDaemon => {
    const store = new Store(storeFile),
      files = new ArtifactFiles(artifacts),
      control = new Control(store, files, [new FixtureAdapter(delay)], undefined, {
        ...controlOptions,
        readProcess: () => undefined,
      });
    let stopped = false;
    const daemon: BenchDaemon = {
      store,
      control,
      call: (type, input, revision = null, principal = user) =>
        control.execute(principal, command(principal.id, type, input, revision)) as never,
      async stop() {
        if (stopped) return;
        stopped = true;
        open.splice(open.indexOf(daemon), 1);
        await control.shutdown();
        store.close();
      },
    };
    open.push(daemon);
    return daemon;
  };

  /**
   * Runs the scenario in a child daemon on this data directory and waits until the failpoint
   * has killed it. Every daemon here must be stopped first, so only the child writes meanwhile.
   */
  const crash = async (scenario: CrashScenario) => {
    expect(open).toEqual([]);
    const marker = crypto.randomUUID();
    const config = {
      store: storeFile,
      artifacts,
      delay,
      controlOptions,
      failpoint: scenario.failpoint,
      commands: scenario.commands.map((step) => ({ principal: user, ...step })),
      timeout_ms: scenario.timeout_ms ?? 20000,
    };
    const daemon = spawn(
      process.execPath,
      [child, JSON.stringify(config), `--crash-marker=${marker}`],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    daemon.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const [code, signal] = (await once(daemon, 'exit')) as [number | null, NodeJS.Signals | null];
    expect({ code, signal, stderr }).toEqual({ code: null, signal: 'SIGKILL', stderr: '' });
  };

  /** Opens a daemon on the data directory the crash left, as the next daemon start does. */
  const restart = async () => {
    const daemon = start();
    await daemon.control.recover();
    await daemon.control.reconcile();
    return daemon;
  };

  return { root, source, start, crash, restart };
}
