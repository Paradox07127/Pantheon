import path from 'node:path';
import os from 'node:os';
import { startDaemon } from '@pantheon/daemon';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';

/** `home` stands in for the user's home; a fixture-only scenario passes its own, so audits never read the real one. */
export async function startNativeDaemon(
  workspace,
  adapters,
  { intervalMs, home = os.homedir() } = {},
) {
  return startFixtureDaemon(workspace, adapters, {
    intervalMs,
    workspaceRoot: path.join(workspace, 'workspaces'),
    protectionPaths: {
      dataDir: path.join(workspace, 'state'),
      backupDir: path.join(workspace, 'backups'),
      desktopUserDataDir: path.join(home, 'Library/Application Support/Pantheon Desktop'),
      home,
      codexHome: path.join(home, '.codex'),
    },
  });
}

/**
 * @param {string} workspace
 * @param {import('@pantheon/domain').HarnessAdapter[]} [adapters]
 * @param {Pick<import('@pantheon/daemon').DaemonOptions, 'now' | 'failpoint' | 'workspaceRoot' | 'protectionPaths' | 'intervalMs'>} [options]
 */
export async function startFixtureDaemon(
  workspace,
  adapters = [new FixtureAdapter()],
  { now, failpoint, workspaceRoot, protectionPaths, intervalMs = 600000 } = {},
) {
  const daemon = await startDaemon({
    directory: path.join(workspace, 'state'),
    adapters,
    // Stands in for Haiku: the first words of the user's message.
    turnSummarizer: async (prompt) =>
      (prompt.split('<user_message>\n')[1] ?? '').split('\n')[0].slice(0, 18),
    intervalMs,
    now,
    failpoint,
    workspaceRoot,
    protectionPaths,
  });
  const receipts = [];
  const submit = async (body) => {
    const response = await fetch(daemon.url + '/v1/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    const result = { status: response.status, data };
    receipts.push({ command: body, result });
    return result;
  };
  const call = async (type, input, revision = null) => {
    const res = await submit(command(USER_PRINCIPAL_ID, type, input, revision));
    if (res.status !== 200) throw new Error(JSON.stringify(res));
    return res.data.receipt;
  };
  return { daemon, receipts, submit, call, close: () => daemon.close() };
}
