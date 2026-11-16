import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function files(target) {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!info.isDirectory()) return [{ path: target, mtime_ms: info.mtimeMs }];
  const found = [];
  for (const entry of await readdir(target)) found.push(...(await files(path.join(target, entry))));
  return found;
}

const relative = (repoRoot, file) =>
  file && { path: path.relative(repoRoot, file.path), mtime_ms: file.mtime_ms };

/** The bundled app is fresh when every file in apps/desktop/out is newer than every input. */
export async function checkDesktopBuild(repoRoot) {
  const packages = await readdir(path.join(repoRoot, 'packages'));
  const inputs = [
    'apps/web/src',
    'apps/web/index.html',
    'apps/desktop/src',
    'apps/desktop/electron.vite.config.ts',
    'apps/daemon/src',
    ...packages.map((name) => `packages/${name}/src`),
  ];
  const inputFiles = (await Promise.all(inputs.map((p) => files(path.join(repoRoot, p))))).flat();
  const outputFiles = await files(path.join(repoRoot, 'apps/desktop/out'));
  const newest = inputFiles.reduce((a, b) => (!a || b.mtime_ms > a.mtime_ms ? b : a), null);
  const oldest = outputFiles.reduce((a, b) => (!a || b.mtime_ms < a.mtime_ms ? b : a), null);
  return {
    fresh: Boolean(newest && oldest && oldest.mtime_ms > newest.mtime_ms),
    newest_input: relative(repoRoot, newest),
    oldest_output: relative(repoRoot, oldest),
  };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Processes in the group, each with its parent and command line. */
function groupMembers(pgid) {
  let out;
  try {
    out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,command='], {
      encoding: 'utf8',
    });
  } catch (error) {
    throw new Error(`ps failed: ${error.message}`);
  }
  return out
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && Number(m[3]) === pgid)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[4] }));
}

/**
 * A window of `size` centred on the first display that is not the main one, in Electron's
 * top-left coordinates; null with one display. AppKit frames start at the main display's
 * bottom-left corner with y growing upwards.
 */
function secondDisplayWindow(size) {
  let screens;
  try {
    screens = JSON.parse(
      execFileSync(
        'osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          'ObjC.import("AppKit"); const s = $.NSScreen.screens; const out = []; for (let i = 0; i < s.count; i++) { const f = s.objectAtIndex(i).visibleFrame; out.push([f.origin.x, f.origin.y, f.size.width, f.size.height]); } JSON.stringify(out)',
        ],
        { encoding: 'utf8' },
      ),
    );
  } catch {
    return null;
  }
  const main = screens[0];
  const other = screens[1];
  if (!main || !other) return null;
  const [x, y, width, height] = other;
  const mainTop = main[1] + main[3];
  if (width < size.width || height < size.height) return null;
  return {
    x: Math.round(x + (width - size.width) / 2),
    y: Math.round(mainTop - (y + height) + (height - size.height) / 2),
    ...size,
    maximized: false,
  };
}

/** The process id of the frontmost app; null when lsappinfo cannot say. */
function frontPid() {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    const info = execFileSync('lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8' });
    return Number(info.match(/(\d+)/)?.[1]) || null;
  } catch {
    return null;
  }
}

/** Gives the focus back to `previous` once the app's window takes it, for at most 20 s. */
async function returnFocus(previous, group) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const front = frontPid();
    if (front !== null && groupMembers(group).some((m) => m.pid === front)) {
      execFileSync('osascript', [
        '-l',
        'JavaScript',
        '-e',
        `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${previous}).activateWithOptions(0)`,
      ]);
      return;
    }
    await delay(200);
  }
}

/**
 * A page expression that is true once the sidebar names the project. A first launch shows the
 * list of projects instead, so the expression opens the project from that list.
 */
export const projectShown = (name) => `(() => {
  const named = (el) => (el?.textContent ?? '').includes(${JSON.stringify(name)});
  if (named(document.querySelector('button[aria-label="切换项目"]'))) return true;
  [...document.querySelectorAll('nav[aria-label="项目"] button')].find(named)?.click();
  return false;
})()`;

export async function launchDesktopApp({
  repoRoot,
  dataDir,
  deadline,
  size = { width: 1280, height: 800 },
}) {
  const appDir = path.join(repoRoot, 'apps/desktop');
  const electron = createRequire(path.join(appDir, 'package.json'))('electron');
  const port = await freePort();
  // The main process carries the marker; its helpers carry this run's user data directory.
  const marker = `--pantheon-acceptance-run=${randomBytes(8).toString('hex')}`;
  const helperMarker = `--user-data-dir=${path.join(dataDir, 'desktop')}`;
  const marked = (command) => command.includes(marker) || command.includes(helperMarker);
  const env = { ...process.env, PANTHEON_DATA_DIR: dataDir, PANTHEON_ALLOW_FIXTURE: '1' };
  delete env.ELECTRON_RENDERER_URL;
  // Opens the window on a second display, so the laptop screen stays free while a run clicks.
  const placed = secondDisplayWindow(size);
  const focused = frontPid();
  await mkdir(path.join(dataDir, 'desktop'), { recursive: true });
  await writeFile(
    path.join(dataDir, 'desktop', 'window.json'),
    JSON.stringify(placed ?? { ...size, maximized: false }),
  );
  // The scenarios find controls by their Simplified Chinese names.
  const settingsFile = path.join(dataDir, 'desktop', 'settings.json');
  const settings = await readFile(settingsFile, 'utf8').then(JSON.parse, () => ({}));
  await writeFile(settingsFile, JSON.stringify({ locale: 'zh-CN', ...settings }));
  const child = spawn(
    electron,
    [
      appDir,
      `--remote-debugging-port=${port}`,
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      // A window another window covers draws no frames on macOS, so every click waits out its deadline.
      '--disable-backgrounding-occluded-windows',
      marker,
    ],
    { detached: true, stdio: 'ignore', env },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out: starting Electron')),
      Math.max(0, deadline - Date.now()),
    );
    child.once('spawn', () => (clearTimeout(timer), resolve()));
    child.once('error', (error) => (clearTimeout(timer), reject(error)));
  });
  const pid = child.pid;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  // Clicks and keys arrive over CDP, so the app needs no focus; the user's app keeps it.
  if (placed && focused !== null) void returnFocus(focused, pid).catch(() => {});

  // Polls until the app's main process has exited, for at most `ms`.
  const waitExit = async (ms) => {
    const until = Date.now() + ms;
    while (!exited() && Date.now() < until) await delay(Math.min(50, until - Date.now()));
    return exited();
  };

  // Signals the app's process group only if every member descends from `pid` and carries the marker;
  // otherwise only the main process, which Node has not reaped and so is still this child.
  const signalGroup = (signal) => {
    const members = groupMembers(pid);
    const byPid = new Map(members.map((m) => [m.pid, m]));
    const descends = (member) => {
      for (let at = member; at; at = byPid.get(at.ppid)) if (at.pid === pid) return true;
      return false;
    };
    const lines = members.map((m) => `  ${m.pid} (parent ${m.ppid}) ${m.command.slice(0, 160)}`);
    console.error(`desktop-app: ${signal} to process group ${pid}:\n${lines.join('\n')}`);
    const stranger = members.find((m) => !descends(m) || !marked(m.command));
    const refused = !byPid.has(pid)
      ? `process ${pid} is not in its own group`
      : stranger && `process ${stranger.pid} is not marked as this app's`;
    if (refused && exited()) return `${signal} not sent: ${refused}`;
    try {
      process.kill(refused ? pid : -pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') return `${signal} failed: ${error.message}`;
    }
    return refused ? `${signal} sent to ${pid} only: ${refused}` : null;
  };

  async function stop(stopDeadline = Date.now() + 20_000) {
    const left = (cap) => Math.max(0, Math.min(cap, stopDeadline - Date.now()));
    if (exited()) return { stopped: !alive(pid), how: 'already exited' };
    const notes = [];
    // A signal quits without the confirmation the app shows while sessions run, which nobody answers here.
    let how = 'SIGTERM';
    const refused = signalGroup('SIGTERM');
    if (refused) notes.push(refused);
    if (!(await waitExit(left(8000)))) {
      how = 'SIGKILL';
      const refusedKill = signalGroup('SIGKILL');
      if (refusedKill) notes.push(refusedKill);
      await waitExit(Math.max(1000, left(5000)));
    }
    const stopped = exited() && !alive(pid);
    return { stopped, how: notes.length ? `${how} (${notes.join('; ')})` : how };
  }

  return { pid, port, child, stop };
}
