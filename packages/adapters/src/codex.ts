import { lstatSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  id,
  DomainError,
  SessionStartError,
  closeUserExtensions,
  type HarnessAdapter,
  type Capability,
  type CapabilityReport,
  type SessionSpec,
  type AgentEventSink,
  type AgentEvent,
  type SessionHandle,
  type UserTurn,
  type DeliveryReceipt,
  type NativeStatus,
  type CancelReceipt,
  type Receipt,
  type PermissionDecision,
  type ExtensionInventory,
  type McpServerStatus,
  type McpResourceContents,
  type McpToolResult,
  type EffortLevel,
  type RuntimeModel,
  type ApprovalQuestion,
  type BackgroundTask,
} from '@pantheon/domain';
import {
  CLIENT_INFO,
  nativeEnvironment,
  report,
  JsonRpcProcess,
  processIdentity,
  realPathsOnDevice,
  sandboxFactsOnDevice,
  validateSessionSpec,
} from './process.js';
import { MIN_VERSIONS } from './capabilities.js';
import { installedFields, notInstalled, readVersion, type Preflight } from './preflight.js';

import { imageLimit, needsYouLimit, tracePayload } from './trace.js';
import { plannerInstructions } from './planner.js';
import { nativeSessionTitle, prepareNativeState } from './native-state.js';

type Notification = { method: string; params?: Record<string, unknown> };
type CodexTokens = {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};
const minusTokens = (a: CodexTokens, b: CodexTokens): CodexTokens => ({
  inputTokens: (a.inputTokens ?? 0) - (b.inputTokens ?? 0),
  cachedInputTokens:
    a.cachedInputTokens === undefined
      ? undefined
      : a.cachedInputTokens - (b.cachedInputTokens ?? 0),
  cacheWriteInputTokens:
    a.cacheWriteInputTokens === undefined
      ? undefined
      : a.cacheWriteInputTokens - (b.cacheWriteInputTokens ?? 0),
  outputTokens: (a.outputTokens ?? 0) - (b.outputTokens ?? 0),
  reasoningOutputTokens:
    a.reasoningOutputTokens === undefined
      ? undefined
      : a.reasoningOutputTokens - (b.reasoningOutputTokens ?? 0),
});
type RateLimitWindow =
  | { usedPercent?: number; resetsAt?: number | null; windowDurationMins?: number | null }
  | null
  | undefined;
type RateLimitSnapshot = { primary?: RateLimitWindow; secondary?: RateLimitWindow };
/** Unix epoch milliseconds when the later used-up window resets. */
function usedUpReset(snapshot: RateLimitSnapshot | undefined): number | undefined {
  const resets = [snapshot?.primary, snapshot?.secondary].flatMap((window) =>
    window && (window.usedPercent ?? 0) >= 100 && typeof window.resetsAt === 'number'
      ? [window.resetsAt]
      : [],
  );
  // Codex reports resetsAt in Unix epoch seconds.
  return resets.length ? Math.max(...resets) * 1000 : undefined;
}
type ServerReply = (
  response: { result: unknown } | { error: { code: number; message: string } },
) => void;
/** A question of an item/tool/requestUserInput server request. */
type UserInputQuestion = {
  id: string;
  header?: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: { label: string; description?: string }[] | null;
};

// Identical bytes for every session so the provider can cache the prefix.
const PLANNER_PERSONA = `You are a read-only planning agent run by Pantheon.
Use only the tools you are given.
Do the work of the role described in the developer instructions.
Keep replies short.
Do not change files.
`;
const CODEX_PLAN_MODE_INSTRUCTION =
  'Plan mode is on: read and plan only, do not change files, and write the plan in your reply.';
// Frames whose body no reader uses; the log keeps only their type.
const TYPE_ONLY_FRAMES = new Set([
  'rawResponseItem/completed',
  'rawResponse/completed',
  'account/rateLimits/updated',
  'turn/moderationMetadata',
  'thread/readState/changed',
  'remoteControl/status/changed',
  'thread/name/updated',
  'account/updated',
  'thread/status/changed',
]);

function writerFilesystem(sandbox: NonNullable<SessionSpec['sandbox']>, onDevice: boolean) {
  const entries = new Map<string, 'read' | 'write' | 'deny'>([[':root', 'read']]);
  const protectedEntries = sandbox.protected_entries.map((entry) => ({
    ...entry,
    path: path.resolve(entry.path),
  }));
  for (const root of sandbox.writable_roots) {
    const absolute = path.resolve(root);
    entries.set(absolute, 'write');
    // A device worktree's .git is a file; Codex's Linux sandbox does not start with an entry under it.
    if (onDevice) continue;
    // A linked worktree's .git is a file. Codex on Linux fails to start for an entry below a
    // file, and its read-only mount cannot be removed, renamed or rewritten.
    if (lstatSync(path.join(absolute, '.git'), { throwIfNoEntry: false })?.isFile()) {
      entries.set(path.join(absolute, '.git'), 'read');
      continue;
    }
    entries.set(path.join(absolute, '.git'), 'write');
    protectedEntries.push(
      { path: path.join(absolute, '.git/hooks'), deny: 'write' },
      { path: path.join(absolute, '.git/config'), deny: 'write' },
    );
  }
  for (const entry of protectedEntries) entries.set(entry.path, 'read');
  // A nested writable root or a weaker protection must never reopen a protected path.
  for (const [target, access] of entries) {
    if (target === ':root') continue;
    let effective = access;
    for (const entry of protectedEntries) {
      const relative = path.relative(entry.path, target);
      if (
        relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ) {
        if (entry.deny === 'read_write') effective = 'deny';
        else if (effective === 'write') effective = 'read';
      }
    }
    entries.set(target, effective);
  }
  // Codex on Linux fails to start when it mounts an entry inside a path it has already hidden.
  const denied = [...entries].filter(([, access]) => access === 'deny').map(([target]) => target);
  for (const target of entries.keys())
    if (denied.some((dir) => target.startsWith(`${dir}${path.sep}`))) entries.delete(target);
  return Object.fromEntries(entries);
}

/** The writer profile with every writable path, the worktree included, reduced to read. */
function readOnlyFilesystem(sandbox: NonNullable<SessionSpec['sandbox']>, onDevice: boolean) {
  return Object.fromEntries(
    Object.entries(writerFilesystem(sandbox, onDevice)).map(([target, access]) => [
      target,
      access === 'write' ? 'read' : access,
    ]),
  );
}

/** A path with its symlinks resolved, also for a target that does not exist yet. */
function realTarget(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      return realTarget(path.resolve(path.dirname(absolute), readlinkSync(absolute)));
    } catch (linkError) {
      if (!['ENOENT', 'EINVAL'].includes((linkError as NodeJS.ErrnoException).code ?? ''))
        throw linkError;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(realTarget(parent), path.basename(absolute));
  }
}

type PatchChange = { path?: unknown; kind?: { type?: unknown; move_path?: unknown } };

/** The unresolved paths a patch check compares; undefined for a patch refused as written. */
function patchPaths(
  spec: SessionSpec,
  changes: PatchChange[],
  gitFile: (root: string) => boolean,
): { protectedPaths: string[]; roots?: string[]; targets: string[] } | undefined {
  const sandbox = spec.sandbox!;
  const targets = changes.flatMap((change) => [
    change.path,
    ...(change.kind?.move_path == null ? [] : [change.kind.move_path]),
  ]);
  if (
    !targets.length ||
    targets.some((target) => typeof target !== 'string' || !target || target.includes('\0'))
  )
    return undefined;
  // The user approves a user-opened session's writes anywhere but in a hidden path.
  if (spec.user_session)
    return {
      protectedPaths: sandbox.protected_entries
        .filter((entry) => entry.deny === 'read_write')
        .map((entry) => entry.path),
      targets: (targets as string[]).map((target) => path.resolve(spec.cwd, target)),
    };
  return {
    protectedPaths: [
      ...sandbox.protected_entries.map((entry) => entry.path),
      // As in writerFilesystem: a linked worktree's .git is a file, and no path exists below it.
      ...sandbox.writable_roots.flatMap((root) =>
        gitFile(root)
          ? [path.join(root, '.git')]
          : [path.join(root, '.git/hooks'), path.join(root, '.git/config')],
      ),
    ],
    roots: sandbox.writable_roots,
    targets: (targets as string[]).map((target) => path.resolve(spec.cwd, target)),
  };
}

/** Whether a resolved target sits outside every writable root or inside a protected path. */
function pathsDenied(
  paths: NonNullable<ReturnType<typeof patchPaths>>,
  resolve: (target: string) => string,
): boolean {
  const protectedPaths = paths.protectedPaths.map(resolve);
  const roots = paths.roots?.map(resolve);
  return paths.targets.some((target) => {
    const resolved = resolve(target);
    const inside = (root: string): boolean => {
      const relative = path.relative(root, resolved);
      return (
        relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    };
    return protectedPaths.some(inside) || (roots !== undefined && !roots.some(inside));
  });
}

/**
 * Approving a patch lets Codex write each target's directory, so every target, a move's
 * destination included, must sit in a writable root and outside every protected path.
 */
function patchDenied(spec: SessionSpec, changes: PatchChange[]): boolean {
  try {
    const paths = patchPaths(
      spec,
      changes,
      (root) => lstatSync(path.join(root, '.git'), { throwIfNoEntry: false })?.isFile() === true,
    );
    return !paths || pathsDenied(paths, realTarget);
  } catch {
    return true;
  }
}

const DEVICE_PATH_MS = 10_000;

/** patchDenied for a session on a device, whose files only the device can resolve. */
async function devicePatchDenied(spec: SessionSpec, changes: PatchChange[]): Promise<boolean> {
  const remote = spec.remote!;
  const roots = spec.sandbox!.writable_roots;
  const deadline = Date.now() + DEVICE_PATH_MS;
  const facts = await sandboxFactsOnDevice(
    remote,
    [],
    roots.map((root) => path.join(root, '.git')),
    spec.env_allowlist,
    deadline,
  );
  if (!facts) return true;
  const paths = patchPaths(spec, changes, (root) => facts.files[roots.indexOf(root)] !== undefined);
  if (!paths) return true;
  const asked = [...new Set([...paths.protectedPaths, ...(paths.roots ?? []), ...paths.targets])];
  const real = await realPathsOnDevice(remote, asked, spec.env_allowlist, deadline);
  if (!real) return true;
  return pathsDenied(paths, (target) => real[asked.indexOf(target)]!);
}

/** The provider a session runs on: the backend's when it has one, else OpenAI on the subscription. */
function modelProvider(spec: Pick<SessionSpec, 'backend'>): string {
  return spec.backend ? `pantheon-${spec.backend.id}` : 'openai';
}

/**
 * Returns undefined for a backend session, which bills the backend's key instead of a login.
 * loggedOut is set when the runtime reports no account, before the refusal.
 */
async function checkBillingChannel(
  rpc: JsonRpcProcess,
  spec: Pick<SessionSpec, 'cwd' | 'backend'>,
  loggedOut?: () => void,
) {
  const { cwd } = spec;
  const [result, configuration] = await Promise.all([
    spec.backend
      ? undefined
      : rpc.request<{
          account?: { type: string; planType?: string; email?: string | null } | null;
        }>('account/read', {
          refreshToken: false,
        }),
    rpc.request<{
      config: {
        forced_login_method?: string | null;
        model_provider?: string | null;
        model_providers?: Record<string, unknown>;
      };
    }>('config/read', { cwd }),
  ]);
  if (spec.backend) {
    if (configuration?.config?.model_provider !== modelProvider(spec))
      throw new DomainError('billing_channel_mismatch', 'Backend provider is not in effect');
    return;
  }
  const account = result?.account;
  if (account === null) loggedOut?.();
  if (account?.type !== 'chatgpt')
    throw new DomainError(
      'billing_channel_mismatch',
      account?.type === 'apiKey' ? 'API key account' : 'Unverified account channel',
    );
  const config = configuration?.config;
  if (!config) throw new DomainError('billing_channel_mismatch', 'Unverified provider channel');
  if (config.forced_login_method != null && config.forced_login_method !== 'chatgpt')
    throw new DomainError(
      'billing_channel_mismatch',
      config.forced_login_method === 'api' ? 'API key login' : 'Unverified login method',
    );
  // An omitted provider uses OpenAI. A user-defined entry under that name is not built-in.
  if (
    (config.model_provider ?? 'openai') !== 'openai' ||
    Object.hasOwn(config.model_providers ?? {}, 'openai')
  )
    throw new DomainError('billing_channel_mismatch', 'Custom model provider');
  return {
    channel: 'subscription' as const,
    method: 'chatgpt' as const,
    ...(typeof account.planType === 'string' ? { plan: account.planType } : {}),
    ...(typeof account.email === 'string' ? { email: account.email } : {}),
  };
}

async function readExtensions(rpc: JsonRpcProcess, cwd: string, discoverPluginTools = false) {
  type McpPolicy = {
    enabled?: boolean;
    enabled_tools?: string[];
    tools?: Record<string, unknown>;
  };
  const [config, installed, skills] = await Promise.all([
    rpc.request<{
      config: {
        mcp_servers?: Record<string, McpPolicy | null>;
        plugins?: Record<string, { mcp_servers?: Record<string, McpPolicy> }>;
        apps?: Record<
          string,
          {
            enabled?: boolean;
            tools?: Record<string, unknown>;
            links?: Record<string, unknown>;
          } | null
        >;
        features?: { apps?: boolean; hooks?: boolean };
        skills?: { config?: { path: string; enabled?: boolean }[] };
      };
      /** The layer each dotted config key comes from. */
      origins?: Record<string, { name: { type: string } }>;
    }>('config/read', { cwd }),
    rpc.request<{
      marketplaces: {
        name: string;
        path?: string | null;
        plugins: { name: string; enabled: boolean }[];
      }[];
    }>('plugin/installed', { cwds: [cwd] }),
    rpc.request<{
      data: {
        skills: {
          name: string;
          path: string;
          enabled: boolean;
          pluginId?: string | null;
          scope?: string;
        }[];
      }[];
    }>('skills/list', { cwds: [cwd] }),
  ]);
  // A server is user-level when every key declaring it comes from $CODEX_HOME/config.toml.
  const userServer = (name: string) => {
    const layers = Object.entries(config.origins ?? {})
      .filter(([key]) => key.startsWith(`mcp_servers.${name}.`))
      .map(([, origin]) => origin.name.type);
    return layers.length > 0 && layers.every((type) => type === 'user');
  };
  // Project only identifiers; configuration values must not reach events or inventory results.
  const mcpServers: {
    name: string;
    enabled: boolean;
    tool_names: string[];
    plugin?: string;
    enabled_tools?: string[];
    tools_error?: boolean;
    user?: boolean;
  }[] = Object.entries(config.config.mcp_servers ?? {}).map(([name, server]) => ({
    name,
    enabled: server?.enabled !== false,
    tool_names: Object.keys(server?.tools ?? {}),
    ...(userServer(name) ? { user: true } : {}),
  }));
  const unreadablePlugins: string[] = [];
  if (discoverPluginTools) {
    const declared = await Promise.all(
      installed.marketplaces.flatMap((market) =>
        market.plugins
          .filter((plugin) => plugin.enabled)
          .map(async (plugin) => {
            const id = `${plugin.name}@${market.name}`;
            try {
              const detail = await rpc.request<{ plugin: { mcpServers: string[] } }>(
                'plugin/read',
                {
                  pluginName: plugin.name,
                  ...(market.path
                    ? { marketplacePath: market.path }
                    : { remoteMarketplaceName: market.name }),
                },
              );
              return { plugin: id, servers: detail.plugin.mcpServers };
            } catch {
              // Its servers are unknown, so no prompting policy can cover them; the session disables it.
              return { plugin: id, servers: [], unreadable: true };
            }
          }),
      ),
    );
    for (const plugin of declared) if (plugin.unreadable) unreadablePlugins.push(plugin.plugin);
    // An unscoped list carries every user server's full tool catalog, which can be megabytes.
    const names = [...new Set(declared.flatMap((plugin) => plugin.servers))].filter(
      (name) => !Object.hasOwn(config.config.mcp_servers ?? {}, name),
    );
    const listed = await Promise.all(
      names.map(async (name) => {
        const entries: {
          name: string;
          pluginId?: string | null;
          tools: Record<string, { name: string }> | null;
          toolsError?: string | null;
        }[] = [];
        let cursor: string | null | undefined;
        do {
          const page = await rpc.request<{ data: typeof entries; nextCursor?: string | null }>(
            'mcpServerStatus/list',
            { detail: 'toolsAndAuthOnly', serverName: name, ...(cursor ? { cursor } : {}) },
            // Codex starts each MCP server to list its tools; one server may take its whole startup timeout (10 s by default).
            60_000,
          );
          entries.push(...page.data.filter((server) => server.name === name));
          cursor = page.nextCursor;
        } while (cursor);
        return entries;
      }),
    );
    for (const server of listed.flat()) {
      if (!server.pluginId) continue;
      const policy = config.config.plugins?.[server.pluginId]?.mcp_servers?.[server.name];
      const tools = Object.values(server.tools ?? {}).map((tool) => tool.name);
      mcpServers.push({
        name: server.name,
        enabled: policy?.enabled !== false,
        plugin: server.pluginId,
        tool_names: [...new Set([...tools, ...Object.keys(policy?.tools ?? {})])],
        // An undiscovered tool can carry a manifest-level approval override.
        enabled_tools: tools.filter(
          (name) => !policy?.enabled_tools || policy.enabled_tools.includes(name),
        ),
        // A null catalog means the tools are unknown, which a prompting policy cannot cover.
        tools_error: server.toolsError != null || server.tools === null,
      });
    }
    // Threadless MCP status omits project settings; never inherit an unseen server's tool policy.
    for (const plugin of declared)
      for (const name of plugin.servers)
        if (!mcpServers.some((server) => server.name === name))
          mcpServers.push({
            name,
            enabled: true,
            plugin: plugin.plugin,
            tool_names: [],
            tools_error: true,
          });
  }
  return {
    mcp_servers: mcpServers,
    unreadable_plugins: unreadablePlugins,
    app_policies: Object.entries(config.config.apps ?? {}).map(([name, app]) => ({
      name,
      // An app entry without the key is enabled.
      enabled: app?.enabled !== false,
      tools: Object.keys(app?.tools ?? {}),
      links: Object.keys(app?.links ?? {}),
    })),
    apps: config.config.features?.apps !== false,
    hooks: config.config.features?.hooks !== false,
    hooks_enabled: config.config.features?.hooks,
    disabled_skills: (config.config.skills?.config ?? [])
      .filter((skill) => skill.enabled === false)
      .map((skill) => skill.path),
    plugins: installed.marketplaces.flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => ({
        id: `${plugin.name}@${marketplace.name}`,
        enabled: plugin.enabled,
      })),
    ),
    skills: skills.data.flatMap((entry) =>
      entry.skills.map((skill) => ({
        id: skill.path,
        name: skill.name,
        path: skill.path,
        enabled: skill.enabled,
        ...(skill.pluginId ? { plugin: skill.pluginId } : {}),
        ...(skill.scope === 'user' && !skill.pluginId ? { user: true } : {}),
      })),
    ),
  };
}

type ToolEvent =
  | Omit<Extract<AgentEvent, { kind: 'tool.started' }>, 'key' | 'provider_sequence'>
  | Omit<Extract<AgentEvent, { kind: 'tool.completed' }>, 'key' | 'provider_sequence'>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A listed MCP tool: its ui:// interface and its declared visibility, each when present. */
type McpToolInfo = { resource_uri?: string; visibility?: string[] };
/** Listed MCP tools by server, then by tool name. */
type McpTools = Map<string, Map<string, McpToolInfo>>;

/** The tools of one mcpServerStatus/list entry; the _meta.ui key wins over the flat one. */
function listedTools(tools: unknown): Map<string, McpToolInfo> {
  const listed = new Map<string, McpToolInfo>();
  for (const tool of isObject(tools) ? Object.values(tools) : []) {
    if (!isObject(tool) || typeof tool.name !== 'string') continue;
    const meta = isObject(tool._meta) ? tool._meta : {};
    const ui = isObject(meta.ui) ? meta.ui : {};
    const uri = typeof ui.resourceUri === 'string' ? ui.resourceUri : meta['ui/resourceUri'];
    listed.set(tool.name, {
      ...(typeof uri === 'string' && uri.startsWith('ui://') ? { resource_uri: uri } : {}),
      ...(Array.isArray(ui.visibility)
        ? { visibility: ui.visibility.filter((item) => typeof item === 'string') }
        : {}),
    });
  }
  return listed;
}

/** The ui:// interface of an mcpToolCall item: its own fields first, then the listed tools. */
function itemApp(
  item: Record<string, unknown>,
  tools: McpTools | undefined,
): { server: string; resource_uri: string } | undefined {
  if (typeof item.server !== 'string') return;
  const uri = [
    isObject(item.mcpAppUi) ? item.mcpAppUi.resourceUri : undefined,
    item.mcpAppResourceUri,
    typeof item.tool === 'string'
      ? tools?.get(item.server)?.get(item.tool)?.resource_uri
      : undefined,
  ].find((value): value is string => typeof value === 'string' && value.startsWith('ui://'));
  return uri ? { server: item.server, resource_uri: uri } : undefined;
}

const APP_RESULT_LIMIT = 1_048_576;
// One MCP status reply holds whole tool catalogs, whose output schemas can run to megabytes.
const CODEX_MAX_LINE = 64 * 1024 * 1024;

/** The MCP CallToolResult an interface receives; absent when even its content is too long. */
function appResult(
  item: Record<string, unknown>,
): NonNullable<Extract<AgentEvent, { kind: 'tool.completed' }>['app_result']> | undefined {
  const result = isObject(item.result) ? item.result : undefined;
  const error =
    isObject(item.error) && typeof item.error.message === 'string' ? item.error.message : undefined;
  const failed = item.status === 'failed' || !!item.error;
  if (!result && error === undefined) return;
  const base = result
    ? {
        content: Array.isArray(result.content) ? result.content : [],
        ...(failed ? { isError: true } : {}),
      }
    : { content: [{ type: 'text', text: error }], isError: true };
  const full = {
    ...base,
    ...(result?.structuredContent != null ? { structuredContent: result.structuredContent } : {}),
    ...(isObject(result?._meta) ? { _meta: result._meta } : {}),
  };
  if (JSON.stringify(full).length <= APP_RESULT_LIMIT) return full;
  return JSON.stringify(base).length <= APP_RESULT_LIMIT ? base : undefined;
}

function rawToolEvent(frame: Notification, started: ToolEvent[]): ToolEvent | undefined {
  const item = frame.params?.item as Record<string, unknown> | undefined;
  if (!item || typeof item.call_id !== 'string') return;
  switch (item.type) {
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call': {
      const name =
        item.type === 'local_shell_call'
          ? 'local_shell_call'
          : typeof item.name === 'string'
            ? typeof item.namespace === 'string'
              ? `${item.namespace}.${item.name}`
              : item.name
            : undefined;
      if (!name) return;
      let input =
        item.type === 'local_shell_call'
          ? item.action
          : item.type === 'custom_tool_call'
            ? item.input
            : item.arguments;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          // Custom tools and invalid calls can carry plain text.
        }
      }
      return { kind: 'tool.started', tool_call_id: item.call_id, name, input: tracePayload(input) };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const { text, ok } = toolOutputOutcome(item.output);
      const needsYou = started.some(
        (tool) =>
          tool.kind === 'tool.started' &&
          tool.tool_call_id === item.call_id &&
          tool.name === 'pantheon.needs_you',
      );
      return {
        kind: 'tool.completed',
        tool_call_id: item.call_id,
        ok: ok ?? true,
        output: tracePayload({ text }, needsYou ? needsYouLimit : undefined),
      };
    }
  }
}

// `ok` is undefined when the output neither reports an exit code nor a sandbox refusal.
export function toolOutputOutcome(output: unknown): { text: string; ok?: boolean } {
  const text =
    typeof output === 'string'
      ? output
      : Array.isArray(output)
        ? output
            .filter((part) => typeof part?.text === 'string')
            .map((part) => part.text)
            .join('\n')
        : '';
  let structured: unknown;
  try {
    structured = JSON.parse(text);
  } catch {
    // Most outputs are text.
  }
  if (
    isObject(structured) &&
    isObject(structured.metadata) &&
    typeof structured.metadata.exit_code === 'number'
  )
    return { text, ok: structured.metadata.exit_code === 0 };
  // Codex's own lines come before its `Output:` line; what follows is the tool's output.
  const wrapper = text.split(/^Output:$/m)[0]!.split('\n');
  const codes = wrapper.flatMap((line) => {
    const code = /^(?:Process exited with code|Exit code:) (-?\d+)$/.exec(line)?.[1];
    return code === undefined ? [] : [Number(code)];
  });
  const refused = wrapper.some(
    (line) =>
      /^[\w.-]+ failed: /.test(line) &&
      /\b(?:operation not permitted|permission denied|read-only file system|sandboxdenied|sandbox[ _-]+(?:denied|refused|rejected)|(?:denied|refused|rejected) by (?:the )?sandbox)\b/i.test(
        line,
      ),
  );
  if (refused || codes.some((code) => code !== 0)) return { text, ok: false };
  return codes.length ? { text, ok: true } : { text };
}

function toolEvent(frame: Notification, tools?: McpTools): ToolEvent | undefined {
  if (frame.method !== 'item/started' && frame.method !== 'item/completed') return;
  const item = frame.params?.item as Record<string, unknown> | undefined;
  if (!item || typeof item.id !== 'string') return;
  let name: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    ok = item.status === 'completed',
    app: { server: string; resource_uri: string } | undefined,
    images: { mime: string; data: string }[] | undefined;
  switch (item.type) {
    case 'commandExecution':
      name = 'commandExecution';
      input = { command: item.command, cwd: item.cwd };
      output = { text: item.aggregatedOutput, exitCode: item.exitCode, status: item.status };
      ok &&= item.exitCode == null || item.exitCode === 0;
      break;
    case 'fileChange':
      name = 'fileChange';
      input = { changes: item.changes };
      output = { changes: item.changes, status: item.status };
      break;
    case 'mcpToolCall':
      name = `${item.server}.${item.tool}`;
      input = { server: item.server, tool: item.tool, arguments: item.arguments };
      output = { result: item.result, error: item.error, status: item.status };
      ok &&= !item.error;
      app = itemApp(item, tools);
      break;
    case 'dynamicToolCall':
      name = 'dynamicToolCall';
      input = { namespace: item.namespace, tool: item.tool, arguments: item.arguments };
      output = { contentItems: item.contentItems, success: item.success, status: item.status };
      ok &&= item.success !== false;
      break;
    case 'collabAgentToolCall':
      name = 'collabAgentToolCall';
      input = {
        tool: item.tool,
        senderThreadId: item.senderThreadId,
        receiverThreadIds: item.receiverThreadIds,
        prompt: item.prompt,
      };
      output = { agentsStates: item.agentsStates, status: item.status };
      break;
    case 'webSearch':
      ok = item.status === undefined || item.status === 'completed';
      name = 'webSearch';
      input = { query: item.query, action: item.action };
      output = { query: item.query, action: item.action, results: item.results };
      break;
    case 'imageView':
      ok = item.status === undefined || item.status === 'completed';
      name = 'imageView';
      input = { path: item.path };
      output = { path: item.path };
      break;
    case 'sleep':
      ok = item.status === undefined || item.status === 'completed';
      name = 'sleep';
      input = { durationMs: item.durationMs };
      output = { durationMs: item.durationMs };
      break;
    case 'imageGeneration':
      name = 'imageGeneration';
      input = { revisedPrompt: item.revisedPrompt, inputImages: item.inputImages };
      output = {
        result: item.result,
        fileId: item.fileId,
        savedPath: item.savedPath,
        failure: item.failure,
        status: item.status,
      };
      ok &&= !item.failure;
      if (typeof item.result === 'string' && item.result && item.result.length <= imageLimit)
        images = [{ mime: 'image/png', data: item.result }];
      break;
    default:
      return;
  }
  const duration = item.durationMs;
  const result = app && frame.method === 'item/completed' ? appResult(item) : undefined;
  return frame.method === 'item/started'
    ? {
        kind: 'tool.started',
        tool_call_id: item.id,
        name,
        input: tracePayload(input),
        ...(app ? { app } : {}),
      }
    : {
        kind: 'tool.completed',
        tool_call_id: item.id,
        ok,
        output: tracePayload(output, name === 'pantheon.needs_you' ? needsYouLimit : undefined),
        ...(['commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(String(item.type)) &&
        typeof duration === 'number' &&
        Number.isFinite(duration) &&
        duration >= 0
          ? { duration_ms: duration }
          : {}),
        ...(result ? { app_result: result } : {}),
        ...(images ? { images } : {}),
      };
}

/** The summary text of a completed reasoning item, when it has any. */
function reasoningSummary(frame: Notification): string | undefined {
  if (frame.method !== 'item/completed') return;
  const item = frame.params?.item as { type?: unknown; summary?: unknown } | undefined;
  if (item?.type !== 'reasoning' || !Array.isArray(item.summary)) return;
  const text = item.summary.filter((part) => typeof part === 'string').join('\n\n');
  return text.trim() ? text : undefined;
}

interface CodexModel {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  defaultReasoningEffort: string;
  isDefault: boolean;
  serviceTiers: { id: string; name: string; description: string }[];
  defaultServiceTier: string | null;
}

async function listModels(rpc: JsonRpcProcess): Promise<CodexModel[]> {
  const models: CodexModel[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: CodexModel[]; nextCursor: string | null } = await rpc.request(
      'model/list',
      cursor ? { cursor } : {},
    );
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}

async function fastTier(rpc: JsonRpcProcess, model: string | undefined): Promise<string> {
  const rows = await listModels(rpc);
  const selected = rows.find((row) => (model ? row.model === model : row.isDefault));
  const tier = selected?.serviceTiers.find((tier) => tier.id === 'fast' || tier.id === 'priority');
  if (!tier) throw new DomainError('unsupported_capability', 'Model has no fast service tier');
  return tier.id;
}

/** Runs a model or speed change after the ones called before it. */
function inOrder<T>(session: CodexSession, change: () => Promise<T>): Promise<T> {
  const run = (session.tierChange ?? Promise.resolve()).then(change);
  session.tierChange = run.catch(() => {});
  return run;
}

interface CodexSession {
  spec: SessionSpec;
  emit: AgentEventSink;
  rpc: JsonRpcProcess;
  turns: Map<string, string>;
  sequence: number;
  state: NativeStatus['state'];
  error?: Error;
  stopping?: boolean;
  /** A turn/start carried an effort, which stays in force until another one replaces it. */
  effortSent?: boolean;
  serviceTier?: string;
  /** The last model or speed change; the next waits for it, so the later call wins. */
  tierChange?: Promise<unknown>;
  /** The thread's permission profiles; a turn/start selection stays in force for later turns. */
  profiles?: { writer: string; readOnly: string };
  /** The profile the last turn/start selected; undefined means the thread's default writer profile. */
  profileSent?: string;
  /** The sandbox the user's Codex config gave a user-opened session, selected again after a read-only turn. */
  userSandbox?: { permissions: string } | { sandboxPolicy: unknown };
  /** Who answers approvals in a user-opened session, as its thread reported; a read-only turn overrides it. */
  userReviewer?: string;
  /** The last turn/start narrowed a user-opened session to read-only. */
  readOnlySent?: boolean;
  /** Running commandExecution items by item id; background once the turn that started them ended. */
  commands: Map<string, BackgroundTask & { background?: true }>;
  /** The MCP tools of the latest status read on this process; empty until one succeeds. */
  mcpTools: McpTools;
  /** The latest call that showed each interface, by JSON [server, resource_uri]. */
  appCalls: Map<string, string>;
  /** Subagent threads by thread id: the collab call that spawned each and whether it ended. */
  subagents: Map<string, { call: string; ended?: true }>;
  turn?: {
    id: string;
    /** The user turn runs on the read-only profile. */
    readOnly: boolean;
    native_id?: string;
    usage?: CodexTokens;
    /** Thread totals before the turn's first model request. */
    usageBase?: CodexTokens;
    contextTokens?: number;
    contextWindow?: number;
    /** Compactions this turn announced by thread/compacted and by a completed contextCompaction item. */
    compactions?: { notices: number; items: number };
    compact?: true;
    pending: Notification[];
    pendingRequests: (() => void)[];
    rawTools: ToolEvent[];
    v2ToolIds: Set<string>;
    /** Ids of the commandExecution items this turn started. */
    commands: Set<string>;
    /** Target paths of each announced patch item, since its approval request carries none. */
    patches: Map<string, PatchChange[]>;
    permissions: Map<
      string,
      (decision: PermissionDecision, cancelled?: boolean, answers?: Record<string, string>) => void
    >;
    /** Stops the wall clock while a permission request waits; restarting it keeps the time left. */
    pauseClock: (paused: boolean) => void;
    /** The user interrupted this turn; turn/interrupt goes out once native_id is known. */
    interrupted?: boolean;
    /** codexErrorInfo of an error notification of this turn. */
    errorInfo?: unknown;
    finish: (
      status: 'completed' | 'interrupted' | 'failed',
      error?: string,
      frame?: Notification,
      error_code?: string,
      resets_at?: number,
    ) => void;
  };
  /** Pantheon names this new thread; input is its first message until the name is asked for. */
  autoTitle?: { input?: string };
  /** The hidden thread that generates the name; its frames never reach the session. */
  titleThread?: { id: string; frame: (frame: Notification) => void };
  notification: (frame: Notification) => void;
}

/** Reports the commands that outlived the turn that started them. */
function emitBackground(session: CodexSession): void {
  session.emit({
    key: String(++session.sequence),
    provider_sequence: session.sequence,
    kind: 'background.changed',
    tasks: [...session.commands.values()]
      .filter((command) => command.background)
      .map(({ id, kind, description, started_at }) => ({ id, kind, description, started_at })),
  });
}

/** Keeps the target paths of a patch item that starts, since its approval request carries none. */
function rememberPatch(turn: CodexSession['turn'], frame: Notification): void {
  const item = frame.params?.item as
    { type?: unknown; id?: unknown; changes?: unknown } | undefined;
  if (
    frame.method === 'item/started' &&
    item?.type === 'fileChange' &&
    typeof item.id === 'string' &&
    Array.isArray(item.changes)
  )
    turn?.patches.set(
      item.id,
      (item.changes as (PatchChange | null)[]).map((change) => ({
        path: change?.path,
        kind: change?.kind,
      })),
    );
}

/** Starts a task for each thread a spawn dispatches and ends one once a call marks its thread done. */
function emitSubagentEdges(
  session: CodexSession,
  frame: Notification,
  turn_id: string | undefined,
): void {
  const item = frame.params?.item as Record<string, unknown> | undefined;
  if (item?.type !== 'collabAgentToolCall' || typeof item.id !== 'string') return;
  const edge = { native_type: frame.method, ...(turn_id ? { turn_id } : {}) };
  if (
    frame.method === 'item/started' &&
    /^spawn/i.test(String(item.tool)) &&
    Array.isArray(item.receiverThreadIds)
  )
    for (const thread of item.receiverThreadIds) {
      if (typeof thread !== 'string' || session.subagents.has(thread)) continue;
      session.subagents.set(thread, { call: item.id });
      session.emit({
        key: String(++session.sequence),
        provider_sequence: session.sequence,
        ...edge,
        kind: 'task.started',
        task: {
          id: thread,
          kind: 'agent',
          tool_call_id: item.id,
          description: String(item.prompt ?? '')
            .split('\n')[0]!
            .slice(0, 200),
          background: false,
          started_at: Date.now(),
        },
      });
    }
  if (frame.method !== 'item/completed' || !item.agentsStates) return;
  for (const [thread, state] of Object.entries(item.agentsStates as Record<string, unknown>)) {
    const subagent = session.subagents.get(thread);
    const status = (state as { status?: unknown } | null)?.status;
    if (!subagent || subagent.ended || (status !== 'completed' && status !== 'errored')) continue;
    subagent.ended = true;
    session.emit({
      key: String(++session.sequence),
      provider_sequence: session.sequence,
      ...edge,
      kind: 'task.ended',
      task_id: thread,
      state: status === 'completed' ? 'completed' : 'failed',
    });
  }
}

/** Asks the app-server to end one native turn and the commands it started; the process and thread stay open. */
async function interruptNativeTurn(
  session: CodexSession,
  threadId: string,
  turnId: string,
  commands: Set<string>,
): Promise<Receipt> {
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  try {
    await session.rpc.request('turn/interrupt', { threadId, turnId });
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  if (!commands.size) return { ok: true };
  // Codex keeps an interrupted turn's commands running as background terminals; earlier turns' ones stay.
  const terminals: { itemId?: unknown; processId?: unknown }[] = [];
  const failures: string[] = [];
  try {
    let cursor: string | null | undefined;
    do {
      const page = await session.rpc.request<{
        data?: { itemId?: unknown; processId?: unknown }[];
        nextCursor?: string | null;
      }>('thread/backgroundTerminals/list', { threadId, ...(cursor ? { cursor } : {}) });
      terminals.push(...(page?.data ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
  } catch (error) {
    failures.push(message(error));
  }
  for (const terminal of terminals) {
    if (typeof terminal.itemId !== 'string' || !commands.has(terminal.itemId)) continue;
    try {
      await session.rpc.request('thread/backgroundTerminals/terminate', {
        threadId,
        processId: terminal.processId,
      });
    } catch (error) {
      failures.push(message(error));
    }
  }
  return failures.length
    ? { ok: true, reason: `The turn's commands were not stopped: ${failures.join('; ')}` }
    : { ok: true };
}

/** Codex reports efforts as free strings; only the ones Pantheon knows are kept. */
const EFFORT_LEVELS: Record<EffortLevel, true> = {
  none: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  ultra: true,
};
const isEffortLevel = (effort: string): effort is EffortLevel =>
  Object.hasOwn(EFFORT_LEVELS, effort);

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The text with file paths appended, then one entry per image and per skill. */
function nativeInput(turn: Pick<UserTurn, 'input' | 'attachments' | 'skills'>) {
  const attachments = turn.attachments ?? [];
  const files = attachments.filter((attachment) => !IMAGE_MIMES.has(attachment.mime));
  const text = files.length
    ? `${turn.input}\n\nAttached files:\n${files.map((file) => `- ${file.path}`).join('\n')}`
    : turn.input;
  return [
    { type: 'text', text },
    ...attachments
      .filter((attachment) => IMAGE_MIMES.has(attachment.mime))
      .map((image) => ({ type: 'localImage', path: image.path })),
    ...(turn.skills ?? []).map((skill) => ({ type: 'skill', name: skill.name, path: skill.path })),
  ];
}

function bindNativeTurn(
  session: CodexSession,
  threadId: string,
  current: NonNullable<CodexSession['turn']>,
  nativeId: string,
): void {
  current.native_id = nativeId;
  session.turns.set(nativeId, current.id);
  if (current.interrupted)
    void interruptNativeTurn(session, threadId, nativeId, current.commands).then((receipt) => {
      if (!receipt.ok) current.interrupted = false;
    });
  for (const frame of current.pending.splice(0)) session.notification(frame);
  for (const request of current.pendingRequests.splice(0)) request();
}

/** Starts a native turn for the current user turn; frames that arrived before its id are replayed. */
async function startNativeTurn(
  session: CodexSession,
  threadId: string,
  current: NonNullable<CodexSession['turn']>,
  turn: Pick<UserTurn, 'input' | 'attachments' | 'skills' | 'compact'>,
): Promise<void> {
  try {
    if (turn.compact) {
      await session.rpc.request('thread/compact/start', { threadId });
      return;
    }
    const effort = session.spec.effort ?? (session.effortSent ? null : undefined);
    if (session.spec.effort) session.effortSent = true;
    // Codex 0.164 failed turns whose profile came from a `permissions` field, so only a change sends one.
    const wanted =
      session.profiles && (current.readOnly ? session.profiles.readOnly : session.profiles.writer);
    const profile =
      wanted !== (session.profileSent ?? session.profiles?.writer) ? wanted : undefined;
    if (profile !== undefined) session.profileSent = profile;
    // A turn/start sandbox stays in force for later turns, so the turn after a read-only one restores it.
    const userSandbox = session.spec.user_session
      ? current.readOnly
        ? // The user's auto reviewer would approve an escalation past the read-only sandbox.
          { sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' }
        : session.readOnlySent
          ? {
              ...(session.spec.permission_mode !== 'full_access' ? session.userSandbox : {}),
              ...(session.userReviewer ? { approvalsReviewer: session.userReviewer } : {}),
            }
          : undefined
      : undefined;
    if (session.spec.user_session) session.readOnlySent = current.readOnly;
    const started = await session.rpc.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: nativeInput(turn),
      ...(session.spec.model ? { model: session.spec.model } : {}),
      serviceTier: session.serviceTier ?? 'default',
      ...(session.spec.permission_mode === 'full_access'
        ? {
            sandboxPolicy: current.readOnly
              ? { type: 'readOnly', networkAccess: false }
              : { type: 'dangerFullAccess' },
          }
        : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(profile !== undefined ? { permissions: profile } : {}),
      ...userSandbox,
    });
    if (session.turn !== current) return;
    if (!started?.turn?.id) throw new Error('Codex did not return a turn id');
    bindNativeTurn(session, threadId, current, started.turn.id);
  } catch (error) {
    if (session.turn === current) {
      if (turn.compact) {
        current.finish(
          session.stopping ? 'interrupted' : 'failed',
          session.stopping ? undefined : String(error),
        );
        return;
      }
      session.state = 'unknown';
      current.finish(
        session.stopping ? 'interrupted' : 'failed',
        session.stopping ? undefined : String(error),
      );
      session.stopping = true;
      void session.rpc.close().then((receipt) => {
        session.state = receipt.stopped ? 'exited' : 'unknown';
      });
    }
  }
}

// Copied from codex-rs rust-v0.166.0 tui/src/app/thread_title.rs.
const THREAD_TITLE_MAX_CHARS = 36;
const THREAD_TITLE_MODEL = 'gpt-5.6-luna';
const THREAD_TITLE_PROMPT_MAX_BYTES = 960;
const THREAD_TITLE_INSTRUCTIONS = `Generate a concise, single-line task title of at most ${THREAD_TITLE_MAX_CHARS} characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.`;
const THREAD_TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: THREAD_TITLE_MAX_CHARS },
  },
  required: ['title'],
  additionalProperties: false,
};
const THREAD_TITLE_SOURCE = 'thread_title';
// The hidden thread runs without tools, extensions or environment access, as in
// codex-rs rust-v0.166.0 tui/src/temporary_structured_request.rs.
const TITLE_THREAD_CONFIG = {
  'features.apps': false,
  'features.code_mode': false,
  'features.code_mode_only': false,
  'features.context_management': false,
  'features.current_time_reminder': false,
  'features.deferred_executor': false,
  'features.enable_fanout': false,
  'features.goals': false,
  'features.hooks': false,
  'features.image_generation': false,
  'features.memories': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.plugins': false,
  'features.request_permissions_tool': false,
  'features.shell_snapshot': false,
  'features.shell_tool': false,
  'features.standalone_web_search': false,
  'features.token_budget': false,
  'features.tool_suggest': false,
  'features.unified_exec': false,
  'features.view_image': false,
  'cloud.skills.enabled': false,
  'skills.include_instructions': false,
  'tools.experimental_request_user_input.enabled': false,
  'tools.update_plan.enabled': false,
  web_search: 'disabled',
  default_permissions: ':read-only',
};
const TITLE_TURN_TIMEOUT_MS = 30000;

/** The title request for a message, cut to 960 bytes without splitting a character. */
function threadTitlePrompt(message: string): string {
  const prefix = `${THREAD_TITLE_INSTRUCTIONS}\n\nUser prompt:\n`;
  let left = THREAD_TITLE_PROMPT_MAX_BYTES - Buffer.byteLength(prefix);
  let text = '';
  for (const character of message.trim()) {
    left -= Buffer.byteLength(character);
    if (left < 0) break;
    text += character;
  }
  return prefix + text;
}

/** The title in a structured answer, without quotes or end punctuation, at most 36 characters. */
function parseThreadTitle(response: string): string | undefined {
  let answer: unknown;
  try {
    answer = JSON.parse(response);
  } catch {
    return undefined;
  }
  if (!answer || typeof answer !== 'object' || Object.keys(answer).join() !== 'title')
    return undefined;
  const { title } = answer as { title: unknown };
  if (typeof title !== 'string') return undefined;
  const normalized = title
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .replace(/[.?!]+$/, '')
    .trimEnd();
  return normalized ? [...normalized].slice(0, THREAD_TITLE_MAX_CHARS).join('') : undefined;
}

async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the title request on a hidden ephemeral thread of the session's app-server. */
async function generateThreadTitle(
  session: CodexSession,
  model: string | undefined,
  input: string,
): Promise<string> {
  const { rpc, spec } = session;
  let hidden: string | undefined;
  try {
    const listed = await rpc.request<{ data?: { model?: string }[] }>('model/list', {
      includeHidden: true,
    });
    const titleModel = listed?.data?.some((entry) => entry.model === THREAD_TITLE_MODEL);
    const effective = await rpc.request<{ config?: { mcp_servers?: Record<string, unknown> } }>(
      'config/read',
      { includeLayers: false, cwd: spec.cwd },
    );
    const started = await rpc.request<{ thread?: { id?: string }; sandbox?: { type?: string } }>(
      'thread/start',
      {
        ...(titleModel ? { model: THREAD_TITLE_MODEL } : model ? { model } : {}),
        modelProvider: modelProvider(spec),
        cwd: spec.cwd,
        sandbox: 'read-only',
        runtimeWorkspaceRoots: [],
        ephemeral: true,
        threadSource: THREAD_TITLE_SOURCE,
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
        config: {
          ...TITLE_THREAD_CONFIG,
          mcp_servers: Object.fromEntries(
            Object.keys(effective?.config?.mcp_servers ?? {}).map((name) => [
              name,
              { enabled: false },
            ]),
          ),
        },
      },
    );
    hidden = started?.thread?.id;
    if (!hidden) throw new Error('Codex did not return the title thread id');
    if (started.sandbox?.type !== 'readOnly')
      throw new Error('The Codex title thread did not start read-only');
    const thread = hidden;
    const answer = new Promise<{ status: unknown; text?: string }>((resolve) => {
      let text: string | undefined;
      session.titleThread = {
        id: thread,
        frame: (frame) => {
          const p = frame.params ?? {};
          const item = p.item as { type?: unknown; text?: unknown } | undefined;
          if (frame.method === 'item/completed' && item?.type === 'agentMessage')
            text = typeof item.text === 'string' ? item.text : undefined;
          if (frame.method === 'turn/completed')
            resolve({ status: (p.turn as { status?: unknown } | undefined)?.status, text });
        },
      };
    });
    const { status, text } = await within(
      rpc
        .request('turn/start', {
          threadId: thread,
          input: [{ type: 'text', text: threadTitlePrompt(input), text_elements: [] }],
          outputSchema: THREAD_TITLE_SCHEMA,
          ...(titleModel ? { effort: 'low' } : {}),
        })
        .then(() => answer),
      TITLE_TURN_TIMEOUT_MS,
      'Codex title turn timed out',
    );
    if (status !== 'completed') throw new Error(`Codex title turn ended ${String(status)}`);
    const title = text === undefined ? undefined : parseThreadTitle(text);
    if (!title) throw new Error('Codex title turn returned no title');
    return title;
  } finally {
    session.titleThread = undefined;
    if (hidden) await rpc.request('thread/unsubscribe', { threadId: hidden }).catch(() => {});
  }
}

/** Names a new thread as the Codex TUI does, only while the thread still has no name. */
async function nameThread(
  session: CodexSession,
  handle: SessionHandle,
  input: string,
): Promise<void> {
  try {
    const title = await generateThreadTitle(
      session,
      session.spec.model ?? handle.reported_model,
      input,
    );
    const read = await session.rpc.request<{ thread?: { name?: string | null } }>('thread/read', {
      threadId: handle.native_session_id,
      includeTurns: false,
    });
    if (read?.thread?.name) return;
    await session.rpc.request('thread/name/set', {
      threadId: handle.native_session_id,
      name: title,
    });
    session.emit({
      key: String(++session.sequence),
      provider_sequence: session.sequence,
      kind: 'title.generated',
      title,
    });
  } catch (error) {
    console.warn(
      'Codex thread title was not generated:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Config overrides that send the app-server to the backend; the key stays in the environment. */
function backendConfig(backend: NonNullable<SessionSpec['backend']>): string[] {
  const provider = `pantheon-${backend.id}`;
  return [
    ['model_provider', provider],
    [`model_providers.${provider}.name`, provider],
    [`model_providers.${provider}.base_url`, backend.base_url],
    [`model_providers.${provider}.env_key`, 'PANTHEON_BACKEND_KEY'],
    [`model_providers.${provider}.wire_api`, 'responses'],
  ].flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}

// Each of these replaces the sandbox or approval policy Pantheon sets for a session.
const REFUSED_ARGS = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  // A profile can carry its own sandbox and approval settings.
  '-p',
  '--profile',
]);
const REFUSED_CONFIG = /^\s*(sandbox|approval_policy)/;

function refuseArgs(args: readonly string[]): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    // `--flag=value` and `-xvalue` carry their value in the same word.
    const [flag, inline] = arg.startsWith('--')
      ? (arg.split(/=(.*)/s) as [string, string | undefined])
      : arg.startsWith('-') && arg.length > 2
        ? [arg.slice(0, 2), arg.slice(2).replace(/^=/, '')]
        : [arg, undefined];
    const value = flag === '-c' || flag === '--config' ? (inline ?? args[++index]) : undefined;
    if (REFUSED_ARGS.has(flag) || (value !== undefined && REFUSED_CONFIG.test(value)))
      throw new DomainError('invalid_user_config', `Codex argument ${arg} is not allowed`);
  }
}

const OWN_CAPABILITIES: Record<string, Capability> = {
  conversation_rollback: {
    status: 'supported',
    evidence:
      'App-server thread/fork lastTurnId retains history through the selected turn; not live-verified',
  },
  fork_within_turn: {
    status: 'unsupported',
    evidence:
      'App-server ThreadForkParams accepts lastTurnId or beforeTurnId, but no item or message boundary',
  },
  manual_compaction: {
    status: 'supported',
    evidence: 'The app-server exposes thread/compact/start without instructions; not live-verified',
  },
  compaction_instructions: {
    status: 'unsupported',
    evidence: 'thread/compact/start takes only the thread id',
  },
  turn_write_unlock: {
    status: 'unsupported',
    evidence:
      'The permission profile of a turn is chosen at turn/start; setTurnReadOnly changes only its later fileChange approvals',
  },
  turn_model_change: {
    status: 'supported',
    evidence: 'setModel during a turn is accepted and carried by the next turn/start',
  },
};

export class CodexAdapter implements HarnessAdapter {
  name = 'codex';
  backendProtocols = ['openai-responses'] as const;
  questionTool = 'request_user_input';
  generatesTitles = true;
  report: CapabilityReport;
  private sessions = new WeakMap<SessionHandle, CodexSession>();
  private readonly args: string[];
  constructor(
    readonly binary = 'codex',
    version = 'unprobed',
    options: { args?: string[] } = {},
  ) {
    refuseArgs(options.args ?? []);
    this.args = [...(options.args ?? [])];
    this.report = report('codex', version, false, OWN_CAPABILITIES);
  }
  async probe() {
    return this.report;
  }
  async reconnect(): Promise<void> {
    const rpc = new JsonRpcProcess(this.binary, [...this.args, 'app-server']);
    try {
      await rpc.initialize();
    } finally {
      await rpc.close();
    }
  }
  async mcpStatus(cwd: string, handle?: SessionHandle): Promise<McpServerStatus[]> {
    const session = handle ? this.sessions.get(handle) : undefined;
    const live = session?.rpc;
    const rpc =
      live ??
      new JsonRpcProcess(
        this.binary,
        [...this.args, 'app-server'],
        cwd,
        undefined,
        {},
        { maxLine: CODEX_MAX_LINE },
      );
    try {
      if (!live) await rpc.initialize();
      const servers: McpServerStatus[] = [];
      const tools: McpTools = new Map();
      let cursor: string | null | undefined;
      do {
        const raw = await rpc.request(
          'mcpServerStatus/list',
          {
            detail: 'toolsAndAuthOnly',
            ...(live ? { threadId: handle!.native_session_id } : {}),
            ...(cursor ? { cursor } : {}),
          },
          60_000,
        );
        if (!raw || typeof raw !== 'object' || !('data' in raw) || !Array.isArray(raw.data))
          throw new Error('Codex returned an invalid MCP status page');
        for (const server of raw.data as unknown[]) {
          if (
            !server ||
            typeof server !== 'object' ||
            !('name' in server) ||
            typeof server.name !== 'string' ||
            !('tools' in server) ||
            (server.tools !== null && typeof server.tools !== 'object') ||
            ('toolsError' in server &&
              server.toolsError != null &&
              typeof server.toolsError !== 'string')
          )
            throw new Error('Codex returned an invalid MCP server status');
          const reason = 'toolsError' in server ? (server.toolsError as string | null) : undefined;
          tools.set(server.name, listedTools(server.tools));
          servers.push({
            name: server.name,
            state: reason ? 'failed' : server.tools === null ? 'unknown' : 'connected',
            ...(reason ? { reason } : {}),
          });
        }
        if ('nextCursor' in raw && raw.nextCursor != null && typeof raw.nextCursor !== 'string')
          throw new Error('Codex returned an invalid MCP status cursor');
        cursor = 'nextCursor' in raw ? (raw.nextCursor as string | null) : undefined;
      } while (cursor);
      if (session) session.mcpTools = tools;
      return servers;
    } finally {
      if (!live) await rpc.close();
    }
  }
  async readMcpResource(
    handle: SessionHandle,
    server: string,
    uri: string,
  ): Promise<McpResourceContents> {
    const session = this.liveSession(handle);
    const origin = session.appCalls.get(JSON.stringify([server, uri]));
    const raw = await session.rpc.request('mcpServer/resource/read', {
      threadId: handle.native_session_id,
      server,
      uri,
      ...(origin ? { originCallId: origin } : {}),
    });
    if (!isObject(raw) || !Array.isArray(raw.contents))
      throw new Error('Codex returned an invalid MCP resource');
    return {
      contents: raw.contents.map((item: unknown) => {
        if (!isObject(item) || typeof item.uri !== 'string')
          throw new Error('Codex returned an invalid MCP resource item');
        return {
          uri: item.uri,
          ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
          ...(typeof item.text === 'string' ? { text: item.text } : {}),
          ...(typeof item.blob === 'string' ? { blob: item.blob } : {}),
          ...(isObject(item._meta) ? { _meta: item._meta } : {}),
        };
      }),
    };
  }
  async callMcpTool(
    handle: SessionHandle,
    server: string,
    tool: string,
    args: Record<string, unknown> | undefined,
  ): Promise<McpToolResult> {
    const raw = await this.liveSession(handle).rpc.request(
      'mcpServer/tool/call',
      {
        threadId: handle.native_session_id,
        server,
        tool,
        ...(args ? { arguments: args } : {}),
      },
      // No client deadline: the tool runs as long as the runtime lets it.
      null,
    );
    if (!isObject(raw) || !Array.isArray(raw.content))
      throw new Error('Codex returned an invalid MCP tool result');
    return {
      content: raw.content,
      ...(raw.structuredContent != null ? { structuredContent: raw.structuredContent } : {}),
      ...(typeof raw.isError === 'boolean' ? { isError: raw.isError } : {}),
      ...(isObject(raw._meta) ? { _meta: raw._meta } : {}),
    };
  }
  /** Rereads the server's tools on the thread's own MCP connection. */
  async findMcpTool(
    handle: SessionHandle,
    server: string,
    tool: string,
  ): Promise<{ visibility?: string[] } | undefined> {
    const session = this.liveSession(handle);
    const tools = new Map<string, McpToolInfo>();
    let cursor: string | null | undefined;
    do {
      const raw = await session.rpc.request(
        'mcpServerStatus/list',
        {
          detail: 'toolsAndAuthOnly',
          threadId: handle.native_session_id,
          serverName: server,
          ...(cursor ? { cursor } : {}),
        },
        60_000,
      );
      if (!isObject(raw) || !Array.isArray(raw.data))
        throw new Error('Codex returned an invalid MCP status page');
      for (const entry of raw.data as unknown[])
        if (isObject(entry) && entry.name === server)
          for (const [name, info] of listedTools(entry.tools)) tools.set(name, info);
      cursor = typeof raw.nextCursor === 'string' ? raw.nextCursor : undefined;
    } while (cursor);
    session.mcpTools.set(server, tools);
    const found = tools.get(tool);
    return found && (found.visibility ? { visibility: found.visibility } : {});
  }
  private liveSession(handle: SessionHandle): CodexSession {
    const session = this.sessions.get(handle);
    if (!session) throw new Error('Codex session is not live');
    return session;
  }
  async preflight(): Promise<Preflight> {
    let version: string;
    try {
      version = await readVersion(this.binary);
    } catch (error) {
      if (this.report.version !== 'unprobed')
        this.report = report('codex', 'unprobed', false, OWN_CAPABILITIES);
      return notInstalled(MIN_VERSIONS.codex, error);
    }
    if (this.report.version !== version)
      this.report = report('codex', version, false, OWN_CAPABILITIES);
    const installed = installedFields(version, MIN_VERSIONS.codex);
    const rpc = new JsonRpcProcess(this.binary, [...this.args, 'app-server'], os.tmpdir());
    let loggedOut = false;
    try {
      await rpc.initialize();
      const auth = await checkBillingChannel(rpc, { cwd: os.tmpdir() }, () => {
        loggedOut = true;
      });
      return {
        ...installed,
        auth: {
          state: 'ok',
          ...(auth?.email !== undefined ? { email: auth.email } : {}),
          ...(auth?.plan !== undefined ? { plan: auth.plan } : {}),
        },
      };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'billing_channel_mismatch')
        return {
          ...installed,
          auth: {
            state: loggedOut ? 'logged_out' : 'unsupported_channel',
            reason: error.message,
          },
        };
      return {
        ...installed,
        auth: { state: 'unknown' },
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await rpc.close();
    }
  }
  async inventory(cwd: string): Promise<ExtensionInventory> {
    const rpc = new JsonRpcProcess(this.binary, [...this.args, 'app-server'], cwd);
    try {
      // app/list is an experimental method.
      await rpc.initialize({
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true },
      });
      const extensions = await readExtensions(rpc, cwd);
      const hooks = await rpc.request<{
        data: { hooks: { eventName: string; pluginId?: string | null }[] }[];
      }>('hooks/list', { cwds: [cwd] });
      const connectors: ExtensionInventory['connectors'] = [];
      try {
        let cursor: string | null | undefined;
        do {
          const page: {
            data: { id: string; name?: string; isAccessible?: boolean; isEnabled?: boolean }[];
            nextCursor?: string | null;
          } = await rpc.request('app/list', cursor ? { cursor } : {});
          for (const app of page.data)
            if (app.isAccessible !== false)
              connectors.push({
                name: app.id,
                enabled: app.isEnabled !== false,
                ...(app.name ? { title: app.name } : {}),
              });
          cursor = page.nextCursor;
        } while (cursor);
      } catch {
        // The rest of the inventory stands without the account apps.
        connectors.length = 0;
      }
      return {
        runtime: this.name,
        mcp_servers: extensions.mcp_servers.map(({ name, enabled, user }) => ({
          name,
          enabled,
          ...(user ? { user } : {}),
        })),
        plugins: extensions.plugins,
        skills: extensions.skills,
        apps: extensions.apps,
        connectors,
        ...(extensions.hooks_enabled === undefined
          ? {}
          : { hooks_enabled: extensions.hooks_enabled }),
        hooks: hooks.data.flatMap((entry) =>
          entry.hooks.map((hook) => ({
            event: hook.eventName,
            ...(hook.pluginId ? { plugin: hook.pluginId } : {}),
          })),
        ),
      };
    } finally {
      await rpc.close();
    }
  }
  async models(cwd: string): Promise<RuntimeModel[]> {
    const rpc = new JsonRpcProcess(this.binary, [...this.args, 'app-server'], cwd);
    try {
      await rpc.initialize();
      return (await listModels(rpc))
        .filter((model) => !model.hidden)
        .map<RuntimeModel>((model) => ({
          id: model.model,
          label: model.displayName,
          ...(model.description ? { description: model.description } : {}),
          permission_modes: ['plan', 'auto_edit', 'full_access'],
          ...(model.serviceTiers.some((tier) => tier.id === 'fast' || tier.id === 'priority')
            ? { fast: true as const }
            : {}),
          efforts: model.supportedReasoningEfforts
            .map((option) => option.reasoningEffort)
            .filter(isEffortLevel),
          default_effort: isEffortLevel(model.defaultReasoningEffort)
            ? model.defaultReasoningEffort
            : null,
          default: model.isDefault,
        }));
    } finally {
      await rpc.close();
    }
  }
  async start(spec: SessionSpec, emit: AgentEventSink): Promise<SessionHandle> {
    return this.open(spec, undefined, emit);
  }
  async resume(
    spec: SessionSpec,
    native_session_id: string,
    emit: AgentEventSink,
  ): Promise<SessionHandle> {
    return this.open(spec, native_session_id, emit);
  }
  private async open(
    spec: SessionSpec,
    native_session_id: string | undefined,
    emit: AgentEventSink,
  ): Promise<SessionHandle> {
    validateSessionSpec(spec, this.report.version);
    // Native state lives on this machine, so a session on another device runs without it.
    const state = spec.remote ? { args: [], env: {} } : prepareNativeState('codex', spec);
    const planning = spec.role === 'planner' || spec.role === 'reviewer';
    const rpc = new JsonRpcProcess(
      spec.remote?.binary ?? this.binary,
      [
        // The user's arguments come first so Pantheon's own settings follow them.
        ...this.args,
        ...state.args,
        // Codex reads the plugins feature once per app-server process, not per thread.
        ...(planning ? ['-c', 'features.plugins=false'] : []),
        ...(spec.backend ? backendConfig(spec.backend) : []),
        'app-server',
      ],
      spec.cwd,
      spec.env_allowlist,
      // Project variables sit under the allowlisted and native state variables, except TMPDIR.
      spec.remote
        ? spec.env
        : {
            ...spec.env,
            ...nativeEnvironment(spec.env_allowlist),
            ...(spec.env?.TMPDIR ? { TMPDIR: spec.env.TMPDIR } : {}),
            ...state.env,
            ...(spec.backend ? { PANTHEON_BACKEND_KEY: spec.backend.api_key } : {}),
          },
      { remote: spec.remote, maxLine: CODEX_MAX_LINE },
    );
    const handle: SessionHandle = {
      platform_session_id: spec.platform_session_id,
      native_session_id: native_session_id ?? '',
      adapter_version: this.report.version,
      device_id: spec.device_id,
      requested_model: spec.model,
      requested_effort: spec.effort,
      native_state_dir: spec.remote ? undefined : spec.native_state_dir,
      native_title:
        spec.native_title || (native_session_id === undefined && !spec.auto_title)
          ? nativeSessionTitle(spec)
          : undefined,
      process_identity: rpc.child.pid ? processIdentity(rpc.child.pid) : undefined,
    };
    let ready = false;
    const pending: Notification[] = [];
    let rateLimits: RateLimitSnapshot | undefined;
    const session: CodexSession = {
      spec,
      emit,
      rpc,
      turns: new Map(),
      sequence: 0,
      state: 'idle',
      commands: new Map(),
      mcpTools: new Map(),
      appCalls: new Map(),
      subagents: new Map(),
      ...(spec.auto_title && native_session_id === undefined ? { autoTitle: {} } : {}),
      notification: (frame) => {
        if (!ready) {
          pending.push(frame);
          return;
        }
        const p = frame.params ?? {},
          current = session.turn;
        if (session.titleThread && p.threadId === session.titleThread.id) {
          session.titleThread.frame(frame);
          return;
        }
        // The hidden title thread announces itself before its id is known.
        if (
          frame.method === 'thread/started' &&
          (p.thread as { threadSource?: unknown } | undefined)?.threadSource === THREAD_TITLE_SOURCE
        )
          return;
        if (p.threadId && p.threadId !== handle.native_session_id) {
          // Only a known subagent's tool calls show, under the spawn that dispatched it.
          const subagent = session.subagents.get(String(p.threadId));
          const type = (p.item as { type?: unknown } | undefined)?.type;
          const tool =
            subagent && ['commandExecution', 'fileChange', 'mcpToolCall'].includes(String(type))
              ? toolEvent(frame, session.mcpTools)
              : undefined;
          if (!subagent || !tool) return;
          rememberPatch(current, frame);
          const edge = { native_type: frame.method, ...(current ? { turn_id: current.id } : {}) };
          emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            ...edge,
            ...tool,
            parent_tool_use_id: subagent.call,
          });
          if (tool.kind === 'tool.started')
            emit({
              key: String(++session.sequence),
              provider_sequence: session.sequence,
              ...edge,
              kind: 'task.progress',
              task_id: String(p.threadId),
              last_tool: tool.name,
            });
          return;
        }
        // A command's end arrives with the turn that started it, which may have ended long before.
        const command = p.item as
          { type?: unknown; id?: unknown; processId?: unknown; command?: unknown } | undefined;
        if (command?.type === 'commandExecution' && typeof command.id === 'string') {
          const known = session.commands.get(command.id);
          if (frame.method === 'item/started' && !known && command.processId != null)
            session.commands.set(command.id, {
              id: String(command.processId),
              kind: 'shell',
              description: String(command.command ?? ''),
              started_at: Date.now(),
            });
          if (frame.method === 'item/completed' && known) {
            session.commands.delete(command.id);
            if (known.background) emitBackground(session);
          }
        }
        if (current?.compact && !current.native_id && frame.method === 'turn/started') {
          const turn = p.turn as { id?: string } | undefined;
          if (typeof turn?.id !== 'string') {
            fail(new Error('Invalid Codex compaction turn start'));
            return;
          }
          bindNativeTurn(session, handle.native_session_id, current, turn.id);
        }
        if (current && !current.native_id) {
          current.pending.push(frame);
          return;
        }
        const nativeTurnId = p.turnId ?? (p.turn as { id?: string } | undefined)?.id,
          turn_id =
            typeof nativeTurnId === 'string' ? session.turns.get(nativeTurnId) : current?.id;
        if (turn_id && turn_id !== current?.id) return;
        if (!current && /^(turn|item)\//.test(frame.method)) return;
        if (frame.method === 'rawResponseItem/completed') {
          if (!current || p.turnId !== current.native_id) return;
          const tool = rawToolEvent(frame, current.rawTools);
          if (tool) {
            current.rawTools.push(tool);
            return;
          }
        }
        if (
          frame.method === 'thread/tokenUsage/updated' &&
          current &&
          p.turnId === current.native_id
        ) {
          // `last` covers one model request and `total` the whole thread, so a turn is total minus the total before it.
          const { last, total, modelContextWindow } = (p.tokenUsage ?? {}) as {
            last?: CodexTokens;
            total?: CodexTokens;
            modelContextWindow?: number | null;
          };
          if (last && total) {
            current.usageBase ??= minusTokens(total, last);
            current.usage = minusTokens(total, current.usageBase);
          }
          if (last) current.contextTokens = last.totalTokens;
          current.contextWindow = modelContextWindow ?? undefined;
        }
        const compaction =
          frame.method === 'thread/compacted'
            ? 'notices'
            : frame.method === 'item/completed' &&
                (p.item as { type?: unknown } | undefined)?.type === 'contextCompaction'
              ? 'items'
              : undefined;
        let compacted = compaction !== undefined;
        if (compaction && current) {
          // Codex announces one compaction both ways; the second announcement adds no event.
          const seen = (current.compactions ??= { notices: 0, items: 0 });
          seen[compaction] += 1;
          compacted = seen[compaction] > seen[compaction === 'items' ? 'notices' : 'items'];
        }
        if (frame.method === 'account/rateLimits/updated') {
          rateLimits = p.rateLimits as RateLimitSnapshot | undefined;
          const windows = [rateLimits?.primary, rateLimits?.secondary].flatMap((window, index) =>
            window && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
              ? [
                  {
                    window:
                      window.windowDurationMins === 300
                        ? 'five_hour'
                        : window.windowDurationMins === 10080
                          ? 'seven_day'
                          : window.windowDurationMins != null
                            ? `${window.windowDurationMins}_minutes`
                            : index === 0
                              ? 'primary'
                              : 'secondary',
                    used_percent: window.usedPercent,
                    ...(typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)
                      ? { resets_at: window.resetsAt * 1000 }
                      : {}),
                  },
                ]
              : [],
          );
          if (windows.length)
            emit({
              key: String(++session.sequence),
              provider_sequence: session.sequence,
              kind: 'quota.updated',
              windows,
              native_type: frame.method,
            });
        }
        if (frame.method === 'error' && current && p.turnId === current.native_id)
          current.errorInfo = (p.error as { codexErrorInfo?: unknown } | undefined)?.codexErrorInfo;
        const reasoning = reasoningSummary(frame);
        if (frame.method === 'turn/completed') {
          const turn = p.turn as { id?: string; status?: string; error?: unknown } | undefined;
          if (typeof turn?.id !== 'string' || typeof turn.status !== 'string') {
            fail(new Error('Invalid Codex turn completion'));
            return;
          }
          if (!current || turn.id !== current.native_id) return;
          const usageLimit =
            turn.status === 'failed' &&
            ((turn.error as { codexErrorInfo?: unknown } | null | undefined)?.codexErrorInfo ??
              current.errorInfo) === 'usageLimitExceeded';
          current.finish(
            turn.status === 'completed' || turn.status === 'interrupted' ? turn.status : 'failed',
            turn.status === 'completed' || turn.status === 'interrupted'
              ? undefined
              : `Codex turn ${turn.status}: ${JSON.stringify(turn.error ?? 'unknown error')}`,
            frame,
            usageLimit ? 'usage_limit' : undefined,
            usageLimit ? usedUpReset(rateLimits) : undefined,
          );
        } else if (frame.method === 'item/agentMessage/delta') {
          emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id,
            kind: 'message.delta',
            text: String(p.delta ?? ''),
            native_type: frame.method,
          });
        } else if (reasoning) {
          emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id,
            kind: 'reasoning',
            text: reasoning,
            summary: true,
            native_type: frame.method,
          });
        } else if (
          current &&
          frame.method === 'item/started' &&
          (p.item as { type?: unknown } | undefined)?.type === 'contextCompaction'
        ) {
          emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id,
            kind: 'context.compacting',
            trigger: current.compact ? 'manual' : 'auto',
            native_type: frame.method,
          });
        } else if (compacted) {
          emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id,
            kind: 'context.compacted',
            ...(current?.compact ? { trigger: 'manual' as const } : {}),
            native_type: frame.method,
          });
        } else {
          const tool = toolEvent(frame, session.mcpTools);
          if (tool) current?.v2ToolIds.add(tool.tool_call_id);
          if (tool?.kind === 'tool.started' && tool.app)
            session.appCalls.set(
              JSON.stringify([tool.app.server, tool.app.resource_uri]),
              tool.tool_call_id,
            );
          if (tool?.kind === 'tool.started' && tool.name === 'commandExecution')
            current?.commands.add(tool.tool_call_id);
          rememberPatch(current, frame);
          emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id,
            ...(tool ?? { kind: 'native' }),
            native_type: frame.method,
            ...(tool || TYPE_ONLY_FRAMES.has(frame.method) ? {} : { native: frame }),
          });
          emitSubagentEdges(session, frame, turn_id);
        }
      },
    };
    const fail = (error: Error): void => {
      if (!session.error && !session.stopping)
        emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          kind: 'runtime.disconnected',
          reason: `Codex runtime connection lost: ${error.message}`,
        });
      session.error = error;
      session.state = 'unknown';
      session.turn?.finish(
        session.stopping ? 'interrupted' : 'failed',
        session.stopping
          ? undefined
          : `Codex runtime connection lost: ${error.message || String(error)}`,
      );
      void rpc.close().then((receipt) => {
        session.state = receipt.stopped ? 'exited' : 'unknown';
      });
    };
    rpc.on('closed', () => {
      delete handle.process_identity;
      if (session.stopping) session.turn?.finish('interrupted');
      else if (session.state !== 'exited')
        fail(new Error('Codex transport closed before turn completion'));
      // Background terminals end with the app-server.
      if (session.commands.size) {
        session.commands.clear();
        emitBackground(session);
      }
    });
    rpc.on('protocolError', fail);
    rpc.on('notification', session.notification);
    const requestPermission = async (frame: Notification, reply: ServerReply): Promise<void> => {
      const p = frame.params ?? {};
      const mcp = frame.method === 'mcpServer/elicitation/request';
      let questions: UserInputQuestion[] | undefined;
      const respond = (decision: 'accept' | 'decline', answers: Record<string, string> = {}) =>
        reply({
          result: mcp
            ? { action: decision }
            : questions
              ? {
                  // The model reads an empty map as no answer from the user.
                  answers:
                    decision === 'accept'
                      ? Object.fromEntries(
                          questions.flatMap((q) =>
                            answers[q.question] === undefined
                              ? []
                              : [[q.id, { answers: [answers[q.question]] }]],
                          ),
                        )
                      : {},
                }
              : { decision },
        });
      let tool: string;
      // Only a named MCP tool is narrow enough for a session-wide rule.
      let rule: string | undefined;
      let denied = false;
      switch (frame.method) {
        case 'item/commandExecution/requestApproval':
          tool = 'commandExecution';
          // A require_escalated command carries no marker here, and approving it widens the profile.
          // A user-opened session asks the user, as bare Codex does, unless it may not write.
          denied =
            !session.spec.user_session ||
            session.turn?.readOnly === true ||
            session.spec.permission_mode === 'plan';
          break;
        case 'item/fileChange/requestApproval':
          tool = 'fileChange';
          // Approving a patch would write past the read-only profile.
          denied =
            (p.grantRoot != null && !session.spec.user_session) ||
            session.turn?.readOnly === true ||
            session.spec.permission_mode === 'plan';
          break;
        case 'item/permissions/requestApproval':
          reply({ result: { permissions: {} } });
          return;
        case 'mcpServer/elicitation/request': {
          const meta = p._meta as Record<string, unknown> | undefined;
          denied = meta?.codex_approval_kind !== 'mcp_tool_call';
          tool =
            typeof meta?.tool_name === 'string'
              ? `${p.serverName}.${meta.tool_name}`
              : String(p.serverName ?? 'mcpToolCall');
          // Server and tool names may both contain dots, so the rule keeps them apart.
          if (typeof meta?.tool_name === 'string')
            rule = `mcp:${JSON.stringify([String(p.serverName), meta.tool_name])}`;
          break;
        }
        case 'item/tool/requestUserInput':
          tool = 'AskUserQuestion';
          questions = Array.isArray(p.questions) ? (p.questions as UserInputQuestion[]) : [];
          break;
        default:
          reply({ error: { code: -32601, message: 'Unknown Codex server request' } });
          return;
      }
      const current = session.turn;
      // A subagent's request carries its own thread's turn.
      const subagent =
        p.threadId !== handle.native_session_id && session.subagents.has(String(p.threadId));
      if (
        denied ||
        !ready ||
        !current ||
        session.stopping ||
        session.state !== 'running' ||
        (p.threadId !== handle.native_session_id && !subagent)
      ) {
        respond('decline');
        return;
      }
      if (!current.native_id) {
        current.pendingRequests.push(() => handleRequest(frame, reply));
        return;
      }
      // MCP elicitations may omit turn correlation; built-in approvals must match exactly.
      if (!subagent && p.turnId !== current.native_id && !(mcp && p.turnId == null)) {
        respond('decline');
        return;
      }
      let input = p;
      if (tool === 'fileChange') {
        const changes = typeof p.itemId === 'string' ? current.patches.get(p.itemId) : undefined;
        // The root a user-opened session's patch asks to keep writing is checked as a target.
        const checked =
          changes && p.grantRoot != null ? [...changes, { path: p.grantRoot }] : changes;
        if (
          !checked ||
          (session.spec.remote
            ? await devicePatchDenied(session.spec, checked)
            : patchDenied(session.spec, checked)) ||
          session.turn !== current ||
          session.stopping ||
          current.readOnly
        ) {
          respond('decline');
          return;
        }
        // First, so the approval summary leads with the target paths.
        input = { changes, ...p };
      }
      // Saved rules stay dormant in plan mode, as in the Claude adapter, and in read-only turns.
      if (
        rule &&
        session.spec.permission_mode !== 'plan' &&
        !current.readOnly &&
        session.spec.allowed_rules?.includes(rule)
      ) {
        respond('accept');
        return;
      }
      const request_id = id();
      current.permissions.set(request_id, (decision, cancelled, answers) => {
        if (!current.permissions.delete(request_id)) return;
        if (!current.permissions.size) current.pauseClock(false);
        // A turn made read-only while the approval waited refuses the patch it would write.
        const refused = decision === 'deny' || (tool === 'fileChange' && current.readOnly);
        emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          turn_id: current.id,
          kind: 'permission.resolved',
          request_id,
          decision: refused ? 'deny' : decision,
          ...(cancelled ? { cancelled: true } : {}),
        });
        // Without a rule, allow_session answers this request only.
        if (!refused && decision === 'allow_session' && rule)
          session.spec = {
            ...session.spec,
            allowed_rules: [...(session.spec.allowed_rules ?? []), rule],
          };
        respond(refused ? 'decline' : 'accept', answers);
      });
      if (current.permissions.size === 1) current.pauseClock(true);
      emit({
        key: String(++session.sequence),
        provider_sequence: session.sequence,
        turn_id: current.id,
        kind: 'permission.requested',
        request_id,
        tool,
        ...(rule ? { rule } : {}),
        project_rule_supported: rule !== undefined && !current.readOnly,
        detail: {
          input: tracePayload(input),
          ...(typeof p.itemId === 'string' ? { tool_call_id: p.itemId } : {}),
          ...(questions
            ? {
                questions: questions.map((q): ApprovalQuestion => ({
                  question: String(q.question),
                  header: String(q.header ?? ''),
                  options: (q.options ?? []).map((option) => ({
                    label: String(option.label),
                    description: String(option.description ?? ''),
                  })),
                  multiSelect: false,
                  id: String(q.id),
                  other: q.isOther,
                  secret: q.isSecret,
                })),
              }
            : {}),
        },
      });
    };
    // The handler awaits device lookups; a failure inside it declines instead of going unhandled.
    const handleRequest = (frame: Notification, reply: ServerReply): void =>
      void requestPermission(frame, reply).catch((error: unknown) => {
        reply({
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      });
    if (spec.sandbox) rpc.on('request', handleRequest);
    try {
      if (spec.sandbox) {
        await rpc.request('initialize', {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: true },
        });
        rpc.notify('initialized');
      } else await rpc.initialize();
      const auth = await checkBillingChannel(rpc, spec);
      if (auth) {
        // The email stays out of session events.
        const { email: _email, ...summary } = auth;
        emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          kind: 'auth.checked',
          ...summary,
        });
      }
      const mode = spec.extensions?.mode;
      const extensions =
        mode || spec.sandbox || spec.pantheon_mcp || spec.mcp_servers.length
          ? await readExtensions(
              rpc,
              spec.cwd,
              !!spec.sandbox && mode !== 'none' && !spec.user_session,
            )
          : undefined;
      const inherited = spec.extensions?.mode === 'inherit' ? spec.extensions.overrides : undefined;
      const overrides =
        inherited && extensions ? closeUserExtensions(inherited, extensions) : inherited;
      const notApplied: { item: string; reason: string }[] = [];
      const known = (requested: string[], listed: string[], reason: string) =>
        [...new Set(requested)].filter((item) => {
          if (listed.includes(item)) return true;
          notApplied.push({ item, reason });
          return false;
        });
      const disabled = extensions
        ? {
            mcp_servers:
              mode === 'none'
                ? extensions.mcp_servers.map((server) => server.name)
                : known(
                    overrides?.disabled_mcp_servers ?? [],
                    extensions.mcp_servers.map((server) => server.name),
                    'MCP server is not user-defined; disable its plugin instead if applicable',
                  ),
            plugins:
              mode === 'none'
                ? extensions.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id)
                : known(
                    overrides?.disabled_plugins ?? [],
                    extensions.plugins.map((plugin) => plugin.id),
                    'Unknown plugin id',
                  ),
            skills:
              mode === 'none'
                ? extensions.skills.filter((skill) => skill.enabled).map((skill) => skill.id)
                : [
                    ...new Set(
                      known(
                        overrides?.disabled_skills ?? [],
                        extensions.skills.flatMap((skill) => [skill.id, skill.name]),
                        'Unknown skill id',
                      ).flatMap((item) =>
                        extensions.skills.some((skill) => skill.id === item)
                          ? [item]
                          : extensions.skills
                              .filter((skill) => skill.name === item)
                              .map((skill) => skill.id),
                      ),
                    ),
                  ],
            apps:
              mode === 'none' ||
              overrides?.disable_apps === true ||
              overrides?.enabled_user_connectors?.length === 0,
            hooks: mode === 'none' || overrides?.disable_hooks === true,
          }
        : undefined;
      if (spec.sandbox && extensions && disabled)
        disabled.plugins = [...new Set([...disabled.plugins, ...extensions.unreadable_plugins])];
      if (spec.sandbox && extensions && disabled)
        disabled.mcp_servers = [
          ...new Set([
            ...disabled.mcp_servers,
            ...extensions.mcp_servers
              .filter((server) => server.tools_error)
              .map((server) => server.name),
          ]),
        ];
      if (spec.pantheon_mcp && disabled)
        disabled.mcp_servers = disabled.mcp_servers.filter((name) => name !== 'pantheon');
      if (disabled)
        disabled.mcp_servers = disabled.mcp_servers.filter(
          (name) => !spec.mcp_servers.some((server) => server.name === name),
        );
      // skills.config replaces an array. Keep existing disables so an override cannot
      // turn a skill back on that the user disabled in the harness.
      const disabledSkills = [
        ...new Set([
          ...(disabled?.skills ?? []),
          ...(extensions?.disabled_skills ?? []),
          ...(extensions?.skills.filter((skill) => !skill.enabled).map((skill) => skill.id) ?? []),
        ]),
      ];
      // Apps are on by default, so only the opened ones are turned back on.
      const openedApps = disabled?.apps ? undefined : overrides?.enabled_user_connectors;
      const config: Record<string, unknown> = disabled
        ? {
            ...(openedApps
              ? {
                  apps: {
                    _default: { enabled: false },
                    ...Object.fromEntries(openedApps.map((id) => [id, { enabled: true }])),
                  },
                }
              : {}),
            ...(disabled.mcp_servers.length
              ? {
                  mcp_servers: Object.fromEntries(
                    disabled.mcp_servers
                      .filter(
                        (name) =>
                          !extensions!.mcp_servers.some(
                            (server) => server.name === name && server.plugin,
                          ),
                      )
                      .map((name) => [name, { enabled: false }]),
                  ),
                }
              : {}),
            ...(disabled.plugins.length
              ? {
                  plugins: Object.fromEntries(
                    disabled.plugins.map((id) => [id, { enabled: false }]),
                  ),
                }
              : {}),
            ...(disabled.skills.length
              ? { skills: { config: disabledSkills.map((path) => ({ path, enabled: false })) } }
              : {}),
            ...(disabled.apps || disabled.hooks
              ? {
                  features: {
                    ...(disabled.apps ? { apps: false } : {}),
                    ...(disabled.hooks ? { hooks: false } : {}),
                  },
                }
              : {}),
          }
        : {};
      // Use a fresh name so merging config cannot retain a user's broader profile entries.
      // A user-opened session runs on the sandbox and approvals of the user's own Codex config.
      const permissions = spec.sandbox && !spec.user_session ? `pantheon_${id()}` : undefined;
      const promptTools = (names: string[]) =>
        Object.fromEntries(names.map((name) => [name, { approval_mode: 'prompt' }]));
      if (spec.sandbox) {
        if (spec.user_session && spec.permission_mode === 'plan')
          config.default_permissions = ':read-only';
        else if (permissions && spec.permission_mode !== 'full_access') {
          config[`permissions.${permissions}`] = {
            filesystem:
              spec.permission_mode === 'plan' || spec.runtime_analysis
                ? readOnlyFilesystem(spec.sandbox, spec.remote !== undefined)
                : writerFilesystem(spec.sandbox, spec.remote !== undefined),
          };
          config[`permissions.${permissions}_read`] = {
            filesystem: readOnlyFilesystem(spec.sandbox, spec.remote !== undefined),
          };
          session.profiles = { writer: permissions, readOnly: `${permissions}_read` };
          // Codex 0.164 fails every turn's account check when the profile comes from the `permissions` field.
          config.default_permissions = permissions;
        }
        const serverPolicy = (server: NonNullable<typeof extensions>['mcp_servers'][number]) =>
          disabled!.mcp_servers.includes(server.name)
            ? { enabled: false }
            : {
                default_tools_approval_mode: 'prompt',
                ...(server.tool_names.length ? { tools: promptTools(server.tool_names) } : {}),
                ...(server.enabled_tools ? { enabled_tools: server.enabled_tools } : {}),
              };
        const servers = extensions!.mcp_servers.filter(
          (server) =>
            (server.enabled && !spec.user_session) || disabled!.mcp_servers.includes(server.name),
        );
        const mcpServers = Object.fromEntries(
          servers
            .filter((server) => !server.plugin)
            .map((server) => [server.name, serverPolicy(server)]),
        );
        if (Object.keys(mcpServers).length) config.mcp_servers = mcpServers;
        const plugins = new Map<
          string,
          { enabled?: boolean; mcp_servers?: Record<string, unknown> }
        >(disabled!.plugins.map((id) => [id, { enabled: false }]));
        for (const server of servers) {
          if (!server.plugin || disabled!.plugins.includes(server.plugin)) continue;
          const plugin = plugins.get(server.plugin) ?? {};
          plugin.mcp_servers = { ...plugin.mcp_servers, [server.name]: serverPolicy(server) };
          plugins.set(server.plugin, plugin);
        }
        if (plugins.size) config.plugins = Object.fromEntries(plugins);
        const appPolicy = spec.user_session
          ? {}
          : { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' };
        // An entry here replaces the user's, whose enabled key defaults to true, so each one names it.
        const policies = extensions!.app_policies;
        if (!disabled!.apps && (!spec.user_session || openedApps))
          config.apps = {
            _default: {
              ...appPolicy,
              enabled:
                !openedApps && policies.find((app) => app.name === '_default')?.enabled !== false,
            },
            ...Object.fromEntries(
              policies
                .filter((app) => app.name !== '_default')
                .map((app) => [
                  app.name,
                  {
                    ...appPolicy,
                    enabled: openedApps ? openedApps.includes(app.name) : app.enabled,
                    ...(app.tools.length && !spec.user_session
                      ? { tools: promptTools(app.tools) }
                      : {}),
                    ...(app.links.length && !spec.user_session
                      ? { links: Object.fromEntries(app.links.map((name) => [name, appPolicy])) }
                      : {}),
                  },
                ]),
            ),
            ...Object.fromEntries(
              (openedApps ?? [])
                .filter((id) => !policies.some((app) => app.name === id))
                .map((id) => [id, { ...appPolicy, enabled: true }]),
            ),
          };
      }
      if (spec.pantheon_mcp) {
        const { ask_tools, ...server } = spec.pantheon_mcp;
        config.mcp_servers = {
          ...(config.mcp_servers as Record<string, unknown> | undefined),
          pantheon: {
            ...server,
            enabled: true,
            default_tools_approval_mode: 'approve',
            ...(ask_tools?.length ? { tools: promptTools(ask_tools) } : {}),
          },
        };
      }
      if (spec.mcp_servers.length)
        config.mcp_servers = {
          ...(config.mcp_servers as Record<string, unknown> | undefined),
          ...Object.fromEntries(
            spec.mcp_servers.map(({ name, ...server }) => [name, { ...server, enabled: true }]),
          ),
        };
      if (planning) {
        config.web_search = 'disabled';
        config.features = {
          ...(config.features as Record<string, unknown> | undefined),
          image_generation: false,
          goals: false,
          multi_agent: false,
          collaboration_modes: false,
        };
        config.include_environment_context = false;
        if (spec.native_state_dir) {
          const persona = path.join(spec.native_state_dir, 'pantheon-planner.md');
          writeFileSync(persona, PLANNER_PERSONA, { mode: 0o600 });
          config.model_instructions_file = persona;
        }
      }
      // Codex otherwise allows request_user_input only in Plan collaboration mode.
      if (spec.sandbox && spec.role === 'writer' && !spec.user_session)
        config.features = {
          ...(config.features as Record<string, unknown> | undefined),
          default_mode_request_user_input: true,
        };
      const withControlInstructions = (instructions: string) =>
        [
          instructions,
          ...((spec.role === 'writer' || spec.runtime_analysis) && spec.control_instructions
            ? [spec.control_instructions]
            : []),
          ...(spec.permission_mode === 'plan' ? [CODEX_PLAN_MODE_INSTRUCTION] : []),
        ]
          .filter(Boolean)
          .join('\n\n');
      if (spec.fast) session.serviceTier = await fastTier(rpc, spec.model);
      const params = {
        cwd: spec.cwd,
        serviceTier: session.serviceTier ?? 'default',
        ...(spec.permission_mode === 'full_access' ? { sandbox: 'danger-full-access' } : {}),
        model: spec.model,
        // Keep resumed threads on the provider that passed the billing check.
        modelProvider: modelProvider(spec),
        ...(spec.sandbox
          ? {
              ...(spec.user_session
                ? // Plan mode declines escalations in this adapter; the user's auto reviewer would approve them.
                  spec.permission_mode === 'plan'
                  ? { approvalsReviewer: 'user' }
                  : {}
                : {
                    approvalPolicy: spec.role === 'planner' ? 'never' : 'on-request',
                    // The user's auto_review setting would let a Codex agent approve escalations and MCP calls.
                    approvalsReviewer: 'user',
                  }),
              developerInstructions: withControlInstructions(
                spec.role === 'planner'
                  ? plannerInstructions(spec)
                  : spec.permission_mode === 'full_access' || spec.user_session
                    ? ''
                    : 'Use tools inside the Pantheon permission profile. Do not request permissions outside the sandbox.',
              ),
            }
          : {
              approvalPolicy: 'never',
              sandbox: 'read-only',
              developerInstructions: withControlInstructions(
                spec.pantheon_mcp
                  ? plannerInstructions(spec)
                  : 'This is a bounded Pantheon text protocol probe. Do not use tools or access files. Respond to the user text only.',
              ),
            }),
        ...(Object.keys(config).length ? { config } : {}),
      };
      type ThreadResponse = {
        thread: { id: string };
        model?: string;
        activePermissionProfile?: { id: string } | null;
        approvalsReviewer?: string;
        sandbox?: { type?: string };
      };
      const result = spec.native_fork
        ? await rpc.request<ThreadResponse>('thread/fork', {
            ...params,
            threadId: spec.native_fork.session_id,
            lastTurnId: spec.native_fork.after,
          })
        : native_session_id !== undefined
          ? await rpc.request<ThreadResponse>('thread/resume', {
              ...params,
              threadId: native_session_id,
            })
          : await rpc.request<ThreadResponse>('thread/start', {
              ...params,
              ...(spec.sandbox ? { experimentalRawEvents: true } : {}),
            });
      if (!result?.thread?.id) throw new Error('Codex did not return a thread id');
      if (handle.native_title)
        await rpc.request('thread/name/set', {
          threadId: result.thread.id,
          name: handle.native_title,
        });
      if (session.profiles && result.activePermissionProfile?.id !== permissions)
        throw new Error('Codex did not activate the requested permission profile');
      if (permissions && result.approvalsReviewer !== 'user')
        throw new Error('Codex did not route approvals to Pantheon');
      if (
        spec.user_session &&
        spec.permission_mode === 'plan' &&
        (result.sandbox?.type !== 'readOnly' || result.approvalsReviewer !== 'user')
      )
        throw new Error('Codex did not start the plan mode session read-only');
      if (spec.user_session) session.userReviewer = result.approvalsReviewer;
      if (spec.user_session)
        session.userSandbox = result.activePermissionProfile?.id
          ? { permissions: result.activePermissionProfile.id }
          : result.sandbox
            ? { sandboxPolicy: result.sandbox }
            : undefined;
      if (session.error) throw session.error;
      handle.native_session_id = result.thread.id;
      // Thread start/resume returns the server's resolved model. Never manufacture
      // a report from the request when an older server omits this field.
      handle.reported_model =
        typeof result.model === 'string' && result.model.trim() ? result.model : undefined;
      this.sessions.set(handle, session);
      // No requested_model: this runs before start returns, so the spec's model would
      // overwrite one the user picked during startup.
      emit({
        key: String(++session.sequence),
        provider_sequence: session.sequence,
        kind: 'session.started',
        native_session_id: handle.native_session_id,
        reported_model: handle.reported_model,
        ...(spec.sandbox
          ? {
              raw_tool_events:
                native_session_id === undefined
                  ? ('enabled' as const)
                  : ('unavailable_on_resume' as const),
            }
          : {}),
      });
      if (extensions && disabled)
        emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          kind: 'extensions.applied',
          mode: mode ?? 'inherit',
          disabled,
          loaded: {
            mcp_servers: [
              ...new Set([
                ...(spec.pantheon_mcp ? ['pantheon'] : []),
                ...spec.mcp_servers.map((server) => server.name),
                ...extensions.mcp_servers
                  .filter(
                    (server) =>
                      server.enabled &&
                      !disabled.mcp_servers.includes(server.name) &&
                      (!server.plugin || !disabled.plugins.includes(server.plugin)),
                  )
                  .map((server) => server.name),
              ]),
            ],
            plugins: extensions.plugins
              .filter((plugin) => plugin.enabled && !disabled.plugins.includes(plugin.id))
              .map((plugin) => plugin.id),
            skills: extensions.skills
              .filter(
                (skill) =>
                  skill.enabled &&
                  !disabled.skills.includes(skill.id) &&
                  (!skill.plugin ||
                    extensions.plugins.some(
                      (plugin) =>
                        plugin.id === skill.plugin &&
                        plugin.enabled &&
                        !disabled.plugins.includes(plugin.id),
                    )),
              )
              .map((skill) => skill.id),
            apps: extensions.apps && !disabled.apps,
            hooks: extensions.hooks && !disabled.hooks,
          },
          ...(notApplied.length ? { not_applied: notApplied } : {}),
        });
      ready = true;
      for (const frame of pending.splice(0)) session.notification(frame);
      return handle;
    } catch (error) {
      session.stopping = true;
      const stop = await rpc.close();
      session.state = stop.stopped ? 'exited' : 'unknown';
      if (!rpc.child.pid) throw error;
      const failure = new SessionStartError(
        error instanceof Error ? error.message : String(error),
        stop,
      );
      if (error && typeof error === 'object' && 'code' in error)
        Object.assign(failure, { code: error.code });
      throw failure;
    }
  }
  async send(handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> {
    const session = this.sessions.get(handle);
    if (!session || session.state !== 'idle')
      return { turn_id: turn.turn_id, status: 'unsupported', reason: 'Session is not idle' };
    session.state = 'running';
    if (session.autoTitle && !turn.compact) session.autoTitle.input ??= turn.input;
    let timer: NodeJS.Timeout | undefined,
      left = session.spec.budget.wall_time_ms,
      since = Date.now();
    const expire = () => {
      if (session.stopping) return;
      session.state = 'unknown';
      current.finish('failed', 'Codex turn deadline exceeded', undefined, 'turn_deadline');
      session.stopping = true;
      void session.rpc.close().then((receipt) => {
        session.state = receipt.stopped ? 'exited' : 'unknown';
      });
    };
    const current: NonNullable<CodexSession['turn']> = {
      id: turn.turn_id,
      ...(turn.compact ? { compact: true as const } : {}),
      readOnly: turn.read_only === true,
      pending: [],
      pendingRequests: [],
      rawTools: [],
      v2ToolIds: new Set(),
      commands: new Set(),
      patches: new Map(),
      permissions: new Map(),
      pauseClock: (paused) => {
        if (session.turn !== current) return;
        clearTimeout(timer);
        if (paused) left -= Date.now() - since;
        else {
          since = Date.now();
          timer = setTimeout(expire, left);
        }
      },
      finish: (status, error, frame, error_code, resets_at) => {
        if (session.turn !== current) return;
        clearTimeout(timer);
        session.turn = undefined;
        for (const answer of current.permissions.values()) answer('deny', true);
        for (const request of current.pendingRequests.splice(0)) request();
        if (session.state === 'running') session.state = 'idle';
        // A turn ended by cancel, a lost transport or the deadline gets no turn/completed.
        session.emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          turn_id: turn.turn_id,
          kind: 'usage.updated',
          input_tokens: current.usage?.inputTokens,
          cached_input_tokens: current.usage?.cachedInputTokens,
          cache_write_input_tokens: current.usage?.cacheWriteInputTokens,
          output_tokens: current.usage?.outputTokens,
          reasoning_output_tokens: current.usage?.reasoningOutputTokens,
          context_tokens: current.contextTokens,
          context_window: current.contextWindow,
          cost_source: 'unknown',
          native_type: frame?.method,
        });
        // A v2 item may arrive after both raw items; prefer it for the entire call.
        for (const tool of current.rawTools) {
          if (current.v2ToolIds.has(tool.tool_call_id)) continue;
          session.emit({
            ...tool,
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id: turn.turn_id,
            native_type: 'rawResponseItem/completed',
          });
        }
        session.emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          turn_id: turn.turn_id,
          kind: 'turn.completed',
          ...(current.native_id ? { native_history_end: current.native_id } : {}),
          status,
          error,
          error_code,
          resets_at,
          native_type: frame?.method,
          native: frame,
        });
        const input = session.autoTitle?.input;
        if (input !== undefined && session.state === 'idle') {
          session.autoTitle = undefined;
          void nameThread(session, handle, input);
        }
        // Codex ends a turn without waiting for its commands; those still running go on in the background.
        const outlived = [...session.commands.values()].filter((command) => !command.background);
        for (const command of outlived) command.background = true;
        if (outlived.length) emitBackground(session);
      },
    };
    session.turn = current;
    timer = setTimeout(expire, left);
    // A model or speed change called before this turn sets the values its turn/start carries.
    if (session.tierChange) await session.tierChange;
    // A cancel or deadline while the change was applied already ended this turn.
    if (session.turn !== current || session.stopping)
      return { turn_id: turn.turn_id, status: 'delivered' };
    await startNativeTurn(session, handle.native_session_id, current, turn);
    return { turn_id: turn.turn_id, status: 'delivered' };
  }
  /** The next turn/start carries the new values; a running turn keeps its own. */
  async setModel(
    handle: SessionHandle,
    model: string,
    effort: EffortLevel | undefined,
    fast?: boolean,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session) return { ok: false, reason: 'Unknown Codex session' };
    return inOrder(session, async () => {
      session.serviceTier =
        (fast ?? session.spec.fast) ? await fastTier(session.rpc, model) : 'default';
      session.spec = {
        ...session.spec,
        model,
        effort,
        ...(fast !== undefined ? { fast: fast ? (true as const) : undefined } : {}),
      };
      // Control stores the handle's models back into the session on every event.
      handle.requested_model = model;
      handle.requested_effort = effort;
      delete handle.reported_model;
      return { ok: true };
    });
  }
  async setFastMode(handle: SessionHandle, fast: boolean): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session) return { ok: false, reason: 'Unknown Codex session' };
    return inOrder(session, async () => {
      session.serviceTier = fast ? await fastTier(session.rpc, session.spec.model) : 'default';
      session.spec = { ...session.spec, fast: fast ? true : undefined };
      return { ok: true };
    });
  }
  // Only later fileChange approvals see this; writes the turn's sandbox profile already allows go through.
  setTurnReadOnly(handle: SessionHandle, readOnly: boolean): void {
    const turn = this.sessions.get(handle)?.turn;
    if (turn) turn.readOnly = readOnly;
  }
  async steer(handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> {
    const session = this.sessions.get(handle);
    const current = session?.turn;
    // Queued input is sent by the control layer once the running turn ends.
    if (!session || !current?.native_id)
      return { turn_id: turn.turn_id, status: 'queued', reason: 'No native turn to steer yet' };
    if (current.interrupted)
      return { turn_id: turn.turn_id, status: 'queued', reason: 'The native turn is interrupting' };
    try {
      await session.rpc.request('turn/steer', {
        threadId: handle.native_session_id,
        expectedTurnId: current.native_id,
        input: nativeInput(turn),
      });
    } catch (error) {
      // RPC errors carry the server's JSON error; keep only its code.
      let code: unknown;
      try {
        code = (JSON.parse((error as Error).message) as { code?: unknown }).code;
      } catch {
        code = undefined;
      }
      throw new Error(
        code === undefined ? 'Codex turn/steer failed' : `Codex rejected turn/steer (${code})`,
      );
    }
    return { turn_id: turn.turn_id, status: 'delivered' };
  }
  async interrupt(handle: SessionHandle): Promise<Receipt> {
    const session = this.sessions.get(handle);
    const current = session?.turn;
    if (!session || !current || session.stopping)
      return { ok: false, reason: 'No Codex turn is running' };
    if (current.interrupted) return { ok: true, reason: 'The turn is already interrupting' };
    current.interrupted = true;
    if (!current.native_id)
      return { ok: true, reason: 'turn/interrupt follows once Codex returns the turn id' };
    const receipt = await interruptNativeTurn(
      session,
      handle.native_session_id,
      current.native_id,
      current.commands,
    );
    if (!receipt.ok) current.interrupted = false;
    return receipt;
  }
  async stopBackground(handle: SessionHandle, taskId: string): Promise<void> {
    const session = this.sessions.get(handle);
    if (
      ![...(session?.commands.values() ?? [])].some(
        (command) => command.background && command.id === taskId,
      )
    )
      throw new Error('No Codex background terminal with this id is running');
    // The exit watcher's item/completed takes the terminal off the list.
    await session!.rpc.request('thread/backgroundTerminals/terminate', {
      threadId: handle.native_session_id,
      processId: taskId,
    });
  }
  async inspect(handle: SessionHandle): Promise<NativeStatus> {
    return {
      state: this.sessions.get(handle)?.state ?? 'unknown',
      native_session_id: handle.native_session_id,
      process_identity: this.sessions.has(handle) ? handle.process_identity : undefined,
      observed_at: new Date().toISOString(),
    };
  }
  async answerPermission(
    handle: SessionHandle,
    request_id: string,
    decision: PermissionDecision,
    answers?: Record<string, string>,
    reason?: string,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session?.spec.sandbox)
      return { ok: false, reason: 'No permission requests are raised by this adapter' };
    const current = session.turn;
    const answer = current?.permissions.get(request_id);
    if (!current || !answer)
      return { ok: false, reason: 'Unknown permission request', unknown_request: true };
    answer(decision, undefined, answers);
    if (decision !== 'deny' || !reason) return { ok: true };
    // A Codex decline carries no message, so the reason follows as user input to the same turn.
    try {
      const steered = await this.steer(handle, {
        turn_id: current.id,
        input: `The user declined that request: ${reason}`,
      });
      if (steered.status === 'delivered') return { ok: true };
      return { ok: true, reason: `The rejection reason was not delivered: ${steered.reason}` };
    } catch (error) {
      return { ok: true, reason: `The rejection reason was not delivered: ${String(error)}` };
    }
  }
  async cancel(handle: SessionHandle, deadline: number): Promise<CancelReceipt> {
    const session = this.sessions.get(handle);
    if (!session)
      return {
        stopped: false,
        deadline,
        finished_at: new Date().toISOString(),
        evidence: { method: 'none', members: [] },
        reason: 'Unknown handle',
      };
    session.state = 'unknown';
    session.stopping = true;
    const current = session.turn;
    if (current) {
      for (const answer of current.permissions.values()) answer('deny', true);
      for (const request of current.pendingRequests.splice(0)) request();
    }
    if (current && Date.now() < deadline) {
      const interrupt = session.rpc.request(
        'turn/interrupt',
        { threadId: handle.native_session_id, turnId: current.native_id },
        Math.max(1, Math.min(1000, (deadline - Date.now()) / 2)),
      );
      await interrupt.catch(() => {});
    }
    const receipt = await session.rpc.close(deadline);
    current?.finish('interrupted');
    session.state = receipt.stopped ? 'exited' : 'unknown';
    return receipt;
  }
  async close(handle: SessionHandle, deadline: number): Promise<CancelReceipt> {
    return this.cancel(handle, deadline);
  }
}
