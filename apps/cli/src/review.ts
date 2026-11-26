import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Review, ReviewFinding } from '@pantheon/domain';
import {
  command,
  USER_PRINCIPAL_ID,
  type CommandType,
  type RuntimeStatus,
} from '@pantheon/protocol';

export interface Daemon {
  url: string;
  token: string;
  /** The data directory review and land found the daemon in. */
  dataDir?: string;
}

export const reviewUsage =
  'review [--base REF] [RANGE] [--runtime NAME]... [--fallback NAME]... [--focus TEXT] [--paths A,B]';
/** The most diff one review part carries; a larger file goes alone in its part. */
const PART_BYTES = 150 * 1024;
const MAX_PARTS = 8;
/** The most paths one review.range takes. */
const PART_PATHS = 500;
const outcomes = ['fixed', 'intentional', 'not_worth_it', 'wrong'];
export const resolveUsage = `review resolve REVIEW_ID FINDING_ID ${outcomes.join('|')} [--note TEXT]`;

export const usageError = (message: string): never => {
  console.error(message);
  process.exit(64);
};

/** The value as one shell word. */
export const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Exits 2 saying no daemon runs for the data directory. */
export const notRunning = (directory: string): never => {
  console.error(
    `Pantheon daemon is not running (data dir ${directory}). Open the app, or run pnpm relaunch in the Pantheon repo.`,
  );
  return process.exit(2);
};

const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' });

/** The main checkout of the repository around the current directory, also from a linked worktree. */
export const projectRoot = () => {
  const result = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  if (result.status !== 0) return usageError('Not inside a git repository.');
  return realpathSync(path.dirname(result.stdout.trim()));
};

/**
 * The ref as the main checkout reads it. A linked worktree has its own HEAD, ORIG_HEAD and other
 * pseudo-refs, so a ref outside the branches, tags and remotes goes as its commit.
 */
export const sharedRef = (ref: string) => {
  const full = git('rev-parse', '--symbolic-full-name', '--verify', '-q', '--end-of-options', ref);
  if (/^refs\/(heads|tags|remotes)\//.test(full.stdout.trim()))
    return git(
      'rev-parse',
      '--abbrev-ref',
      '--verify',
      '-q',
      '--end-of-options',
      ref,
    ).stdout.trim();
  const commit = git('rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`);
  return commit.status === 0 ? commit.stdout.trim() : ref;
};

// The settings the daemon's runGit runs git with, so planning runs none of the repository's programs.
const hardened = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
  '-c',
  'log.showSignature=false',
  '-c',
  'gpg.program=/usr/bin/false',
  '-c',
  'gpg.openpgp.program=/usr/bin/false',
  '-c',
  'gpg.x509.program=/usr/bin/false',
  '-c',
  'gpg.ssh.program=/usr/bin/false',
  // Patch headers then name a non-ASCII path as the name status does.
  '-c',
  'core.quotePath=false',
];
const noDrivers = ['--no-ext-diff', '--no-textconv'];

const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
/** The patch header with each path git C-quoted written out as the name status writes it. */
const unquoted = (header: string) =>
  header.replace(/"((?:[^"\\]|\\.)*)"/g, (_, quoted: string) => {
    const bytes: number[] = [];
    for (let index = 0; index < quoted.length; index++) {
      const char = String.fromCodePoint(quoted.codePointAt(index)!);
      if (char !== '\\') {
        bytes.push(...Buffer.from(char));
        index += char.length - 1;
        continue;
      }
      const next = quoted[++index]!;
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(quoted.slice(index, index + 3), 8));
        index += 2;
      } else bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
    return Buffer.from(bytes).toString('utf8');
  });

/** Git's output in the root; a failure prints the message given, or git's, and exits 2. */
const inRoot = (root: string, args: string[], failure?: string) => {
  const result = spawnSync('git', ['-C', root, ...hardened, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  if (result.status !== 0) {
    console.error(failure ?? (result.stderr?.trim() || `git ${args[0]} failed`));
    process.exit(2);
  }
  return result.stdout;
};

/**
 * The paths of each review part of a range, packed in diff order, and the deleted files the parts
 * are reviewed without; a range within PART_BYTES goes as one part without paths.
 */
const rangeParts = (
  root: string,
  from: string,
  to: string,
): { parts: (string[] | undefined)[]; deleted: string[] } => {
  const range = [from, to, '--'];
  const fields = inRoot(root, ['diff', '--name-status', '-z', ...noDrivers, ...range]).split('\0');
  const deleted: string[] = [];
  const entries: { header: string; paths: string[] }[] = [];
  for (let index = 0; fields[index]; index++) {
    const status = fields[index]!;
    const paths = fields.slice(index + 1, index + (/^[RC]/.test(status) ? 3 : 2));
    index += paths.length;
    if (status === 'D') deleted.push(...paths);
    else entries.push({ header: `diff --git a/${paths[0]} b/${paths.at(-1)}`, paths });
  }
  const patch = inRoot(root, [
    'diff',
    '--no-color',
    ...noDrivers,
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--diff-filter=d',
    ...range,
  ]);
  if (Buffer.byteLength(patch) <= PART_BYTES && (entries.length || !deleted.length))
    return { parts: [undefined], deleted };
  // A type change has two sections under one header.
  const sizes = new Map<string, number>();
  for (const section of patch.split(/^(?=diff --git )/m)) {
    const header = unquoted(section.slice(0, section.indexOf('\n')));
    sizes.set(header, (sizes.get(header) ?? 0) + Buffer.byteLength(section));
  }
  const parts: { paths: string[]; bytes: number }[] = [];
  for (const { header, paths } of entries) {
    const bytes = sizes.get(header) ?? 0;
    const last = parts.at(-1);
    if (
      last &&
      last.bytes + bytes <= PART_BYTES &&
      last.paths.length + paths.length <= PART_PATHS
    ) {
      last.paths.push(...paths);
      last.bytes += bytes;
    } else parts.push({ paths, bytes });
  }
  if (parts.length > MAX_PARTS)
    usageError(
      `The range needs ${parts.length} review parts of at most ${PART_BYTES / 1024} KB, over ${MAX_PARTS}; review fewer files with --paths.`,
    );
  return { parts: parts.map((part) => part.paths), deleted };
};

/** The branch checked out in the current directory; undefined on a detached HEAD. */
export const currentBranch = () => {
  const result = git('symbolic-ref', '--short', '-q', 'HEAD');
  return result.status === 0 ? result.stdout.trim() : undefined;
};

export const sendCommand = async (
  daemon: Daemon,
  type: CommandType,
  input: Record<string, unknown>,
  timeout: number,
  expectedRevision: number | null = null,
) => {
  try {
    const response = await fetch(new URL('/v1/commands', daemon.url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command(USER_PRINCIPAL_ID, type, input, expectedRevision)),
      signal: AbortSignal.timeout(timeout),
    });
    return { ok: response.ok, body: (await response.json()) as { receipt: unknown } };
  } catch (error) {
    if (daemon.dataDir !== undefined && !(await readHealth(daemon.url))) notRunning(daemon.dataDir);
    throw error;
  }
};

/**
 * Reads the query once a second until done; Ctrl-C only stops the wait. A read that fails while no
 * daemon answers /health exits 2.
 */
export const poll = async <T>(
  daemon: Daemon,
  method: string,
  key: string,
  id: string,
  done: (value: T) => boolean,
  each: (value: T) => void | Promise<void> = () => {},
) => {
  const url = new URL(`/v1/${method}`, daemon.url);
  url.searchParams.set(key, id);
  for (;;) {
    await delay(1000);
    let response: Response, value: T;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${daemon.token}` },
        signal: AbortSignal.timeout(5000),
      });
      value = (await response.json()) as T;
    } catch (error) {
      if (daemon.dataDir !== undefined && !(await readHealth(daemon.url)))
        notRunning(daemon.dataDir);
      throw error;
    }
    if (!response.ok) throw new Error(JSON.stringify(value));
    await each(value);
    if (done(value)) return value;
  }
};

/** The /health of the daemon at the url; undefined when no Pantheon daemon answers it. */
export const readHealth = async (url: string) => {
  try {
    const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(3000) });
    const health = (await response.json()) as {
      service?: string;
      version?: string;
      restart_required?: string;
    };
    return response.ok && health.service === 'pantheon' ? health : undefined;
  } catch {
    return undefined;
  }
};

/** Exits 2 when the daemon has to restart first. */
export const stopForRestart = (health: { restart_required?: string } | undefined) => {
  if (!health?.restart_required) return;
  console.error(`${health.restart_required} Restart the daemon: pnpm relaunch`);
  process.exit(2);
};

/** How often a wait reads whether the daemon has to restart and its runtimes are connected. */
export const STATUS_MS = 15_000;

/**
 * Says once when a runtime the review waits for disconnects, and once when it connects again, also
 * after the review stopped waiting for it; a status read that fails is tried again at the next read.
 */
const watchRuntimes = (daemon: Daemon) => {
  const down = new Set<string>();
  let readAt = -Infinity;
  return async (review: Review) => {
    if (Date.now() - readAt < STATUS_MS) return;
    readAt = Date.now();
    const [health, statuses] = await Promise.all([
      readHealth(daemon.url),
      fetch(new URL('/v1/runtime.status', daemon.url), {
        headers: { Authorization: `Bearer ${daemon.token}` },
        signal: AbortSignal.timeout(5000),
      })
        .then(async (response) => (response.ok ? ((await response.json()) as unknown) : undefined))
        .then((body) => (Array.isArray(body) ? (body as RuntimeStatus[]) : undefined))
        .catch(() => undefined),
    ]);
    stopForRestart(health);
    const waiting = (review.executions ?? [])
      .filter((execution) => execution.state === 'queued' || execution.state === 'running')
      .map((execution) => execution.runtime);
    for (const { runtime, connection, enabled } of statuses ?? []) {
      // A disabled runtime has no adapter, so it reads as disconnected while its turn still runs.
      if ((!waiting.includes(runtime) && !down.has(runtime)) || enabled === false) continue;
      if (connection?.connected === false && !down.has(runtime)) {
        // Only an outage the daemon recorded has a time and a retry; a missing executable has neither.
        down.add(runtime);
        console.error(
          `${runtime} is disconnected${connection.disconnected_since ? ` since ${connection.disconnected_since}` : ''}${connection.reason ? ` (${connection.reason})` : ''}; the review waits ${connection.disconnected_since ? 'while the daemon retries it' : 'for it'}.`,
        );
      } else if (connection?.connected === true && down.delete(runtime))
        console.error(`${runtime} reconnected`);
    }
  };
};

const printFinding = (finding: ReviewFinding) => {
  const mark = finding.resolution
    ? `resolved: ${finding.resolution.outcome}`
    : finding.blocking
      ? 'blocking'
      : 'report';
  console.log(`${finding.location} [${mark}] ${finding.runtime}: ${finding.impact}`);
  console.log(`  id: ${finding.id}`);
  console.log(`  quote: ${finding.quote}`);
  console.log(`  evidence: ${finding.evidence}`);
};

/** Records the user's outcome on one finding, at the review's current revision. */
const resolve = async (
  connect: () => Daemon | Promise<Daemon>,
  positionals: string[],
  note?: string,
) => {
  const [reviewId, findingId, outcome] = positionals;
  if (positionals.length !== 3 || !outcomes.includes(outcome!))
    return usageError(`Usage: pantheon ${resolveUsage}`);
  try {
    const daemon = await connect();
    const url = new URL('/v1/review.read', daemon.url);
    url.searchParams.set('review_id', reviewId!);
    const read = await fetch(url, {
      headers: { Authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(5000),
    });
    const current = (await read.json()) as Review;
    if (!read.ok) throw new Error(JSON.stringify(current));
    const sent = await sendCommand(
      daemon,
      'review.finding.resolve',
      {
        review_id: reviewId,
        finding_id: findingId,
        outcome,
        ...(note === undefined ? {} : { note }),
      },
      5000,
      current.revision,
    );
    if (!sent.ok) {
      console.error(JSON.stringify(sent.body, null, 2));
      return 2;
    }
  } catch (error) {
    console.error(String(error));
    return 2;
  }
  console.log(`${findingId}: ${outcome}`);
  return 0;
};

export const review = async (
  connect: () => Daemon | Promise<Daemon>,
  positionals: string[],
  values: {
    base?: string;
    runtime?: string[];
    fallback?: string[];
    note?: string;
    focus?: string;
    paths?: string;
    'data-dir'?: string;
  },
) => {
  if (positionals[0] === 'resolve') return resolve(connect, positionals.slice(1), values.note);
  if (positionals.length > 1) usageError(`Usage: pantheon ${reviewUsage}`);
  let base = values.base,
    head = positionals[0];
  const separator = head?.indexOf('..') ?? -1;
  if (head && separator >= 0) {
    if (base) usageError('Give the base either with --base or in A..B, not both.');
    base = head.slice(0, separator);
    head = head.slice(separator + 2).replace(/^\./, '');
    if (!base || !head) usageError(`Usage: pantheon ${reviewUsage}`);
  }
  if (!base) return usageError(`Usage: pantheon ${reviewUsage}`);
  const root = projectRoot();
  const defaulted = !head;
  head ??= 'HEAD';
  const here = process.cwd();
  if (defaulted && inRoot(here, ['status', '--porcelain']).trim())
    console.error('Uncommitted changes are not reviewed; only committed content is.');
  // Every part reviews the same commits, whatever the refs point at meanwhile, as this worktree reads them.
  const commitOf = (ref: string) =>
    inRoot(
      here,
      ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`],
      `unknown revision: ${ref}`,
    ).trim();
  const to = commitOf(head);
  const from = inRoot(
    root,
    ['merge-base', '--end-of-options', commitOf(base), to],
    `${base} and ${head} share no history`,
  ).trim();
  const split =
    values.paths === undefined
      ? rangeParts(root, from, to)
      : { parts: [values.paths.split(',').filter(Boolean)], deleted: [] };
  if (split.deleted.length) console.log(`LEFT OUT (deleted): ${split.deleted.join(', ')}`);
  const parts = split.parts;
  if (!parts.length) {
    console.error('Only deleted files changed; no part is left to review.');
    return 2;
  }
  // A part without a blocking count ended in an error.
  const settled: { label: string; id?: string; code: number; blocking?: number }[] = [];
  for (const [index, paths] of parts.entries()) {
    const label = `PART ${index + 1}/${parts.length}`;
    let id: string | undefined;
    try {
      const daemon = await connect();
      const sent = await sendCommand(
        daemon,
        'review.range',
        {
          root,
          base: from,
          head: to,
          ...(values.focus === undefined ? {} : { focus: values.focus }),
          ...(paths ? { paths } : {}),
          ...(values.paths === undefined ? { exclude_deleted: true } : {}),
          ...(values.runtime?.length ? { runtimes: values.runtime } : {}),
          ...(values.fallback?.length ? { fallback: values.fallback } : {}),
        },
        60_000,
      );
      if (!sent.ok) {
        console.error(JSON.stringify(sent.body, null, 2));
        settled.push({ label, code: 2 });
        continue;
      }
      const started = sent.body.receipt as Review;
      id = started.id;
      if (parts.length > 1) console.log(`${label} ${started.id}`);
      console.error(`Review ${started.id} started: ${started.runtimes.join(', ')}`);
      const watch = watchRuntimes(daemon);
      const result = await poll<Review>(
        daemon,
        'review.read',
        'review_id',
        started.id,
        (value) => value.state !== 'running',
        (value) => (value.state === 'running' ? watch(value) : undefined),
      );
      const blocking = result.findings.filter(unresolvedBlocking).length;
      settled.push({ label, id: result.id, code: printReview(result, started.runtimes), blocking });
    } catch (error) {
      // Exit 1 means the review blocks; one that never finished or reads back malformed is exit 2.
      console.error(String(error));
      settled.push({ label, id, code: 2 });
    }
  }
  if (settled.length === 1) return settled[0]!.code;
  for (const part of settled)
    console.log(
      part.blocking === undefined
        ? `${part.label}${part.id ? ` ${part.id}` : ''}: error`
        : `${part.label} ${part.id}: ${['pass', 'fail', 'incomplete'][part.code]}, ${part.blocking} blocking`,
    );
  const codes = settled.map((part) => part.code);
  return codes.includes(1) ? 1 : codes.includes(2) ? 2 : 0;
};

const unresolvedBlocking = (finding: ReviewFinding) =>
  finding.status === 'open' && finding.blocking && !finding.resolution;

/** Prints a settled review's open findings and verdicts; returns its exit code. `asked` is the start receipt's runtimes. */
const printReview = (result: Review, asked: string[]) => {
  const open = result.findings.filter((finding) => finding.status === 'open');
  const located = open
    .filter((finding) => !finding.unlocated)
    .sort((a, b) => a.location.localeCompare(b.location, undefined, { numeric: true }));
  const unlocated = open.filter((finding) => finding.unlocated);
  located.forEach(printFinding);
  if (unlocated.length) {
    console.log('Without file:line:');
    unlocated.forEach(printFinding);
  }
  const verdicts = result.verdicts ?? [];
  for (const replaced of result.replacements ?? [])
    console.log(`${replaced.runtime}: replaced by ${replaced.by} (${replaced.reason})`);
  const reviewers = [...new Set([...asked, ...result.runtimes])].filter(
    (runtime) => !result.replacements?.some((replaced) => replaced.runtime === runtime),
  );
  for (const runtime of reviewers) {
    const mine = verdicts.filter((verdict) => verdict.runtime === runtime);
    const failed = result.executions?.find((execution) => execution.runtime === runtime);
    const why = [failed?.error_code, failed?.error?.split('\n')[0]].filter(Boolean).join(': ');
    if (!mine.length) console.log(`${runtime}: no verdict${why ? ` (${why})` : ''}`);
    for (const verdict of mine) console.log(`${runtime}: ${verdict.verdict} — ${verdict.summary}`);
  }
  if (result.incomplete) console.log(`incomplete: ${result.incomplete}`);
  if (open.some(unresolvedBlocking) || verdicts.some((verdict) => verdict.verdict === 'fail'))
    return 1;
  const passed = reviewers.every((runtime) =>
    verdicts.some((verdict) => verdict.runtime === runtime && verdict.verdict === 'pass'),
  );
  return result.state === 'completed' && !result.incomplete && passed ? 0 : 2;
};
