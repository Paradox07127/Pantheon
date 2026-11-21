import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { versionOf } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST } from '@pantheon/domain';
import { worktreeSandbox } from '../../../packages/control/dist/protection.js';
import { startNativeDaemon } from '../../acceptance/lib/daemon.mjs';
import { waitFor } from '../../acceptance/lib/event-client.mjs';
import { materialize } from './check.mjs';

const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const busy = (turn) => ['queued', 'running'].includes(turn.state);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The plan a lead writes for the task: one task, dispatched to a session of its own. */
export const oneTaskPlan = (task) => ({
  base_version: 0,
  headline: 'Evaluation run',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    {
      id: 'A',
      title: 'Task A',
      goal: task.goal,
      lane: 'main',
      milestone: 'M',
      depends_on: [],
      // A source must be a verbatim quote of the lead's input, where the plan is escaped JSON.
      source: [task.goal.split('\n')[0]],
      scope: task.scope,
      acceptance: task.acceptance,
      ...(task.runtime ? { runtime: task.runtime } : {}),
      ...(task.model ? { model: task.model } : {}),
      path: 'dispatch',
      flow_reason: 'The task runs in a session of its own',
    },
  ],
  milestones: [{ id: 'M', title: 'Milestone M', criteria: ['A is merged'], tasks: ['A'] }],
  risks: [],
  assumptions: [],
});

/** Whether the hidden check passes on main, and whether it passed only on its second try. */
async function hiddenOnMain(spec, repo) {
  const hidden = async () => {
    const tree = fs.mkdtempSync(path.join(spec.workspace, 'main-tree-'));
    materialize(repo, 'main', tree);
    return spec.hiddenCheck(tree);
  };
  const first = await hidden();
  const passed = first || (await hidden());
  return { hidden_passed: passed, hidden_unstable: first !== passed };
}

/** true: a file outside the source trees (product state, native transcripts) names the eval checkout. */
const readCheckout = ({ workspace, checkout }) =>
  checkout
    ? fs
        .readdirSync(workspace, { recursive: true })
        .filter((file) => !/^(repo|workspaces|main-tree-[^/]*)(\/|$)/.test(file))
        .map((file) => path.join(workspace, file))
        .some((file) => fs.lstatSync(file).isFile() && fs.readFileSync(file).includes(checkout))
    : null;

/**
 * A bare run: one session of the runtime outside Pantheon, so with no Pantheon tools, memory or
 * gate, sent the goal alone in a worktree of the repository. What it commits there lands on main
 * for the hidden check.
 */
async function bareRun(spec, repo, adapter, runtimeVersion) {
  const tree = path.join(spec.workspace, 'workspaces', 'bare');
  // Detached as the product's worktrees are: its sandbox lets a commit write the worktree's HEAD, not a branch.
  git(repo, 'worktree', 'add', '-q', '--detach', tree);
  const temporary = path.join(spec.workspace, 'tmp');
  let sandbox;
  // A frozen task's run names the checkout and history repository that hold its hidden test and source commit.
  if (spec.checkout) {
    const home = spec.realHome ? os.homedir() : path.join(spec.workspace, 'home');
    fs.mkdirSync(temporary, { mode: 0o700 });
    sandbox = worktreeSandbox({
      dataDir: path.join(spec.workspace, 'state'),
      backupDir: path.join(spec.workspace, 'backups'),
      desktopUserDataDir: path.join(home, 'Library/Application Support/Pantheon Desktop'),
      home,
      codexHome: path.join(home, '.codex'),
      sourceRepo: repo,
      workspacePath: tree,
      worktreeId: path.basename(tree),
      tempDir: temporary,
      otherWorkspaces: [],
      hiddenChecksDirs: [...new Set([spec.checkout, spec.history])],
      taskSession: { reviewsDirs: [] },
    });
  }
  const events = [];
  let ended;
  const end = new Promise((resolve) => (ended = resolve));
  const handle = await adapter.start(
    {
      platform_session_id: 'bare',
      project_id: 'bare',
      runtime: adapter.name,
      ...(spec.task.model ? { model: spec.task.model } : {}),
      device_id: 'local',
      role: 'writer',
      ...(sandbox
        ? {
            env: { TMPDIR: temporary },
            sandbox: {
              writable_roots: sandbox.writable_roots,
              protected_entries: sandbox.protected_entries.map(({ path: target, deny }) => ({
                path: target,
                deny,
              })),
            },
          }
        : {}),
      cwd: tree,
      env_allowlist: NATIVE_ENV_ALLOWLIST,
      skills: [],
      mcp_servers: [],
      budget: { max_turns: 1, wall_time_ms: spec.settleMs },
      permission_mode: 'auto_edit',
    },
    (event) => {
      events.push(event);
      // Nobody answers a permission request here either.
      if (event.kind === 'turn.completed' || event.kind === 'permission.requested') ended();
    },
  );
  const started = Date.now();
  try {
    await adapter.send(handle, { turn_id: 'bare-turn', input: spec.task.goal });
    await end;
  } finally {
    await adapter.close(handle, Date.now() + 10000);
  }
  const wall = Date.now() - started;
  const completed = events.find((event) => event.kind === 'turn.completed');
  const asked = events.filter((event) => event.kind === 'permission.requested').length;
  const head = git(tree, 'rev-parse', 'HEAD').trim();
  const merged = git(repo, 'rev-list', '--count', `main..${head}`).trim() !== '0';
  if (merged) git(repo, 'merge', '-q', '--ff-only', head);
  const { hidden_passed, hidden_unstable } = merged
    ? await hiddenOnMain(spec, repo)
    : { hidden_passed: null, hidden_unstable: null };
  const usage = events.findLast((event) => event.kind === 'usage.updated');
  return {
    mode: 'bare',
    runtime_version: runtimeVersion,
    model_asked: spec.task.model ?? null,
    model_reported: [...new Set(events.map((event) => event.reported_model).filter(Boolean))],
    outcome: merged ? 'merged' : 'failed',
    hidden_passed,
    hidden_unstable,
    stopped_by: merged
      ? null
      : asked
        ? 'permission_requested'
        : completed?.status === 'failed'
          ? 'turn_failed'
          : 'unknown',
    settled: completed?.error_code !== 'turn_deadline',
    turn_error: completed?.status === 'failed' ? completed.error : null,
    task_turns: 1,
    gate_runs: 0,
    // There is no Needs-you list outside Pantheon.
    needs_you: null,
    needs_you_kinds: null,
    human_touches: asked,
    read_checkout: readCheckout(spec),
    input_tokens: usage ? (usage.input_tokens ?? 0) : null,
    cached_input_tokens: usage ? (usage.cached_input_tokens ?? 0) : null,
    output_tokens: usage ? (usage.output_tokens ?? 0) : null,
    cost_usd: usage?.cost_usd ?? null,
    wall_ms: wall,
    policy_version: null,
  };
}

/**
 * One run: a fresh repository, then either a bare session (see bareRun) or a fresh daemon whose
 * lead, scripted or real, plans the task and dispatches it; then the hidden check on what
 * reached main. A scripted lead writes oneTaskPlan; a real lead on the task's runtime is sent the
 * goal as a user message, under the condition's policy.
 * The repository is `<workspace>/repo`.
 */
export async function runOne(spec) {
  const { workspace } = spec;
  const repo = path.join(workspace, 'repo');
  spec.createRepo(repo);
  const runtime = spec.task.runtime ?? spec.leadRuntime;
  const adapter = spec.adapters.find((entry) => entry.name === runtime);
  const runtimeVersion = adapter.binary ? versionOf(adapter.binary) : adapter.report.version;
  if (spec.condition.mode === 'bare') return bareRun(spec, repo, adapter, runtimeVersion);
  const real = spec.condition.lead === 'real';
  // With protection paths the task session gets its sandbox; this home keeps audits off the real one.
  // A real runtime reads its login from the real home, which the product must then protect.
  const home = spec.realHome ? undefined : path.join(workspace, 'home');
  if (home) fs.mkdirSync(home);
  const fixture = await startNativeDaemon(workspace, spec.adapters, { intervalMs: 50, home });
  const { daemon } = fixture;
  const get = async (method, params) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  let over = false;
  // Settles when the loop that answers a real lead's permission cards has stopped.
  let approver = Promise.resolve();
  try {
    const project = await fixture.call('project.open', { name: 'Evaluation run', roots: [repo] });
    const params = { project_id: project.id };
    const revision = async () =>
      (await get('board', params)).projects.find((row) => row.id === project.id).revision;
    await fixture.call(
      'project.gate.set',
      { project_id: project.id, root: project.roots[0], commands: spec.gate },
      project.revision,
    );
    await fixture.call(
      'project.autoMerge.set',
      { project_id: project.id, enabled: true },
      await revision(),
    );
    const leadRuntime = real ? runtime : spec.leadRuntime;
    await fixture.call(
      'project.sessionDefaults.set',
      { project_id: project.id, runtime: leadRuntime, permission_mode: 'auto_edit' },
      await revision(),
    );
    if (spec.condition.policy) {
      const current = await get('workflow.policy', params);
      // Revision 0 is the defaults of a project that stores no policy yet.
      await fixture.call(
        'workflow.policy.set',
        { ...params, ...spec.condition.policy },
        current.revision || null,
      );
    }
    const policyVersion = (await get('workflow.policy', params)).policy_version;

    const leadSession = await fixture.call(
      'session.create',
      real
        ? {
            project_id: project.id,
            runtime: leadRuntime,
            purpose: 'lead',
            ...(spec.task.model ? { model: spec.task.model } : {}),
            input: spec.task.goal,
          }
        : {
            project_id: project.id,
            runtime: leadRuntime,
            purpose: 'lead',
            input: script(
              { tool: { name: 'update_board', arguments: oneTaskPlan(spec.task) } },
              { tool: { name: 'start_task', arguments: { task_ids: ['A'] } } },
            ),
          },
    );
    const events = async () => {
      const all = [];
      for (let after = 0; ;) {
        const page = await get('events', { after: String(after), ...params });
        if (!page.events.length) return all;
        all.push(...page.events);
        after = page.events.at(-1).sequence;
      }
    };
    // Nobody sits at a real lead's permission cards: the run approves each one and counts it.
    let leadApprovals = 0;
    approver = (async () => {
      const answered = new Set();
      while (real && !over) {
        await delay(500);
        const pending = (await events()).filter(
          (event) =>
            event.kind === 'approval.requested' &&
            event.payload.kind === 'permission' &&
            event.payload.session_id === leadSession.id &&
            !answered.has(event.payload.id),
        );
        for (const { payload } of pending) {
          answered.add(payload.id);
          await fixture.call(
            'approval.respond',
            { approval_id: payload.id, decision: 'approve_session' },
            payload.revision,
          );
          leadApprovals += 1;
        }
      }
    })();
    // The finally block awaits it; until then a failed answer must not end the process.
    approver.catch(() => {});
    const taskRow = async () =>
      (await get('session.list', params)).find((row) => row.id === taskSession);
    const taskSession = await waitFor(
      async () =>
        (await events()).find((event) => event.kind === 'task.dispatched')?.payload.session_id ??
        // A real lead may claim the task and do it in its own session.
        ((await events()).some(
          (event) => event.kind === 'task.claimed' && event.aggregate_id === leadSession.id,
        ) &&
          leadSession.id),
      'the task session',
      spec.settleMs,
    );
    const started = Date.now();
    let all = await events(),
      changed = Date.now(),
      settled = false;
    while (Date.now() - started < spec.settleMs) {
      await delay(100);
      const next = await events();
      if (next.length !== all.length) {
        all = next;
        changed = Date.now();
        continue;
      }
      const turns = (await get('board', params)).session_turns;
      if (Date.now() - changed < spec.quietMs) continue;
      const row = await taskRow();
      // Nobody answers a permission request here, so its turn would stay running to the cap.
      // A running merge is not the end of the run, however long its gate prints no event.
      // The run itself answers the permission requests of a real lead's own session.
      const unanswered = row.waiting > 0 && taskSession !== leadSession.id;
      if (unanswered || (!turns.some(busy) && row.merge?.state !== 'running')) {
        settled = true;
        break;
      }
    }

    const board = await get('board', params);
    const needsYou = (await get('needs_you.list', params)).items.map((item) => item.kind);
    const of = (kind) => all.filter((event) => event.kind === kind);
    const ofTask = (kind) => of(kind).filter((event) => event.aggregate_id === taskSession);
    // The session holds a block no event announces (a review step); the next turn clears it,
    // so an earlier block is read from the events.
    const { merge, waiting } = await taskRow();
    const blocked =
      merge?.state === 'blocked' ? merge : ofTask('session.merge_blocked').at(-1)?.payload;
    const skipped = ofTask('session.merge_skipped').at(-1)?.payload;
    const merged = ofTask('session.merged').length > 0;
    const taskTurns = board.session_turns.filter((turn) => turn.session_id === taskSession);
    // A real lead's turns are part of what the run cost; a scripted lead's are not.
    const usage = (real ? board.session_turns : taskTurns)
      .map((turn) => turn.usage)
      .filter(Boolean);
    const sum = (field) =>
      usage.length ? usage.reduce((total, row) => total + (row[field] ?? 0), 0) : null;
    const costs = usage.map((row) => row.cost_usd).filter((cost) => cost !== undefined);
    const { hidden_passed: hiddenPassed, hidden_unstable: hiddenUnstable } = merged
      ? await hiddenOnMain(spec, repo)
      : { hidden_passed: null, hidden_unstable: null };
    return {
      mode: spec.condition.mode,
      runtime_version: runtimeVersion,
      model_asked: spec.task.model ?? null,
      model_reported: [
        ...new Set(board.session_turns.map((turn) => turn.reported_model).filter(Boolean)),
      ],
      // blocked: the product refused or skipped a merge of the task session and none landed.
      outcome: merged ? 'merged' : blocked || skipped ? 'blocked' : 'failed',
      hidden_passed: hiddenPassed,
      // true: the hidden check failed once and passed on its second try.
      hidden_unstable: hiddenUnstable,
      stopped_by: merged
        ? null
        : blocked
          ? [blocked.reason, blocked.gate?.name].filter(Boolean).join(': ')
          : skipped
            ? skipped.reason
            : waiting > 0
              ? 'permission_requested'
              : taskTurns.some((turn) => turn.state === 'failed')
                ? 'turn_failed'
                : 'unknown',
      settled,
      // The runtime's reason for the last failed turn of the task session.
      turn_error: taskTurns.findLast((turn) => turn.state === 'failed')?.delivery_reason ?? null,
      task_turns: taskTurns.length,
      gate_runs: of('session.gate_checked').length,
      needs_you: needsYou.length,
      needs_you_kinds: needsYou,
      // What a person would have had to answer: the needs-you items left at settle.
      human_touches: needsYou.length,
      // Permission requests of a real lead that the run approved in the user's place.
      lead_approvals: leadApprovals,
      read_checkout: readCheckout(spec),
      input_tokens: sum('input_tokens'),
      cached_input_tokens: sum('cached_input_tokens'),
      output_tokens: sum('output_tokens'),
      cost_usd: costs.length ? costs.reduce((total, cost) => total + cost, 0) : null,
      wall_ms: changed - started,
      policy_version: policyVersion,
    };
  } finally {
    over = true;
    await approver;
    await fixture.close();
  }
}
