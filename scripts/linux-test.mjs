// Runs a command (default: pnpm test) on a copy of this checkout inside a privileged Linux container.
// node scripts/linux-test.mjs [command...]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { devEngines, packageManager: pnpm } = JSON.parse(
  readFileSync(path.join(repo, 'package.json'), 'utf8'),
);
const version = devEngines.runtime.version;
const image = `pantheon-linux-test:node${version}`;

const dockerfile = `FROM node:${version}-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git bubblewrap socat ca-certificates procps netcat-openbsd && rm -rf /var/lib/apt/lists/*
RUN npm install -g ${pnpm}
RUN git config --global user.name test && git config --global user.email test@example.invalid && git config --global init.defaultBranch main
`;
execFileSync('docker', ['build', '-q', '-t', image, '-'], {
  input: dockerfile,
  stdio: ['pipe', 'ignore', 'inherit'],
});

// Tracked and untracked files minus ignored ones, so the container builds its own node_modules for Linux.
// git still lists a tracked file that is deleted in the working tree, and tar stops on a missing file.
const deleted = new Set(
  execFileSync('git', ['ls-files', '-d', '-z'], { cwd: repo }).toString().split('\0'),
);
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repo })
  .toString()
  .split('\0')
  .filter((file) => file && !deleted.has(file))
  .map((file) => `${file}\0`)
  .join('');
const archive = execFileSync('tar', ['-c', '--null', '-T', '-', '-f', '-'], {
  cwd: repo,
  input: files,
  maxBuffer: 1 << 30,
  // macOS tar otherwise adds ._ AppleDouble files that break JSON and module globs.
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});

const command = process.argv.slice(2).join(' ') || 'pnpm test';
// bubblewrap needs user namespaces, which an unprivileged container does not get.
const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-i',
    // An init as PID 1 reaps orphans, as on a real system; bash would leave them as zombies in process groups.
    '--init',
    '--privileged',
    '-v',
    'pantheon-linux-pnpm-store:/pnpm-store',
    // LINUX_TEST_OUT: an absolute directory on the Docker host, mounted at /out for files the command keeps.
    ...(process.env.LINUX_TEST_OUT ? ['-v', `${process.env.LINUX_TEST_OUT}:/out`] : []),
    '-e',
    'CI=1',
    image,
    'bash',
    '-c',
    `set -e; mkdir -p /repo && cd /repo && tar -x -f - && git init -q && git add -A && git commit -qm snapshot && pnpm config set store-dir /pnpm-store && pnpm install --frozen-lockfile >/tmp/install.log 2>&1 || { tail -40 /tmp/install.log; exit 1; }; ${command}`,
  ],
  { input: archive, stdio: ['pipe', 'inherit', 'inherit'], maxBuffer: 1 << 30 },
);
process.exit(result.status ?? 1);
