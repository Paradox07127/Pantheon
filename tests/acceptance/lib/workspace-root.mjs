import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = fileURLToPath(new URL('../../../node_modules/.cache/', import.meta.url));

/**
 * A fresh directory for managed worktrees under the repository's node_modules/.cache: the daemon
 * refuses managed workspaces in temporary directories, where the case workspace may live.
 */
export function createWorkspaceRoot(prefix) {
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, `${prefix}-`));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}
