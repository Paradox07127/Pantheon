// Runs drivers one after another, writes <runDir>/results.json and appends to <runDir>/history.jsonl.
//   node run.mjs <runDir> [entry ids…]                                  no ids: every driver in drivers/
//   node run.mjs --boot [--out <runDir>] [--size WxH] [entry ids…]    starts boot.mjs first, stops it after
// Exit code: 0 when every driver passes, 1 on any fail or error, 2 when boot does not come up.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const drivers = fileURLToPath(new URL('./drivers/', import.meta.url));
const bootScript = fileURLToPath(new URL('./boot.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const args = process.argv.slice(2);
let runDir;
let asked;
let boot = null;
if (args[0] === '--boot') {
  const bootArgs = [];
  asked = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--out' || args[i] === '--size') bootArgs.push(args[i], args[++i]);
    else asked.push(args[i]);
  }
  boot = await startBoot(bootArgs);
  runDir = boot.runDir;
} else {
  [runDir, ...asked] = args;
}

const ids = asked.length
  ? asked
  : readdirSync(drivers)
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => f.slice(0, -4));

const results = [];
for (const id of ids) {
  const started = Date.now();
  const { code, stdout, stderr } = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [path.join(drivers, `${id}.mjs`), runDir],
      { maxBuffer: 1 << 26, timeout: 180_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    ),
  );
  let output = null;
  try {
    output = JSON.parse(stdout);
  } catch {}
  // A driver that throws before printing is a driver error until shown otherwise.
  const failed = output ? output.checks.filter((c) => !c.ok).map((c) => c.what) : [];
  const result = !output ? 'error' : failed.length || output.errors?.length ? 'fail' : 'pass';
  const thrown =
    stderr
      .split('\n')
      .find((line) => /^\w*Error:/.test(line))
      ?.trim() ?? stderr.trim().slice(0, 300);
  results.push({
    id,
    result,
    failed,
    errors: output?.errors ?? [],
    thrown,
    exit: code,
    ms: Date.now() - started,
    output,
  });
  console.log(
    [
      id,
      result,
      `${Date.now() - started}ms`,
      failed.length ? JSON.stringify(failed) : '',
      result === 'error' ? thrown.slice(0, 300) : '',
    ]
      .filter(Boolean)
      .join('  '),
  );
}
writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));

const at = new Date().toISOString();
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
  .toString()
  .trim();
appendFileSync(
  path.join(runDir, 'history.jsonl'),
  results
    .map(({ id, result, failed }) => JSON.stringify({ at, commit, id, result, failed }) + '\n')
    .join(''),
);

if (boot) console.log(await boot.stop());
process.exit(results.every((r) => r.result === 'pass') ? 0 : 1);

/** Starts boot.mjs and waits for its READY line; exits 2 with boot's output when it does not come. */
async function startBoot(bootArgs) {
  const child = spawn(process.execPath, [bootScript, ...bootArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stdout = '';
  const waiters = new Set();
  const notify = () => waiters.forEach((w) => w());
  child.stdout.on('data', (chunk) => {
    output += chunk;
    stdout += chunk;
    notify();
  });
  child.stderr.on('data', (chunk) => (output += chunk));
  let exited = false;
  child.on('close', () => {
    exited = true;
    notify();
  });
  /** Resolves with the first stdout line matching `pattern`, or null on exit or after `ms`. */
  const waitLine = (pattern, ms) =>
    new Promise((resolve) => {
      const check = () => {
        // The last piece may be a line still being written.
        const line = stdout
          .split('\n')
          .slice(0, -1)
          .find((l) => pattern.test(l));
        if (line || exited) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(line ?? null);
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        resolve(null);
      }, ms);
      waiters.add(check);
      check();
    });

  const ready = await waitLine(/^READY /, 120_000);
  if (!ready) {
    if (!exited) child.kill('SIGTERM');
    console.error(`boot did not print READY within 120s:\n${output}`);
    process.exit(2);
  }
  return {
    runDir: ready.slice('READY '.length).trim(),
    stop: async () => {
      if (exited) return 'boot already exited';
      child.kill('SIGTERM');
      return (await waitLine(/^STOPPED/, 30_000)) ?? 'boot did not stop within 30s';
    },
  };
}
