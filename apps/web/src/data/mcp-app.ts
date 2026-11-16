import type { CallToolResult } from '@modelcontextprotocol/client';
import type { BridgeResult, McpAppResource } from '@pantheon/protocol';
import { messageCommand } from '../screens/sessions/thread-model';
import { runCommand } from './commands';

/** GET /v1/mcp.app.resource: the HTML and sandbox settings of a ui:// interface, read through the live session. */
export async function readAppResource(
  session_id: string,
  server: string,
  uri: string,
): Promise<BridgeResult<McpAppResource>> {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  const result = await bridge
    .query('mcp.app.resource', { session_id, server, uri })
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return result;
  const value = result.value as Partial<McpAppResource> | null;
  if (typeof value?.html !== 'string')
    return {
      ok: false,
      error: { code: 'bad_response', message: 'mcp.app.resource result has no html' },
    };
  return { ok: true, value: value as McpAppResource };
}

/** What an interface of server says to the session: a message from the user, or context for the model. */
export function appSender(
  session_id: string,
  state: string | undefined,
  revision: number | null,
  server: string,
) {
  const run = async (type: Parameters<typeof runCommand>[0], input: Record<string, unknown>) => {
    const result = await runCommand(type, input, revision);
    if (!result.ok) throw new Error(result.error.message);
  };
  return {
    sendMessage: (text: string) =>
      run(messageCommand(state), { session_id, input: text, app: { server } }),
    setModelContext: (content: string) =>
      run('session.app_context', { session_id, server, content }),
  };
}

/** Calls a tool of server for its interface through the live session; use only when mcp.app.resource said tool_calls. */
export function appToolCaller(session_id: string, server: string) {
  return async (tool: string, args: Record<string, unknown> | undefined) => {
    const result = await runCommand(
      'mcp.app.tool_call',
      { session_id, server, tool, ...(args ? { arguments: args } : {}) },
      null,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value as CallToolResult;
  };
}
