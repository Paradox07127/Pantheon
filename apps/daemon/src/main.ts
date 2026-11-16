import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { startDaemon } from './index.js';
import { acpProfiles, claudeOneShot, FixtureAdapter, withInstallFolders } from '@pantheon/adapters';
import { runtimeConfig } from '@pantheon/control';
import { defaultDataDirectory, defaultDesktopUserDataDirectory } from '@pantheon/protocol/paths';
import { createRuntimeAdapter } from './runtime-registry.js';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    port: { type: 'string' },
    'allow-fixture': { type: 'boolean' },
  },
});
process.env.PATH = withInstallFolders(process.env.PATH);
const directory = path.resolve(
  values['data-dir'] ?? process.env.PANTHEON_DATA_DIR ?? defaultDataDirectory(),
);
const userConfigDir = path.join(os.homedir(), '.pantheon');
const formerWorkspaceRoot = path.join(path.dirname(directory), 'Pantheon Workspaces');
type RuntimeConfig = ReturnType<typeof runtimeConfig>;
let claudeConfig: RuntimeConfig = {},
  codexConfig: RuntimeConfig = {};
const acpConfigs: Record<string, RuntimeConfig> = {};
try {
  claudeConfig = runtimeConfig(userConfigDir, 'claude');
  codexConfig = runtimeConfig(userConfigDir, 'codex');
  for (const name of Object.keys(acpProfiles))
    acpConfigs[name] = runtimeConfig(userConfigDir, name);
} catch (error) {
  console.error('Starting the runtimes with their defaults:', (error as Error).message);
}
const adapters = (
  await Promise.all(
    ['claude', 'codex', ...Object.keys(acpProfiles)].map(async (name) => {
      const config =
        name === 'claude'
          ? claudeConfig
          : name === 'codex'
            ? codexConfig
            : (acpConfigs[name] ?? {});
      try {
        return await createRuntimeAdapter(name, config);
      } catch (error) {
        console.error(
          'Starting the runtime without its configured arguments:',
          (error as Error).message,
        );
        return createRuntimeAdapter(name, { ...config, args: undefined });
      }
    }),
  )
).filter((adapter) => adapter !== undefined);
if (values['allow-fixture']) adapters.push(new FixtureAdapter());
const daemon = await startDaemon({
  directory,
  // A data directory from the environment (tests, acceptance runs) keeps worktrees out of the real home.
  workspaceRoot: process.env.PANTHEON_DATA_DIR
    ? formerWorkspaceRoot
    : path.join(userConfigDir, 'worktrees'),
  formerWorkspaceRoots: [formerWorkspaceRoot],
  protectionPaths: {
    dataDir: directory,
    // Electron's appData, whatever --data-dir says.
    desktopUserDataDir: defaultDesktopUserDataDirectory(),
    backupDir: path.join(path.dirname(directory), 'Pantheon Backups'),
    home: os.homedir(),
    // The native environment allowlist drops CODEX_HOME, so Codex always uses this one.
    codexHome: path.join(os.homedir(), '.codex'),
  },
  adapters,
  createRuntimeAdapter,
  ...(values['allow-fixture']
    ? {}
    : {
        turnSummarizer: async (prompt: string, signal: AbortSignal) => ({
          ...(await claudeOneShot(prompt, 'claude-haiku-5-5', signal, claudeConfig.binary)),
          model: 'claude-haiku-5-5',
        }),
      }),
  port: values.port ? Number(values.port) : 0,
  userConfigDir,
  mcpEntry: process.env.PANTHEON_MCP_ENTRY,
});
console.log(
  JSON.stringify({
    service: 'pantheon',
    url: daemon.url,
    directory,
    fixture: !!values['allow-fixture'],
  }),
);
daemon.control.on('diagnostic', (error) => console.error('Scheduler diagnostic:', String(error)));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void daemon.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
