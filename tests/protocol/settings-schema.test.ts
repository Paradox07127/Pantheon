import { expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';

it('accepts role choices and fallbacks and rejects an unknown role', () => {
  const base = { project_id: 'project', runtime: 'claude', permission_mode: 'ask' };
  const choice = { runtime: 'codex', model: 'gpt-fixture' };
  const schema = inputSchemas['project.sessionDefaults.set'];
  expect(
    schema.safeParse({
      ...base,
      writer: choice,
      reviewer: choice,
      fallbacks: { lead: choice, writer: choice, reviewer: choice },
    }).success,
  ).toBe(true);
  expect(schema.safeParse({ ...base, fallbacks: { observer: choice } }).success).toBe(false);
});

it('accepts whole token targets and clears and rejects negative or fractional targets', () => {
  const schema = inputSchemas['project.usageTargets.set'];
  expect(
    schema.safeParse({ project_id: 'project', targets: { claude: 0, codex: null } }).success,
  ).toBe(true);
  for (const value of [-1, 1.5])
    expect(schema.safeParse({ project_id: 'project', targets: { claude: value } }).success).toBe(
      false,
    );
});
