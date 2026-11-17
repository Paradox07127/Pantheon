import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  credentialRole,
  id,
  NATIVE_ENV_ALLOWLIST,
  requireThat,
  type Project,
  type Session,
  type SessionSpec,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { runtime } from './admission.js';
import {
  insert,
  projectAccess,
  revision,
  sessionMcp,
  userOnly,
  sessionAdapter,
  type ControlContext,
  type Handlers,
} from './context.js';
import { sessionDefaults } from './user-config.js';
import { assertNativeSessionFree } from './native-liveness.js';
import { managedSessionSpec } from './native-session.js';
import { inPlaceSandbox } from './protection.js';
import { registerInPlaceWorkspace } from './workspace.js';
import { checkPermissionMode, workerInstructions } from './workbench-session.js';
import { writerTempDirectory } from './workspace-removal.js';

const IN_PLACE_TURN_MS = 6 * 60 * 60 * 1000;
// Either key moves the runtime away from the native home that holds the user's sessions.
const NATIVE_HOME_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

function assertSandbox(ctx: ControlContext): asserts ctx is ControlContext & {
  protectionPaths: NonNullable<ControlContext['protectionPaths']>;
} {
  requireThat(
    ctx.protectionPaths,
    'unsupported_capability',
    'Sessions in the user folder need protected paths for their sandbox',
  );
}

function assertProviderHome(project: Project): void {
  const moved = NATIVE_HOME_KEYS.filter((key) => project.env?.[key] !== undefined);
  requireThat(
    moved.length === 0,
    'invalid_state',
    `The project environment sets ${moved.join(', ')}, which moves the native session home`,
  );
}

function assertFree(
  ctx: ControlContext,
  runtimeName: string,
  nativeId: string,
  ownPids: number[] = [],
): void {
  assertNativeSessionFree({
    runtime: runtimeName,
    native_id: nativeId,
    claudeHome: path.join(ctx.protectionPaths!.home, '.claude'),
    readProcess: ctx.readProcess,
    ownPids,
  });
}

/** Refuses a turn for the session's live process while a process outside Pantheon holds its native session. */
export function assertInPlaceSessionFree(ctx: ControlContext, session: Session): void {
  if (!session.native_id) return;
  assertFree(
    ctx,
    session.runtime,
    session.native_id,
    session.process_identity ? [session.process_identity.pid] : [],
  );
}

/** The spec of a session that continues the user's native session in the user's own folder. */
export async function inPlaceSessionSpec(
  ctx: ControlContext,
  session: Session,
): Promise<SessionSpec> {
  assertSandbox(ctx);
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!),
    project = ctx.store.must<Project>('projects', session.project_id);
  requireThat(workspace.kind === 'in_place', 'invalid_state', 'Session is not in the user folder');
  assertProviderHome(project);
  assertInPlaceSessionFree(ctx, session);
  const temporary = writerTempDirectory(workspace.id);
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const sandbox = await inPlaceSandbox({
    ...ctx.protectionPaths,
    projectRoot: workspace.source!,
    tempDir: temporary,
    otherWorkspaces: ctx.store
      .list<Workspace>('workspaces')
      .filter((other) => other.project_id === project.id && other.kind === 'linked_worktree')
      .map((other) => other.path),
  });
  const questionTool = sessionAdapter(ctx, session)?.questionTool;
  const saved = project.extension_overrides?.[session.runtime];
  return managedSessionSpec(ctx, {
    platform_session_id: session.id,
    project_id: project.id,
    runtime: session.runtime,
    model: session.requested_model,
    effort: session.requested_effort,
    profile_version: session.profile_version,
    account_ref: session.account_ref,
    role: 'writer',
    control_instructions: [
      session.in_place
        ? `You are working in the project folder at ${workspace.path}, on its current branch. Commit your changes there; Pantheon runs the gates in this folder, and the session lands once they pass on the commit you leave. Do not write files outside the project folder.`
        : `You are working for the user in their own folder at ${workspace.path}, inside the project folder ${workspace.source}. Your changes land directly on its current branch; there is no merge gate. Do not write files outside the project folder.`,
      ...(session.task ? [workerInstructions(ctx, session.task, questionTool)] : []),
      ...(questionTool
        ? [
            `When the user must decide or answer something, ask with the ${questionTool} tool instead of asking in plain text. Give 2 to 4 short options with the one you recommend first; the user can also type an answer of their own.`,
          ]
        : []),
    ].join('\n\n'),
    workspace: { id: workspace.id, path: workspace.path },
    env: { TMPDIR: temporary },
    sandbox: {
      writable_roots: sandbox.writable_roots,
      protected_entries: sandbox.protected_entries.map(({ path, deny }) => ({ path, deny })),
    },
    cwd: workspace.path,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    pantheon_mcp: sessionMcp(ctx, session, credentialRole(session, workspace.kind)),
    extensions: {
      mode: 'inherit',
      // User-level MCP servers, skills and account connectors stay off until the project opens them.
      overrides: {
        disabled_mcp_servers: [],
        disabled_plugins: [],
        disabled_skills: [],
        disable_hooks: false,
        ...saved,
        disable_apps:
          session.enabled_user_connectors !== undefined
            ? !session.enabled_user_connectors.length
            : saved?.disable_apps === true || !saved?.enabled_user_connectors?.length,
        enabled_user_mcp_servers: saved?.enabled_user_mcp_servers ?? [],
        enabled_user_skills: saved?.enabled_user_skills ?? [],
        enabled_user_connectors:
          session.enabled_user_connectors ?? saved?.enabled_user_connectors ?? [],
      },
    },
    device_id: session.device_id ?? 'local',
    budget: { max_turns: 1, wall_time_ms: ctx.turnWallTimeMs ?? IN_PLACE_TURN_MS },
    permission_mode: session.permission_mode ?? 'ask',
    ...(session.fast ? { fast: true as const } : {}),
    ...(session.ultracode ? { ultracode: true as const } : {}),
    ...(session.allowed_rules ? { allowed_rules: session.allowed_rules } : {}),
  });
}

export const inPlaceSessionHandlers: Handlers = {
  'session.adopt': (ctx, p, c) => {
    userOnly(p);
    const cause = c.command_id,
      input = inputSchemas['session.adopt'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    revision(ctx, c);
    const project = ctx.store.must<Project>('projects', input.project_id);
    checkPermissionMode(
      input.runtime,
      input.permission_mode ?? sessionDefaults(ctx, project)?.permission_mode ?? 'ask',
      p,
    );
    requireThat(ctx.trace, 'unsupported_capability', 'Native transcripts are not indexed');
    const record = ctx.trace
      .lanes(project.id)
      .find(
        ({ lane }) => lane.runtime === input.runtime && lane.native_id === input.native_session_id,
      )?.lane;
    requireThat(
      record,
      'not_found',
      `Not found: ${input.runtime} session ${input.native_session_id} in this project`,
    );
    const taken = ctx.store
      .list<Session>('sessions')
      .find(
        (session) =>
          session.runtime === input.runtime && session.native_id === input.native_session_id,
      );
    requireThat(!taken, 'resource_busy', `The native session is already session ${taken?.id}`);
    runtime(ctx, input.runtime, 'writer');
    assertSandbox(ctx);
    assertProviderHome(project);
    assertFree(ctx, input.runtime, input.native_session_id);
    const workspace = registerInPlaceWorkspace(
      ctx,
      { project_id: project.id, cwd: record.cwd },
      cause,
    );
    const session = insert<Session>(
      ctx,
      'sessions',
      {
        project_id: project.id,
        runtime: input.runtime,
        device_id: 'local',
        id: id(),
        revision: 1,
        native_id: input.native_session_id,
        // No first input: a new session that already has a native id would look interrupted.
        state: 'open',
        turn_count: 0,
        workspace_id: workspace.id,
        permission_mode:
          input.permission_mode ?? sessionDefaults(ctx, project)?.permission_mode ?? 'ask',
        title: input.title ?? record.title,
      },
      'session.opened',
      project.id,
      cause,
    );
    ctx.store.event(
      'session.adopted',
      session,
      project.id,
      { runtime: input.runtime, native_id: input.native_session_id, cwd: workspace.path },
      cause,
    );
    return session;
  },
};
