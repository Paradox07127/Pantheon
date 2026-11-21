import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Review, ReviewFinding } from '@pantheon/domain';
import { command, USER_PRINCIPAL_ID, type CommandType } from '@pantheon/protocol';

export interface Daemon {
  url: string;
  token: string;
}

export const reviewUsage = 'review [--base REF] [RANGE] [--runtime NAME]...';
const outcomes = ['fixed', 'intentional', 'not_worth_it', 'wrong'];
export const resolveUsage = `review resolve REVIEW_ID FINDING_ID ${outcomes.join('|')} [--note TEXT]`;

export const usageError = (message: string): never => {
  console.error(message);
  process.exit(64);
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
  const response = await fetch(new URL('/v1/commands', daemon.url), {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command(USER_PRINCIPAL_ID, type, input, expectedRevision)),
    signal: AbortSignal.timeout(timeout),
  });
  return { ok: response.ok, body: (await response.json()) as { receipt: unknown } };
};

/** Reads the query once a second until done; Ctrl-C only stops the wait. */
export const poll = async <T>(
  daemon: Daemon,
  method: string,
  key: string,
  id: string,
  done: (value: T) => boolean,
  each: (value: T) => void = () => {},
) => {
  const url = new URL(`/v1/${method}`, daemon.url);
  url.searchParams.set(key, id);
  for (;;) {
    await delay(1000);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(5000),
    });
    const value = (await response.json()) as T;
    if (!response.ok) throw new Error(JSON.stringify(value));
    each(value);
    if (done(value)) return value;
  }
};

const printFinding = (finding: ReviewFinding) => {
  console.log(
    `${finding.location} [${finding.blocking ? 'blocking' : 'report'}] ${finding.runtime}: ${finding.impact}`,
  );
  console.log(`  id: ${finding.id}`);
  console.log(`  quote: ${finding.quote}`);
  console.log(`  evidence: ${finding.evidence}`);
};

/** Records the user's outcome on one finding, at the review's current revision. */
const resolve = async (connect: () => Daemon, positionals: string[], note?: string) => {
  const [reviewId, findingId, outcome] = positionals;
  if (positionals.length !== 3 || !outcomes.includes(outcome!))
    return usageError(`Usage: pantheon ${resolveUsage}`);
  try {
    const daemon = connect();
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
  connect: () => Daemon,
  positionals: string[],
  values: { base?: string; runtime?: string[]; note?: string },
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
  base = sharedRef(base);
  head = sharedRef(head ?? 'HEAD');
  if (defaulted && git('status', '--porcelain').stdout.trim())
    console.error('Uncommitted changes are not reviewed; only committed content is.');
  let result: Review;
  try {
    const daemon = connect();
    const sent = await sendCommand(
      daemon,
      'review.range',
      { root, base, head, ...(values.runtime?.length ? { runtimes: values.runtime } : {}) },
      60_000,
    );
    if (!sent.ok) {
      console.error(JSON.stringify(sent.body, null, 2));
      return 2;
    }
    const started = sent.body.receipt as Review;
    console.error(`Review ${started.id} started: ${started.runtimes.join(', ')}`);
    result = await poll<Review>(
      daemon,
      'review.read',
      'review_id',
      started.id,
      (value) => value.state !== 'running',
    );
  } catch (error) {
    // Exit 1 means the review blocks; a review that never finished is exit 2.
    console.error(String(error));
    return 2;
  }
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
  for (const runtime of result.runtimes) {
    const mine = verdicts.filter((verdict) => verdict.runtime === runtime);
    if (!mine.length) console.log(`${runtime}: no verdict`);
    for (const verdict of mine) console.log(`${runtime}: ${verdict.verdict} — ${verdict.summary}`);
  }
  if (result.incomplete) console.log(`incomplete: ${result.incomplete}`);
  if (
    open.some((finding) => finding.blocking) ||
    verdicts.some((verdict) => verdict.verdict === 'fail')
  )
    return 1;
  const passed = result.runtimes.every((runtime) =>
    verdicts.some((verdict) => verdict.runtime === runtime && verdict.verdict === 'pass'),
  );
  return result.state === 'completed' && !result.incomplete && passed ? 0 : 2;
};
