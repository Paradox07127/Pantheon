import { permissionRules } from './approvals.js';
import { projectBranches, projectDefaultsRead } from './project.js';
import {
  repoBlame,
  repoCommitAfter,
  repoCommitDiff,
  repoCompare,
  repoFileHistory,
  repoLog,
  repoStatus,
  repoTimeline,
  repoWorktrees,
} from './repo.js';
import {
  isRepoWrite,
  prepareRepoWrite,
  recoverDiscardBackups,
  repoWorkingDiff,
} from './repo-write.js';
import { prepareStalePrune, workspaceStale } from './workspace-stale.js';
import { assertMemoryFresh } from './memory.js';
import {
  memoryRead,
  memoryItem,
  memoryGraph,
  memoryDocument,
  memoryTurn,
  memorySessionTurns,
  memoryRecent,
} from './memory-catalog.js';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  hash,
  DomainError,
  requireThat,
  type Principal,
  type ExternalEvent,
  type ExternalRead,
  type NeedsYouItem,
  type Session,
  type SessionComment,
  type SessionHandle,
  type HarnessAdapter,
  type Improvement,
  type Project,
  type ExtensionInventory,
  type ProcessIdentity,
  type Review,
  type Role,
  type RuntimeModel,
  type BoardPlan,
} from '@pantheon/domain';
import {
  commandSchema,
  inputSchemas,
  ZodError,
  PROTOCOL_VERSION,
  USER_PRINCIPAL_ID,
  type CommandType,
  type DeviceListItem,
  type UserConfig,
  type WorkflowPolicyView,
  type querySchemas,
} from '@pantheon/protocol';
import { Store, ArtifactFiles } from '@pantheon/store';
import {
  inside,
  resolvedPath,
  projectAccess,
  sessionPrincipal,
  sessionAction,
  purposeSessionTools,
  leadSessionTools,
  sessionWorkspaceKind,
  userOnly,
  revision,
  type ControlContext,
  type Handler,
} from './context.js';
import { personalCommand } from './personal-scope.js';
import { handlers, preparers } from './commands.js';
import type { VisualDrawReceipt } from './visual.js';
import { tick } from './scheduler.js';
import { acceptInput, personalAgentFolder, stopTurn } from './session.js';
import { recover, reconcile } from './recovery.js';
import { snapshot, snapshotAccess } from './snapshot.js';
import { projectRead } from './project-facts.js';
import { projectUsageRead } from './usage-report.js';
import { retrospectiveList } from './retrospective.js';
import { routingTable } from './routing-table.js';
import {
  checkWorkflowSkills,
  workflowDefinitionList,
  workflowDefinitionView,
} from './workflow-engine.js';
import { inheritedPolicy, workflowPolicy } from './workflow-policy.js';
import { improvementList, improvementSessions } from './improvements.js';
import { learnedList } from './learned-inbox.js';
import { changeOutcome, changeOutcomes } from './change-outcomes.js';
import { improvementSignals } from './improvement-signals.js';
import { taskTrace } from './task-trace.js';
import { taskThread } from './task-thread.js';
import { projectReviewMetrics, reviewExecutionReader, reviewTimeReader } from './review.js';
import {
  baselineSessionOf,
  inventoryRuntimes,
  projectBaselineRead,
  projectFactsRead,
} from './baseline.js';
import { environmentChecks } from './environment-check.js';
import {
  changeStoryDiff,
  changeStoryList,
  isPreparedChangeStory,
  prepareChangeStory,
} from './change-story.js';
import { rangeStoryList } from './range-story.js';
import { projectIntroRead } from './project-intro.js';
import { filesList, filesRead, sessionToolImage, symbolsSearch } from './workspace-files.js';
import { prepareRollback, readTurnDiff } from './checkpoint.js';
import {
  addAttachment,
  filesSearch,
  projectGatesHistory,
  projectHead,
  sessionCreatePreview,
  isPreparedSessionCommand,
  prepareSessionCommand,
  prepareSessionModels,
  prefetchMergeReads,
  prefetchWorktreeReads,
  projectTimeline,
  readSessionDiff,
  sessionGates,
  sessionGatesHistory,
  sessionPreflight,
  sessionList,
  sessionToolActivity,
} from './workbench-session.js';
import { sessionTasks } from './session-tasks.js';
import { boardView, prefetchRevertWalks } from './board-view.js';
import { boardHistory } from './board-history.js';
import { planReplay } from './plan-replay.js';
import {
  projectHeatmap,
  projectTrace,
  sessionTrace,
  sessionStepDiff,
  projectCollab,
  traceProjects,
  traceTime,
  toolCalls,
  projectTraceStats,
} from './trace-view.js';
import type { TraceIndex } from './trace-index.js';
import { SessionSearch } from './session-search.js';
import { recoverWorkspaceProvisioning, stopWorkspaceProvisioning } from './provisioning.js';
import { needsYou } from './needs-you.js';
import { projectsSummary, summaryProjects } from './projects-summary.js';
import { projectBrief } from './project-brief.js';
import { decisionsForUser } from './decisions-for-user.js';
import { personalKeyList } from './personal-keys.js';
import { timerHandlers } from './timers.js';
import { agentList, agentTemplates, ensureAgents } from './agents.js';
import { agentRoutines, agentWakes } from './agent-wakes.js';
import { agentProposal } from './agent-proposals.js';
import { recordTraceFindings, signalList } from './signals.js';
import { continueSession } from './continuation.js';
import { appendNote } from './lead-inbox.js';
import type { ProtectionPaths } from './protection.js';
import { readProcess } from './process.js';
import { githubSource } from './github-notifications.js';
import { externalSourceStatuses, type ExternalSource } from './external-sources.js';
import { stopChildProcesses } from './child-processes.js';
import { reconnectRuntime, refreshRuntimeStatus, runtimeStatus } from './runtime-status.js';
import {
  mcpAppResource,
  mcpAppToolCall,
  mcpStatus,
  reconnectMcp,
  sessionMcpServers,
} from './mcp-status.js';
import { connectionsStatus } from './connections-status.js';
import { localCommand, type LocalCommand } from './local-command.js';
import type { TurnSummarizer } from './session-recap.js';
import {
  githubItems,
  githubPullDetail,
  prepareGithubReferences,
  preparePullRequest,
} from './github.js';
import { prepareRuntimeConfig } from './runtime-config.js';
import { readAppSettings } from './app-settings.js';
import { themeList, themeRead } from './theme.js';
import { styleRead } from './user-style.js';
import { appLogs } from './app-logs.js';
import { listDevices, refreshDevices, reprobeDevice, sshHosts } from './devices.js';
import { backendList, externalEvents, readUserConfig } from './user-config.js';
import { onDevice, pullRemoteWorkspace } from './remote-workspace.js';
import { deviceLoads } from './task-dispatch.js';
import { importCandidates, importableSessions } from './import-candidates.js';
import { Terminals, type TerminalSpawn, type TerminalFrame } from './terminals.js';
import { BrowserRelay } from './browser.js';

export {
  Terminals,
  type TerminalSpawn,
  type TerminalPty,
  type TerminalFrame,
} from './terminals.js';

export {
  scheduleTimer,
  cancelTimer,
  fireDueTimers,
  timerHandlers,
  type TimerHandler,
} from './timers.js';
export {
  protectionList,
  plannerProtectionList,
  reviewerProtectionList,
  assertManagedLocation,
  type ProtectionPaths,
  type ProtectionEntry,
} from './protection.js';
export { runGit } from './git.js';
export {
  PERSONAL_QUERIES,
  PERSONAL_COMMANDS,
  OUTSIDE_PERSONAL_SCOPE,
  personalQuery,
  personalCommand,
} from './personal-scope.js';
export { AGENT_SCOPE, agentScopeMarkdown, type AgentScopeRow } from './agent-scope.js';
export { personalHome } from './personal-agent.js';
export { TraceIndex } from './trace-index.js';
export { RUNTIME_EVENT_KINDS } from './runtime-findings.js';
export { runtimeConfig } from './user-config.js';
export { taskRung, type TaskRungFacts } from './task-rung.js';
export { startEnvironmentCheck } from './environment-check.js';
export type { HandBackCheck } from './task-tracking.js';

const USAGE_LIMIT_RESUME_TEXT =
  '[Pantheon] Your last turn stopped because the usage limit was used up. The limit has reset. Check where your work stopped, then continue.';

/** Each item once; an item is enabled when any folder enables it. */
function unionInventory(a: ExtensionInventory, b: ExtensionInventory): ExtensionInventory {
  const merge = <T extends { enabled: boolean }>(items: T[], key: (item: T) => string): T[] => {
    const byKey = new Map<string, T>();
    for (const item of items) {
      const seen = byKey.get(key(item));
      byKey.set(key(item), seen ? { ...seen, enabled: seen.enabled || item.enabled } : item);
    }
    return [...byKey.values()];
  };
  const hooks = new Map(
    [...a.hooks, ...b.hooks].map((hook) => [`${hook.event}\0${hook.plugin ?? ''}`, hook]),
  );
  // An absent switch is unreported and counts as on.
  const reported = [a.hooks_enabled, b.hooks_enabled];
  return {
    runtime: a.runtime,
    mcp_servers: merge([...a.mcp_servers, ...b.mcp_servers], (server) => server.name),
    plugins: merge([...a.plugins, ...b.plugins], (plugin) => plugin.id),
    skills: merge([...a.skills, ...b.skills], (skill) => skill.id),
    apps: a.apps || b.apps,
    connectors: merge([...a.connectors, ...b.connectors], (connector) => connector.name),
    hooks: [...hooks.values()],
    ...(reported.includes(true)
      ? { hooks_enabled: true }
      : reported.every((value) => value === false)
        ? { hooks_enabled: false }
        : {}),
  };
}

export interface ControlOptions {
  terminalSpawn?: TerminalSpawn;
  workspaceRoot?: string;
  /** Earlier managed roots whose worktrees and reviews are still removed and protected; none are created there. */
  formerWorkspaceRoots?: string[];
  protectionPaths?: Omit<ProtectionPaths, 'workspacePath' | 'sourceRepo' | 'otherWorkspaces'>;
  readProcess?: (pid: number) => ProcessIdentity | undefined;
  issueSessionCredential?: (
    sessionId: string,
    role: Role,
  ) => { token_file: string; daemon_url: string };
  revokeSessionCredential?: (sessionId: string) => void;
  issuePersonalKey?: (keyId: string) => { token_file: string; digest: string };
  revokePersonalKey?: (keyId: string) => void;
  /** Undoes revokePersonalKey: the token file and its principal come back. */
  restorePersonalKey?: (keyId: string, digest: string) => void;
  /** Removes for good a key whose row never committed. */
  discardPersonalKey?: (keyId: string) => void;
  /** The token file of a live personal key and the daemon address a personal MCP server uses. */
  personalKeyFile?: (keyId: string) => { token_file: string; daemon_url: string };
  /** Native transcript index the trace queries merge with the event log. */
  trace?: TraceIndex;
  /** Directory holding the user's config.json; absent means no user configuration. */
  userConfigDir?: string;
  /** Adapter construction supplied by the daemon, shared with startup. */
  createRuntimeAdapter?: (
    runtime: string,
    config: NonNullable<UserConfig['runtimes']>[string],
  ) => Promise<HarnessAdapter | undefined>;
  /** Wall clock of a worktree session's turn; absent means six hours. */
  turnWallTimeMs?: number;
  /** Absolute path of the CLI entry a session's Pantheon MCP server runs; absent means the one built in this repository. */
  mcpEntry?: string;
  /** The source checkout the running app is built from; absent means the one this package is built in. */
  appRoot?: string;
  /** Where external events come from; absent means GitHub through the gh CLI. */
  externalSources?: ExternalSource[];
  /** Runs local connection and GitHub commands; absent means execFile. */
  localCommand?: LocalCommand;
  /** Writes each session's recap after its turns and requests; absent means sessions get none. */
  turnSummarizer?: TurnSummarizer;
  /** How commands and git reach a device's SSH target; absent means SSH itself. */
  deviceLink?: (ssh: string) => {
    transport: string[];
    gitUrl: (path: string) => string;
    /** The transport with the device socket reaching the local one, and the socket the device uses. */
    withSocket: (
      localSocket: string,
      deviceSocket: string,
    ) => { transport: string[]; socket: string };
  };
}

export class Control extends EventEmitter {
  readonly adapters: Map<string, HarnessAdapter>;
  readonly handles = new Map<string, SessionHandle>();
  /** The desktop windows that answer the sessions' browser tools. */
  readonly browser = new BrowserRelay();
  private announcedTrace = 0;
  private runtimeConfigChanges: Promise<unknown> = Promise.resolve();
  private readonly ctx: ControlContext;
  private readonly search: SessionSearch;
  private readonly terminals: Terminals;
  constructor(
    readonly store: Store,
    readonly files: ArtifactFiles,
    adapters: HarnessAdapter[],
    readonly failpoint: (name: string) => void = () => {},
    options: ControlOptions = {},
  ) {
    super();
    this.terminals = new Terminals(store, options.terminalSpawn);
    const workspaceRoot =
      options.workspaceRoot === undefined ? undefined : resolvedPath(options.workspaceRoot);
    const managedWorkspaceRoots =
      workspaceRoot === undefined
        ? []
        : [
            ...new Set([
              workspaceRoot,
              ...(options.formerWorkspaceRoots ?? []).map((root) => resolvedPath(root)),
            ]),
          ];
    // The temporary-directory rule is checked per workspace in registerWorkspace, so a daemon
    // whose data directory is temporary (tests, development) still starts.
    for (const root of managedWorkspaceRoots) {
      requireThat(
        !inside(resolvedPath(path.dirname(files.directory)), root) &&
          (store.file === ':memory:' || !inside(resolvedPath(path.dirname(store.file)), root)),
        'scope_violation',
        'Workspace root cannot be inside the data directory',
      );
    }
    timerHandlers.set('usage-limit-resume', (ctx, timer) => {
      const session = ctx.store.get<Session>('sessions', timer.subject_id);
      if (!session || session.state === 'closed') return;
      const plan = ctx.store.get<BoardPlan>('board_plans', session.id);
      // A lead's wake is held while this timer is pending, so the tracker sends the note on a later tick.
      if (plan)
        appendNote(ctx, plan, {
          at: ctx.store.now(),
          session_id: '',
          task_id: '',
          kind: 'usage_reset',
          text: USAGE_LIMIT_RESUME_TEXT,
        });
      else {
        // A session that takes no input now, such as one still stopping, is asked again later.
        try {
          acceptInput(ctx, session, 'send');
        } catch (error) {
          if (error instanceof DomainError) return ctx.store.now() + 60_000;
          throw error;
        }
        continueSession(ctx, session, USAGE_LIMIT_RESUME_TEXT, '');
      }
    });
    files.failpoint = failpoint;
    this.adapters = new Map(adapters.map((a) => [a.name, a]));
    this.ctx = {
      store,
      files,
      workspaceRoot,
      managedWorkspaceRoots,
      protectionPaths: options.protectionPaths,
      trace: options.trace,
      userConfigDir: options.userConfigDir,
      turnWallTimeMs: options.turnWallTimeMs,
      mcpEntry: options.mcpEntry,
      appRoot: options.appRoot,
      readProcess: options.readProcess ?? readProcess,
      issueSessionCredential: options.issueSessionCredential,
      revokeSessionCredential: options.revokeSessionCredential,
      issuePersonalKey: options.issuePersonalKey,
      revokePersonalKey: options.revokePersonalKey,
      restorePersonalKey: options.restorePersonalKey,
      discardPersonalKey: options.discardPersonalKey,
      personalKeyFile: options.personalKeyFile,
      adapters: this.adapters,
      createRuntimeAdapter: options.createRuntimeAdapter,
      handles: this.handles,
      completions: new Set<Promise<void>>(),
      cancelling: new Map<string, Promise<void>>(),
      endTurns: new Map<string, (error?: string) => string | undefined>(),
      idleConversations: new Map<string, number>(),
      runtimeStatus: new Map(),
      runtimeModels: new Map(),
      devices: new Map(),
      deviceLink: options.deviceLink,
      toolRelays: new Map(),
      externalSources: options.externalSources ?? [githubSource()],
      localCommand: options.localCommand ?? localCommand,
      turnSummarizer: options.turnSummarizer,
      failpoint,
      busy: false,
      closing: false,
      changed: () => {
        this.terminals.reapSessions();
        this.emit('events', this.store.cursor());
      },
      diagnostic: (error) => this.emit('diagnostic', error),
    };
    this.search = new SessionSearch(store);
  }
  execute(principal: Principal, raw: unknown): unknown {
    const version = (raw as { protocol_version?: unknown } | null)?.protocol_version;
    if (version !== undefined && version !== PROTOCOL_VERSION)
      throw new DomainError(
        'protocol_mismatch',
        `command protocol ${JSON.stringify(version)}, daemon ${PROTOCOL_VERSION}`,
      );
    const command = commandSchema.parse(raw);
    const sessionChoice =
      command.type === 'session.create' ||
      command.type === 'session.setPermissionMode' ||
      command.type === 'session.setFastMode';
    if (principal.session_id && !sessionChoice) sessionAction(this.ctx, principal, command.type);
    requireThat(
      command.actor === principal.id,
      'permission_denied',
      'Actor must match authenticated principal',
    );
    // A personal principal sends only its listed commands; nothing below runs for any other.
    personalCommand(principal, command);
    requireThat(
      Object.hasOwn(inputSchemas, command.type),
      'unsupported_command',
      `Not implemented: ${command.type}`,
    );
    const input = inputSchemas[command.type as CommandType].parse(command.input);
    command.input = input;
    const projectId = (input as { project_id?: unknown }).project_id;
    requireThat(
      typeof projectId !== 'string' ||
        this.store.get<Project>('projects', projectId)?.kind !== 'personal',
      'invalid_input',
      "The personal agent's home takes no project commands",
    );
    if (sessionChoice) {
      const choice = input as { permission_mode?: Session['permission_mode']; fast?: boolean };
      requireThat(
        (principal.role === 'user' && !principal.session_id) ||
          (!['auto', 'full_access'].includes(choice.permission_mode ?? '') &&
            choice.fast !== true &&
            command.type !== 'session.setFastMode'),
        'unsupported_capability',
        'Only user can select elevated permission modes or fast mode',
      );
    }
    if (principal.session_id && sessionChoice) sessionAction(this.ctx, principal, command.type);
    // A browser page is live and a screenshot large, so these keep no receipt.
    if (command.type === 'browser.open')
      return this.browser.call(principal, 'open', { url: (input as { url: string }).url });
    if (command.type === 'browser.read' || command.type === 'browser.screenshot')
      return this.browser.call(principal, command.type === 'browser.read' ? 'read' : 'screenshot');
    if (command.type === 'app.errors') return this.browser.call(principal, 'app_errors');
    if (command.type === 'app.screenshot') return this.browser.call(principal, 'app_screenshot');
    if (command.type === 'app.dom')
      return this.browser.call(principal, 'app_dom', input as { selector?: string });
    // The log and the stylesheet are read as they are now, so these keep no receipt either.
    if (command.type === 'app.logs')
      return appLogs(this.ctx, input as ReturnType<(typeof inputSchemas)['app.logs']['parse']>);
    if (command.type === 'style.read') return styleRead(this.ctx);
    if (command.type === 'browser.result') {
      userOnly(principal);
      return this.browser.answer(
        input as ReturnType<(typeof inputSchemas)['browser.result']['parse']>,
      );
    }
    const key = `${principal.id}:key:${command.idempotency_key}`,
      commandKey = `${principal.id}:command:${command.command_id}`;
    // A session credential's expiry moves on every call, so a retry must not see it.
    const { expires_at, ...holder } = principal;
    const digest = hash({
      principal: holder,
      type: command.type,
      input,
      expected_revision: command.expected_revision,
    });
    // Current-memory reads must never replay an obsolete idempotency receipt.
    const liveMemoryRead = [
      'memory.get',
      'memory.context',
      'memory.search',
      'memory.related',
      'project.read',
    ].includes(command.type);
    const apply = (prepared?: Handler): unknown => {
      let result: unknown;
      this.ctx.rollback = [];
      try {
        result = this.store.transaction(() => {
          for (const k of liveMemoryRead ? [] : [key, commandKey]) {
            const previous = this.store.receipt(k);
            if (previous) {
              requireThat(
                previous.input_hash === digest,
                'conflict',
                'Command key reused for different input',
              );
              return previous.receipt;
            }
          }
          const handler = prepared ?? handlers[command.type as CommandType];
          if (!handler)
            throw new DomainError('unsupported_command', `Not implemented: ${command.type}`);
          assertMemoryFresh(this.ctx, principal, command.type);
          const receipt = handler(this.ctx, principal, command);
          if (!liveMemoryRead) {
            this.store.remember(key, digest, receipt);
            this.store.remember(commandKey, digest, receipt);
          }
          this.failpoint('before_transaction_commit');
          return receipt;
        });
      } catch (error) {
        for (const undo of this.ctx.rollback.reverse()) {
          try {
            undo();
          } catch {
            /* Preserve the command failure. */
          }
        }
        throw error;
      } finally {
        this.ctx.rollback = undefined;
      }
      this.failpoint('after_commit_before_send');
      this.ctx.changed();
      if (command.type === 'visual.draw') {
        const receipt = result as VisualDrawReceipt;
        // The failed visual and its event must commit before the agent receives the error.
        if (receipt.issues) throw new ZodError(receipt.issues);
      }
      // Invalidating an approval must commit even when the response itself is refused.
      if (
        command.type === 'approval.respond' &&
        result &&
        typeof result === 'object' &&
        'error' in result &&
        'message' in result
      )
        throw new DomainError(String(result.error), String(result.message));
      return result;
    };
    // Their git runs before the transaction, once references and models are read.
    const applyPrepared = (): unknown =>
      isPreparedSessionCommand(command.type) &&
      ![key, commandKey].some((k) => this.store.receipt(k))
        ? prepareSessionCommand(this.ctx, principal, command).then(apply)
        : apply();
    if (
      command.type === 'terminal.open' ||
      command.type === 'terminal.write' ||
      command.type === 'terminal.resize' ||
      command.type === 'terminal.close'
    ) {
      userOnly(principal);
      revision(this.ctx, command);
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      if (command.type === 'terminal.open')
        return this.terminals.prepare().then(() =>
          apply(() => {
            const receipt = this.terminals.open(
              input as ReturnType<(typeof inputSchemas)['terminal.open']['parse']>,
            );
            this.ctx.rollback?.push(() => this.terminals.close(receipt.terminal_id));
            return receipt;
          }),
        );
      return apply(() => {
        const { terminal_id } = input as { terminal_id: string };
        if (command.type === 'terminal.write')
          this.terminals.write(
            terminal_id,
            (input as ReturnType<(typeof inputSchemas)['terminal.write']['parse']>).data,
          );
        else if (command.type === 'terminal.resize') {
          const { cols, rows } = input as ReturnType<
            (typeof inputSchemas)['terminal.resize']['parse']
          >;
          this.terminals.resize(terminal_id, cols, rows);
        } else this.terminals.close(terminal_id);
        return { terminal_id };
      });
    }
    if (command.type === 'github.pr.create') {
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      return preparePullRequest(
        this.ctx,
        principal,
        command,
        input as ReturnType<(typeof inputSchemas)['github.pr.create']['parse']>,
      ).then(apply);
    }
    if (isRepoWrite(command.type)) {
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      return prepareRepoWrite(this.ctx, principal, command).then(apply);
    }
    // Their git runs outside the command's transaction.
    if (command.type === 'session.rollback' || command.type === 'workspace.prune_stale') {
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      const prepared = (command.type === 'session.rollback' ? prepareRollback : prepareStalePrune)(
        this.ctx,
        principal,
        command,
      );
      return prepared instanceof Promise ? prepared.then(apply) : apply(prepared);
    }
    if (isPreparedChangeStory(command.type)) {
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      return prepareChangeStory(this.ctx, principal, command).then(apply);
    }
    const prepare = preparers[command.type as CommandType];
    if (prepare) {
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      const prepared = prepare(this.ctx, principal, command);
      return prepared instanceof Promise ? prepared.then(apply) : apply(prepared);
    }
    if (command.type === 'session.reconnect') {
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      userOnly(principal);
      const { session_id } = input as ReturnType<
        (typeof inputSchemas)['session.reconnect']['parse']
      >;
      const session = this.store.must<Session>('sessions', session_id);
      requireThat(onDevice(session), 'invalid_state', `Session ${session_id} is not remote`);
      requireThat(
        session.remote_pull?.status === 'failed',
        'invalid_state',
        `The remote pull for session ${session_id} has not failed`,
      );
      const reconnect = pullRemoteWorkspace(this.ctx, session_id).then(
        () => apply(() => ({ session_id, succeeded: true })),
        (error: unknown) => {
          throw new DomainError(
            'remote_pull_failed',
            error instanceof Error ? error.message : String(error),
          );
        },
      );
      const tracked: Promise<void> = reconnect
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => this.ctx.completions.delete(tracked));
      this.ctx.completions.add(tracked);
      return reconnect;
    }
    if (command.type === 'runtime.reconnect' || command.type === 'mcp.reconnect') {
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      const update = async () => {
        const result =
          command.type === 'runtime.reconnect'
            ? await reconnectRuntime(this.ctx, principal, (input as { runtime: string }).runtime)
            : await reconnectMcp(
                this.ctx,
                principal,
                input as ReturnType<(typeof inputSchemas)['mcp.reconnect']['parse']>,
              );
        return apply(() => result);
      };
      this.runtimeConfigChanges = this.runtimeConfigChanges.then(update, update);
      return this.runtimeConfigChanges;
    }
    if (command.type === 'mcp.app.tool_call') {
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      return mcpAppToolCall(
        this.ctx,
        principal,
        input as ReturnType<(typeof inputSchemas)['mcp.app.tool_call']['parse']>,
      ).then((result) => apply(() => result));
    }
    if (command.type === 'runtime.config.set') {
      if ([key, commandKey].some((k) => this.store.receipt(k))) return apply();
      const update = () =>
        prepareRuntimeConfig(
          this.ctx,
          principal,
          command,
          input as ReturnType<(typeof inputSchemas)['runtime.config.set']['parse']>,
        ).then(apply);
      this.runtimeConfigChanges = this.runtimeConfigChanges.then(update, update);
      return this.runtimeConfigChanges;
    }
    const refs = (input as { refs?: { kind: string; number?: number }[] }).refs;
    if (
      refs?.some((ref) => ref.kind !== 'session') &&
      ![key, commandKey].some((k) => this.store.receipt(k))
    ) {
      // Pull requests and issues are read with gh before the turn is built from them.
      const projectId =
        'project_id' in input
          ? (input.project_id as string)
          : this.store.must<Session>('sessions', (input as { session_id: string }).session_id)
              .project_id;
      projectAccess(this.ctx, principal, projectId, command.type);
      return prepareGithubReferences(this.ctx, projectId, refs).then(
        () =>
          prepareSessionModels(this.ctx, principal, command)?.then(applyPrepared) ??
          applyPrepared(),
      );
    }
    if (![key, commandKey].some((k) => this.store.receipt(k))) {
      const modelsChecked = prepareSessionModels(this.ctx, principal, command);
      if (modelsChecked) return modelsChecked.then(applyPrepared);
    }
    // Skills are checked against the runtimes' inventories, which are read asynchronously.
    const skillsChecked =
      command.type === 'workflow.definition.set' &&
      ![key, commandKey].some((k) => this.store.receipt(k))
        ? checkWorkflowSkills(
            this.ctx,
            principal,
            input as ReturnType<(typeof inputSchemas)['workflow.definition.set']['parse']>,
          )
        : undefined;
    if (skillsChecked) return skillsChecked.then(() => apply());
    return applyPrepared();
  }
  snapshot(principal: Principal, projectId?: string): unknown {
    return snapshot(this.ctx, principal, projectId);
  }
  snapshotAccess(principal: Principal, projectId?: string): void {
    snapshotAccess(this.ctx, principal, projectId);
  }
  memoryRead(principal: Principal, projectId: string, options: Record<string, unknown> = {}) {
    return memoryRead(this.ctx, principal, projectId, options);
  }
  memoryItem(principal: Principal, projectId: string, memoryId: string) {
    return memoryItem(this.ctx, principal, projectId, memoryId);
  }
  memoryGraph(principal: Principal, input: unknown) {
    return memoryGraph(this.ctx, principal, input);
  }
  memoryTurn(principal: Principal, sessionId: string, turnId: string) {
    return memoryTurn(this.ctx, principal, sessionId, turnId);
  }
  memorySessionTurns(principal: Principal, sessionId: string) {
    return memorySessionTurns(this.ctx, principal, sessionId);
  }
  memoryRecent(principal: Principal, projectId: string, limit: number) {
    return memoryRecent(this.ctx, principal, projectId, limit);
  }
  memoryDocument(principal: Principal, projectId: string) {
    return memoryDocument(this.ctx, principal, projectId);
  }
  projectRead(principal: Principal, projectId: string): unknown {
    return projectRead(this.ctx, principal, projectId);
  }
  agentList(principal: Principal, projectId: string) {
    return agentList(this.ctx, principal, projectId);
  }
  agentTemplates(principal: Principal) {
    return agentTemplates(principal);
  }
  agentWakes(principal: Principal, agentId: string, limit: number) {
    return agentWakes(this.ctx, principal, agentId, limit);
  }
  agentRoutines(principal: Principal, projectId: string) {
    return agentRoutines(this.ctx, principal, projectId);
  }
  agentProposal(principal: Principal, proposalId: string) {
    return agentProposal(this.ctx, principal, proposalId);
  }
  signalList(principal: Principal, projectId: string, state?: 'open' | 'muted' | 'resolved') {
    return signalList(this.ctx, principal, projectId, state);
  }
  projectUsageRead(principal: Principal, projectId: string) {
    return projectUsageRead(this.ctx, principal, projectId);
  }
  retrospectiveList(principal: Principal, projectId: string, taskId?: string) {
    return retrospectiveList(this.ctx, principal, projectId, taskId);
  }
  routingTable(principal: Principal, projectId: string) {
    return routingTable(this.ctx, principal, projectId);
  }
  workflowPolicy(principal: Principal, projectId: string): WorkflowPolicyView {
    projectAccess(this.ctx, principal, projectId, 'workflow.policy');
    this.ctx.store.must<Project>('projects', projectId);
    return {
      ...workflowPolicy(this.ctx, projectId),
      defaults: inheritedPolicy(this.ctx),
    };
  }
  workflowDefinition(principal: Principal, projectId: string, workflowId?: string) {
    projectAccess(this.ctx, principal, projectId, 'workflow.definition');
    return workflowDefinitionView(this.ctx, projectId, workflowId);
  }
  workflowDefinitionList(principal: Principal, projectId: string) {
    projectAccess(this.ctx, principal, projectId, 'workflow.definition.list');
    this.ctx.store.must<Project>('projects', projectId);
    return workflowDefinitionList(this.ctx, projectId);
  }
  improvementList(principal: Principal, projectId: string, status?: Improvement['status']) {
    return improvementList(this.ctx, principal, projectId, status);
  }
  improvementSessions(principal: Principal, projectId: string, improvementId: string) {
    return improvementSessions(this.ctx, principal, projectId, improvementId);
  }
  learnedList(principal: Principal, projectId: string) {
    return learnedList(this.ctx, principal, projectId);
  }
  changeOutcome(principal: Principal, projectId: string, eventId: string) {
    return changeOutcome(this.ctx, principal, projectId, eventId);
  }
  changeOutcomes(principal: Principal, projectId: string) {
    return changeOutcomes(this.ctx, principal, projectId);
  }
  improvementSignals(principal: Principal, projectId: string) {
    projectAccess(this.ctx, principal, projectId, 'improvement.signals');
    this.ctx.store.must<Project>('projects', projectId);
    return improvementSignals(this.ctx, projectId);
  }
  taskTrace(principal: Principal, projectId: string, leadId: string, taskId: string) {
    return taskTrace(this.ctx, principal, projectId, leadId, taskId);
  }
  taskThread(principal: Principal, projectId: string, leadId: string, taskId: string) {
    return taskThread(this.ctx, principal, projectId, leadId, taskId);
  }
  projectReviewMetrics(principal: Principal, projectId: string) {
    return projectReviewMetrics(this.ctx, principal, projectId);
  }
  projectIntroRead(principal: Principal, projectId: string) {
    return projectIntroRead(this.ctx, principal, projectId);
  }
  projectBaselineRead(principal: Principal, projectId: string) {
    return projectBaselineRead(this.ctx, principal, projectId);
  }
  environmentChecks(
    principal: Principal,
    input: { project_id: string; baseline_id?: string; limit?: number },
  ) {
    return environmentChecks(this.ctx, principal, input);
  }
  projectFactsRead(principal: Principal, projectId: string) {
    return projectFactsRead(this.ctx, principal, projectId);
  }
  changeStoryList(principal: Principal, projectId: string) {
    return changeStoryList(this.ctx, principal, projectId);
  }
  changeStoryDiff(principal: Principal, storyId: string) {
    return changeStoryDiff(this.ctx, principal, storyId);
  }
  rangeStoryList(principal: Principal, projectId: string) {
    return rangeStoryList(this.ctx, principal, projectId);
  }
  sessionSearch(
    principal: Principal,
    input: ReturnType<(typeof querySchemas)['session.search']['parse']>,
  ) {
    userOnly(principal);
    if (input.project_id) projectAccess(this.ctx, principal, input.project_id, 'session.search');
    return this.search.search(input);
  }
  sessionList(principal: Principal, projectId: string, readChanges: true | 'cached' = true) {
    return sessionList(this.ctx, principal, projectId, readChanges);
  }
  /**
   * Reads ahead asynchronously the worktrees the session list and the needs-you merge actions read,
   * and the board's revert walks, of the project or of every summary project.
   */
  async prefetchWorktreeReads(principal: Principal, projectId?: string) {
    const projects = projectId
      ? [projectId]
      : summaryProjects(this.ctx, principal).map((project) => project.id);
    await Promise.all(
      projects.flatMap((id) => [
        prefetchWorktreeReads(this.ctx, principal, id),
        prefetchMergeReads(this.ctx, principal, id),
        prefetchRevertWalks(this.ctx, principal, id),
      ]),
    );
  }
  sessionDiff(principal: Principal, sessionId: string) {
    return readSessionDiff(this.ctx, principal, sessionId);
  }
  sessionTurnDiff(principal: Principal, sessionId: string, turnId: string) {
    return readTurnDiff(this.ctx, principal, sessionId, turnId);
  }
  sessionGates(principal: Principal, sessionId: string) {
    return sessionGates(this.ctx, principal, sessionId);
  }
  sessionGatesHistory(principal: Principal, sessionId: string, limit?: number) {
    return sessionGatesHistory(this.ctx, principal, sessionId, limit);
  }
  sessionTasks(principal: Principal, sessionId: string) {
    const session = this.ctx.store.must<Session>('sessions', sessionId);
    projectAccess(this.ctx, principal, session.project_id, 'project.read');
    return sessionTasks(this.ctx, sessionId);
  }
  projectGatesHistory(principal: Principal, projectId: string, limit?: number, since?: number) {
    return projectGatesHistory(this.ctx, principal, projectId, limit, since);
  }
  projectTimeline(principal: Principal, projectId: string, since?: string) {
    return projectTimeline(this.ctx, principal, projectId, since);
  }
  projectTrace(
    principal: Principal,
    projectId: string,
    from?: string,
    to?: string,
    bucketMs = 60_000,
  ) {
    return projectTrace(this.ctx, principal, projectId, from, to, bucketMs);
  }
  sessionTrace(principal: Principal, projectId: string, laneKey: string, turn?: string) {
    return sessionTrace(this.ctx, principal, projectId, laneKey, turn);
  }
  sessionStepDiff(principal: Principal, sessionId: string, turnId: string, spanId: string) {
    return sessionStepDiff(this.ctx, principal, sessionId, turnId, spanId);
  }
  projectCollab(principal: Principal, projectId: string, since: number, until: number) {
    return projectCollab(this.ctx, principal, projectId, since, until);
  }
  traceTime(principal: Principal, projectId: string, laneKey?: string, from?: string, to?: string) {
    return traceTime(this.ctx, principal, projectId, laneKey, from, to);
  }
  toolCalls(principal: Principal, projectId: string, command?: string, limit = 50) {
    return toolCalls(this.ctx, principal, projectId, command, limit);
  }
  projectTraceStats(principal: Principal, projectId: string, since: number, until: number) {
    return projectTraceStats(this.ctx, principal, projectId, since, until);
  }
  projectHeatmap(principal: Principal, projectId: string, days: '7' | '30' | '90' | 'all') {
    return projectHeatmap(this.ctx, principal, projectId, days);
  }
  sessionPreflight(principal: Principal, sessionId: string) {
    return sessionPreflight(this.ctx, principal, sessionId);
  }
  sessionToolActivity(principal: Principal, sessionId: string) {
    return sessionToolActivity(this.ctx, principal, sessionId);
  }
  boardHistory(principal: Principal, projectId: string) {
    return boardHistory(this.ctx, principal, projectId);
  }
  planReplay(principal: Principal, leadId: string, after: number, limit: number) {
    return planReplay(this.ctx, principal, leadId, after, limit);
  }
  boardView(
    principal: Principal,
    projectId: string,
    days: number | 'all',
    until?: string,
    readChanges: true | 'cached' = true,
  ) {
    const sessions = sessionList(this.ctx, principal, projectId, readChanges);
    return boardView(this.ctx, principal, projectId, days, until, sessions);
  }
  sessionComments(principal: Principal, sessionId: string) {
    const session = this.store.must<Session>('sessions', sessionId);
    projectAccess(this.ctx, principal, session.project_id, 'project.read');
    return this.store
      .list<SessionComment>('session_comments')
      .filter((comment) => comment.session_id === sessionId)
      .sort(
        (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.created_at - b.created_at,
      );
  }
  sessionReviews(principal: Principal, sessionId: string) {
    const session = this.store.must<Session>('sessions', sessionId);
    projectAccess(this.ctx, principal, session.project_id, 'project.read');
    const executions = reviewExecutionReader(this.ctx, session.project_id),
      times = reviewTimeReader(this.ctx, session.project_id);
    return this.store
      .list<Review>('reviews')
      .filter((review) => review.session_id === sessionId)
      .map((review) => ({ ...review, ...times(review), executions: executions(review) }));
  }
  sessionPrincipal(principal: Principal) {
    // MCP initializes during resume, before the runtime returns its new handle.
    const session = sessionPrincipal(this.ctx, principal, true);
    return {
      principal,
      review_id: session.review_id,
      baseline_id: session.baseline?.baseline_id,
      story_id: session.change_story?.story_id ?? session.range_story?.story_id,
      ...(session.baseline ? { extension_runtimes: inventoryRuntimes(this.ctx) } : {}),
      allowed_tool_names:
        purposeSessionTools(session, sessionWorkspaceKind(this.ctx, session)) ??
        leadSessionTools(this.ctx, session),
      ...(session.app_debug ? { app_debug: true as const } : {}),
    };
  }
  needsYou(principal: Principal, projectId?: string): { items: NeedsYouItem[] } {
    return needsYou(this.ctx, principal, projectId);
  }
  externalRead(principal: Principal, projectId: string): ExternalRead {
    userOnly(principal);
    const mode = externalEvents(this.ctx, this.ctx.store.must<Project>('projects', projectId));
    return {
      ...(mode !== 'off' && { mode }),
      sources: externalSourceStatuses(this.ctx),
      events: this.ctx.store
        .list<ExternalEvent>('external_events')
        .filter((event) => event.project_id === projectId)
        .reverse()
        .slice(0, 50),
      held: this.ctx.store
        .list<BoardPlan>('board_plans')
        .filter((plan) => plan.project_id === projectId)
        .flatMap((plan) => Object.keys(plan.external_holds ?? {})),
    };
  }
  projectsSummary(principal: Principal, readChanges: true | 'cached' = true) {
    return projectsSummary(this.ctx, principal, readChanges);
  }
  projectBrief(principal: Principal, projectId: string, since?: number) {
    return projectBrief(this.ctx, principal, projectId, since);
  }
  decisionsForUser(principal: Principal, projectId: string, since?: number) {
    return decisionsForUser(this.ctx, principal, projectId, since);
  }
  personalKeyList(principal: Principal) {
    return personalKeyList(this.ctx, principal);
  }
  async extensionsInventory(
    principal: Principal,
    projectId: string,
    runtime: string,
  ): Promise<ExtensionInventory> {
    if (!baselineSessionOf(this.ctx, principal, projectId))
      projectAccess(this.ctx, principal, projectId, 'project.read');
    const project = this.store.must<Project>('projects', projectId),
      adapter = this.adapters.get(runtime);
    requireThat(
      adapter?.inventory,
      'unsupported_capability',
      'Runtime does not support extension inventory',
    );
    const read = adapter.inventory.bind(adapter);
    const roots = project.roots.length ? project.roots : [personalAgentFolder(this.ctx)];
    const inventories = await Promise.all(roots.map((root) => read(root)));
    return inventories.reduce(unionInventory);
  }
  async runtimeModels(
    principal: Principal,
    projectId: string,
    runtime: string,
  ): Promise<RuntimeModel[]> {
    if (!baselineSessionOf(this.ctx, principal, projectId))
      projectAccess(this.ctx, principal, projectId, 'project.read');
    const project = this.store.must<Project>('projects', projectId),
      adapter = this.adapters.get(runtime);
    requireThat(adapter?.models, 'unsupported_capability', 'Runtime does not list its models');
    const models = await adapter.models(project.roots[0] ?? personalAgentFolder(this.ctx));
    this.ctx.runtimeModels.set(`${project.id}:${runtime}`, models);
    return models;
  }
  sessionCreatePreview(
    principal: Principal,
    input: ReturnType<(typeof querySchemas)['session.create.preview']['parse']>,
  ) {
    return sessionCreatePreview(this.ctx, principal, input);
  }
  permissionRules(principal: Principal, projectId: string) {
    return permissionRules(this.ctx, principal, projectId);
  }
  projectBranches(principal: Principal, projectId: string, root?: string) {
    return projectBranches(this.ctx, principal, projectId, root);
  }
  repoWorktrees(principal: Principal, projectId: string) {
    return repoWorktrees(this.ctx, principal, projectId);
  }
  repoStatus(principal: Principal, projectId: string, path: string) {
    return repoStatus(this.ctx, principal, projectId, path);
  }
  repoLog(principal: Principal, input: ReturnType<(typeof querySchemas)['repo.log']['parse']>) {
    return repoLog(this.ctx, principal, input);
  }
  repoCommitDiff(principal: Principal, projectId: string, sha: string) {
    return repoCommitDiff(this.ctx, principal, projectId, sha);
  }
  repoCompare(principal: Principal, projectId: string, base: string, head: string) {
    return repoCompare(this.ctx, principal, projectId, base, head);
  }
  repoCommitAfter(
    principal: Principal,
    input: ReturnType<(typeof querySchemas)['repo.commit_after']['parse']>,
  ) {
    return repoCommitAfter(this.ctx, principal, input);
  }
  repoTimeline(
    principal: Principal,
    input: ReturnType<(typeof querySchemas)['repo.timeline']['parse']>,
  ) {
    return repoTimeline(this.ctx, principal, input);
  }
  repoBlame(principal: Principal, input: ReturnType<(typeof querySchemas)['repo.blame']['parse']>) {
    return repoBlame(this.ctx, principal, input);
  }
  repoFileHistory(
    principal: Principal,
    input: ReturnType<(typeof querySchemas)['repo.file_history']['parse']>,
  ) {
    return repoFileHistory(this.ctx, principal, input);
  }
  repoWorkingDiff(principal: Principal, projectId: string) {
    return repoWorkingDiff(this.ctx, principal, projectId);
  }
  workspaceStale(principal: Principal, projectId: string) {
    return workspaceStale(this.ctx, principal, projectId);
  }
  projectHead(principal: Principal, projectId: string) {
    return projectHead(this.ctx, principal, projectId);
  }
  runtimeStatus(principal: Principal, refresh = false) {
    userOnly(principal);
    return runtimeStatus(this.ctx, refresh);
  }
  mcpStatus(principal: Principal, input: ReturnType<(typeof querySchemas)['mcp.status']['parse']>) {
    return mcpStatus(this.ctx, principal, input);
  }
  sessionMcpServers(principal: Principal, sessionId: string) {
    return sessionMcpServers(this.ctx, principal, sessionId);
  }
  mcpAppResource(
    principal: Principal,
    input: ReturnType<(typeof querySchemas)['mcp.app.resource']['parse']>,
  ) {
    return mcpAppResource(this.ctx, principal, input);
  }
  githubItems(principal: Principal, projectId: string, kind: 'pr' | 'issue') {
    return githubItems(this.ctx, principal, projectId, kind);
  }
  githubPullDetail(principal: Principal, projectId: string, number: number) {
    return githubPullDetail(this.ctx, principal, projectId, number);
  }
  connectionsStatus(principal: Principal, refresh = false) {
    return connectionsStatus(this.ctx, principal, refresh);
  }
  /** Checks every runtime again; a check still running is shared. */
  refreshRuntimeStatus(): Promise<void> {
    return refreshRuntimeStatus(this.ctx);
  }
  async listDevices(principal: Principal, refresh = false): Promise<DeviceListItem[]> {
    userOnly(principal);
    if (refresh) await refreshDevices(this.ctx);
    const configured = readUserConfig(this.ctx.userConfigDir).devices,
      loads = deviceLoads(this.ctx);
    const all = this.store.list<Session>('sessions'),
      opened = this.store.statement(
        "SELECT created_at FROM events WHERE aggregate_id=? AND project_id=? AND kind='session.opened' ORDER BY sequence DESC LIMIT 1",
      );
    // The open sessions session.list lists, in its order: by project, then as stored.
    const sessions = this.store.list<Project>('projects').flatMap((project) => {
      // session.list makes this check for each project; it refuses an expired principal.
      projectAccess(this.ctx, principal, project.id, 'project.read');
      return all
        .filter(
          (session) =>
            session.project_id === project.id &&
            (session.workspace_id ||
              session.baseline ||
              session.runtime_review ||
              session.resident) &&
            session.state !== 'closed' &&
            !session.outcome,
        )
        .map((session) => ({
          device_id: session.device_id ?? 'local',
          id: session.id,
          title: session.title ?? '',
          runtime: session.runtime,
          started_at: new Date(
            (opened.get(session.id, project.id)?.created_at as number | undefined) ?? 0,
          ).toISOString(),
        }));
    });
    return listDevices(this.ctx).map((device) => {
      const config = configured?.[device.id];
      return {
        ...device,
        ...(config && { config }),
        load: {
          ...(loads.get(device.id) ?? { sessions: 0, uses: {} }),
          active_sessions: sessions
            .filter((session) => session.device_id === device.id)
            .map(({ device_id: _device, ...session }) => session),
        },
      };
    });
  }
  /** Probes every configured device again; a probe still running is shared. */
  refreshDevices(): Promise<void> {
    return refreshDevices(this.ctx);
  }
  /** Probes the one device again and answers with it as device.list lists it. */
  async reprobeDevice(principal: Principal, id: string): Promise<DeviceListItem> {
    userOnly(principal);
    await reprobeDevice(this.ctx, id);
    return (await this.listDevices(principal)).find((device) => device.id === id)!;
  }
  sshHosts(principal: Principal) {
    userOnly(principal);
    return sshHosts(this.ctx);
  }
  appSettings(principal: Principal) {
    userOnly(principal);
    return readAppSettings(this.ctx);
  }
  projectDefaults(principal: Principal) {
    userOnly(principal);
    return projectDefaultsRead(this.ctx);
  }
  backendList(principal: Principal) {
    userOnly(principal);
    return backendList(this.ctx);
  }
  themeList(principal: Principal) {
    userOnly(principal);
    return themeList(this.ctx);
  }
  themeGet(principal: Principal, themeId: string) {
    userOnly(principal);
    return themeRead(this.ctx, themeId);
  }
  styleRead(principal: Principal) {
    userOnly(principal);
    return styleRead(this.ctx);
  }
  importCandidates(principal: Principal) {
    userOnly(principal);
    return importCandidates(this.ctx);
  }
  importableSessions(principal: Principal, projectId: string) {
    userOnly(principal);
    return importableSessions(this.ctx, projectId);
  }
  addAttachment(
    principal: Principal,
    projectId: string,
    name: string,
    mime: string,
    bytes: Uint8Array,
  ) {
    return addAttachment(this.ctx, principal, projectId, name, mime, bytes);
  }
  filesSearch(principal: Principal, projectId: string, sessionId: string | undefined, q: string) {
    return filesSearch(this.ctx, principal, projectId, sessionId, q);
  }
  filesList(principal: Principal, projectId: string, sessionId: string | undefined, path?: string) {
    return filesList(this.ctx, principal, projectId, sessionId, path);
  }
  filesRead(principal: Principal, projectId: string, sessionId: string | undefined, path: string) {
    return filesRead(this.ctx, principal, projectId, sessionId, path);
  }
  sessionToolImage(principal: Principal, sessionId: string, hash: string) {
    return sessionToolImage(this.ctx, principal, sessionId, hash);
  }
  symbolsSearch(principal: Principal, projectId: string, sessionId: string | undefined, q: string) {
    return symbolsSearch(this.ctx, principal, projectId, sessionId, q);
  }
  async recover(): Promise<void> {
    this.store.transaction(() => {
      for (const project of this.store.list<Project>('projects'))
        if (project.removed_at === undefined) ensureAgents(this.ctx, project.id);
    });
    recoverWorkspaceProvisioning(this.ctx);
    recoverDiscardBackups(this.ctx);
    await recover(this.ctx);
    // The first list after a start then finds the worktrees read or being read.
    this.prefetchWorktreeReads({ id: USER_PRINCIPAL_ID, role: 'user' }).catch((error) =>
      this.emit('diagnostic', error),
    );
  }
  reconcile(): Promise<void> {
    return reconcile(this.ctx);
  }
  tick(): Promise<void> {
    return tick(this.ctx);
  }
  terminalSubscribe(
    principal: Principal,
    terminalId: string,
    subscriber: (frame: TerminalFrame) => void,
  ): () => void {
    userOnly(principal);
    return this.terminals.subscribe(terminalId, subscriber);
  }
  /** Scans the native transcripts for at most budgetMs and emits 'trace' with the revision when the index changed; the index's progress, undefined without one. */
  async traceScan(
    budgetMs: number,
  ): Promise<{ done_files: number; total_files: number } | undefined> {
    const trace = this.ctx.trace;
    if (!trace) return;
    const progress = await trace.scan(traceProjects(this.ctx), budgetMs);
    if (this.store.transaction(() => recordTraceFindings(this.ctx))) this.ctx.changed();
    // A query's own scan may have read the change in first; compare with what was announced.
    if (trace.revision !== this.announcedTrace) {
      this.announcedTrace = trace.revision;
      this.emit('trace', trace.revision);
    }
    return progress;
  }
  async shutdown(): Promise<void> {
    const ctx = this.ctx;
    ctx.closing = true;
    this.terminals.shutdown();
    await this.search.close();
    stopWorkspaceProvisioning(ctx);
    stopChildProcesses(ctx);
    // A start already in progress must install its handle before storage closes.
    while (ctx.busy) await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.all([...ctx.handles.keys()].map((key) => stopTurn(ctx, key, 'daemon_shutdown')));
    await Promise.allSettled([...ctx.completions]);
    for (const close of ctx.toolRelays.values()) close();
    ctx.toolRelays.clear();
  }
}
