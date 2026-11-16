import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  existsSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  nativeSessionTitle,
  prepareNativeState,
} from '../../packages/adapters/src/native-state.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-state-'));
  roots.push(root);
  const home = path.join(root, 'home');
  mkdirSync(home);
  return { root, home };
}
/** A home with a space in its path, provider instructions and skills, and user-level ones. */
function userFixture() {
  const { root } = fixture();
  const home = path.join(root, 'user home');
  const user = path.join(home, '.pantheon');
  const claude = path.join(home, '.claude');
  const codex = path.join(home, '.codex');
  for (const dir of [claude, codex])
    for (const name of ['a', 'b']) mkdirSync(path.join(dir, 'skills', name), { recursive: true });
  for (const name of ['b', 'c']) mkdirSync(path.join(user, 'skills', name), { recursive: true });
  mkdirSync(path.join(claude, 'skills', '.trash'));
  writeFileSync(path.join(claude, 'CLAUDE.md'), 'claude instructions');
  writeFileSync(path.join(codex, 'AGENTS.md'), 'codex instructions');
  writeFileSync(path.join(user, 'AGENTS.md'), 'pantheon instructions');
  const spec = (runtime: string, withUser = true) => ({
    project_id: 'project',
    native_state_dir: path.join(root, `managed-${runtime}`),
    extensions: opened({}),
    ...(withUser ? { user_config_dir: user } : {}),
  });
  return { root, home, user, claude, codex, spec };
}
const regularFile = (file: string) => {
  const stat = lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink();
};
const realDirectory = (dir: string) => {
  const stat = lstatSync(dir);
  return stat.isDirectory() && !stat.isSymbolicLink();
};
const links = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((name) => lstatSync(path.join(dir, name)).isSymbolicLink())
      .sort()
      .map((name) => [name, readlinkSync(path.join(dir, name))]),
  );
const escaped = (file: string) => file.replaceAll(' ', '\\ ');
const opened = (lists: {
  enabled_user_mcp_servers?: string[];
  enabled_user_skills?: string[];
}) => ({
  mode: 'inherit' as const,
  overrides: {
    disabled_mcp_servers: [],
    disabled_plugins: [],
    disabled_skills: [],
    disable_apps: false,
    disable_hooks: false,
    ...lists,
  },
});
describe('user-level extensions the project opened', () => {
  it('projects only the opened Claude MCP servers, also after the user adds one', () => {
    const { root, home } = fixture();
    mkdirSync(path.join(home, '.claude'));
    const write = (names: string[]) => {
      const servers = Object.fromEntries(names.map((name) => [name, { command: name }]));
      writeFileSync(
        path.join(home, '.claude.json'),
        JSON.stringify({ mcpServers: servers, projects: { '/work': { mcpServers: servers } } }),
      );
    };
    write(['a', 'b']);
    const managed = path.join(root, 'managed');
    const spec = {
      project_id: 'project',
      native_state_dir: managed,
      extensions: opened({ enabled_user_mcp_servers: ['a'], enabled_user_skills: [] }),
    };
    const projected = () => JSON.parse(readFileSync(path.join(managed, '.claude.json'), 'utf8'));
    prepareNativeState('claude', spec, home);
    expect(projected()).toEqual({
      mcpServers: { a: { command: 'a' } },
      projects: { '/work': { mcpServers: { a: { command: 'a' } } } },
    });
    write(['a', 'b', 'c']);
    prepareNativeState('claude', spec, home);
    expect(projected()).toEqual({
      mcpServers: { a: { command: 'a' } },
      projects: { '/work': { mcpServers: { a: { command: 'a' } } } },
    });
  });
  it('links only the opened Claude skills and turns off claude.ai skill sync', () => {
    const { root, home } = fixture();
    const claude = path.join(home, '.claude');
    for (const name of ['x', 'y', 'synced'])
      mkdirSync(path.join(claude, 'skills', name), { recursive: true });
    writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ model: 'opus' }));
    const managed = path.join(root, 'managed');
    prepareNativeState(
      'claude',
      {
        project_id: 'project',
        native_state_dir: managed,
        extensions: opened({ enabled_user_mcp_servers: [], enabled_user_skills: ['x', 'synced'] }),
      },
      home,
    );
    expect(realDirectory(path.join(managed, 'skills'))).toBe(true);
    expect(links(path.join(managed, 'skills'))).toEqual({ x: path.join(claude, 'skills', 'x') });
    expect(JSON.parse(readFileSync(path.join(managed, 'settings.json'), 'utf8'))).toEqual({
      model: 'opus',
      syncClaudeAiSkills: false,
    });
    expect(readFileSync(path.join(claude, 'settings.json'), 'utf8')).toBe('{"model":"opus"}');
  });
  it('turns off claude.ai skill sync for a user without Claude settings', () => {
    const { root, home } = fixture();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const managed = path.join(root, 'managed');
    prepareNativeState(
      'claude',
      { project_id: 'project', native_state_dir: managed, extensions: opened({}) },
      home,
    );
    expect(JSON.parse(readFileSync(path.join(managed, 'settings.json'), 'utf8'))).toEqual({
      syncClaudeAiSkills: false,
    });
  });
  it('links only the Codex skills whose SKILL.md path the project opened', () => {
    const { root, home } = fixture();
    const codex = path.join(home, '.codex');
    for (const name of ['x', 'y']) {
      mkdirSync(path.join(codex, 'skills', name), { recursive: true });
      writeFileSync(path.join(codex, 'skills', name, 'SKILL.md'), name);
    }
    const managed = path.join(root, 'managed');
    const skill = realpathSync(path.join(codex, 'skills', 'x', 'SKILL.md'));
    prepareNativeState(
      'codex',
      {
        project_id: 'project',
        native_state_dir: managed,
        extensions: opened({ enabled_user_mcp_servers: [], enabled_user_skills: [skill] }),
      },
      home,
    );
    expect(links(path.join(managed, 'skills'))).toEqual({ x: path.join(codex, 'skills', 'x') });
  });
  it('keeps what an earlier session projected when a session carries no extensions', () => {
    const { root, home } = fixture();
    const claude = path.join(home, '.claude');
    for (const name of ['x', 'y'])
      mkdirSync(path.join(claude, 'skills', name), { recursive: true });
    const servers = { a: { command: 'a' }, b: { command: 'b' } };
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }));
    const managed = path.join(root, 'managed');
    const spec = { project_id: 'project', native_state_dir: managed };
    const projected = () => ({
      servers: JSON.parse(readFileSync(path.join(managed, '.claude.json'), 'utf8')).mcpServers,
      skills: links(path.join(managed, 'skills')),
    });
    prepareNativeState('claude', { ...spec, extensions: { mode: 'none' } }, home);
    expect(projected()).toEqual({ servers: {}, skills: {} });
    prepareNativeState(
      'claude',
      {
        ...spec,
        extensions: opened({ enabled_user_mcp_servers: ['a'], enabled_user_skills: ['x'] }),
      },
      home,
    );
    prepareNativeState('claude', { ...spec, extensions: { mode: 'none' } }, home);
    expect(projected()).toEqual({
      servers: { a: { command: 'a' } },
      skills: { x: path.join(claude, 'skills', 'x') },
    });
  });
  it('projects only the opened agy MCP servers into its Gemini folder, also after the user adds one', () => {
    const { root, home } = fixture();
    const config = path.join(home, '.gemini', 'config');
    mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'config.json'), '{"theme":"dark"}');
    const write = (names: string[]) =>
      writeFileSync(
        path.join(config, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: Object.fromEntries(names.map((name) => [name, { command: name }])),
          other: true,
        }),
      );
    write(['a', 'b']);
    const managed = path.join(root, 'managed');
    const spec = {
      project_id: 'project',
      native_state_dir: managed,
      extensions: opened({ enabled_user_mcp_servers: ['a'], enabled_user_skills: [] }),
    };
    const projected = () =>
      JSON.parse(readFileSync(path.join(managed, 'config', 'mcp_config.json'), 'utf8'));
    expect(prepareNativeState('agy', spec, home)).toEqual({
      env: {},
      args: ['--gemini-dir', managed],
    });
    expect(projected()).toEqual({ mcpServers: { a: { command: 'a' } }, other: true });
    expect(readFileSync(path.join(managed, 'config', 'config.json'), 'utf8')).toBe(
      '{"theme":"dark"}',
    );
    write(['a', 'b', 'c']);
    prepareNativeState('agy', spec, home);
    expect(projected()).toEqual({ mcpServers: { a: { command: 'a' } }, other: true });
    prepareNativeState('agy', { ...spec, extensions: { mode: 'none' } }, home);
    expect(projected()).toEqual({ mcpServers: { a: { command: 'a' } }, other: true });
  });
  it('writes an empty agy MCP list when the user has no Gemini MCP configuration', () => {
    const { root, home } = fixture();
    const managed = path.join(root, 'managed');
    prepareNativeState(
      'agy',
      { project_id: 'project', native_state_dir: managed, extensions: opened({}) },
      home,
    );
    expect(
      JSON.parse(readFileSync(path.join(managed, 'config', 'mcp_config.json'), 'utf8')),
    ).toEqual({ mcpServers: {} });
    expect(existsSync(path.join(managed, 'config', 'config.json'))).toBe(false);
  });
  it('links only the opened agy skills from the Gemini and agents skill folders', () => {
    const { root, home } = fixture();
    const gemini = path.join(home, '.gemini', 'config', 'skills');
    const agents = path.join(home, '.agents', 'skills');
    mkdirSync(path.join(gemini, 'x'), { recursive: true });
    mkdirSync(path.join(agents, 'y'), { recursive: true });
    const managed = path.join(root, 'managed');
    prepareNativeState(
      'agy',
      {
        project_id: 'project',
        native_state_dir: managed,
        extensions: opened({ enabled_user_mcp_servers: [], enabled_user_skills: ['y'] }),
      },
      home,
    );
    expect(realDirectory(path.join(managed, 'config', 'skills'))).toBe(true);
    expect(links(path.join(managed, 'config', 'skills'))).toEqual({ y: path.join(agents, 'y') });
    expect(existsSync(path.join(managed, 'skills'))).toBe(false);
  });
  it('gives grok its own home with the opened skills, the user config and an MCP allowlist with the project servers', () => {
    const { root, home } = fixture();
    const grok = path.join(home, '.grok');
    const claude = path.join(home, '.claude', 'skills');
    for (const dir of [path.join(grok, 'skills', 'x'), path.join(claude, 'y')])
      mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(claude, 'synced', 'z'), { recursive: true });
    const agents = path.join(home, '.agents', 'skills');
    for (const name of ['p', 'q']) mkdirSync(path.join(agents, name), { recursive: true });
    writeFileSync(path.join(grok, 'config.toml'), '[ui]\ntheme = "dark"\n');
    const cwd = path.join(root, 'project');
    mkdirSync(cwd);
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { project: { command: 'p' } } }),
    );
    const managed = path.join(root, 'managed');
    const spec = {
      project_id: 'project',
      native_state_dir: managed,
      cwd,
      extensions: opened({
        enabled_user_mcp_servers: ['a "b"'],
        enabled_user_skills: ['y', 'synced', 'p'],
      }),
    };
    expect(prepareNativeState('grok', spec, home)).toEqual({
      env: {
        GROK_HOME: managed,
        GROK_AUTH_PATH: path.join(grok, 'auth.json'),
        GROK_CLAUDE_SKILLS_ENABLED: 'false',
        GROK_CURSOR_SKILLS_ENABLED: 'false',
        GROK_CURSOR_MCPS_ENABLED: 'false',
      },
      args: [],
    });
    expect(links(path.join(managed, 'skills'))).toEqual({ y: path.join(claude, 'y') });
    expect(regularFile(path.join(managed, 'config.toml'))).toBe(true);
    expect(readFileSync(path.join(managed, 'config.toml'), 'utf8')).toBe('[ui]\ntheme = "dark"\n');
    expect(readFileSync(path.join(managed, 'managed_config.toml'), 'utf8')).toBe(
      'allowed_mcp_servers = [{ server_name = "a \\"b\\"" }, { server_name = "project" }]\n' +
        `[skills]\nignore = [${JSON.stringify(path.join(agents, 'q'))}]\n`,
    );
    expect(existsSync(path.join(managed, 'auth.json'))).toBe(false);
  });
  it('writes an empty grok allowlist without a project MCP file, blocks other hooks when asked, and keeps it for a session without extension settings', () => {
    const { root, home } = fixture();
    const cwd = path.join(root, 'project');
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, '.mcp.json'), '{ not json');
    const managed = path.join(root, 'managed');
    const extensions = opened({ enabled_user_mcp_servers: [], enabled_user_skills: [] });
    prepareNativeState(
      'grok',
      {
        project_id: 'project',
        native_state_dir: managed,
        cwd,
        extensions: {
          ...extensions,
          overrides: { ...extensions.overrides, disable_hooks: true },
        },
      },
      home,
    );
    const written =
      'allowed_mcp_servers = []\nallow_managed_hooks_only = true\n' + '[skills]\nignore = []\n';
    const managedConfig = () => readFileSync(path.join(managed, 'managed_config.toml'), 'utf8');
    expect(managedConfig()).toBe(written);
    expect(existsSync(path.join(managed, 'config.toml'))).toBe(false);
    writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { later: {} } }));
    prepareNativeState(
      'grok',
      { project_id: 'project', native_state_dir: managed, cwd, extensions: { mode: 'none' } },
      home,
    );
    expect(managedConfig()).toBe(written);
  });
  it('allows the grok project servers of each .grok/config.toml up to the repository root', () => {
    const { root, home } = fixture();
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'pkg');
    for (const dir of [path.join(repo, '.git'), path.join(repo, '.grok'), path.join(cwd, '.grok')])
      mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(repo, '.grok', 'config.toml'),
      '[ui]\ntheme = "dark"\n[mcp_servers.repo-wide]\nurl = "https://example.test"\n',
    );
    writeFileSync(
      path.join(cwd, '.grok', 'config.toml'),
      '[mcp_servers.toml-project]\ncommand = "t"\n[mcp_servers.toml-project.env]\nA = "1"\n',
    );
    mkdirSync(path.join(root, '.grok'));
    writeFileSync(
      path.join(root, '.grok', 'config.toml'),
      '[mcp_servers.outside]\ncommand = "o"\n',
    );
    writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { project: {} } }));
    const managed = path.join(root, 'managed');
    prepareNativeState(
      'grok',
      {
        project_id: 'project',
        native_state_dir: managed,
        cwd,
        extensions: opened({ enabled_user_mcp_servers: [], enabled_user_skills: [] }),
      },
      home,
    );
    expect(readFileSync(path.join(managed, 'managed_config.toml'), 'utf8')).toBe(
      'allowed_mcp_servers = [{ server_name = "project" }, { server_name = "toml-project" }, { server_name = "repo-wide" }]\n' +
        '[skills]\nignore = []\n',
    );
  });
  it('leaves the servers and skills a grok or agy project disabled out of its managed folder', () => {
    const { root, home } = fixture();
    const cwd = path.join(root, 'project');
    mkdirSync(path.join(cwd, '.grok'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { proj: {}, kept: {} } }),
    );
    writeFileSync(
      path.join(cwd, '.grok', 'config.toml'),
      '[mcp_servers.toml-proj]\ncommand = "t"\n',
    );
    for (const dir of [
      path.join(home, '.grok', 'skills', 's1'),
      path.join(home, '.grok', 'skills', 's2'),
      path.join(home, '.gemini', 'config', 'skills', 'g1'),
      path.join(home, '.agents', 'skills', 'a1'),
    ])
      mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { u1: {}, u2: {} } }),
    );
    const extensions = opened({
      enabled_user_mcp_servers: ['u1', 'u2'],
      enabled_user_skills: ['s1', 's2', 'g1', 'a1'],
    });
    const disabled = {
      ...extensions,
      overrides: {
        ...extensions.overrides,
        disabled_mcp_servers: ['u1', 'proj', 'toml-proj'],
        disabled_skills: ['s1', 'g1', 'a1'],
      },
    };
    const grok = path.join(root, 'grok');
    prepareNativeState(
      'grok',
      { project_id: 'project', native_state_dir: grok, cwd, extensions: disabled },
      home,
    );
    expect(readFileSync(path.join(grok, 'managed_config.toml'), 'utf8')).toBe(
      'allowed_mcp_servers = [{ server_name = "u2" }, { server_name = "kept" }]\n' +
        `[skills]\nignore = [${JSON.stringify(path.join(home, '.agents', 'skills', 'a1'))}]\n`,
    );
    expect(links(path.join(grok, 'skills'))).toEqual({
      s2: path.join(home, '.grok', 'skills', 's2'),
    });
    const agy = path.join(root, 'agy');
    prepareNativeState(
      'agy',
      { project_id: 'project', native_state_dir: agy, extensions: disabled },
      home,
    );
    expect(JSON.parse(readFileSync(path.join(agy, 'config', 'mcp_config.json'), 'utf8'))).toEqual({
      mcpServers: { u2: {} },
    });
    expect(links(path.join(agy, 'config', 'skills'))).toEqual({});
  });
  it('denies the servers a grok project disabled when it opens every user server', () => {
    const { root, home } = fixture();
    const extensions = opened({});
    const managed = path.join(root, 'managed');
    prepareNativeState(
      'grok',
      {
        project_id: 'project',
        native_state_dir: managed,
        extensions: {
          ...extensions,
          overrides: { ...extensions.overrides, disabled_mcp_servers: ['u1', 'a "b"'] },
        },
      },
      home,
    );
    expect(readFileSync(path.join(managed, 'managed_config.toml'), 'utf8')).toBe(
      'denied_mcp_servers = [{ server_name = "u1" }, { server_name = "a \\"b\\"" }]\n' +
        '[skills]\nignore = []\n',
    );
  });
  it('refuses a grok or agy session whose project disabled a plugin, naming the plugin and the setting', () => {
    const { root, home } = fixture();
    const extensions = opened({});
    for (const runtime of ['grok', 'agy'] as const) {
      const run = () =>
        prepareNativeState(
          runtime,
          {
            project_id: 'project',
            native_state_dir: path.join(root, runtime),
            extensions: {
              ...extensions,
              overrides: { ...extensions.overrides, disabled_plugins: ['tools@market'] },
            },
          },
          home,
        );
      expect(run).toThrow(/tools@market/);
      expect(run).toThrow(`Settings > Extensions > Plugins`);
    }
  });
  it('refuses a grok session whose user config.toml sets a key that would override the managed restrictions', () => {
    const { root, home } = fixture();
    mkdirSync(path.join(home, '.grok'));
    const user = path.join(home, '.grok', 'config.toml');
    const launch = (text: string, name: string) => {
      writeFileSync(user, text);
      return () =>
        prepareNativeState(
          'grok',
          {
            project_id: 'project',
            native_state_dir: path.join(root, name),
            extensions: opened({ enabled_user_mcp_servers: [], enabled_user_skills: [] }),
          },
          home,
        );
    };
    for (const [text, key] of [
      ['[ui]\ntheme = "dark"\n[skills]\nignore = []\n', 'skills.ignore'],
      ['skills.ignore = []\n', 'skills.ignore'],
      ['allowed_mcp_servers = []\n[ui]\n', 'allowed_mcp_servers'],
      ['denied_mcp_servers = []\n', 'denied_mcp_servers'],
      ['allow_managed_hooks_only = false\n', 'allow_managed_hooks_only'],
    ] as const) {
      const run = launch(text, key + text.length);
      expect(run).toThrow(key);
      expect(run).toThrow(user);
    }
    expect(
      launch('[ui]\nignore = 1\nallow_managed_hooks_only = true\n', 'other-tables'),
    ).not.toThrow();
  });
});
describe('user-level instructions and skills', () => {
  it('imports user and Claude instructions and links merged skills for Claude', () => {
    const { home, user, claude, spec } = userFixture();
    const managed = spec('claude').native_state_dir;
    prepareNativeState('claude', spec('claude'), home);
    const memory = path.join(managed, 'CLAUDE.md');
    expect(regularFile(memory)).toBe(true);
    expect(readFileSync(memory, 'utf8')).toBe(
      `@${escaped(path.join(user, 'AGENTS.md'))}\n@${escaped(path.join(claude, 'CLAUDE.md'))}\n`,
    );
    const skills = path.join(managed, 'skills');
    expect(realDirectory(skills)).toBe(true);
    expect(links(skills)).toEqual({
      a: path.join(claude, 'skills', 'a'),
      b: path.join(user, 'skills', 'b'),
      c: path.join(user, 'skills', 'c'),
    });
    expect(existsSync(path.join(skills, '.trash'))).toBe(false);
    rmSync(path.join(user, 'skills', 'c'), { recursive: true });
    rmSync(path.join(user, 'skills', 'b'), { recursive: true });
    mkdirSync(path.join(skills, 'owned'));
    writeFileSync(path.join(skills, 'owned', 'SKILL.md'), 'kept');
    prepareNativeState('claude', spec('claude'), home);
    expect(links(skills)).toEqual({
      a: path.join(claude, 'skills', 'a'),
      b: path.join(claude, 'skills', 'b'),
    });
    expect(readFileSync(path.join(skills, 'owned', 'SKILL.md'), 'utf8')).toBe('kept');
  });
  it('joins user and Codex instructions and keeps the Codex system skills', () => {
    const { home, user, codex, spec } = userFixture();
    const managed = spec('codex').native_state_dir;
    prepareNativeState('codex', spec('codex'), home);
    const agents = path.join(managed, 'AGENTS.md');
    expect(regularFile(agents)).toBe(true);
    expect(readFileSync(agents, 'utf8')).toBe('pantheon instructions\n\ncodex instructions');
    const skills = path.join(managed, 'skills');
    expect(realDirectory(skills)).toBe(true);
    expect(links(skills)).toEqual({
      a: path.join(codex, 'skills', 'a'),
      b: path.join(user, 'skills', 'b'),
      c: path.join(user, 'skills', 'c'),
    });
    mkdirSync(path.join(skills, '.system', 'bundled'), { recursive: true });
    rmSync(path.join(user, 'skills', 'c'), { recursive: true });
    prepareNativeState('codex', spec('codex'), home);
    expect(links(skills)).toEqual({
      a: path.join(codex, 'skills', 'a'),
      b: path.join(user, 'skills', 'b'),
    });
    expect(realDirectory(path.join(skills, '.system', 'bundled'))).toBe(true);
  });
  it('migrates earlier provider links without touching the provider or user sources', () => {
    const { home, user, claude, codex, spec } = userFixture();
    for (const runtime of ['claude', 'codex'] as const) {
      prepareNativeState(runtime, spec(runtime, false), home);
      prepareNativeState(runtime, spec(runtime), home);
    }
    const claudeManaged = spec('claude').native_state_dir;
    const codexManaged = spec('codex').native_state_dir;
    expect(regularFile(path.join(claudeManaged, 'CLAUDE.md'))).toBe(true);
    expect(regularFile(path.join(codexManaged, 'AGENTS.md'))).toBe(true);
    for (const managed of [claudeManaged, codexManaged]) {
      expect(realDirectory(path.join(managed, 'skills'))).toBe(true);
      expect(Object.keys(links(path.join(managed, 'skills')))).toEqual(['a', 'b', 'c']);
    }
    expect(readFileSync(path.join(claude, 'CLAUDE.md'), 'utf8')).toBe('claude instructions');
    expect(readFileSync(path.join(codex, 'AGENTS.md'), 'utf8')).toBe('codex instructions');
    expect(readFileSync(path.join(user, 'AGENTS.md'), 'utf8')).toBe('pantheon instructions');
    expect(readdirSync(path.join(claude, 'skills')).sort()).toEqual(['.trash', 'a', 'b']);
    expect(readdirSync(path.join(codex, 'skills')).sort()).toEqual(['a', 'b']);
    expect(readdirSync(path.join(user, 'skills')).sort()).toEqual(['b', 'c']);
    for (const dir of [claude, codex, user])
      for (const name of readdirSync(path.join(dir, 'skills')))
        expect(realDirectory(path.join(dir, 'skills', name))).toBe(true);
    rmSync(path.join(claudeManaged, 'CLAUDE.md'));
    symlinkSync(path.join(user, 'AGENTS.md'), path.join(claudeManaged, 'CLAUDE.md'));
    expect(() => prepareNativeState('claude', spec('claude'), home)).toThrow(
      'configuration reference changed: CLAUDE.md',
    );
  });
  it('uses only the provider instructions when the user directory is absent', () => {
    const { home, user, claude, spec } = userFixture();
    rmSync(user, { recursive: true });
    prepareNativeState('claude', spec('claude'), home);
    prepareNativeState('codex', spec('codex'), home);
    expect(readFileSync(path.join(spec('claude').native_state_dir, 'CLAUDE.md'), 'utf8')).toBe(
      `@${escaped(path.join(claude, 'CLAUDE.md'))}\n`,
    );
    expect(readFileSync(path.join(spec('codex').native_state_dir, 'AGENTS.md'), 'utf8')).toBe(
      'codex instructions',
    );
  });
});
describe('managed native history', () => {
  it('inherits configured account and tools without linking provider history or databases', () => {
    const { root, home } = fixture();
    const original = path.join(home, '.codex');
    mkdirSync(original);
    for (const name of ['config.toml', 'auth.json', 'AGENTS.md', 'state_5.sqlite', 'history.jsonl'])
      writeFileSync(path.join(original, name), name);
    mkdirSync(path.join(original, 'skills'));
    mkdirSync(path.join(original, '.tmp/marketplaces/tracing'), { recursive: true });
    mkdirSync(path.join(original, '.tmp/bundled-marketplaces/openai-bundled'), { recursive: true });
    mkdirSync(path.join(original, 'sessions'));
    writeFileSync(path.join(original, 'sessions', 'ordinary.jsonl'), 'ordinary user history');
    const managed = path.join(root, 'managed');
    const spec = { project_id: 'project', native_state_dir: managed };
    const result = prepareNativeState('codex', spec, home);
    expect(result.env).toEqual({ CODEX_HOME: managed });
    expect(result.args).toContain(`sqlite_home=${JSON.stringify(path.join(managed, 'sqlite'))}`);
    expect(result.args).toContain('history.persistence="none"');
    expect(result.args).toContain(
      `marketplaces.openai-bundled.source=${JSON.stringify(path.join(managed, '.tmp/bundled-marketplaces/openai-bundled'))}`,
    );
    for (const name of ['auth.json', 'AGENTS.md', '.tmp/marketplaces'])
      expect(readlinkSync(path.join(managed, name))).toBe(path.join(original, name));
    expect(readFileSync(path.join(managed, 'config.toml'), 'utf8')).toBe('config.toml');
    for (const name of ['sessions', 'state_5.sqlite', 'history.jsonl'])
      expect(existsSync(path.join(managed, name))).toBe(false);
    mkdirSync(path.join(managed, 'sessions'));
    writeFileSync(path.join(managed, 'sessions', 'owned.jsonl'), 'resumable');
    expect(prepareNativeState('codex', spec, home)).toEqual(result);
    expect(readFileSync(path.join(managed, 'sessions', 'owned.jsonl'), 'utf8')).toBe('resumable');
    expect(readFileSync(path.join(original, 'sessions', 'ordinary.jsonl'), 'utf8')).toBe(
      'ordinary user history',
    );
    expect(() => prepareNativeState('codex', { ...spec, project_id: 'other' }, home)).toThrow(
      'another project',
    );
  });
  it('drops the managed copy of a configuration file the user deleted', () => {
    const { root, home } = fixture();
    const files = {
      claude: ['settings.json', 'settings.local.json'],
      codex: ['config.toml', 'hooks.json'],
    } as const;
    for (const [runtime, names] of Object.entries(files)) {
      const source = path.join(home, `.${runtime}`);
      mkdirSync(source);
      for (const name of names) writeFileSync(path.join(source, name), '{"hooks":"old"}');
      const managed = path.join(root, `managed-${runtime}`);
      const spec = { project_id: 'project', native_state_dir: managed };
      prepareNativeState(runtime as keyof typeof files, spec, home);
      for (const name of names) expect(existsSync(path.join(managed, name))).toBe(true);
      for (const name of names) rmSync(path.join(source, name));
      prepareNativeState(runtime as keyof typeof files, spec, home);
      const left = names.filter((name) => existsSync(path.join(managed, name)));
      expect(left).toEqual(runtime === 'claude' ? ['settings.json'] : []);
    }
    expect(readFileSync(path.join(root, 'managed-claude', 'settings.json'), 'utf8')).toBe(
      '{"syncClaudeAiSkills":false}',
    );
  });
  it('keeps Claude default secure storage separate from managed persistent transcripts', () => {
    const { root, home } = fixture();
    const original = path.join(home, '.claude');
    mkdirSync(original);
    writeFileSync(path.join(original, 'settings.json'), '{}');
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { known: { command: 'tool' } },
        skillUsage: { private: 2 },
        projects: {
          '/work': {
            hasTrustDialogAccepted: true,
            mcpServers: {},
            lastSessionId: 'private',
            lastSessionFirstPrompt: 'private prompt',
          },
        },
      }),
    );
    mkdirSync(path.join(original, 'projects'));
    writeFileSync(path.join(original, 'history.jsonl'), 'unrelated');
    const managed = path.join(root, 'managed');
    expect(
      prepareNativeState(
        'claude',
        { project_id: 'project', native_state_dir: managed, extensions: opened({}) },
        home,
      ),
    ).toEqual({
      env: { CLAUDE_CONFIG_DIR: managed, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
      args: [],
    });
    expect(JSON.parse(readFileSync(path.join(managed, '.claude.json'), 'utf8'))).toEqual({
      mcpServers: { known: { command: 'tool' } },
      projects: { '/work': { hasTrustDialogAccepted: true, mcpServers: {} } },
    });
    expect(existsSync(path.join(managed, 'projects'))).toBe(false);
    expect(existsSync(path.join(managed, 'history.jsonl'))).toBe(false);
  });
  it('retains explicit legacy-store behavior and rejects aliases or unowned directories', () => {
    const { root, home } = fixture();
    const original = path.join(home, '.codex');
    mkdirSync(original);
    expect(prepareNativeState('codex', { project_id: 'legacy' }, home)).toEqual({
      env: {},
      args: [],
    });
    expect(() =>
      prepareNativeState('codex', { project_id: 'project', native_state_dir: original }, home),
    ).toThrow('separate absolute');
    const alias = path.join(root, 'alias');
    symlinkSync(original, alias);
    expect(() =>
      prepareNativeState('codex', { project_id: 'project', native_state_dir: alias }, home),
    ).toThrow('alias');
    const occupied = path.join(root, 'occupied');
    mkdirSync(occupied);
    writeFileSync(path.join(occupied, 'user.txt'), 'preserve');
    expect(() =>
      prepareNativeState('codex', { project_id: 'project', native_state_dir: occupied }, home),
    ).toThrow('unowned');
    expect(readFileSync(path.join(occupied, 'user.txt'), 'utf8')).toBe('preserve');
  });
  it('fails closed if a provider replaces an inherited account reference', () => {
    const { root, home } = fixture();
    mkdirSync(path.join(home, '.codex'));
    writeFileSync(path.join(home, '.codex', 'auth.json'), 'original');
    const spec = { project_id: 'project', native_state_dir: path.join(root, 'managed') };
    prepareNativeState('codex', spec, home);
    rmSync(path.join(spec.native_state_dir, 'auth.json'));
    writeFileSync(path.join(spec.native_state_dir, 'auth.json'), 'replacement');
    expect(() => prepareNativeState('codex', spec, home)).toThrow(
      'configuration reference changed: auth.json',
    );
    expect(readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).toBe('original');
  });
  it('uses bounded readable labels without turning the control input into a title', () => {
    expect(
      nativeSessionTitle({
        role: 'writer',
        platform_session_id: '1234567890',
        native_title: 'Project\n · Write docs',
      }),
    ).toBe('Project  · Write docs');
    expect(nativeSessionTitle({ role: 'planner', platform_session_id: '1234567890' })).toBe(
      'Pantheon · planner · 12345678',
    );
    expect(
      nativeSessionTitle({
        role: 'writer',
        platform_session_id: 'x',
        native_title: 'a'.repeat(300),
      }),
    ).toHaveLength(200);
  });
});
