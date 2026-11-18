import { afterEach, expect, it } from 'vitest';
import {
  DomainError,
  type Improvement,
  type Principal,
  type Project,
  type Retrospective,
  type Session,
} from '@pantheon/domain';
import { fixture } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const retrospectiveIds = ['retrospective-1', 'retrospective-2'];

async function opened() {
  const f = await fixture();
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

const lead = (f: Fixture): Principal => ({
  id: 'session:lead',
  role: 'lead',
  project_id: f.project.id,
  session_id: 'lead',
  expires_at: f.store.now() + 60000,
});
const project = (f: Fixture) => f.store.must<Project>('projects', f.project.id);
const propose = (f: Fixture, change: Record<string, unknown>) =>
  f.call<Improvement>(
    'improvement.propose',
    { project_id: f.project.id, retrospective_ids: retrospectiveIds, change },
    null,
    lead(f),
  );
const decide = async (f: Fixture, improvement: Improvement, decision: 'confirm' | 'revert') =>
  await f.call<Improvement | Promise<Improvement>>('improvement.decide', {
    project_id: f.project.id,
    improvement_id: improvement.id,
    decision,
  });
const setGate = async (f: Fixture, commands: unknown[]) =>
  await f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.project.roots[0], commands },
    project(f).revision,
  );
const setWorktree = (f: Fixture, worktree: Record<string, unknown>) =>
  f.call('project.worktree.set', { project_id: f.project.id, ...worktree }, project(f).revision);

const earlier = [{ name: 'lint', argv: ['pnpm', 'lint'] }];
const proposed = [{ name: 'test', argv: ['pnpm', 'test'] }];
const gateChange = (f: Fixture) => ({
  type: 'gate_command',
  root: f.project.roots[0],
  to: proposed,
});

it('sets the root gate when the user confirms a gate change, and keeps it without a trial', async () => {
  const f = await opened();
  const confirmed = await decide(f, propose(f, gateChange(f)), 'confirm');
  expect(confirmed.status).toBe('active');
  expect(confirmed.trial_started_at).toBeUndefined();
  expect(confirmed.decided_at).toBeTypeOf('number');
  expect(project(f).gates?.[f.project.roots[0]!]).toEqual(proposed);
});

it('restores the earlier gate commands when the user reverts a confirmed gate change', async () => {
  const f = await opened();
  await setGate(f, earlier);
  const confirmed = await decide(f, propose(f, gateChange(f)), 'confirm');
  const reverted = await decide(f, confirmed, 'revert');
  expect(reverted.status).toBe('reverted');
  expect(reverted.status_detail).toBeUndefined();
  expect(project(f).gates?.[f.project.roots[0]!]).toEqual(earlier);
});

it('keeps the gate commands the user set after the confirmation when the change is reverted', async () => {
  const f = await opened();
  const confirmed = await decide(f, propose(f, gateChange(f)), 'confirm');
  const own = [{ name: 'check', argv: ['pnpm', 'check'] }];
  await setGate(f, own);
  const reverted = await decide(f, confirmed, 'revert');
  expect(reverted.status).toBe('reverted');
  expect(reverted.status_detail).toBeTruthy();
  expect(project(f).gates?.[f.project.roots[0]!]).toEqual(own);
});

it('holds a lead gate proposal for the user in auto mode', async () => {
  const f = await opened();
  const improvement = propose(f, gateChange(f));
  expect(improvement.status).toBe('candidate');
  expect(project(f).gates).toBeUndefined();
});

it('refuses a second gate proposal for a root whose change waits', async () => {
  const f = await opened();
  propose(f, gateChange(f));
  let error: unknown;
  try {
    propose(f, { ...gateChange(f), to: earlier });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe('invalid_state');
});

it('sets the worktree setup when the user confirms a worktree change, and restores it on revert', async () => {
  const f = await opened();
  setWorktree(f, { copy_paths: ['.env'] });
  const improvement = propose(f, {
    type: 'worktree_setup',
    to: { copy_paths: ['.env.local'], command: { argv: ['pnpm', 'install'] } },
  });
  expect(improvement.status).toBe('candidate');
  const confirmed = await decide(f, improvement, 'confirm');
  expect(confirmed.status).toBe('active');
  expect(project(f).worktree).toEqual({
    copy_paths: ['.env.local'],
    command: { argv: ['pnpm', 'install'] },
  });
  expect((await decide(f, confirmed, 'revert')).status).toBe('reverted');
  expect(project(f).worktree).toEqual({ copy_paths: ['.env'] });
});
