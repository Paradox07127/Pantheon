import { expect, it } from 'vitest';
import { plannerInstructions } from '../../packages/adapters/src/planner.js';

const spec = { project_id: 'project-1', cwd: '/repo/root' };

it('gives the planner its root and leaves the project id to the tools', () => {
  for (const control_instructions of [undefined, 'Assess the project.']) {
    const instructions = plannerInstructions({ ...spec, control_instructions });
    expect(instructions).toContain('/repo/root');
    expect(instructions).not.toContain('project-1');
    expect(instructions).not.toContain('project_id');
  }
});

it('lists every project folder and marks the folders that are not git as read-only', () => {
  for (const control_instructions of [undefined, 'Assess the project.']) {
    const instructions = plannerInstructions({
      project_id: 'project-1',
      cwd: '/repo/app',
      control_instructions,
      project_roots: [
        { path: '/repo/app', git: true },
        { path: '/repo/notes', git: false },
      ],
    });
    expect(instructions).toContain('/repo/app (git)');
    expect(instructions).toContain('/repo/notes (not git, read-only)');
  }
});

it('allows reading project files without changing them', () => {
  expect(plannerInstructions(spec)).toContain(
    'As an exception, you can read project files with your read-only tools and cannot change files.',
  );
});

it('names none of the removed task and plan tools', () => {
  expect(plannerInstructions(spec)).not.toMatch(/task_create|plan_propose|board_read|grant/);
});
