import { expect, it } from 'vitest';
import { inputSchemas, leadToolEffects, sessionTools } from '@pantheon/protocol';

const patch = { type: 'remove_task', task_id: 'api' };
const proposal = {
  project_id: 'project',
  base_version: 1,
  reason: 'Split the deliverable',
  ops: [patch],
};

it('requires proposal reason, current base version and one to 32 patch ops', () => {
  const schema = inputSchemas['board.plan.propose'];
  expect(schema.safeParse(proposal).success).toBe(true);
  expect(schema.safeParse({ ...proposal, reason: 'x'.repeat(280) }).success).toBe(true);
  expect(schema.safeParse({ ...proposal, ops: Array(32).fill(patch) }).success).toBe(true);
  for (const changed of [
    { reason: undefined },
    { reason: '' },
    { reason: 'x'.repeat(281) },
    { base_version: undefined },
    { ops: [] },
    { ops: Array(33).fill(patch) },
    { ops: [{ type: 'resolve_edit', edit_id: 'edit', decision: 'apply' }] },
    { lead_session_id: 'other-lead' },
  ])
    expect(schema.safeParse({ ...proposal, ...changed }).success).toBe(false);
});

it('accepts all patch op kinds and keeps proposal tool schemas plain objects', () => {
  const task = {
    id: 'api',
    title: 'API',
    goal: 'Serve exports',
    lane: 'core',
    depends_on: [],
    source: ['Ship exports'],
    scope: ['src/export'],
    acceptance: ['pnpm test'],
  };
  for (const op of [
    patch,
    { type: 'add_task', task },
    { type: 'set_task', task_id: 'api', patch: { title: 'Exports' } },
    { type: 'set_dependencies', task_id: 'ui', depends_on: ['api'] },
    { type: 'move_task', task_id: 'api', before: null },
    { type: 'set_iterations', iterations: [] },
    { type: 'set_milestone', milestone_id: 'release', patch: { title: 'Launch' } },
    { type: 'add_lane', lane: { id: 'ideas', title: 'Ideas' } },
  ])
    expect(inputSchemas['board.plan.propose'].safeParse({ ...proposal, ops: [op] }).success).toBe(
      true,
    );
  expect(
    inputSchemas['board.plan.propose'].omit({ project_id: true }).extend({}).toJSONSchema().type,
  ).toBe('object');
  expect(
    inputSchemas['board.plan.proposal.withdraw']
      .omit({ project_id: true })
      .extend({})
      .toJSONSchema().type,
  ).toBe('object');
  expect(sessionTools.lead).toMatchObject({
    propose_board: 'board.plan.propose',
    withdraw_board_proposal: 'board.plan.proposal.withdraw',
  });
  expect(leadToolEffects).toMatchObject({
    propose_board: 'write',
    withdraw_board_proposal: 'write',
  });
});

it('validates proposal resolution decisions and excludes resolve_edit from replacement ops', () => {
  const schema = inputSchemas['board.plan.proposal.resolve'];
  const resolution = {
    project_id: 'project',
    lead_session_id: 'lead',
    proposal_id: 'proposal',
    decision: 'accept',
  };
  expect(schema.safeParse(resolution).success).toBe(true);
  expect(schema.safeParse({ ...resolution, ops: [patch] }).success).toBe(true);
  expect(schema.safeParse({ ...resolution, decision: 'reject', reason: 'Keep it' }).success).toBe(
    true,
  );
  for (const changed of [
    { decision: 'apply' },
    { proposal_id: undefined },
    { lead_session_id: undefined },
    { ops: [] },
    { ops: [{ type: 'resolve_edit', edit_id: 'edit', decision: 'apply' }] },
  ])
    expect(schema.safeParse({ ...resolution, ...changed }).success).toBe(false);
});
