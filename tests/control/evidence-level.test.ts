import { expect, it } from 'vitest';
import {
  milestoneEvidenceLevel,
  taskEvidenceLevel,
} from '../../packages/control/dist/evidence-level.js';

const passed = { name: 'Test', state: 'passed' as const };
const skipped = { name: 'Lint', state: 'skipped' as const };
const failed = { name: 'Build', state: 'failed' as const };
const pending = { name: 'Build', state: 'pending' as const };

it.each([
  ['a merged task with no gate steps and no review', {}, { evidence_level: 'report' }],
  [
    'a gate whose steps were all skipped',
    { gate_steps: [skipped, skipped] },
    { evidence_level: 'report' },
  ],
  [
    'one passed and one skipped step',
    { gate_steps: [passed, skipped] },
    { evidence_level: 'gate' },
  ],
  [
    'a passed step and a failed one',
    { gate_steps: [passed, failed] },
    { evidence_level: 'report' },
  ],
  [
    'a passed step and one still pending',
    { gate_steps: [passed, pending] },
    { evidence_level: 'report' },
  ],
  [
    'a carried passed step',
    { gate_steps: [{ ...passed, carried: true }] },
    { evidence_level: 'gate' },
  ],
  [
    'a passed review whose only reviewer runs on the writer runtime',
    {
      gate_steps: [passed],
      review: { failed: false, verdicts: [{ runtime: 'claude', verdict: 'pass' as const }] },
    },
    { evidence_level: 'gate' },
  ],
  [
    'a codex pass on a claude writer',
    {
      gate_steps: [passed],
      review: { failed: false, verdicts: [{ runtime: 'codex', verdict: 'pass' as const }] },
    },
    { evidence_level: 'reviewed', evidence_reviewer: 'other_vendor' },
  ],
  [
    'a pass from a runtime of unknown vendor',
    { review: { failed: false, verdicts: [{ runtime: 'opencode', verdict: 'pass' as const }] } },
    { evidence_level: 'reviewed', evidence_reviewer: 'other_runtime' },
  ],
  [
    'a review with no handed-in verdict',
    { gate_steps: [passed], review: { failed: false, verdicts: [] } },
    { evidence_level: 'gate' },
  ],
  [
    'a failed review with a codex pass',
    {
      gate_steps: [passed],
      review: { failed: true, verdicts: [{ runtime: 'codex', verdict: 'pass' as const }] },
    },
    { evidence_level: 'gate' },
  ],
  [
    'a codex fail',
    {
      gate_steps: [passed],
      review: { failed: false, verdicts: [{ runtime: 'codex', verdict: 'fail' as const }] },
    },
    { evidence_level: 'gate' },
  ],
  [
    'a codex pass on a task whose writer runtime is unknown',
    {
      gate_steps: [passed],
      writers: [],
      review: { failed: false, verdicts: [{ runtime: 'codex', verdict: 'pass' as const }] },
    },
    { evidence_level: 'gate' },
  ],
])('gives %s its level', (_name, facts, expected) => {
  expect(taskEvidenceLevel({ merged: true, writers: ['claude'], ...facts })).toEqual(expected);
});

it('gives an unmerged task no level, whatever backs it', () => {
  expect(
    taskEvidenceLevel({
      merged: false,
      gate_steps: [passed],
      review: { failed: false, verdicts: [{ runtime: 'codex', verdict: 'pass' }] },
      writers: ['claude'],
    }),
  ).toEqual({});
});

it.each([
  [
    'one report task and one reviewed task',
    { status: 'ready_for_acceptance' as const, tasks: ['report' as const, 'reviewed' as const] },
    'report',
  ],
  [
    'a passed verification',
    {
      status: 'ready_for_acceptance' as const,
      verification_state: 'passed' as const,
      tasks: ['report' as const],
    },
    'verified',
  ],
  [
    'the user acceptance',
    {
      status: 'completed' as const,
      acceptance_actor: 'local-user',
      verification_state: 'failed' as const,
      tasks: ['report' as const],
    },
    'accepted',
  ],
  [
    "the acceptance of the user's personal key",
    { status: 'completed' as const, acceptance_actor: 'personal:key-1', tasks: [] },
    'accepted',
  ],
  [
    'a lead acceptance over a failed verification',
    {
      status: 'completed' as const,
      acceptance_actor: 'session:lead-1',
      verification_state: 'failed' as const,
      tasks: ['gate' as const, 'reviewed' as const],
    },
    'gate',
  ],
  [
    'a user acceptance that no longer holds',
    {
      status: 'ready_for_acceptance' as const,
      acceptance_actor: 'local-user',
      tasks: ['reviewed' as const],
    },
    'reviewed',
  ],
  ['no merged task', { status: 'ready_for_acceptance' as const, tasks: [] }, undefined],
  [
    'a done task whose row the board does not show',
    { status: 'completed' as const, tasks: ['reviewed' as const], done_tasks: 2 },
    undefined,
  ],
  [
    'an active milestone',
    {
      status: 'active' as const,
      acceptance_actor: 'local-user',
      verification_state: 'passed' as const,
      tasks: ['reviewed' as const],
    },
    undefined,
  ],
])('gives a milestone with %s its level', (_name, facts, expected) => {
  expect(milestoneEvidenceLevel(facts)).toBe(expected);
});
