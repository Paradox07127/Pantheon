/** The guide that opens a session debugging an error the running Pantheon app reported. */
export const appDebugSkill = `[Pantheon] This is a debug session. The user clicked "Ask agent" next to an error in the
running Pantheon app; the message below holds the error and the context captured there.
This worktree is the source code of Pantheon itself.

## Reproduce first
- When you have the chrome_devtools MCP tools, they are connected to the Electron renderer
  of the running app: use them to list pages, take screenshots, read the console and run
  JavaScript. window.__pantheonAppErrors holds the app's recent errors.
- Without those tools, read the daemon logs and the code.

## Fix
- Once you find the root cause, fix it in this worktree following the repository
  conventions (CLAUDE.md, docs/architecture.md). Write a test that reproduces it first.
- The fix reaches the running app only after the user merges it and runs pnpm relaunch.
  When you report, say how to confirm the fix in the app.
- Do not change the running app's data directory or the user's settings.`;
