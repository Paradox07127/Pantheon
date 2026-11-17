// Starts a fixture daemon with one project and the desktop app on it, writes run.json, and stays up
// until SIGTERM or SIGINT.
//   node tests/acceptance/verify/boot.mjs [--size 1440x900] [--out <runDir>]
// Without --out the run directory is .notes/evidence/verify-app/<local time>/.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/cdp.mjs';
import { startNativeDaemon } from '../lib/daemon.mjs';
import { checkDesktopBuild, launchDesktopApp, projectShown } from '../lib/desktop-app.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const PROJECT_NAME = 'verify-app';
const sizeArg = process.argv[process.argv.indexOf('--size') + 1];
const [width, height] =
  process.argv.includes('--size') && /^\d+x\d+$/.test(sizeArg)
    ? sizeArg.split('x').map(Number)
    : [1280, 800];
const outArg = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : undefined;

const build = await checkDesktopBuild(repoRoot);
if (!build.fresh) {
  console.error(
    `apps/desktop/out is older than ${build.newest_input?.path}; run pnpm build && pnpm --filter @pantheon/desktop bundle`,
  );
  process.exit(3);
}

// Local time, e.g. 20261116-201142.
const stamp = new Date().toLocaleString('sv-SE').replace(/[-:]/g, '').replace(' ', '-');
const runDir = outArg
  ? path.resolve(outArg)
  : path.join(repoRoot, '.notes/evidence/verify-app', stamp);
await mkdir(path.join(repoRoot, 'node_modules/.cache'), { recursive: true });
const workspace = await mkdtemp(path.join(repoRoot, 'node_modules/.cache/verify-app-'));
const repo = path.join(workspace, 'repo');
for (const dir of [runDir, repo, path.join(workspace, 'home'), path.join(workspace, 'no-hooks')])
  await mkdir(dir, { recursive: true });

const git = (...args) =>
  execFileSync('git', args, {
    cwd: repo,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Verify App');
git('config', 'user.email', 'verify-app@example.invalid');
git('config', 'core.hooksPath', path.join(workspace, 'no-hooks'));
await writeFile(path.join(repo, 'README.md'), '# verify-app\n');
git('add', '-A');
git('commit', '-q', '-m', 'Initial commit');

const fixture = await startNativeDaemon(workspace, undefined, {
  intervalMs: 200,
  home: path.join(workspace, 'home'),
});
const project_id = (await fixture.call('project.open', { name: PROJECT_NAME, roots: [repo] })).id;

const deadline = Date.now() + 90_000;
const app = await launchDesktopApp({
  repoRoot,
  dataDir: path.join(workspace, 'state'),
  deadline,
  size: { width, height },
});
const page = await connect(app.port, deadline, { evidenceDir: runDir });
await page.waitFor(projectShown(PROJECT_NAME), 'the sidebar to show the project');
await page.screenshot('boot');
page.close();

await writeFile(
  path.join(runDir, 'run.json'),
  JSON.stringify(
    {
      pid: process.pid,
      port: app.port,
      daemon_url: fixture.daemon.url,
      token: fixture.daemon.token,
      project_id,
      project_name: PROJECT_NAME,
      repo,
      workspace,
      size: { width, height },
    },
    null,
    2,
  ),
);
console.log(`READY ${runDir}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const result = await app.stop();
  await fixture.close();
  await rm(workspace, { recursive: true, force: true });
  console.log(`STOPPED app ${result.how}`);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1 << 30);
