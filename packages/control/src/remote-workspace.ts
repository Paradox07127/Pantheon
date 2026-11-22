import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NATIVE_ENV_ALLOWLIST,
  requireThat,
  type AgentEventSink,
  type Session,
  type SessionSpec,
  type UserTurn,
  type Workspace,
} from '@pantheon/domain';
import type { DeviceStatus } from '@pantheon/protocol';
import type { ControlContext } from './context.js';
import { checkpointRef, globalExcludes, globalExcludesFile } from './checkpoint.js';
import { sshDeviceLink } from './devices.js';
import { runGit } from './git.js';
import { sourceCommitter } from './landing.js';
import { readUserConfig } from './user-config.js';

export interface RemoteSession {
  device: DeviceStatus;
  link: ReturnType<NonNullable<ControlContext['deviceLink']>>;
  /** The device's bare repository, the session's worktree there, its temporary directory and session tools socket. */
  paths: { repo: string; work: string; tmp: string; socket: string };
}

export const onDevice = (session: Session): boolean =>
  session.device_id !== undefined && session.device_id !== 'local';

/** The device a worktree session runs on, as its last probe found it; undefined on this machine. */
function remoteSession(ctx: ControlContext, session: Session): RemoteSession | undefined {
  if (!onDevice(session)) return;
  const id = session.device_id!;
  const device = ctx.devices?.get(id);
  requireThat(
    device?.online,
    'invalid_state',
    `Device ${id} is offline: ${device?.error ?? 'not probed yet'}`,
  );
  requireThat(
    device.runtimes[session.runtime],
    'invalid_state',
    `The last probe of device ${id} found no ${session.runtime} runtime`,
  );
  return deviceWorkspace(ctx, device, readUserConfig(ctx.userConfigDir).devices![id]!.ssh, session);
}

function deviceWorkspace(
  ctx: ControlContext,
  device: DeviceStatus,
  ssh: string,
  session: Session,
): RemoteSession {
  // An online probe always reports the home directory.
  const base = path.posix.join(device.home!, '.pantheon/remote', session.project_id);
  return {
    device,
    link: (ctx.deviceLink ?? sshDeviceLink)(ssh),
    paths: {
      repo: path.posix.join(base, 'repo.git'),
      work: path.posix.join(base, 'w', session.workspace_id!),
      tmp: path.posix.join(base, 'tmp', session.workspace_id!),
      // A socket path has a 104 byte limit on macOS, so it stays off the project's directory.
      socket: path.posix.join(device.home!, '.pantheon/s', `${session.workspace_id!}.sock`),
    },
  };
}

/**
 * The spec the runtime starts with on the device, working in the device's worktree; its session
 * tools reach the relay listening at the local socket.
 */
export function remoteSessionSpec(
  ctx: ControlContext,
  session: Session,
  spec: SessionSpec,
  localSocket?: string,
): SessionSpec {
  const { device, link, paths } = remoteSession(ctx, session)!;
  const metadata = path.posix.join(paths.repo, 'worktrees', session.workspace_id!);
  const deny = (deny: 'read_write' | 'write', targets: string[]) =>
    targets.map((target) => ({ path: target, deny }));
  const forwarded =
    localSocket === undefined ? undefined : link.withSocket(localSocket, paths.socket);
  return {
    ...spec,
    remote: {
      transport: forwarded?.transport ?? link.transport,
      plain_transport: link.transport,
      binary: device.runtimes[session.runtime]!.binary,
      env: { PATH: device.path! },
    },
    cwd: paths.work,
    workspace: { id: spec.workspace!.id, path: paths.work },
    control_instructions: spec.control_instructions?.replaceAll(spec.workspace!.path, paths.work),
    // As on this machine: the worktree commits through the repository's objects and its own metadata folder.
    sandbox: {
      writable_roots: [paths.work, paths.tmp, path.posix.join(paths.repo, 'objects'), metadata],
      protected_entries: [
        ...deny(
          'write',
          ['.claude', '.codex', '.mcp.json'].map((name) => path.posix.join(paths.work, name)),
        ),
        ...deny(
          'write',
          ['config.worktree', 'commondir', 'gitdir'].map((name) => path.posix.join(metadata, name)),
        ),
        // Git commands the sync runs in the worktree must keep reading the repository this file points at.
        ...deny('write', [path.posix.join(paths.work, '.git')]),
      ],
    },
    env: { ...spec.env, TMPDIR: paths.tmp },
    // The daemon's own variables describe this machine, not the device.
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    pantheon_mcp: forwarded && {
      command: 'nc',
      args: ['-U', forwarded.socket],
      env: {},
      ask_tools: spec.pantheon_mcp?.ask_tools,
    },
    native_state_dir: undefined,
    user_config_dir: undefined,
  };
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Git on the device as runGit runs it: no hooks, file monitor, signing or outside configuration. */
const GIT =
  'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c commit.gpgsign=false -c core.autocrlf=false';

const DEVICE_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** Runs a POSIX shell script on the device with the PATH its probe found; `input` is its standard input. */
function deviceRun(remote: RemoteSession, script: string, input?: Buffer): Promise<string> {
  const [command, ...args] = remote.link.transport;
  return new Promise((resolve, reject) => {
    const child = spawn(
      command!,
      [...args, `PATH=${quote(remote.device.path!)}; export PATH\n${script}`],
      { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] },
    );
    // A transport that exits before it reads its input fails through its exit code below.
    child.stdin?.on('error', () => {}).end(input);
    let stdout = '',
      stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `Device command did not finish within ${DEVICE_COMMAND_TIMEOUT_MS / 60_000} minutes`,
        ),
      );
    }, DEVICE_COMMAND_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(stderr.trim().split('\n').at(-1) || `Device command exited with code ${code}`),
        );
    });
  });
}

async function localGit(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  // Git's own ssh gets the agent socket and never prompts, like the transport that runs device commands.
  const result = await runGit(cwd, args, undefined, true, {
    env: {
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=8',
      ...(process.env.SSH_AUTH_SOCK === undefined
        ? {}
        : { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
      ...env,
    },
  });
  if (result.exit_code !== 0)
    throw new Error(result.stderr.toString().trim().split('\n').at(-1) || result.error);
  return result.stdout.toString().trim();
}

/**
 * head and in carry a turn's start to the device, out and out-head bring its files and HEAD back.
 * base and base-head are the files and HEAD the device was last known to hold; local keeps the
 * files of this machine from before a merge that left conflicts.
 */
const SYNC_REFS = ['head', 'in', 'out', 'out-head', 'base', 'base-head', 'local'] as const;
const syncRef = (workspace: Workspace, name: (typeof SYNC_REFS)[number]) =>
  `refs/pantheon/sync/${workspace.id}/${name}`;

/** The commit a local sync ref names; undefined before the first turn has landed on the device. */
async function known(workspace: Workspace, name: 'base'): Promise<string | undefined> {
  const result = await runGit(
    workspace.path,
    ['rev-parse', '-q', '--verify', `${syncRef(workspace, name)}^{commit}`],
    undefined,
    true,
  );
  return result.exit_code === 0 ? result.stdout.toString().trim() : undefined;
}

function deviceSession(ctx: ControlContext, sessionId: string) {
  const session = ctx.store.must<Session>('sessions', sessionId);
  return {
    session,
    remote: remoteSession(ctx, session)!,
    workspace: ctx.store.must<Workspace>('workspaces', session.workspace_id!),
  };
}

// The sessions of a project share its repository on a device, whose init, config and worktree commands collide.
const preparing = new WeakMap<ControlContext, Map<string, Promise<unknown>>>();

/** Creates the device's repository, worktree and temporary directory when they are missing. */
export async function prepareRemoteWorkspace(ctx: ControlContext, session: Session): Promise<void> {
  const { remote } = deviceSession(ctx, session.id);
  let queue = preparing.get(ctx);
  if (!queue) preparing.set(ctx, (queue = new Map()));
  const key = `${remote.device.id}:${remote.paths.repo}`;
  const prepared = (queue.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => prepareDevice(ctx, session));
  queue.set(key, prepared);
  await prepared;
}

async function prepareDevice(ctx: ControlContext, session: Session): Promise<void> {
  const { remote, workspace } = deviceSession(ctx, session.id);
  const { repo, work, tmp, socket } = remote.paths;
  // Without this a device commit carries the device's own git identity into the project's history.
  const committer = await sourceCommitter(workspace.path);
  await deviceRun(
    remote,
    [
      `mkdir -p ${quote(tmp)} ${quote(path.posix.dirname(socket))}`,
      `chmod 700 ${quote(path.posix.dirname(socket))}`,
      // A socket file left by an earlier runtime makes the SSH forward fail to bind.
      `rm -f ${quote(socket)}`,
      `{ [ -d ${quote(repo)} ] || ${GIT} init -q --bare ${quote(repo)}; }`,
      // The device ignores what this machine ignores: its own global excludes file would drop files from the sync.
      `${GIT} -C ${quote(repo)} config core.excludesFile /dev/null`,
      ...(committer
        ? [
            `${GIT} -C ${quote(repo)} config user.name ${quote(committer.name)}`,
            `${GIT} -C ${quote(repo)} config user.email ${quote(committer.email)}`,
          ]
        : []),
    ].join(' && '),
  );
  const head = await localGit(workspace.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
  await localGit(workspace.path, [
    'push',
    '-q',
    `--receive-pack=${GIT} receive-pack`,
    remote.link.gitUrl(repo),
    `+${head}:${syncRef(workspace, 'head')}`,
  ]);
  const created = await deviceRun(
    remote,
    // Pruning drops the record of a worktree directory that was deleted on the device.
    `[ -d ${quote(work)} ] || { ${GIT} -C ${quote(repo)} worktree prune && ${GIT} -C ${quote(repo)} worktree add -q --detach ${quote(work)} ${head} && echo created; }`,
  );
  // A new device worktree holds none of the files the last sync knew: a pull would delete them here.
  if (created.includes('created'))
    for (const name of ['base', 'base-head'] as const)
      await localGit(workspace.path, ['update-ref', '-d', syncRef(workspace, name)]);
}

/**
 * The shell command that gives the device the ignore rules of this machine that no tracked file
 * holds: the repository's own and the user's global ones.
 */
async function excludesOnDevice(workspace: Workspace, repo: string): Promise<string> {
  const own = path.resolve(
    workspace.path,
    await localGit(workspace.path, ['rev-parse', '--git-path', 'info/exclude']),
  );
  // In one file the last matching rule wins: the repository's rules follow the global ones they override.
  const rules = [await globalExcludesFile(), own]
    .filter((file) => file !== undefined && existsSync(file))
    .map((file) => readFileSync(file!, 'utf8'))
    .join('\n');
  return `printf %s ${quote(rules)} > ${quote(path.posix.join(repo, 'info/exclude'))}`;
}

/**
 * Lands the turn's checkpoint, the local files and HEAD, in the device's worktree. Call it after
 * pullRemoteWorkspace: only the paths that differ from the device's last known files are written.
 */
export async function pushRemoteWorkspace(
  ctx: ControlContext,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const { remote, workspace } = deviceSession(ctx, sessionId);
  const { repo, work, tmp } = remote.paths;
  const snapshot = await localGit(workspace.path, [
    'rev-parse',
    '--verify',
    `${checkpointRef(workspace, sessionId, turnId)}^{commit}`,
  ]);
  const head = await localGit(workspace.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const base = await known(workspace, 'base');
  await localGit(workspace.path, [
    'push',
    '-q',
    `--receive-pack=${GIT} receive-pack`,
    remote.link.gitUrl(repo),
    `+${head}:${syncRef(workspace, 'head')}`,
    `+${snapshot}:${syncRef(workspace, 'in')}`,
    ...(base ? [`+${base}:${syncRef(workspace, 'base')}`] : []),
  ]);
  // A new worktree holds its HEAD.
  const from = base ?? 'HEAD';
  await deviceRun(
    remote,
    [
      await excludesOnDevice(workspace, repo),
      `cd ${quote(work)}`,
      `old=$(${GIT} rev-parse --verify HEAD)`,
      `index=${quote(`${tmp}.index`)}`,
      `paths=${quote(`${tmp}.paths`)}`,
      'rm -f "$index"',
      // The two-tree merge leaves a file the device changed since `from` alone, and stops when the
      // snapshot changes that same file. It works in its own index: the real one keeps what is staged.
      `GIT_INDEX_FILE="$index" ${GIT} read-tree ${from}`,
      `{ GIT_INDEX_FILE="$index" ${GIT} update-index -q --refresh >/dev/null || :; }`,
      `GIT_INDEX_FILE="$index" ${GIT} read-tree -u -m ${from} ${snapshot}`,
      // Only the paths the sync wrote or HEAD moved get the index entry of the new HEAD.
      `${GIT} diff-tree -r -z --name-only --no-renames ${from} ${snapshot} > "$paths"`,
      `${GIT} diff-tree -r -z --name-only --no-renames "$old" ${head} >> "$paths"`,
      // xargs may run its command once without paths, which would reset the whole index.
      `xargs -0 sh -c '[ $# -eq 0 ] || ${GIT} --literal-pathspecs reset -q ${head} -- "$@"' sh < "$paths"`,
      `${GIT} reset -q --soft ${head}`,
    ].join(' && '),
  );
  await localGit(workspace.path, ['update-ref', syncRef(workspace, 'base'), snapshot]);
  await localGit(workspace.path, ['update-ref', syncRef(workspace, 'base-head'), head]);
}

function markPull(
  ctx: ControlContext,
  sessionId: string,
  state: NonNullable<Session['remote_pull']>,
  pending: boolean,
): void {
  ctx.store.transaction(() => {
    const session = ctx.store.must<Session>('sessions', sessionId);
    const { remote_pull_pending, ...rest } = session;
    const next = ctx.store.update(
      'sessions',
      { ...rest, ...(pending ? { remote_pull_pending: true } : {}), remote_pull: state },
      session.revision,
    );
    ctx.store.event('session.remote_pull_changed', next, next.project_id, state);
  });
  ctx.changed();
}

/** A commit of the local worktree's files, without ignored ones, on `parent`; the real index stays as it is. */
async function localSnapshot(workspace: Workspace, parent: string): Promise<string> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-sync-'));
  const env = { GIT_INDEX_FILE: path.join(directory, 'index') };
  try {
    await localGit(workspace.path, ['read-tree', 'HEAD'], env);
    await localGit(workspace.path, [...(await globalExcludes()), 'add', '-A'], env);
    const tree = await localGit(workspace.path, ['write-tree'], env);
    return await localGit(workspace.path, [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      'Pantheon workspace sync',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Returns what the user must know about a merge that could not keep both sides whole. */
async function mergeDeviceWorkspace(
  ctx: ControlContext,
  sessionId: string,
): Promise<string | undefined> {
  const { remote, workspace } = deviceSession(ctx, sessionId);
  const base = await known(workspace, 'base');
  if (!base) return;
  const { work, tmp } = remote.paths;
  const ref = (name: (typeof SYNC_REFS)[number]) => syncRef(workspace, name);
  const git = (...args: string[]) => localGit(workspace.path, args);
  await deviceRun(
    remote,
    [
      // A rule this machine got since the last push keeps the device's file of that path out of the pull.
      await excludesOnDevice(workspace, remote.paths.repo),
      `cd ${quote(work)}`,
      `GIT_INDEX_FILE=${quote(`${tmp}.index`)}`,
      'export GIT_INDEX_FILE',
      'rm -f "$GIT_INDEX_FILE"',
      `${GIT} read-tree HEAD`,
      `${GIT} add -A`,
      `tree=$(${GIT} write-tree)`,
      `commit=$(GIT_AUTHOR_NAME=Pantheon GIT_AUTHOR_EMAIL=sync@example.invalid GIT_COMMITTER_NAME=Pantheon GIT_COMMITTER_EMAIL=sync@example.invalid ${GIT} commit-tree "$tree" -p HEAD -m 'Pantheon workspace sync')`,
      `${GIT} update-ref ${ref('out')} "$commit"`,
      `${GIT} update-ref ${ref('out-head')} HEAD`,
    ].join(' && '),
  );
  await git(
    'fetch',
    '-q',
    remote.link.gitUrl(remote.paths.repo),
    `+${ref('out')}:${ref('out')}`,
    `+${ref('out-head')}:${ref('out-head')}`,
  );
  const mine = await localSnapshot(workspace, base);
  const [baseTree, mineTree, theirsTree, baseHead, deviceHead, localHead] = await Promise.all(
    [
      `${base}^{tree}`,
      `${mine}^{tree}`,
      `${ref('out')}^{tree}`,
      ref('base-head'),
      ref('out-head'),
      'HEAD',
    ].map((revision) => git('rev-parse', '--verify', revision)),
  );
  // The files the local worktree gets; undefined when the device changed none since `base`.
  let files: string | undefined,
    conflicts: string[] = [];
  if (theirsTree !== baseTree && mineTree === baseTree) files = theirsTree;
  else if (theirsTree !== baseTree) {
    // Both sides changed files since `base`: a three-way merge of the two file sets.
    const theirs = await git(
      'commit-tree',
      theirsTree!,
      '-p',
      base,
      '-m',
      'Pantheon workspace sync',
    );
    const merge = await runGit(
      workspace.path,
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', mine, theirs],
      undefined,
      true,
    );
    // Exit code 1 is a merge with conflicts: its tree holds the files with conflict markers.
    if (merge.exit_code !== 0 && merge.exit_code !== 1)
      throw new Error(merge.stderr.toString().trim().split('\n').at(-1) || merge.error);
    [files, ...conflicts] = merge.stdout.toString().trim().split('\n');
  }
  const deviceMoved = deviceHead !== baseHead;
  let localMoved = localHead !== baseHead;
  if (conflicts.length) await git('update-ref', ref('local'), mine);
  if (files) {
    // From the snapshot's files, read-tree refuses a path whose file was saved after the snapshot.
    // It works in its own index: the real one keeps what the user staged.
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-sync-'));
    const env = { GIT_INDEX_FILE: path.join(directory, 'index') };
    try {
      await localGit(workspace.path, ['read-tree', mineTree!], env);
      await runGit(workspace.path, ['update-index', '-q', '--refresh'], undefined, true, { env });
      await localGit(workspace.path, ['read-tree', '-u', '-m', mineTree!, files], env);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (deviceMoved && !localMoved)
    await git('update-ref', '--no-deref', 'HEAD', deviceHead!, localHead!).catch(
      async (error: unknown) => {
        // A commit made here since localHead was read stays, as when both sides committed.
        localMoved = (await git('rev-parse', '--verify', 'HEAD')) !== localHead;
        if (!localMoved) throw error;
      },
    );
  // Only the paths the sync wrote or HEAD moved get the index entry of HEAD.
  const changed = [
    ...(files ? [[mineTree!, files]] : []),
    ...(deviceMoved && !localMoved ? [[localHead!, deviceHead!]] : []),
  ];
  // Untrimmed: a path may start or end with a space.
  const untrimmed = async (args: string[], input?: Buffer) => {
    const result = await runGit(workspace.path, args, input, true);
    if (result.exit_code !== 0)
      throw new Error(result.stderr.toString().trim().split('\n').at(-1) || result.error);
    return result.stdout;
  };
  const paths: Buffer[] = [];
  for (const [from, to] of changed)
    paths.push(
      await untrimmed(['diff-tree', '-r', '-z', '--name-only', '--no-renames', from!, to!]),
    );
  // An empty path list would reset the whole index.
  if (Buffer.concat(paths).length)
    await untrimmed(
      ['--literal-pathspecs', 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'],
      Buffer.concat(paths),
    );
  await git('update-ref', ref('base'), ref('out'));
  await git('update-ref', ref('base-head'), deviceHead!);
  const device = remote.device.name;
  return (
    [
      ...(conflicts.length
        ? [
            `This machine and ${device} both changed ${conflicts.join(', ')}. The worktree holds the merge with conflict markers; the files of this machine from before it are at ${ref('local')}.`,
          ]
        : []),
      ...(deviceMoved && localMoved && deviceHead !== localHead
        ? [
            `This machine and ${device} both committed. The worktree keeps the commits of this machine and holds the changes of ${device} uncommitted; its commits are at ${ref('out-head')}.`,
          ]
        : []),
    ].join(' ') || undefined
  );
}

/**
 * Merges the device worktree's files and HEAD into the local worktree; ignored files stay on both
 * sides. Throws after a merge that left conflicts, with the local worktree already updated.
 */
export async function pullRemoteWorkspace(ctx: ControlContext, sessionId: string): Promise<void> {
  const changedAt = () => new Date(ctx.store.now()).toISOString();
  markPull(ctx, sessionId, { status: 'running', changed_at: changedAt() }, true);
  let unresolved: string | undefined;
  try {
    unresolved = await mergeDeviceWorkspace(ctx, sessionId);
  } catch (error) {
    markPull(
      ctx,
      sessionId,
      { status: 'failed', reason: reason(error), changed_at: changedAt() },
      true,
    );
    throw error;
  }
  markPull(
    ctx,
    sessionId,
    unresolved
      ? { status: 'failed', reason: unresolved, changed_at: changedAt() }
      : { status: 'done', changed_at: changedAt() },
    false,
  );
  if (unresolved) throw new Error(unresolved);
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Holds a turn.completed until the device's changes are back, then hands it on with the events
 * that arrived meanwhile in order; a failed pull fails a completed turn.
 */
export function pullingSink(
  ctx: ControlContext,
  sessionId: string,
  sink: AgentEventSink,
): AgentEventSink {
  let waiting = 0,
    chain = Promise.resolve();
  return (event) => {
    if (waiting === 0 && event.kind !== 'turn.completed') return sink(event);
    waiting++;
    chain = chain.then(async () => {
      let delivered = event;
      if (event.kind === 'turn.completed')
        try {
          await pullRemoteWorkspace(ctx, sessionId);
        } catch (error) {
          if (event.status === 'completed')
            delivered = {
              ...event,
              status: 'failed',
              error: `Remote workspace sync failed: ${reason(error)}`,
            };
        }
      waiting--;
      sink(delivered);
    });
    // Shutdown waits for a pull in flight: it writes the local worktree and the store.
    const tracked: Promise<void> = chain.finally(() => ctx.completions.delete(tracked));
    ctx.completions.add(tracked);
  };
}

/** The turn as the runtime gets it: a device session reads its attachments from copies on its device. */
export async function deviceTurn(
  ctx: ControlContext,
  sessionId: string,
  turn: UserTurn,
): Promise<UserTurn> {
  if (!turn.attachments?.length || !onDevice(ctx.store.must<Session>('sessions', sessionId)))
    return turn;
  const { remote } = deviceSession(ctx, sessionId);
  const directory = path.posix.join(remote.paths.tmp, 'attachments');
  const attachments = [];
  for (const attachment of turn.attachments) {
    const copy = path.posix.join(directory, path.basename(attachment.path));
    await deviceRun(
      remote,
      [
        // The runtime can write here: a link it planted is removed, never followed.
        `{ [ ! -L ${quote(directory)} ] || rm ${quote(directory)}; }`,
        `mkdir -p ${quote(directory)}`,
        `rm -f ${quote(copy)}`,
        'set -C',
        `cat > ${quote(copy)}`,
      ].join(' && '),
      readFileSync(attachment.path),
    );
    attachments.push({ ...attachment, path: copy, source: attachment.path });
  }
  return { ...turn, attachments };
}

/** The device session that worked in a worktree, if one did. */
function deviceOwner(ctx: ControlContext, workspace: Workspace): Session | undefined {
  const isOwner = (entry: Session) => entry.workspace_id === workspace.id && onDevice(entry);
  // A deleted session's row may be gone before its worktree is removed; its opening event stays.
  return (
    ctx.store.list<Session>('sessions').find(isOwner) ??
    ctx.store
      .kindEvents(workspace.project_id, ['session.opened'])
      .map((event) => event.payload as Session)
      .find(isOwner)
  );
}

/** Deletes the refs a device session's sync left in the source repository; call it outside a transaction. */
export async function deleteSyncRefs(ctx: ControlContext, workspace: Workspace): Promise<void> {
  if (!deviceOwner(ctx, workspace)) return;
  await runGit(
    workspace.source!,
    ['update-ref', '--stdin'],
    Buffer.from(SYNC_REFS.map((name) => `delete ${syncRef(workspace, name)}\n`).join('')),
    true,
  );
}

/** Deletes the device's copy of a removed worktree and the refs its sync left there. */
export function removeRemoteWorkspace(ctx: ControlContext, workspace: Workspace): void {
  const session = deviceOwner(ctx, workspace);
  if (!session) return;
  ctx.toolRelays.get(session.id)?.();
  ctx.toolRelays.delete(session.id);
  const device = ctx.devices?.get(session.device_id!);
  if (!device?.online) return;
  // Only this machine has no ssh target, and it runs no device session.
  const remote = deviceWorkspace(ctx, device, device.ssh!, session);
  const { repo, work, tmp, socket } = remote.paths;
  const cleanup: Promise<void> = deviceRun(
    remote,
    [
      `rm -rf ${quote(tmp)} ${quote(`${tmp}.index`)} ${quote(`${tmp}.paths`)} ${quote(socket)}`,
      `[ -d ${quote(repo)} ] || exit 0`,
      `${GIT} -C ${quote(repo)} worktree remove --force ${quote(work)}`,
      `${GIT} -C ${quote(repo)} for-each-ref --format='delete %(refname)' refs/pantheon/sync/${workspace.id}/ | ${GIT} -C ${quote(repo)} update-ref --stdin`,
    ].join('\n'),
  )
    // Nothing retries: a device that dropped the connection keeps its copy.
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => ctx.completions.delete(cleanup));
  ctx.completions.add(cleanup);
}
