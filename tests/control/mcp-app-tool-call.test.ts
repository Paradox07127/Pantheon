import { expect, it, vi } from 'vitest';
import type { Principal } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const RESULT = { content: [{ type: 'text', text: 'refreshed' }], structuredContent: { week: 2 } };

const listed: Record<string, { visibility?: string[] }> = {
  refresh: { visibility: ['model', 'app'] },
  secret: { visibility: ['model'] },
  plain: {},
};

async function liveSession(supported = true) {
  const f = await workbenchFixture();
  const callMcpTool = vi.fn(async () => RESULT);
  const findMcpTool = vi.fn(async (_handle: unknown, _server: string, tool: string) =>
    Object.hasOwn(listed, tool) ? listed[tool] : undefined,
  );
  if (supported) Object.assign(f.adapter, { callMcpTool, findMcpTool });
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.control.handles.size > 0,
    () => f.control.tick(),
  );
  const call = (tool: string, principal: Principal = user) =>
    f.call(
      'mcp.app.tool_call',
      { session_id: session.id, server: 'charts', tool, arguments: { week: 2 } },
      null,
      principal,
    );
  return { f, session, call, callMcpTool, findMcpTool };
}

it('calls a tool whose visibility includes app and returns its result', async () => {
  const { f, call, callMcpTool, findMcpTool } = await liveSession();
  expect(await call('refresh')).toEqual(RESULT);
  const handle = [...f.control.handles.values()][0];
  expect(findMcpTool).toHaveBeenCalledWith(handle, 'charts', 'refresh');
  expect(callMcpTool).toHaveBeenCalledWith(handle, 'charts', 'refresh', { week: 2 });
});

it('calls a tool that declares no visibility', async () => {
  const { call, callMcpTool } = await liveSession();
  expect(await call('plain')).toEqual(RESULT);
  expect(callMcpTool).toHaveBeenCalledOnce();
});

it.each([
  ['refuses a tool only the model may call', 'secret', 'permission_denied'],
  ['refuses a tool the server does not list', 'missing', 'not_found'],
])('%s', async (_name, tool, code) => {
  const { call, callMcpTool } = await liveSession();
  await expect(call(tool)).rejects.toMatchObject({ code });
  expect(callMcpTool).not.toHaveBeenCalled();
});

it('reports a runtime that cannot call MCP tools for an interface', async () => {
  const { call } = await liveSession(false);
  await expect(call('refresh')).rejects.toMatchObject({ code: 'unsupported_capability' });
});

it('takes interface tool calls only from the user', async () => {
  const { f, call, callMcpTool } = await liveSession();
  const planner: Principal = { id: 'planner-agent', role: 'planner', project_id: f.project.id };
  await expect(Promise.resolve().then(() => call('refresh', planner))).rejects.toMatchObject({
    code: 'permission_denied',
  });
  expect(callMcpTool).not.toHaveBeenCalled();
});

it('tells the interface whether the runtime lets it call tools', async () => {
  const read = async (supported: boolean) => {
    const { f, session } = await liveSession(supported);
    Object.assign(f.adapter, {
      readMcpResource: async () => ({
        contents: [{ uri: 'ui://charts/plot', mimeType: 'text/html;profile=mcp-app', text: 'x' }],
      }),
    });
    return f.control.mcpAppResource(user, {
      session_id: session.id,
      server: 'charts',
      uri: 'ui://charts/plot',
    });
  };
  expect(await read(true)).toEqual({ html: 'x', tool_calls: true });
  expect(await read(false)).toEqual({ html: 'x', tool_calls: false });
});
