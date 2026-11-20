import path from 'node:path';
import {
  hash,
  INHERITED_ENV_DENYLIST,
  NATIVE_ENV_ALLOWLIST,
  type ExtensionOverrides,
  type Project,
  type ProjectBrief,
  type Session,
  type SessionSpec,
  type Workspace,
} from '@pantheon/domain';
import { inside, type ControlContext } from './context.js';
import { backendKey, backendProfile } from './user-config.js';

function title(ctx: ControlContext, session: Session): string {
  const project = ctx.store.must<Project>('projects', session.project_id);
  const purpose = session.runtime_review
    ? 'Runtime analysis'
    : session.baseline
      ? 'Baseline assessment'
      : session.change_story
        ? 'Change story'
        : session.range_story
          ? 'Range story'
          : session.review_id
            ? 'Review'
            : 'Project conversation';
  const goal = ctx.store.get<ProjectBrief>('project_briefs', project.id)?.goal;
  return [project.name, purpose, goal]
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

/** The daemon variables a session the user opened inherits, as the bare runtime started from a shell would. */
export function inheritedEnvAllowlist(project: Project): string[] {
  const denied = (name: string) =>
    INHERITED_ENV_DENYLIST.some((entry) =>
      entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry,
    );
  // An inherited variable would override the project's value, which only the allowlist may do.
  return Object.keys(process.env).filter(
    (name) =>
      !denied(name) && (NATIVE_ENV_ALLOWLIST.includes(name) || project.env?.[name] === undefined),
  );
}

/**
 * User-level MCP servers, skills and account connectors: a session the user opened loads them as
 * the user's configuration does; any other session gets only those the project opened.
 */
export function sessionExtensions(
  session: Session,
  saved: ExtensionOverrides | undefined,
  userSession: boolean,
): NonNullable<SessionSpec['extensions']> {
  if (userSession)
    return {
      mode: 'inherit',
      overrides: {
        disabled_mcp_servers: saved?.disabled_mcp_servers ?? [],
        disabled_plugins: saved?.disabled_plugins ?? [],
        disabled_skills: saved?.disabled_skills ?? [],
        disable_hooks: saved?.disable_hooks ?? false,
        disable_apps:
          session.enabled_user_connectors !== undefined
            ? !session.enabled_user_connectors.length
            : saved?.disable_apps === true,
        ...(session.enabled_user_connectors
          ? { enabled_user_connectors: session.enabled_user_connectors }
          : {}),
      },
    };
  return {
    mode: 'inherit',
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
  };
}

/** Persist the native store selection before launch; legacy native IDs keep their original store. */
export function managedSessionSpec(ctx: ControlContext, spec: SessionSpec): SessionSpec {
  const session = ctx.store.must<Session>('sessions', spec.platform_session_id);
  const root = path.resolve(path.dirname(ctx.files.directory), 'native-sessions');
  const segment = (value: string) => (/^[a-zA-Z0-9_-]+$/.test(value) ? value : hash(value));
  // A session in the user's own folder continues the user's native session in the provider home,
  // under the user's own title.
  const inPlace =
    session.workspace_id !== undefined &&
    ctx.store.get<Workspace>('workspaces', session.workspace_id)?.kind === 'in_place';
  // A session the user opened starts in the provider home, so the CLI's own resume finds it.
  const native_state_dir = inPlace
    ? undefined
    : (session.native_state_dir ??
      (session.native_id || session.native_fork || spec.user_session
        ? undefined
        : path.join(root, segment(session.project_id), segment(session.runtime))));
  const native_title = inPlace
    ? undefined
    : (session.native_title ?? (spec.auto_title ? undefined : title(ctx, session)));
  if (session.native_state_dir !== native_state_dir || session.native_title !== native_title)
    ctx.store.transaction(() => {
      const current = ctx.store.must<Session>('sessions', session.id);
      const next = ctx.store.update(
        'sessions',
        { ...current, native_state_dir, native_title },
        current.revision,
      );
      ctx.store.event('session.native_history_selected', next, session.project_id, {
        mode: native_state_dir ? 'managed' : 'legacy',
        title: native_title,
      });
    });
  const project = ctx.store.must<Project>('projects', session.project_id);
  const sandbox = spec.sandbox;
  const profile = session.backend_id
    ? backendProfile(ctx, session.runtime, session.backend_id)
    : undefined;
  return {
    ...spec,
    ...(session.native_fork ? { native_fork: session.native_fork } : {}),
    ...(profile
      ? {
          backend: {
            id: profile.id,
            protocol: profile.protocol,
            base_url: profile.base_url,
            api_key: backendKey(profile),
          },
        }
      : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(project.env ? { env: { ...project.env, ...spec.env } } : {}),
    native_state_dir,
    native_title,
    ...(ctx.userConfigDir ? { user_config_dir: ctx.userConfigDir } : {}),
    // A sandbox enables native tool capabilities. History isolation must never
    // create that authority for a deliberately tool-free session.
    ...(native_state_dir && sandbox
      ? {
          sandbox: {
            writable_roots: sandbox.writable_roots,
            protected_entries: [
              ...(sandbox.protected_entries ?? []),
              { path: root, deny: 'read_write' as const },
              ...(!inside(root, native_state_dir)
                ? [{ path: native_state_dir, deny: 'read_write' as const }]
                : []),
            ],
          },
        }
      : {}),
  };
}
