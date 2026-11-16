import { expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';

it.each(['auto', 'full_access'])(
  'accepts %s as a permission mode with fast mode',
  (permission_mode) => {
    const schema = inputSchemas['session.create'];
    expect(
      schema.parse({
        project_id: 'project',
        runtime: 'claude',
        permission_mode,
        fast: true,
        input: 'Work',
      }),
    ).toMatchObject({ permission_mode, fast: true });
    expect(
      inputSchemas['session.setPermissionMode'].parse({ session_id: 'session', permission_mode }),
    ).toMatchObject({ permission_mode });
  },
);

it('accepts only a boolean fast mode command', () => {
  const schema = inputSchemas['session.setFastMode'];
  for (const fast of [true, false])
    expect(schema.parse({ session_id: 'session', fast })).toEqual({ session_id: 'session', fast });
  expect(schema.safeParse({ session_id: 'session', fast: 'on' }).success).toBe(false);
  expect(schema.safeParse({ session_id: 'session', fast: true, extra: true }).success).toBe(false);
});
