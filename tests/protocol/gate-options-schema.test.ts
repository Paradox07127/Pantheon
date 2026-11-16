import { expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';

it('accepts optional enabled and skippable gate commands and validates their types', () => {
  const input = {
    project_id: 'project',
    root: '/project',
    commands: [{ name: 'lint', argv: ['lint'], enabled: false, skippable: true }],
  };
  expect(inputSchemas['project.gate.set'].safeParse(input).success).toBe(true);
  expect(
    inputSchemas['project.gate.set'].safeParse({
      ...input,
      commands: [{ ...input.commands[0], enabled: 'false' }],
    }).success,
  ).toBe(false);
});

it('validates gate failure and runner policies and trial task bounds', () => {
  for (const gate_on_fail of ['handback', 'retry', 'stop'])
    for (const gate_runner of ['daemon', 'session'])
      expect(
        inputSchemas['workflow.policy.set'].safeParse({
          project_id: 'project',
          gate_on_fail,
          gate_runner,
        }).success,
      ).toBe(true);
  expect(
    inputSchemas['workflow.policy.set'].safeParse({ project_id: 'project', gate_on_fail: 'ignore' })
      .success,
  ).toBe(false);
  expect(
    inputSchemas['workflow.policy.set'].safeParse({ project_id: 'project', gate_runner: 'agent' })
      .success,
  ).toBe(false);
  const definition = { slots: { before_dispatch: [], before_merge: [], after_merge: [] } };
  for (const trial_tasks of [1, 20])
    expect(
      inputSchemas['workflow.definition.set'].safeParse({
        project_id: 'project',
        base_version: 0,
        definition,
        trial_tasks,
      }).success,
    ).toBe(true);
  for (const trial_tasks of [0, 21, 1.5])
    expect(
      inputSchemas['workflow.definition.set'].safeParse({
        project_id: 'project',
        base_version: 0,
        definition,
        trial_tasks,
      }).success,
    ).toBe(false);
});
