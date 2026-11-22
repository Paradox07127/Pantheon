import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEvent,
  AgentEventSink,
  Principal,
  Review,
  Session,
  SessionHandle,
  SessionSpec,
  SessionTurn,
  UserTurn,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

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
  emit(event: Omit<AgentEvent, 'key' | 'provider_sequence' | 'turn_id'>) {
    const session = this.starts.at(-1)!;
    session.emit({
      key: String(++this.sequence),
      provider_sequence: this.sequence,
      turn_id: session.turn!.turn_id,
      ...event,
    } as AgentEvent);
  }
  finding(location: string, quote: string) {
    this.emit({
      kind: 'tool.started',
      name: 'review.finding',
      tool_call_id: `finding-${this.sequence}`,
      input: {
        blocking: true,
        location,
        quote,
        evidence: 'It is wrong',
        impact: 'It breaks',
        reproduction: 'Run the module and read the value',
      },
    } as AgentEvent);
  }
}

/** A project whose feature branch adds src/a.ts, while main moved on after the fork. */
async function rangeFixture() {
  const w = await workbenchFixture();
  const reviewer = new ReviewerAdapter('range-reviewer');
  w.control.adapters.set(reviewer.name, reviewer);
  git(w.source, 'checkout', '--quiet', '-b', 'feature');
  mkdirSync(path.join(w.source, 'src'));
  writeFileSync(
    path.join(w.source, 'src/a.ts'),
    'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
  );
  git(w.source, 'add', '.');
  git(w.source, 'commit', '--quiet', '-m', 'Add the a module');
  git(w.source, 'checkout', '--quiet', 'main');
  writeFileSync(path.join(w.source, 'answer.txt'), 'base side change\n');
  git(w.source, 'commit', '--quiet', '-am', 'Move main on');
  const request = (input: Record<string, unknown> = {}, principal: Principal = user) =>
    (async () =>
      w.call<Promise<Review>>(
        'review.range',
        { root: w.source, base: 'main', head: 'feature', runtimes: [reviewer.name], ...input },
        null,
        principal,
      ))();
  const started = async (input: Record<string, unknown> = {}) => {
    const review = await request(input);
    await eventually(
      () => reviewer.starts[0]?.turn !== undefined,
      () => w.control.tick(),
    );
    return review;
  };
  const row = (id: string) => w.store.must<Review>('reviews', id);
  return { w, reviewer, request, started, row };
}

it('reviews the range from the merge base of base and head without a session or a requester', async () => {
  const { w, reviewer, started, row } = await rangeFixture();
  const review = await started();
  const stored = row(review.id);
  expect(stored.range).toEqual({
    source: w.source,
    from_sha: git(w.source, 'merge-base', 'main', 'feature'),
    to_sha: git(w.source, 'rev-parse', 'feature'),
  });
  expect(stored.refs).toEqual({ base: 'main', head: 'feature' });
  expect(stored).not.toHaveProperty('session_id');
  expect(stored).not.toHaveProperty('requester');
  const { spec, turn } = reviewer.starts[0]!;
  const diff = readFileSync(path.join(spec.cwd, 'changes.diff'), 'utf8');
  expect(diff).toContain('+export const c = 3;');
  expect(diff).not.toContain('base side change');
  expect(turn!.input).toContain('Add the a module');
  expect(turn!.input).toContain('path:line');
  expect(turn!.input).not.toContain('base side change');
});

it('reviews only the diff of the named paths and keeps them with the refs', async () => {
  const { w, reviewer, started, row } = await rangeFixture();
  git(w.source, 'checkout', '--quiet', 'feature');
  writeFileSync(path.join(w.source, 'notes.txt'), 'left out of this part\n');
  git(w.source, 'add', '.');
  git(w.source, 'commit', '--quiet', '-m', 'Add notes');
  git(w.source, 'checkout', '--quiet', 'main');
  const review = await started({ paths: ['src/a.ts'] });
  expect(row(review.id).refs).toEqual({ base: 'main', head: 'feature', paths: ['src/a.ts'] });
  const { spec, turn } = reviewer.starts[0]!;
  const diff = readFileSync(path.join(spec.cwd, 'changes.diff'), 'utf8');
  expect(diff).toContain('+export const c = 3;');
  expect(diff).not.toContain('left out of this part');
  expect(turn!.input).not.toContain('left out of this part');
});

it('puts the review focus into the reviewer input after the goal and before the changes', async () => {
  const { reviewer, started } = await rangeFixture();
  await started({ focus: 'Check the exported constants only' });
  const input = reviewer.starts[0]!.turn!.input as string;
  const focus = input.indexOf('Check the exported constants only');
  expect(focus).toBeGreaterThan(input.indexOf('Add the a module'));
  expect(focus).toBeLessThan(input.indexOf('+export const c = 3;'));
});

it('reviews the same range for another set of paths while the first is under review', async () => {
  const { w, request } = await rangeFixture();
  await request({ paths: ['src/a.ts'] });
  await request({ paths: ['answer.txt', 'src/a.ts'] });
  await request();
  expect(w.store.list<Review>('reviews')).toHaveLength(3);
});

it('keeps a located blocking finding of a range review blocking and records a free-text one as unlocated and not blocking', async () => {
  const { reviewer, started, row } = await rangeFixture();
  const review = await started();
  reviewer.finding('src/a.ts:3', 'export const c = 3;');
  reviewer.finding('the module as a whole', 'export const b = 2;');
  await eventually(() => row(review.id).findings.length === 2);
  const [located, unlocated] = row(review.id).findings;
  expect(located).toMatchObject({ location: 'src/a.ts:3', blocking: true, status: 'open' });
  expect(located).not.toHaveProperty('unlocated');
  expect(unlocated).toMatchObject({
    location: 'the module as a whole',
    blocking: false,
    unlocated: true,
    status: 'open',
  });
});

it.each([
  { location: 'answer.txt:9', quote: 'second', recorded: 'answer.txt:3' },
  { location: 'answer.txt:1', quote: ' fourth', recorded: 'answer.txt:4' },
  { location: 'answer.txt:2', quote: 'third', recorded: 'answer.txt:2' },
  { location: 'src/b.ts:5', quote: 'return x;', recorded: 'src/b.ts:6' },
  { location: 'src/b.ts:3-4', quote: '+return x;\n+const y = 2;', recorded: 'src/b.ts:2-3' },
  { location: 'src/missing.ts:1', quote: 'return x;', recorded: 'src/missing.ts:1' },
  { location: 'src/b.ts', quote: 'return x;', recorded: 'src/b.ts' },
])(
  'records the finding at $location quoting $quote at $recorded, the line of the quote in the new file',
  async ({ location, quote, recorded }) => {
    const { w, reviewer, started, row } = await rangeFixture();
    writeFileSync(path.join(w.source, 'answer.txt'), 'first\nsecond\nthird\nfourth\n');
    git(w.source, 'commit', '--quiet', '-am', 'Write four lines');
    git(w.source, 'checkout', '--quiet', '-b', 'located');
    writeFileSync(path.join(w.source, 'answer.txt'), 'first\nadded\nsecond\nfourth\n');
    mkdirSync(path.join(w.source, 'src'), { recursive: true });
    writeFileSync(
      path.join(w.source, 'src/b.ts'),
      'const x = 1;\nreturn x;\nconst y = 2;\nconst z = 3;\nconst w = 4;\nreturn x;\n',
    );
    git(w.source, 'add', '.');
    git(w.source, 'commit', '--quiet', '-m', 'Rework the answer');
    git(w.source, 'checkout', '--quiet', 'main');
    const review = await started({ head: 'located' });
    reviewer.finding(location, quote);
    await eventually(() => row(review.id).findings.length === 1);
    expect(row(review.id).findings[0]).toMatchObject({ location: recorded, status: 'open' });
  },
);

it('keeps a free-text blocking finding of a session review blocking', async () => {
  const w = await workbenchFixture();
  const reviewer = new ReviewerAdapter('session-reviewer');
  w.control.adapters.set(reviewer.name, reviewer);
  const session = await w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'reviewed answer\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');
  const review = await w.call<Review>('review.request', {
    session_id: session.id,
    runtimes: [reviewer.name],
  });
  await eventually(
    () => reviewer.starts[0]?.turn !== undefined,
    () => w.control.tick(),
  );
  reviewer.finding('the answer as a whole', 'reviewed answer');
  await eventually(() => w.store.must<Review>('reviews', review.id).findings.length === 1);
  const [finding] = w.store.must<Review>('reviews', review.id).findings;
  expect(finding).toMatchObject({ blocking: true, status: 'open' });
  expect(finding).not.toHaveProperty('unlocated');
});

it('reads a settled range review with its verdict and findings and tells no lead', async () => {
  const { w, reviewer, started, row } = await rangeFixture();
  const review = await started();
  const sessionId = review.session_ids[0]!;
  reviewer.finding('src/a.ts:1', 'export const a = 1;');
  await eventually(() => row(review.id).findings.length === 1);
  w.call('review.verdict', { verdict: 'fail', summary: 'Checked src/a.ts' }, null, {
    id: `session:${sessionId}`,
    role: 'reviewer',
    session_id: sessionId,
    project_id: w.project.id,
    expires_at: Date.now() + 60000,
  });
  reviewer.emit({ kind: 'turn.completed', status: 'completed' } as AgentEvent);
  await eventually(
    () => row(review.id).state === 'completed',
    () => w.control.tick(),
  );

  const read = w.control.reviewRead(user, review.id);
  expect(read).toMatchObject({
    id: review.id,
    state: 'completed',
    refs: { base: 'main', head: 'feature' },
    verdicts: [expect.objectContaining({ verdict: 'fail', summary: 'Checked src/a.ts' })],
    findings: [expect.objectContaining({ location: 'src/a.ts:1', blocking: true })],
  });
  expect(read).toHaveProperty('started_at');
  expect(read).toHaveProperty('ended_at');
  expect(read).toHaveProperty('executions');
  expect(w.store.kindEvents(w.project.id, ['lead.note_added'])).toEqual([]);
  const reviewerSessions = new Set(review.session_ids);
  expect(
    w.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => !reviewerSessions.has(turn.session_id)),
  ).toEqual([]);
  expect(() => w.control.reviewRead(user, 'no-such-review')).toThrow(
    expect.objectContaining({ code: 'not_found' }),
  );
});

const usageLimitHit = {
  kind: 'turn.completed',
  status: 'failed',
  error: 'Usage limit reached',
  error_code: 'usage_limit',
} as AgentEvent;
const turnCompleted = { kind: 'turn.completed', status: 'completed' } as AgentEvent;

function addReviewer(w: Awaited<ReturnType<typeof workbenchFixture>>, name: string) {
  const reviewer = new ReviewerAdapter(name);
  w.control.adapters.set(name, reviewer);
  return reviewer;
}

const pass = (w: Awaited<ReturnType<typeof workbenchFixture>>, sessionId: string) =>
  w.call('review.verdict', { verdict: 'pass', summary: 'Checked src/a.ts' }, null, {
    id: `session:${sessionId}`,
    role: 'reviewer',
    session_id: sessionId,
    project_id: w.project.id,
    expires_at: Date.now() + 60000,
  });

it('hands a reviewer that hit its usage limit over to the next fallback runtime not yet reviewing', async () => {
  const { w, reviewer, started, row } = await rangeFixture();
  const spare = addReviewer(w, 'spare-reviewer');
  addReviewer(w, 'last-reviewer');
  const review = await started({ fallback: [reviewer.name, spare.name, 'last-reviewer'] });
  reviewer.emit(usageLimitHit);
  await eventually(
    () => spare.starts[0]?.turn !== undefined,
    () => w.control.tick(),
  );
  const replacing = row(review.id);
  expect(replacing).toMatchObject({
    state: 'running',
    runtimes: [reviewer.name, spare.name],
    replacements: [
      {
        runtime: reviewer.name,
        session_id: review.session_ids[0],
        by: spare.name,
        reason: 'usage_limit',
      },
    ],
  });
  expect(replacing.session_ids).toHaveLength(2);
  const { spec, turn } = spare.starts[0]!;
  expect(readFileSync(path.join(spec.cwd, 'changes.diff'), 'utf8')).toContain(
    '+export const c = 3;',
  );
  expect(turn!.input).toBe(reviewer.starts[0]!.turn!.input);
  pass(w, replacing.session_ids[1]!);
  spare.emit(turnCompleted);
  await eventually(
    () => row(review.id).state !== 'running',
    () => w.control.tick(),
  );
  expect(row(review.id).state).toBe('completed');
  expect(row(review.id)).not.toHaveProperty('incomplete');
});

it('leaves a review incomplete once its fallback runtimes also hit their usage limits', async () => {
  const { w, reviewer, started, row } = await rangeFixture();
  const steady = addReviewer(w, 'steady-reviewer');
  const spare = addReviewer(w, 'spare-reviewer');
  const review = await started({ runtimes: [reviewer.name, steady.name], fallback: [spare.name] });
  await eventually(
    () => steady.starts[0]?.turn !== undefined,
    () => w.control.tick(),
  );
  reviewer.emit(usageLimitHit);
  await eventually(
    () => spare.starts[0]?.turn !== undefined,
    () => w.control.tick(),
  );
  spare.emit(usageLimitHit);
  pass(w, review.session_ids[1]!);
  steady.emit(turnCompleted);
  await eventually(
    () => row(review.id).state !== 'running',
    () => w.control.tick(),
  );
  expect(row(review.id)).toMatchObject({
    state: 'completed',
    incomplete: 'reviewer spare-reviewer failed',
    runtimes: [reviewer.name, steady.name, spare.name],
    replacements: [{ runtime: reviewer.name, by: spare.name, reason: 'usage_limit' }],
  });
});

it('does not replace a reviewer whose turn failed for a reason other than its usage limit', async () => {
  const { w, reviewer, started, row } = await rangeFixture();
  const spare = addReviewer(w, 'spare-reviewer');
  const review = await started({ fallback: [spare.name] });
  reviewer.emit({ kind: 'turn.completed', status: 'failed', error: 'Model crashed' } as AgentEvent);
  await eventually(
    () => row(review.id).state !== 'running',
    () => w.control.tick(),
  );
  expect(row(review.id)).toMatchObject({ state: 'failed', runtimes: [reviewer.name] });
  expect(row(review.id)).not.toHaveProperty('replacements');
  expect(spare.starts).toEqual([]);
});

it('skips the writer runtime among the fallback runtimes of a session review', async () => {
  const w = await workbenchFixture();
  const reviewer = addReviewer(w, 'session-reviewer');
  const spare = addReviewer(w, 'spare-reviewer');
  const session = await w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'reviewed answer\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');
  const review = await w.call<Review>('review.request', {
    session_id: session.id,
    runtimes: [reviewer.name],
    fallback: [session.runtime, spare.name],
  });
  await eventually(
    () => reviewer.starts[0]?.turn !== undefined,
    () => w.control.tick(),
  );
  reviewer.emit(usageLimitHit);
  await eventually(
    () => spare.starts[0]?.turn !== undefined,
    () => w.control.tick(),
  );
  expect(w.store.must<Review>('reviews', review.id)).toMatchObject({
    runtimes: [reviewer.name, spare.name],
    replacements: [{ runtime: reviewer.name, by: spare.name, reason: 'usage_limit' }],
  });
});

const writer: Principal = { id: 'some-writer', role: 'writer' };

it.each<
  [
    string,
    (f: Awaited<ReturnType<typeof rangeFixture>>) => Promise<unknown>,
    string,
    RegExp | undefined,
  ]
>([
  [
    'an unresolvable ref',
    (f) => f.request({ base: 'no-such-branch' }),
    'invalid_input',
    /no-such-branch/,
  ],
  [
    'a head equal to the base',
    (f) => f.request({ base: 'feature' }),
    'invalid_input',
    /No committed changes/,
  ],
  [
    'refs with no common history',
    (f) => {
      git(f.w.source, 'checkout', '--quiet', '--orphan', 'lonely');
      git(f.w.source, 'commit', '--quiet', '-m', 'Start over');
      git(f.w.source, 'checkout', '--quiet', 'main');
      return f.request({ head: 'lonely' });
    },
    'invalid_input',
    /share no history/,
  ],
  [
    'paths with no changes in the range',
    (f) => f.request({ paths: ['answer.txt'] }),
    'invalid_input',
    /No changes under the given paths/,
  ],
  [
    'a root that is not a project root',
    (f) => f.request({ root: path.dirname(f.w.source) }),
    'not_found',
    undefined,
  ],
  ['a principal other than the user', (f) => f.request({}, writer), 'permission_denied', undefined],
  [
    'a fallback runtime that is not available',
    (f) => f.request({ fallback: ['no-such-runtime'] }),
    'unsupported_capability',
    /no-such-runtime/,
  ],
  [
    'a ref that looks like an option',
    (f) => f.request({ base: `--output=${path.join(f.w.root, 'leaked')}` }),
    'invalid_input',
    /--output=/,
  ],
  [
    'a range already under review',
    async (f) => {
      await f.request();
      return f.request();
    },
    'resource_busy',
    undefined,
  ],
  [
    'the same paths of a range already under review',
    async (f) => {
      await f.request({ paths: ['src/a.ts', 'answer.txt'] });
      return f.request({ paths: ['answer.txt', 'src/a.ts'] });
    },
    'resource_busy',
    undefined,
  ],
])('rejects %s and starts no other review', async (_name, run, code, message) => {
  const f = await rangeFixture();
  const error = await run(f).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toMatchObject({ code });
  if (message) expect((error as Error).message).toMatch(message);
  expect(f.w.store.list<Review>('reviews')).toHaveLength(code === 'resource_busy' ? 1 : 0);
  expect(existsSync(path.join(f.w.root, 'leaked'))).toBe(false);
});
