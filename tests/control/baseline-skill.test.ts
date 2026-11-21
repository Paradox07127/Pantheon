import { expect, it } from 'vitest';
import { baselineSkill } from '../../packages/control/src/baseline-skill.js';

it('asks the baseline session for gate commands through its one submit tool', () => {
  expect(baselineSkill).toContain('project_baseline_submit');
  expect(baselineSkill).toContain('gate');
  expect(baselineSkill).toContain('setup');
  for (const removed of [
    'project_baseline_submit_folder',
    'project_intro_submit',
    'project_extensions_inventory',
    'draw',
  ])
    expect(baselineSkill).not.toContain(removed);
  for (const local of ['.notes', '/Users/', '~/']) expect(baselineSkill).not.toContain(local);
});
