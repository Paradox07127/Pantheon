import { expect, it } from 'vitest';
import { inputSchemas, sessionTools, coordinationTools } from '@pantheon/protocol';

it('accepts a strict manual compaction command with one optional line of at most 2000 code points', () => {
  const schema = inputSchemas['session.compact'];
  expect(schema.parse({ session_id: 'session' })).toEqual({ session_id: 'session' });
  expect(schema.parse({ session_id: 'session', instructions: 'Keep the plan' })).toEqual({
    session_id: 'session',
    instructions: 'Keep the plan',
  });
  expect(schema.safeParse({ session_id: 'session', instructions: '😀'.repeat(2000) }).success).toBe(
    true,
  );
  for (const instructions of ['😀'.repeat(2001), 'keep\nplan', 'keep\rplan', 'keep\n', 'keep\r'])
    expect(schema.safeParse({ session_id: 'session', instructions }).success).toBe(false);
  expect(schema.safeParse({ session_id: 'session', extra: true }).success).toBe(false);
  expect(schema.safeParse({}).success).toBe(false);
  for (const tools of [...Object.values(sessionTools), coordinationTools])
    expect(Object.values(tools)).not.toContain('session.compact');
});
