import type { Capability } from '@pantheon/domain';

/** The oldest versions the evidence below was observed on. */
export const MIN_VERSIONS = { claude: '2.1.312', codex: '0.165.0' } as const;

/** platforms lists where the evidence was observed; elsewhere it does not apply. */
export const verifiedCapabilities: Record<
  string,
  { platforms: NodeJS.Platform[]; capabilities: Record<string, Capability> }
> = {
  codex: {
    platforms: ['darwin', 'linux'],
    capabilities: {
      text_execution: {
        status: 'supported',
        evidence:
          'codex-cli 0.165.0 completed a live text turn with read-only sandbox and approval never on 2026-10-28; codex-cli 0.168.0 did on Linux (WSL 2, x64) on 2026-11-13.',
      },
      resume: {
        status: 'supported',
        evidence:
          'codex-cli 0.165.0 resumed the same thread for a second text turn on 2026-10-28; codex-cli 0.168.0 did on Linux (WSL 2, x64) on 2026-11-13.',
      },
      write_isolation: {
        status: 'supported',
        evidence:
          'codex-cli 0.165.0 writer sessions on 2026-10-28 in a profile from the protection list: committed in their clone; writes to .git/hooks and outside the clone failed; an MCP call waited for Pantheon approval. On Linux (WSL 2, x64) on 2026-11-13, codex-cli 0.168.0 writer sessions committed in a linked worktree; shell writes to the Pantheon data folder, the source .git/hooks and outside the worktree failed under bubblewrap.',
      },
      read_isolation: {
        status: 'supported',
        evidence:
          'codex-cli 0.165.0 denied a writer session command reading a read_write protection entry on 2026-10-28, and the entry content never reached session events; reviewer sessions use the same profile with no writable roots. On Linux on 2026-11-13, codex-cli 0.168.0 under the same profile format denied reading, listing and writing a deny entry, and the sentinel of a live writer session never reached session events.',
      },
    },
  },
  claude: {
    platforms: ['darwin', 'linux'],
    capabilities: {
      text_execution: {
        status: 'supported',
        evidence:
          '2.1.312 (Claude Code) completed a live text turn with no tools on 2026-10-27; 2.1.323 did on Linux (WSL 2, x64) on 2026-11-13.',
      },
      resume: {
        status: 'supported',
        evidence:
          '2.1.312 (Claude Code) resumed the same session for a second text turn on 2026-10-27; 2.1.323 did on Linux (WSL 2, x64) on 2026-11-13.',
      },
      write_isolation: {
        status: 'supported',
        evidence:
          '2.1.312 (Claude Code) writer session on 2026-10-27 with the SDK sandbox and protection rules: committed in its clone; writing .git/hooks, reading a protected directory with Bash and Read, and writing outside the clone failed; MCP calls waited for Pantheon approval. On Linux (WSL 2, x64) on 2026-11-13, 2.1.323 writer sessions committed in a linked worktree; shell writes to the source .git/hooks and outside the worktree failed as read-only, and a write into the protected data folder stayed in the empty folder the sandbox shows in its place.',
      },
      read_isolation: {
        status: 'supported',
        evidence:
          '2.1.312 (Claude Code) writer sessions on 2026-10-27 and 2026-10-28 could not read a read_write protection entry with Bash or Read; reviewer sessions use the same rules with no writable roots. On Linux on 2026-11-13, 2.1.323 writer sessions found an empty folder in place of a read_write entry and were denied Bash and Read on its absolute path; the sentinel never reached session events.',
      },
    },
  },
  grok: {
    platforms: ['darwin'],
    capabilities: {
      text_execution: {
        status: 'supported',
        evidence:
          'grok 1.0.77 over ACP answered a fixture code question with the right line on 2026-11-11.',
      },
      resume: {
        status: 'supported',
        evidence:
          'grok 1.0.77 over ACP resumed the same session for a follow-up turn on 2026-11-11.',
      },
      write_isolation: {
        status: 'unsupported',
        evidence:
          'grok 1.0.77 over ACP wrote a file in its folder and one outside it on 2026-11-11 without a permission request.',
      },
    },
  },
  dsh: {
    platforms: ['darwin'],
    capabilities: {
      text_execution: {
        status: 'supported',
        evidence:
          'dsh 0.2.1-rc.5 over ACP answered a fixture code question with the right line on 2026-11-15.',
      },
      resume: {
        status: 'supported',
        evidence:
          'dsh 0.2.1-rc.5 over ACP resumed the same session for a follow-up turn on 2026-11-15.',
      },
      write_isolation: {
        status: 'supported',
        evidence:
          'dsh 0.2.2-rc.3 over ACP in workspace-write mode on 2026-11-16, in a linked worktree: wrote in the worktree; shell writes outside it and to the source .git/hooks failed with Operation not permitted once the permission request was refused; its commit asked through session/request_permission. Temporary folders stay writable.',
      },
    },
  },
};
