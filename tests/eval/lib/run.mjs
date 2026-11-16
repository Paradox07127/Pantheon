import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startNativeDaemon } from '../../acceptance/lib/daemon.mjs';
import { waitFor } from '../../acceptance/lib/event-client.mjs';
import { materialize } from './check.mjs';

const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const busy = (turn) => ['queued', 'running'].includes(turn.state);

/**
 * One run: a fresh daemon and repository, a scripted lead that writes a one-task plan and
 * dispatches it, then the hidden check on what reached main.
 * The repository is `<workspace>/repo`.
 */
export async function runOne(spec) {
  const { workspace } = spec;
  const repo = path.join(workspace, 'repo');
  spec.createRepo(repo);
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
    await fixture.call(
      'project.sessionDefaults.set',
      { project_id: project.id, runtime: spec.leadRuntime, permission_mode: 'auto_edit' },
      await revision(),
    );
    await fixture.call('workflow.definition.set', {
      project_id: project.id,
      definition: {
        slots: { before_dispatch: [], before_merge: spec.beforeMerge, after_merge: [] },
      },
      base_version: 0,
    });

    const plan = {
      base_version: 0,
      headline: 'Evaluation run',
      lanes: [{ id: 'main', title: 'Main' }],
      tasks: [
        {
          id: 'A',
          title: 'Task A',
          goal: spec.task.goal,
          lane: 'main',
          milestone: 'M',
          depends_on: [],
          // A source must be a verbatim quote of the lead's input, where the plan is escaped JSON.
          source: [spec.task.goal.split('\n')[0]],
          scope: spec.task.scope,
          acceptance: spec.task.acceptance,
          ...(spec.task.runtime ? { runtime: spec.task.runtime } : {}),
          path: 'dispatch',
          flow_reason: 'The task runs in a session of its own',
        },
      ],
      milestones: [{ id: 'M', title: 'Milestone M', criteria: ['A is merged'], tasks: ['A'] }],
      risks: [],
      assumptions: [],
    };
    await fixture.call('session.create', {
      project_id: project.id,
      runtime: spec.leadRuntime,
      input: script(
        { tool: { name: 'update_board', arguments: plan } },
        { tool: { name: 'start_task', arguments: { task_ids: ['A'] } } },
      ),
    });
    const events = async () => {
      const all = [];
      for (let after = 0; ;) {
        const page = await get('events', { after: String(after), ...params });
        if (!page.events.length) return all;
        all.push(...page.events);
        after = page.events.at(-1).sequence;
      }
    };
    const taskRow = async () =>
      (await get('session.list', params)).find((row) => row.id === taskSession);
    const taskSession = await waitFor(
      async () =>
        (await events()).find((event) => event.kind === 'task.dispatched')?.payload.session_id ??
        false,
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
      if (row.waiting > 0 || (!turns.some(busy) && row.merge?.state !== 'running')) {
        settled = true;
        break;
      }
    }

    const board = await get('board', params);
    const needsYou = (await get('needs_you.list', params)).items.map((item) => item.kind);
    const of = (kind) => all.filter((event) => event.kind === kind);
    const ofTask = (kind) => of(kind).filter((event) => event.aggregate_id === taskSession);
    // The session holds a block no event announces (an approval step); the next turn clears it,
    // so an earlier block is read from the events.
    const { merge, waiting } = await taskRow();
    const blocked =
      merge?.state === 'blocked' ? merge : ofTask('session.merge_blocked').at(-1)?.payload;
    const skipped = ofTask('session.merge_skipped').at(-1)?.payload;
    const merged = ofTask('session.merged').length > 0;
    const taskTurns = board.session_turns.filter((turn) => turn.session_id === taskSession);
    const usage = taskTurns.map((turn) => turn.usage).filter(Boolean);
    const sum = (field) =>
      usage.length ? usage.reduce((total, row) => total + (row[field] ?? 0), 0) : null;
    const hidden = async () => {
      const tree = fs.mkdtempSync(path.join(workspace, 'main-tree-'));
      materialize(repo, 'main', tree);
      return spec.hiddenCheck(tree);
    };
    let hiddenPassed = null,
      hiddenUnstable = null;
    if (merged) {
      const first = await hidden();
      hiddenPassed = first || (await hidden());
      hiddenUnstable = first !== hiddenPassed;
    }
    return {
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
      // true: a file outside the source trees (product state, native transcripts) names the eval checkout.
      read_checkout: spec.checkout
        ? fs
            .readdirSync(workspace, { recursive: true })
            .filter((file) => !/^(repo|workspaces|main-tree-[^/]*)(\/|$)/.test(file))
            .map((file) => path.join(workspace, file))
            .some(
              (file) =>
                fs.lstatSync(file).isFile() && fs.readFileSync(file).includes(spec.checkout),
            )
        : null,
      input_tokens: sum('input_tokens'),
      cached_input_tokens: sum('cached_input_tokens'),
      output_tokens: sum('output_tokens'),
      wall_ms: changed - started,
    };
  } finally {
    await fixture.close();
  }
}
