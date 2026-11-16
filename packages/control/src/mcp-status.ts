import {
  requireThat,
  type McpServerStatus,
  type McpToolResult,
  type Principal,
  type Project,
  type Session,
} from '@pantheon/domain';
import type { McpAppResource, McpStatus, querySchemas } from '@pantheon/protocol';
import { projectAccess, sessionAdapter, userOnly, type ControlContext } from './context.js';

type McpScope = ReturnType<(typeof querySchemas)['mcp.status']['parse']>;

export async function mcpStatus(
  ctx: ControlContext,
  principal: Principal,
  input: McpScope,
): Promise<McpStatus> {
  const session =
    'session_id' in input ? ctx.store.must<Session>('sessions', input.session_id) : undefined;
  const projectId = 'project_id' in input ? input.project_id : session!.project_id;
  projectAccess(ctx, principal, projectId, 'project.read');
  const project = ctx.store.must<Project>('projects', projectId);
  const runtime = 'runtime' in input ? input.runtime : session!.runtime;
  const adapter = session ? sessionAdapter(ctx, session) : ctx.adapters.get(runtime);
  const handle = session
    ? [...ctx.handles.values()].find((handle) => handle.platform_session_id === session.id)
    : undefined;
  const live = handle && ctx.runtimeStatus.get(runtime)?.connection?.connected !== false;
  return {
    runtime,
    reconnect_available: !!adapter?.reconnectMcp && !!live,
    ...(adapter?.mcpStatus && (!session || live)
      ? { servers: await adapter.mcpStatus(project.roots[0]!, handle) }
      : {}),
  };
}

/** The servers the session's newest start reported, else the names it last loaded; read from its events only. */
export function sessionMcpServers(
  ctx: ControlContext,
  principal: Principal,
  sessionId: string,
): McpServerStatus[] {
  const session = ctx.store.must<Session>('sessions', sessionId);
  projectAccess(ctx, principal, session.project_id, 'project.read');
  const newest = (kind: string, path: string) =>
    ctx.store.db
      .prepare(
        "SELECT payload ->> ? AS servers FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind=? AND aggregate_id=? AND json_type(payload, ?)='array' ORDER BY sequence DESC LIMIT 1",
      )
      .get(path, session.project_id, kind, sessionId, path) as { servers: string } | undefined;
  const started = newest('agent.session.started', '$.native.mcp_servers');
  if (started)
    return (JSON.parse(started.servers) as { name: string; status: string }[]).map(
      ({ name, status }) => ({
        name,
        state: (status === 'needs-auth' ? 'needs_sign_in' : status) as McpServerStatus['state'],
      }),
    );
  const loaded = newest('agent.extensions.applied', '$.loaded.mcp_servers');
  return loaded
    ? (JSON.parse(loaded.servers) as string[]).map((name) => ({ name, state: 'unknown' }))
    : [];
}

export async function reconnectMcp(
  ctx: ControlContext,
  principal: Principal,
  input: { session_id: string; server: string },
) {
  userOnly(principal);
  const session = ctx.store.must<Session>('sessions', input.session_id);
  const adapter = sessionAdapter(ctx, session);
  requireThat(
    adapter?.reconnectMcp,
    'unsupported_capability',
    `${session.runtime} does not support reconnecting MCP servers`,
  );
  const handle = [...ctx.handles.values()].find(
    (handle) => handle.platform_session_id === session.id,
  );
  requireThat(
    handle && ctx.runtimeStatus.get(session.runtime)?.connection?.connected !== false,
    'invalid_state',
    'MCP reconnect requires a live runtime session',
  );
  await adapter.reconnectMcp(input.server, handle);
  ctx.store.event('mcp.reconnected', session, session.project_id, {
    runtime: session.runtime,
    server: input.server,
  });
  return { runtime: session.runtime, server: input.server, reconnected: true };
}

const APP_MIME_TYPE = 'text/html;profile=mcp-app';
const CSP_KEYS = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const;
const PERMISSION_KEYS = ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function mcpAppResource(
  ctx: ControlContext,
  principal: Principal,
  input: { session_id: string; server: string; uri: string },
): Promise<McpAppResource> {
  const session = ctx.store.must<Session>('sessions', input.session_id);
  projectAccess(ctx, principal, session.project_id, 'project.read');
  const adapter = sessionAdapter(ctx, session);
  requireThat(
    adapter?.readMcpResource,
    'unsupported_capability',
    `${session.runtime} does not support reading MCP interface resources`,
  );
  const handle = [...ctx.handles.values()].find(
    (handle) => handle.platform_session_id === session.id,
  );
  requireThat(
    handle && ctx.runtimeStatus.get(session.runtime)?.connection?.connected !== false,
    'invalid_state',
    'Reading an MCP interface requires a live runtime session',
  );
  const { contents } = await adapter.readMcpResource(handle, input.server, input.uri);
  const item = contents.find((content) => content.mimeType === APP_MIME_TYPE);
  requireThat(item, 'invalid_input', `${input.uri} has no ${APP_MIME_TYPE} content`);
  const html = item.text ?? Buffer.from(item.blob ?? '', 'base64').toString('utf8');
  const ui = isObject(item._meta?.ui) ? item._meta.ui : {};
  const csp = isObject(ui.csp) ? ui.csp : {};
  const domains = Object.fromEntries(
    CSP_KEYS.flatMap((key) => {
      const value = csp[key];
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? [[key, value as string[]]]
        : [];
    }),
  );
  const requested = isObject(ui.permissions) ? ui.permissions : {};
  const permissions = Object.fromEntries(
    PERMISSION_KEYS.flatMap((key) => (key in requested ? [[key, requested[key]]] : [])),
  );
  return {
    html,
    ...(Object.keys(domains).length ? { csp: domains } : {}),
    ...(Object.keys(permissions).length ? { permissions } : {}),
    ...(typeof ui.prefersBorder === 'boolean' ? { prefers_border: ui.prefersBorder } : {}),
    ...(typeof ui.domain === 'string' ? { domain: ui.domain } : {}),
    tool_calls: !!adapter.callMcpTool && !!adapter.findMcpTool,
  };
}

export async function mcpAppToolCall(
  ctx: ControlContext,
  principal: Principal,
  input: { session_id: string; server: string; tool: string; arguments?: Record<string, unknown> },
): Promise<McpToolResult> {
  userOnly(principal);
  const session = ctx.store.must<Session>('sessions', input.session_id);
  projectAccess(ctx, principal, session.project_id, 'mcp.app.tool_call');
  const adapter = sessionAdapter(ctx, session);
  requireThat(
    adapter?.callMcpTool && adapter.findMcpTool,
    'unsupported_capability',
    `${session.runtime} does not let MCP interfaces call tools`,
  );
  const handle = [...ctx.handles.values()].find(
    (handle) => handle.platform_session_id === session.id,
  );
  requireThat(
    handle && ctx.runtimeStatus.get(session.runtime)?.connection?.connected !== false,
    'invalid_state',
    'An MCP interface tool call requires a live runtime session',
  );
  const tool = await adapter.findMcpTool(handle, input.server, input.tool);
  requireThat(tool, 'not_found', `${input.server} lists no tool ${input.tool}`);
  // The spec's default visibility is ["model", "app"].
  requireThat(
    (tool.visibility ?? ['model', 'app']).includes('app'),
    'permission_denied',
    `${input.tool} is not callable from an interface`,
  );
  return adapter.callMcpTool(handle, input.server, input.tool, input.arguments);
}
