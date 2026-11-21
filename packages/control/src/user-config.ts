import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError, requireThat, type Project, type SessionDefaults } from '@pantheon/domain';
import {
  userConfigSchema,
  type BackendProfile,
  type BackendSummary,
  type UserConfig,
} from '@pantheon/protocol';
import type { ControlContext } from './context.js';

const RUNTIME_FAMILIES: [RegExp, string][] = [
  [/^claude-/, 'claude'],
  [/^(gpt-|o\d)/, 'codex'],
  [/^deepseek-/, 'dsh'],
  [/^qwen/, 'qwen'],
  [/^kimi-/, 'kimi'],
  [/^muse-/, 'muse'],
];

/** Reads `<dir>/config.json` on every call; no directory or no file is an empty configuration. */
export function readUserConfig(dir: string | undefined): UserConfig {
  const file = dir === undefined ? undefined : path.join(dir, 'config.json');
  if (file === undefined || !existsSync(file))
    return { version: 1, backends: [], model_families: {} };
  try {
    return userConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new DomainError('invalid_user_config', `Invalid ${file}: ${(error as Error).message}`);
  }
}

/** The binary and extra arguments the runtime starts with; empty uses the one on PATH. */
export function runtimeConfig(
  dir: string | undefined,
  runtime: string,
): { binary?: string; args?: string[]; enabled?: boolean; artifacts?: boolean } {
  return readUserConfig(dir).runtimes?.[runtime] ?? {};
}

/** Whether opening a folder that is not a git repository runs git init in it; on by default. */
export function autoGitInit(dir: string | undefined): boolean {
  return readUserConfig(dir).auto_git_init ?? true;
}

export type ProjectDefaults = NonNullable<UserConfig['project_defaults']>;

/** The values every project follows where it has none of its own. */
export function projectDefaults(dir: string | undefined): ProjectDefaults {
  const defaults = readUserConfig(dir).project_defaults ?? {};
  if (defaults.workflow_policy?.improvement_mode === undefined) return defaults;
  // No longer used; a stored value is ignored.
  const { improvement_mode: _unused, ...workflow_policy } = defaults.workflow_policy;
  return { ...defaults, workflow_policy };
}

/** The project's session defaults, else the global ones; undefined leaves the composer's own default. */
export function sessionDefaults(
  ctx: Pick<ControlContext, 'userConfigDir'>,
  project: Project,
): SessionDefaults | undefined {
  return project.session_defaults ?? projectDefaults(ctx.userConfigDir).session_defaults;
}

/** The global token targets with the project's own ones over them. */
export function usageTargets(
  ctx: Pick<ControlContext, 'userConfigDir'>,
  project: Project,
): Record<string, number> {
  return { ...projectDefaults(ctx.userConfigDir).usage_targets, ...project.usage_targets };
}

export function autoMerge(ctx: Pick<ControlContext, 'userConfigDir'>, project: Project): boolean {
  return project.auto_merge ?? projectDefaults(ctx.userConfigDir).auto_merge ?? false;
}

export function externalEvents(
  ctx: Pick<ControlContext, 'userConfigDir'>,
  project: Project,
): 'off' | 'approve' | 'auto' {
  return project.external_events ?? projectDefaults(ctx.userConfigDir).external_events ?? 'off';
}

export function userConfigDirectory(ctx: Pick<ControlContext, 'userConfigDir'>): string {
  requireThat(
    ctx.userConfigDir !== undefined,
    'unsupported_capability',
    'This daemon has no user configuration directory',
  );
  return ctx.userConfigDir;
}

/** Merges the patch into `<dir>/config.json`, keeping the user's other keys and their order. */
export function writeUserConfig(dir: string, patch: Partial<UserConfig>): void {
  const file = path.join(dir, 'config.json');
  let current: Record<string, unknown> = { version: 1 };
  try {
    if (existsSync(file)) current = JSON.parse(readFileSync(file, 'utf8')) as typeof current;
  } catch (error) {
    throw new DomainError('invalid_user_config', `Invalid ${file}: ${(error as Error).message}`);
  }
  const next = { ...current, ...patch };
  const checked = userConfigSchema.safeParse(next);
  if (!checked.success)
    throw new DomainError('invalid_user_config', `Invalid ${file}: ${checked.error.message}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The runtime a model belongs to: the longest matching configured prefix, then the built-in families. */
export function homeRuntime(model: string, families: Record<string, string>): string | undefined {
  const prefix = Object.keys(families)
    .filter((candidate) => model.startsWith(candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix !== undefined) return families[prefix];
  return RUNTIME_FAMILIES.find(([pattern]) => pattern.test(model))?.[1];
}

/** The configured backend `id`, checked against the protocols the runtime can send to. */
export function backendProfile(ctx: ControlContext, runtime: string, id: string): BackendProfile {
  const profile = readUserConfig(ctx.userConfigDir).backends.find((backend) => backend.id === id);
  requireThat(profile, 'invalid_input', `Unknown backend ${id}`);
  requireThat(
    ctx.adapters.get(runtime)?.backendProtocols?.includes(profile.protocol),
    'unsupported_capability',
    `Runtime ${runtime} cannot send to a ${profile.protocol} backend`,
  );
  return profile;
}

/** The configured backends; a keychain key is not read, since reading it may prompt the user. */
export function backendList(ctx: ControlContext): BackendSummary[] {
  return readUserConfig(ctx.userConfigDir).backends.map((profile) => ({
    id: profile.id,
    protocol: profile.protocol,
    base_url: profile.base_url,
    models: profile.models ?? [],
    runtimes: [...ctx.adapters]
      .filter(([, adapter]) => adapter.backendProtocols?.includes(profile.protocol))
      .map(([runtime]) => runtime),
    ...('env' in profile.key
      ? { key: { env: profile.key.env }, key_present: !!process.env[profile.key.env] }
      : { key: { keychain: profile.key.keychain } }),
  }));
}

/** The backend's API key; error messages name where it was looked up, never its value. */
export function backendKey(
  profile: BackendProfile,
  env: NodeJS.ProcessEnv = process.env,
  keychain: (service: string) => string = readKeychain,
): string {
  if ('env' in profile.key) {
    const value = env[profile.key.env];
    if (!value)
      throw new DomainError(
        'backend_key_missing',
        `Backend ${profile.id}: environment variable ${profile.key.env} is not set`,
      );
    return value;
  }
  const service = profile.key.keychain;
  let value = '';
  try {
    value = keychain(service);
  } catch {
    // The keychain tool's own message is dropped in case it quotes the item.
  }
  if (!value)
    throw new DomainError(
      'backend_key_missing',
      process.platform === 'darwin'
        ? `Backend ${profile.id}: no keychain password for service ${service}`
        : `Backend ${profile.id}: keychain keys are read only on macOS; set key.env for service ${service}`,
    );
  return value;
}

function readKeychain(service: string): string {
  if (process.platform !== 'darwin') return '';
  return execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
  }).trim();
}
