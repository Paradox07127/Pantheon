import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  DomainError,
  hash,
  type AgentProfile,
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

const addHelper = (f: Fixture) =>
  f.store.insert<AgentProfile>('agents', {
    id: 'helper',
    revision: 1,
    project_id: f.project.id,
    template: 'custom',
    name: 'Helper',
    role: 'Help',
    instructions: 'Answer with the reasons.',
    routines: [],
    created_by: { kind: 'user' },
    created_at: f.store.now(),
  });
const helper = (f: Fixture) => f.store.must<AgentProfile>('agents', 'helper');
const oneLine = { type: 'agent_instructions', agent_id: 'helper', to: 'Answer in one line.' };

it('sets the agent instructions when the user confirms an instruction change, and restores them on revert', async () => {
  const f = await opened();
  addHelper(f);
  const improvement = propose(f, oneLine);
  expect(improvement.status).toBe('candidate');
  expect(helper(f).instructions).toBe('Answer with the reasons.');
  const confirmed = await decide(f, improvement, 'confirm');
  expect(confirmed).toMatchObject({
    status: 'active',
    change: { from: 'Answer with the reasons.', to: 'Answer in one line.' },
  });
  expect(helper(f).instructions).toBe('Answer in one line.');
  const reverted = await decide(f, confirmed, 'revert');
  expect(reverted.status).toBe('reverted');
  expect(reverted.status_detail).toBeUndefined();
  expect(helper(f).instructions).toBe('Answer with the reasons.');
});

it('keeps the instructions the user wrote after the confirmation when the instruction change is reverted', async () => {
  const f = await opened();
  addHelper(f);
  const confirmed = await decide(f, propose(f, oneLine), 'confirm');
  f.call('agent.update', {
    agent_id: 'helper',
    revision: helper(f).revision,
    instructions: 'Answer with a table.',
  });
  const reverted = await decide(f, confirmed, 'revert');
  expect(reverted.status_detail).toBeTruthy();
  expect(helper(f).instructions).toBe('Answer with a table.');
});

it('refuses an instruction change for an agent of another project', async () => {
  const f = await opened();
  f.store.insert<AgentProfile>('agents', {
    ...addHelper(f),
    id: 'stranger',
    project_id: 'other-project',
  });
  let error: unknown;
  try {
    propose(f, { ...oneLine, agent_id: 'stranger' });
  } catch (caught) {
    error = caught;
  }
  expect((error as DomainError).code).toBe('invalid_input');
  expect(f.store.list('improvements')).toEqual([]);
});

const sections = (reply: string) => ({
  before_you_plan: 'Plan right away.',
  routing: '- Keep every task on t1.',
  replies: reply,
});
const playbookVersion = (f: Fixture) =>
  f.call<{ version: number }>('playbook.get', { project_id: f.project.id }).version;
const replies = { 1: '- Reply with the task ids.', 2: '- Reply in one line.' } as const;
/**
 * The runs of an eval of six tasks under the current playbook, version 2, then under version 1;
 * only the winner's runs merged with the hidden check passed.
 */
const evalRuns = (winner: 1 | 2 = 1): Record<string, unknown>[] =>
  ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((task) =>
    ([2, 1] as const).map((version) => ({
      task,
      condition: `playbook=${version}`,
      repetition: 0,
      outcome: version === winner ? 'merged' : 'failed',
      hidden_passed: version === winner ? true : null,
      input_tokens: 1000,
      playbook_sha256: hash(sections(replies[version])),
    })),
  );
/** The runs file of an eval of two conditions, the second of them the proposed playbook. */
const runsFile = (runs = evalRuns()) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-receipt-')), 'runs.jsonl');
  fs.writeFileSync(file, runs.map((run) => `${JSON.stringify(run)}\n`).join(''));
  return { path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
};
const receipt = (verdict: string, file = runsFile()) => ({
  kind: 'eval_receipt',
  ...file,
  verdict,
});
const proposePlaybook = (f: Fixture, evidence: Record<string, unknown>[]) =>
  f.call<Improvement>(
    'improvement.propose',
    {
      project_id: f.project.id,
      retrospective_ids: retrospectiveIds,
      ...(evidence.length && { evidence: [...evidence, { kind: 'session', id: 'lead' }] }),
      change: { type: 'playbook', to: 1 },
    },
    null,
    lead(f),
  );
const twoPlaybooks = (f: Fixture) => {
  for (const [base_version, reply] of [
    [0, replies[1]],
    [1, replies[2]],
  ] as const)
    f.call('playbook.set', { project_id: f.project.id, base_version, sections: sections(reply) });
};

it('makes an earlier playbook version current when the user confirms it, and the later one again on revert', async () => {
  const f = await opened();
  twoPlaybooks(f);
  const better = receipt('playbook=1_passes_more');
  const improvement = proposePlaybook(f, [better]);
  expect(improvement.status).toBe('candidate');
  expect(improvement.evidence).toContainEqual(better);
  expect(playbookVersion(f)).toBe(2);
  const confirmed = await decide(f, improvement, 'confirm');
  expect(confirmed).toMatchObject({ status: 'active', change: { from: 2, to: 1 } });
  expect(playbookVersion(f)).toBe(1);
  expect((await decide(f, confirmed, 'revert')).status).toBe('reverted');
  expect(playbookVersion(f)).toBe(2);
});

it.each([
  ['without an eval receipt', () => [], 'no_eval_receipt', 'eval receipt'],
  [
    'whose eval reached no conclusion',
    () => [receipt('no_conclusion')],
    'eval_not_better',
    'no conclusion',
  ],
  [
    'whose eval found the current version better',
    () => [receipt('playbook=2_passes_more', runsFile(evalRuns(2)))],
    'eval_not_better',
    'playbook=2_passes_more',
  ],
  [
    'whose eval found it cheaper but the current version passes more',
    () => [
      receipt(
        'playbook=1_cheaper',
        runsFile([
          ...evalRuns(2).map((run) =>
            run.condition === 'playbook=1'
              ? { ...run, outcome: 'merged', hidden_passed: true, input_tokens: 500 }
              : run,
          ),
          ...evalRuns(2).map((run) => ({ ...run, task: `${String(run.task)}-only-current` })),
        ]),
      ),
    ],
    'eval_not_better',
    'playbook=2_passes_more',
  ],
  [
    'whose verdict its runs do not show',
    () => [
      receipt(
        'playbook=1_passes_more',
        runsFile(evalRuns().map((run) => ({ ...run, outcome: 'merged', hidden_passed: true }))),
      ),
    ],
    'eval_not_better',
    'not what the runs',
  ],
  [
    'whose runs compared another playbook with the current one',
    () => [
      receipt(
        'playbook=1_passes_more',
        runsFile(
          evalRuns().map((run) =>
            run.condition === 'playbook=1'
              ? { ...run, playbook_sha256: hash(sections('- Reply in two lines.')) }
              : run,
          ),
        ),
      ),
    ],
    'eval_not_better',
    'another playbook',
  ],
  [
    'whose runs do not record the playbook of each condition',
    () => [
      receipt(
        'playbook=1_passes_more',
        runsFile(evalRuns().map(({ playbook_sha256: _, ...run }) => run)),
      ),
    ],
    'eval_not_better',
    'record the playbook',
  ],
  [
    'whose eval runs changed since the receipt',
    () => {
      const changed = receipt('playbook=1_passes_more');
      fs.appendFileSync(changed.path, '\n');
      return [changed];
    },
    'eval_not_better',
    'changed',
  ],
] as const)(
  'refuses to confirm a playbook change %s and keeps the current version',
  async (_, evidence, reason, detail) => {
    const f = await opened();
    twoPlaybooks(f);
    const refused = await decide(f, proposePlaybook(f, evidence()), 'confirm');
    expect(refused).toMatchObject({ status: 'rejected', status_reason: reason });
    expect(refused.status_detail).toContain(detail);
    expect(playbookVersion(f)).toBe(2);
  },
);

it('refuses a playbook change to a version that is not stored or already current', async () => {
  const f = await opened();
  f.call('playbook.set', {
    project_id: f.project.id,
    base_version: 0,
    sections: sections('- Reply in one line.'),
  });
  for (const to of [1, 3]) {
    let error: unknown;
    try {
      propose(f, { type: 'playbook', to });
    } catch (caught) {
      error = caught;
    }
    expect((error as DomainError).code).toBe('invalid_input');
  }
  expect(f.store.list('improvements')).toEqual([]);
});
