#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { defaultDataDirectory } from '@pantheon/protocol/paths';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.js';
import { createPersonalMcpServer } from './personal-tools.js';
import { land, landUsage } from './land.js';
import { resolveUsage, review, reviewUsage } from './review.js';

const usage = `Usage: pantheon mcp [--personal]|health|command (--file FILE|--json JSON)|<query method> [--project ID] [--after N] [--param KEY=VALUE]... [--data-dir DIR]
       pantheon ${reviewUsage} [--data-dir DIR]
       pantheon ${resolveUsage} [--data-dir DIR]
       pantheon ${landUsage} [--data-dir DIR]`;
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      personal: { type: 'boolean' },
      'data-dir': { type: 'string' },
      file: { type: 'string' },
      json: { type: 'string' },
      project: { type: 'string' },
      after: { type: 'string' },
      param: { type: 'string', multiple: true },
      base: { type: 'string' },
      runtime: { type: 'string', multiple: true },
      fallback: { type: 'string', multiple: true },
      message: { type: 'string' },
      note: { type: 'string' },
    },
  });
} catch (error) {
  if (!(error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS_')) throw error;
  console.error((error as Error).message);
  process.exit(64);
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(usage);
  process.exit(0);
}
const directory = values['data-dir'] ?? process.env.PANTHEON_DATA_DIR ?? defaultDataDirectory();
if (!positionals[0]) {
  console.error(usage);
  process.exit(64);
}
const connect = () => {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'daemon.json'), 'utf8')) as {
    url: string;
    token_file: string;
  };
  return { url: manifest.url, token: readFileSync(manifest.token_file, 'utf8').trim() };
};
try {
  if (positionals[0] === 'mcp') {
    const variable = values.personal
      ? 'PANTHEON_PERSONAL_TOKEN_FILE'
      : 'PANTHEON_SESSION_TOKEN_FILE';
    const tokenFile = process.env[variable];
    if (!tokenFile) throw new Error(`permission_denied: ${variable} required`);
    const token = readFileSync(tokenFile, 'utf8');
    const url =
      process.env.PANTHEON_DAEMON_URL ??
      (JSON.parse(readFileSync(path.join(directory, 'daemon.json'), 'utf8')) as { url: string })
        .url;
    // The daemon names each personal key's token file by the key id.
    const server = values.personal
      ? await createPersonalMcpServer(url, token)
      : await createMcpServer(url, token);
    await server.connect(new StdioServerTransport());
  } else if (positionals[0] === 'review') {
    process.exitCode = await review(connect, positionals.slice(1), values);
  } else if (positionals[0] === 'land') {
    process.exitCode = await land(connect, positionals.slice(1), values);
  } else {
    const manifest = connect(),
      token = manifest.token,
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
