import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { startDaemon } from '@pantheon/daemon';
import { command } from '@pantheon/protocol';
import type {
  AgentEvent,
  AgentEventSink,
  Principal,
  Project,
  Review,
  ReviewMetrics,
  Session,
  SessionHandle,
  SessionSpec,
  SessionTurn,
  UserTurn,
} from '@pantheon/domain';
import { awaitWorkspaceReady, countingGit, eventually, gitRunsOf, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const content = "return title.toLowerCase().replace(/[^a-z0-9]+/g, '-');\n";
const finding = {
  blocking: false,
  location: 'src/slug.js:6',
  quote: content.trim(),
  evidence: 'Surrounding whitespace produces leading and trailing dashes',
  impact: 'The generated URL has unwanted dashes',
};

class ReviewerAdapter extends FixtureAdapter {
  starts: { spec: SessionSpec; emit: AgentEventSink; handle: SessionHandle; turn?: UserTurn }[] =
    [];
  sequence = 0;
  constructor(name: string) {
    super();
    this.name = name;
  }
  override async start(spec: SessionSpec, emit: AgentEventSink) {
    const handle = {
      platform_session_id: spec.platform_session_id,
      native_session_id: `native-${spec.platform_session_id}`,
      adapter_version: '1',
      device_id: 'local',
    };
    this.starts.push({ spec, emit, handle });
    return handle;
  }
  override async send(handle: SessionHandle, turn: UserTurn) {
    this.starts.find((s) => s.handle === handle)!.turn = turn;
    return { turn_id: turn.turn_id, status: 'delivered' as const };
  }
  finding(input: unknown) {
    const session = this.starts.at(-1)!;
    ++this.sequence;
    session.emit({
      key: String(this.sequence),
      provider_sequence: this.sequence,
      turn_id: session.turn!.turn_id,
      kind: 'tool.started',
      name: 'review.finding',
      tool_call_id: `finding-${this.sequence}`,
      input,
    } as AgentEvent);
  }
  override async cancel(_handle: SessionHandle, deadline: number) {
    return {
      stopped: true,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none' as const, members: [] },
    };
  }
}

/** A workbench session that committed src/slug.js, with two reviewer runtimes ready to review it. */
async function sessionReviewFixture() {
  const w = await workbenchFixture();
  const reviewers = [new ReviewerAdapter('reviewer-one'), new ReviewerAdapter('reviewer-two')];
  for (const adapter of reviewers) w.control.adapters.set(adapter.name, adapter);
  const session = await w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  mkdirSync(path.join(workspace.path, 'src'));
  writeFileSync(path.join(workspace.path, 'src/slug.js'), content);
  git(workspace.path, 'add', '.');
  git(workspace.path, 'commit', '--quiet', '-m', 'Add slugify');
  const request = async (runtimes = reviewers.map((a) => a.name)) => {
    const review = await w.call<Review>('review.request', { session_id: session.id, runtimes });
    await eventually(
      () => reviewers.every((adapter) => adapter.starts[0]?.turn !== undefined),
      () => w.control.tick(),
    );
    return review;
  };
  const row = (review: Review) => w.store.must<Review>('reviews', review.id);
  const resolve = (
    review: Review,
    findingId: string,
    outcome: 'fixed' | 'intentional' | 'not_worth_it' | 'wrong',
    extra: { note?: string } = {},
    principal: Principal = user,
    revision = row(review).revision,
  ) =>
    w.call<Review>(
      'review.finding.resolve',
      { review_id: review.id, finding_id: findingId, outcome, ...extra },
      revision,
      principal,
    );
  /** Commits the reviewed file with new text, unless it is undefined, then has the writer run a turn. */
  const writerTurn = async (text?: string) => {
    if (text !== undefined) {
      writeFileSync(path.join(workspace.path, 'src/slug.js'), text);
      git(workspace.path, 'commit', '--quiet', '-am', 'Change slugify');
    }
    const turn = w.call<SessionTurn>(
      'session.send',
      { session_id: session.id, input: 'Check the slug again' },
      w.store.must<Session>('sessions', session.id).revision,
    );
    await eventually(
      () => w.store.must<SessionTurn>('session_turns', turn.id).state === 'completed',
      () => w.control.tick(),
    );
  };
  return { ...w, reviewers, request, row, resolve, workspace, writerTurn };
}

it('records a fixed or wrong outcome on open session review findings and emits review.finding_resolved', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request();
  f.reviewers[0]!.finding(finding);
  f.reviewers[1]!.finding({ ...finding, location: 'src/slug.js:7' });
  const [first, second] = f.row(review).findings;
  expect([first!.status, second!.status]).toEqual(['open', 'open']);
  const before = f.store.now();
  const fixed = f.resolve(review, first!.id, 'fixed', { note: 'Fixed by trimming first' });
  const after = f.store.now();
  expect(fixed.revision).toBe(f.row(review).revision);
  const resolution = f.row(review).findings[0]!.resolution!;
  expect(resolution).toEqual({
    outcome: 'fixed',
    note: 'Fixed by trimming first',
    resolved_at: expect.any(Number),
    resolved_by: user.id,
  });
  expect(resolution.resolved_at).toBeGreaterThanOrEqual(before);
  expect(resolution.resolved_at).toBeLessThanOrEqual(after);
  expect(f.row(review).findings[1]!.resolution).toBeUndefined();
  f.resolve(review, second!.id, 'wrong');
  expect(f.row(review).findings[1]!.resolution).toEqual({
    outcome: 'wrong',
    resolved_at: expect.any(Number),
    resolved_by: user.id,
  });
  expect(
    f.store
      .events()
      .filter((e) => e.kind === 'review.finding_resolved')
      .map((e) => ({ aggregate: e.aggregate_id, payload: e.payload })),
  ).toEqual([
    { aggregate: review.id, payload: { finding_id: first!.id, outcome: 'fixed' } },
    { aggregate: review.id, payload: { finding_id: second!.id, outcome: 'wrong' } },
  ]);
});

it('refuses to resolve a session review finding that was rejected', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request();
  f.reviewers[0]!.finding({ ...finding, quote: 'not in the changes' });
  const [rejected] = f.row(review).findings;
  expect(rejected!.status).toBe('rejected');
  const before = f.row(review);
  expect(() => f.resolve(review, rejected!.id, 'fixed')).toThrow(
    expect.objectContaining({
      code: 'invalid_state',
      message: expect.stringContaining('rejected'),
    }),
  );
  expect(f.row(review)).toEqual(before);
});

it('replaces the outcome of a resolved finding and records the previous one in the event', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request();
  f.reviewers[0]!.finding(finding);
  const [open] = f.row(review).findings;
  f.resolve(review, open!.id, 'fixed', { note: 'Recorded by mistake' });
  const previous = f.row(review).findings[0]!.resolution!;
  f.resolve(review, open!.id, 'wrong');
  expect(f.row(review).findings[0]!.resolution).toEqual({
    outcome: 'wrong',
    resolved_at: expect.any(Number),
    resolved_by: user.id,
  });
  expect(
    f.store
      .events()
      .filter((e) => e.kind === 'review.finding_resolved')
      .map((e) => e.payload),
  ).toEqual([
    { finding_id: open!.id, outcome: 'fixed' },
    { finding_id: open!.id, outcome: 'wrong', previous },
  ]);
});

it('resolves a session review finding that went stale after a later commit', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request();
  f.reviewers[0]!.finding({ ...finding, quote: 'title.toLowerCase()' });
  await f.writerTurn(content.replace('title.', 'title.trim().'));
  await eventually(() => f.row(review).findings[0]!.status === 'stale');
  f.resolve(review, f.row(review).findings[0]!.id, 'fixed');
  expect(f.row(review).findings[0]).toMatchObject({
    status: 'stale',
    resolution: { outcome: 'fixed', resolved_by: user.id },
  });
});

it('refuses session review finding resolution from a principal other than the user', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request();
  f.reviewers[0]!.finding(finding);
  const open = f.row(review).findings[0]!;
  const planner: Principal = {
    id: 'finding-resolver',
    role: 'planner',
    project_id: f.project.id,
  };
  expect(() => f.resolve(review, open.id, 'fixed', {}, planner)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(f.row(review).findings[0]!.resolution).toBeUndefined();
});

it('refuses session review finding resolution against a review revision that is not current', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request();
  f.reviewers[0]!.finding(finding);
  const current = f.row(review);
  expect(() =>
    f.resolve(review, current.findings[0]!.id, 'fixed', {}, user, current.revision - 1),
  ).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
  expect(f.row(review)).toEqual(current);
});

it('marks an open finding stale once a new commit of the reviewed session no longer has its quote', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request();
  const changed = 'title.toLowerCase()';
  const kept = ".replace(/[^a-z0-9]+/g, '-')";
  f.reviewers[0]!.finding({ ...finding, quote: changed });
  f.reviewers[0]!.finding({ ...finding, quote: kept });
  f.reviewers[1]!.finding({ ...finding, quote: changed });
  f.reviewers[1]!.finding({ ...finding, quote: 'not in the changes' });
  const [gone, stays, resolved, rejected] = f.row(review).findings.map((row) => row.id);
  f.resolve(review, resolved!, 'fixed');
  const staleEvents = () =>
    f.store.events().filter((event) => event.kind === 'review.finding_marked_stale');
  const statuses = () => f.row(review).findings.map((row) => row.status);

  await f.writerTurn();
  expect(statuses()).toEqual(['open', 'open', 'open', 'rejected']);
  expect(staleEvents()).toEqual([]);

  await f.writerTurn(content.replace('title.', 'title.trim().'));
  const head = git(f.workspace.path, 'rev-parse', 'HEAD');
  await eventually(() => statuses()[0] === 'stale');
  expect(statuses()).toEqual(['stale', 'open', 'open', 'rejected']);
  expect(f.row(review).findings[2]!.resolution?.outcome).toBe('fixed');
  expect(staleEvents().map((event) => [event.aggregate_id, event.payload])).toEqual([
    [review.id, { finding_id: gone, to_sha: head }],
  ]);

  await f.writerTurn(
    `// Turns a title into a URL slug.\n${content.replace('title.', 'title.trim().')}`,
  );
  expect(statuses()).toEqual(['stale', 'open', 'open', 'rejected']);
  expect(staleEvents()).toHaveLength(1);
});

it('marks a finding stale on recording when the reviewed session already moved past its quote', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request();
  await f.writerTurn(content.replace('title.', 'title.trim().'));
  f.reviewers[0]!.finding({ ...finding, quote: 'title.toLowerCase()' });
  f.reviewers[0]!.finding({ ...finding, quote: ".replace(/[^a-z0-9]+/g, '-')" });
  await eventually(() => f.row(review).findings[0]!.status === 'stale');
  expect(f.row(review).findings.map((row) => row.status)).toEqual(['stale', 'open']);
});

it('reads the diff for stale findings without blocking the daemon, only for the files they name', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request();
  f.reviewers[0]!.finding({ ...finding, quote: 'title.toLowerCase()' });
  writeFileSync(
    path.join(f.workspace.path, 'src/slug.js'),
    content.replace('title.', 'title.trim().'),
  );
  writeFileSync(path.join(f.workspace.path, 'src/other.js'), 'other();\n');
  git(f.workspace.path, 'add', '-A');
  git(f.workspace.path, 'commit', '--quiet', '-m', 'Change slugify');
  const head = git(f.workspace.path, 'rev-parse', 'HEAD');
  const range = `--no-color --no-ext-diff ${f.workspace.base_sha} ${head}`;
  const runs = countingGit();
  try {
    runs.slowOn(range);
    let during = 0;
    const timer = setInterval(() => {
      const log = runs.log();
      if (log.includes('slow start') && !log.includes('slow done')) during++;
    }, 50);
    await f.writerTurn();
    await eventually(() => f.row(review).findings[0]!.status === 'stale');
    clearInterval(timer);
    expect(during).toBeGreaterThan(0);
    const diffs = gitRunsOf(runs.runs(), 'diff').filter((args) => args.includes(range));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatch(/ -- src\/slug\.js$/);
  } finally {
    runs.restore();
  }
});

const zero = {
  reviews: 1,
  reviews_without_findings: 0,
  findings: 0,
  fixed: 0,
  intentional: 0,
  not_worth_it: 0,
  wrong: 0,
  unresolved: 0,
  invalid: 0,
};

it('reports session review precision per runtime and counts a runtime with only rejected findings as without findings', async () => {
  const f = await sessionReviewFixture();
  const review = await f.request(['reviewer-two', 'reviewer-one']);
  const [one, two] = f.reviewers;
  one!.finding(finding);
  one!.finding({ ...finding, location: 'src/slug.js:7' });
  one!.finding({ ...finding, location: 'src/slug.js:8' });
  one!.finding({ ...finding, location: 'src/slug.js:9' });
  one!.finding({ ...finding, location: 'src/slug.js:10' });
  one!.finding({ ...finding, location: 'src/slug.js:11' });
  one!.finding({ ...finding, quote: 'not in the changes' });
  two!.finding({ ...finding, quote: 'also not in the changes' });
  const [fixed, intentional, notWorthIt, wrong] = f.row(review).findings;
  f.resolve(review, fixed!.id, 'fixed');
  f.resolve(review, intentional!.id, 'intentional');
  f.resolve(review, notWorthIt!.id, 'not_worth_it');
  f.resolve(review, wrong!.id, 'wrong');
  expect(f.control.projectReviewMetrics(user, f.project.id)).toEqual<ReviewMetrics[]>([
    {
      ...zero,
      runtime: 'reviewer-one',
      findings: 7,
      fixed: 1,
      intentional: 1,
      not_worth_it: 1,
      wrong: 1,
      unresolved: 2,
      invalid: 1,
    },
    {
      ...zero,
      runtime: 'reviewer-two',
      reviews_without_findings: 1,
      findings: 1,
      invalid: 1,
    },
  ]);
});

it('serves review metrics at the project.review.metrics query', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-metrics-'));
  const work = path.join(root, 'project');
  mkdirSync(work);
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [],
    intervalMs: 60000,
  });
  try {
    const project = (await daemon.control.execute(
      user,
      command(user.id, 'project.open', { name: 'Metrics query', roots: [work] }, null),
    )) as Project;
    daemon.store.insert<Review>('reviews', {
      id: 'query-review',
      revision: 1,
      project_id: project.id,
      round: 1,
      runtimes: ['reviewer-one'],
      state: 'completed',
      session_ids: [],
      findings: [
        {
          id: 'query-finding',
          review_id: 'query-review',
          runtime: 'reviewer-one',
          round: 1,
          ...finding,
          status: 'open',
          blocking: false,
        },
      ],
    });
    const response = await fetch(
      `${daemon.url}/v1/project.review.metrics?project_id=${project.id}`,
      { headers: { Authorization: `Bearer ${daemon.token}` } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { ...zero, runtime: 'reviewer-one', findings: 1, unresolved: 1 },
    ]);
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});
