import { expect, it } from 'vitest';
import { querySchemas } from '@pantheon/protocol';

it('pages a plan replay after or before a sequence, not both', () => {
  const schema = querySchemas['board.plan.replay'];
  expect(schema.safeParse({ lead_session_id: 'lead', after: '4' }).success).toBe(true);
  expect(schema.parse({ lead_session_id: 'lead', before: '9', limit: '5' })).toEqual({
    lead_session_id: 'lead',
    before: 9,
    limit: 5,
  });
  expect(schema.safeParse({ lead_session_id: 'lead', after: 4, before: 9 }).success).toBe(false);
});
