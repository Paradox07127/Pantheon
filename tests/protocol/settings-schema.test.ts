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
