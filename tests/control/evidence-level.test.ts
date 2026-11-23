import { expect, it } from 'vitest';
import { planItemEvidence } from '../../packages/control/dist/evidence-level.js';
import { runtimeIndependence } from '../../packages/control/dist/runtime-vendor.js';

type Facts = Parameters<typeof planItemEvidence>[0];

const passedBy = (runtime: string, to_sha?: string): Facts['review'] => ({
  failed: false,
  to_sha,
  verdicts: [{ runtime, verdict: 'pass' }],
});

it.each<[string, Facts, ReturnType<typeof planItemEvidence>]>([
  [
    'an accepted landed item',
    { landed: true, accepted: true, gate: 'passed' },
    { level: 'accepted' },
  ],
  ['an accepted item that never landed', { landed: false, accepted: true }, { level: 'accepted' }],
  [
    'an item that has not landed',
    {
      landed: false,
      accepted: false,
      gate: 'passed',
      review: passedBy('codex', 'abc'),
      landed_head: 'abc',
      writer: 'claude',
    },
    undefined,
  ],
  [
    'an item another vendor reviewed',
    {
      landed: true,
      accepted: false,
      review: passedBy('codex', 'abc'),
      landed_head: 'abc',
      writer: 'claude',
    },
    { level: 'reviewed', reviewer: 'other_vendor' },
  ],
  [
    'an item another runtime reviewed whose writer has no known vendor',
    {
      landed: true,
      accepted: false,
      review: passedBy('codex', 'abc'),
      landed_head: 'abc',
      writer: 'fixture',
    },
    { level: 'reviewed', reviewer: 'other_runtime' },
  ],
  [
    'an item its own runtime reviewed',
    {
      landed: true,
      accepted: false,
      review: passedBy('claude', 'abc'),
      landed_head: 'abc',
      writer: 'claude',
    },
    { level: 'report' },
  ],
  [
    'an item whose review failed',
    {
      landed: true,
      accepted: false,
      review: { failed: true, to_sha: 'abc', verdicts: [{ runtime: 'codex', verdict: 'pass' }] },
      landed_head: 'abc',
      writer: 'claude',
    },
    { level: 'report' },
  ],
  [
    'an item reviewed at a commit other than the one that landed',
    {
      landed: true,
      accepted: false,
      review: passedBy('codex', 'abc'),
      landed_head: 'def',
      writer: 'claude',
    },
    { level: 'report' },
  ],
  [
    'an item whose review names no commit',
    {
      landed: true,
      accepted: false,
      review: passedBy('codex'),
      landed_head: 'abc',
      writer: 'claude',
    },
    { level: 'report' },
  ],
  [
    'an item whose landing names no commit',
    { landed: true, accepted: false, review: passedBy('codex', 'abc'), writer: 'claude' },
    { level: 'report' },
  ],
  [
    'an item reviewed with no known writer',
    { landed: true, accepted: false, review: passedBy('codex', 'abc'), landed_head: 'abc' },
    { level: 'report' },
  ],
  [
    'an item whose gate passed',
    { landed: true, accepted: false, gate: 'passed' },
    { level: 'gate' },
  ],
  [
    'an item whose gate was skipped',
    { landed: true, accepted: false, gate: 'skipped' },
    { level: 'report' },
  ],
  [
    'an item whose gate failed',
    { landed: true, accepted: false, gate: 'failed' },
    { level: 'report' },
  ],
  ['a landed item with nothing behind it', { landed: true, accepted: false }, { level: 'report' }],
])('grades %s', (_name, facts, expected) => {
  expect(planItemEvidence(facts)).toEqual(expected);
});

it.each([
  ['claude', 'codex', 'other_vendor'],
  ['fixture', 'codex', 'other_runtime'],
  ['claude', 'claude', 'same_runtime'],
] as const)('work by %s reviewed by %s stands at %s', (writer, reviewer, expected) => {
  expect(runtimeIndependence([writer], reviewer)).toBe(expected);
});
