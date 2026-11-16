import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { RecordingFixtureAdapter, sandboxedRead } from '../fixtures/recording-fixture-adapter.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';

export const title = '审查隔离与发现裁决';
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
const REVIEWERS = ['fixture-reviewer-a', 'fixture-reviewer-b'];
const MODULE = 'src/average.mjs';
// Divides by one less than the count, so average([1, 2, 3]) is 3.
const DEFECT = `export const average = (values) =>\n  values.reduce((sum, value) => sum + value, 0) / (values.length - 1);\n`;
// Rewrites the divisor the first review quoted but still divides by one less than the count.
const REWRITTEN = `// Averages a non-empty list of numbers.\nexport const average = (values) =>\n  values.reduce((sum, value) => sum + value, 0) / Math.max(values.length - 1, 1);\n`;
const FIXED = `// Averages a non-empty list of numbers.\nexport const average = (values) =>\n  values.reduce((sum, value) => sum + value, 0) / values.length;\n`;
const VALID_QUOTE = '/ (values.length - 1)';
// The rewritten divisor, which the second review quotes.
const REWRITTEN_QUOTE = '/ Math.max(values.length - 1, 1)';
// A part of the defect the rewrite leaves as it was.
const KEPT_QUOTE = 'values.reduce((sum, value) => sum + value, 0)';
// Nowhere in the reviewed changes.
const INVALID_QUOTE = '/ (values.length + 1)';
const ROUNDS = 2;
// Every reviewer turn probes one other reviewer directory and two native session records.
const PROBES_PER_TURN = 3;

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const write = (file, text) => ({ write: { path: file, text } });
const ended = (turn) => !['queued', 'running'].includes(turn.state);
const finding = (quote) => ({
  tool: {
    name: 'review_finding',
    arguments: {
      location: `${MODULE}:2`,
      quote,
      evidence: 'average([1, 2, 3]) returns 3 instead of 2',
      impact: 'Every average is larger than the mean of its values',
      reproduction: {
        command: `node -e "import('./${MODULE}').then((m) => console.log(m.average([1, 2, 3])))"`,
        expected: '2',
        actual: '3',
      },
    },
  },
});
/** What each reviewer does in each review round, after its write probe. */
const reviewerSteps = [
  // A rejected finding fails the fixture tool call, so it is that reviewer's last step.
  {
    [REVIEWERS[0]]: [finding(VALID_QUOTE), finding(KEPT_QUOTE)],
    [REVIEWERS[1]]: [finding(INVALID_QUOTE)],
  },
  { [REVIEWERS[0]]: [finding(REWRITTEN_QUOTE)], [REVIEWERS[1]]: [{ say: 'No findings' }] },
];

export async function run({ workspace, evidenceDir }) {
  const home = path.join(workspace, 'home');
  const records = {
    claude_native_record: path.join(home, '.claude/projects/-review-project/session.jsonl'),
    codex_native_record: path.join(home, '.codex/sessions/2026/11/09/rollout-review.jsonl'),
  };
  const tokens = Object.fromEntries(
    Object.keys(records).map((kind) => [kind, `sentinel-${randomUUID()}`]),
  );
  const reviewInputs = [],
    probes = [],
    receipts = [],
    reads = {},
    observations = {};
  const ids = { reviews: [] };
  let round, projectId, writerWorktree, failure, evidence, fixture;

  /** Probes the reviewer's reads under the sandbox it was given, then runs its steps for the round. */
  const reviewerInput =
    (runtime) =>
    async ({ session_id, input, spec }) => {
      const current = round;
      await current.placed;
      reviewInputs.push({
        round: current.index,
        runtime,
        session_id,
        sha256: sha256(input),
        input,
      });
      const targets = [
        ...[...current.sentinels]
          .filter(([sessionId]) => sessionId !== session_id)
          .map(([, sentinel]) => ({ kind: 'other_reviewer_directory', ...sentinel })),
        ...Object.entries(records).map(([kind, file]) => ({
          kind,
          path: file,
          token: tokens[kind],
        })),
      ];
      for (const target of targets) {
        const result = await sandboxedRead(spec, target.path);
        probes.push({
          round: current.index,
          runtime,
          target: target.kind,
          read: result.read,
          sentinel_seen: result.read && result.text.includes(target.token),
        });
      }
      return script(
        { write_outside: { path: path.join(writerWorktree, 'review-probe.txt'), text: 'probe\n' } },
        ...reviewerSteps[current.index][runtime],
      );
    };
  const writer = new FixtureAdapter();
  const reviewers = REVIEWERS.map(
    (name) => new RecordingFixtureAdapter(name, { input: reviewerInput(name) }),
  );
  const workspaceRoot = createWorkspaceRoot('pantheon-acceptance');

  const send = async (step, type, input, revision = null) => {
    const body = command(USER_PRINCIPAL_ID, type, input, revision);
    const result = await fixture.submit(body);
    receipts.push({
      step,
      type,
      input,
      expected_revision: revision,
      command_id: body.command_id,
      ...result,
    });
    return { ...result, command_id: body.command_id };
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
  const reviewsOf = () => get('session.reviews', { session_id: ids.writer });
  /** Waits until the writer is open with every turn ended; each turn must have completed. */
  const idle = async (description) => {
    const found = await waitFor(
      async () => {
        const board = await snapshot();
        const session = board.sessions.find((row) => row.id === ids.writer);
        const turns = board.session_turns.filter((turn) => turn.session_id === ids.writer);
        return session?.state === 'open' && turns.length && turns.every(ended)
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
  const commitWriter = async (step, text, message) => {
    const session = await idle(`the writer to be open for ${step}`);
    await call(
      step,
      'session.send',
      { session_id: ids.writer, input: script(write(MODULE, text), { commit: message }) },
      session.revision,
    );
    await idle(`the writer to commit for ${step}`);
  };
  /** Requests a review from both reviewers, places the sentinels, and waits for it to settle. */
  const review = async (index) => {
    let release;
    round = { index, placed: new Promise((resolve) => (release = resolve)), sentinels: new Map() };
    const requested = await call(`review_${index + 1}`, 'review.request', {
      session_id: ids.writer,
      runtimes: REVIEWERS,
    });
    ids.reviews.push(requested.review_id);
    for (const sessionId of requested.session_ids) {
      const directory = path.join(
        path.dirname(writerWorktree),
        'reviews',
        requested.review_id,
        sessionId,
      );
      const sentinel = {
        path: path.join(directory, 'sentinel.txt'),
        token: `sentinel-${randomUUID()}`,
      };
      // The daemon made the reviewer directory with the request; it is not made here.
      await writeFile(sentinel.path, `${sentinel.token}\n`, { flag: 'wx' });
      round.sentinels.set(sessionId, sentinel);
    }
    release();
    return waitFor(
      async () =>
        (await reviewsOf()).find(
          (row) => row.id === requested.review_id && row.state !== 'running',
        ) ?? false,
      `review round ${index + 1} to settle`,
      WAIT_MS,
    );
  };

  try {
    for (const [kind, file] of Object.entries(records)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify({ type: 'message', text: tokens[kind] })}\n`);
    }
    fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [writer, ...reviewers], {
      intervalMs: 50,
      workspaceRoot: workspaceRoot.root,
      protectionPaths: {
        dataDir: path.join(workspace, 'daemon', 'state'),
        backupDir: path.join(workspace, 'daemon', 'backups'),
        desktopUserDataDir: path.join(home, 'Library/Application Support/Pantheon Desktop'),
        home,
        codexHome: path.join(home, '.codex'),
      },
    });
    const repo = path.join(workspace, 'repo');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Review Isolation');
    git(repo, 'config', 'user.email', 'review-isolation@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Averages\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    projectId = (await call('open', 'project.open', { name: 'Averages', roots: [repo] })).id;

    // The writer commits a reproducible defect.
    ids.writer = (
      await call('write', 'session.create', {
        project_id: projectId,
        runtime: writer.name,
        input: script(write(MODULE, DEFECT), { commit: 'Add average' }),
      })
    ).id;
    const opened = await idle('the writer to commit the defect');
    writerWorktree = (await snapshot()).workspaces.find(
      (row) => row.id === opened.workspace_id,
    ).path;

    // Round one: a quoted finding and one whose quote is not in the changes; then the code changes.
    reads.review_1 = await review(0);
    reads.reviews_before_change = await reviewsOf();
    await commitWriter('change', REWRITTEN, 'Guard the divisor of average');
    reads.reviews_after_change = await reviewsOf();

    // Round two: only one reviewer finds the defect; the user adopts it and has it fixed.
    reads.review_2 = await review(1);
    const lone = reads.review_2.findings.find((row) => row.status === 'open');
    const resolve = await send(
      'resolve',
      'review.finding.resolve',
      { review_id: reads.review_2.id, finding_id: lone?.id ?? '', outcome: 'adopted' },
      reads.review_2.revision,
    );
    reads.resolve = { status: resolve.status, data: resolve.data, command_id: resolve.command_id };
    await commitWriter('fix', FIXED, 'Divide by the count of values');
    reads.reviews_final = await reviewsOf();

    if (probes.length !== ROUNDS * REVIEWERS.length * PROBES_PER_TURN)
      throw new Error(`Isolation probes ran ${probes.length} times`);
    const all = await events();
    const recorded = all.filter((event) => event.kind === 'review.finding_recorded');
    const recordedWith = (quote) =>
      recorded.filter(
        (event) => event.aggregate_id === ids.reviews[0] && event.payload.quote === quote,
      );
    const roundOneInputs = reviewInputs.filter((row) => row.round === 0);
    const oldWith = (quote) => (reviews) =>
      reviews
        .find((row) => row.id === ids.reviews[0])
        ?.findings.filter((row) => row.quote === quote) ?? [];
    const oldValid = oldWith(VALID_QUOTE),
      oldKept = oldWith(KEPT_QUOTE);
    const finalFindings = reads.reviews_final.flatMap((row) => row.findings);
    const adopted = finalFindings.find((row) => row.id === lone?.id);
    observations.review = {
      isolation_forbidden_reads: probes.filter((probe) => probe.sentinel_seen).length,
      invalid_quote_rejected:
        roundOneInputs.length === REVIEWERS.length &&
        roundOneInputs.every(
          (row) => row.input.includes(VALID_QUOTE) && !row.input.includes(INVALID_QUOTE),
        ) &&
        recordedWith(INVALID_QUOTE).length === 1 &&
        recordedWith(INVALID_QUOTE)[0].payload.status === 'rejected' &&
        recordedWith(INVALID_QUOTE)[0].payload.reason === 'quote_not_in_artifact' &&
        recordedWith(VALID_QUOTE).length === 1 &&
        recordedWith(VALID_QUOTE)[0].payload.status === 'open',
      // The writer's head moved past the reviewed range; the product's validity is the finding's status.
      old_findings_stale:
        oldValid(reads.reviews_before_change).length === 1 &&
        oldValid(reads.reviews_before_change)[0].status === 'open' &&
        oldValid(reads.reviews_after_change).length === 1 &&
        oldValid(reads.reviews_after_change)[0].status === 'stale' &&
        oldKept(reads.reviews_before_change).length === 1 &&
        oldKept(reads.reviews_before_change)[0].status === 'open' &&
        oldKept(reads.reviews_after_change).length === 1 &&
        oldKept(reads.reviews_after_change)[0].status === 'open',
      vendor_or_vote_veto:
        resolve.status !== 200 ||
        !lone ||
        reads.review_2.findings.filter((row) => row.status === 'open').length !== 1 ||
        adopted?.resolution?.outcome !== 'adopted' ||
        adopted.resolution.resolved_by !== USER_PRINCIPAL_ID ||
        finalFindings.some((row) => row.blocking) ||
        finalFindings.some((row) => row.resolution && row.id !== lone.id) ||
        all.some(
          (event) =>
            event.kind === 'review.finding_resolved' && event.causation_id !== resolve.command_id,
        ),
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
    adapters: [writer, ...reviewers].map((adapter) => `${adapter.name}@${adapter.report.version}`),
  };

  async function collectEvidence() {
    const inputs = {
      review_ids: ids.reviews,
      input_hashes: (reads.reviews_final ?? []).map((row) => ({
        id: row.id,
        input_hash: row.input_hash,
      })),
      inputs: reviewInputs,
    };
    if (!projectId)
      return {
        'review-inputs.json': inputs,
        'isolation-probes.json': { probes },
        'finding-ledger.json': { receipts },
      };
    const all = await events();
    const reviewerSessions = new Set((reads.reviews_final ?? []).flatMap((row) => row.session_ids));
    const writeProbes = all
      .filter(
        (event) =>
          event.kind === 'agent.tool.completed' &&
          reviewerSessions.has(event.aggregate_id) &&
          String(event.payload.tool_call_id).endsWith(':0'),
      )
      .map((event) => ({
        session_id: event.aggregate_id,
        ok: event.payload.ok,
        output: event.payload.output,
      }));
    return {
      'review-inputs.json': inputs,
      'isolation-probes.json': {
        probes,
        write_probes: writeProbes,
        write_probe_file_exists: writerWorktree
          ? existsSync(path.join(writerWorktree, 'review-probe.txt'))
          : null,
        sandboxes: reviewers.flatMap((adapter) =>
          [...adapter.specs].map(([sessionId, spec]) => ({
            runtime: adapter.name,
            session_id: sessionId,
            writable_roots: spec.sandbox?.writable_roots.length ?? null,
            protected_entries: (spec.sandbox?.protected_entries ?? []).map((entry) => entry.deny),
          })),
        ),
      },
      'finding-ledger.json': {
        recorded: all.filter((event) => event.kind === 'review.finding_recorded'),
        resolved: all.filter((event) => event.kind === 'review.finding_resolved'),
        resolve: reads.resolve ?? null,
        reviews_before_change: reads.reviews_before_change ?? null,
        reviews_after_change: reads.reviews_after_change ?? null,
        reviews_final: reads.reviews_final ?? null,
        observations,
      },
      'events.json': all,
      'receipts.json': receipts,
    };
  }
}
