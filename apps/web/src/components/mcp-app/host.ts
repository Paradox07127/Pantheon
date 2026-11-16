import type {
  McpUiDisplayMode,
  McpUiHostContext,
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult, StandardSchemaV1, Transport } from '@modelcontextprotocol/client';

let runtime:
  | {
      bridge: typeof import('@modelcontextprotocol/ext-apps/app-bridge');
      client: typeof import('@modelcontextprotocol/client');
    }
  | undefined;

/** Loads the MCP packages; createAppHost runs only once this has resolved. */
export async function loadAppHost() {
  const [bridge, client] = await Promise.all([
    import('@modelcontextprotocol/ext-apps/app-bridge'),
    import('@modelcontextprotocol/client'),
  ]);
  runtime = { bridge, client };
  return runtime;
}

export interface AppHostDeps {
  sendMessage(text: string): Promise<void>;
  setModelContext(text: string): Promise<void>;
  /** True right after a click or key press in the interface's frame. */
  userGesture(): boolean;
  /** False when the link was refused. */
  openLink(url: string): Promise<boolean>;
  /** Returns the mode the interface ends up in. */
  setDisplayMode(mode: McpUiDisplayMode): McpUiDisplayMode;
  onSize(width?: number, height?: number): void;
  log?(entry: { server: string; level: string; logger?: string; data: unknown }): void;
  /** Calls a tool of the interface's own server; absent when the session's runtime cannot. */
  callTool?(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult>;
}

/** The host context fields Pantheon sends; style variables may be any subset, as the spec allows. */
export interface AppHostContext {
  theme: 'light' | 'dark';
  displayMode: McpUiDisplayMode;
  availableDisplayModes: McpUiDisplayMode[];
  containerDimensions: NonNullable<McpUiHostContext['containerDimensions']>;
  locale: string;
  timeZone: string;
  platform: 'web' | 'desktop' | 'mobile';
  styles: { variables: Record<string, string> };
}

export interface AppHostOptions {
  toolCallId: string;
  toolName: string;
  server: string;
  hostContext: AppHostContext;
  /** The policy the page was actually served with. */
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  deps: AppHostDeps;
}

/** What the session's events say about the tool call so far. */
export interface AppToolUpdate {
  input?: Record<string, unknown>;
  result?: {
    ok: boolean;
    app_result?: { content: unknown[]; structuredContent?: unknown; isError?: boolean };
  };
  /** The reason the call ended without a result. */
  cancelled?: string;
}

/** The version in apps/web/package.json, put in by the bundler's define. */
declare const __WEB_VERSION__: string;
const HOST_VERSION = __WEB_VERSION__;
const TEARDOWN_WAIT_MS = 500;
/** JSON-RPC server error the spec names for a refused link. */
const REFUSED = -32000;

// The package's ui/message schema takes only a list of blocks; the spec also allows one block.
const anyParams: StandardSchemaV1<Record<string, unknown>> = {
  '~standard': {
    version: 1,
    vendor: 'pantheon',
    validate: (value) => ({ value: value as Record<string, unknown> }),
  },
};

function texts(content: unknown): string[] {
  const blocks: unknown[] = Array.isArray(content) ? content : [content];
  return blocks.flatMap((block) => {
    const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
    return type === 'text' && typeof text === 'string' ? [text] : [];
  });
}

/** The host side of one MCP App interface: answers the view and passes it the tool call's progress. */
export function createAppHost(options: AppHostOptions) {
  const { deps, server } = options;
  const { AppBridge } = runtime!.bridge;
  const { ProtocolError, ProtocolErrorCode } = runtime!.client;
  // AppBridge answers ui/initialize with this object, so changes before the handshake go into it.
  const context = {
    ...options.hostContext,
    toolInfo: {
      id: options.toolCallId,
      tool: { name: options.toolName, inputSchema: { type: 'object' } },
    },
  } as McpUiHostContext;
  const bridge = new AppBridge(
    null,
    { name: 'Pantheon', version: HOST_VERSION },
    {
      openLinks: {},
      logging: {},
      message: {},
      updateModelContext: {},
      ...(deps.callTool ? { serverTools: {} } : {}),
      sandbox: {
        csp: options.csp,
        // The frame never gets camera, microphone or geolocation, so the view is not told it has them.
        permissions: options.permissions && {
          ...(options.permissions.clipboardWrite && { clipboardWrite: {} }),
        },
      },
    },
    { hostContext: context },
  );

  bridge.setRequestHandler('ui/message', { params: anyParams }, async (params) => {
    const text = texts(params.content).join('\n\n');
    if (!text) return { isError: true };
    return deps.sendMessage(text).then(
      () => ({}),
      () => ({ isError: true }),
    );
  });
  bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
    const parts = texts(content ?? []);
    if (structuredContent !== undefined) parts.push(JSON.stringify(structuredContent));
    await deps.setModelContext(parts.join('\n\n'));
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    if (!deps.userGesture() || !(await deps.openLink(url)))
      throw new ProtocolError(REFUSED, 'The link was refused');
    return {};
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    const declared = bridge.getAppCapabilities()?.availableDisplayModes ?? [];
    if (context.availableDisplayModes?.includes(mode) && declared.includes(mode))
      context.displayMode = deps.setDisplayMode(mode);
    return { mode: context.displayMode ?? 'inline' };
  };
  bridge.oncalltool = async ({ name, arguments: args }) => {
    if (!deps.callTool)
      throw new ProtocolError(
        ProtocolErrorCode.MethodNotFound,
        'This host does not let interfaces call tools',
      );
    try {
      return await deps.callTool(name, args);
    } catch (error) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  bridge.addEventListener('loggingmessage', ({ level, logger, data }) =>
    deps.log?.({ server, level, ...(logger !== undefined ? { logger } : {}), data }),
  );
  bridge.addEventListener('sizechange', ({ width, height }) => deps.onSize(width, height));

  let initialized = false;
  let input: Record<string, unknown> | undefined;
  let inputSent = false;
  let ending: { result: CallToolResult } | { cancelled: string | undefined } | undefined;
  let endSent = false;
  let sending: Promise<unknown> = Promise.resolve();
  const send = (next: () => Promise<void>) => {
    sending = sending.then(next).catch(() => {});
  };
  const flush = () => {
    if (!initialized) return;
    if (!inputSent && (input !== undefined || ending)) {
      inputSent = true;
      const params = { arguments: input };
      send(() => bridge.sendToolInput(params));
    }
    if (ending && !endSent) {
      endSent = true;
      const end = ending;
      if ('result' in end) send(() => bridge.sendToolResult(end.result));
      else send(() => bridge.sendToolCancelled(end.cancelled ? { reason: end.cancelled } : {}));
    }
  };
  bridge.addEventListener('initialized', () => {
    initialized = true;
    flush();
  });

  return {
    bridge,
    connect: (transport: Transport) => bridge.connect(transport),
    feed(update: AppToolUpdate) {
      if (update.input !== undefined && input === undefined) input = update.input;
      if (!ending && update.result)
        ending = update.result.app_result
          ? { result: update.result.app_result as CallToolResult }
          : {
              cancelled: update.result.ok
                ? 'The result did not reach the interface'
                : 'The tool failed',
            };
      else if (!ending && update.cancelled !== undefined) ending = { cancelled: update.cancelled };
      flush();
    },
    /** Theme, size or display mode changed; the view hears of it once it is initialized. */
    setContext(partial: Partial<AppHostContext>) {
      Object.assign(context, partial);
      if (initialized) send(async () => bridge.sendHostContextChange(partial as McpUiHostContext));
    },
    async teardown() {
      await sending;
      if (initialized)
        await bridge.teardownResource({}, { timeout: TEARDOWN_WAIT_MS }).catch(() => {});
      await bridge.close();
    },
  };
}
