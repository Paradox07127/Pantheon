import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { nativeEnvironment, readProcessIdentity } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { git, POLL_MS, REQUEST_MS } from './codex-live.mjs';

/** Shapes of credentials; an evidence file matching one holds a secret. */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /"(?:access_token|refresh_token|id_token|api_key|apiKey|account_id|accountId)"\s*:\s*"[^"]{6,}"/,
  /[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];
const TEXT_LIMIT = 200;
const EMAIL = /[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ACCOUNT_KEY = /^(?:account_ref|account_id|accountId|email)$/;

/** Commands and queries against the daemon endpoint() returns; every command and its answer goes to receipts. */
export function daemonClient(endpoint, receipts) {
  const request = async (pathname, init = {}) => {
    const { url, token } = endpoint();
    const response = await fetch(`${url}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    return { status: response.status, ok: response.ok, data: await response.json() };
  };
  const send = async (step, type, input, revision = null) => {
    const result = await request('/v1/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command(USER_PRINCIPAL_ID, type, input, revision)),
    });
    receipts.push({ step, type, input, expected_revision: revision, ...result });
    return result;
  };
  const call = async (step, type, input, revision = null) => {
    const result = await send(step, type, input, revision);
    if (result.status !== 200 || result.data.receipt?.error)
      throw new Error(`${step} ${type}: ${JSON.stringify(result.data)}`);
    return result.data.receipt;
  };
  const get = async (method, params) => {
    const result = await request(`/v1/${method}?${new URLSearchParams(params)}`);
    if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.data)}`);
    return result.data;
  };
  return { send, call, get };
}

/** The project's events read so far in all; pull appends the ones after the last read. */
export function eventLog(get, projectId) {
  const all = [];
  let cursor = 0,
    pulling;
  const pull = () =>
    (pulling ??= (async () => {
      for (;;) {
        const page = await get('events', { after: String(cursor), project_id: projectId() });
        if (page.snapshot_required)
          throw new Error('Event log no longer reaches the unread events');
        if (!page.events.length) return all;
        all.push(...page.events);
        cursor = page.events.at(-1).sequence;
      }
    })().finally(() => (pulling = undefined)));
  return { all, pull };
}

/** Calls check every second until it returns a truthy value; throws after capMs or at the deadline. */
export async function poll(check, description, capMs, deadline) {
  const until = Math.min(Date.now() + capMs, deadline);
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= until)
      throw new Error(
        `${Date.now() >= deadline ? 'Scenario deadline reached' : 'Timed out'} waiting for ${description}`,
      );
    await delay(POLL_MS);
  }
}

/** A git repository at root with the given files in one commit on main. */
export async function createGitProject(root, files) {
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Native Live Scenario');
  git(root, 'config', 'user.email', 'native-live@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(root, name), content);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Initial commit');
}

/** The first line `<binary> --version` prints in the native environment; throws when it fails. */
export async function installedVersion(binary) {
  const { stdout } = await promisify(execFile)(binary, ['--version'], {
    env: nativeEnvironment(),
    encoding: 'utf8',
    timeout: REQUEST_MS,
  });
  const version = stdout.trim().split('\n')[0];
  if (!version) throw new Error(`${binary} --version printed nothing`);
  return version;
}

/** Turns off the user's MCP servers, plugins, apps and hooks for each runtime; returns the inventories. */
export async function disableUserExtensions({ get, call, project, runtimes }) {
  const inventories = {};
  let revision = project.revision;
  for (const runtime of runtimes) {
    const inventory = await get('extensions.inventory', { project_id: project.id, runtime });
    inventories[runtime] = {
      mcp_servers: inventory.mcp_servers.map((server) => server.name),
      plugins: inventory.plugins.map((plugin) => plugin.id),
    };
    const receipt = await call(
      'preflight',
      'project.extensions.set',
      {
        project_id: project.id,
        runtime,
        overrides: {
          disabled_mcp_servers: inventory.mcp_servers
            .filter((server) => !server.plugin)
            .map((server) => server.name),
          disabled_plugins: inventory.plugins.map((plugin) => plugin.id),
          disabled_skills: [],
          disable_apps: true,
          disable_hooks: true,
        },
      },
      revision,
    );
    revision = receipt.revision;
  }
  return inventories;
}

/** The runtime's cheapest listed model by name and its lowest effort from low up; the default without one. */
export async function cheapModel(get, projectId, runtime) {
  const models = await get('runtime.models', { project_id: projectId, runtime });
  // Haiku and the Luna or mini models are the small tiers of each family.
  const name = runtime === 'claude' ? /haiku/i : /luna|mini/i;
  const model = models.find((row) => name.test(row.id));
  const effort = ['low', 'medium', 'high'].find((level) => model?.efforts?.includes(level));
  return {
    listed: models.map((row) => row.id),
    ...(model ? { model: model.id } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** The text the runtime streamed for one turn. */
export const replyOf = (events, turnId) =>
  events
    .filter((event) => event.kind === 'agent.message.delta' && event.payload.turn_id === turnId)
    .map((event) => event.payload.text)
    .join('');

/** The text with the user's home directory written as ~ and email addresses blanked. */
export const scrub = (text) => text.replaceAll(os.homedir(), '~').replace(EMAIL, '[email]');

/** Strings scrubbed and cut to 200 characters; account fields blanked. */
export function redact(value) {
  if (typeof value === 'string') {
    const text = scrub(value);
    return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        ACCOUNT_KEY.test(key) && item != null ? '[redacted]' : redact(item),
      ]),
    );
  return value;
}

export const redactedLines = (rows) =>
  rows.map((row) => JSON.stringify(redact(row))).join('\n') + '\n';

/**
 * Names the evidence files whose text matches a credential shape or holds one of the literals:
 * the files already in evidenceDir and the contents still to be written there.
 */
export async function findSecrets(evidenceDir, contents, literals) {
  const texts = {};
  for (const entry of await readdir(evidenceDir, { withFileTypes: true }))
    if (entry.isFile() && !entry.name.endsWith('.png'))
      texts[entry.name] = await readFile(path.join(evidenceDir, entry.name), 'utf8');
  for (const [name, value] of Object.entries(contents))
    texts[name] =
      typeof value === 'string' || value instanceof Uint8Array
        ? String(value)
        : JSON.stringify(value, null, 2);
  const matches = [];
  for (const [file, text] of Object.entries(texts)) {
    for (const pattern of SECRET_PATTERNS)
      if (pattern.test(text)) matches.push({ file, pattern: SECRET_PATTERNS.indexOf(pattern) });
    for (const literal of literals)
      if (literal && text.includes(literal)) matches.push({ file, pattern: 'literal' });
  }
  return {
    files_scanned: Object.keys(texts).sort(),
    patterns: SECRET_PATTERNS.map((pattern) => pattern.source),
    matches,
  };
}

/** Whether a recorded process still runs: same pid and the same start second. */
export function identityAlive(identity) {
  const current = readProcessIdentity(identity.pid);
  if (!current) return false;
  if (identity.start_time_us === undefined || current.start_time_us === undefined) return true;
  return (
    Math.floor(identity.start_time_us / 1000000) === Math.floor(current.start_time_us / 1000000)
  );
}

/** Whether pid runs a command line that holds marker; ps exits 1 when the pid is gone. */
export function runsWithMarker(pid, marker) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: REQUEST_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).includes(marker);
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}
