import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control, TraceIndex } from '@pantheon/control';
import type {
  Principal,
  ProcessIdentity,
  Project,
  Session,
  SessionTurn,
  WorkflowPolicy,
} from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import type { ExternalSource } from '../../packages/control/src/external-sources.js';
import { user } from '../helpers.js';
import type { LocalCommand } from '../../packages/control/src/local-command.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

export function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Workbench Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Workbench Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

let template: string | undefined;
afterAll(() => {
  if (template) rmSync(path.dirname(template), { recursive: true, force: true });
  template = undefined;
});
/** A repository with one commit of answer.txt on main, made once per test file and copied into each fixture. */
function sourceTemplate(cache: string) {
  if (template) return template;
  const source = path.join(mkdtempSync(path.join(cache, 'pantheon-workbench-template-')), 'source');
  mkdirSync(source);
  git(source, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  git(source, 'add', '.');
  // Detached auto maintenance would still touch .git while the template is copied.
  git(source, '-c', 'maintenance.auto=false', 'commit', '--quiet', '-m', 'Initial files');
  return (template = source);
}

export function workbenchFixture(
  options: {
    managedWorkspaces?: boolean;
    delay?: number;
    /** Names the adapter claude and indexes Claude transcripts in the fixture home, so they can be adopted. */
    adoptable?: boolean;
    externalSources?: ExternalSource[];
    localCommand?: LocalCommand;
  } = {},
) {
  const cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'pantheon-workbench-')),
    source = path.join(root, 'project/source'),
    workspaceRoot = path.join(root, 'managed'),
    protectionPaths = {
      dataDir: path.join(root, 'state'),
      desktopUserDataDir: path.join(root, 'desktop'),
      backupDir: path.join(root, 'backups'),
      home: path.join(root, 'home'),
      codexHome: path.join(root, 'codex'),
    };
  mkdirSync(workspaceRoot);
  cpSync(sourceTemplate(cache), source, { recursive: true });
  const adapter = new FixtureAdapter(options.delay ?? 0);
  if (options.adoptable) adapter.name = 'claude';
  const start = vi.spyOn(adapter, 'start'),
    resume = vi.spyOn(adapter, 'resume'),
    store = new Store(path.join(root, 'state/control.sqlite')),
    files = new ArtifactFiles(path.join(root, 'state/artifacts')),
    claudeHome = path.join(protectionPaths.home, '.claude'),
    trace = options.adoptable
      ? new TraceIndex({
          file: path.join(root, 'state/trace-cache.sqlite'),
          claudeHomes: [claudeHome],
          codexHomes: [protectionPaths.codexHome],
        })
      : undefined,
    controlOptions = {
      ...(options.managedWorkspaces === false
        ? { protectionPaths }
        : { workspaceRoot, protectionPaths }),
      ...(trace ? { trace } : {}),
      // No fixture asks a real service for events.
      externalSources: options.externalSources ?? [],
      localCommand: options.localCommand,
    };
  // A commit survives a process crash in WAL mode without the disk sync the daemon asks for.
  store.db.exec('PRAGMA synchronous=NORMAL');
  let control = new Control(store, files, [adapter], undefined, {
    ...controlOptions,
    // Fresh fixture children need no process-table recovery; restart supplies its own probe.
    readProcess: () => undefined,
  });
  const temporaryDirectories: string[] = [];
  cleanups.push(async () => {
    await control.shutdown();
    trace?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
    for (const directory of temporaryDirectories)
      rmSync(directory, { recursive: true, force: true });
  });
  const call = <T = unknown>(
    type: CommandType,
    input: Record<string, unknown>,
    revision: number | null = null,
    principal: Principal = user,
  ) => control.execute(principal, command(principal.id, type, input, revision)) as T;
  const project = call<Project>('project.open', {
    name: 'Workbench project',
    roots: [source],
  });
  const create = (input = 'Rename the answer file and explain why', principal: Principal = user) =>
    call<Session>(
      'session.create',
      { project_id: project.id, runtime: adapter.name, input },
      null,
      principal,
    );
  const turns = (sessionId: string) =>
    store.list<SessionTurn>('session_turns').filter((turn) => turn.session_id === sessionId);
  const list = () => control.sessionList(user, project.id);
  /** Opens a new Control on the same database and leaves the old one running, as after a daemon crash. */
  const restart = async (readProcess?: (pid: number) => ProcessIdentity | undefined) => {
    control = new Control(store, files, [...control.adapters.values()], undefined, {
      ...controlOptions,
      readProcess,
    });
    control.recover();
    await control.reconcile();
  };
  /** Writes a Claude transcript as a terminal session in cwd would leave it. */
  const nativeRecord = (nativeId: string, cwd = source, title = 'Fix the parser') => {
    const folder = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    const prompt = {
      type: 'user',
      message: { role: 'user', content: title },
      uuid: randomUUID(),
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-11-10T10:00:00.000Z',
      cwd,
      sessionId: nativeId,
      version: '2.1.322',
    };
    writeFileSync(path.join(folder, `${nativeId}.jsonl`), `${JSON.stringify(prompt)}\n`);
  };
  /** Records a native session in cwd, indexes it and adopts it. */
  const adopt = async (
    input: {
      native_id?: string;
      cwd?: string;
      title?: string;
      permission_mode?: 'ask' | 'auto_edit' | 'plan';
    } = {},
  ) => {
    const { native_id = randomUUID(), cwd, ...rest } = input;
    nativeRecord(native_id, cwd);
    await control.traceScan(5000);
    return call<Session>('session.adopt', {
      project_id: project.id,
      runtime: adapter.name,
      native_session_id: native_id,
      ...rest,
    });
  };
  return {
    root,
    source,
    protectionPaths,
    temporaryDirectories,
    store,
    get control() {
      return control;
    },
    restart,
    adapter,
    start,
    resume,
    call,
    project,
    create,
    nativeRecord,
    adopt,
    turns,
    list,
  };
}

/** A session bound to the task before its turn runs, without the checks and the note of one the user opens from the board. */
export function boundTaskSession(
  f: ReturnType<typeof workbenchFixture>,
  leadId: string,
  taskId: string,
  input = 'Build it',
) {
  const opened = f.create(input);
  return f.store.update<Session>(
    'sessions',
    { ...opened, task: { lead_session_id: leadId, id: taskId, generation: 1 } },
    opened.revision,
  );
}

/** Sends every task a lead starts to a task session, which the default path of t1 tasks does not. */
export const dispatchEveryTier = (f: ReturnType<typeof workbenchFixture>) =>
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, path: { t1: 'dispatch' } },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The arguments of each git run made while `run` runs, through a script on PATH that logs them. */
export async function gitRuns(run: () => unknown): Promise<string[]> {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/counting-git-')),
    log = path.join(bin, 'runs.log');
  writeFileSync(log, '');
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quoted(log)}\nexec ${quoted(real)} "$@"\n`,
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    await run();
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } finally {
    process.env.PATH = PATH;
    rmSync(bin, { recursive: true, force: true });
  }
}
