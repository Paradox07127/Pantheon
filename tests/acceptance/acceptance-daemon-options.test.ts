import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startDaemon } from '@pantheon/daemon';
import { startNativeDaemon } from './lib/daemon.mjs';

vi.mock('@pantheon/daemon', () => ({ startDaemon: vi.fn(async () => ({ close: vi.fn() })) }));

it('configures managed workspaces and protected paths for the native daemon helper', async () => {
  const workspace = path.join(process.cwd(), 'native-probe');
  await startNativeDaemon(workspace, []);
  expect(startDaemon).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceRoot: path.join(workspace, 'workspaces'),
      userConfigDir: path.join(workspace, 'config'),
      protectionPaths: {
        dataDir: path.join(workspace, 'state'),
        backupDir: path.join(workspace, 'backups'),
        desktopUserDataDir: path.join(os.homedir(), 'Library/Application Support/Pantheon Desktop'),
        home: os.homedir(),
        codexHome: path.join(os.homedir(), '.codex'),
      },
    }),
  );
});

it('protects a stand-in home instead of the real one when a scenario passes it', async () => {
  const workspace = path.join(process.cwd(), 'native-probe');
  const home = path.join(workspace, 'home');
  await startNativeDaemon(workspace, [], { home });
  expect(startDaemon).toHaveBeenLastCalledWith(
    expect.objectContaining({
      protectionPaths: expect.objectContaining({
        home,
        codexHome: path.join(home, '.codex'),
        desktopUserDataDir: path.join(home, 'Library/Application Support/Pantheon Desktop'),
      }),
    }),
  );
});
