import { afterEach, expect, it } from 'vitest';
import {
  DomainError,
  type Improvement,
  type Principal,
  type Retrospective,
  type Session,
  type WorkflowPolicy,
} from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const retrospectiveIds = ['retrospective-1', 'retrospective-2'];

async function opened() {
  const f = await fixture();
  fixtures.push(f);
  const session = (id: string, task?: Session['task']) =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      state: 'open',
      turn_count: 1,
      workspace_id: `${id}-workspace`,
      ...(task && { task }),
    });
  session('lead');
  session('worker', { lead_session_id: 'lead', id: 'api' });
  for (const [index, retrospectiveId] of retrospectiveIds.entries())
    f.store.insert<Retrospective>('retrospectives', {
      id: retrospectiveId,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: `task-${index}`,
      session_ids: [],
      outcome: 'merged',
      recorded_at: index + 1,
    });
  return f;
}

const principalOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});
const policyOf = (f: Fixture) => f.control.workflowPolicy(user, f.project.id) as WorkflowPolicy;
const policyEvents = (f: Fixture) =>
  f.store.events(0, f.project.id).filter((event) => event.kind === 'workflow.policy_changed');
const statusEvents = (f: Fixture) =>
  f.store.events(0, f.project.id).filter((event) => event.kind === 'improvement.status_changed');

function setPolicy(f: Fixture, input: Record<string, unknown>) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call('workflow.policy.set', { project_id: f.project.id, ...input }, row?.revision ?? null);
}
function propose(
  f: Fixture,
  change: Record<string, unknown>,
  principal = principalOf(f, 'lead', 'lead'),
  retrospective_ids = retrospectiveIds,
) {
  return f.call<Improvement>(
    'improvement.propose',
    { project_id: f.project.id, retrospective_ids, change },
    null,
    principal,
  );
}
function decide(f: Fixture, improvement: Improvement, decision: string, principal = user) {
  return f.call<Improvement>(
    'improvement.decide',
    { project_id: f.project.id, improvement_id: improvement.id, decision },
    null,
    principal,
  );
}
const stored = (f: Fixture, improvement: Improvement) =>
  f.store.must<Improvement>('improvements', improvement.id);
function refused(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('The command was accepted');
}

const fewerParallel = { type: 'policy_change', param: 'max_parallel', to: 2 };

it('starts the trial of a lead proposal at once in auto mode and changes the policy', async () => {
  const f = await opened();
  const improvement = propose(f, fewerParallel);
  expect(improvement).toMatchObject({
    status: 'trial',
    source: 'lead',
    lead_session_id: 'lead',
    retrospective_ids: retrospectiveIds,
    change: { type: 'policy_change', param: 'max_parallel', from: 3, to: 2 },
  });
  expect(improvement.trial_started_at).toBeTypeOf('number');
  expect(policyOf(f)).toMatchObject({ max_parallel: 2, policy_version: 1 });
  expect(policyEvents(f).map((event) => event.payload)).toEqual([
    {
      param: 'max_parallel',
      from: 3,
      to: 2,
      by: 'improvement',
      improvement_id: improvement.id,
      policy_version: 1,
    },
  ]);
  expect(statusEvents(f).map((event) => event.payload)).toEqual([
    { improvement_id: improvement.id, from: 'candidate', to: 'trial' },
  ]);
});

it('holds a proposal as a candidate in confirm mode until the user confirms it', async () => {
  const f = await opened();
  setPolicy(f, { improvement_mode: 'confirm' });
  const improvement = propose(f, fewerParallel);
  expect(improvement.status).toBe('candidate');
  expect(policyOf(f)).toMatchObject({ max_parallel: 3, policy_version: 1 });
  expect(decide(f, improvement, 'confirm').status).toBe('trial');
  expect(policyOf(f)).toMatchObject({ max_parallel: 2, policy_version: 2 });
  expect(stored(f, improvement).trial_started_at).toBeTypeOf('number');
});

it('restores the former value when the user reverts a trial', async () => {
  const f = await opened();
  const improvement = propose(f, fewerParallel);
  const reverted = decide(f, improvement, 'revert');
  expect(reverted.status).toBe('reverted');
  expect(reverted.decided_at).toBeTypeOf('number');
  expect(policyOf(f)).toMatchObject({ max_parallel: 3, policy_version: 2 });
});

it('keeps a value the user changed since the trial started when the trial is reverted', async () => {
  const f = await opened();
  const improvement = propose(f, fewerParallel);
  setPolicy(f, { max_parallel: 1 });
  const reverted = decide(f, improvement, 'revert');
  expect(reverted.status).toBe('reverted');
  expect(reverted.status_detail).toBeTruthy();
  expect(policyOf(f)).toMatchObject({ max_parallel: 1, policy_version: 2 });
});

it('pins the parameter of a trial, makes it active and refuses later proposals for it', async () => {
  const f = await opened();
  const improvement = propose(f, fewerParallel);
  const pinned = decide(f, improvement, 'pin');
  expect(pinned.status).toBe('active');
  expect(pinned.decided_at).toBeTypeOf('number');
  expect(policyOf(f)).toMatchObject({ max_parallel: 2, pinned: ['max_parallel'] });
  expect(refused(() => propose(f, { ...fewerParallel, to: 1 })).code).toBe('permission_denied');
});

it('refuses proposals while improvements are off', async () => {
  const f = await opened();
  setPolicy(f, { improvement_mode: 'off' });
  expect(refused(() => propose(f, fewerParallel)).code).toBe('permission_denied');
  expect(f.store.list('improvements')).toEqual([]);
});

it('refuses a proposal that rests on a retrospective that does not exist', async () => {
  const f = await opened();
  const error = refused(() => propose(f, fewerParallel, undefined, ['retrospective-1', 'ghost']));
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('ghost');
});

const proposeOn = (f: Fixture, evidence: { kind: string; id: string }[]) =>
  f.call<Improvement>(
    'improvement.propose',
    { project_id: f.project.id, evidence, change: fewerParallel },
    null,
    principalOf(f, 'lead', 'lead'),
  );

it('accepts a proposal that cites two gate runs of the project instead of retrospectives', async () => {
  const f = await opened();
  const worker = f.store.must<Session>('sessions', 'worker');
  const runs = [1, 2].map((attempt) => ({
    kind: 'gate_run',
    id: f.store.event('session.gate_checked', worker, f.project.id, {
      results: [{ name: 'test', exit_code: 127, output: `pnpm: not found (${attempt})` }],
    }).event_id,
  }));
  expect(proposeOn(f, runs)).toMatchObject({
    status: 'trial',
    retrospective_ids: [],
    evidence: runs,
  });
});

it('refuses a proposal that cites a session of another project', async () => {
  const f = await opened();
  f.store.insert<Session>('sessions', {
    id: 'elsewhere',
    revision: 1,
    project_id: 'other-project',
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 1,
    workspace_id: 'elsewhere-workspace',
  });
  const error = refused(() =>
    proposeOn(f, [
      { kind: 'session', id: 'worker' },
      { kind: 'session', id: 'elsewhere' },
    ]),
  );
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('elsewhere');
  expect(f.store.list('improvements')).toEqual([]);
});

it('refuses a second proposal for a parameter whose trial is running', async () => {
  const f = await opened();
  propose(f, fewerParallel);
  expect(refused(() => propose(f, { ...fewerParallel, to: 1 })).code).toBe('invalid_state');
});

it('refuses a value outside the allowed range and a value equal to the current one', async () => {
  const f = await opened();
  expect(refused(() => propose(f, { ...fewerParallel, to: 9 })).code).toBe('invalid_input');
  expect(refused(() => propose(f, { ...fewerParallel, to: 3 })).code).toBe('invalid_input');
});

it('starts the trial of a handback limit proposal at once in auto mode', async () => {
  const f = await opened();
  const handback = propose(f, { type: 'policy_change', param: 'handback_limit', to: 4 });
  expect(handback.status).toBe('trial');
  expect(policyOf(f)).toMatchObject({ handback_limit: 4, policy_version: 1 });
});

it('starts the trial of a lead experience at once in auto mode and holds it for the user in confirm mode', async () => {
  const f = await opened();
  const change = {
    type: 'experience',
    domain: 'backend-logic',
    procedure: 'Run the migration check before the gate',
  };
  const tried = propose(f, change);
  expect(tried.status).toBe('trial');
  expect(tried.trial_started_at).toBeTypeOf('number');
  expect(statusEvents(f).map((event) => event.payload)).toEqual([
    { improvement_id: tried.id, from: 'candidate', to: 'trial' },
  ]);
  setPolicy(f, { improvement_mode: 'confirm' });
  const held = propose(f, { ...change, procedure: 'Read the schema before the migration' });
  expect(held.status).toBe('candidate');
  expect(stored(f, held).trial_started_at).toBeUndefined();
});

it.each([
  [
    'gate command',
    { type: 'gate_command', root: '/repo', to: [{ name: 'test', argv: ['pnpm', 'test'] }] },
  ],
  ['worktree setup', { type: 'worktree_setup', to: { copy_paths: ['.env'] } }],
])('holds a lead proposal of a %s change for the user', async (_, change) => {
  const f = await opened();
  setPolicy(f, { improvement_mode: 'confirm' });
  expect(propose(f, change).status).toBe('candidate');
  expect(f.store.list('improvements')).toHaveLength(1);
});

it('lists a policy improvement as tried before it stays', async () => {
  const f = await opened();
  propose(f, fewerParallel);
  expect(f.control.improvementList(user, f.project.id)[0]?.grade).toBe('trial');
});

it('lets only a lead propose and only the user decide', async () => {
  const f = await opened();
  expect(refused(() => propose(f, fewerParallel, user)).code).toBe('permission_denied');
  expect(refused(() => propose(f, fewerParallel, principalOf(f, 'worker', 'worker'))).code).toBe(
    'permission_denied',
  );
  setPolicy(f, { improvement_mode: 'confirm' });
  const improvement = propose(f, fewerParallel);
  expect(
    refused(() => decide(f, improvement, 'confirm', principalOf(f, 'lead', 'lead'))).code,
  ).toBe('permission_denied');
  expect(stored(f, improvement).status).toBe('candidate');
});

it('changes only the named tier of the path', async () => {
  const f = await opened();
  const improvement = propose(f, {
    type: 'policy_change',
    param: 'path',
    tier: 't2',
    to: 'direct',
  });
  expect(improvement.change).toMatchObject({ param: 'path', tier: 't2', from: 'dispatch' });
  expect(policyOf(f).path).toEqual({ t1: 'direct', t2: 'direct', t3: 'dispatch' });
});

it('refuses a proposal that makes parallel a tier path, when proposed and when applied', async () => {
  const f = await opened();
  const toParallel = { type: 'policy_change', param: 'path', tier: 't2', to: 'parallel' };
  expect(refused(() => propose(f, toParallel)).code).toBe('invalid_input');
  expect(policyOf(f).path.t2).toBe('dispatch');
  expect(f.store.list<Improvement>('improvements')).toEqual([]);
  setPolicy(f, { improvement_mode: 'confirm' });
  const candidate = propose(f, { ...toParallel, to: 'direct' });
  f.store.update<Improvement>(
    'improvements',
    { ...candidate, change: { ...candidate.change, to: 'parallel' } as Improvement['change'] },
    candidate.revision,
  );
  expect(refused(() => decide(f, stored(f, candidate), 'confirm')).code).toBe('invalid_input');
  expect(policyOf(f).path.t2).toBe('dispatch');
});

it('refuses a decision that does not fit the status', async () => {
  const f = await opened();
  const improvement = propose(f, fewerParallel);
  expect(refused(() => decide(f, improvement, 'confirm')).code).toBe('invalid_state');
  expect(refused(() => decide(f, improvement, 'reject')).code).toBe('invalid_state');
});

it('lists improvements newest first and by status', async () => {
  let now = 1_000;
  const f = await fixture({ now: () => now });
  fixtures.push(f);
  f.store.insert<Session>('sessions', {
    id: 'lead',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 1,
    workspace_id: 'lead-workspace',
  });
  for (const retrospectiveId of retrospectiveIds)
    f.store.insert<Retrospective>('retrospectives', {
      id: retrospectiveId,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: retrospectiveId,
      session_ids: [],
      outcome: 'merged',
      recorded_at: now,
    });
  const trial = propose(f, fewerParallel);
  setPolicy(f, { improvement_mode: 'confirm' });
  now += 1_000;
  const candidate = propose(f, { type: 'experience', procedure: 'Read the schema first' });
  now += 1_000;
  const rejected = propose(f, { type: 'experience', procedure: 'Run the linter first' });
  decide(f, rejected, 'reject');
  const ids = (status?: Improvement['status']) =>
    f.control.improvementList(user, f.project.id, status).map((row) => row.id);
  expect(ids()).toEqual([rejected.id, candidate.id, trial.id]);
  expect(ids('candidate')).toEqual([candidate.id]);
  expect(ids('rejected')).toEqual([rejected.id]);
  expect(stored(f, rejected).decided_at).toBe(now);
});

it.each([
  ['runtime_quota_threshold', 80],
  ['budget', { t2: { dispatch: { input_tokens: 500000, wall_ms: 200000 } } }],
])('trials and pins a %s proposal and refuses another change while pinned', async (param, to) => {
  const f = await opened();
  const previous = policyOf(f)[param as 'runtime_quota_threshold' | 'budget'];
  const improvement = propose(f, { type: 'policy_change', param, to });
  expect(stored(f, improvement)).toMatchObject({
    status: 'trial',
    change: { param, from: previous, to },
  });
  expect(policyOf(f)[param as 'runtime_quota_threshold' | 'budget']).toEqual(to);
  decide(f, improvement, 'pin');
  expect(policyOf(f).pinned).toContain(param);
  expect(refused(() => propose(f, { type: 'policy_change', param, to: previous })).code).toBe(
    'permission_denied',
  );
});

it('stores a trimmed rejection reason and note beside the status reason', async () => {
  const f = await opened();
  setPolicy(f, { improvement_mode: 'confirm' });
  const improvement = propose(f, { type: 'experience', procedure: 'Read the schema first' });
  f.call('improvement.decide', {
    project_id: f.project.id,
    improvement_id: improvement.id,
    decision: 'reject',
    reject_reason: 'duplicate',
    reject_note: '  Already covered by our schema rule.  ',
  });
  expect(f.control.improvementList(user, f.project.id)[0]).toMatchObject({
    status: 'rejected',
    reject_reason: 'duplicate',
    reject_note: 'Already covered by our schema rule.',
    source: 'lead',
    lead_session_id: 'lead',
    retrospective_ids: retrospectiveIds,
  });
  expect(stored(f, improvement)).toMatchObject({ reject_reason: 'duplicate' });
});

it('keeps disabling hand-backs out of proposals and restores the user setting after a trial', async () => {
  const f = await opened();
  expect(
    refused(() => propose(f, { type: 'policy_change', param: 'handback_limit', to: 0 })).code,
  ).toBe('invalid_input');
  expect(f.store.list<Improvement>('improvements')).toEqual([]);
  setPolicy(f, { handback_limit: 0 });
  const improvement = propose(f, { type: 'policy_change', param: 'handback_limit', to: 4 });
  expect(policyOf(f).handback_limit).toBe(4);
  decide(f, improvement, 'revert');
  expect(policyOf(f).handback_limit).toBe(0);
});
