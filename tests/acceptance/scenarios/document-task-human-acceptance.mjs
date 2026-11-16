import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { createResearchDoc } from '../fixtures/research-doc.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';

export const title = '非代码任务与人工验收';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const WAIT_MS = 30000;
const DOCUMENT = 'report.md';
const CHECKER = 'check/citations.mjs';
const ACCEPTANCE = `node ${CHECKER} ${DOCUMENT}`;
const SELF_REPORT = 'report.md is complete and both human judgments are satisfied';
// Found on the daemon's PATH, so no machine path lands in the evidence.
const passingGate = [{ name: 'Passes', argv: ['node', '-e', 'process.exit(0)'] }];
/** Fails unless the document cites at least once and every quote occurs verbatim in its source. */
const checkerSource = (pattern) =>
  [
    "import { existsSync, readFileSync } from 'node:fs';",
    'const [document] = process.argv.slice(2);',
    `const citations = [...readFileSync(document, 'utf8').matchAll(new RegExp(${JSON.stringify(pattern)}, 'g'))];`,
    'const unsupported = citations.filter(([, id, quote]) => {',
    '  const source = `sources/${id}.md`;',
    "  return !existsSync(source) || !readFileSync(source, 'utf8').includes(quote);",
    '});',
    "if (!citations.length) console.error('No citations');",
    'for (const [citation] of unsupported) console.error(`Not in its source: ${citation}`);',
    'process.exitCode = citations.length && !unsupported.length ? 0 : 1;',
    '',
  ].join('\n');
const plan = {
  base_version: 0,
  headline: 'Storage decision',
  lanes: [{ id: 'docs', title: 'Docs' }],
  tasks: [
    {
      id: 'report',
      title: 'Write the storage decision',
      goal: 'Write report.md from template.md, citing each source verbatim',
      lane: 'docs',
      depends_on: [],
      source: ['Write the storage decision for the notes app'],
      scope: [DOCUMENT],
      acceptance: [ACCEPTANCE],
      done_when: 'report',
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const write = (file, text) => ({ write: { path: file, text } });
const ended = (turn) => !['queued', 'running'].includes(turn.state);
const passed = (check) =>
  Boolean(check?.payload.results.length) &&
  check.payload.results.every((result) => result.exit_code === 0 && !result.timed_out);

export async function run({ workspace, evidenceDir, humanReview }) {
  const adapter = new FixtureAdapter();
  const workspaceRoot = createWorkspaceRoot('pantheon-acceptance');
  let fixture;
  const receipts = [],
    reads = {},
    observations = {};
  const ids = {};
  let projectId, failure, evidence, research, repo;

  const send = async (step, type, input, revision = null) => {
    const result = await fixture.submit(command(USER_PRINCIPAL_ID, type, input, revision));
    receipts.push({ step, type, input, expected_revision: revision, ...result });
    return result;
  };
  const call = async (step, type, input, revision = null) => {
    const result = await send(step, type, input, revision);
    if (result.status !== 200) throw new Error(`${step} ${type}: ${JSON.stringify(result.data)}`);
    return result.data.receipt;
  };
  const get = async (method, params) => {
    const { daemon } = fixture;
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const snapshot = () => get('board', { project_id: projectId });
  const events = async () => {
    const all = [];
    for (let after = 0; ;) {
      const page = await get('events', { after: String(after), project_id: projectId });
      if (page.snapshot_required) throw new Error('Event log no longer reaches the first event');
      if (!page.events.length) return all;
      all.push(...page.events);
      after = page.events.at(-1).sequence;
    }
  };
  const sessionRow = (board, sessionId) => board.sessions.find((row) => row.id === sessionId);
  /** Waits until the session is open and idle; each of its turns must have completed. */
  const idle = async (sessionId, description) => {
    const found = await waitFor(
      async () => {
        const board = await snapshot();
        const session = sessionRow(board, sessionId);
        const turns = board.session_turns.filter((turn) => turn.session_id === sessionId);
        return session?.state === 'open' &&
          session.merge?.state !== 'running' &&
          turns.length &&
          turns.every(ended)
          ? { board, session, turns }
          : false;
      },
      description,
      WAIT_MS,
    );
    const failed = found.turns.filter((turn) => turn.state !== 'completed');
    if (failed.length) throw new Error(`${description}: turn ended ${failed[0].state}`);
    return found.session;
  };
  /** Starts the user's merge and waits until it lands or is blocked. */
  const merge = async (step) => {
    const session = await idle(ids.doc, `the document session to be idle for ${step}`);
    await call(step, 'session.merge', { session_id: ids.doc }, session.revision);
    return waitFor(
      async () => {
        const row = sessionRow(await snapshot(), ids.doc);
        return row?.outcome === 'merged' || row?.merge?.state === 'blocked' ? row : false;
      },
      `the ${step} merge to land or be blocked`,
      WAIT_MS,
    );
  };
  /** Sends the lead one tool call once it is open and returns that call's result. */
  const leadCalls = async (step, tool) => {
    let turn;
    for (;;) {
      const session = await idle(ids.lead, `the lead to be open for ${step}`);
      const result = await send(
        step,
        'session.send',
        { session_id: ids.lead, input: script({ tool }) },
        session.revision,
      );
      if (result.status === 200) {
        turn = result.data.receipt;
        break;
      }
      if (!['resource_busy', 'conflict', 'revision_conflict'].includes(result.data.error))
        throw new Error(`${step} session.send: ${JSON.stringify(result.data)}`);
    }
    await waitFor(
      async () => {
        const row = (await snapshot()).session_turns.find((candidate) => candidate.id === turn.id);
        return row && ended(row);
      },
      `the lead ${step} turn to end`,
      WAIT_MS,
    );
    const all = await events();
    const started = all.find(
      (event) =>
        event.kind === 'agent.tool.started' &&
        event.payload.turn_id === turn.id &&
        event.payload.name === tool.name,
    );
    return (
      all.find(
        (event) =>
          event.kind === 'agent.tool.completed' &&
          event.payload.tool_call_id === started?.payload.tool_call_id,
      )?.payload ?? null
    );
  };
  const milestoneOf = async () => ({
    row: (await snapshot()).milestones.find((row) => row.id === ids.milestone),
    status:
      (await get('project.read', { project_id: projectId })).milestones.find(
        (view) => view.milestone.id === ids.milestone,
      )?.status ?? null,
  });

  try {
    // The research-doc sources, question and template, with the citation checker, in a git repository.
    research = await createResearchDoc(path.join(workspace, 'research'));
    repo = path.join(workspace, 'repo');
    await mkdir(path.join(repo, 'sources'), { recursive: true });
    await mkdir(path.join(repo, 'check'));
    for (const file of [research.question, research.template, research.required_judgments])
      await copyFile(file, path.join(repo, path.basename(file)));
    for (const source of research.sources)
      await copyFile(source.path, path.join(repo, 'sources', `${source.id}.md`));
    await writeFile(path.join(repo, CHECKER), checkerSource(research.citation_pattern));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Document Task');
    git(repo, 'config', 'user.email', 'document-task@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Add the research material');
    const drafts = {
      missing_citation: await readFile(research.drafts.missing_citation, 'utf8'),
      complete: await readFile(research.drafts.complete, 'utf8'),
    };
    const judgments = JSON.parse(await readFile(research.required_judgments, 'utf8'));

    fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [adapter], {
      intervalMs: 50,
      workspaceRoot: workspaceRoot.root,
    });
    const project = await call('open', 'project.open', { name: 'Storage decision', roots: [repo] });
    projectId = project.id;
    await call(
      'open',
      'project.gate.set',
      { project_id: projectId, root: project.roots[0], commands: passingGate },
      project.revision,
    );

    // The lead plans a document-only task; its session commits a draft whose citation is paraphrased.
    ids.lead = (
      await call('plan', 'session.create', {
        project_id: projectId,
        runtime: adapter.name,
        input: script({ tool: { name: 'update_board', arguments: plan } }),
      })
    ).id;
    await idle(ids.lead, 'the lead to write the plan');
    ids.doc = (
      await call('draft', 'session.create', {
        project_id: projectId,
        runtime: adapter.name,
        task_id: `${ids.lead}:report`,
        input: script(write(DOCUMENT, drafts.missing_citation), {
          commit: 'Draft the storage decision',
        }),
      })
    ).id;
    await idle(ids.doc, 'the document session to commit its draft');
    reads.missing_commit = (await get('session.diff', { session_id: ids.doc })).head_sha;

    // The user's milestone needs the document session merged and the human judgments made.
    ids.milestone = (
      await call('milestone', 'milestone.create', {
        project_id: projectId,
        title: 'Storage decision accepted',
        required_sessions: [ids.doc],
        criteria: [
          `${DOCUMENT} cites each source verbatim`,
          ...judgments.map((judgment) => `Human judgment ${judgment.id}: ${judgment.statement}`),
        ],
      })
    ).id;
    reads.missing_merge = await merge('missing_merge');

    // Completed, the session reports its human judgments satisfied, and the user merges it.
    const draft = await idle(ids.doc, 'the document session to be open');
    await call(
      'complete',
      'session.send',
      {
        session_id: ids.doc,
        input: script(
          write(DOCUMENT, drafts.complete),
          { commit: 'Cite the WAL notes verbatim' },
          { tool: { name: 'report', arguments: { kind: 'done', text: SELF_REPORT } } },
        ),
      },
      draft.revision,
    );
    await idle(ids.doc, 'the document session to complete the document');
    reads.complete_commit = (await get('session.diff', { session_id: ids.doc })).head_sha;
    reads.complete_merge = await merge('complete_merge');
    reads.report = await waitFor(
      async () =>
        (await events()).find(
          (event) => event.kind === 'task.reported' && event.payload.text === SELF_REPORT,
        ) ?? false,
      'the done report of the document session',
      WAIT_MS,
    );

    // The lead accepts its task on that report and tries the user's milestone.
    reads.milestone_before_lead = await milestoneOf();
    reads.lead_accept_task = await leadCalls('accept_task', {
      name: 'accept_task',
      arguments: { project_id: projectId, task_id: 'report', evidence: SELF_REPORT },
    });
    reads.lead_accept_milestone = await leadCalls('accept_milestone', {
      name: 'milestone_accept',
      arguments: { milestone_id: ids.milestone, evidence_refs: [`session:${ids.doc}`] },
    });
    reads.milestone_after_lead = await milestoneOf();

    // An acceptance that names no merged session is refused.
    const criteria = reads.milestone_after_lead.row.criteria.map((_, index) => index);
    const unreferenced = await send(
      'unreferenced',
      'milestone.accept',
      { milestone_id: ids.milestone, evidence_refs: ['report:self'], criteria_checked: criteria },
      reads.milestone_after_lead.row.revision,
    );
    reads.unreferenced_accept = { status: unreferenced.status, data: unreferenced.data };

    // A human confirms the session's final document; only then does the user accept with evidence.
    const final = git(repo, 'show', `${reads.complete_commit}:${DOCUMENT}`);
    const [reviewed] = await writeEvidence(evidenceDir, { 'reviewed-report.md': final });
    const review = await humanReview([{ name: DOCUMENT, path: reviewed.path }], { waitMs: 0 });
    reads.human_review = {
      ok: review.ok,
      reasons: review.reasons,
      receipt: review.receipt ?? null,
    };
    if (review.ok) {
      const { row } = await milestoneOf();
      reads.user_accept = await call(
        'accept',
        'milestone.accept',
        {
          milestone_id: ids.milestone,
          evidence_refs: [`session:${ids.doc}`],
          criteria_checked: criteria,
        },
        row.revision,
      );
    }
    reads.milestone_final = await milestoneOf();

    const all = await events();
    const checks = all.filter(
      (event) => event.kind === 'session.gate_checked' && event.aggregate_id === ids.doc,
    );
    const mergedEvent = all.find(
      (event) => event.kind === 'session.merged' && event.aggregate_id === ids.doc,
    );
    const checkOn = (commit) => checks.findLast((event) => event.payload.commit === commit);
    const acceptanceRan = (check) =>
      check?.payload.results.some((result) => result.name === ACCEPTANCE);
    const receiptItem = review.receipt?.items.find((item) => item.name === DOCUMENT);
    reads.merged_document = mergedEvent ? git(repo, 'show', `HEAD:${DOCUMENT}`) : null;
    observations.acceptance = {
      doc_task_merged:
        Boolean(mergedEvent) &&
        reads.merged_document === drafts.complete &&
        acceptanceRan(checkOn(reads.complete_commit)) &&
        passed(checkOn(reads.complete_commit)),
      missing_reference_passed: checkOn(reads.missing_commit)
        ? !acceptanceRan(checkOn(reads.missing_commit)) ||
          passed(checkOn(reads.missing_commit)) ||
          reads.missing_merge.outcome === 'merged'
        : null,
      self_report_satisfies_human:
        reads.milestone_after_lead.row.acceptance !== undefined ||
        reads.milestone_after_lead.status === 'completed' ||
        reads.lead_accept_milestone?.ok === true,
      human_receipt_bound_to_hash:
        review.ok &&
        receiptItem?.sha256 === sha256(final) &&
        final === reads.merged_document &&
        reads.milestone_final.row.acceptance?.evidence_refs?.includes(`session:${ids.doc}`) ===
          true &&
        reads.milestone_final.status === 'completed',
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      evidence = await collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    await fixture?.close();
    workspaceRoot.remove();
  }
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...evidence,
      'failure.txt': String(failure?.stack ?? failure),
    });
    throw failure;
  }
  return {
    observations,
    evidence,
    adapters: [`${adapter.name}@${adapter.report.version}`],
  };

  async function collectEvidence() {
    const drafts = research
      ? {
          missing_citation_sha256: sha256(await readFile(research.drafts.missing_citation)),
          complete_sha256: sha256(await readFile(research.drafts.complete)),
          fixture_hash: research.hash,
        }
      : null;
    if (!projectId)
      return {
        'artifact-checks.json': { drafts },
        'gate-history.json': { receipts },
        'human-review.json': { human_review: reads.human_review ?? null },
      };
    const all = await events();
    const checks = all
      .filter((event) => event.kind === 'session.gate_checked' && event.aggregate_id === ids.doc)
      .map((event) => ({
        commit: event.payload.commit,
        results: event.payload.results.map((result) => ({
          name: result.name,
          exit_code: result.exit_code,
          timed_out: result.timed_out,
          output: result.output,
        })),
      }));
    return {
      'artifact-checks.json': {
        acceptance: ACCEPTANCE,
        checker: research ? checkerSource(research.citation_pattern) : null,
        drafts,
        commits: {
          missing_citation: reads.missing_commit ?? null,
          complete: reads.complete_commit ?? null,
        },
        checks,
        merged_document: reads.merged_document ?? null,
      },
      'gate-history.json': {
        history: await get('session.gates.history', { session_id: ids.doc }).catch(() => null),
        merges: all
          .filter(
            (event) =>
              ['session.merge_started', 'session.merge_blocked', 'session.merged'].includes(
                event.kind,
              ) && event.aggregate_id === ids.doc,
          )
          .map((event) => ({ sequence: event.sequence, kind: event.kind, payload: event.payload })),
        missing_merge: reads.missing_merge
          ? {
              outcome: reads.missing_merge.outcome ?? null,
              merge: reads.missing_merge.merge ?? null,
            }
          : null,
        complete_merge: reads.complete_merge
          ? { outcome: reads.complete_merge.outcome ?? null }
          : null,
      },
      'human-review.json': {
        report: reads.report?.payload ?? null,
        lead_accept_task: reads.lead_accept_task ?? null,
        lead_accept_milestone: reads.lead_accept_milestone ?? null,
        unreferenced_accept: reads.unreferenced_accept ?? null,
        milestone_before_lead: reads.milestone_before_lead ?? null,
        milestone_after_lead: reads.milestone_after_lead ?? null,
        human_review: reads.human_review ?? null,
        user_accept: reads.user_accept ?? null,
        milestone_final: reads.milestone_final ?? null,
        observations,
      },
      'events.json': all,
      'receipts.json': receipts,
    };
  }
}
