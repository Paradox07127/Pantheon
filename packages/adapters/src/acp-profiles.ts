import type { PermissionMode } from '@pantheon/domain';

export interface AcpProfile {
  binary: string;
  args: string[];
  /** Extra arguments for the short process that only lists models; they keep it out of the history. */
  listArgs?: string[];
  /** The modes permissionEnv sets at launch; without them the runtime's own permission modes apply. */
  permissionModes?: PermissionMode[];
  /** The environment that starts the agent in a permission mode. */
  permissionEnv?: (mode: PermissionMode) => Record<string, string>;
  /** A --patch file that lets the agent's sandbox write the session's roots; undefined adds none. */
  sandboxPatch?: (mode: PermissionMode, writableRoots: string[]) => string | undefined;
  /** Undefined leaves the request to the transport's method-not-found response. */
  handleRequest?: (request: {
    method: string;
    params?: Record<string, unknown>;
  }) => { result: unknown } | { error: { code: number; message: string } } | undefined;
}

export const acpProfiles: Record<string, AcpProfile> = {
  grok: {
    binary: 'grok',
    args: ['--permission-mode', 'default', 'agent', 'stdio'],
  },
  agy: {
    binary: 'agy',
    args: ['acp'],
  },
  dsh: {
    binary: 'dsh',
    args: ['--profile', 'acp'],
    permissionModes: ['plan', 'auto_edit', 'full_access'],
    // Its sandbox, chosen only at launch; workspace-write asks before going past the workspace.
    permissionEnv: (mode) => ({
      DSH_PERMISSION_MODE:
        mode === 'plan'
          ? 'read-only'
          : mode === 'full_access'
            ? 'danger-full-access'
            : 'workspace-write',
    }),
    // A linked worktree commits into the source's objects and its own git folder, both outside it.
    sandboxPatch: (mode, roots) =>
      mode === 'plan'
        ? undefined
        : [
            '- id: sandbox-policy',
            '  config:',
            "    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'",
            '    workspaceRoot: !!js process.cwd()',
            '    additionalWritableRoots:',
            ...roots.map((root) => `      - ${JSON.stringify(root)}`),
            '',
          ].join('\n'),
  },
  muse: {
    binary: 'muse',
    args: ['acp'],
    listArgs: ['--no-session-log'],
  },
  opencode: { binary: 'opencode', args: ['acp'] },
  cursor: { binary: 'cursor-agent', args: ['acp'] },
  copilot: { binary: 'copilot', args: ['--acp'] },
  gemini: { binary: 'gemini', args: ['--acp'] },
  kilo: { binary: 'kilo', args: ['acp'] },
  cline: { binary: 'cline', args: ['--acp'] },
  qwen: { binary: 'qwen', args: ['--acp'] },
  kimi: { binary: 'kimi', args: ['acp'] },
  goose: { binary: 'goose', args: ['acp'] },
  openhands: { binary: 'openhands', args: ['acp'] },
  auggie: { binary: 'auggie', args: ['--acp'] },
  kiro: { binary: 'kiro-cli', args: ['acp'] },
  junie: { binary: 'junie', args: ['--acp', 'true'] },
  devin: { binary: 'devin', args: ['acp'] },
  vibe: { binary: 'vibe-acp', args: [] },
  hermes: { binary: 'hermes', args: ['acp'] },
  omp: { binary: 'omp', args: ['acp'] },
  codebuddy: { binary: 'codebuddy', args: ['--acp'] },
  droid: { binary: 'droid', args: ['exec', '--output-format', 'acp-daemon'] },
  qoder: { binary: 'qodercli', args: ['--acp'] },
};
