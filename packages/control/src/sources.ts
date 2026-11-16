import os from 'node:os';
import path from 'node:path';
import { defaultDesktopUserDataDirectory } from '@pantheon/protocol/paths';
import { resolvedPath, type ControlContext } from './context.js';

export function protectedInputs(ctx: ControlContext, roots: string[] = []): string[] {
  const home = ctx.protectionPaths?.home ?? os.homedir();
  return [
    path.dirname(ctx.files.directory),
    ctx.protectionPaths?.dataDir,
    ctx.protectionPaths?.desktopUserDataDir ??
      defaultDesktopUserDataDirectory(process.platform, process.env, home),
    ctx.protectionPaths?.backupDir,
    ctx.protectionPaths?.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex'),
    ...['.claude', '.claude.json', '.ssh', '.aws', '.agents'].map((name) => path.join(home, name)),
    ...roots.flatMap((root) =>
      ['.git', '.claude', '.codex', '.mcp.json', '.env'].map((name) => path.join(root, name)),
    ),
  ]
    .filter((value): value is string => !!value)
    .map(resolvedPath);
}
