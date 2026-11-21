import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { versionOf } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST } from '@pantheon/domain';
import { startNativeDaemon } from '../../acceptance/lib/daemon.mjs';
import { materialize } from './check.mjs';

const busy = (turn) => ['queued', 'running'].includes(turn.state);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const POLL_MS = 500;
// The runtime's own limit on a title turn, and a margin.
const TITLE_WAIT_MS = 35000;

// The first turn of the native session that the adopted condition imports; the task needs nothing from it.
const OPENER = 'Reply with the single word ready.';

/** Runs `codex exec --json` on the input in cwd, as a user would from a shell, with its output in logs. */
async function codexExec(binary, cwd, input, logs, name, timeoutMs) {
  const stdout = fs.openSync(path.join(logs, `${name}.jsonl`), 'w');
  const stderr = fs.openSync(path.join(logs, `${name}.stderr.log`), 'w');
  const started = Date.now();
  const child = spawn(binary, ['exec', '--json', input], {
    cwd,
    stdio: ['ignore', stdout, stderr],
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  const events = fs
    .readFileSync(path.join(logs, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const failed = events.find((event) => event.type === 'turn.failed' || event.type === 'error');
  return {
    thread: events.find((event) => event.type === 'thread.started')?.thread_id,
    settled: events.some(
      (event) => event.type === 'turn.completed' || event.type === 'turn.failed',
    ),
    error: failed
      ? JSON.stringify(failed.error ?? failed.message ?? failed)
      : code
        ? `exit ${code}`
        : null,
    wall_ms: Date.now() - started,
  };
}

/** The Codex transcripts written since `since` whose thread started in one of the folders. */
function rollouts(folders, since) {
  const root = path.join(codexHome, 'sessions');
  const names = new Set([...folders, ...folders.map((folder) => fs.realpathSync(folder))]);
  return fs
    .readdirSync(root, { recursive: true })
    .filter((name) => /^rollout-.*\.jsonl$/.test(path.basename(name)))
    .map((name) => path.join(root, name))
    .filter((file) => fs.statSync(file).mtimeMs >= since)
    .map((file) => ({
      file,
      lines: fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    }))
    .filter(({ lines }) => names.has(lines[0]?.payload?.cwd));
}

const TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

/**
 * What the goal's turn did and cost, read from the runtime's own transcripts of the folders: the
 * thread the session ran in, and the threads it spawned there (approval reviews, subagents).
 */
function nativeTurn(threads, goal, checkouts) {
  const main = threads.filter(({ lines }) => typeof lines[0].payload.source === 'string');
  if (main.length !== 1) return { error: `${main.length} native threads in the folders` };
  const { lines } = main[0];
  const asked = lines.findLastIndex(
    (line) => line.type === 'event_msg' && line.payload.item?.type === 'UserMessage',
  );
  const message = lines[asked]?.payload;
  if (!message) return { error: 'no user message in the native thread' };
  const text = message.item.content.map((part) => part.text ?? '').join('');
  if (text === OPENER)
    return {
      native_session_id: lines[0].payload.id,
      error: 'the goal never reached the native thread',
    };
  const turnId = message.turn_id;
  const usage = lines
    .filter((line) => line.type === 'token_usage_record' && line.payload.turn_id === turnId)
    .map((line) => line.payload.usage);
  const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
  const calls = lines
    .slice(asked)
    .filter((line) => line.type === 'response_item' && TOOL_CALLS.has(line.payload.type));
  const spawned = threads
    .filter((thread) => thread !== main[0])
    .flatMap(({ lines: own }) =>
      own.filter((line) => line.type === 'token_usage_record').map((line) => line.payload.usage),
    );
  return {
    native_session_id: lines[0].payload.id,
    model: lines.findLast((line) => line.type === 'turn_context')?.payload.model ?? null,
    // false: what reached the model as the user's message is not the goal as written.
    goal_verbatim: text === goal,
    tool_calls: calls.length,
    model_requests: usage.length,
    input_tokens: sum(usage, 'input_tokens'),
    cached_input_tokens: sum(usage, 'cached_input_tokens'),
    output_tokens: sum(usage, 'output_tokens'),
    spawned_threads: threads.length - 1,
    spawned_input_tokens: sum(spawned, 'input_tokens'),
    native_ms:
      lines.find(
        (line) => line.payload?.type === 'task_complete' && line.payload.turn_id === turnId,
      )?.payload.duration_ms ?? null,
    read_checkout: calls.some((line) =>
      checkouts.some((checkout) => JSON.stringify(line.payload).includes(checkout)),
    ),
  };
}

/** Whether the hidden check passes on what the session left in tree, committed or not; writes its output and the diff to logs. */
function hiddenOnTree(spec, repo, tree, base) {
  const index = path.join(spec.workspace, 'snapshot-index');
  const indexed = { ...env, GIT_INDEX_FILE: index };
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: tree, env: indexed });
  execFileSync('git', ['add', '-A'], { cwd: tree, env: indexed });
  const snapshot = execFileSync('git', ['write-tree'], {
    cwd: tree,
    env: indexed,
    encoding: 'utf8',
  }).trim();
  fs.rmSync(index);
  if (snapshot === base) return { changed: false, hidden_passed: null, hidden_unstable: null };
  fs.writeFileSync(path.join(spec.logs, 'diff.patch'), git(repo, 'diff', base, snapshot));
  const hidden = () => {
    const dir = fs.mkdtempSync(path.join(spec.workspace, 'hidden-tree-'));
    materialize(repo, snapshot, dir);
    const result = spec.hiddenCheck(dir);
    fs.writeFileSync(path.join(spec.logs, 'hidden.log'), result.output);
    return result.ok;
  };
  const first = hidden();
  const passed = first || hidden();
  return { changed: true, hidden_passed: passed, hidden_unstable: first !== passed };
}

/** A bare session of a fixture runtime: the adapter alone in the repository, outside the daemon. */
async function adapterRun(spec, repo, adapter) {
  const events = [];
  let ended;
  const end = new Promise((resolve) => (ended = resolve));
  const handle = await adapter.start(
    {
      platform_session_id: 'bare',
      project_id: 'bare',
      runtime: adapter.name,
      device_id: 'local',
      role: 'writer',
      cwd: repo,
      env_allowlist: NATIVE_ENV_ALLOWLIST,
      skills: [],
      mcp_servers: [],
      budget: { max_turns: 1, wall_time_ms: spec.settleMs },
      permission_mode: 'auto_edit',
    },
    (event) => {
      events.push(event);
      if (event.kind === 'turn.completed') ended();
    },
  );
  const started = Date.now();
  try {
    await adapter.send(handle, { turn_id: 'bare-turn', input: spec.goal });
    await end;
  } finally {
    await adapter.close(handle, Date.now() + 10000);
  }
  const completed = events.find((event) => event.kind === 'turn.completed');
  return {
    tree: repo,
    settled: completed?.error_code !== 'turn_deadline',
    turn_error: completed?.status === 'failed' ? completed.error : null,
    task_turns: 1,
    approvals: 0,
    wall_ms: Date.now() - started,
  };
}

/**
 * A session inside a fresh daemon on its own data directory and home: a worktree session the
 * user creates with the goal (plain), or the bare opener's native session adopted in the
 * repository and sent the goal (adopted).
 */
async function pantheonRun(spec, repo, opener) {
  const home = path.join(spec.workspace, 'home');
  fs.mkdirSync(home);
  if (opener) {
    // The daemon indexes native sessions from its home; only the opener's transcript is put there.
    const { file } = rollouts([repo], opener.since).find(
      ({ lines }) => lines[0].payload.id === opener.thread,
    );
    const target = path.join(home, '.codex', path.relative(codexHome, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  const fixture = await startNativeDaemon(spec.workspace, spec.adapters, { intervalMs: 50, home });
  const { daemon } = fixture;
  const get = async (method, params) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const poll = async (check, description) => {
    for (const deadline = Date.now() + spec.settleMs; ; await delay(POLL_MS)) {
      const result = await check();
      if (result) return result;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    }
  };
  try {
    const project = await fixture.call('project.open', { name: 'Evaluation run', roots: [repo] });
    const params = { project_id: project.id };
    let session, started;
    if (opener) {
      await poll(
        async () =>
          (await get('session.importable', params)).some(
            (row) => row.native_session_id === opener.thread,
          ),
        'the opener to be importable',
      );
      session = await fixture.call('session.adopt', {
        project_id: project.id,
        runtime: spec.runtime,
        native_session_id: opener.thread,
      });
      const idle = await poll(async () => {
        const row = (await get('board', params)).sessions.find((one) => one.id === session.id);
        return row?.state === 'open' && row;
      }, 'the adopted session to open');
      started = Date.now();
      await fixture.call(
        'session.send',
        { session_id: session.id, input: spec.goal },
        idle.revision,
      );
    } else {
      started = Date.now();
      session = await fixture.call('session.create', {
        project_id: project.id,
        runtime: spec.runtime,
        input: spec.goal,
      });
    }
    // Nobody sits at the session: the run approves each permission request in the user's place and counts it.
    let approvals = 0,
      after = 0,
      settled = false,
      turns = [],
      wall,
      title = null,
      renamed;
    // The runtime's error of each failed turn, by turn id.
    const failures = new Map();
    // A plain session's runtime names it after the turn ends; closing the daemon earlier cuts that off.
    for (
      const deadline = started + spec.settleMs;
      settled
        ? !opener && !renamed && Date.now() < started + wall + TITLE_WAIT_MS
        : Date.now() < deadline;
    ) {
      await delay(POLL_MS);
      for (
        let page;
        (page = await get('events', { after: String(after), ...params })).events.length;
      ) {
        after = page.events.at(-1).sequence;
        for (const { kind, payload, aggregate_id } of page.events)
          if (kind === 'turn.failed') failures.set(aggregate_id, payload.error);
          else if (
            kind === 'session.renamed' &&
            aggregate_id === session.id &&
            payload.source === 'auto'
          ) {
            title = payload.title;
            renamed = Date.now();
          } else if (
            kind === 'approval.requested' &&
            payload.kind === 'permission' &&
            payload.session_id === session.id
          ) {
            await fixture.call(
              'approval.respond',
              { approval_id: payload.id, decision: 'approve_session' },
              payload.revision,
            );
            approvals += 1;
          }
      }
      if (settled) continue;
      turns = (await get('board', params)).session_turns.filter(
        (turn) => turn.session_id === session.id,
      );
      if (turns.length && !turns.some(busy)) {
        settled = true;
        wall = Date.now() - started;
      }
    }
    wall ??= Date.now() - started;
    // The plain session's worktree is the one linked worktree of the repository.
    const tree = opener
      ? repo
      : git(repo, 'worktree', 'list', '--porcelain')
          .split('\n')
          .filter((line) => line.startsWith('worktree '))
          .map((line) => line.slice('worktree '.length))
          .find((dir) => fs.realpathSync(dir) !== fs.realpathSync(repo));
    return {
      tree,
      settled,
      turn_error: failures.get(turns.findLast((turn) => turn.state === 'failed')?.id) ?? null,
      task_turns: turns.length,
      approvals,
      wall_ms: wall,
      title,
      title_ms: renamed === undefined ? null : Math.max(0, renamed - started - wall),
    };
  } finally {
    await fixture.close();
  }
}

/**
 * One run: a fresh repository at `<workspace>/repo`, one session on the goal under the
 * condition, then the hidden check on what the session left in its folder. A Codex run reads
 * what the turn did and cost from Codex's own transcripts, the same way in every condition.
 */
export async function runOne(spec) {
  const repo = path.join(spec.workspace, 'repo');
  spec.createRepo(repo);
  const base = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
  const adapter = spec.adapters.find((entry) => entry.name === spec.runtime);
  const codex = spec.runtime === 'codex';
  const since = Date.now();
  let run, opener;
  if (spec.condition.mode === 'adopted') {
    opener = {
      since,
      ...(await codexExec(adapter.binary, repo, OPENER, spec.logs, 'opener', spec.settleMs)),
    };
    if (!opener.thread) throw new Error(`the opener started no native session: ${opener.error}`);
  }
  if (spec.condition.mode !== 'bare') run = await pantheonRun(spec, repo, opener);
  else if (codex) {
    const bare = await codexExec(adapter.binary, repo, spec.goal, spec.logs, 'bare', spec.settleMs);
    run = {
      tree: repo,
      settled: bare.settled,
      turn_error: bare.error,
      task_turns: 1,
      approvals: 0,
      wall_ms: bare.wall_ms,
    };
  } else run = await adapterRun(spec, repo, adapter);
  const { tree, ...rest } = run;
  const threads = codex ? rollouts([tree], since) : [];
  for (const { file } of threads) fs.copyFileSync(file, path.join(spec.logs, path.basename(file)));
  const native = codex ? nativeTurn(threads, spec.goal, spec.checkouts) : {};
  const { changed, hidden_passed, hidden_unstable } = hiddenOnTree(spec, repo, tree, base);
  return {
    mode: spec.condition.mode,
    runtime_version: adapter.binary ? versionOf(adapter.binary) : adapter.report.version,
    outcome: changed ? 'changed' : 'unchanged',
    hidden_passed,
    // true: the hidden check failed once and passed on its second try.
    hidden_unstable,
    title: null,
    title_ms: null,
    ...rest,
    native_error: native.error ?? null,
    native_session_id: native.native_session_id ?? null,
    model_reported: native.model ?? null,
    goal_verbatim: native.goal_verbatim ?? null,
    tool_calls: native.tool_calls ?? null,
    model_requests: native.model_requests ?? null,
    input_tokens: native.input_tokens ?? null,
    cached_input_tokens: native.cached_input_tokens ?? null,
    output_tokens: native.output_tokens ?? null,
    spawned_threads: native.spawned_threads ?? null,
    spawned_input_tokens: native.spawned_input_tokens ?? null,
    native_ms: native.native_ms ?? null,
    read_checkout: native.read_checkout ?? null,
  };
}
