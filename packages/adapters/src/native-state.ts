import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainError, type SessionSpec } from '@pantheon/domain';

type NativeRuntime = 'claude' | 'codex' | 'agy' | 'grok';
const homes: Record<NativeRuntime, string> = {
  claude: '.claude',
  codex: '.codex',
  agy: '.gemini',
  grok: '.grok',
};
/** The user-level skill folders agy reads without `--gemini-dir`. */
export const agySkillDirs = (home: string) => [
  path.join(home, '.gemini', 'config', 'skills'),
  path.join(home, '.agents', 'skills'),
];
const inherited: Record<NativeRuntime, readonly string[]> = {
  agy: [],
  grok: ['config.toml'],
  codex: [
    'config.toml',
    'auth.json',
    '.credentials.json',
    'AGENTS.md',
    'rules',
    'skills',
    'plugins',
    'packages',
    'hooks.json',
    'hooks',
    '.hook-trust',
    '.tmp/bundled-marketplaces',
    '.tmp/plugins',
    '.tmp/marketplaces',
  ],
  claude: [
    'settings.json',
    'settings.local.json',
    'CLAUDE.md',
    'agents',
    'commands',
    'skills',
    'plugins',
    'hooks',
  ],
};

/** Deliberately excludes sessions, history, SQLite databases, and app activity state.
 * Configuration is privately snapshotted; native account credentials and installed
 * capabilities retain source references. Settings and credential values are never logged.
 */
export function prepareNativeState(
  runtime: NativeRuntime,
  spec: Pick<SessionSpec, 'native_state_dir' | 'project_id' | 'user_config_dir' | 'extensions'> & {
    cwd?: string;
  },
  home = os.homedir(),
): { env: NodeJS.ProcessEnv; args: string[] } {
  if (!spec.native_state_dir) return { env: {}, args: [] }; // Explicit legacy-store resume.
  const root = spec.native_state_dir;
  const source = path.join(home, homes[runtime]);
  if (
    !path.isAbsolute(root) ||
    root.includes('\0') ||
    root === source ||
    root.startsWith(source + path.sep)
  )
    throw new DomainError(
      'invalid_native_state',
      'Native state must use a separate absolute managed directory',
    );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (
    lstatSync(root).isSymbolicLink() ||
    !lstatSync(root).isDirectory() ||
    (existsSync(source) &&
      (realpathSync(root) === realpathSync(source) ||
        realpathSync(root).startsWith(realpathSync(source) + path.sep)))
  )
    throw new DomainError('invalid_native_state', 'Native state must not alias the provider home');
  const marker = path.join(root, '.pantheon-native-state.json');
  const identity = { schema: 1, runtime, project_id: spec.project_id, source_home: source };
  if (existsSync(marker)) {
    if (JSON.stringify(JSON.parse(readFileSync(marker, 'utf8'))) !== JSON.stringify(identity))
      throw new DomainError(
        'invalid_native_state',
        'Native state belongs to another project or runtime',
      );
  } else {
    if (readdirSync(root).length)
      throw new DomainError(
        'invalid_native_state',
        'Refusing to adopt an unowned native state directory',
      );
    writeFileSync(marker, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  }
  const link = (name: string, from = path.join(source, name)) => {
    if (!existsSync(from)) return;
    const to = path.join(root, name);
    const existing = lstatSync(to, { throwIfNoEntry: false });
    if (existing) {
      // A native-populated marketplace cache stays; replacing it could discard local capability state.
      if (name === '.tmp/marketplaces' && existing.isDirectory() && !existing.isSymbolicLink())
        return;
      if (!existing.isSymbolicLink() || path.resolve(root, readlinkSync(to)) !== from)
        throw new DomainError(
          'invalid_native_state',
          `Managed native configuration reference changed: ${name}`,
        );
      return;
    }
    mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    symlinkSync(from, to, lstatSync(from).isDirectory() ? 'dir' : 'file');
  };
  const config = (
    name: string,
    from = path.join(source, name),
    transform?: (value: string) => string,
  ) => {
    if (!existsSync(from)) return;
    const to = path.join(root, name);
    const existing = lstatSync(to, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw new DomainError(
        'invalid_native_state',
        `Managed native configuration is not a regular file: ${name}`,
      );
    const value = readFileSync(from, 'utf8');
    writeFileSync(to, transform ? transform(value) : value, { mode: 0o600 });
  };
  // Sessions of one project and runtime share this directory, so a session without
  // extension settings keeps what an earlier one projected.
  const overrides = spec.extensions?.mode === 'inherit' ? spec.extensions.overrides : undefined;
  const opened = (list: string[] | undefined, id: string, disabled: string[] = []) =>
    (!list || list.includes(id)) && !disabled.includes(id);
  // Neither runtime has a plugin switch Pantheon can set for one session.
  const plugin = (runtime === 'agy' || runtime === 'grok') && overrides?.disabled_plugins[0];
  if (plugin)
    throw new DomainError(
      'invalid_user_config',
      `${runtime} cannot turn off the plugin ${plugin} the project disabled; turn it back on for ${runtime} in Settings > Extensions > Plugins`,
    );
  // grok layers the user config.toml above managed_config.toml, so these keys would undo it.
  const userConfig = path.join(source, 'config.toml');
  if (runtime === 'grok' && existsSync(userConfig)) {
    let table = '';
    for (const line of readFileSync(userConfig, 'utf8').split('\n')) {
      const header = /^\s*\[\[?\s*([\w.-]+)\s*\]/.exec(line)?.[1];
      if (header !== undefined) table = header;
      const key = /^\s*([\w.-]+)\s*=/.exec(line)?.[1];
      const name = header ?? (key && (table ? `${table}.${key}` : key));
      if (
        name &&
        [
          'allowed_mcp_servers',
          'denied_mcp_servers',
          'allow_managed_hooks_only',
          'skills.ignore',
        ].includes(name)
      )
        throw new DomainError(
          'invalid_user_config',
          `${userConfig} sets ${name}, which would override the managed grok configuration`,
        );
    }
  }
  const user = runtime === 'agy' || runtime === 'grok' ? undefined : spec.user_config_dir;
  const projected = user ? ['CLAUDE.md', 'AGENTS.md', 'skills'] : ['skills'];
  const copied = ['config.toml', 'hooks.json', 'settings.json', 'settings.local.json'];
  for (const name of inherited[runtime])
    if (copied.includes(name) && !existsSync(path.join(source, name)))
      // A deleted user file must take its hooks and settings out of the managed copy.
      rmSync(path.join(root, name), { force: true });
    else if (runtime === 'claude' && name === 'settings.json')
      config(name, undefined, (text) =>
        JSON.stringify({ ...JSON.parse(text), syncClaudeAiSkills: false }),
      );
    else if (copied.includes(name)) config(name);
    else if (!projected.includes(name)) link(name);
  if (runtime === 'claude' && !existsSync(path.join(root, 'settings.json')))
    writeFileSync(path.join(root, 'settings.json'), '{"syncClaudeAiSkills":false}', {
      mode: 0o600,
    });
  // Earlier stores linked these entries straight to the provider home.
  for (const name of projected) {
    const to = path.join(root, name);
    if (!lstatSync(to, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
    if (path.resolve(root, readlinkSync(to)) !== path.join(source, name))
      throw new DomainError(
        'invalid_native_state',
        `Managed native configuration reference changed: ${name}`,
      );
    unlinkSync(to);
  }
  if (user) {
    const instructions = [
      path.join(user, 'AGENTS.md'),
      path.join(source, runtime === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'),
    ].filter((file) => existsSync(file));
    if (runtime === 'claude')
      writeFileSync(
        path.join(root, 'CLAUDE.md'),
        instructions.map((file) => `@${file.replaceAll(' ', '\\ ')}\n`).join(''),
        { mode: 0o600 },
      );
    else if (instructions.length)
      writeFileSync(
        path.join(root, 'AGENTS.md'),
        instructions.map((file) => readFileSync(file, 'utf8')).join('\n\n'),
        { mode: 0o600 },
      );
    else rmSync(path.join(root, 'AGENTS.md'), { force: true });
  }
  const skills = path.join(root, runtime === 'agy' ? 'config/skills' : 'skills');
  mkdirSync(skills, { recursive: true, mode: 0o700 });
  // Claude and agy name a skill by its directory, Codex by the real path of its SKILL.md.
  const skillId = (from: string) => {
    const file = path.join(from, 'SKILL.md');
    return runtime !== 'codex' ? path.basename(from) : existsSync(file) ? realpathSync(file) : file;
  };
  const wanted = new Map<string, string>();
  for (const dir of runtime === 'agy'
    ? agySkillDirs(home)
    : runtime === 'grok'
      ? [path.join(source, 'skills'), path.join(home, '.claude', 'skills')]
      : [path.join(source, 'skills'), ...(user ? [path.join(user, 'skills')] : [])])
    if (existsSync(dir))
      for (const name of readdirSync(dir)) {
        const from = path.join(dir, name);
        const to = path.join(skills, name);
        if (
          !name.startsWith('.') &&
          !((runtime === 'claude' || runtime === 'grok') && name === 'synced') &&
          statSync(from, { throwIfNoEntry: false })?.isDirectory() &&
          (overrides
            ? opened(
                overrides.enabled_user_skills,
                skillId(from),
                runtime === 'agy' || runtime === 'grok' ? overrides.disabled_skills : [],
              )
            : lstatSync(to, { throwIfNoEntry: false })?.isSymbolicLink() &&
              readlinkSync(to) === from)
        )
          wanted.set(name, from);
      }
  // Only links are managed here; real entries such as Codex's own .system stay untouched.
  for (const entry of readdirSync(skills, { withFileTypes: true }))
    if (
      !entry.name.startsWith('.') &&
      entry.isSymbolicLink() &&
      readlinkSync(path.join(skills, entry.name)) !== wanted.get(entry.name)
    )
      unlinkSync(path.join(skills, entry.name));
  for (const [name, from] of wanted)
    if (!lstatSync(path.join(skills, name), { throwIfNoEntry: false }))
      symlinkSync(from, path.join(skills, name), 'dir');
  if (runtime === 'grok') {
    const managedConfig = path.join(root, 'managed_config.toml');
    if (overrides || !existsSync(managedConfig)) {
      let project: string[] = [];
      try {
        if (spec.cwd)
          project = Object.keys(
            (
              JSON.parse(readFileSync(path.join(spec.cwd, '.mcp.json'), 'utf8')) as {
                mcpServers?: object;
              }
            ).mcpServers ?? {},
          );
      } catch {
        // Without a readable project MCP file only the opened user servers are allowed.
      }
      // grok also reads project servers from each .grok/config.toml up to the repository root.
      const chain: string[] = [];
      for (let dir = spec.cwd; dir && !chain.includes(dir); dir = path.dirname(dir)) {
        chain.push(dir);
        if (existsSync(path.join(dir, '.git'))) break;
      }
      // Outside a repository only the working folder's file counts.
      const repo = existsSync(path.join(chain.at(-1) ?? '', '.git')) ? chain : chain.slice(0, 1);
      for (const dir of repo.filter((dir) => dir !== home)) {
        const file = path.join(dir, '.grok', 'config.toml');
        if (existsSync(file))
          for (const line of readFileSync(file, 'utf8').split('\n')) {
            const name = /^\s*\[\s*mcp_servers\.("?)([\w-]+)\1\s*[.\]]/.exec(line)?.[2];
            if (name && !project.includes(name)) project.push(name);
          }
      }
      const servers = overrides?.enabled_user_mcp_servers;
      // grok reads ~/.agents/skills in place and cannot load a link into an ignored folder, so each
      // unopened skill folder is ignored by its own path.
      const agents = path.join(home, '.agents', 'skills');
      const ignored = overrides
        ? (existsSync(agents) ? readdirSync(agents) : [])
            .filter(
              (name) =>
                !name.startsWith('.') &&
                !opened(overrides.enabled_user_skills, name, overrides.disabled_skills),
            )
            .map((name) => path.join(agents, name))
        : [agents];
      // The allowlist also blocks project servers, so it names those too.
      // A JSON string is a valid TOML basic string.
      const named = (names: string[]) =>
        names.map((name) => `{ server_name = ${JSON.stringify(name)} }`).join(', ');
      const lines = [
        // Opening every user server leaves no allowlist, so the disabled ones are denied by name.
        ...(overrides && !servers
          ? overrides.disabled_mcp_servers.length
            ? [`denied_mcp_servers = [${named(overrides.disabled_mcp_servers)}]`]
            : []
          : [
              `allowed_mcp_servers = [${named(
                [...(servers ?? []), ...project].filter(
                  (name) => !overrides?.disabled_mcp_servers.includes(name),
                ),
              )}]`,
            ]),
        ...(overrides?.disable_hooks ? ['allow_managed_hooks_only = true'] : []),
        '[skills]',
        `ignore = [${ignored.map((dir) => JSON.stringify(dir)).join(', ')}]`,
      ];
      writeFileSync(managedConfig, lines.map((line) => `${line}\n`).join(''), { mode: 0o600 });
    }
    return {
      env: {
        GROK_HOME: root,
        GROK_AUTH_PATH: path.join(source, 'auth.json'),
        GROK_CLAUDE_SKILLS_ENABLED: 'false',
        GROK_CURSOR_SKILLS_ENABLED: 'false',
        GROK_CURSOR_MCPS_ENABLED: 'false',
      },
      args: [],
    };
  }
  if (runtime === 'agy') {
    config('config/config.json');
    const managedServers = path.join(root, 'config/mcp_config.json');
    const earlier =
      !overrides && existsSync(managedServers)
        ? Object.keys(
            (JSON.parse(readFileSync(managedServers, 'utf8')) as { mcpServers?: object })
              .mcpServers ?? {},
          )
        : [];
    if (existsSync(path.join(source, 'config/mcp_config.json')))
      config('config/mcp_config.json', undefined, (text) => {
        const value = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
        return JSON.stringify({
          ...value,
          mcpServers: Object.fromEntries(
            Object.entries(value.mcpServers ?? {}).filter(([name]) =>
              overrides
                ? opened(overrides.enabled_user_mcp_servers, name, overrides.disabled_mcp_servers)
                : earlier.includes(name),
            ),
          ),
        });
      });
    else writeFileSync(managedServers, '{"mcpServers":{}}', { mode: 0o600 });
    return { env: {}, args: ['--gemini-dir', root] };
  }
  if (runtime === 'claude') {
    const managedConfig = path.join(root, '.claude.json');
    const earlier = new Set<string>();
    if (!overrides && existsSync(managedConfig)) {
      const value = JSON.parse(readFileSync(managedConfig, 'utf8')) as {
        mcpServers?: object;
        projects?: Record<string, { mcpServers?: object }>;
      };
      for (const servers of [
        value.mcpServers,
        ...Object.values(value.projects ?? {}).map((settings) => settings.mcpServers),
      ])
        for (const name of Object.keys(servers ?? {})) earlier.add(name);
    }
    const servers = (value: unknown) =>
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([name]) =>
          overrides ? opened(overrides.enabled_user_mcp_servers, name) : earlier.has(name),
        ),
      );
    config('.claude.json', path.join(home, '.claude.json'), (text) => {
      const value = JSON.parse(text) as Record<string, unknown>;
      const selected = Object.fromEntries(
        [
          'mcpServers',
          'oauthAccount',
          'userID',
          'hasCompletedOnboarding',
          'claudeAiMcpEverConnected',
          'claudeInChromeDefaultEnabled',
          'hasCompletedClaudeInChromeOnboarding',
        ].flatMap((key) => (key in value ? [[key, value[key]]] : [])),
      );
      if ('mcpServers' in selected) selected.mcpServers = servers(selected.mcpServers);
      // Project configuration contains last prompts, session IDs and metrics as well
      // as settings. Inherit only configuration, never that activity/history payload.
      if (value.projects && typeof value.projects === 'object')
        selected.projects = Object.fromEntries(
          Object.entries(value.projects).map(([cwd, settings]) => [
            cwd,
            Object.fromEntries(
              Object.entries(settings as Record<string, unknown>)
                .filter(([key]) =>
                  [
                    'allowedTools',
                    'disabledMcpServers',
                    'disabledMcpjsonServers',
                    'enabledMcpServers',
                    'enabledMcpjsonServers',
                    'mcpServers',
                    'hasTrustDialogAccepted',
                    'hasClaudeMdExternalIncludesApproved',
                  ].includes(key),
                )
                .map(([key, entry]) => [key, key === 'mcpServers' ? servers(entry) : entry]),
            ),
          ]),
        );
      return JSON.stringify(selected);
    });
    // Installed Claude 2.1.312 interprets empty secure-storage override as the
    // original default keychain/file credential slot, independent of config home.
    return { env: { CLAUDE_CONFIG_DIR: root, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, args: [] };
  }
  return {
    env: { CODEX_HOME: root },
    args: [
      '-c',
      `sqlite_home=${JSON.stringify(path.join(root, 'sqlite'))}`,
      '-c',
      `log_dir=${JSON.stringify(path.join(root, 'logs'))}`,
      '-c',
      'history.persistence="none"',
      // Native bundled marketplace discovery requires a path rooted in CODEX_HOME.
      // The managed path references the exact installed catalog, not another copy.
      ...(existsSync(path.join(source, '.tmp/bundled-marketplaces/openai-bundled'))
        ? [
            '-c',
            `marketplaces.openai-bundled.source=${JSON.stringify(path.join(root, '.tmp/bundled-marketplaces/openai-bundled'))}`,
          ]
        : []),
    ],
  };
}

export function nativeSessionTitle(
  spec: Pick<SessionSpec, 'native_title' | 'role' | 'platform_session_id'>,
): string {
  const text = spec.native_title?.replace(/[\r\n\t]+/g, ' ').trim();
  return (text || `Pantheon · ${spec.role} · ${spec.platform_session_id.slice(0, 8)}`).slice(
    0,
    200,
  );
}
