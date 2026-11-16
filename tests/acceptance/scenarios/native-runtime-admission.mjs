import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { ClaudeAdapter, CodexAdapter } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST } from '@pantheon/domain';
import { PROTOCOL_VERSION } from '@pantheon/protocol';
import { closeDaemon, git, MINUTE, repositoryRoot, watchApprovals } from '../lib/codex-live.mjs';
import { startNativeDaemon } from '../lib/daemon.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import {
  cheapModel,
  createGitProject,
  daemonClient,
  disableUserExtensions,
  eventLog,
  findSecrets,
  installedVersion,
  poll,
  redactedLines,
  replyOf,
} from '../lib/native-live.mjs';

export const title = '两家原生接入与认证自检';
export const mode = 'live';

const RUNTIMES = ['claude', 'codex'];
const SCENARIO_MS = 13 * MINUTE;
const TURN_MS = 6 * MINUTE;
const PROBE_MS = MINUTE;
const MAX_DENIALS_PER_SESSION = 3;
/** A placeholder in the shape of no real key, so the CLI sees an API key channel without a credential. */
const PLACEHOLDER_KEY = 'pantheon-mismatch-placeholder';
/** Agent events that only follow a model request or a native thread start. */
const MODEL_EVENT_KINDS = new Set([
  'session.started',
  'turn.started',
  'message.delta',
  'tool.started',
  'tool.completed',
  'usage.updated',
  'turn.completed',
]);
const prompt = (file) =>
  `Read the file ${file} in the current directory and reply with its exact contents and nothing else. Read only that one file; do not create, change or delete any file and run nothing else.`;

export async function run({ workspace, evidenceDir }) {
  const startedAt = Date.now(),
    deadline = startedAt + SCENARIO_MS;
  const marker = `native-admission-${randomUUID()}`;
  const repo = path.join(workspace, 'project');
  const codexHome = path.join(workspace, 'mismatch', 'codex-home');
  const receipts = [],
    timings = {},
    denials = [],
    processes = new Map(),
    sessions = {},
    observations = { adapters: {}, auth: {} };
  const compatibility = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pantheon_protocol_version: PROTOCOL_VERSION,
  };
  const auth = { effective: {}, mismatch: {} };
  let fixture, endpoint, projectId, adapters, listener, watcher, watchFailure, failure;
  let stopWatch = false;
  const { send, call, get } = daemonClient(() => endpoint, receipts);
  const log = eventLog(get, () => projectId);
  const timed = async (name, step) => {
    const started = Date.now();
    try {
      return await step();
    } finally {
      timings[name] = Date.now() - started;
    }
  };

  /** Opens a session through the adapter's own start, as the daemon does, and closes any it opens. */
  const startProbe = async (adapter, spec) => {
    const emitted = [];
    let handle, error;
    try {
      handle = await adapter.start(spec, (event) => emitted.push(event));
    } catch (caught) {
      error = caught;
    } finally {
      if (handle) await adapter.close(handle, Date.now() + PROBE_MS).catch(() => {});
    }
    return {
      refused_with: error?.code ?? null,
      message: error ? String(error.message) : null,
      opened: Boolean(handle),
      emitted_kinds: emitted.map((event) => event.kind),
      model_request_events: emitted.filter((event) => MODEL_EVENT_KINDS.has(event.kind)).length,
    };
  };
  const probeSpec = (runtime, extra) => ({
    platform_session_id: `mismatch-probe-${runtime}`,
    project_id: 'mismatch-probe',
    runtime,
    device_id: 'local',
    role: 'writer',
    cwd: repo,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: PROBE_MS },
    ...extra,
  });

  try {
    // Versions of both CLIs, the SDK and the protocol, and the adapters' capability reports.
    await timed('versions', async () => {
      compatibility.cli = {
        claude: await installedVersion('claude'),
        codex: await installedVersion('codex'),
      };
      compatibility.sdk = {
        '@anthropic-ai/claude-agent-sdk': JSON.parse(
          await readFile(
            path.join(
              repositoryRoot,
              'packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
            ),
            'utf8',
          ),
        ).version,
      };
      adapters = [
        new ClaudeAdapter('claude', compatibility.cli.claude),
        new CodexAdapter('codex', compatibility.cli.codex),
      ];
      compatibility.adapters = Object.fromEntries(
        adapters.map((adapter) => [
          adapter.name,
          {
            version: adapter.report.version,
            capabilities: Object.fromEntries(
              Object.entries(adapter.report.capabilities).map(([name, row]) => [name, row.status]),
            ),
          },
        ]),
      );
    });
    await createGitProject(repo, {
      'README.md': 'Native runtime admission\n',
      'marker.txt': `${marker}\n`,
    });

    // A billing channel other than the subscription is refused before any model request.
    const requests = [];
    listener = createServer((request, response) => {
      requests.push({ method: request.method, path: request.url });
      request.resume();
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"mismatch probe"}');
    });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${listener.address().port}`;
    await timed('mismatch', async () => {
      auth.mismatch.claude = {
        configured: {
          env: {
            ANTHROPIC_API_KEY: 'placeholder value, not a key',
            ANTHROPIC_BASE_URL: 'a local listener that answers 503',
          },
        },
        ...(await startProbe(
          adapters[0],
          probeSpec('claude', {
            native_state_dir: path.join(workspace, 'mismatch', 'claude-state'),
            env: { ANTHROPIC_API_KEY: PLACEHOLDER_KEY, ANTHROPIC_BASE_URL: base },
          }),
        )),
      };
      // A CODEX_HOME of its own, so the user's ~/.codex stays untouched.
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        path.join(codexHome, 'config.toml'),
        [
          'model_provider = "mismatch-probe"',
          '',
          '[model_providers.mismatch-probe]',
          'name = "Mismatch probe"',
          `base_url = "${base}/v1"`,
          'wire_api = "responses"',
          '',
        ].join('\n'),
      );
      auth.mismatch.codex = {
        configured: {
          config: {
            model_provider: 'mismatch-probe',
            'model_providers.mismatch-probe.base_url': 'a local listener that answers 503',
          },
        },
        ...(await startProbe(adapters[1], probeSpec('codex', { env: { CODEX_HOME: codexHome } }))),
      };
    });
    auth.listener_requests = requests;
    const modelRequests = requests.filter(
      (row) => row.method === 'POST' && /messages|responses|completions/.test(row.path),
    ).length;
    observations.auth.mismatch_refused =
      modelRequests === 0 &&
      RUNTIMES.every(
        (runtime) =>
          auth.mismatch[runtime].refused_with === 'billing_channel_mismatch' &&
          !auth.mismatch[runtime].opened &&
          auth.mismatch[runtime].model_request_events === 0,
      );

    // One real session per runtime reads the marker file and repeats it.
    fixture = await startNativeDaemon(workspace, adapters, { intervalMs: 200 });
    endpoint = fixture.daemon;
    const project = await call('open', 'project.open', {
      name: 'Native runtime admission',
      roots: [repo],
    });
    projectId = project.id;
    compatibility.user_extensions_disabled = await disableUserExtensions({
      get,
      call,
      project,
      runtimes: RUNTIMES,
    });
    compatibility.models = {};
    for (const runtime of RUNTIMES)
      compatibility.models[runtime] = await cheapModel(get, projectId, runtime);
    watcher = watchApprovals({
      projectId,
      get,
      send,
      pullEvents: log.pull,
      events: log.all,
      denials,
      deadline,
      stopped: () => stopWatch,
      fail: (error) => (watchFailure = error),
      maxPerSession: MAX_DENIALS_PER_SESSION,
    });
    for (const runtime of RUNTIMES) {
      const { model, effort } = compatibility.models[runtime];
      const session = await call('session', 'session.create', {
        project_id: projectId,
        runtime,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        permission_mode: 'ask',
        input: prompt('marker.txt'),
      });
      sessions[runtime] = { id: session.id };
    }
    const board = await timed('turns', () =>
      poll(
        async () => {
          if (watchFailure) throw watchFailure;
          const current = await get('board', { project_id: projectId });
          for (const row of current.sessions)
            if (row.process_identity)
              processes.set(`${row.process_identity.pid}:${row.process_identity.start_time_us}`, {
                ...row.process_identity,
              });
          return RUNTIMES.every((runtime) => {
            const turns = current.session_turns.filter(
              (turn) => turn.session_id === sessions[runtime].id,
            );
            return (
              turns.length && turns.every((turn) => !['queued', 'running'].includes(turn.state))
            );
          })
            ? current
            : false;
        },
        'both sessions to end their turn',
        TURN_MS,
        deadline,
      ),
    );
    stopWatch = true;
    await watcher;
    if (watchFailure) throw watchFailure;
    const events = await log.pull();
    for (const runtime of RUNTIMES) {
      const id = sessions[runtime].id;
      const row = board.sessions.find((session) => session.id === id);
      const turn = board.session_turns.find((candidate) => candidate.session_id === id);
      const started = events.filter(
        (event) => event.kind === 'agent.session.started' && event.aggregate_id === id,
      );
      const checked = events.filter(
        (event) => event.kind === 'agent.auth.checked' && event.aggregate_id === id,
      );
      const worktree = board.workspaces.find((candidate) => candidate.id === row?.workspace_id);
      const reply = replyOf(events, turn?.id);
      sessions[runtime] = {
        id,
        native_session_id: row?.native_id ?? null,
        turn_state: turn?.state ?? null,
        turn_delivery_reason: turn?.delivery_reason ?? null,
        reply_has_marker: reply.includes(marker),
        reply: reply.slice(0, 200),
        session_started: started.map((event) => event.payload.native_session_id),
        reported_model: started.at(-1)?.payload.reported_model ?? null,
        worktree_status: worktree
          ? git(worktree.path, 'status', '--porcelain=v1', '--untracked-files=all')
          : null,
        approvals_denied: denials.filter((denial) => denial.session_id === id).length,
      };
      auth.effective[runtime] = checked.map(({ payload }) => ({
        channel: payload.channel,
        method: payload.method,
        ...(payload.plan ? { plan: payload.plan } : {}),
      }));
      observations.adapters[runtime] = {
        actual_session:
          turn?.state === 'completed' &&
          sessions[runtime].reply_has_marker &&
          Boolean(row?.native_id) &&
          started.some((event) => event.payload.native_session_id === row.native_id),
      };
    }
  } catch (error) {
    failure = error;
  } finally {
    stopWatch = true;
    await watcher;
    if (fixture) {
      try {
        await log.pull();
      } catch (error) {
        timings.collection_error = String(error?.message ?? error);
      }
      observations.shutdown = {
        processes_stopped: await closeDaemon({ fixture, processes, timed, timings }),
      };
    }
    if (listener) await new Promise((resolve) => listener.close(resolve));
    timings.total = Date.now() - startedAt;
  }
  const evidence = {
    'compatibility.json': compatibility,
    'redacted-native-events.jsonl': redactedLines(log.all),
    'sessions.json': { sessions, receipts, denials, timings },
  };
  const scan = await findSecrets(evidenceDir, { ...evidence, 'auth-probes.json': auth }, [
    endpoint?.token,
    PLACEHOLDER_KEY,
  ]);
  observations.auth.secret_in_receipts = scan.matches.length > 0;
  evidence['auth-probes.json'] = { ...auth, secret_scan: scan };
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...evidence,
      'failure.txt': String(failure?.stack ?? failure),
      'partial-observations.json': observations,
    });
    throw failure;
  }
  return {
    observations,
    evidence,
    adapters: adapters.map((adapter) => `${adapter.name}@${adapter.report.version}`),
  };
}
