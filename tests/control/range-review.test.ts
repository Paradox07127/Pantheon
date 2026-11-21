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
  const started = async () => {
    const review = await request();
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

const lead: Principal = { id: 'some-lead', role: 'lead' };

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
    'a root that is not a project root',
    (f) => f.request({ root: path.dirname(f.w.source) }),
    'not_found',
    undefined,
  ],
  ['a principal other than the user', (f) => f.request({}, lead), 'permission_denied', undefined],
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
