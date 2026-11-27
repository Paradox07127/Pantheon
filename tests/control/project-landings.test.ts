import { expect, it, vi } from 'vitest';
import type { LandingRecord, Review, SettingProposal } from '@pantheon/domain';
import { recordSessionLanding } from '../../packages/control/dist/project-landings.js';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

async function settingProposal(state: SettingProposal['state']) {
  const f = await workbenchFixture();
  const proposal = f.store.insert<SettingProposal>('setting_change_proposals', {
    id: 'proposal',
    project_id: f.project.id,
    revision: 1,
    session_id: 'conductor',
    command: 'workflow.policy.set',
    input: {},
    reason: 'Reduce usage',
    before: {},
    state,
    created_at: 0,
    decided_at: 30,
  });
  return { f, proposal };
}

it('compares the nearest landings on either side of the approval', async () => {
  const { f, proposal } = await settingProposal('approved');
  for (const [i, ended_at] of [10, 20, 40, 50, 60].entries())
    f.store.insert<LandingRecord>('landing_records', {
      id: String(i),
      revision: 1,
      project_id: f.project.id,
      session_id: String(i),
      state: 'landed',
      reason: null,
      landed_sha: 'commit',
      ended_at,
      gate_runs: 1,
      first_gate_passed: i >= 1 && i <= 3,
      review_rounds: i,
      turns: 1,
      input_tokens: i * 9,
      output_tokens: i,
      wall_ms: i * 20,
    });
  const compare = (count: number) =>
    f.control.projectLandingsCompare(user, f.project.id, proposal.id, count);
  expect(compare(2)).toEqual({
    before: {
      count: 2,
      first_gate_pass_rate: 0.5,
      mean_review_rounds: 0.5,
      median_wall_ms: 10,
      mean_tokens: 5,
    },
    after: {
      count: 2,
      first_gate_pass_rate: 1,
      mean_review_rounds: 2.5,
      median_wall_ms: 50,
      mean_tokens: 25,
    },
  });
  expect(compare(5)).toMatchObject({
    before: { count: 2 },
    after: { count: 3, median_wall_ms: 60 },
  });
  expect(
    f.control
      .projectLandingsRead(user, { project_id: f.project.id, from: 20, to: 50, limit: 2 })
      .landings.map((r) => r.ended_at),
  ).toEqual([50, 40]);

  f.store.insert<LandingRecord>('landing_records', {
    id: 'renamed-target',
    revision: 1,
    project_id: f.project.id,
    branch: 'feature',
    state: 'blocked',
    reason: 'target_branch_changed',
    landed_sha: null,
    ended_at: 29,
    gate_runs: 0,
    first_gate_passed: null,
    review_rounds: null,
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    wall_ms: null,
  });
  expect(compare(2).before).toMatchObject({ count: 2, mean_review_rounds: 1 });
  expect(compare(1).before).toMatchObject({ count: 1, mean_review_rounds: null });
});

it.each(['pending', 'rejected', 'failed'] as const)(
  'refuses a comparison for a %s proposal',
  async (state) => {
    const { f, proposal } = await settingProposal(state);
    expect(() => f.control.projectLandingsCompare(user, f.project.id, proposal.id, 2)).toThrow(
      /not approved/i,
    );
  },
);

it('records a completed skipped-only gate as passing', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  f.store.event('session.gate_checked', session, f.project.id, {
    results: [{ state: 'skipped', exit_code: null, timed_out: false }],
  });
  recordSessionLanding(f.control['ctx'], session, 'landed', null, 'tip');
  expect(f.control.projectLandingsRead(user, { project_id: f.project.id }).landings).toMatchObject([
    { gate_runs: 1, first_gate_passed: true },
  ]);
});

it('starts gate and review counts over after a blocked session landing', async () => {
  const f = await workbenchFixture();
  vi.spyOn(f.store, 'now').mockReturnValue(100);
  const session = await f.create();
  for (const [i, exit_code] of [1, 0].entries()) {
    const review = f.store.insert<Review>('reviews', {
      id: String(i),
      revision: 1,
      session_id: session.id,
      project_id: f.project.id,
      round: i + 1,
      state: 'completed',
      findings: [],
      session_ids: [],
      runtimes: ['reviewer'],
    });
    f.store.event('review.requested', review, f.project.id, review);
    f.store.event('session.gate_started', session, f.project.id, {});
    f.store.event('session.gate_checked', session, f.project.id, {
      results: [{ exit_code, timed_out: false }],
    });
    if (exit_code) recordSessionLanding(f.control['ctx'], session, 'blocked', 'gate_failed');
    else recordSessionLanding(f.control['ctx'], session, 'landed', null, 'tip');
  }
  expect(f.control.projectLandingsRead(user, { project_id: f.project.id }).landings).toMatchObject([
    { state: 'landed', gate_runs: 1, first_gate_passed: true, review_rounds: 1 },
    { state: 'blocked', gate_runs: 1, first_gate_passed: false, review_rounds: 1 },
  ]);
});

it('measures usage and wall time from turns queued after the later landing boundary', async () => {
  const f = await workbenchFixture();
  const clock = vi.spyOn(f.store, 'now').mockReturnValue(10);
  const session = await f.create();
  const first = f.turns(session.id)[0]!;
  f.store.update(
    'session_turns',
    { ...first, usage: { input_tokens: 20, output_tokens: 8 } },
    first.revision,
  );
  clock.mockReturnValue(20);
  f.store.event('session.merged', session, f.project.id, {});
  clock.mockReturnValue(30);
  const current = f.store.insert('session_turns', {
    ...first,
    id: 'current',
    usage: { input_tokens: 9, output_tokens: 4 },
  });
  f.store.event('turn.queued', current, f.project.id, current);
  clock.mockReturnValue(50);
  recordSessionLanding(f.control['ctx'], session, 'blocked', 'cancelled');
  recordSessionLanding(f.control['ctx'], session, 'landed', null, 'second');
  expect(f.control.projectLandingsRead(user, { project_id: f.project.id }).landings).toMatchObject([
    { turns: 0, input_tokens: 0, output_tokens: 0, wall_ms: null },
    { turns: 1, input_tokens: 9, output_tokens: 4, wall_ms: 20 },
  ]);
});

it('computes first-pass rates only for landings that ran a gate', async () => {
  const { f, proposal } = await settingProposal('approved');
  const clock = vi.spyOn(f.store, 'now').mockReturnValue(20);
  const session = await f.create();
  recordSessionLanding(f.control['ctx'], session, 'no_changes', null);
  clock.mockReturnValue(40);
  recordSessionLanding(f.control['ctx'], session, 'blocked', 'cancelled');
  f.store.event('session.gate_checked', session, f.project.id, {
    results: [{ exit_code: 0, timed_out: false }],
  });
  recordSessionLanding(f.control['ctx'], session, 'landed', null, 'tip');
  expect(f.control.projectLandingsCompare(user, f.project.id, proposal.id, 2)).toMatchObject({
    before: { count: 1, first_gate_pass_rate: null },
    after: { count: 2, first_gate_pass_rate: 1 },
  });
  expect(f.control.projectLandingsRead(user, { project_id: f.project.id }).landings).toMatchObject([
    { gate_runs: 1, first_gate_passed: true },
    { gate_runs: 0, first_gate_passed: null },
    { gate_runs: 0, first_gate_passed: null },
  ]);
  expect(f.store.list<LandingRecord>('landing_records')[1]!.first_gate_passed).toBeNull();
});
