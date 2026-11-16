# Security policy

Pantheon is an experimental product. Only the latest pre-release gets fixes.

## Report a vulnerability

Do not open a public issue for a security problem.
Report it privately: on the repository page, open **Security** > **Advisories** > **Report a vulnerability**.

Give:

- the Pantheon version, the OS and the architecture;
- the steps that show the problem;
- what an attacker can do with it.

## Scope

These parts are in scope:

- the daemon, which listens only on `127.0.0.1` and checks the local user token;
- the worktree sandbox and the gate commands;
- the desktop app and its bridge to the daemon;
- the CLI and its MCP tool server.

The runtimes (Claude Code, Codex, ACP agents) are separate products. Report their problems to their makers.
