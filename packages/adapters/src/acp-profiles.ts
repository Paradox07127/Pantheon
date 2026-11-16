export interface AcpProfile {
  binary: string;
  args: string[];
  resume: 'resume' | 'load';
  /** Extra arguments for the short process that only lists models; they keep it out of the history. */
  listArgs?: string[];
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
