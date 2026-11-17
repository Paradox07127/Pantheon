import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { FixtureAdapter, nativeEnvironment } from '@pantheon/adapters';

/** The first line of the digest of notes the daemon sends a lead it wakes. */
const INBOX_HEADER = '[Pantheon] Board updates since your last message:';

const pattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The tool calls a lead makes on a turn that is a digest of the daemon's notes, from what
 * project_read shows it first: it applies every user edit that waits for it, accepts each report
 * task whose done report is in the notes, then accepts each of its milestones that is ready or that
 * those acceptances make ready. None for a turn with a fixture script or without notes.
 */
export async function leadAnswers(input, read, leadId) {
  const lines = input.split('\n');
  if (lines.includes('fixture-script') || !lines.includes(INBOX_HEADER)) return [];
  const facts = await read();
  const project_id = facts.project.id;
  const plan = facts.plans.find((candidate) => candidate.lead_session_id === leadId);
  const steps = [];
  // A held user edit's note says `the user asks to change tasks that have open sessions (edit <id>):`.
  const edits = [
    ...new Set(
      lines.flatMap((line) =>
        [...line.matchAll(/have open sessions \(edit ([^)\s]+)\):/g)].map((match) => match[1]),
      ),
    ),
  ];
  if (edits.length)
    steps.push({
      tool: {
        name: 'edit_board',
        arguments: {
          project_id,
          base_version: plan.plan_version,
          ops: edits.map((edit_id) => ({ type: 'resolve_edit', edit_id, decision: 'apply' })),
        },
      },
    });
  const accepted = new Set();
  for (const task of plan.tasks) {
    if (task.done_when !== 'report' || task.state === 'done') continue;
    // A done note says `What happened: Task <id> "<title>" sent a done report, status <status>: "<text>".`
    const done = new RegExp(
      `^What happened: Task ${pattern(task.id)} "${pattern(task.title)}" sent a done report, status \\w+: "(.+)"\\.$`,
    );
    const evidence = lines.map((line) => done.exec(line)?.[1]).find(Boolean);
    if (!evidence) continue;
    accepted.add(task.id);
    steps.push({
      tool: { name: 'accept_task', arguments: { project_id, task_id: task.id, evidence } },
    });
  }
  const sessionsOf = (taskId) => plan.tasks.find((task) => task.id === taskId)?.session_ids ?? [];
  // What holds a milestone back: `task:<id>:<state>` and `session:<id>:open`.
  const cleared = (reason) => {
    const [kind, id] = reason.split(':');
    return kind === 'task'
      ? accepted.has(id)
      : [...accepted].some((taskId) => sessionsOf(taskId).includes(id));
  };
  for (const view of facts.milestones) {
    if (view.milestone.owner_session_id !== leadId) continue;
    const ready =
      view.status === 'ready_for_acceptance' ||
      (view.status === 'active' && accepted.size > 0 && view.reasons.every(cleared));
    if (!ready) continue;
    // A report task is accepted by now; every session of another done task merged.
    const evidence_refs = view.milestone.task_ids.flatMap((taskId) =>
      plan.tasks.find((task) => task.id === taskId)?.done_when === 'report'
        ? [`task:${taskId}`]
        : sessionsOf(taskId).map((sessionId) => `session:${sessionId}`),
    );
    steps.push({
      tool: {
        name: 'milestone_accept',
        arguments: { milestone_id: view.milestone.key, evidence_refs },
      },
    });
  }
  return steps;
}

/** What project_read shows the session, through a Pantheon MCP server of its own. */
async function projectRead(spec) {
  const server = spec.pantheon_mcp;
  if (!server) throw new Error('The lead session has no Pantheon MCP server to read the project');
  const child = spawn(server.command, server.args, {
    cwd: spec.cwd,
    env: { ...spec.env, ...nativeEnvironment(spec.env_allowlist), ...server.env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const exited = closed.then((code) => {
    throw new Error(`The Pantheon MCP server exited with ${code}`);
  });
  exited.catch(() => {});
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    waiting.get(frame?.id)?.(frame);
  });
  let sequence = 0;
  const write = (frame) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
  const request = (method, params) =>
    Promise.race([
      exited,
      new Promise((resolve, reject) => {
        const id = ++sequence;
        waiting.set(id, (frame) =>
          frame.error ? reject(new Error(JSON.stringify(frame.error))) : resolve(frame.result),
        );
        write({ id, method, params });
      }),
    ]);
  try {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'lead-fixture', version: '1' },
    });
    write({ method: 'notifications/initialized' });
    const result = await request('tools/call', { name: 'project_read', arguments: {} });
    const text = (result?.content ?? []).map((item) => item.text ?? '').join('\n');
    if (result?.isError) throw new Error(`project_read returned an error: ${text}`);
    return JSON.parse(text).receipt;
  } finally {
    child.kill();
    await closed;
  }
}

/**
 * The fixture runtime for a lead that answers its notes itself: a turn without a fixture script
 * that brings the daemon's notes runs the tool calls leadAnswers makes for them. Any other turn
 * runs as the fixture runs it.
 */
export class LeadFixtureAdapter extends FixtureAdapter {
  #specs = new Map();

  // start() goes through resume() with a new native session id.
  async resume(spec, nativeSessionId, emit) {
    this.#specs.set(spec.platform_session_id, spec);
    return super.resume(spec, nativeSessionId, emit);
  }

  async send(handle, turn) {
    const spec = this.#specs.get(handle.platform_session_id);
    const steps = await leadAnswers(
      turn.input,
      () => projectRead(spec),
      handle.platform_session_id,
    );
    return super.send(
      handle,
      steps.length ? { ...turn, input: `fixture-script\n${JSON.stringify(steps)}` } : turn,
    );
  }
}
