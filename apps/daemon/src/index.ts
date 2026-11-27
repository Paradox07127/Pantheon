import { randomBytes, createHash } from 'node:crypto';
import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  renameSync,
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  unlinkSync,
  linkSync,
  lstatSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import { daemonBuildTime, PANTHEON_VERSION } from '@pantheon/domain/version';
import {
  credentialRole,
  DomainError,
  requireThat,
  type HarnessAdapter,
  type PersonalKey,
  type Principal,
  type ProcessIdentity,
  type Session,
  type Role,
} from '@pantheon/domain';
import {
  PROTOCOL_VERSION,
  querySchemas,
  USER_PRINCIPAL_ID,
  type QueryMethod,
} from '@pantheon/protocol';
import { readProcessIdentity } from '@pantheon/adapters';
import { Store, ArtifactFiles } from '@pantheon/store';
import {
  Control,
  OUTSIDE_PERSONAL_SCOPE,
  PERSONAL_QUERIES,
  personalQuery,
  TraceIndex,
  type ControlOptions,
} from '@pantheon/control';
import { startRuntimeOtel } from './runtime-otel.js';
import { createRuntimeAdapter } from './runtime-registry.js';

// Snapshot at module load so a rebuild on disk cannot change the running daemon's answer.
const buildTime = daemonBuildTime(new URL('../', import.meta.url));
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A schema error as one `path: message` line per issue; the daemon does not depend on zod itself. */
const issueLines = (error: Error): string =>
  (error as Error & { issues: { path: PropertyKey[]; message: string }[] }).issues
    .map((issue) =>
      issue.path.length ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message,
    )
    .join('\n');
const TRACE_SCAN_MS = 2000,
  TRACE_SCAN_BUDGET_MS = 150,
  // File events closer together than this start one scan.
  TRACE_HINT_MS = 300,
  // Leave time between background batches for command delivery and the event stream.
  TRACE_CATCHUP_MS = 250;
// Closing the session revokes its credential sooner.
const SESSION_CREDENTIAL_MS = 24 * 60 * 60 * 1000;
// Milliseconds between heartbeat frames to a subscribed event socket.
const HEARTBEAT_MS = 15_000;
// Milliseconds between checks of whether each runtime is installed and logged in.
const RUNTIME_STATUS_MS = 5 * 60_000;
// The longest the tick waits while the store is unwritten since the last tick began.
const QUIET_TICK_MS = 1000;
// A query holding the event loop longer than this is reported as a diagnostic.
const QUERY_HOLD_MS = 500;
// The longest a session list waits for its worktrees' Git reads, well under the app's 5 s query timeout.
const LIST_READ_WAIT_MS = 1500;
export class AuthRegistry {
  private tokens = new Map<string, Principal>();
  constructor(
    token: string,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens.set(digest(token), { id: USER_PRINCIPAL_ID, role: 'user' });
  }
  add(token: string, principal: Principal): void {
    this.tokens.set(digest(token), principal);
  }
  addDigest(tokenDigest: string, principal: Principal): void {
    this.tokens.set(tokenDigest, principal);
  }
  revokePrincipal(principalId: string): void {
    for (const [key, principal] of this.tokens)
      if (principal.id === principalId) this.tokens.delete(key);
  }
  issueSession(session: Session, role: Role): string {
    requireThat(
      role === credentialRole(session) && session.state !== 'closed',
      'permission_denied',
      'Active session required',
    );
    this.revokeSession(session.id);
    const token = randomBytes(32).toString('base64url');
    this.add(token, {
      id: `session:${session.id}`,
      role,
      session_id: session.id,
      project_id: session.project_id,
      expires_at: this.now() + SESSION_CREDENTIAL_MS,
    });
    return token;
  }
  revokeSession(sessionId: string): void {
    for (const [key, principal] of this.tokens)
      if (principal.session_id === sessionId) this.tokens.delete(key);
  }
  clear(): void {
    this.tokens.clear();
  }
  // Unlike authenticate, does not extend a session credential.
  current(token: string): Principal | undefined {
    const principal = this.tokens.get(digest(token));
    return principal && !(principal.expires_at && principal.expires_at <= this.now())
      ? principal
      : undefined;
  }
  authenticate(header: string | undefined | null): Principal {
    const value = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const key = digest(value);
    const principal = this.current(value);
    if (!principal)
      throw new DomainError('permission_denied', 'Valid connection credentials required');
    if (!principal.session_id) return principal;
    // A session that keeps calling keeps its credential.
    const extended = { ...principal, expires_at: this.now() + SESSION_CREDENTIAL_MS };
    this.tokens.set(key, extended);
    return extended;
  }
}
export interface DaemonOptions {
  terminalSpawn?: ControlOptions['terminalSpawn'];
  directory: string;
  workspaceRoot?: string;
  formerWorkspaceRoots?: string[];
  protectionPaths?: ControlOptions['protectionPaths'];
  adapters: HarnessAdapter[];
  createRuntimeAdapter?: ControlOptions['createRuntimeAdapter'];
  turnSummarizer?: ControlOptions['turnSummarizer'];
  port?: number;
  allowedOrigins?: string[];
  intervalMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  failpoint?: (name: string) => void;
  storeOptions?: ConstructorParameters<typeof Store>[2];
  userConfigDir?: string;
  mcpEntry?: string;
  runtimeStatusMs?: number;
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
/** The starter a reclaim file names still runs: its pid is alive and started when recorded. */
function reclaimHolderAlive(text: string): boolean {
  let holder: Partial<ProcessIdentity> | null;
  try {
    holder = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof holder?.pid !== 'number' || holder.pid <= 0) return false;
  return holder.start_time_us === undefined
    ? processAlive(holder.pid)
    : readProcessIdentity(holder.pid)?.start_time_us === holder.start_time_us;
}
async function acquireLock(socket: string): Promise<net.Server> {
  const open = (): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const server = net.createServer((c) => c.end());
      server.once('error', reject);
      server.listen(socket, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });
  const live = (): Promise<boolean> =>
    new Promise((resolve) => {
      const client = net.createConnection(socket);
      client.setTimeout(500);
      client.once('connect', () => {
        client.destroy();
        resolve(true);
      });
      client.once('error', () => resolve(false));
      client.once('timeout', () => {
        client.destroy();
        resolve(true);
      });
    });
  try {
    return await open();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    const running = new DomainError(
      'daemon_running',
      'This data directory already has an active daemon',
    );
    if (await live()) throw running;
    // Only one starter replaces a stale socket; the file names its pid and start time, so a crashed one's is cleared.
    const reclaim = `${socket}.reclaim`;
    // Linked into place whole, so another starter never reads it without its pid.
    const take = (): void => {
      const staged = `${reclaim}.${process.pid}`;
      writeFileSync(
        staged,
        JSON.stringify(readProcessIdentity(process.pid) ?? { pid: process.pid }),
        { mode: 0o600 },
      );
      try {
        linkSync(staged, reclaim);
      } finally {
        unlinkSync(staged);
      }
    };
    try {
      take();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (reclaimHolderAlive(readFileSync(reclaim, 'utf8'))) throw running;
      unlinkSync(reclaim);
      try {
        take();
      } catch (retry) {
        if ((retry as NodeJS.ErrnoException).code === 'EEXIST') throw running;
        throw retry;
      }
    }
    try {
      if (await live()) throw running;
      if (!lstatSync(socket).isSocket())
        throw new DomainError('invalid_lock', 'Refusing to replace a non-socket lock');
      unlinkSync(socket);
      return await open();
    } finally {
      unlinkSync(reclaim);
    }
  }
}
export async function startDaemon(options: DaemonOptions) {
  const directory = path.resolve(options.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const socket = path.join(directory, 'daemon.lock.sock'),
    lock = await acquireLock(socket);
  let store: Store | undefined;
  let trace: TraceIndex | undefined;
  let acquiredControl: Control | undefined;
  let auth: AuthRegistry | undefined;
  let daemonUrl: string | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let ws: WebSocketServer | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let traceInterval: ReturnType<typeof setInterval> | undefined;
  let runtimeStatusInterval: ReturnType<typeof setInterval> | undefined;
  let traceHint: ReturnType<typeof setTimeout> | undefined;
  let traceScanning: Promise<void> | undefined;
  let closeOtel: (() => Promise<void>) | undefined;
  const watchers: FSWatcher[] = [];
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    clearInterval(traceInterval);
    clearInterval(runtimeStatusInterval);
    clearTimeout(traceHint);
    for (const watcher of watchers) watcher.close();
    try {
      if (ws) {
        for (const client of ws.clients) client.terminate();
        await new Promise<void>((resolve) => ws!.close(() => resolve()));
      }
      await closeOtel?.();
      await acquiredControl?.shutdown();
    } finally {
      auth?.clear();
      try {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      } finally {
        try {
          await traceScanning;
          trace?.close();
          store?.close();
        } finally {
          await new Promise<void>((resolve) => lock.close(() => resolve()));
          for (const name of ['daemon.json', 'user.token'])
            try {
              unlinkSync(path.join(directory, name));
            } catch {}
        }
      }
    }
  }
  try {
    chmodSync(socket, 0o600);
    // A session gets its token as a file path: other same-user processes can read argv and env.
    const sessionTokens = path.join(directory, 'session-tokens');
    rmSync(sessionTokens, { recursive: true, force: true });
    mkdirSync(sessionTokens, { mode: 0o700 });
    const file = path.join(directory, 'control.sqlite');
    const openedStore = (store = new Store(file, options.now, options.storeOptions));
    const token = randomBytes(32).toString('base64url');
    const registry = (auth = new AuthRegistry(token, openedStore.now));
    // Personal keys outlive the daemon, so their folder is kept.
    const personalKeys = path.join(directory, 'personal-keys');
    const keysEntry = lstatSync(personalKeys, { throwIfNoEntry: false });
    requireThat(
      !keysEntry || keysEntry.isDirectory(),
      'invalid_state',
      `Personal key folder is not a directory: ${personalKeys}`,
    );
    mkdirSync(personalKeys, { recursive: true, mode: 0o700 });
    chmodSync(personalKeys, 0o700);
    const personalPrincipal = (keyId: string): Principal => ({
      id: `personal:${keyId}`,
      role: 'personal',
    });
    // A file set aside by a revoke whose commit never happened still names a live row.
    for (const name of readdirSync(personalKeys)) {
      const key =
        name.endsWith('.revoked') &&
        openedStore.get<PersonalKey>('personal_keys', name.slice(0, -'.revoked'.length));
      if (key && key.revoked_at === undefined)
        openedStore.transaction(() => {
          const revoked = openedStore.update(
            'personal_keys',
            { ...key, revoked_at: openedStore.now() },
            key.revision,
          );
          openedStore.event('personal_key.revoked', revoked, '', {});
        });
    }
    const liveKeys = openedStore
      .list<PersonalKey>('personal_keys')
      .filter((key) => key.revoked_at === undefined);
    const liveIds = new Set(liveKeys.map((key) => key.id));
    for (const name of readdirSync(personalKeys))
      if (!liveIds.has(name)) rmSync(path.join(personalKeys, name), { force: true });
    for (const key of liveKeys) registry.addDigest(key.digest, personalPrincipal(key.id));
    const protectionPaths = options.protectionPaths;
    if (protectionPaths)
      trace = new TraceIndex({
        file: path.join(directory, 'trace-cache.sqlite'),
        claudeHomes: [path.join(protectionPaths.home, '.claude')],
        codexHomes: [protectionPaths.codexHome],
        nativeSessionsDir: path.join(directory, 'native-sessions'),
      });
    const control = (acquiredControl = new Control(
      openedStore,
      new ArtifactFiles(path.join(directory, 'artifacts')),
      options.adapters,
      options.failpoint,
      {
        terminalSpawn: options.terminalSpawn,
        workspaceRoot: options.workspaceRoot,
        formerWorkspaceRoots: options.formerWorkspaceRoots,
        protectionPaths: options.protectionPaths,
        trace,
        userConfigDir: options.userConfigDir,
        createRuntimeAdapter: options.createRuntimeAdapter ?? createRuntimeAdapter,
        mcpEntry: options.mcpEntry,
        turnSummarizer: options.turnSummarizer,
        issueSessionCredential: (sessionId, role) => {
          requireThat(daemonUrl, 'daemon_unavailable', 'Daemon address is not ready');
          const session = openedStore.must<Session>('sessions', sessionId);
          const tokenFile = path.join(sessionTokens, sessionId),
            partial = `${tokenFile}.${randomBytes(6).toString('hex')}.tmp`;
          writeFileSync(partial, registry.issueSession(session, role), {
            mode: 0o600,
            flag: 'wx',
          });
          renameSync(partial, tokenFile);
          return { token_file: tokenFile, daemon_url: daemonUrl };
        },
        revokeSessionCredential: (sessionId) => {
          registry.revokeSession(sessionId);
          rmSync(path.join(sessionTokens, sessionId), { force: true });
        },
        issuePersonalKey: (keyId) => {
          const personalToken = randomBytes(32).toString('base64url'),
            tokenDigest = digest(personalToken),
            tokenFile = path.join(personalKeys, keyId),
            partial = `${tokenFile}.${randomBytes(6).toString('hex')}.tmp`;
          writeFileSync(partial, personalToken, { mode: 0o600, flag: 'wx' });
          renameSync(partial, tokenFile);
          registry.addDigest(tokenDigest, personalPrincipal(keyId));
          return { token_file: tokenFile, digest: tokenDigest };
        },
        // Set aside, not deleted, so a revoke that rolls back can put the file back.
        revokePersonalKey: (keyId) => {
          registry.revokePrincipal(personalPrincipal(keyId).id);
          const tokenFile = path.join(personalKeys, keyId);
          // An empty marker stands in for a token file the user already deleted.
          if (existsSync(tokenFile)) renameSync(tokenFile, `${tokenFile}.revoked`);
          else writeFileSync(`${tokenFile}.revoked`, '', { mode: 0o600, flag: 'wx' });
        },
        restorePersonalKey: (keyId, tokenDigest) => {
          registry.addDigest(tokenDigest, personalPrincipal(keyId));
          const tokenFile = path.join(personalKeys, keyId);
          if (statSync(`${tokenFile}.revoked`).size) renameSync(`${tokenFile}.revoked`, tokenFile);
          else unlinkSync(`${tokenFile}.revoked`);
        },
        discardPersonalKey: (keyId) => {
          registry.revokePrincipal(personalPrincipal(keyId).id);
          rmSync(path.join(personalKeys, keyId), { force: true });
        },
        personalKeyFile: (keyId) => {
          requireThat(daemonUrl, 'daemon_unavailable', 'Daemon address is not ready');
          return { token_file: path.join(personalKeys, keyId), daemon_url: daemonUrl };
        },
      },
    ));
    await control.recover();
    const allowedOrigins = new Set(options.allowedOrigins ?? []);
    const app = new Hono<{ Variables: { principal: Principal } }>();
    const originAllowed = (origin: string | null | undefined): boolean =>
      !origin || allowedOrigins.has(origin);
    const requestLimit = bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json({ error: 'payload_too_large', message: 'Request body is larger than 1 MiB' }, 413),
    });
    // Uploads carry their own, larger limit on their route.
    app.use('*', (c, next) => (c.req.path === '/v1/attachments' ? next() : requestLimit(c, next)));
    app.use('*', async (c, next) => {
      if (!originAllowed(c.req.header('origin'))) return c.json({ error: 'origin_denied' }, 403);
      if (c.req.path === '/health') return next();
      const principal = registry.authenticate(c.req.header('authorization'));
      if (principal.session_id) control.sessionPrincipal(principal);
      // A personal principal reaches the command route and its listed queries, no other route.
      if (principal.role === 'personal')
        requireThat(
          (c.req.method === 'POST' && c.req.path === '/v1/commands') ||
            (c.req.method === 'GET' &&
              PERSONAL_QUERIES.some((query) => c.req.path === `/v1/${query}`)),
          'permission_denied',
          OUTSIDE_PERSONAL_SCOPE,
        );
      c.set('principal', principal);
      return next();
    });
    app.onError((error, c) => {
      const stack = error.stack?.split('\n').slice(0, 15).join('\n');
      const body =
        error instanceof DomainError
          ? { error: error.code, message: error.message, details: error.details }
          : error.name === 'ZodError'
            ? { error: 'invalid_input', message: issueLines(error) }
            : { error: 'invalid_request', message: error.message, stack };
      const unexpected = !(error instanceof DomainError) && error.name !== 'ZodError';
      // The desktop app writes the daemon's stderr to daemon.log.
      console.error(
        `${c.req.method} ${c.req.path} failed: ${body.error}: ${JSON.stringify(body.message)}` +
          (unexpected ? `\n${error.stack}` : ''),
      );
      return c.json(
        body,
        error instanceof DomainError && error.code === 'permission_denied'
          ? 403
          : error instanceof DomainError && error.code === 'protocol_mismatch'
            ? 409
            : 400,
      );
    });
    app.notFound((c) =>
      c.json({ error: 'unknown_route', message: `${c.req.method} ${c.req.path}` }, 404),
    );
    app.get('/health', (c) =>
      c.json({
        service: 'pantheon',
        protocol_version: PROTOCOL_VERSION,
        version: PANTHEON_VERSION,
        build_time_ms: buildTime,
        // An upgrade can delete the node this daemon runs, and every child it starts with it.
        ...(existsSync(process.execPath)
          ? {}
          : { restart_required: `The node this daemon runs, ${process.execPath}, is gone.` }),
      }),
    );
    app.get('/v1/capabilities', (c) => c.json([...control.adapters.values()].map((a) => a.report)));
    app.get('/v1/session-principal', (c) => c.json(control.sessionPrincipal(c.get('principal'))));
    app.post('/v1/commands', async (c) =>
      c.json({ receipt: await control.execute(c.get('principal'), await c.req.json()) }),
    );
    app.post(
      '/v1/attachments',
      bodyLimit({
        maxSize: 20 * 1024 * 1024,
        onError: (c) =>
          c.json(
            { error: 'attachment_too_large', message: 'Attachments are limited to 20 MiB' },
            413,
          ),
      }),
      async (c) => {
        const projectId = c.req.query('project_id'),
          name = c.req.query('name');
        requireThat(projectId && name, 'invalid_input', 'project_id and name are required');
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        return c.json(
          control.addAttachment(
            c.get('principal'),
            projectId,
            name,
            c.req.header('content-type') || 'application/octet-stream',
            bytes,
          ),
        );
      },
    );
    app.get('/v1/board', (c) =>
      c.json(control.snapshot(c.get('principal'), c.req.query('project_id'))),
    );
    app.get('/v1/events', (c) => {
      const project = c.req.query('project_id');
      control.snapshotAccess(c.get('principal'), project);
      const after = Number(c.req.query('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new DomainError('invalid_cursor', 'Cursor must be a nonnegative integer');
      const limit = Number(c.req.query('limit') ?? 256);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
        throw new DomainError('invalid_limit', 'Limit must be an integer from 1 to 2000');
      if (after > openedStore.cursor() || after + 1 < openedStore.eventHorizon())
        return c.json({ snapshot_required: true, cursor: openedStore.cursor(), events: [] });
      return c.json({
        events: openedStore.events(after, project, limit, undefined, c.req.query('session_id')),
        cursor: openedStore.cursor(),
      });
    });
    const timed = <T>(query: string, read: () => T): T => {
      const started = performance.now();
      try {
        return read();
      } finally {
        const held = Math.round(performance.now() - started);
        if (held > QUERY_HOLD_MS)
          control.emit(
            'diagnostic',
            new Error(`Query ${query} held the event loop for ${held} ms`),
          );
      }
    };
    // The answer waits for the reads at most LIST_READ_WAIT_MS; reads that land later emit an event.
    const prefetch = async (p: Principal, projectId?: string): Promise<void> => {
      // A personal principal starts no worktree prefetch.
      if (p.role === 'personal') return;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        control
          .prefetchWorktreeReads(p, projectId)
          .catch((error) => control.emit('diagnostic', error)),
        new Promise<void>((resolve) => (deadline = setTimeout(resolve, LIST_READ_WAIT_MS))),
      ]);
      clearTimeout(deadline);
    };
    const withRuntimeDeadline = async <T>(read: Promise<T>, error: DomainError): Promise<T> => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          read,
          new Promise<never>((_resolve, reject) => {
            // Claude discovery may take ten seconds; leave it time to finish.
            deadline = setTimeout(() => reject(error), 12_000);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    };
    const queries: {
      [M in QueryMethod]: (
        principal: Principal,
        input: ReturnType<(typeof querySchemas)[M]['parse']>,
      ) => unknown;
    } = {
      'memory.read': (p, i) => control.memoryRead(p, i.project_id, i),
      'memory.item': (p, i) => control.memoryItem(p, i.project_id, i.memory_id),
      'memory.graph': (p, i) => control.memoryGraph(p, i),
      'memory.turn': (p, i) => control.memoryTurn(p, i.session_id, i.turn_id),
      'memory.session_turns': (p, i) => control.memorySessionTurns(p, i.session_id),
      'memory.recent': (p, i) => control.memoryRecent(p, i.project_id, i.limit),
      'memory.document': (p, i) => control.memoryDocument(p, i.project_id),
      'project.read': (p, i) => control.projectRead(p, i.project_id),
      'project.overlap': (p, i) => control.projectOverlap(p, i.project_id),
      'session.thread': (p, i) => control.sessionThread(p, i.session_id),
      'project.usage.daily': (p, i) =>
        control.projectUsageDaily(p, i.project_id, i.days, i.timezone),
      'project.usage.read': (p, i) => control.projectUsageRead(p, i.project_id),
      'workflow.policy': (p, i) => control.workflowPolicy(p, i.project_id),
      'project.review.metrics': (p, i) => control.projectReviewMetrics(p, i.project_id),
      'project.intro.read': (p, i) => control.projectIntroRead(p, i.project_id),
      'project.baseline.read': (p, i) => control.projectBaselineRead(p, i.project_id),
      'project.environment.checks': (p, i) => control.environmentChecks(p, i),
      'project.landing.read': (p, i) => control.landingRead(p, i.landing_id),
      'project.landing.find': (p, i) => control.landingFind(p, i.root, i.branch),
      'project.facts.read': (p, i) => control.projectFactsRead(p, i.project_id),
      'change_story.list': (p, i) => control.changeStoryList(p, i.project_id),
      'change_story.diff': (p, i) => control.changeStoryDiff(p, i.story_id),
      'session.search': (p, i) => control.sessionSearch(p, i),
      'session.list': async (p, i) => {
        await prefetch(p, i.project_id);
        return timed('session.list', () => control.sessionList(p, i.project_id, 'cached'));
      },
      'session.diff': (p, i) => control.sessionDiff(p, i.session_id),
      'session.turn_diff': (p, i) => control.sessionTurnDiff(p, i.session_id, i.turn_id),
      'session.gates': (p, i) => control.sessionGates(p, i.session_id),
      'session.tasks': (p, i) => control.sessionTasks(p, i.session_id),
      'session.gates.history': (p, i) => control.sessionGatesHistory(p, i.session_id, i.limit),
      'project.gates.history': (p, i) =>
        control.projectGatesHistory(p, i.project_id, i.limit, i.since),
      'project.timeline': (p, i) => control.projectTimeline(p, i.project_id, i.since),
      'project.trace': (p, i) => control.projectTrace(p, i.project_id, i.from, i.to, i.bucket_ms),
      'session.trace': (p, i) => control.sessionTrace(p, i.project_id, i.lane_key, i.turn),
      'session.step_diff': (p, i) => control.sessionStepDiff(p, i.session_id, i.turn_id, i.span_id),
      'project.collab': (p, i) => control.projectCollab(p, i.project_id, i.since, i.until),
      'tool.calls': (p, i) => control.toolCalls(p, i.project_id, i.command, i.limit),
      'project.trace.stats': (p, i) => control.projectTraceStats(p, i.project_id, i.since, i.until),
      'trace.time': (p, i) => control.traceTime(p, i.project_id, i.lane_key, i.from, i.to),
      'project.heatmap': (p, i) => control.projectHeatmap(p, i.project_id, i.days),
      'session.preflight': (p, i) => control.sessionPreflight(p, i.session_id),
      'session.activity': (p, i) => control.sessionToolActivity(p, i.session_id),
      'session.reviews': (p, i) => control.sessionReviews(p, i.session_id),
      'review.read': (p, i) => control.reviewRead(p, i.review_id),
      'session.comments': (p, i) => control.sessionComments(p, i.session_id),
      'needs_you.list': async (p, i) => {
        await prefetch(p, i.project_id);
        return timed('needs_you.list', () => control.needsYou(p, i.project_id));
      },
      'projects.summary': async (p) => {
        await prefetch(p);
        return timed('projects.summary', () => control.projectsSummary(p, 'cached'));
      },
      'project.brief': (p, i) => control.projectBrief(p, i.project_id, i.since),
      'project.changes': async (p, i) => {
        await prefetch(p, i.project_id);
        return timed('project.changes', () => control.projectChanges(p, i.project_id));
      },
      'project.plan.history': (p, i) => control.projectPlanHistory(p, i.project_id, i.limit),
      'project.status.read': (p, i) => control.projectStatusRead(p, i),
      'project.landings.read': (p, i) => control.projectLandingsRead(p, i),
      'project.landings.compare': (p, i) =>
        control.projectLandingsCompare(p, i.project_id, i.proposal_id, i.count),
      'project.resident': (p, i) => control.projectResident(p, i.project_id),
      'project.setting_proposals': (p, i) => control.projectSettingProposals(p, i.project_id),
      'project.plan': async (p, i) => {
        await prefetch(p, i.project_id);
        return timed('project.plan', () => control.projectPlan(p, i.project_id));
      },
      'project.decisions': (p, i) => control.decisionsForUser(p, i.project_id, i.since),
      'extensions.inventory': (p, i) =>
        withRuntimeDeadline(
          control.extensionsInventory(p, i.project_id, i.runtime),
          new DomainError('inventory_timeout', 'Extension inventory exceeded 12 seconds'),
        ),
      'runtime.models': (p, i) =>
        withRuntimeDeadline(
          control.runtimeModels(p, i.project_id, i.runtime),
          new DomainError('models_timeout', 'Model list exceeded 12 seconds'),
        ),
      'permission.rules': (p, i) => control.permissionRules(p, i.project_id),
      'repo.working_diff': (p, i) => control.repoWorkingDiff(p, i.project_id),
      'repo.log': (p, i) => control.repoLog(p, i),
      'repo.commit_diff': (p, i) => control.repoCommitDiff(p, i.project_id, i.sha),
      'repo.compare': (p, i) => control.repoCompare(p, i.project_id, i.base, i.head),
      'repo.commit_after': (p, i) => control.repoCommitAfter(p, i),
      'repo.blame': (p, i) => control.repoBlame(p, i),
      'repo.file_history': (p, i) => control.repoFileHistory(p, i),
      'project.branches': (p, i) => control.projectBranches(p, i.project_id, i.root),
      'workspace.stale': (p, i) => control.workspaceStale(p, i.project_id),
      'project.head': (p, i) => control.projectHead(p, i.project_id),
      'session.create.preview': (p, i) => control.sessionCreatePreview(p, i),
      'files.search': (p, i) => control.filesSearch(p, i.project_id, i.session_id, i.q),
      'files.list': (p, i) => control.filesList(p, i.project_id, i.session_id, i.path),
      'files.read': (p, i) => control.filesRead(p, i.project_id, i.session_id, i.path),
      'session.tool_image': (p, i) => control.sessionToolImage(p, i.session_id, i.hash),
      'symbols.search': (p, i) => control.symbolsSearch(p, i.project_id, i.session_id, i.q),
      'runtime.status': (p, i) => control.runtimeStatus(p, i.refresh),
      'mcp.status': (p, i) => control.mcpStatus(p, i),
      'session.mcp_servers': (p, i) => control.sessionMcpServers(p, i.session_id),
      'mcp.app.resource': (p, i) => control.mcpAppResource(p, i),
      'github.items': (p, i) => control.githubItems(p, i.project_id, i.kind),
      'github.pr.detail': (p, i) => control.githubPullDetail(p, i.project_id, i.number),
      'connections.status': (p, i) => control.connectionsStatus(p, i.refresh),
      'device.list': (p, i) => control.listDevices(p, i.refresh),
      'device.probe': (p, i) => control.reprobeDevice(p, i.id),
      'device.ssh_hosts': (p) => control.sshHosts(p),
      'app.settings': (p) => control.appSettings(p),
      'project.defaults': (p) => control.projectDefaults(p),
      'backend.list': (p) => control.backendList(p),
      'personal.key.list': (p) => control.personalKeyList(p),
      'import.candidates': (p) => control.importCandidates(p),
      'session.importable': (p, i) => control.importableSessions(p, i.project_id),
    };
    // Must stay after the explicit GET /v1/* routes; registered first, it would answer them with 404.
    app.get('/v1/:method', async (c) => {
      const method = c.req.param('method');
      if (!Object.hasOwn(querySchemas, method)) return c.notFound();
      const query = method as QueryMethod;
      personalQuery(c.get('principal'), query);
      const params: Record<string, string | string[]> = c.req.query();
      if (query === 'memory.read' || query === 'memory.graph') {
        const tags = c.req.queries('tag');
        if (tags) params.tag = tags;
      }
      if (query === 'memory.graph') {
        const kinds = c.req.queries('kind');
        if (kinds) params.kind = kinds;
      }
      const input = querySchemas[query].parse(params);
      return c.json(await timed(query, () => queries[query](c.get('principal'), input as never)));
    });
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port ?? 0 });
    await new Promise<void>((resolve, reject) => {
      if (server!.listening) resolve();
      else server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const port = (server.address() as net.AddressInfo).port;
    const sockets = (ws = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }));
    server.on('upgrade', (req, socket, head) => {
      const terminal = /^\/v1\/terminals\/([^/]+)\/ws$/.exec(req.url ?? '');
      if ((!terminal && req.url !== '/v1/events/ws') || !originAllowed(req.headers.origin)) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(req, socket, head, (client) =>
        sockets.emit('connection', client, terminal?.[1]),
      );
    });
    sockets.on('connection', (client: WebSocket, terminalId?: string) => {
      if (terminalId) {
        let detach: (() => void) | undefined;
        let credential = '';
        const timeout = setTimeout(() => client.close(1008, 'Authenticate first'), 5000);
        client.on('error', (error) => {
          control.emit('diagnostic', error);
          client.terminate();
        });
        client.on('message', (bytes) => {
          try {
            if (detach) throw new Error('Already subscribed');
            const input = JSON.parse(String(bytes)) as { token: string };
            const principal = registry.authenticate(`Bearer ${input.token}`);
            requireThat(principal.role !== 'personal', 'permission_denied', OUTSIDE_PERSONAL_SCOPE);
            credential = input.token;
            detach = control.terminalSubscribe(principal, terminalId, (frame) => {
              if (client.readyState !== WebSocket.OPEN) return;
              if (!registry.current(credential)) {
                client.close(1008, 'Authorization expired or revoked');
                return;
              }
              if (Buffer.isBuffer(frame)) client.send(frame);
              else {
                client.send(JSON.stringify(frame));
                client.close(1000);
              }
            });
            clearTimeout(timeout);
          } catch {
            client.close(1008, 'Invalid subscription');
          }
        });
        const poll = setInterval(() => {
          if (detach && !registry.current(credential))
            client.close(1008, 'Authorization expired or revoked');
        }, 250);
        client.on('close', () => {
          clearTimeout(timeout);
          clearInterval(poll);
          detach?.();
        });
        return;
      }
      let project: string | undefined,
        principal: Principal | undefined,
        credential = '',
        cursor = 0,
        heartbeat: ReturnType<typeof setInterval> | undefined,
        detachBrowser: (() => void) | undefined;
      const timeout = setTimeout(() => client.close(1008, 'Authenticate first'), 5000);
      client.on('error', (error) => {
        control.emit('diagnostic', error);
        client.terminate();
      });
      const pump = (): void => {
        if (!principal || client.readyState !== WebSocket.OPEN) return;
        try {
          const current = registry.current(credential);
          if (!current) throw new Error('Credential revoked');
          control.snapshotAccess(current, project);
          if (client.bufferedAmount > 1024 * 1024) {
            client.close(1013, 'Replay from last cursor');
            return;
          }
          const events = openedStore.events(cursor, project);
          for (const event of events) {
            client.send(JSON.stringify({ type: 'event', event }));
            cursor = event.sequence;
          }
        } catch {
          client.close(1008, 'Authorization expired or revoked');
        }
      };
      client.on('message', (bytes) => {
        try {
          if (principal) throw new Error('Already subscribed');
          const input = JSON.parse(String(bytes)) as {
            token: string;
            project_id?: string;
            cursor?: number;
            browser?: boolean;
          };
          principal = registry.authenticate(`Bearer ${input.token}`);
          requireThat(principal.role !== 'personal', 'permission_denied', OUTSIDE_PERSONAL_SCOPE);
          credential = input.token;
          project = input.project_id;
          cursor = input.cursor ?? 0;
          if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid cursor');
          control.snapshotAccess(principal, project);
          clearTimeout(timeout);
          if (cursor > openedStore.cursor() || cursor + 1 < openedStore.eventHorizon()) {
            client.send(
              JSON.stringify({ type: 'snapshot_required', cursor: openedStore.cursor() }),
            );
            client.close(1000);
            return;
          }
          client.send(JSON.stringify({ type: 'subscribed', cursor }));
          if (input.browser === true && principal.role === 'user' && !principal.session_id)
            detachBrowser = control.browser.attach((request) =>
              client.send(JSON.stringify({ type: 'browser.request', request })),
            );
          heartbeat = setInterval(() => {
            if (client.readyState === WebSocket.OPEN)
              client.send(JSON.stringify({ type: 'heartbeat', cursor }));
          }, options.heartbeatMs ?? HEARTBEAT_MS);
          pump();
        } catch {
          client.close(1008, 'Invalid subscription');
        }
      });
      const traced = (revision: number): void => {
        if (!principal || client.readyState !== WebSocket.OPEN) return;
        if (registry.current(credential))
          client.send(JSON.stringify({ type: 'trace.changed', revision }));
        else client.close(1008, 'Authorization expired or revoked');
      };
      control.on('events', pump);
      control.on('trace', traced);
      const poll = setInterval(pump, 250);
      client.on('close', () => {
        clearTimeout(timeout);
        clearInterval(poll);
        clearInterval(heartbeat);
        control.off('events', pump);
        control.off('trace', traced);
        detachBrowser?.();
      });
    });
    const manifest = {
      protocol_version: PROTOCOL_VERSION,
      pid: process.pid,
      started_at: new Date().toISOString(),
      url: `http://127.0.0.1:${port}`,
      token_file: path.join(directory, 'user.token'),
    };
    daemonUrl = manifest.url;
    writeFileSync(manifest.token_file, token, { mode: 0o600 });
    chmodSync(manifest.token_file, 0o600);
    writeFileSync(path.join(directory, 'daemon.json'), JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
    });
    await control.reconcile();
    const otlp = process.env.PANTHEON_OTLP_HTTP_ENDPOINT;
    if (otlp) {
      try {
        closeOtel = startRuntimeOtel(openedStore, otlp, (error) =>
          control.emit('diagnostic', error),
        );
      } catch {
        control.emit('diagnostic', new Error('Invalid PANTHEON_OTLP_HTTP_ENDPOINT'));
      }
    }
    // total_changes counts this connection's writes, which are all of the store's writes.
    const totalChanges = openedStore.db.prepare('SELECT total_changes() AS n');
    let ticked: { changes: number; at: number } | undefined;
    // A beat during a tick would only find it busy, so it leaves the start mark alone.
    let ticking = false;
    // The control announced a change that may be in memory alone; a tick announces at its own end.
    let announced = false;
    control.on('events', () => {
      if (!ticking) announced = true;
    });
    interval = setInterval(() => {
      if (ticking) return;
      const changes = Number(totalChanges.get()!.n),
        at = Date.now();
      if (!announced && ticked?.changes === changes && at - ticked.at < QUIET_TICK_MS) return;
      announced = false;
      ticked = { changes, at };
      ticking = true;
      void control
        .tick()
        .catch((error) => control.emit('diagnostic', error))
        .finally(() => {
          ticking = false;
        });
    }, options.intervalMs ?? 50);
    const refreshRuntimeStatus = (): void => {
      void control.refreshRuntimeStatus().catch((error) => control.emit('diagnostic', error));
      void control.refreshDevices().catch((error) => control.emit('diagnostic', error));
    };
    refreshRuntimeStatus();
    runtimeStatusInterval = setInterval(
      refreshRuntimeStatus,
      options.runtimeStatusMs ?? RUNTIME_STATUS_MS,
    );
    if (protectionPaths) {
      const traceScan = (): void => {
        if (closed || traceScanning) return;
        traceScanning = control
          .traceScan(TRACE_SCAN_BUDGET_MS)
          .then((progress) => {
            if (progress && progress.done_files < progress.total_files)
              traceHint ??= setTimeout(() => {
                traceHint = undefined;
                traceScan();
              }, TRACE_CATCHUP_MS);
          })
          .catch((error) => {
            control.emit('diagnostic', error);
          })
          .finally(() => {
            traceScanning = undefined;
          });
      };
      traceInterval = setInterval(traceScan, TRACE_SCAN_MS);
      // File events are only hints; the interval still finds what a watcher misses.
      for (const dir of [
        path.join(protectionPaths.home, '.claude', 'projects'),
        path.join(protectionPaths.codexHome, 'sessions'),
        path.join(directory, 'native-sessions'),
      ])
        try {
          const watcher = watch(dir, { recursive: true }, () => {
            traceHint ??= setTimeout(() => {
              traceHint = undefined;
              traceScan();
            }, TRACE_HINT_MS);
          });
          watcher.on('error', () => watcher.close());
          watchers.push(watcher);
        } catch {}
    }
    return {
      control,
      store: openedStore,
      auth: registry,
      url: manifest.url,
      token,
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
