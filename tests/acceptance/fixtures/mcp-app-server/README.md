# MCP App fixture server

A stdio MCP server for manual testing of the MCP Apps host. Its `show_counter` tool has a UI (`ui://pantheon-fixture/counter.html`) whose buttons send each View-to-host message. It needs `pnpm install` in this checkout; replace `/path/to/Pantheon` with the checkout path.

Claude Code, project-level `.mcp.json` in the test project (or `claude mcp add --scope project pantheon-mcp-app-fixture -- node /path/to/Pantheon/tests/acceptance/fixtures/mcp-app-server/server.mjs`):

```json
{
  "mcpServers": {
    "pantheon-mcp-app-fixture": {
      "command": "node",
      "args": ["/path/to/Pantheon/tests/acceptance/fixtures/mcp-app-server/server.mjs"]
    }
  }
}
```

Codex, project-level `.codex/config.toml` in the test project (same table as in `~/.codex/config.toml`):

```toml
[mcp_servers.pantheon-mcp-app-fixture]
command = "node"
args = ["/path/to/Pantheon/tests/acceptance/fixtures/mcp-app-server/server.mjs"]
```
