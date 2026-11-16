import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { defaultDataDirectory } from '@pantheon/protocol/paths';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'data-dir': { type: 'string' },
    file: { type: 'string' },
    json: { type: 'string' },
    project: { type: 'string' },
    after: { type: 'string' },
    param: { type: 'string', multiple: true },
  },
});
const directory = values['data-dir'] ?? process.env.PANTHEON_DATA_DIR ?? defaultDataDirectory();
if (!positionals[0]) {
  console.error(
    'Usage: pnpm cli mcp|health|command (--file FILE|--json JSON)|<query method> [--project ID] [--after N] [--param KEY=VALUE]... [--data-dir DIR]',
  );
  process.exit(64);
}
try {
  if (positionals[0] === 'mcp') {
    const tokenFile = process.env.PANTHEON_SESSION_TOKEN_FILE;
    if (!tokenFile) throw new Error('permission_denied: PANTHEON_SESSION_TOKEN_FILE required');
    const token = readFileSync(tokenFile, 'utf8');
    const url =
      process.env.PANTHEON_DAEMON_URL ??
      (JSON.parse(readFileSync(path.join(directory, 'daemon.json'), 'utf8')) as { url: string })
        .url;
    const server = await createMcpServer(url, token);
    await server.connect(new StdioServerTransport());
  } else {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'daemon.json'), 'utf8')) as {
      url: string;
      token_file: string;
    };
    const token = readFileSync(manifest.token_file, 'utf8').trim(),
      method = positionals[0];
    const route =
      method === 'health' ? '/health' : method === 'command' ? '/v1/commands' : `/v1/${method}`;
    const url = new URL(route, manifest.url);
    if (values.project) url.searchParams.set('project_id', values.project);
    if (values.after) url.searchParams.set('after', values.after);
    for (const pair of values.param ?? []) {
      const separator = pair.indexOf('=');
      if (separator < 1) throw new Error(`--param needs KEY=VALUE: ${pair}`);
      url.searchParams.append(pair.slice(0, separator), pair.slice(separator + 1));
    }
    if (method === 'command' && !values.file && !values.json)
      throw new Error('--file or --json required');
    const response = await fetch(url, {
      method: method === 'command' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method === 'command' ? (values.json ?? readFileSync(values.file!, 'utf8')) : undefined,
      signal: AbortSignal.timeout(
        method === 'extensions.inventory' || method === 'runtime.models' ? 15_000 : 5000,
      ),
    });
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
    if (!response.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
