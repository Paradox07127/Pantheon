import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, type UUID } from 'node:crypto';
import {
  query,
  resolveSettings,
  type AccountInfo,
  type CanUseTool,
  type EffortLevel as ClaudeEffortLevel,
  type Options,
  type PermissionResult,
  type ResolvedSettings,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import {
  id,
  DomainError,
  NATIVE_ENV_ALLOWLIST,
  PLAN_MODE_INSTRUCTION,
  SessionStartError,
  closeUserExtensions,
  permissionRule,
  type ApprovalQuestion,
  type BackgroundTask,
  type ContextBreakdown,
  type EffortLevel,
  type HarnessAdapter,
  type Capability,
  type CapabilityReport,
  type SessionSpec,
  type AgentEvent,
  type AgentEventSink,
  type SessionHandle,
  type UserTurn,
  type TurnAttachment,
  type DeliveryReceipt,
  type NativeStatus,
  type CancelReceipt,
  type Receipt,
  type PermissionDecision,
  type ExtensionInventory,
  type McpServerStatus,
  type McpResourceContents,
  type ExtensionOverrides,
  type ProcessIdentity,
  type RemoteLaunch,
  type RuntimeModel,
} from '@pantheon/domain';
import {
  deviceGroupOf,
  nativeEnvironment,
  processIdentity,
  readProcessIdentity,
  descendants,
  descendantRuns,
  groupHolds,
  groupMembers,
  mergeProcesses,
  realPathsOnDevice,
  remoteSpawn,
  sandboxFactsOnDevice,
  report,
  stopOnDevice,
  transportEnvironment,
  validateSessionSpec,
  type DeviceProcess,
  type LeftoverProcess,
} from './process.js';
import { MIN_VERSIONS } from './capabilities.js';
import { installedFields, notInstalled, readVersion, type Preflight } from './preflight.js';

import { imageLimit, needsYouLimit, tracePayload } from './trace.js';
import { plannerInstructions } from './planner.js';
import { nativeSessionTitle, prepareNativeState } from './native-state.js';

/** Tools that ask and plan mode allow without asking the user. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebSearch',
  'ToolSearch',
  'TodoWrite',
  'Task',
  'Agent',
  'BashOutput',
  'KillShell',
]);

/** Tools of the chrome_devtools server Pantheon passes in that only read the renderer. */
const DEVTOOLS_READ_TOOLS = new Set(
  [
    'list_pages',
    'select_page',
    'take_screenshot',
    'take_snapshot',
    'list_console_messages',
    'get_console_message',
    'list_network_requests',
    'get_network_request',
    'get_css_styles',
    'wait_for',
  ].map((name) => `mcp__chrome_devtools__${name}`),
);

const READ_ONLY_DENIAL =
  'Your plan has unfinished tasks, so this lead turn is read-only: read files, run git log, git status or git diff, act through the Pantheon tools, and leave changes to the task sessions.';
const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'pwd',
  'echo',
  'printf',
]);
const READ_ONLY_GIT = new Set([
  'log',
  'status',
  'diff',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'blame',
]);

/** Splits a command on `;`, `&&` and `||`, or with `pipes` on `|`, outside quotes and backslash escapes. */
function simpleCommands(command: string, pipes = false): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"') i++;
    } else if (char === '\\') i++;
    else if (char === "'" || char === '"') quote = char;
    else if (
      pipes
        ? char === '|'
        : char === ';' || ((char === '&' || char === '|') && command[i + 1] === char)
    ) {
      parts.push(command.slice(start, i));
      if (!pipes && char !== ';') i++;
      start = i + 1;
    }
  }
  return [...parts, command.slice(start)];
}

/** True for a command list whose every pipeline only reads; anything uncertain is false. */
function readOnlyBash(
  command: string,
  spec: Pick<SessionSpec, 'cwd' | 'project_roots' | 'sandbox'>,
): boolean {
  // These redirections only discard output or merge it into the pipe.
  const unredirected = command.replace(/(^|\s)(?:2>&1|[12]?>\/dev\/null)(?=$|[\s;&|])/g, '$1');
  // Unquoted braces, globs (with the zsh extended glob ^) and parentheses expand into words the checks below never see.
  // A quote left open would hide the separators after it from the splitters.
  if (/[{}*?[\]()^'"]/.test(unredirected.replace(/'[^']*'|"(?:[^"\\]|\\[\s\S])*"|\\[\s\S]/g, '')))
    return false;
  return simpleCommands(unredirected).every((part) => {
    if (/[<>;&`$\n\r]/.test(part)) return false;
    return readOnlyPipeline(part, spec);
  });
}

/**
 * True for an absolute directory inside a project root the session may read. Relative paths are
 * refused: the shell keeps its directory between commands and CDPATH can redirect cd.
 */
function readableDirectory(
  directory: string,
  spec: Pick<SessionSpec, 'cwd' | 'project_roots' | 'sandbox'>,
): boolean {
  if (!path.isAbsolute(directory) || directory.split('/').includes('..')) return false;
  return (
    (spec.project_roots?.map((root) => root.path) ?? [spec.cwd]).some((root) =>
      within(root, directory),
    ) &&
    !(spec.sandbox?.protected_entries ?? []).some(
      (entry) => entry.deny === 'read_write' && within(entry.path, directory),
    )
  );
}

function readOnlyPipeline(
  command: string,
  spec: Pick<SessionSpec, 'cwd' | 'project_roots' | 'sandbox'>,
): boolean {
  return simpleCommands(command, true).every((segment) => {
    // Dropping quotes and backslashes keeps `"-exec"` or `-e\xec` from passing as another word.
    const [program = '', ...args] = segment
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/["'\\]/g, ''));
    if (program === 'cd') return args.length === 1 && readableDirectory(args[0]!, spec);
    if (program === 'git') {
      let options = args;
      while (options[0] === '-C') {
        if (!readableDirectory(options[1] ?? '', spec)) return false;
        options = options.slice(2);
      }
      const [sub = '', ...rest] = options;
      if (!READ_ONLY_GIT.has(sub)) return false;
      // Other branch options create, move or delete branches.
      if (sub === 'branch')
        return rest.every((arg) =>
          ['-a', '-r', '-v', '-vv', '--all', '--remotes', '--list', '--show-current'].includes(arg),
        );
      return !rest.some((arg) => /^--(output|ext-diff|textconv)/.test(arg));
    }
    if (program === 'find')
      return !args.some((arg) =>
        /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(arg),
      );
    // Both options run a program named by the caller.
    if (program === 'rg') return !args.some((arg) => /^--(pre|hostname-bin)/.test(arg));
    return READ_ONLY_PROGRAMS.has(program);
  });
}

const NATIVE_PERMISSION_MODES = {
  ask: 'default',
  auto_edit: 'acceptEdits',
  plan: 'plan',
  auto: 'auto',
  full_access: 'bypassPermissions',
} as const satisfies Record<NonNullable<SessionSpec['permission_mode']>, Options['permissionMode']>;

const CLAUDE_EFFORTS: Record<ClaudeEffortLevel, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};
const isClaudeEffort = (effort: EffortLevel): effort is ClaudeEffortLevel =>
  Object.hasOwn(CLAUDE_EFFORTS, effort);

/**
 * An opened connector needs the connector switch on, so the listed ones not opened are denied by
 * server name; toggleMcpServer would write the user's own settings.
 */
function closeConnectors(
  overrides: ExtensionOverrides,
  listed: ExtensionInventory['connectors'],
): ExtensionOverrides {
  const opened = overrides.enabled_user_connectors;
  if (!opened || overrides.disable_apps) return overrides;
  if (!opened.length) return { ...overrides, disable_apps: true };
  return {
    ...overrides,
    disabled_mcp_servers: [
      ...new Set([
        ...overrides.disabled_mcp_servers,
        ...listed.map((connector) => connector.name).filter((name) => !opened.includes(name)),
      ]),
    ],
  };
}

/** The user-level MCP servers and skills of this machine's home that a session in cwd can load. */
function homeExtensions(
  cwd: string,
  userConfigDir?: string,
): Parameters<typeof closeUserExtensions>[1] {
  const home = os.homedir();
  const servers = new Set<string>();
  const file = path.join(home, '.claude.json');
  if (existsSync(file)) {
    const value = JSON.parse(readFileSync(file, 'utf8')) as {
      mcpServers?: object;
      projects?: Record<string, { mcpServers?: object }>;
    };
    // Local servers are keyed by folder, and a linked worktree's can sit under its source repository.
    const folders = [cwd, ...linkedMainGit(cwd).map((git) => path.dirname(git))];
    for (const entry of [
      value.mcpServers,
      ...folders.map((folder) =>
        value.projects && Object.hasOwn(value.projects, folder)
          ? value.projects[folder]!.mcpServers
          : undefined,
      ),
    ])
      for (const name of Object.keys(entry ?? {})) servers.add(name);
  }
  const skills = new Set(
    [
      path.join(home, '.claude', 'skills'),
      ...(userConfigDir ? [path.join(userConfigDir, 'skills')] : []),
    ]
      .filter((dir) => existsSync(dir))
      .flatMap((dir) =>
        readdirSync(dir).filter(
          (name) =>
            !name.startsWith('.') &&
            name !== 'synced' &&
            statSync(path.join(dir, name), { throwIfNoEntry: false })?.isDirectory(),
        ),
      ),
  );
  return {
    mcp_servers: [...servers].map((name) => ({ name, user: true })),
    skills: [...skills].map((id) => ({ id, user: true })),
  };
}

/** The main repository's .git when dir is a linked worktree; Claude Code's sandbox lets commands write it. */
function linkedMainGit(dir: string): string[] {
  const marker = path.join(dir, '.git');
  if (!statSync(marker, { throwIfNoEntry: false })?.isFile()) return [];
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'))?.[1]?.trim();
  if (!gitdir) return [];
  const worktree = path.resolve(dir, gitdir);
  const main = path.dirname(path.dirname(worktree));
  return path.basename(path.dirname(worktree)) === 'worktrees' && existsSync(main) ? [main] : [];
}

/** Session-only options; the caller supplies environment and process state. */
export function buildClaudeOptions(
  spec: Pick<
    SessionSpec,
    | 'cwd'
    | 'model'
    | 'effort'
    | 'extensions'
    | 'budget'
    | 'sandbox'
    | 'native_title'
    | 'control_instructions'
    | 'task_session'
    | 'runtime_analysis'
    | 'read_only_shell'
  > &
    Partial<
      Pick<
        SessionSpec,
        | 'permission_mode'
        | 'allowed_rules'
        | 'fast'
        | 'ultracode'
        | 'remote'
        | 'env_allowlist'
        | 'project_roots'
        | 'mcp_servers'
        | 'user_session'
      >
    > &
    (
      | Pick<SessionSpec, 'project_id' | 'pantheon_mcp' | 'role'>
      | {
          role?: undefined;
          pantheon_mcp?: undefined;
        }
    ),
  base: Pick<
    Options,
    | 'pathToClaudeCodeExecutable'
    | 'env'
    | 'resume'
    | 'abortController'
    | 'spawnClaudeCodeProcess'
    | 'extraArgs'
  >,
  /** Skill names a listing found; without one the skills option is left out. */
  listedSkills?: readonly string[],
  requestPermission?: CanUseTool,
  /** Read on every tool call, so a mode change applies to the running query. */
  permissionMode: () => SessionSpec['permission_mode'] = () => spec.permission_mode,
  /** Read on every tool call, so a rule allowed mid-run applies to the running query. */
  allowedRules: () => SessionSpec['allowed_rules'] = () => spec.allowed_rules,
  /** Read on every tool call: whether the current user turn may only read. */
  readOnly: () => boolean = () => false,
  /** Read on every tool call: whether a user turn is running on this query. */
  turnActive: () => boolean = () => true,
  /** Shared by every SDK query opened for this adapter session. */
  subagents: { launches: number } = { launches: 0 },
  /** Whether the sandbox can name a protected path that lies outside the writable roots. */
  mounted: (target: string) => boolean = (target) =>
    process.platform !== 'linux' || existsSync(target),
): Options {
  const overrides = spec.extensions?.mode === 'inherit' ? spec.extensions.overrides : undefined;
  const deniedSkills = (overrides?.disabled_skills ?? []).map((name) => `Skill(${name})`);
  const mcpServers = spec.mcp_servers ?? [];
  const settings = {
    ...(spec.fast || spec.permission_mode ? { fastMode: spec.fast === true } : {}),
    ...(spec.task_session ? { disableWorkflows: true } : {}),
    ...(spec.ultracode ? { ultracode: true } : {}),
    ...(spec.role === 'reviewer' ? { autoMemoryEnabled: false } : {}),
    ...(overrides
      ? {
          ...(overrides.disabled_mcp_servers.length
            ? {
                deniedMcpServers: overrides.disabled_mcp_servers
                  .filter((name) => !spec.pantheon_mcp || name !== 'pantheon')
                  .filter((name) => !mcpServers.some((server) => server.name === name))
                  .map((serverName) => ({ serverName })),
              }
            : {}),
          ...(overrides.disabled_plugins.length
            ? {
                enabledPlugins: Object.fromEntries(
                  overrides.disabled_plugins.map((id) => [id, false]),
                ),
              }
            : {}),
          ...(deniedSkills.length ? { permissions: { deny: deniedSkills } } : {}),
          ...(overrides.disable_hooks ? { disableAllHooks: true } : {}),
          ...(overrides.disable_apps ? { disableClaudeAiConnectors: true } : {}),
        }
      : {}),
  } satisfies NonNullable<Options['settings']>;
  /**
   * Pantheon's answers that come before the permission mode, the allowed rules and the user. Only a
   * device session's answer is a promise, so a local call reaches the user in the same tick.
   */
  const settle = (
    tool: string,
    input: Record<string, unknown>,
  ): PermissionResult | undefined | Promise<PermissionResult | undefined> => {
    // A background agent can outlive its turn; nothing grants its tools then.
    if (!turnActive()) return { behavior: 'deny', message: 'Tool request has no active turn' };
    if (
      tool === 'Skill' &&
      typeof input.skill === 'string' &&
      overrides?.disabled_skills.includes(input.skill)
    )
      return { behavior: 'deny', message: 'Skill is disabled for this project session' };
    if (!spec.sandbox || spec.runtime_analysis)
      return { behavior: 'deny', message: 'Only Pantheon session tools are enabled' };
    if (spec.role === 'planner' && !['Read', 'Glob', 'Grep'].includes(tool)) {
      if (spec.read_only_shell && tool === 'Bash') {
        if (typeof input.command !== 'string' || !readOnlyBash(input.command, spec))
          return { behavior: 'deny', message: 'Only read-only shell commands are enabled' };
      } else return { behavior: 'deny', message: 'Only read-only file tools are enabled' };
    }
    // ToolSearch only loads tool definitions.
    if (tool === 'ToolSearch') return { behavior: 'allow', updatedInput: input };
    const after = (denial: string | undefined): PermissionResult | undefined => {
      if (denial) return { behavior: 'deny', message: denial };
      // Before the mode, allowed rules and the user, so none of them can widen a read-only turn.
      // Questions to the user and leaving plan mode write nothing, so they keep their usual flow.
      if (readOnly() && !['AskUserQuestion', 'ExitPlanMode'].includes(tool)) {
        const allowed =
          tool === 'Bash'
            ? typeof input.command === 'string' && readOnlyBash(input.command, spec)
            : READ_ONLY_TOOLS.has(tool);
        if (!allowed) return { behavior: 'deny', message: READ_ONLY_DENIAL };
        return { behavior: 'allow', updatedInput: input };
      }
    };
    return spec.remote
      ? deviceToolDenial(spec, spec.remote, tool, input, spec.env_allowlist ?? []).then(after)
      : after(toolDenial(spec, tool, input));
  };
  // On Linux the sandbox mounts /dev/null over a missing path that Edit rules or denyWrite name, and
  // git then fails to read the source repository's packed-refs. Outside allowWrite nothing can be
  // created anyway, and the PreToolUse gate still refuses file tools there.
  const mountedOnLinux = (target: string) =>
    mounted(target) ||
    (spec.sandbox?.writable_roots ?? []).some((root) => {
      const relative = path.relative(root, target);
      return (
        relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    });
  return {
    ...base,
    ...(spec.native_title ? { title: spec.native_title } : {}),
    persistSession: true,
    includeHookEvents: true,
    includePartialMessages: true,
    cwd: spec.cwd,
    ...(overrides
      ? {
          settingSources: ['user', 'project', 'local'],
          ...(overrides.disabled_skills.length && listedSkills
            ? { skills: listedSkills.filter((name) => !overrides.disabled_skills.includes(name)) }
            : {}),
        }
      : { settingSources: [], mcpServers: {}, strictMcpConfig: true }),
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(spec.pantheon_mcp || mcpServers.length
      ? {
          mcpServers: {
            ...(spec.pantheon_mcp
              ? {
                  pantheon: {
                    type: 'stdio' as const,
                    command: spec.pantheon_mcp.command,
                    args: spec.pantheon_mcp.args,
                    env: spec.pantheon_mcp.env,
                  },
                }
              : {}),
            ...Object.fromEntries(
              mcpServers.map(({ name, command, args, env }) => [
                name,
                { type: 'stdio' as const, command, args, env },
              ]),
            ),
          },
        }
      : {}),
    ...(spec.sandbox
      ? {
          settings: {
            ...settings,
            permissions: {
              deny: [
                ...deniedSkills,
                ...spec.sandbox.protected_entries
                  .filter((entry) => !spec.user_session || entry.deny === 'read_write')
                  .flatMap((entry) =>
                    [
                      ...(entry.deny === 'read_write' ? ['Read'] : []),
                      ...(mountedOnLinux(entry.path) ? ['Edit'] : []),
                    ].flatMap((tool) => [`${tool}(/${entry.path})`, `${tool}(/${entry.path}/**)`]),
                  ),
              ],
            },
          },
        }
      : {}),
    // A user session runs in the sandbox its own Claude settings choose, if any.
    ...(spec.sandbox && !spec.user_session
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            // Inherited user settings can turn these on; each one lets a command leave the sandbox.
            allowAppleEvents: false,
            allowNestedUserNamespaces: false,
            enableWeakerNetworkIsolation: false,
            network: { allowAllUnixSockets: false },
            excludedCommands: [],
            filesystem: {
              disabled: false,
              allowWrite: spec.sandbox.writable_roots,
              denyRead: spec.sandbox.protected_entries
                .filter((entry) => entry.deny === 'read_write')
                .map((entry) => entry.path),
              denyWrite: [
                ...(spec.sandbox.writable_roots.length
                  ? []
                  : spec.remote && !spec.read_only_shell
                    ? // The device's home is unknown here, and its shell is not limited to reads.
                      ['/']
                    : // Claude Code writes each command's working directory under /tmp/claude-<uid>, which '/' denies.
                      [
                        ...new Set([
                          ...(spec.remote ? [] : [os.homedir(), ...linkedMainGit(spec.cwd)]),
                          spec.cwd,
                          ...(spec.project_roots ?? []).map((root) => root.path),
                        ]),
                      ]),
                ...spec.sandbox.protected_entries.map((entry) => entry.path).filter(mountedOnLinux),
              ],
            },
          },
        }
      : {}),
    // Settings allow rules, bypassPermissions and user hooks can bypass canUseTool.
    // An SDK ask decision routes every call back through Pantheon's permission gate.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              // SubagentStart cannot deny a launch; reserve slots here, including nested calls.
              if (
                spec.task_session &&
                input.hook_event_name === 'PreToolUse' &&
                ['Agent', 'Task'].includes(input.tool_name) &&
                ++subagents.launches > 4
              )
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: 'Task session subagent launch limit (4) reached',
                  },
                };
              const mode = permissionMode();
              // The classifier or bypass decides what Pantheon's own checks do not refuse; in a user
              // session the native permission rules decide in every mode.
              if (
                input.hook_event_name === 'PreToolUse' &&
                (spec.user_session || mode === 'auto' || mode === 'full_access') &&
                !input.tool_name.startsWith('mcp__pantheon__') &&
                !['AskUserQuestion', 'ExitPlanMode'].includes(input.tool_name)
              ) {
                const settled = await settle(
                  input.tool_name,
                  (input.tool_input ?? {}) as Record<string, unknown>,
                );
                return settled?.behavior === 'deny'
                  ? {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: settled.message,
                      },
                    }
                  : {};
              }
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'ask',
                  permissionDecisionReason: 'Pantheon decides every tool call through canUseTool',
                },
              };
            },
          ],
        },
      ],
    },
    tools: spec.runtime_analysis
      ? []
      : spec.sandbox
        ? spec.role === 'planner'
          ? spec.read_only_shell
            ? ['Read', 'Glob', 'Grep', 'Bash']
            : ['Read', 'Glob', 'Grep']
          : { type: 'preset', preset: 'claude_code' }
        : [],
    ...(spec.user_session ? {} : { allowedTools: [] }),
    permissionMode: spec.permission_mode
      ? NATIVE_PERMISSION_MODES[spec.permission_mode]
      : 'dontAsk',
    // Lets setPermissionMode enter bypassPermissions later; the starting mode is the one above.
    ...(spec.sandbox ? { allowDangerouslySkipPermissions: true } : {}),
    canUseTool: async (tool, input, options) => {
      // The server passed in mcpServers comes from the command line ('dynamic'); a configured
      // server named like pantheon__x would give its tools the same prefix.
      if (
        spec.pantheon_mcp &&
        options.mcpServer?.source === 'dynamic' &&
        options.mcpServer.name === 'pantheon' &&
        tool.startsWith('mcp__pantheon__')
      ) {
        if (!turnActive()) return { behavior: 'deny', message: 'Tool request has no active turn' };
        if (!spec.pantheon_mcp.ask_tools?.includes(tool.slice('mcp__pantheon__'.length)))
          return { behavior: 'allow', updatedInput: input };
        // Allowed rules stay dormant in plan mode here too.
        if (permissionMode() !== 'plan' && allowedRules()?.includes(permissionRule(tool, input)))
          return { behavior: 'allow', updatedInput: input };
        return requestPermission
          ? requestPermission(tool, input, options)
          : { behavior: 'deny', message: 'No active permission handler' };
      }
      const pending = settle(tool, input);
      const settled = pending instanceof Promise ? await pending : pending;
      if (settled) return settled;
      const readOnlyCommand =
        tool === 'Bash' && typeof input.command === 'string' && readOnlyBash(input.command, spec);
      if (
        options.mcpServer?.source === 'dynamic' &&
        options.mcpServer.name === 'chrome_devtools' &&
        DEVTOOLS_READ_TOOLS.has(tool)
      )
        return { behavior: 'allow', updatedInput: input };
      const mode = permissionMode();
      // Allowed rules stay dormant until the session leaves plan mode.
      if (
        mode === 'plan' &&
        !READ_ONLY_TOOLS.has(tool) &&
        !readOnlyCommand &&
        !['ExitPlanMode', 'AskUserQuestion'].includes(tool)
      )
        return { behavior: 'deny', message: PLAN_MODE_INSTRUCTION };
      if (allowedRules()?.includes(permissionRule(tool, input)))
        return { behavior: 'allow', updatedInput: input };
      if (spec.user_session) {
        // No Pantheon sandbox bounds its reads: what the native rules send here is asked.
      } else if (mode === 'ask' || mode === 'plan' || mode === 'auto') {
        if (READ_ONLY_TOOLS.has(tool) || readOnlyCommand)
          return { behavior: 'allow', updatedInput: input };
      } else if (
        spec.role === 'planner' ||
        (spec.role === 'writer'
          ? !tool.startsWith('mcp__') && !['AskUserQuestion', 'ExitPlanMode'].includes(tool)
          : [
              'Bash',
              'Read',
              'Edit',
              'Write',
              'MultiEdit',
              'NotebookEdit',
              'Glob',
              'Grep',
              'TodoWrite',
              'TaskStop',
            ].includes(tool))
      )
        return { behavior: 'allow', updatedInput: input };
      return requestPermission
        ? requestPermission(tool, input, options)
        : { behavior: 'deny', message: 'No active permission handler' };
    },
    ...(spec.runtime_analysis
      ? { systemPrompt: spec.control_instructions }
      : spec.sandbox && spec.role !== 'planner'
        ? spec.role === 'writer' && spec.control_instructions
          ? {
              systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append: spec.control_instructions,
              },
            }
          : {}
        : {
            systemPrompt: [
              spec.pantheon_mcp || (spec.sandbox && spec.role === 'planner')
                ? plannerInstructions(spec)
                : 'Respond to the user text only. No tools or file operations are available.',
              ...(spec.role === 'writer' && spec.control_instructions
                ? [spec.control_instructions]
                : []),
            ].join('\n\n'),
          }),
    // The SDK counts each tool round as a turn; Pantheon's max_turns counts user turns.
    ...(spec.sandbox || spec.pantheon_mcp ? {} : { maxTurns: spec.budget.max_turns }),
    model: spec.model,
    ...(spec.effort && isClaudeEffort(spec.effort) ? { effort: spec.effort } : {}),
  };
}

// Resolve existing ancestors and dangling links before checking a tool's not-yet-created target.
function toolPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      return toolPath(path.resolve(path.dirname(absolute), readlinkSync(absolute)));
    } catch (linkError) {
      if (!['ENOENT', 'EINVAL'].includes((linkError as NodeJS.ErrnoException).code ?? ''))
        throw linkError;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(toolPath(parent), path.basename(absolute));
  }
}

/** The parts of AskUserQuestion input a question card shows; option previews are left out. */
function askedQuestions(questions: unknown[]): ApprovalQuestion[] {
  return (questions as Partial<ApprovalQuestion>[]).map((q) => ({
    question: String(q.question),
    header: String(q.header ?? ''),
    options: (Array.isArray(q.options) ? q.options : []).map((option) => ({
      label: String(option.label),
      description: String(option.description ?? ''),
    })),
    multiSelect: q.multiSelect === true,
  }));
}

function toolDenial(
  spec: Pick<SessionSpec, 'cwd' | 'sandbox' | 'user_session'>,
  tool: string,
  input: Record<string, unknown>,
  resolve: (target: string) => string = toolPath,
): string | undefined {
  if (!spec.sandbox) return 'Tools are not enabled for the text probe';
  // In a user session the native rules govern these and writes; only read_write entries stay denied.
  if (tool === 'Bash' && input.dangerouslyDisableSandbox && !spec.user_session)
    return 'Bash must run inside the sandbox';
  if (
    !spec.user_session &&
    (tool === 'EnterWorktree' ||
      tool === 'ExitWorktree' ||
      ((tool === 'Agent' || tool === 'Task') && input.isolation !== undefined))
  )
    return 'The session must stay in the worktree Pantheon gave it';
  const writing = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool);
  const searching = tool === 'Glob' || tool === 'Grep';
  if (!writing && !searching && tool !== 'Read') return;
  const target =
    tool === 'NotebookEdit'
      ? input.notebook_path
      : searching
        ? (input.path ?? spec.cwd)
        : input.file_path;
  if (typeof target !== 'string' || !target || target.includes('\0'))
    return 'File tool requires a valid target path';
  try {
    const resolved = resolve(path.resolve(spec.cwd, target));
    const inside = (root: string): boolean => {
      const relative = path.relative(resolve(root), resolved);
      return (
        relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    };
    if (
      spec.sandbox.protected_entries.some(
        (entry) =>
          ((writing && !spec.user_session) || entry.deny === 'read_write') && inside(entry.path),
      )
    )
      return 'File target is protected';
    if (writing && !spec.user_session && !spec.sandbox.writable_roots.some(inside))
      return 'File writes must stay inside the writable roots';
  } catch {
    return 'Unable to resolve file target safely';
  }
}

/** toolDenial for a session on a device, whose files only the device can resolve. */
async function deviceToolDenial(
  spec: Pick<SessionSpec, 'cwd' | 'sandbox' | 'user_session'>,
  remote: RemoteLaunch,
  tool: string,
  input: Record<string, unknown>,
  allowlist: readonly string[],
): Promise<string | undefined> {
  const asked: string[] = [];
  const lexical = toolDenial(spec, tool, input, (target) => (asked.push(target), target));
  if (!asked.length || !spec.sandbox) return lexical;
  const paths = [
    ...new Set([
      asked[0]!,
      ...spec.sandbox.protected_entries.map((entry) => entry.path),
      ...spec.sandbox.writable_roots,
    ]),
  ];
  const real = await realPathsOnDevice(remote, paths, allowlist, Date.now() + DEVICE_PATH_MS);
  if (!real) return 'Unable to resolve file target on the device';
  return toolDenial(spec, tool, input, (target) => {
    const found = real[paths.indexOf(target)];
    if (found === undefined) throw new Error('Path was not resolved on the device');
    return found;
  });
}

const within = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
};

// Relative entries start at ~/.claude for user settings and at the project otherwise.
const settingsBase = (cwd: string, source: string, file: string | undefined): string =>
  source === 'user' && file ? path.dirname(file) : cwd;

const settingsTarget = (entry: string, home: string, base: string): string => {
  // A glob is checked as the folder it starts in.
  const literal = entry.replace(/[^/]*[*?[{].*$/, '');
  return literal === '~' || literal.startsWith('~/')
    ? path.join(home, literal.slice(1))
    : path.resolve(base, literal);
};

/** The CLI lets an inherited sandbox allowRead win over the denyRead Pantheon sets. */
async function refuseInheritedReadAllows(
  cwd: string,
  sandbox: NonNullable<SessionSpec['sandbox']>,
  /** A device session's settings and home, and its paths resolved on the device. */
  device?: Pick<ResolvedSettings, 'sources'> & {
    home: string;
    resolve: (paths: string[]) => Promise<string[]>;
  },
): Promise<void> {
  const unreadable = sandbox.protected_entries
    .filter((entry) => entry.deny === 'read_write')
    .map((entry) => entry.path);
  if (!unreadable.length) return;
  const { sources } =
    device ?? (await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] }));
  const home = device?.home ?? os.homedir();
  const allowed = sources.flatMap(({ source, path: file, settings }) =>
    (settings.sandbox?.filesystem?.allowRead ?? []).map((entry) =>
      settingsTarget(entry, home, settingsBase(cwd, source, file)),
    ),
  );
  const real = device
    ? await device.resolve([...unreadable, ...allowed])
    : [...unreadable, ...allowed].map(toolPath);
  const denied = real.slice(0, unreadable.length);
  if (
    real
      .slice(unreadable.length)
      .some((target) => denied.some((entry) => within(entry, target) || within(target, entry)))
  )
    throw new DomainError(
      'protected_read_allowed',
      'Inherited sandbox settings allow reading a path the session must not read',
    );
}

/** The CLI runs excluded commands unsandboxed and adds allowWrite and Edit allow paths to its writable paths. */
async function refuseInheritedWriteAllows(
  cwd: string,
  sandbox: NonNullable<SessionSpec['sandbox']>,
  /** A device session's settings and home, and its paths resolved on the device. */
  device?: Pick<ResolvedSettings, 'sources'> & {
    home: string;
    resolve: (paths: string[]) => Promise<string[]>;
  },
): Promise<void> {
  const { sources } =
    device ?? (await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] }));
  const home = device?.home ?? os.homedir();
  // Managed settings are the administrator's, not the user's. A rule without a target always widens.
  const rules = sources
    .filter((entry) => ['user', 'project', 'local'].includes(entry.source))
    .flatMap(({ source, path: file, settings }): { rule: string; target?: string }[] => {
      const base = settingsBase(cwd, source, file);
      const where = file ? ` in ${file}` : '';
      return [
        ...(settings.sandbox?.excludedCommands ?? []).map((command) => ({
          rule: `sandbox.excludedCommands ${JSON.stringify(command)}${where}`,
        })),
        ...(settings.sandbox?.filesystem?.allowWrite ?? []).map((entry) => ({
          rule: `sandbox.filesystem.allowWrite ${JSON.stringify(entry)}${where}`,
          target: settingsTarget(entry, home, base),
        })),
        ...(settings.permissions?.allow ?? []).flatMap((rule) => {
          const target = /^Edit(?:\((.*)\))?$/.exec(rule)?.[1];
          const label = `permissions.allow ${JSON.stringify(rule)}${where}`;
          if (target === undefined) return rule === 'Edit' ? [{ rule: label }] : [];
          // `//x` is absolute, `/x` starts at the settings base and `x` at the working folder.
          return [
            {
              rule: label,
              target: target.startsWith('//')
                ? settingsTarget(target.slice(1), home, '/')
                : target.startsWith('/')
                  ? settingsTarget(target.slice(1), home, base)
                  : settingsTarget(target, home, cwd),
            },
          ];
        }),
      ];
    });
  if (!rules.length) return;
  const targeted = rules.filter((entry) => entry.target !== undefined);
  const paths = [...sandbox.writable_roots, ...targeted.map((entry) => entry.target!)];
  const real = device ? await device.resolve(paths) : paths.map(toolPath);
  const roots = real.slice(0, sandbox.writable_roots.length);
  const outside = new Set(
    targeted.filter((_, index) => !roots.some((root) => within(root, real[roots.length + index]!))),
  );
  const widening = rules.find((entry) => entry.target === undefined || outside.has(entry));
  if (widening)
    throw new DomainError(
      'sandbox_widened',
      `Inherited Claude settings widen the sandbox with ${widening.rule}`,
    );
}

const MANAGED_SETTINGS = [
  '/etc/claude-code/managed-settings.json',
  '/Library/Application Support/ClaudeCode/managed-settings.json',
];

/**
 * Checks a device session's sandbox against the device's own settings and paths, and returns
 * which protected paths its sandbox can name. Refuses the session when the device cannot be checked.
 */
async function deviceSandbox(
  spec: Pick<SessionSpec, 'cwd' | 'env' | 'env_allowlist' | 'extensions' | 'user_session'>,
  remote: RemoteLaunch,
  sandbox: NonNullable<SessionSpec['sandbox']>,
): Promise<(target: string) => boolean> {
  const unresolved = () =>
    new DomainError('sandbox_unresolved', 'Unable to check the sandbox paths on the device');
  const deadline = Date.now() + DEVICE_PATH_MS;
  const protectedPaths = sandbox.protected_entries.map((entry) => entry.path);
  const config = { ...remote.env, ...spec.env }.CLAUDE_CONFIG_DIR;
  const files: (readonly ['managed' | 'user' | 'project' | 'local', string])[] =
    spec.extensions?.mode === 'inherit' && !spec.user_session
      ? [
          ...MANAGED_SETTINGS.map((file) => ['managed', file] as const),
          ['user', config ? path.posix.join(config, 'settings.json') : '~/.claude/settings.json'],
          ['project', path.posix.join(spec.cwd, '.claude', 'settings.json')],
          ['local', path.posix.join(spec.cwd, '.claude', 'settings.local.json')],
        ]
      : [];
  const facts = await sandboxFactsOnDevice(
    remote,
    protectedPaths,
    files.map(([, file]) => file),
    spec.env_allowlist,
    deadline,
  );
  if (!facts) throw unresolved();
  if (files.length) {
    const sources = files.flatMap(([source, file], index) => {
      const text = facts.files[index];
      if (text === undefined) return [];
      let settings: {
        sandbox?: {
          excludedCommands?: unknown;
          filesystem?: { allowRead?: unknown; allowWrite?: unknown };
        };
        permissions?: { allow?: unknown };
      } | null;
      try {
        settings = JSON.parse(text);
      } catch {
        throw unresolved();
      }
      const strings = (value: unknown): string[] => {
        if (value === undefined) return [];
        if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
        throw unresolved();
      };
      return [
        {
          source,
          path: file.startsWith('~/') ? path.posix.join(facts.home, file.slice(2)) : file,
          settings: {
            sandbox: {
              excludedCommands: strings(settings?.sandbox?.excludedCommands),
              filesystem: {
                allowRead: strings(settings?.sandbox?.filesystem?.allowRead),
                allowWrite: strings(settings?.sandbox?.filesystem?.allowWrite),
              },
            },
            permissions: { allow: strings(settings?.permissions?.allow) },
          },
        },
      ];
    });
    const device = {
      sources,
      home: facts.home,
      resolve: async (paths: string[]) => {
        const real = await realPathsOnDevice(remote, paths, spec.env_allowlist, deadline);
        if (!real) throw unresolved();
        return real;
      },
    };
    await refuseInheritedReadAllows(spec.cwd, sandbox, device);
    await refuseInheritedWriteAllows(spec.cwd, sandbox, device);
  }
  return (target) => !facts.linux || facts.present[protectedPaths.indexOf(target)] === true;
}

type UserContent = SDKUserMessage['message']['content'];
type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const IMAGE_MIMES: Record<ImageMime, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/gif': true,
  'image/webp': true,
};
const isImage = (attachment: TurnAttachment): attachment is TurnAttachment & { mime: ImageMime } =>
  Object.hasOwn(IMAGE_MIMES, attachment.mime);

/**
 * Plain text without attachments; otherwise the text, with file paths appended, then one block per
 * image. The SDK has no input item for skills; its user input invokes a skill as `/name`.
 */
function userContent(turn: UserTurn): UserContent {
  const attachments = turn.attachments ?? [];
  const input = [...(turn.skills ?? []).map((skill) => `/${skill.name}`), turn.input].join(' ');
  if (!attachments.length) return input;
  const files = attachments.filter((attachment) => !isImage(attachment));
  const text = files.length
    ? `${input}\n\nAttached files:\n${files.map((file) => `- ${file.path}`).join('\n')}`
    : input;
  return [
    { type: 'text', text },
    ...attachments.filter(isImage).map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mime,
        data: readFileSync(image.source ?? image.path).toString('base64'),
      },
    })),
  ];
}

/** Token counts summed over every model; input_tokens includes cache reads and writes. */
interface TokenTotals {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
}

const isTokenTotals = (value: unknown): value is TokenTotals =>
  !!value &&
  typeof value === 'object' &&
  ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'].every(
    (key) => typeof (value as Record<string, unknown>)[key] === 'number',
  );

interface ClaudeQuery {
  abort: AbortController;
  stream: ReturnType<typeof query>;
  /** Queues a user message on the native input that lives as long as the query; returns its client uuid. */
  push: (content: UserContent) => string;
  /** Client uuids submitted to this query, so late results can be identified across turns. */
  sent: Set<string>;
  /** Drops the queued messages the SDK has not read yet; returns their client uuids. */
  discard: () => string[];
  end: () => void;
  /** A resumed query's first result carries the cost of the earlier queries. */
  resumed: boolean;
  /** total_cost_usd of the latest result; the SDK reports it cumulatively per query. */
  cost?: number;
  /** modelUsage totals of the latest result, cumulative per query like cost. */
  tokens?: TokenTotals;
  reading: boolean;
  historyMessage?: { uuid: string; before?: string };
  /** Live background tasks of this CLI process that are activity, by task id; their end starts a native turn. */
  background: Map<string, BackgroundTask>;
  /** The inherited overrides with the user-level items the project has not opened disabled. */
  overrides?: ExtensionOverrides;
  configuredSkills?: {
    allowlist: string[];
    denied: string[];
    source: 'sdk_options_and_permission_rules';
  };
}

interface ClaudeProcess {
  child: ChildProcessWithoutNullStreams;
  identity?: ProcessIdentity;
  exited: Promise<void>;
  exit?: NonNullable<CancelReceipt['evidence']['exits']>[number];
  /** The group was seen empty; its id may now belong to another process, so it is never signalled. */
  groupEmpty?: boolean;
  /** Set when the CLI runs on another device; stopped as groupEmpty is. */
  device?: DeviceProcess;
  /** Its descendants a stop saw while it ran and has not yet seen gone; some may have left its group. */
  descendants?: LeftoverProcess[];
  /**
   * The members of the group a stop left running: once the CLI exits, the group may empty and its
   * number pass to another group, so a later stop signals it only while one of them is still in it.
   */
  members?: ProcessIdentity[];
}

const groupsObserved = process.platform !== 'win32';

/** Whether the process group the CLI leads still has members. */
function groupAlive(owned: ClaudeProcess): boolean {
  if (!groupsObserved || !owned.identity || owned.groupEmpty) return false;
  try {
    process.kill(-owned.identity.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
    owned.groupEmpty = true;
    return false;
  }
}

async function stoppedProcesses(
  processes: ClaudeProcess[],
  deadline: number,
): Promise<CancelReceipt> {
  let timer: NodeJS.Timeout | undefined;
  const pending = processes.filter((owned) => owned.identity && !owned.exit);
  // Read before any wait: once the CLI exits, a tool that left its group has no parent chain to it.
  if (groupsObserved)
    for (const owned of pending)
      if (!owned.device)
        owned.descendants = mergeProcesses(
          owned.descendants ?? [],
          descendants(owned.identity!.pid),
        );
  if (pending.length && Date.now() < deadline) {
    try {
      await Promise.race([
        Promise.all(pending.map((owned) => owned.exited)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const foreign = new Set(
    processes.filter(
      (owned) =>
        owned.exit &&
        owned.members &&
        groupAlive(owned) &&
        !groupHolds(owned.identity!.pid, owned.members),
    ),
  );
  // Tools the CLI started can outlive it in its group.
  const left = () =>
    processes.filter((owned) => owned.exit && !foreign.has(owned) && groupAlive(owned));
  const signals: NonNullable<CancelReceipt['evidence']['signals']> = [];
  const signal = (name: NodeJS.Signals) => {
    for (const { identity } of left())
      try {
        process.kill(-identity!.pid, name);
        signals.push({ pid: identity!.pid, signal: name, at: new Date().toISOString() });
      } catch {
        // The group emptied in the meantime.
      }
  };
  if (left().length) {
    signal('SIGTERM');
    const forceAt = Date.now() + Math.min(2000, Math.max(0, (deadline - Date.now()) / 2));
    let forced = false;
    while (left().length && Date.now() < deadline) {
      if (!forced && Date.now() >= forceAt) {
        signal('SIGKILL');
        forced = true;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(10, deadline - Date.now()))),
      );
    }
  }
  for (const owned of processes)
    if (!foreign.has(owned) && groupAlive(owned)) {
      const members = groupMembers(owned.identity!.pid);
      if (members?.length) owned.members = members;
    }
  const members = processes.flatMap((owned) => (owned.identity ? [owned.identity] : []));
  const exits = processes.flatMap((owned) => (owned.exit ? [owned.exit] : []));
  const exited = processes.length > 0 && exits.length === members.length;
  let unconfirmed: string | undefined;
  for (const { device } of processes)
    if (device && !device.stopped) {
      const reason = await stopOnDevice(device, deadline);
      device.stopped = reason === undefined;
      unconfirmed ??= reason;
    }
  // Once its group is empty, a descendant still running left the group; it is reported, never signalled.
  for (const owned of processes) owned.descendants = owned.descendants?.filter(descendantRuns);
  const escaped = processes.some((owned) => owned.descendants?.length);
  const stopped =
    exited && !left().length && !foreign.size && unconfirmed === undefined && !escaped;
  return {
    stopped,
    deadline,
    finished_at: new Date().toISOString(),
    evidence: {
      method: groupsObserved && members.length ? 'process_group' : 'none',
      members,
      ...(members.length ? { exits } : {}),
      ...(signals.length ? { signals } : {}),
    },
    ...(stopped
      ? {}
      : {
          reason: exited
            ? (unconfirmed ??
              (foreign.size
                ? 'Process group number may now belong to another process group'
                : left().length
                  ? 'Process group still has members after the deadline'
                  : 'Descendants that left the process group are still running'))
            : processes.length
              ? 'Child exit not observed by deadline'
              : 'No owned child process was observed',
        }),
  };
}

interface ClaudeSession {
  spec: SessionSpec;
  subagents: { launches: number };
  emit: AgentEventSink;
  sequence: number;
  started: boolean;
  extensionsApplied: boolean;
  authChecked: boolean;
  processes: ClaudeProcess[];
  prepared?: ClaudeQuery;
  /** The fast mode state and reason of the last event; status and result messages repeat them. */
  fastModeSeen?: string;
  /** Totals of the native session's latest result; a resumed query starts from them. */
  costBaseline?: { native_session_id: string; total_cost_usd: number; tokens?: TokenTotals };
  /** Claude Code names this new session itself; input is its first message until the title is read. */
  autoTitle?: { input?: string };
  /** The window and auto-compact threshold the last turn reported for the current model. */
  contextLimits?: { window?: number; autoCompactAtTokens?: number };
  /** MCP tools with a ui:// interface, by their mcp__server__tool name, as of the latest init. */
  appTools: Map<string, { server: string; resource_uri: string; visibility?: string[] }>;
  /** The MCP servers the CLI last reported for this session. */
  mcpServers?: McpServerStatus[];
  state: NativeStatus['state'];
  turn?: {
    id: string;
    compact?: true;
    historyEnd?: string;
    autoCompactAtTokens?: number;
    /** The user turn allows only reads, read-only commands and Pantheon tools. */
    readOnly: boolean;
    permissions: Map<
      string,
      (
        decision: PermissionDecision,
        answers?: Record<string, string>,
        reason?: string,
        cancelled?: boolean,
      ) => void
    >;
    /** Stops the wall clock while a permission request waits; restarting it keeps the time left. */
    pauseClock: (paused: boolean) => void;
    abort: AbortController;
    /** Every client uuid sent for this turn, including sends earlier results already answered. */
    sent: Set<string>;
    /** Client uuids of this turn's sends that no result has echoed yet. */
    unanswered: Set<string>;
    /** The user interrupted this turn; its next result ends it. */
    interrupted?: boolean;
    /** Ends a turn whose last result came while only background tasks kept it open. */
    release?: () => void;
    /** What fills the context window, read when the turn's last result arrived. */
    context?: ContextBreakdown;
    /** Usage of this turn's results so far; finish reports it whichever way the turn ends. */
    usage?: {
      tokens: TokenTotals;
      /** A resumed query's first result carried tokens of earlier queries. */
      tokensCarried: boolean;
      cost_usd: number;
      carried: boolean;
      context_tokens?: number;
      context_window?: number;
    };
    finish: (
      status: 'completed' | 'interrupted' | 'failed',
      error?: string,
      native_type?: string,
      error_code?: string,
      resets_at?: number,
    ) => void;
  };
}

/** Where a native session's last query total is kept; the folder is shared by a project's sessions. */
const costFile = (dir: string, native_session_id: string): string | undefined =>
  /^[A-Za-z0-9_-]+$/.test(native_session_id)
    ? path.join(dir, `.pantheon-claude-cost-${native_session_id}.json`)
    : undefined;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The MCP tools whose _meta declares a ui:// interface; the object key wins over the flat one. */
function appTools(
  servers: Awaited<ReturnType<ClaudeQuery['stream']['mcpServerStatus']>>,
): ClaudeSession['appTools'] {
  const tools: ClaudeSession['appTools'] = new Map();
  for (const server of servers)
    for (const tool of server.tools ?? []) {
      const ui = isObject(tool._meta?.ui) ? tool._meta.ui : undefined;
      const uri =
        typeof ui?.resourceUri === 'string' ? ui.resourceUri : tool._meta?.['ui/resourceUri'];
      if (typeof uri !== 'string' || !uri.startsWith('ui://')) continue;
      tools.set(`mcp__${server.name}__${tool.name}`, {
        server: server.name,
        resource_uri: uri,
        ...(Array.isArray(ui?.visibility)
          ? { visibility: ui.visibility.filter((item) => typeof item === 'string') }
          : {}),
      });
    }
  return tools;
}

const APP_RESULT_LIMIT = 1_048_576;

/** The MCP CallToolResult an interface receives; absent when even its content is too long. */
function appResult(
  block: { content?: unknown; is_error?: boolean },
  toolUseResult: unknown,
): NonNullable<Extract<AgentEvent, { kind: 'tool.completed' }>['app_result']> | undefined {
  const full =
    isObject(toolUseResult) && ('content' in toolUseResult || 'structuredContent' in toolUseResult)
      ? toolUseResult
      : undefined;
  const content = Array.isArray(full?.content)
    ? full.content
    : typeof block.content === 'string'
      ? [{ type: 'text', text: block.content }]
      : Array.isArray(block.content)
        ? block.content
        : [];
  const base = { content, ...(block.is_error !== undefined ? { isError: block.is_error } : {}) };
  const result = {
    ...base,
    ...(full?.structuredContent !== undefined ? { structuredContent: full.structuredContent } : {}),
    ...(isObject(full?._meta) ? { _meta: full._meta } : {}),
  };
  if (JSON.stringify(result).length <= APP_RESULT_LIMIT) return result;
  return JSON.stringify(base).length <= APP_RESULT_LIMIT ? base : undefined;
}

/** The page an Artifact call published; its other actions (list, read, assets) return no page. */
function publishedArtifact(
  toolUseResult: unknown,
): Extract<AgentEvent, { kind: 'tool.completed' }>['artifact'] {
  if (
    !isObject(toolUseResult) ||
    typeof toolUseResult.url !== 'string' ||
    typeof toolUseResult.path !== 'string'
  )
    return undefined;
  const { title, version } = toolUseResult;
  return {
    url: toolUseResult.url,
    path: toolUseResult.path,
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof version === 'string' ? { version } : {}),
  };
}

/** The session's next send resumes the native session in a new query. */
function closeQuery(session: ClaudeSession, prepared: ClaudeQuery): void {
  if (session.prepared === prepared) session.prepared = undefined;
  prepared.end();
  try {
    prepared.stream.close();
  } catch {
    // SDK errors can contain private account/configuration data.
  }
}

/**
 * Reads the title Claude Code generated for the session, or generates and saves one; it never
 * replaces a title the user gave. The SDK runtime has this method but does not declare it.
 */
async function readTitle(
  session: ClaudeSession,
  stream: ReturnType<typeof query>,
  description: string,
): Promise<void> {
  try {
    const title = await (
      stream as unknown as {
        generateSessionTitle(
          description: string,
          options: { persist: boolean },
        ): Promise<string | null | undefined>;
      }
    ).generateSessionTitle(description, { persist: true });
    if (!title?.trim()) return;
    session.emit({
      key: String(++session.sequence),
      provider_sequence: session.sequence,
      kind: 'title.generated',
      title,
    });
  } catch (error) {
    console.warn(
      'Claude session title was not read:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** A session's turn does not wait longer than this for the CLI to report its account. */
const ACCOUNT_CHECK_MS = 30_000;
const DEVICE_PATH_MS = 10_000;

// Each of these replaces the permissions, settings, tools, MCP servers, folders, session, model,
// turn limit or stream format Pantheon gives the CLI.
const REFUSED_ARGS = new Set([
  'dangerously-skip-permissions',
  'allow-dangerously-skip-permissions',
  'permission-mode',
  'permission-prompt-tool',
  'permission-prompts',
  'settings',
  'setting-sources',
  'managed-settings',
  'project-config-root',
  'mcp-config',
  'strict-mcp-config',
  'allowed-tools',
  'allowedTools',
  'disallowedTools',
  'disallowed-tools',
  'tools',
  'model',
  'effort',
  'max-turns',
  'add-dir',
  'resume',
  'continue',
  'session-id',
  'fork-session',
  'resume-session-at',
  'resume-drops-turn',
  'no-session-persistence',
  'input-format',
  'output-format',
]);

/**
 * The transport command that runs the SDK's Claude on the device, without the local allowlisted
 * variables; a variable the session's own `env` names stays.
 */
function deviceLaunch(
  remote: RemoteLaunch,
  options: SpawnOptions,
  allowlist?: readonly string[],
  env: Record<string, string> = {},
): { command: string; args: string[] } {
  const local = nativeEnvironment(allowlist);
  return remoteSpawn(
    remote,
    options.command,
    options.args,
    options.cwd,
    Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] =>
          (entry[0] in env || !(entry[0] in local)) && entry[1] !== undefined,
      ),
    ),
  );
}

/**
 * `--flag value` becomes { flag: value } and a bare `--flag` becomes { flag: null }. The SDK takes
 * one value per key, so a repeated flag's later values become `--flag=value` keys; a value given
 * again moves its key last, since the CLI keeps a single-value flag's last value.
 */
function extraArgs(args: readonly string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const set = (flag: string, value: string | null) => {
    if (!Object.hasOwn(result, flag)) result[flag] = value;
    else if (value !== null) {
      delete result[`${flag}=${value}`];
      result[`${flag}=${value}`] = null;
    }
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('--') || arg === '--')
      throw new DomainError('invalid_user_config', `Claude argument ${arg} is not a --flag`);
    const [flag = '', inline] = arg.slice(2).split(/=(.*)/s);
    if (REFUSED_ARGS.has(flag))
      throw new DomainError('invalid_user_config', `Claude argument --${flag} is not allowed`);
    const next = args[index + 1];
    if (inline !== undefined) set(flag, inline);
    else if (next !== undefined && !next.startsWith('-')) {
      set(flag, next);
      index++;
    } else set(flag, null);
  }
  return result;
}

type AccountCheck =
  { state: 'ok'; plan?: string } | { state: 'logged_out' | 'unsupported_channel'; reason: string };

/** Whether the account the CLI reports runs on a claude.ai subscription, or on the backend key. */
function checkAccount(account: AccountInfo | undefined, backend: boolean): AccountCheck {
  if (!account) return { state: 'logged_out', reason: 'Unverified account channel' };
  if (account.apiKeySource) return { state: 'unsupported_channel', reason: 'API key channel' };
  if (account.apiProvider !== 'firstParty')
    return { state: 'unsupported_channel', reason: 'Non-first-party provider' };
  if (backend) {
    // The backend key reaches the CLI as ANTHROPIC_AUTH_TOKEN, which it reports as the token source.
    if (account.tokenSource !== 'ANTHROPIC_AUTH_TOKEN')
      return { state: 'unsupported_channel', reason: 'Account does not use the backend key' };
    return { state: 'ok' };
  }
  // The CLI sets tokenSource only for non-claude.ai sources (environment OAuth tokens and
  // similar); a claude.ai subscription login reports subscriptionType instead.
  if (account.tokenSource !== undefined)
    return {
      state: account.tokenSource === 'none' ? 'logged_out' : 'unsupported_channel',
      reason: 'Non-claude.ai token source',
    };
  if (typeof account.subscriptionType !== 'string')
    return { state: 'unsupported_channel', reason: 'No claude.ai subscription' };
  return { state: 'ok', plan: account.subscriptionType };
}

const OWN_CAPABILITIES: Record<string, Capability> = {
  conversation_rollback: {
    status: 'supported',
    evidence:
      'Agent SDK Options.resumeSessionAt with resume and forkSession resumes through an exact message UUID; not live-verified',
  },
  fork_within_turn: {
    status: 'supported',
    evidence:
      'Agent SDK resumeSessionAt accepts chain-entry UUIDs inside a turn; not live-verified',
  },
  manual_compaction: {
    status: 'supported',
    evidence:
      'The SDK accepts /compact with optional instructions as a query prompt; not live-verified',
  },
  compaction_instructions: {
    status: 'supported',
    evidence: 'The text after /compact is the instructions; not live-verified',
  },
  turn_write_unlock: {
    status: 'supported',
    evidence:
      'setTurnReadOnly changes the read-only flag that canUseTool reads on each tool call of the running turn',
  },
  turn_model_change: {
    status: 'supported',
    evidence: 'setModel sets the model of the running SDK query',
  },
};

export class ClaudeAdapter implements HarnessAdapter {
  name = 'claude';
  backendProtocols = ['anthropic'] as const;
  questionTool = 'AskUserQuestion';
  generatesTitles = true;
  report: CapabilityReport;
  private sessions = new WeakMap<SessionHandle, ClaudeSession>();
  private readonly extraArgs: Record<string, string | null>;
  private readonly artifacts: boolean;
  constructor(
    readonly binary = 'claude',
    version = 'unprobed',
    private readonly queryFn: typeof query = query,
    options: { args?: string[]; artifacts?: boolean } = {},
  ) {
    this.extraArgs = extraArgs(options.args ?? []);
    this.artifacts = options.artifacts ?? true;
    this.report = report('claude', version, false, OWN_CAPABILITIES);
  }
  async probe() {
    return this.report;
  }
  async reconnect(): Promise<void> {
    const found = await this.preflight();
    if (!found.installed || found.error || found.auth.reason === 'timeout')
      throw new Error(found.error ?? found.auth.reason ?? 'Claude runtime could not start');
  }
  async mcpStatus(cwd: string, handle?: SessionHandle): Promise<McpServerStatus[]> {
    const session = handle ? this.sessions.get(handle) : undefined;
    const live = session?.prepared?.stream;
    // A local probe would start servers the session does not have, outside its sandbox and device.
    if (handle && !live) return session?.mcpServers ?? [];
    let closeInput!: () => void;
    const closed = new Promise<void>((resolve) => {
      closeInput = resolve;
    });
    const stream =
      live ??
      this.queryFn({
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await closed;
        })(),
        options: buildClaudeOptions(
          {
            cwd,
            extensions: {
              mode: 'inherit',
              overrides: {
                disabled_mcp_servers: [],
                disabled_plugins: [],
                disabled_skills: [],
                disable_apps: false,
                disable_hooks: true,
              },
            },
            budget: { max_turns: 1, wall_time_ms: 10000 },
          },
          {
            pathToClaudeCodeExecutable: this.binary,
            env: nativeEnvironment(),
            extraArgs: this.extraArgs,
          },
        ),
      });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          await stream.initializationResult();
          const servers = (await stream.mcpServerStatus()).map((server) => ({
            name: server.name,
            state: server.status === 'needs-auth' ? ('needs_sign_in' as const) : server.status,
          }));
          if (session) session.mcpServers = servers;
          return servers;
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Claude MCP status deadline exceeded')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      closeInput();
      if (!live) stream.close();
    }
  }
  async readMcpResource(
    handle: SessionHandle,
    server: string,
    uri: string,
  ): Promise<McpResourceContents> {
    const stream = this.sessions.get(handle)?.prepared?.stream;
    if (!stream) throw new Error('Claude session has no live query');
    return stream.readMcpResource(server, uri);
  }
  async preflight(): Promise<Preflight> {
    let version: string;
    try {
      version = await readVersion(this.binary);
    } catch (error) {
      if (this.report.version !== 'unprobed')
        this.report = report('claude', 'unprobed', false, OWN_CAPABILITIES);
      return notInstalled(MIN_VERSIONS.claude, error);
    }
    if (this.report.version !== version)
      this.report = report('claude', version, false, OWN_CAPABILITIES);
    const installed = installedFields(version, MIN_VERSIONS.claude);
    let closeInput!: () => void;
    const closed = new Promise<void>((resolve) => {
      closeInput = resolve;
    });
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      await closed;
    })();
    let stream: ReturnType<typeof query> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      stream = this.queryFn({
        prompt,
        options: buildClaudeOptions(
          {
            cwd: os.tmpdir(),
            extensions: {
              mode: 'inherit',
              overrides: {
                disabled_mcp_servers: [],
                disabled_plugins: [],
                disabled_skills: [],
                disable_apps: false,
                disable_hooks: true,
              },
            },
            budget: { max_turns: 1, wall_time_ms: 15000 },
          },
          {
            pathToClaudeCodeExecutable: this.binary,
            env: nativeEnvironment(),
            extraArgs: this.extraArgs,
          },
        ),
      });
      const initialized = await Promise.race([
        stream.initializationResult(),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), 15000);
        }),
      ]);
      if (initialized === 'timeout')
        return { ...installed, auth: { state: 'unknown', reason: 'timeout' } };
      const account = initialized?.account;
      const checked = checkAccount(account, false);
      return {
        ...installed,
        auth:
          checked.state === 'ok'
            ? {
                state: 'ok',
                ...(account?.email ? { email: account.email } : {}),
                ...(checked.plan !== undefined ? { plan: checked.plan } : {}),
              }
            : checked,
      };
    } catch (error) {
      return {
        ...installed,
        auth: { state: 'unknown' },
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
      closeInput();
      stream?.close();
    }
  }
  /** A session's overrides keep the servers, plugins and apps it disables from starting for discovery. */
  async inventory(
    cwd: string,
    session?: ExtensionOverrides,
    remote?: RemoteLaunch,
  ): Promise<ExtensionInventory> {
    let closeInput!: () => void;
    const closed = new Promise<void>((resolve) => {
      closeInput = resolve;
    });
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      await closed;
    })();
    let stream: ReturnType<typeof query> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      stream = this.queryFn({
        prompt,
        options: {
          ...buildClaudeOptions(
            {
              cwd,
              extensions: {
                mode: 'inherit',
                overrides: {
                  disabled_mcp_servers: session?.disabled_mcp_servers ?? [],
                  disabled_plugins: session?.disabled_plugins ?? [],
                  disabled_skills: [],
                  disable_apps: session?.disable_apps ?? false,
                  disable_hooks: true,
                },
              },
              budget: { max_turns: 1, wall_time_ms: 10000 },
            },
            {
              pathToClaudeCodeExecutable: remote?.binary ?? this.binary,
              env: remote ? {} : nativeEnvironment(),
              extraArgs: this.extraArgs,
              ...(remote
                ? {
                    spawnClaudeCodeProcess: (options: SpawnOptions) => {
                      const launch = deviceLaunch(
                        { ...remote, transport: remote.plain_transport ?? remote.transport },
                        options,
                      );
                      const child = spawn(launch.command, launch.args, {
                        env: transportEnvironment(NATIVE_ENV_ALLOWLIST),
                        signal: options.signal,
                        windowsHide: true,
                        stdio: ['pipe', 'pipe', 'pipe'],
                      });
                      child.stderr.resume();
                      child.stderr.on('error', () => {});
                      return child;
                    },
                  }
                : {}),
            },
          ),
          // Without the Skill tool the CLI leaves skills out of the context breakdown read below.
          tools: ['Skill'],
        },
      });
      const result = (async () => {
        await stream!.initializationResult();
        const plugins = await stream!.reloadPlugins();
        const [servers, skills, settings, usage] = await Promise.all([
          stream!.mcpServerStatus(),
          stream!.supportedCommands(),
          // The settings files of a device session are on the device.
          remote
            ? undefined
            : resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] }),
          // Only the context breakdown says which skills come from the user's own settings.
          stream!.getContextUsage({ detail: 'summary' }),
        ]);
        const connector = (server: (typeof servers)[number]) =>
          server.source === 'claudeai' || server.scope === 'claudeai';
        const userSkills = new Set(
          (usage.skills?.skillFrontmatter ?? [])
            .filter((skill) => skill.source === 'userSettings')
            .map((skill) => skill.name),
        );
        // Project only identifiers; never return config, descriptions, paths or errors from the SDK.
        return {
          runtime: this.name,
          mcp_servers: servers
            .filter((server) => !connector(server))
            .map((server) => ({
              name: server.name,
              enabled: server.status !== 'disabled',
              // Local scope is the user's own entry for this folder in ~/.claude.json.
              ...(server.scope === 'user' || server.scope === 'local' ? { user: true } : {}),
            })),
          plugins: plugins.plugins.flatMap((plugin) =>
            plugin.source ? [{ id: plugin.source, enabled: true }] : [],
          ),
          skills: skills
            .filter((skill) => !skill.builtin)
            .map((skill) => ({
              id: skill.name,
              name: skill.name,
              enabled: true,
              ...(userSkills.has(skill.name) ? { user: true } : {}),
            })),
          apps: servers.some((server) => server.status !== 'disabled' && connector(server)),
          connectors: servers
            .filter(connector)
            .map((server) => ({ name: server.name, enabled: server.status !== 'disabled' })),
          // Query has no public hook-list API. The discovery session disables user hooks.
          hooks: [],
          ...(typeof settings?.effective.disableAllHooks === 'boolean'
            ? { hooks_enabled: !settings.effective.disableAllHooks }
            : {}),
        };
      })();
      return await Promise.race([
        result,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Inventory deadline exceeded')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      closeInput();
      stream?.close();
    }
  }
  async models(cwd: string): Promise<RuntimeModel[]> {
    let closeInput!: () => void;
    const closed = new Promise<void>((resolve) => {
      closeInput = resolve;
    });
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      await closed;
    })();
    let stream: ReturnType<typeof query> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      stream = this.queryFn({
        prompt,
        options: buildClaudeOptions(
          {
            cwd,
            extensions: {
              mode: 'inherit',
              overrides: {
                disabled_mcp_servers: [],
                disabled_plugins: [],
                disabled_skills: [],
                disable_apps: false,
                disable_hooks: true,
              },
            },
            budget: { max_turns: 1, wall_time_ms: 10000 },
          },
          {
            pathToClaudeCodeExecutable: this.binary,
            env: nativeEnvironment(),
            extraArgs: this.extraArgs,
          },
        ),
      });
      const result = (async () => {
        await stream!.initializationResult();
        // Query's types leave out getSettings, which the SDK has; applied is what the next request sends.
        const [listed, settings] = await Promise.all([
          stream!.supportedModels(),
          (
            stream as unknown as {
              getSettings(): Promise<{
                applied: { model: string | null; effort: ClaudeEffortLevel | null };
              }>;
            }
          ).getSettings(),
        ]);
        const { applied } = settings;
        // ModelInfo names neither a default model nor a default effort; the SDK's default row is 'default'.
        return listed.map<RuntimeModel>((model) => ({
          id: model.value,
          label: model.displayName,
          ...(model.description ? { description: model.description } : {}),
          permission_modes: [
            'plan',
            'ask',
            'auto_edit',
            ...(model.supportsAutoMode ? ['auto' as const] : []),
            'full_access',
          ],
          ...(model.supportsFastMode ? { fast: true as const } : {}),
          efforts: model.supportedEffortLevels ?? [],
          // A session that names no effort runs with the user's settings effort for its model.
          default_effort:
            model.resolvedModel !== undefined && model.resolvedModel === applied.model
              ? applied.effort
              : null,
          default: model.value === 'default',
          ...(model.resolvedModel ? { resolved: model.resolvedModel } : {}),
        }));
      })();
      return await Promise.race([
        result,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Model list deadline exceeded')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      closeInput();
      stream?.close();
    }
  }
  async start(spec: SessionSpec, emit: AgentEventSink): Promise<SessionHandle> {
    return this.resume(spec, '', emit);
  }
  private async prepareQuery(
    session: ClaudeSession,
    handle: SessionHandle,
    abort = new AbortController(),
  ): Promise<ClaudeQuery> {
    const spec = session.spec;
    const mounted =
      spec.remote &&
      spec.sandbox &&
      (spec.sandbox.protected_entries.length || spec.extensions?.mode === 'inherit')
        ? await deviceSandbox(spec, spec.remote, spec.sandbox)
        : undefined;
    // A user session has no Pantheon sandbox for its settings to widen.
    if (!spec.remote && spec.sandbox && spec.extensions?.mode === 'inherit' && !spec.user_session) {
      await refuseInheritedReadAllows(spec.cwd, spec.sandbox);
      await refuseInheritedWriteAllows(spec.cwd, spec.sandbox);
    }
    const inherited = spec.extensions?.mode === 'inherit' ? spec.extensions.overrides : undefined;
    const connectorsOpened =
      !!inherited && !inherited.disable_apps && !!inherited.enabled_user_connectors?.length;
    // A managed configuration folder holds only the user-level MCP servers and skills the project
    // opened; a device session runs on the device's own configuration.
    const projected = !!spec.native_state_dir && !spec.remote;
    const listing =
      inherited &&
      (connectorsOpened ||
        (!projected &&
          (inherited.disabled_skills.length ||
            inherited.enabled_user_mcp_servers ||
            inherited.enabled_user_skills)));
    // The listing starts every server it does not deny, and the user's own ones run unsandboxed.
    const probed =
      inherited && !projected && !spec.remote
        ? closeUserExtensions(inherited, {
            mcp_servers: homeExtensions(spec.cwd, spec.user_config_dir).mcp_servers,
            skills: [],
          })
        : inherited;
    // Every query lists again: the user may have added a server since the last one.
    const listed = listing
      ? await this.inventory(spec.cwd, probed, spec.remote).catch((error) => {
          // Without a listing the user-level items of a session with no managed folder would
          // stay open, so it does not start.
          if (!projected) throw error;
          console.warn(
            'Claude extensions were not listed:',
            error instanceof Error ? error.message : String(error),
          );
          return undefined;
        })
      : undefined;
    // Sessions of the project share the managed folder and rewrite it, so it is not the only filter.
    const closed =
      inherited &&
      (projected
        ? closeUserExtensions(inherited, homeExtensions(spec.cwd, spec.user_config_dir))
        : listed
          ? closeUserExtensions(probed!, listed)
          : inherited);
    const overrides =
      closed &&
      (connectorsOpened && !listed
        ? { ...closed, disable_apps: true }
        : closeConnectors(closed, listed?.connectors ?? []));
    const listedSkills = listed?.skills.map((skill) => skill.id);
    const resumed = !!handle.native_session_id || !!spec.native_fork;
    const inputs: { content: UserContent; uuid: UUID }[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    const push = (content: UserContent) => {
      const uuid = randomUUID();
      inputs.push({ content, uuid });
      wake?.();
      return uuid;
    };
    const end = () => {
      ended = true;
      wake?.();
    };
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (inputs.length && !abort.signal.aborted) {
          const { content, uuid } = inputs.shift()!;
          yield {
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
            uuid,
            session_id: handle.native_session_id,
          };
        }
        if (ended || abort.signal.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    })();
    let stream: ReturnType<typeof query> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: () => void = () => {};
    // The SDK leaves the Artifact tool off; a session without a backend runs on a claude.ai
    // subscription, the only account that can publish, or fails its account check.
    const artifactEnv: Record<string, string> =
      this.artifacts && !spec.backend ? { CLAUDE_CODE_ARTIFACT: '1' } : {};
    try {
      if (abort.signal.aborted) throw new DomainError('query_aborted', 'Query aborted');
      stream = this.queryFn({
        prompt,
        options: buildClaudeOptions(
          {
            ...spec,
            native_title: handle.native_title,
            ...(overrides ? { extensions: { mode: 'inherit' as const, overrides } } : {}),
          },
          {
            pathToClaudeCodeExecutable: spec.remote?.binary ?? this.binary,
            env: spec.remote
              ? { ...spec.env, ...artifactEnv }
              : {
                  ...spec.env,
                  ...nativeEnvironment(spec.env_allowlist),
                  ...(spec.env?.TMPDIR ? { TMPDIR: spec.env.TMPDIR } : {}),
                  ...prepareNativeState('claude', spec).env,
                  ...(spec.backend
                    ? {
                        ANTHROPIC_BASE_URL: spec.backend.base_url,
                        ANTHROPIC_AUTH_TOKEN: spec.backend.api_key,
                      }
                    : {}),
                  ...artifactEnv,
                },
            resume: spec.native_fork?.session_id ?? (handle.native_session_id || undefined),
            ...(spec.native_fork
              ? { resumeSessionAt: spec.native_fork.after, forkSession: true }
              : {}),
            abortController: abort,
            extraArgs: this.extraArgs,
            spawnClaudeCodeProcess: (options) => {
              const launch = spec.remote
                ? deviceLaunch(spec.remote, options, spec.env_allowlist, {
                    ...spec.env,
                    ...artifactEnv,
                  })
                : undefined;
              const child = spawn(
                launch?.command ?? options.command,
                launch?.args ?? options.args,
                {
                  cwd: launch ? undefined : options.cwd,
                  env: launch ? transportEnvironment(spec.env_allowlist) : options.env,
                  signal: options.signal,
                  // Its own process group holds the tools it starts, so a stop can find them.
                  detached: groupsObserved,
                  windowsHide: true,
                  stdio: ['pipe', 'pipe', 'pipe'],
                },
              );
              child.stderr.resume();
              child.stderr.on('error', () => {});
              const owned: ClaudeProcess = { child, exited: Promise.resolve() };
              owned.exited = new Promise<void>((resolve) => {
                child.once('exit', (code, signal) => {
                  if (child.pid) owned.exit = { pid: child.pid, code, signal };
                  // Looked at now, before an empty group's id can pass to another process.
                  groupAlive(owned);
                  if (!ended && !abort.signal.aborted && session.prepared?.abort === abort) {
                    const reason = `Claude runtime connection lost: process exited (${signal ?? code})`;
                    session.state = 'exited';
                    session.emit({
                      key: String(++session.sequence),
                      provider_sequence: session.sequence,
                      kind: 'runtime.disconnected',
                      reason,
                    });
                    session.turn?.finish('failed', reason);
                  }
                  resolve();
                });
                child.once('error', () => {
                  if (!child.pid) resolve();
                });
              });
              if (launch)
                owned.device = {
                  remote: spec.remote!,
                  group: deviceGroupOf(child),
                  allowlist: spec.env_allowlist,
                };
              session.processes.push(owned);
              if (child.pid) {
                owned.identity = processIdentity(child.pid);
                handle.process_identity = owned.identity;
              }
              return child;
            },
          },
          listedSkills,
          async (tool, input, options) => {
            const turn = session.turn;
            if (!turn || abort.signal.aborted || options.signal.aborted)
              return { behavior: 'deny', message: 'Tool request has no active turn' };
            const request_id = id();
            return new Promise((resolve) => {
              const onAbort = () => answer('deny', undefined, undefined, true);
              const answer = (
                decision: PermissionDecision,
                answers?: Record<string, string>,
                reason?: string,
                cancelled?: boolean,
              ) => {
                if (!turn.permissions.delete(request_id)) return;
                if (!turn.permissions.size) turn.pauseClock(false);
                abort.signal.removeEventListener('abort', onAbort);
                options.signal.removeEventListener('abort', onAbort);
                const settle = (denial: string | undefined) => {
                  if (denial) decision = 'deny';
                  if (decision === 'allow_session') {
                    const rule = permissionRule(tool, input),
                      rules = session.spec.allowed_rules ?? [];
                    if (!rules.includes(rule))
                      session.spec = { ...session.spec, allowed_rules: [...rules, rule] };
                  }
                  session.emit({
                    key: String(++session.sequence),
                    provider_sequence: session.sequence,
                    turn_id: turn.id,
                    kind: 'permission.resolved',
                    request_id,
                    decision,
                    ...(cancelled ? { cancelled: true } : {}),
                  });
                  resolve(
                    decision === 'deny'
                      ? { behavior: 'deny', message: denial ?? reason ?? 'Tool request denied' }
                      : {
                          behavior: 'allow',
                          updatedInput: answers ? { questions: input.questions, answers } : input,
                        },
                  );
                };
                // The turn may have become read-only while approval was pending. Pantheon's own
                // ask tools are asked in read-only turns too, so they stay answerable.
                const pantheonTool =
                  options.mcpServer?.source === 'dynamic' &&
                  options.mcpServer.name === 'pantheon' &&
                  tool.startsWith('mcp__pantheon__');
                const readOnlyDenied = () =>
                  turn.readOnly &&
                  !pantheonTool &&
                  !['AskUserQuestion', 'ExitPlanMode'].includes(tool) &&
                  !(tool === 'Bash'
                    ? typeof input.command === 'string' && readOnlyBash(input.command, spec)
                    : READ_ONLY_TOOLS.has(tool));
                if (decision !== 'deny' && readOnlyDenied()) settle(READ_ONLY_DENIAL);
                // A symlink may have changed while approval was pending.
                else if (decision !== 'deny' && spec.remote)
                  void deviceToolDenial(spec, spec.remote, tool, input, spec.env_allowlist).then(
                    (denial) =>
                      settle(
                        denial ??
                          (session.turn !== turn
                            ? 'Tool request has no active turn'
                            : readOnlyDenied()
                              ? READ_ONLY_DENIAL
                              : undefined),
                      ),
                  );
                else settle(decision !== 'deny' ? toolDenial(spec, tool, input) : undefined);
              };
              turn.permissions.set(request_id, answer);
              if (turn.permissions.size === 1) turn.pauseClock(true);
              abort.signal.addEventListener('abort', onAbort, { once: true });
              options.signal.addEventListener('abort', onAbort, { once: true });
              session.emit({
                key: String(++session.sequence),
                provider_sequence: session.sequence,
                turn_id: turn.id,
                kind: 'permission.requested',
                request_id,
                tool,
                rule: permissionRule(tool, input),
                project_rule_supported: true,
                detail: {
                  input: tracePayload(input),
                  tool_call_id: options.toolUseID,
                  ...(tool === 'AskUserQuestion' && Array.isArray(input.questions)
                    ? { questions: askedQuestions(input.questions) }
                    : {}),
                },
              });
            });
          },
          () => session.spec.permission_mode,
          () => session.spec.allowed_rules,
          () => session.turn?.readOnly === true,
          () => !!session.turn && !abort.signal.aborted,
          session.subagents,
          mounted,
        ),
      });
      const initialized = await Promise.race([
        stream.initializationResult(),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new DomainError('query_aborted', 'Query aborted'));
          abort.signal.addEventListener('abort', onAbort, { once: true });
          if (abort.signal.aborted) onAbort();
          timer = setTimeout(
            () => reject(new DomainError('account_check_timeout', 'Account check timed out')),
            Math.min(spec.budget.wall_time_ms, ACCOUNT_CHECK_MS),
          );
        }),
      ]);
      const checked = checkAccount(initialized?.account, !!spec.backend);
      if (checked.state !== 'ok') throw new DomainError('billing_channel_mismatch', checked.reason);
      if (abort.signal.aborted) throw new DomainError('query_aborted', 'Query aborted');
      if (!spec.backend && !session.authChecked) {
        session.authChecked = true;
        session.emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          kind: 'auth.checked',
          channel: 'subscription',
          method: 'claude.ai',
          ...(checked.plan !== undefined ? { plan: checked.plan } : {}),
        });
      }
      return {
        abort,
        stream,
        overrides,
        push,
        sent: new Set(),
        discard: () => inputs.splice(0).map((input) => input.uuid),
        end,
        resumed,
        ...(resumed && session.costBaseline?.native_session_id === handle.native_session_id
          ? {
              cost: session.costBaseline.total_cost_usd,
              ...(session.costBaseline.tokens ? { tokens: session.costBaseline.tokens } : {}),
            }
          : {}),
        reading: false,
        background: new Map(),
        ...(overrides?.disabled_skills.length && listedSkills
          ? {
              configuredSkills: {
                allowlist: listedSkills.filter((name) => !overrides.disabled_skills.includes(name)),
                denied: overrides.disabled_skills.map((name) => `Skill(${name})`),
                source: 'sdk_options_and_permission_rules' as const,
              },
            }
          : {}),
      };
    } catch (error) {
      end();
      abort.abort();
      try {
        stream?.close();
      } catch {
        // The owned child exit remains the stop evidence if SDK cleanup fails.
      }
      if (!stream && !session.processes.length) throw error;
      for (const process of session.processes) if (!process.exit) process.child.stdin.end();
      const stop = await stoppedProcesses(session.processes, Date.now() + 10000);
      const failure = new SessionStartError(
        error instanceof Error ? error.message : String(error),
        stop,
      );
      if (error && typeof error === 'object' && 'code' in error)
        Object.assign(failure, { code: error.code });
      throw failure;
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
    }
  }
  async resume(
    spec: SessionSpec,
    native_session_id: string,
    emit: AgentEventSink,
  ): Promise<SessionHandle> {
    validateSessionSpec(spec, this.report.version);
    if (spec.effort && !isClaudeEffort(spec.effort))
      throw new DomainError('unsupported_effort', `Claude has no ${spec.effort} effort level`);
    const handle: SessionHandle = {
      platform_session_id: spec.platform_session_id,
      native_session_id,
      adapter_version: this.report.version,
      device_id: spec.device_id,
      requested_model: spec.model,
      requested_effort: spec.effort,
      native_state_dir: spec.native_state_dir,
      // A title option turns off the title Claude Code generates for a new session.
      native_title:
        spec.native_title || (!native_session_id && !spec.auto_title)
          ? nativeSessionTitle(spec)
          : undefined,
    };
    const session: ClaudeSession = {
      spec,
      subagents: { launches: 0 },
      emit,
      sequence: 0,
      started: false,
      extensionsApplied: false,
      authChecked: false,
      processes: [],
      ...(spec.auto_title && !native_session_id ? { autoTitle: {} } : {}),
      appTools: new Map(),
      state: 'idle',
    };
    const saved =
      !spec.native_fork &&
      spec.native_state_dir &&
      costFile(spec.native_state_dir, native_session_id);
    if (saved)
      try {
        const { total_cost_usd, tokens } = JSON.parse(readFileSync(saved, 'utf8'));
        if (typeof total_cost_usd === 'number')
          session.costBaseline = {
            native_session_id,
            total_cost_usd,
            ...(isTokenTotals(tokens) ? { tokens } : {}),
          };
      } catch {
        // Without a readable baseline the first resumed result reports an unknown cost.
      }
    session.prepared = await this.prepareQuery(session, handle);
    this.sessions.set(handle, session);
    return handle;
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
      session.state = 'unknown';
      current.abort.abort();
      if (session.prepared?.abort === current.abort) closeQuery(session, session.prepared);
      current.finish('failed', 'Claude turn deadline exceeded', undefined, 'turn_deadline');
    };
    const current: NonNullable<ClaudeSession['turn']> = {
      id: turn.turn_id,
      ...(turn.compact ? { compact: true as const } : {}),
      readOnly: turn.read_only === true,
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
      abort: session.prepared?.abort ?? new AbortController(),
      sent: new Set(),
      unanswered: new Set(),
      finish: (status, error, native_type, error_code, resets_at) => {
        if (session.turn !== current) return;
        clearTimeout(timer);
        session.turn = undefined;
        for (const answer of current.permissions.values())
          answer('deny', undefined, undefined, true);
        if (session.state === 'running') session.state = 'idle';
        const usage = current.usage;
        if (usage)
          session.contextLimits = {
            window: usage.context_window,
            autoCompactAtTokens: current.autoCompactAtTokens,
          };
        // The control layer keeps one usage record per user turn, so native turns are summed.
        if (usage)
          session.emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id: turn.turn_id,
            kind: 'usage.updated',
            ...(current.autoCompactAtTokens !== undefined
              ? { auto_compact_at_tokens: current.autoCompactAtTokens }
              : {}),
            ...(usage.tokensCarried ? {} : usage.tokens),
            context_tokens: usage.context_tokens,
            ...(usage.context_window !== undefined ? { context_window: usage.context_window } : {}),
            ...(current.context ? { context_breakdown: current.context } : {}),
            ...(usage.carried
              ? { cost_source: 'unknown' as const }
              : { cost_usd: usage.cost_usd, cost_source: 'estimated' as const }),
            native_type,
          });
        session.emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          turn_id: turn.turn_id,
          kind: 'turn.completed',
          ...(current.historyEnd ? { native_history_end: current.historyEnd } : {}),
          status,
          error,
          error_code,
          resets_at,
          native_type,
        });
      },
    };
    session.turn = current;
    timer = setTimeout(expire, left);
    void (async () => {
      try {
        const prepared =
          session.prepared ?? (await this.prepareQuery(session, handle, current.abort));
        if (session.turn !== current) {
          prepared.abort.abort();
          closeQuery(session, prepared);
          return;
        }
        session.prepared = prepared;
        const uuid = prepared.push(
          userContent(
            turn.compact
              ? { ...turn, input: turn.input ? `/compact ${turn.input}` : '/compact' }
              : turn,
          ),
        );
        prepared.historyMessage = { uuid };
        current.historyEnd = uuid;
        prepared.sent.add(uuid);
        current.sent.add(uuid);
        current.unanswered.add(uuid);
        if (!prepared.reading) {
          prepared.reading = true;
          void this.read(session, handle, prepared);
        }
      } catch (error) {
        if (session.state === 'running')
          session.emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            kind: 'runtime.disconnected',
            reason: `Claude runtime start failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        current.finish(
          'failed',
          error instanceof Error ? error.message : String(error),
          undefined,
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : undefined,
        );
      }
    })();
    return { turn_id: turn.turn_id, status: 'delivered' };
  }
  async steer(handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> {
    const session = this.sessions.get(handle);
    const prepared = session?.prepared;
    if (!session?.turn || !prepared || session.turn.abort !== prepared.abort)
      return {
        turn_id: turn.turn_id,
        status: 'queued',
        reason: 'No Claude turn is running in a live query',
      };
    if (session.turn.interrupted)
      return { turn_id: turn.turn_id, status: 'queued', reason: 'The Claude turn is interrupting' };
    const uuid = prepared.push(userContent(turn));
    prepared.sent.add(uuid);
    session.turn.sent.add(uuid);
    session.turn.unanswered.add(uuid);
    // Only a result answering the steer can end the turn now.
    session.turn.release = undefined;
    return { turn_id: turn.turn_id, status: 'delivered' };
  }
  async interrupt(handle: SessionHandle): Promise<Receipt> {
    const session = this.sessions.get(handle);
    const prepared = session?.prepared;
    const current = session?.turn;
    if (!current || !prepared?.reading || current.abort !== prepared.abort)
      return { ok: false, reason: 'No Claude turn is running in a live query' };
    current.interrupted = true;
    let receipt: { cancelled?: string[] } | undefined;
    try {
      // The SDK runtime takes cancelQueued; its declared signature has no parameter.
      receipt = await (
        prepared.stream as unknown as {
          interrupt(request: {
            cancelQueued: boolean;
          }): Promise<{ cancelled?: string[] } | undefined>;
        }
      ).interrupt({ cancelQueued: true });
    } catch (error) {
      current.interrupted = false;
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    for (const uuid of [...prepared.discard(), ...(receipt?.cancelled ?? [])])
      current.unanswered.delete(uuid);
    // Every send of the turn was dropped before it ran, so no result will end the turn.
    if (!current.unanswered.size) current.finish('interrupted');
    return { ok: true };
  }
  async setPermissionMode(
    handle: SessionHandle,
    mode: NonNullable<SessionSpec['permission_mode']>,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session) return { ok: false, reason: 'Unknown Claude session' };
    try {
      await session.prepared?.stream.setPermissionMode(NATIVE_PERMISSION_MODES[mode]);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    // A later query is built from the spec; the live query's canUseTool reads it on each call.
    session.spec = { ...session.spec, permission_mode: mode };
    return { ok: true };
  }
  async setFastMode(handle: SessionHandle, fast: boolean): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session) return { ok: false, reason: 'Unknown Claude session' };
    try {
      await session.prepared?.stream.applyFlagSettings({ fastMode: fast });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    session.spec = { ...session.spec, fast: fast ? true : undefined };
    return { ok: true };
  }
  async setUltracode(handle: SessionHandle, ultracode: boolean): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session) return { ok: false, reason: 'Unknown Claude session' };
    try {
      await session.prepared?.stream.applyFlagSettings({ ultracode });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    session.spec = { ...session.spec, ultracode: ultracode ? true : undefined };
    return { ok: true };
  }
  setTurnReadOnly(handle: SessionHandle, readOnly: boolean): void {
    const turn = this.sessions.get(handle)?.turn;
    if (turn) turn.readOnly = readOnly;
  }
  async setModel(
    handle: SessionHandle,
    model: string,
    effort: EffortLevel | undefined,
    fast?: boolean,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session) return { ok: false, reason: 'Unknown Claude session' };
    if (effort && !isClaudeEffort(effort))
      return { ok: false, reason: `Claude has no ${effort} effort level` };
    const prepared = session.prepared;
    let modelApplied = false;
    try {
      await prepared?.stream.setModel(model);
      modelApplied = !!prepared;
      // An effort change sent alone turns ultracode off.
      await prepared?.stream.applyFlagSettings({
        effortLevel: effort ?? null,
        ...(fast !== undefined ? { fastMode: fast } : {}),
        ...(session.spec.ultracode ? { ultracode: true } : {}),
      });
    } catch (error) {
      if (modelApplied && prepared)
        try {
          // Both settings must agree with the saved spec when the command is refused.
          await prepared.stream.setModel(session.spec.model);
          const previousEffort = session.spec.effort;
          await prepared.stream.applyFlagSettings({
            effortLevel: previousEffort && isClaudeEffort(previousEffort) ? previousEffort : null,
            ...(fast !== undefined ? { fastMode: session.spec.fast === true } : {}),
            ...(session.spec.ultracode ? { ultracode: true } : {}),
          });
        } catch {
          // The live configuration is now uncertain. Resume from the last saved spec rather
          // than allowing another turn to run on a model the UI says was not selected.
          const current = session.turn;
          prepared.abort.abort();
          closeQuery(session, prepared);
          if (current?.abort === prepared.abort)
            current.finish('failed', 'Claude model settings could not be restored');
        }
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
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
    session.contextLimits = undefined;
    return { ok: true };
  }
  /** Hands the messages of a long-lived query to whichever turn runs on it. */
  private async read(
    session: ClaudeSession,
    handle: SessionHandle,
    prepared: ClaudeQuery,
  ): Promise<void> {
    const spec = session.spec;
    const { stream } = prepared;
    const active = () =>
      session.prepared === prepared && session.turn?.abort === prepared.abort
        ? session.turn
        : undefined;
    // Main-agent messages whose text already arrived as stream deltas.
    const streamed = new Set<string>();
    // The sends the running native turn answers; the CLI names them only on some of its frames.
    let answering: string[] | undefined;
    const drawings = new Map<
      number,
      { tool_call_id: string; received_bytes: number; emitted_at: number }
    >();
    // Calls of tools with an interface whose result has not arrived.
    const appCalls = new Set<string>();
    const artifactCalls = new Set<string>();
    const needsYouCalls = new Set<string>();
    let contextTokens: number | undefined;
    let contextReportedFor: string | undefined;
    let readingLimits = false;
    // Usage-limit signals of the user turn in progress.
    let rateLimit: SDKRateLimitInfo | undefined;
    let rateLimitError = false;
    const emitBackground = () =>
      session.emit({
        key: String(++session.sequence),
        provider_sequence: session.sequence,
        ...(active() ? { turn_id: active()!.id } : {}),
        kind: 'background.changed',
        tasks: [...prepared.background.values()],
      });
    /** Moves the query totals to a result's and returns what it adds to them. */
    const advanceTotals = (message: SDKResultMessage) => {
      // With several models in play the window of the one holding the context is unknown.
      const models = Object.values(message.modelUsage ?? {});
      const carried = prepared.resumed && prepared.cost === undefined;
      const before = prepared.cost ?? 0;
      // A mid-session /clear restarts the query total from zero.
      const cost =
        message.total_cost_usd >= before ? message.total_cost_usd - before : message.total_cost_usd;
      prepared.cost = message.total_cost_usd;
      // result.usage covers only the main loop; modelUsage adds subagents and compaction.
      const totals = models.reduce<TokenTotals>(
        (sum, model) => ({
          input_tokens:
            sum.input_tokens +
            model.inputTokens +
            model.cacheReadInputTokens +
            model.cacheCreationInputTokens,
          cached_input_tokens: sum.cached_input_tokens + model.cacheReadInputTokens,
          cache_write_input_tokens: sum.cache_write_input_tokens + model.cacheCreationInputTokens,
          output_tokens: sum.output_tokens + model.outputTokens,
        }),
        { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 },
      );
      const tokensCarried = prepared.resumed && prepared.tokens === undefined;
      const keys = Object.keys(totals) as (keyof TokenTotals)[];
      // Like the cost, a mid-session /clear restarts the query totals from zero.
      const since = keys.some((key) => totals[key] < (prepared.tokens?.[key] ?? 0))
        ? undefined
        : prepared.tokens;
      prepared.tokens = totals;
      session.costBaseline = {
        native_session_id: handle.native_session_id,
        total_cost_usd: message.total_cost_usd,
        tokens: totals,
      };
      const saved =
        spec.native_state_dir && costFile(spec.native_state_dir, handle.native_session_id);
      if (saved)
        try {
          writeFileSync(
            saved,
            JSON.stringify({ total_cost_usd: message.total_cost_usd, tokens: totals }),
            { mode: 0o600 },
          );
        } catch (error) {
          console.warn(
            'Claude query total was not saved:',
            error instanceof Error ? error.message : String(error),
          );
        }
      const tokens = { ...totals };
      for (const key of keys) tokens[key] -= since?.[key] ?? 0;
      return { models, carried, cost, tokens, tokensCarried };
    };
    try {
      for await (const message of stream) {
        if (session.prepared !== prepared) break;
        const current = active();
        if ('fast_mode_state' in message && message.fast_mode_state !== undefined) {
          const reason =
            'fast_mode_disabled_reason' in message ? message.fast_mode_disabled_reason : undefined;
          const seen = `${message.fast_mode_state}:${reason ?? ''}`;
          if (seen !== session.fastModeSeen) {
            session.fastModeSeen = seen;
            session.emit({
              key: String(++session.sequence),
              provider_sequence: session.sequence,
              kind: 'fast_mode.changed',
              state: message.fast_mode_state,
              ...(reason ? { reason } : {}),
            });
          }
        }
        // A result after the interrupt ended its turn still moves the query totals, so the
        // next turn counts only what it used.
        const used = message.type === 'result' ? advanceTotals(message) : undefined;
        if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
          const live = message.tasks.filter((task) => !task.ambient);
          const changed =
            live.length !== prepared.background.size ||
            live.some((task) => !prepared.background.has(task.task_id));
          prepared.background = new Map<string, BackgroundTask>(
            live.map((task) => [
              task.task_id,
              prepared.background.get(task.task_id) ?? {
                id: task.task_id,
                kind:
                  task.task_type === 'local_bash'
                    ? 'shell'
                    : task.task_type === 'local_agent'
                      ? 'agent'
                      : 'other',
                description: task.description,
                started_at: Date.now(),
              },
            ]),
          );
          if (changed) emitBackground();
        }
        if (message.type === 'system' && message.subtype === 'task_started' && !message.ambient)
          session.emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            ...(current ? { turn_id: current.id } : {}),
            kind: 'task.started',
            task: {
              id: message.task_id,
              kind:
                message.task_type === 'local_agent'
                  ? 'agent'
                  : message.task_type === 'local_bash'
                    ? 'shell'
                    : message.task_type === 'local_workflow'
                      ? 'workflow'
                      : 'other',
              ...(message.tool_use_id ? { tool_call_id: message.tool_use_id } : {}),
              ...(message.parent_task_id ? { parent_task_id: message.parent_task_id } : {}),
              ...(message.spawn_depth === undefined ? {} : { depth: message.spawn_depth }),
              description: message.description,
              ...(message.subagent_type ? { agent_type: message.subagent_type } : {}),
              background: message.is_backgrounded === true,
              started_at: Date.now(),
            },
          });
        if (message.type === 'system' && message.subtype === 'task_progress')
          session.emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            ...(current ? { turn_id: current.id } : {}),
            kind: 'task.progress',
            task_id: message.task_id,
            usage: {
              tokens: message.usage.total_tokens,
              tool_uses: message.usage.tool_uses,
              duration_ms: message.usage.duration_ms,
            },
            ...(message.last_tool_name ? { last_tool: message.last_tool_name } : {}),
            ...(message.summary ? { summary: message.summary } : {}),
          });
        if (message.type === 'system' && message.subtype === 'task_notification')
          session.emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            ...(current ? { turn_id: current.id } : {}),
            kind: 'task.ended',
            task_id: message.task_id,
            state: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage
              ? {
                  usage: {
                    tokens: message.usage.total_tokens,
                    tool_uses: message.usage.tool_uses,
                    duration_ms: message.usage.duration_ms,
                  },
                }
              : {}),
            ...(message.output_file ? { output_file: message.output_file } : {}),
          });
        if (message.type === 'rate_limit_event') {
          rateLimit = message.rate_limit_info;
          if (
            rateLimit.rateLimitType &&
            (rateLimit.status === 'rejected' || rateLimit.utilization !== undefined)
          )
            session.emit({
              key: String(++session.sequence),
              provider_sequence: session.sequence,
              kind: 'quota.updated',
              native_type: message.type,
              windows: [
                {
                  window: rateLimit.rateLimitType,
                  used_percent:
                    rateLimit.status === 'rejected' ? 100 : rateLimit.utilization! * 100,
                  ...(rateLimit.resetsAt === undefined
                    ? {}
                    : { resets_at: rateLimit.resetsAt * 1000 }),
                },
              ],
            });
        }
        if (
          message.type === 'assistant' ||
          message.type === 'stream_event' ||
          message.type === 'result'
        ) {
          const echoed =
            message.user_message_uuids ??
            (message.user_message_uuid ? [message.user_message_uuid] : []);
          if (echoed.length) answering = echoed;
        }
        const answered = answering;
        if (message.type === 'result') answering = undefined;
        if (!current) continue;
        if (message.type === 'system' && message.subtype === 'api_retry') {
          const reason =
            message.error_status === 429
              ? ('rate_limit' as const)
              : message.error_status === 529 || message.error_status === 503
                ? ('overloaded' as const)
                : message.error_status === null
                  ? ('network' as const)
                  : undefined;
          if (reason)
            session.emit({
              key: String(++session.sequence),
              provider_sequence: session.sequence,
              turn_id: current.id,
              kind: 'turn.retrying',
              attempt: message.attempt,
              retry_at: Date.now() + message.retry_delay_ms,
              reason,
              native_type: message.subtype,
            });
        }
        if (
          message.type === 'system' &&
          message.subtype === 'status' &&
          message.status === 'compacting'
        )
          session.emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id: current.id,
            kind: 'context.compacting',
            trigger: current.compact ? 'manual' : 'auto',
            native_type: message.subtype,
          });
        // Interrupt can finish a turn before its native turn ends. Its query totals still advance
        // above, but what that native turn still sends, its result included, is not the next turn's.
        if (
          ['assistant', 'stream_event', 'user', 'result'].includes(message.type) &&
          answered?.some((uuid) => prepared.sent.has(uuid)) &&
          !answered.some((uuid) => current.sent.has(uuid))
        )
          continue;
        let historyBefore: string | undefined;
        if (
          (message.type === 'assistant' || message.type === 'user') &&
          !message.parent_tool_use_id &&
          message.uuid !== undefined
        ) {
          historyBefore =
            prepared.historyMessage?.uuid === message.uuid
              ? prepared.historyMessage.before
              : prepared.historyMessage?.uuid;
          prepared.historyMessage = { uuid: message.uuid, before: historyBefore };
          current.historyEnd = message.uuid;
        }
        // A native turn is running, so a result will end the user turn.
        if (message.type === 'assistant' || message.type === 'stream_event')
          current.release = undefined;
        if (message.type === 'system' && message.subtype === 'init') {
          handle.native_session_id = message.session_id;
          session.spec.native_fork = undefined;
          // The init belongs to this native query, including resumed turns. A requested
          // alias is not evidence of the model the runtime actually selected.
          const reportedModel =
            typeof message.model === 'string' && message.model.trim() ? message.model : undefined;
          const modelChanged = handle.reported_model !== reportedModel;
          handle.reported_model = reportedModel;
          session.mcpServers = message.mcp_servers.map(({ name, status }) => ({
            name,
            state: (status === 'needs-auth' ? 'needs_sign_in' : status) as McpServerStatus['state'],
          }));
          // A failed status read only loses the interfaces; the turn itself goes on.
          session.appTools = message.capabilities?.includes('mcp_tool_ui_meta_v1')
            ? await stream.mcpServerStatus().then(appTools, () => new Map())
            : new Map();
          if (!session.started || modelChanged) {
            session.started = true;
            session.emit({
              key: String(++session.sequence),
              provider_sequence: session.sequence,
              turn_id: current.id,
              kind: 'session.started',
              native_session_id: handle.native_session_id,
              requested_model: handle.requested_model,
              reported_model: handle.reported_model,
              native_type: message.type,
              native: {
                type: message.type,
                subtype: message.subtype,
                tools: message.tools,
                mcp_servers: message.mcp_servers.map(({ name, status }) => ({ name, status })),
              },
            });
          }
          if (!session.extensionsApplied) {
            const overrides = prepared.overrides;
            // A failed read leaves the receipt to the next init; the turn itself goes on.
            const read = await (async () => {
              // Isolated sessions have no inherited plugins to resolve. In inherit mode,
              // reload returns the canonical name@marketplace IDs missing from system/init.
              const plugins = overrides ? await stream.reloadPlugins() : undefined;
              const servers = overrides ? await stream.mcpServerStatus() : message.mcp_servers;
              // system/init lists every discovered skill; the context breakdown lists the callable
              // ones and leaves the field out when there are none.
              const callable = overrides
                ? ((
                    await stream.getContextUsage({ detail: 'summary' })
                  ).skills?.skillFrontmatter.map((skill) => skill.name) ?? [])
                : message.skills;
              return { plugins, servers, callable };
            })().catch((error: unknown) => {
              console.warn(
                'Claude loaded extensions were not read:',
                error instanceof Error ? error.message : String(error),
              );
              return undefined;
            });
            if (!read || active() !== current) continue;
            const { plugins, servers, callable } = read;
            session.extensionsApplied = true;
            session.emit({
              key: String(++session.sequence),
              provider_sequence: session.sequence,
              turn_id: current.id,
              kind: 'extensions.applied',
              mode: overrides ? 'inherit' : 'none',
              disabled: {
                mcp_servers: (overrides?.disabled_mcp_servers ?? []).filter(
                  (name) => !spec.pantheon_mcp || name !== 'pantheon',
                ),
                plugins: overrides?.disabled_plugins ?? [],
                skills: overrides?.disabled_skills ?? [],
                apps: overrides?.disable_apps ?? true,
                hooks: overrides?.disable_hooks ?? true,
              },
              ...(prepared.configuredSkills
                ? { configured_skills: prepared.configuredSkills }
                : {}),
              loaded: {
                mcp_servers: servers
                  .filter((server) => server.status === 'connected')
                  .map((server) => server.name),
                plugins:
                  plugins?.plugins.flatMap((plugin) => (plugin.source ? [plugin.source] : [])) ??
                  [],
                skills: callable,
                apps: servers.some(
                  (server) =>
                    server.status === 'connected' &&
                    (server.source === 'claudeai' ||
                      ('scope' in server && server.scope === 'claudeai')),
                ),
                // This is the hook enablement state; the SDK cannot enumerate inherited hooks.
                hooks: !!overrides && !overrides.disable_hooks,
              },
              ...(overrides && !overrides.disable_hooks
                ? {
                    not_applied: [
                      {
                        item: 'hooks',
                        reason:
                          'SDK exposes no inherited hook status; loaded.hooks reports whether hooks are allowed',
                      },
                    ],
                  }
                : {}),
            });
          }
        }
        if (message.type === 'system' && message.subtype === 'compact_boundary') {
          current.historyEnd = message.uuid;
          session.emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id: current.id,
            kind: 'context.compacted',
            trigger: message.compact_metadata.trigger,
            pre_tokens: message.compact_metadata.pre_tokens,
            native_type: message.subtype,
          });
        }
        if (
          message.type === 'system' &&
          ['hook_started', 'hook_progress', 'hook_response'].includes(message.subtype)
        )
          session.emit({
            key: String(++session.sequence),
            provider_sequence: session.sequence,
            turn_id: current.id,
            kind: 'native',
            native_type: message.subtype,
            native: tracePayload(message),
          });
        if (message.type === 'assistant' && message.error === 'rate_limit') rateLimitError = true;
        // Subagent messages carry their own context, not the session's.
        if (message.type === 'assistant' && !message.parent_tool_use_id && message.message.usage) {
          contextTokens =
            message.message.usage.input_tokens +
            (message.message.usage.cache_read_input_tokens ?? 0) +
            (message.message.usage.cache_creation_input_tokens ?? 0);
          // Context fields alone: control keeps the turn's other usage fields until the turn ends.
          if (message.message.id !== contextReportedFor) {
            contextReportedFor = message.message.id;
            const turn = current;
            const report = () => {
              const limits = session.contextLimits;
              session.emit({
                key: String(++session.sequence),
                provider_sequence: session.sequence,
                turn_id: turn.id,
                kind: 'usage.updated',
                ...(limits?.autoCompactAtTokens !== undefined
                  ? { auto_compact_at_tokens: limits.autoCompactAtTokens }
                  : {}),
                context_tokens: contextTokens!,
                ...(limits?.window !== undefined ? { context_window: limits.window } : {}),
                // The cost is known only once a result arrives.
                cost_source: 'unknown',
                native_type: 'assistant',
              });
            };
            if (session.contextLimits) report();
            else if (!readingLimits) {
              // A session's first turn knows no window yet; the report waits for one read of it.
              readingLimits = true;
              void stream
                .getContextUsage({ detail: 'summary' })
                .then(
                  (context) => ({
                    window: context.rawMaxTokens,
                    autoCompactAtTokens: context.isAutoCompactEnabled
                      ? context.autoCompactThreshold
                      : undefined,
                  }),
                  // A failed read still reports the tokens, without a window.
                  () => ({}),
                )
                .then((limits) => {
                  readingLimits = false;
                  session.contextLimits ??= limits;
                  if (active() === turn) report();
                });
            }
          }
        }
        if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
          if (message.event.type === 'message_start') {
            streamed.add(message.event.message.id);
            drawings.clear();
          } else if (message.event.type === 'content_block_start') {
            const block = message.event.content_block;
            if (block.type === 'tool_use' && block.name === 'mcp__pantheon__draw')
              drawings.set(message.event.index, {
                tool_call_id: block.id,
                received_bytes: 0,
                emitted_at: -Infinity,
              });
          } else if (message.event.type === 'content_block_stop')
            drawings.delete(message.event.index);
          else if (
            message.event.type === 'content_block_delta' &&
            message.event.delta.type === 'input_json_delta'
          ) {
            const drawing = drawings.get(message.event.index);
            if (drawing) {
              drawing.received_bytes += Buffer.byteLength(message.event.delta.partial_json);
              const now = Date.now();
              if (now - drawing.emitted_at >= 250) {
                drawing.emitted_at = now;
                session.emit({
                  key: String(++session.sequence),
                  provider_sequence: session.sequence,
                  turn_id: current.id,
                  kind: 'visual.drawing',
                  tool_call_id: drawing.tool_call_id,
                  received_bytes: drawing.received_bytes,
                  native_type: message.type,
                });
              }
            }
          } else if (
            message.event.type === 'content_block_delta' &&
            message.event.delta.type === 'text_delta'
          )
            session.emit({
              key: String(++session.sequence),
              provider_sequence: session.sequence,
              turn_id: current.id,
              kind: 'message.delta',
              text: message.event.delta.text,
              native_type: message.type,
            });
        }
        if (message.type === 'assistant')
          for (const content of message.message.content)
            if (content.type === 'text') {
              // Subagent text is the subagent's own working, not the main conversation.
              if (!message.parent_tool_use_id && !streamed.has(message.message.id))
                session.emit({
                  key: String(++session.sequence),
                  provider_sequence: session.sequence,
                  turn_id: current.id,
                  kind: 'message.delta',
                  text: content.text,
                  native_type: message.type,
                });
            } else if (content.type === 'thinking') {
              // The signature only lets the API verify the block; it is not shown.
              if (!message.parent_tool_use_id && content.thinking.trim())
                session.emit({
                  key: String(++session.sequence),
                  provider_sequence: session.sequence,
                  turn_id: current.id,
                  kind: 'reasoning',
                  text: content.thinking,
                  native_type: message.type,
                });
            } else if (content.type === 'tool_use') {
              const app = session.appTools.get(content.name);
              if (app) appCalls.add(content.id);
              if (content.name === 'Artifact') artifactCalls.add(content.id);
              if (content.name === 'mcp__pantheon__needs_you') needsYouCalls.add(content.id);
              session.emit({
                key: String(++session.sequence),
                provider_sequence: session.sequence,
                turn_id: current.id,
                kind: 'tool.started',
                ...(historyBefore ? { native_history_before: historyBefore } : {}),
                tool_call_id: content.id,
                name: content.name,
                input:
                  content.name === 'review.finding' ? content.input : tracePayload(content.input),
                ...(app ? { app: { server: app.server, resource_uri: app.resource_uri } } : {}),
                ...(message.parent_tool_use_id
                  ? { parent_tool_use_id: message.parent_tool_use_id }
                  : {}),
                native_type: message.type,
              });
            }
        if (message.type === 'user' && Array.isArray(message.message.content))
          for (const content of message.message.content)
            if (content.type === 'tool_result') {
              const app_result = appCalls.delete(content.tool_use_id)
                ? appResult(content, message.tool_use_result)
                : undefined;
              const artifact = artifactCalls.delete(content.tool_use_id)
                ? publishedArtifact(message.tool_use_result)
                : undefined;
              const images = Array.isArray(content.content)
                ? content.content.flatMap((block) =>
                    block.type === 'image' &&
                    block.source.type === 'base64' &&
                    block.source.data.length <= imageLimit
                      ? [{ mime: block.source.media_type, data: block.source.data }]
                      : [],
                  )
                : [];
              session.emit({
                key: String(++session.sequence),
                provider_sequence: session.sequence,
                turn_id: current.id,
                kind: 'tool.completed',
                tool_call_id: content.tool_use_id,
                ok: !content.is_error,
                output: tracePayload(
                  { content: content.content },
                  needsYouCalls.delete(content.tool_use_id) ? needsYouLimit : undefined,
                ),
                ...(app_result ? { app_result } : {}),
                ...(images.length ? { images } : {}),
                ...(artifact ? { artifact } : {}),
                ...(message.parent_tool_use_id
                  ? { parent_tool_use_id: message.parent_tool_use_id }
                  : {}),
                native_type: message.type,
              });
            }
        if (message.type === 'result') {
          const { models, carried, cost, tokens, tokensCarried } = used!;
          const usage = (current.usage ??= {
            tokens: {
              input_tokens: 0,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 0,
            },
            tokensCarried: false,
            cost_usd: 0,
            carried: false,
          });
          for (const key of Object.keys(tokens) as (keyof TokenTotals)[])
            usage.tokens[key] += tokens[key];
          if (tokensCarried) usage.tokensCarried = true;
          if (carried) usage.carried = true;
          else usage.cost_usd += cost;
          usage.context_tokens = contextTokens;
          usage.context_window = models.length === 1 ? models[0]!.contextWindow : undefined;
          const echoed =
            message.user_message_uuids ??
            (message.user_message_uuid ? [message.user_message_uuid] : []);
          // A result that echoes none of this turn's sends leaves queued_turn_count as the only signal.
          if (echoed.some((uuid) => current.unanswered.has(uuid)))
            for (const uuid of echoed) current.unanswered.delete(uuid);
          else current.unanswered.clear();
          // A steer the CLI could not fold into the running turn runs as its own native turn;
          // its result follows, so this user turn ends only when every send of it is answered.
          // A background task's end likewise starts a native turn that belongs to this user turn.
          const end = () => {
            const failed = message.subtype !== 'success' || message.is_error;
            const usageLimit =
              failed &&
              !current.interrupted &&
              (rateLimit?.status === 'rejected' || rateLimitError);
            contextTokens = undefined;
            streamed.clear();
            current.finish(
              current.interrupted ? 'interrupted' : failed ? 'failed' : 'completed',
              failed && !current.interrupted ? `Claude result: ${message.subtype}` : undefined,
              message.type,
              usageLimit ? 'usage_limit' : undefined,
              // The CLI reports resetsAt in Unix epoch seconds.
              usageLimit && rateLimit?.resetsAt !== undefined
                ? rateLimit.resetsAt * 1000
                : undefined,
            );
            rateLimit = undefined;
            rateLimitError = false;
            const description = session.autoTitle?.input;
            if (description !== undefined) {
              session.autoTitle = undefined;
              void readTitle(session, stream, description);
            }
          };
          const queued = (message.queued_turn_count ?? 0) > 0 || current.unanswered.size > 0;
          if (!current.interrupted && (queued || prepared.background.size > 0)) {
            current.release = queued ? undefined : end;
            continue;
          }
          try {
            const context = await prepared.stream.getContextUsage({ detail: 'summary' });
            // The window Claude Code applies, the user's autoCompactWindow included.
            usage.context_window = context.rawMaxTokens;
            current.autoCompactAtTokens = context.isAutoCompactEnabled
              ? context.autoCompactThreshold
              : undefined;
            current.context = {
              categories: context.categories.flatMap(({ id, tokens, kind }) =>
                id === undefined ? [] : [{ id, tokens, kind }],
              ),
              memory_files: context.memoryFiles.map(({ path, tokens }) => ({ path, tokens })),
              mcp_tools: context.mcpTools.map(({ name, serverName, tokens, isLoaded }) => ({
                name,
                server: serverName,
                tokens,
                loaded: isLoaded ?? true,
              })),
              agents: context.agents.map(({ agentType, source, tokens }) => ({
                type: agentType,
                source,
                tokens,
              })),
            };
          } catch {
            // A failed read, or an answer without these lists, reports usage without a breakdown.
          }
          // A steer delivered during the read belongs to this turn, so its result ends it.
          if (!current.interrupted && current.unanswered.size > 0) {
            current.release = undefined;
            continue;
          }
          end();
        }
      }
      if (active())
        session.emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          kind: 'runtime.disconnected',
          reason: 'Claude runtime stream ended without a result',
        });
      active()?.finish('failed', 'Claude runtime stream ended without a result');
    } catch (error) {
      if (!prepared.abort.signal.aborted && session.prepared === prepared)
        session.emit({
          key: String(++session.sequence),
          provider_sequence: session.sequence,
          kind: 'runtime.disconnected',
          reason: `Claude runtime stream failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      active()?.finish(
        'failed',
        `Claude runtime stream failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined,
      );
    } finally {
      // The CLI's background tasks end with its process.
      if (prepared.background.size) {
        prepared.background.clear();
        emitBackground();
      }
      closeQuery(session, prepared);
    }
  }
  async stopBackground(handle: SessionHandle, taskId: string): Promise<void> {
    const session = this.sessions.get(handle);
    const prepared = session?.prepared;
    if (!session || !prepared?.background.has(taskId))
      throw new Error('No Claude background task with this id is running');
    await prepared.stream.stopTask(taskId);
    // The CLI starts no native turn after a stop, so no result ends a turn kept open by it.
    const current = session.turn;
    if (
      current?.abort === prepared.abort &&
      current.unanswered.size === 0 &&
      [...prepared.background.keys()].every((id) => id === taskId)
    )
      current.release?.();
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
    const session = this.sessions.get(handle),
      answer = session?.turn?.permissions.get(request_id);
    if (answer) {
      answer(decision, answers, reason);
      return { ok: true };
    }
    if (session)
      return {
        ok: false,
        reason: 'No pending permission request with this id',
        unknown_request: true,
      };
    return { ok: false, reason: 'No permission requests are raised by this adapter' };
  }
  async cancel(handle: SessionHandle, deadline: number): Promise<CancelReceipt> {
    const session = this.sessions.get(handle);
    if (session) {
      session.state = 'unknown';
      const prepared = session.prepared;
      // Started before the abort, so it reads the CLI's process tree while the CLI still runs.
      const stopping = stoppedProcesses(session.processes, deadline);
      if (prepared) {
        prepared.abort.abort();
        closeQuery(session, prepared);
      }
      const current = session.turn;
      current?.abort.abort();
      current?.finish('interrupted');
      const receipt = await stopping;
      session.state = receipt.stopped ? 'exited' : 'unknown';
      return receipt;
    }
    return {
      stopped: false,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none', members: [] },
      reason: 'Unknown handle',
    };
  }
  async close(handle: SessionHandle, deadline: number): Promise<CancelReceipt> {
    return this.cancel(handle, deadline);
  }
}
