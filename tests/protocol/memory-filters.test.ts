import { expect, it } from 'vitest';
import { inputSchemas, querySchemas } from '@pantheon/protocol';

const schemas = [
  [querySchemas['memory.read'], { project_id: 'project' }],
  [querySchemas['memory.graph'], { project_id: 'project' }],
  [inputSchemas['memory.search'], { project_id: 'project' }],
  [inputSchemas['memory.related'], { project_id: 'project', memory_id: 'source' }],
] as const;

it('accepts one tag or several tags in every memory filter', () => {
  for (const [schema, input] of schemas) {
    expect(schema.parse({ ...input, tag: ' storage ' }).tag).toBe('storage');
    expect(schema.parse({ ...input, tag: ['storage', ' local '] }).tag).toEqual([
      'storage',
      'local',
    ]);
  }
});

it('lets the queries take the task and plan filters an older client sends, and the session tools not offer them', () => {
  const retired = {
    task_id: 'task',
    lead_session_id: 'lead',
    project_only: 'true',
    origin: 'plan',
    milestone_id: 'milestone',
  };
  for (const [schema, input] of schemas.slice(0, 2))
    expect(schema.safeParse({ ...input, ...retired }).success).toBe(true);
  for (const [schema, input] of schemas.slice(2))
    for (const [key, value] of Object.entries(retired))
      expect(schema.safeParse({ ...input, [key]: value }).success).toBe(false);
});

it('takes several graph kinds, source kinds among them, and a memory to keep', () => {
  const graph = querySchemas['memory.graph'];
  expect(
    graph.parse({ project_id: 'project', kind: ['report', 'session'], keep: 'record' }),
  ).toMatchObject({ kind: ['report', 'session'], keep: 'record' });
  expect(graph.parse({ project_id: 'project', kind: 'url' }).kind).toBe('url');
  expect(graph.safeParse({ project_id: 'project', kind: ['tag'] }).success).toBe(false);
  expect(
    querySchemas['memory.read'].safeParse({ project_id: 'project', kind: 'file' }).success,
  ).toBe(false);
});
