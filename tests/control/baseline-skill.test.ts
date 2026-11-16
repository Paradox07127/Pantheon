import { expect, it } from 'vitest';
import { baselineSkill } from '../../packages/control/src/baseline-skill.js';

it.each([
  { rounds: 5, visuals: true },
  { rounds: 3, visuals: true },
  { rounds: 2, visuals: false },
])('writes the baseline skill for $rounds rounds with visuals $visuals', (settings) => {
  const skill = baselineSkill(settings);
  expect(skill).toContain(`at most ${settings.rounds} rounds`);
  expect(skill).toContain('kind direction');
  expect(skill).toContain('left to you');
  expect(skill).toMatch(/project_intro_submit[\s\S]*before[\s\S]*project_baseline_submit/);
  expect(skill).toContain('Do not draw in the conversation');
  if (settings.visuals) {
    expect(skill).toContain('Call visual_draw');
    expect(skill).not.toContain('Do not call visual_draw');
  } else {
    expect(skill).toContain('Do not call visual_draw');
    expect(skill).not.toContain('Call visual_draw');
  }
  for (const local of ['.notes', '/Users/', '~/']) expect(skill).not.toContain(local);
});
