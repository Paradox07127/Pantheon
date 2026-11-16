// Stops this repo's dev app and its daemon, rebuilds, then runs `pnpm dev` in the foreground.
// pnpm relaunch [--dry-run] [--force]
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Whether a `ps` command line is this repo's dev Electron, electron-vite or watching tsc. */
export function isDevProcess(command, repo) {
  // Worktrees live under the repo but run their own copies.
  if (!command.includes(`${repo}/`) || command.includes(`${repo}/.claude/`)) return false;
  // Acceptance runs drive their Electron over a debugging port.
  if (/\/(Electron|Pantheon Dev)\.app\/Contents\/MacOS\/Electron( |$)/.test(command))
    return command.startsWith(`${repo}/`) && !command.includes('--remote-debugging-port');
  if (command.includes('/electron-vite/') && / dev( |$)/.test(command)) return true;
  return /\/typescript\/bin\/tsc .*--watch/.test(command);
}

/** Whether a `ps` command line is the daemon the desktop bridge starts for this repo and dataDir. */
export const ownsDaemon = (command, repo, dataDir) => {
  const line = `node ${path.join(repo, 'apps/daemon/dist/main.js')} --data-dir ${dataDir}`;
  return command === line || command === `${line} --allow-fixture`;
};

/** Sessions whose native process or stop is still in flight, as the desktop reload counts them. */
export const activeSessions = (board) =>
  board.sessions.filter(
    (s) =>
      s.state === 'running' || s.state === 'reconciling' || s.stop_pending || s.process_identity,
  ).length;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stop(pids, what) {
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  for (let waited = 0; waited < 10_000 && pids.some(alive); waited += 100) await sleep(100);
  const left = pids.filter(alive);
  for (const pid of left) process.kill(pid, 'SIGKILL');
  console.log(
    `stopped ${what}: ${pids.join(', ')}${left.length ? ` (killed ${left.join(', ')})` : ''}`,
  );
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir =
    process.env.PANTHEON_DATA_DIR ??
    path.join(os.homedir(), 'Library/Application Support/Pantheon');

  const processes = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+) (.*)$/))
    .filter(Boolean)
    .map(([, pid, command]) => ({ pid: Number(pid), command }));
  const cwd = (pid) => {
    try {
      return execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
      })
        .split('\n')
        .find((line) => line.startsWith('n'))
        ?.slice(1);
    } catch {
      return undefined;
    }
  };
  // `pnpm dev` runs `node scripts/dev.mjs` from the repo root, so only its working directory names the repo.
  const launchers = processes
    .filter((p) => p.pid !== process.pid && /(^| )node .*scripts\/dev\.mjs$/.test(p.command))
    .filter((p) => cwd(p.pid) === repo)
    .map((p) => p.pid);
  const dev = processes.filter((p) => isDevProcess(p.command, repo)).map((p) => p.pid);

  let daemon;
  try {
    const manifest = JSON.parse(readFileSync(path.join(dataDir, 'daemon.json'), 'utf8'));
    const owned = processes.find(
      (p) => p.pid === manifest.pid && ownsDaemon(p.command, repo, dataDir),
    );
    if (owned) daemon = { pid: owned.pid, url: manifest.url, token_file: manifest.token_file };
  } catch {
    // No daemon.json: no daemon runs for this data directory.
  }
  if (daemon) {
    const token = readFileSync(daemon.token_file, 'utf8').trim();
    const response = await fetch(new URL('/v1/board', daemon.url), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    daemon.active = response.ok ? activeSessions(await response.json()) : undefined;
  }

  console.log(`data directory: ${dataDir}`);
  console.log(`dev launcher: ${launchers.join(', ') || 'none'}`);
  console.log(`dev Electron / electron-vite / tsc watch: ${dev.join(', ') || 'none'}`);
  console.log(
    `daemon: ${daemon ? `${daemon.pid}, ${daemon.active ?? 'unknown'} active sessions` : 'none of this repo'}`,
  );
  if (dryRun) return;
  if (daemon && daemon.active !== 0 && !args.has('--force')) {
    console.error(
      'Not restarting: sessions are still running or their count is unknown. Wait for them, or pass --force to cut them off.',
    );
    process.exitCode = 1;
    return;
  }

  // The launcher forwards SIGTERM to its children; whatever outlives it is stopped directly.
  if (launchers.length) await stop(launchers, 'dev launcher');
  const left = dev.filter(alive);
  if (left.length) await stop(left, 'dev processes');
  if (daemon) await stop([daemon.pid], 'daemon');

  execFileSync('pnpm', ['build'], { cwd: repo, stdio: 'inherit' });
  const child = spawn('pnpm', ['dev'], { cwd: repo, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => (process.exitCode = code ?? 1));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
