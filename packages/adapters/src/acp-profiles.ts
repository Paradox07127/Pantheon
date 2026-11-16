import type { PermissionMode } from '@pantheon/domain';

export interface AcpProfile {
  binary: string;
  args: string[];
  resume: 'resume' | 'load';
  /** Extra arguments for the short process that only lists models; they keep it out of the history. */
  listArgs?: string[];
  /** The modes permissionEnv sets at launch; without them the runtime's own permission modes apply. */
  permissionModes?: PermissionMode[];
  /** The environment that starts the agent in a permission mode. */
  permissionEnv?: (mode: PermissionMode) => Record<string, string>;
  /** A --patch file that lets the agent's sandbox write the session's roots; undefined adds none. */
  sandboxPatch?: (mode: PermissionMode, writableRoots: string[]) => string | undefined;
  /** ACP tool kinds by tool title, for an agent that reports every call as kind other. */
  toolKinds?: Record<string, string>;
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
    resume: 'resume',
  },
  agy: {
    binary: 'agy',
    args: ['acp'],
    // session/load also succeeds for ids that do not exist.
    resume: 'resume',
  },
  dsh: {
    binary: 'dsh',
    args: ['--profile', 'acp'],
    resume: 'resume',
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
    toolKinds: {
      bash: 'execute',
      edit: 'edit',
      write: 'edit',
      read: 'read',
      read_image: 'read',
      glob: 'search',
      grep: 'search',
      web_fetch: 'fetch',
      web_search: 'fetch',
    },
  },
  muse: {
    binary: 'muse',
    args: ['acp'],
    resume: 'resume',
    listArgs: ['--no-session-log'],
  },
  opencode: { binary: 'opencode', args: ['acp'], resume: 'resume' },
  cursor: { binary: 'cursor-agent', args: ['acp'], resume: 'load' },
  copilot: { binary: 'copilot', args: ['--acp'], resume: 'load' },
  gemini: { binary: 'gemini', args: ['--acp'], resume: 'load' },
  kilo: { binary: 'kilo', args: ['acp'], resume: 'resume' },
  cline: { binary: 'cline', args: ['--acp'], resume: 'load' },
  qwen: { binary: 'qwen', args: ['--acp'], resume: 'resume' },
  kimi: { binary: 'kimi', args: ['acp'], resume: 'resume' },
  goose: { binary: 'goose', args: ['acp'], resume: 'load' },
  openhands: { binary: 'openhands', args: ['acp'], resume: 'load' },
  auggie: { binary: 'auggie', args: ['--acp'], resume: 'load' },
  kiro: { binary: 'kiro-cli', args: ['acp'], resume: 'load' },
  junie: { binary: 'junie', args: ['--acp', 'true'], resume: 'resume' },
  devin: { binary: 'devin', args: ['acp'], resume: 'load' },
  vibe: { binary: 'vibe-acp', args: [], resume: 'load' },
  hermes: { binary: 'hermes', args: ['acp'], resume: 'load' },
  omp: { binary: 'omp', args: ['acp'], resume: 'load' },
  codebuddy: { binary: 'codebuddy', args: ['--acp'], resume: 'load' },
  droid: { binary: 'droid', args: ['exec', '--output-format', 'acp-daemon'], resume: 'resume' },
  qoder: { binary: 'qodercli', args: ['--acp'], resume: 'resume' },
};
