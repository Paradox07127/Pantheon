import { expect, it } from 'vitest';
import { querySchemas } from '@pantheon/protocol';

it('defines strict workspace file and symbol queries with optional session scope', () => {
  for (const [name, extra] of [
    ['files.read', { path: 'src/main.ts' }],
    ['symbols.search', { q: '' }],
  ] as const) {
    const schema = querySchemas[name];
    expect(schema.parse({ project_id: 'project', ...extra })).toEqual({
      project_id: 'project',
      ...extra,
    });
    expect(schema.parse({ project_id: 'project', session_id: 'session', ...extra })).toEqual({
      project_id: 'project',
      session_id: 'session',
      ...extra,
    });
    expect(schema.safeParse(extra).success).toBe(false);
    expect(schema.safeParse({ project_id: 'project', ...extra, unknown: true }).success).toBe(
      false,
    );
  }
  expect(querySchemas['files.read'].safeParse({ project_id: 'project' }).success).toBe(false);
  expect(querySchemas['symbols.search'].safeParse({ project_id: 'project' }).success).toBe(false);
});

it('reads a tool image by a session and a sha256 hash only', () => {
  const schema = querySchemas['session.tool_image'];
  const hash = 'ab'.repeat(32);
  expect(schema.parse({ session_id: 'session', hash })).toEqual({ session_id: 'session', hash });
  for (const input of [
    { session_id: 'session' },
    { hash },
    { session_id: 'session', hash: '../config.json' },
    { session_id: 'session', hash: 'AB'.repeat(32) },
    { session_id: 'session', hash, project_id: 'project' },
  ])
    expect(schema.safeParse(input).success).toBe(false);
});
