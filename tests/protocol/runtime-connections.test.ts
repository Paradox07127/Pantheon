import { expect, it } from 'vitest';
import { inputSchemas, querySchemas } from '@pantheon/protocol';

it('accepts runtime reconnect and strictly scoped MCP requests', () => {
  expect(inputSchemas['runtime.reconnect'].parse({ runtime: 'codex' })).toEqual({
    runtime: 'codex',
  });
  expect(querySchemas['mcp.status'].parse({ project_id: 'project', runtime: 'claude' })).toEqual({
    project_id: 'project',
    runtime: 'claude',
  });
  expect(querySchemas['mcp.status'].parse({ session_id: 'session' })).toEqual({
    session_id: 'session',
  });
  expect(querySchemas['mcp.status'].safeParse({ project_id: 'project' }).success).toBe(false);
  expect(
    querySchemas['mcp.status'].safeParse({
      project_id: 'project',
      runtime: 'claude',
      session_id: 'session',
    }).success,
  ).toBe(false);
  expect(inputSchemas['mcp.reconnect'].parse({ session_id: 'session', server: 'files' })).toEqual({
    session_id: 'session',
    server: 'files',
  });
});

it('accepts the connections refresh flag without runtime sign-in fields', () => {
  expect(querySchemas['connections.status'].parse({ refresh: 'true' })).toEqual({ refresh: true });
  expect(querySchemas['connections.status'].parse({})).toEqual({});
  expect(querySchemas['connections.status'].safeParse({ runtime: 'claude' }).success).toBe(false);
});
