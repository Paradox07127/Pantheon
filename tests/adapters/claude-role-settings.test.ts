import { expect, it } from 'vitest';
import { NATIVE_ENV_ALLOWLIST, type SessionSpec } from '@pantheon/domain';
import { buildClaudeOptions } from '../../packages/adapters/src/claude.js';

const base = { pathToClaudeCodeExecutable: 'fake-claude', env: { PATH: '/test' } };
const spec = (): SessionSpec => ({
  platform_session_id: 'role-settings-session',
  project_id: 'role-settings-project',
  runtime: 'claude',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  extensions: { mode: 'none' },
  budget: { max_turns: 1, wall_time_ms: 10000 },
});

it('disables reviewer auto memory with isolated or inherited extensions and with or without a sandbox', () => {
  for (const sandbox of [undefined, { writable_roots: [], protected_entries: [] }]) {
    for (const extensions of [
      { mode: 'none' },
      {
        mode: 'inherit',
        overrides: {
          disabled_mcp_servers: [],
          disabled_plugins: [],
          disabled_skills: [],
          disable_apps: false,
          disable_hooks: false,
        },
      },
    ] satisfies SessionSpec['extensions'][]) {
      const options = buildClaudeOptions(
        { ...spec(), role: 'reviewer', extensions, sandbox },
        base,
      );
      expect(options.settings).toMatchObject({ autoMemoryEnabled: false });
      expect(options.settings).not.toHaveProperty('disableWorkflows');
    }
  }
});
