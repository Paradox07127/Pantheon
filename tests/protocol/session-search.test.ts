import { expect, it } from 'vitest';
import { querySchemas } from '@pantheon/protocol';

it('validates session search text, project and bounded limit at the query boundary', () => {
  const schema = querySchemas['session.search'];
  expect(schema.parse({ text: '  Search  ' })).toEqual({ text: 'Search', limit: 20 });
  expect(schema.parse({ text: '', project_id: 'project', limit: '50' })).toEqual({
    text: '',
    project_id: 'project',
    limit: 50,
  });
  for (const input of [
    {},
    { text: 'query', limit: '51' },
    { text: 'query', limit: '0' },
    { text: 'query', limit: '1.5' },
    { text: 'query', extra: true },
  ])
    expect(schema.safeParse(input).success).toBe(false);
});
