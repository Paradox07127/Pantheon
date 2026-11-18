import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { connect, describeLocator } from '../lib/cdp.mjs';
import { startNativeDaemon } from '../lib/daemon.mjs';
import { checkDesktopBuild, launchDesktopApp, projectShown } from '../lib/desktop-app.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '关闭 app 后继续与恢复展示';
export const mode = 'ui';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Shorter than the case's own timeout, which kills the worker without running its cleanup. */
const RUN_MS = 85 * 1000;
const PROJECT_NAME = 'App reopen recovery';
/** A turn that runs until the scenario interrupts it. */
const INPUT = `Keep working until told to stop\nfixture-script\n${JSON.stringify([
  { say: 'Working on a long turn' },
  { hang: true },
])}`;
/** How long the turn runs with no app open before the app is started again. */
const CLOSED_MS = 3000;

const NAV = { name: '导航', exact: true };
const button = (name, extra = {}) => ({ role: 'button', name, exact: true, ...extra });
/** Visible role="alert" texts; any of them fails the wait it guards. */
const ALERTS = `[...document.querySelectorAll('[role="alert"]')]
  .filter((el) => el.getClientRects().length > 0)
  .map((el) => el.innerText.trim() || 'an empty alert')
  .join(' | ')`;
const present = (locator) =>
  `(() => { try { globalThis.__acceptanceLocator.find(${JSON.stringify(locator)}); return true; } catch { return false; } })()`;

// The labels the app draws for a listed session's state, its last turn and a board task status.
const SESSION_LABEL = {
  starting: '创建中',
  running: '运行中',
  idle: '空闲',
  ready: '待合并',
  merging: '合并中',
  failed: '失败',
  merged: '已合并',
  discarded: '已丢弃',
  done: '已完成',
};
const WAITING_LABEL = { approval: '待批准', question: '待回答', baseline_review: '待确认' };
const TASK_STATUS_LABEL = {
  running: '进行中',
  waiting: '待处理',
  idle: '空闲',
  ready: '待合并',
  done: '已完成',
  failed: '失败',
  todo: '未开始',
  discarded: '已丢弃',
};
const CONNECTION_LABELS = ['已连接', '连接中', '已断开'];
const sessionLabel = (row) =>
  row.stopping
    ? '停止中'
    : row.reconciling
      ? '待恢复'
      : row.state === 'waiting'
        ? WAITING_LABEL[row.waiting_kind ?? 'approval']
        : SESSION_LABEL[row.state];
const lastTurnLabel = (row) => {
  if (row.stopping || row.reconciling || !['idle', 'ready'].includes(row.state)) return null;
  if (row.last_turn?.state === 'failed') return '上回合失败';
  if (row.last_turn?.state === 'cancelled') return '上回合已打断';
  return null;
};

/** The session's sidebar row and the turns of the open thread, as the page shows them. */
const sessionShown = (sessionTitle) => `(() => {
  const row = [...document.querySelectorAll('[aria-label="导航"]')]
    .filter((nav) => nav.getClientRects().length > 0)
    .flatMap((nav) => [...nav.querySelectorAll('button[aria-label]')])
    .find((b) => b.getAttribute('aria-label').startsWith(${JSON.stringify(`${sessionTitle}，`)}));
  if (!row) return null;
  return {
    state: row.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null,
    last_turn: row.getAttribute('aria-label').split('，').find((part) => part.startsWith('上回合')) ?? null,
    turns: document.querySelectorAll('[data-turn]').length,
  };
})()`;
/** The status the progress table's row of this task title names, as the board shows it. */
const rowShown = (taskTitle) => `(() => {
  const row = [...document.querySelectorAll('[role="table"][aria-label="进度表"] [role="row"][aria-label]')].find(
    (el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(`${taskTitle}，`)}),
  );
  return row ? { status: row.getAttribute('aria-label').slice(${JSON.stringify(`${taskTitle}，`)}.length) } : null;
})()`;
const connectionState = `[...document.querySelectorAll('[role="img"]')].find((el) => ${JSON.stringify(CONNECTION_LABELS)}.includes(el.getAttribute('aria-label')) && el.getClientRects().length > 0)?.getAttribute('aria-label') ?? null`;
/** Records every change of the connection mark from now on. */
const recordConnection = `(() => {
  const read = () => ${connectionState};
  const seen = (globalThis.__acceptanceConnection = [read()]);
  new MutationObserver(() => {
    const now = read();
    if (now !== seen.at(-1)) seen.push(now);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'data-state'] });
  return seen[0];
})()`;
/** Draws the PNGs, given as base64, at half size two to a row and returns the PNG as base64. */
const montage = (images) => `(async () => {
  const bitmaps = await Promise.all(${JSON.stringify(images)}.map((data) =>
    createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'image/png' })),
  ));
  const w = Math.max(...bitmaps.map((b) => b.width)) / 2;
  const h = Math.max(...bitmaps.map((b) => b.height)) / 2;
  const canvas = new OffscreenCanvas(w * 2, h * Math.ceil(bitmaps.length / 2));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  bitmaps.forEach((b, i) => context.drawImage(b, (i % 2) * w, Math.floor(i / 2) * h, b.width / 2, b.height / 2));
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
})()`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const processStarted = (pid) => {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
/** The process's parent and full command line; null once it is gone. */
const processLine = (pid) => {
  try {
    const out = execFileSync('ps', ['-ww', '-o', 'ppid=,command=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    const [, ppid, command] = out.match(/^\s*(\d+)\s+(.*?)\s*$/s) ?? [];
    return ppid ? { ppid: Number(ppid), command } : null;
  } catch {
    return null;
  }
};

export async function run({ workspace, evidenceDir }) {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_MS;
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  let stateDir = path.join(workspace, 'state');
  const repo = path.join(workspace, 'repo');
  const noHooks = path.join(workspace, 'no-hooks');
  // The second part: a data directory where only the app starts a daemon.
  const appOwnedDir = path.join(workspace, 'app-owned');
  const observations = {},
    receipts = [],
    probes = [],
    checks = [],
    cdpLog = [],
    screens = [],
    apps = [],
    appDaemons = [],
    initialTurns = {},
    timings = { steps: [] };
  let fixture, daemon, app, page, projectId, sessionId, sessionTitle, turnId, failure, current;
  let scenarioUrl;
  let evidence = {};
  /** Who started the daemon the steps talk to: this process, or the app. */
  let startedBy = 'scenario';

  const left = (until = deadline) => until - Date.now();
  const get = async (method, params = {}, until = deadline) => {
    if (left(until) <= 0) throw new Error(`Timed out: GET ${method}`);
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(Math.min(15000, left(until))),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const call = async (type, input, revision = null) => {
    if (left() <= 0) throw new Error(`Timed out: ${type}`);
    const body = command(USER_PRINCIPAL_ID, type, input, revision);
    const response = await fetch(`${daemon.url}/v1/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(15000, left())),
    });
    const data = await response.json();
    receipts.push({
      step: current,
      type,
      input,
      expected_revision: revision,
      status: response.status,
      data,
    });
    if (response.status !== 200) throw new Error(`${type}: ${JSON.stringify(data)}`);
    return data.receipt;
  };
  const board = () => get('board', { project_id: projectId });
  const sessionList = () => get('session.list', { project_id: projectId });
  const boardView = () => get('board.view', { project_id: projectId, days: '14' });
  const events = async (until = deadline) => {
    const all = [];
    for (let after = 0; ;) {
      const page = await get('events', { after: String(after), project_id: projectId }, until);
      if (page.snapshot_required) throw new Error('Event log no longer reaches the first event');
      if (!page.events.length) return all;
      all.push(...page.events);
      after = page.events.at(-1).sequence;
    }
  };
  const turnsOf = (snapshot) =>
    snapshot.session_turns.filter((turn) => turn.session_id === sessionId);
  const poll = async (check, description) => {
    for (;;) {
      const value = await check();
      if (value) return value;
      if (left() <= 0) throw new Error(`Timed out: ${description}`);
      await delay(Math.min(200, Math.max(0, left())));
    }
  };

  /** The daemon's process as daemon.json and the process table name it, and the session's turns. */
  const probe = async (moment) => {
    const entry = { moment, started_by: startedBy, at: new Date().toISOString() };
    try {
      const manifest = JSON.parse(await readFile(path.join(stateDir, 'daemon.json'), 'utf8'));
      entry.daemon = {
        pid: manifest.pid,
        started_at: manifest.started_at,
        url: manifest.url,
        process_started: processStarted(manifest.pid),
        command: processLine(manifest.pid)?.command ?? null,
        alive: alive(manifest.pid),
      };
    } catch (error) {
      entry.daemon = { error: error.message };
    }
    entry.app = app
      ? { pid: app.pid, running: app.child.exitCode === null && app.child.signalCode === null }
      : null;
    try {
      const [snapshot, list] = await Promise.all([board(), sessionList()]);
      const row = list.find((s) => s.id === sessionId);
      entry.session_state = row?.state ?? null;
      entry.project_turn_count = snapshot.session_turns.length;
      entry.turns = turnsOf(snapshot).map((turn) => ({ id: turn.id, state: turn.state }));
    } catch (error) {
      entry.read_error = error.message;
    }
    probes.push(entry);
    return entry;
  };
  /** Fails unless the session's one turn is the same turn and still running. */
  const assertRunning = (entry) => {
    const [turn, ...more] = entry.turns ?? [];
    if (entry.read_error) throw new Error(`${entry.moment}: ${entry.read_error}`);
    if (
      more.length ||
      turn?.id !== turnId ||
      turn.state !== 'running' ||
      entry.session_state !== 'running'
    )
      throw new Error(
        `${entry.moment}: the session is ${entry.session_state} with turns ${JSON.stringify(entry.turns)}, not its one turn ${turnId} running`,
      );
  };

  /** The command line the app's bridge starts its daemon with for this data directory. */
  const appDaemonCommand = () =>
    `node ${path.join(repoRoot, 'apps/daemon/dist/main.js')} --data-dir ${stateDir} --allow-fixture`;
  /** The live process daemon.json names, with its parent while the app that may have started it runs. */
  const identifyAppDaemon = async () => {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(stateDir, 'daemon.json'), 'utf8'));
    } catch {
      return null;
    }
    const { pid } = manifest;
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null;
    const line = processLine(pid);
    return {
      pid,
      started_at: manifest.started_at,
      url: manifest.url,
      token_file: manifest.token_file,
      process_started: processStarted(pid),
      ppid: line?.ppid ?? null,
      command: line?.command ?? null,
      app_pid: app && app.child.exitCode === null && app.child.signalCode === null ? app.pid : null,
    };
  };
  /** Fails unless daemon.json still names the live daemon the app started, unchanged. */
  const assertAppDaemon = (entry) => {
    const [first] = appDaemons;
    const now = entry.daemon;
    if (
      !now?.alive ||
      now.pid === process.pid ||
      now.pid !== first.pid ||
      now.started_at !== first.started_at ||
      now.process_started !== first.process_started ||
      now.command !== appDaemonCommand()
    )
      throw new Error(
        `${entry.moment}: daemon.json names ${JSON.stringify(now)}, not the live daemon the app started ${JSON.stringify(first)}`,
      );
  };
  /**
   * Stops the daemons the app started for this run: each must have been the app's child when seen,
   * still run this data directory's command line and have the same start time; else no signal at all.
   */
  const stopAppDaemons = async () => {
    const expected = appDaemonCommand();
    const targets = appDaemons.map((d) => ({
      ...d,
      command_now: processLine(d.pid)?.command ?? null,
      process_started_now: processStarted(d.pid),
      alive: alive(d.pid),
    }));
    const record = { expected_command: expected, targets, signals: [] };
    const live = targets.filter((t) => t.alive);
    if (!live.length) return { ...record, result: 'stopped', how: 'none was running' };
    const list = live.map(
      (t) => `  ${t.pid} (parent ${t.ppid} when seen, app ${t.app_pid}) ${t.command_now}`,
    );
    console.error(
      `app-reopen-recovery: SIGTERM to the daemons the app started:\n${list.join('\n')}`,
    );
    const wrong = live.find(
      (t) =>
        t.app_pid === null ||
        t.ppid !== t.app_pid ||
        t.command_now !== expected ||
        t.process_started_now !== t.process_started,
    );
    if (wrong)
      return {
        ...record,
        result: 'not stopped',
        how: `no signal sent: process ${wrong.pid} is not the daemon the app started for this data directory`,
      };
    const exited = async (ms) => {
      const until = Date.now() + ms;
      while (live.some((t) => alive(t.pid)) && Date.now() < until) await delay(100);
      return !live.some((t) => alive(t.pid));
    };
    for (const t of live) {
      process.kill(t.pid, 'SIGTERM');
      record.signals.push({ pid: t.pid, signal: 'SIGTERM' });
    }
    if (await exited(10000)) return { ...record, result: 'stopped', how: 'SIGTERM' };
    for (const t of live.filter((t) => alive(t.pid))) {
      if (processLine(t.pid)?.command !== expected || processStarted(t.pid) !== t.process_started)
        continue;
      process.kill(t.pid, 'SIGKILL');
      record.signals.push({ pid: t.pid, signal: 'SIGKILL' });
    }
    return (await exited(3000))
      ? { ...record, result: 'stopped', how: 'SIGKILL' }
      : { ...record, result: 'not stopped', how: 'still running after SIGKILL' };
  };

  const seedRepo = async (dir) => {
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'App Reopen Recovery');
    git(dir, 'config', 'user.email', 'app-reopen-recovery@example.invalid');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.hooksPath', noHooks);
    await writeFile(path.join(dir, 'README.md'), 'App reopen recovery\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-q', '-m', 'Initial commit');
  };
  /** Opens the project at `root` and starts the long turn in a fixture session. */
  const startLongTurn = async (root, moment) => {
    projectId = (await call('project.open', { name: PROJECT_NAME, roots: [root] })).id;
    sessionId = (
      await call('session.create', { project_id: projectId, runtime: 'fixture', input: INPUT })
    ).id;
    const turn = await poll(async () => {
      const snapshot = await board();
      const [only, ...more] = turnsOf(snapshot);
      if (more.length) throw new Error(`${more.length + 1} turns started, not one`);
      if (only && !['queued', 'running'].includes(only.state))
        throw new Error(`The long turn ended ${only.state}`);
      const row = (await sessionList()).find((s) => s.id === sessionId);
      return only?.state === 'running' && row?.state === 'running' ? { only, row } : false;
    }, 'the long turn to run');
    turnId = turn.only.id;
    sessionTitle = turn.row.title;
    initialTurns[startedBy] = (await probe(moment)).project_turn_count;
  };
  const interruptTurn = async () => {
    const revision = (await board()).sessions.find((row) => row.id === sessionId)?.revision ?? null;
    await call('session.interrupt', { session_id: sessionId }, revision);
    await poll(async () => {
      const snapshot = await board();
      const row = (await sessionList()).find((s) => s.id === sessionId);
      return turnsOf(snapshot).every((turn) => !['queued', 'running'].includes(turn.state)) &&
        row &&
        !row.stopping &&
        !['starting', 'running'].includes(row.state)
        ? true
        : false;
    }, 'the turn to end');
  };

  // Every page action is logged with its target, duration and result.
  const logged = async (op, target, action, extra = {}) => {
    const entry = { step: current, op, target, ...extra };
    const begun = Date.now();
    try {
      const value = await action();
      cdpLog.push({ ...entry, ms: Date.now() - begun, result: 'ok' });
      return value;
    } catch (error) {
      cdpLog.push({ ...entry, ms: Date.now() - begun, result: error.message.slice(0, 2000) });
      throw error;
    }
  };
  const click = (locator) => logged('click', describeLocator(locator), () => page.click(locator));
  const waitUi = (expression, description, options = { failWhen: ALERTS }) =>
    logged('waitFor', description, () => page.waitFor(expression, description, deadline, options));
  const read = (expression, description) =>
    logged('evaluate', description, () => page.evaluate(expression));
  const appear = (locator) => waitUi(present(locator), `${describeLocator(locator)} to show`);
  // Each connection numbers its own shots, so files are renumbered across connections.
  const shot = async (name) => {
    const taken = await logged('screenshot', name, () => page.screenshot(name));
    const file = `screens/${String(screens.length + 1).padStart(2, '0')}-${name}.png`;
    await rename(path.join(evidenceDir, taken.file), path.join(evidenceDir, file));
    screens.push({ step: current, file, sha256: taken.sha256 });
  };

  const openApp = async (moment) => {
    app = await launchDesktopApp({ repoRoot, dataDir: stateDir, deadline });
    apps.push({ moment, pid: app.pid, port: app.port });
    await attach();
  };
  const attach = async () => {
    page = await logged('connect', `DevTools port ${app.port}`, () =>
      connect(app.port, deadline, { evidenceDir }),
    );
    await waitUi(projectShown(PROJECT_NAME), 'the sidebar to name the project');
    await click({ role: 'button', name: `${sessionTitle}，`, within: NAV });
  };

  /** What the page should show for the session, from session.list and the board's turns. */
  const authoritative = async () => {
    const [snapshot, list] = await Promise.all([board(), sessionList()]);
    const row = list.find((s) => s.id === sessionId);
    if (!row) throw new Error(`session.list does not list ${sessionId}`);
    return {
      row: {
        state: row.state,
        stopping: row.stopping,
        reconciling: row.reconciling,
        last_turn: row.last_turn,
      },
      expected: {
        state: sessionLabel(row),
        last_turn: lastTurnLabel(row),
        turns: turnsOf(snapshot).length,
      },
    };
  };
  /** Waits up to 15 s for the page to show what the daemon reads; records both either way. */
  const compareSession = async (moment) => {
    const until = Math.min(deadline, Date.now() + 15000);
    let truth, shown;
    for (;;) {
      truth = await authoritative();
      shown = await read(sessionShown(sessionTitle), 'the session row and thread');
      if (isDeepStrictEqual(shown, truth.expected) || Date.now() >= until) break;
      await delay(200);
    }
    const entry = {
      moment,
      kind: 'session',
      daemon: truth,
      ui: shown,
      matched: isDeepStrictEqual(shown, truth.expected),
    };
    checks.push(entry);
    return entry;
  };
  const showsRunning = async (moment) => {
    const entry = await compareSession(moment);
    if (!entry.matched || entry.ui.state !== '运行中')
      throw new Error(
        `${moment}: the page shows ${JSON.stringify(entry.ui)}, the daemon ${JSON.stringify(entry.daemon)}`,
      );
  };

  /** Draws every shot so far in the open page; the images never fail the run. */
  const makeMontage = async () => {
    try {
      const images = await Promise.all(
        screens.map(async (s) =>
          (await readFile(path.join(evidenceDir, s.file))).toString('base64'),
        ),
      );
      const data = await page.evaluate(montage(images), Date.now() + 15000);
      evidence['ui-screenshots.png'] = Buffer.from(data, 'base64');
    } catch (error) {
      evidence['montage-error.txt'] = String(error?.stack ?? error);
    }
  };
  /** Every event of the current project, into the named evidence file. */
  const collectEvents = async (name) => {
    try {
      const all = projectId ? await events(Date.now() + 15000) : [];
      evidence[name] = all.map((event) => JSON.stringify(event)).join('\n') + '\n';
    } catch (error) {
      evidence[name.replace('.jsonl', '-error.txt')] = String(error?.stack ?? error);
    }
  };
  const eventsFile = () => (startedBy === 'app' ? 'app-daemon-events.jsonl' : 'events.jsonl');

  const flush = () =>
    writeEvidence(evidenceDir, {
      'process-probes.json': probes,
      'ui-checks.json': checks,
      'cdp-log.json': cdpLog,
      'timings.json': timings,
      'receipts.json': receipts,
    });
  const step = async (name, action) => {
    current = name;
    const begun = Date.now();
    try {
      await action();
    } finally {
      timings.steps.push({ name, ms: Date.now() - begun });
      await flush();
    }
  };

  try {
    await step('seed', async () => {
      const build = await checkDesktopBuild(repoRoot);
      timings.build = build;
      if (!build.fresh)
        throw new Error(
          `apps/desktop/out is older than its inputs (newest input ${JSON.stringify(build.newest_input)}, oldest output ${JSON.stringify(build.oldest_output)}); run pnpm build && pnpm --filter @pantheon/desktop bundle first`,
        );
      for (const dir of [
        noHooks,
        path.join(workspace, 'workspaces'),
        path.join(workspace, 'backups'),
      ])
        await mkdir(dir, { recursive: true });
      await seedRepo(repo);
      fixture = await startNativeDaemon(workspace, [new FixtureAdapter()], { intervalMs: 200 });
      ({ daemon } = fixture);
      scenarioUrl = daemon.url;
      await startLongTurn(repo, 'turn-running');
    });

    await step('launch', async () => {
      await openApp('launch');
      await showsRunning('before-close');
      await shot('before-close');
      assertRunning(await probe('before-close'));
    });

    await step('close-app', async () => {
      page.close();
      page = undefined;
      const stopped = await app.stop(Date.now() + 15000);
      apps.at(-1).stop = stopped;
      if (!stopped.stopped) throw new Error(`The app did not quit: ${stopped.how}`);
      assertRunning(await probe('app-quit'));
      await delay(Math.min(CLOSED_MS, Math.max(0, left())));
      assertRunning(await probe('app-quit-later'));
      app = undefined;
    });

    await step('reopen', async () => {
      await openApp('reopen');
      await showsRunning('reopened');
      await shot('reopened');
      assertRunning(await probe('reopened'));
    });

    await step('reload', async () => {
      const before = page;
      await logged('reload', 'the renderer', async () => {
        await before.send('Page.reload', {}).catch((error) => {
          if (!before.failure?.startsWith('Page navigated')) throw error;
        });
        // The client fails once the new document commits.
        while (!before.failure?.startsWith('Page navigated')) {
          if (left() <= 0) throw new Error('Timed out: the renderer to navigate after the reload');
          await delay(50);
        }
      });
      before.close();
      await attach();
      await showsRunning('reloaded');
      await shot('reloaded');
      assertRunning(await probe('reloaded'));
    });

    await step('disconnect', async () => {
      await waitUi(`(${connectionState}) === '已连接'`, 'the connection mark to show 已连接');
      await read(recordConnection, 'record the connection mark');
      // Every connection the daemon accepted from the app, the event socket included, as a dropped network would end them.
      const port = Number(new URL(daemon.url).port);
      const sockets = process._getActiveHandles().filter((h) => h instanceof net.Socket);
      const own = new Set(sockets.filter((s) => s.remotePort === port).map((s) => s.localPort));
      const accepted = sockets.filter((s) => s.localPort === port && !own.has(s.remotePort));
      for (const socket of accepted) socket.destroy();
      timings.dropped_connections = accepted.length;
      if (accepted.length === 0)
        throw new Error('The daemon had no connection from the app to drop');
      const seen = await waitUi(
        `(() => { const seen = globalThis.__acceptanceConnection; return seen.includes('已断开') && seen.at(-1) === '已连接' ? seen : false; })()`,
        'the connection mark to go 已断开 and back to 已连接',
        {},
      );
      timings.connection_marks = seen;
      await showsRunning('reconnected');
      await shot('reconnected');
      assertRunning(await probe('reconnected'));
    });

    await step('end-turn', async () => {
      await interruptTurn();
      await probe('turn-ended');
      await compareSession('ended');
      await shot('ended');

      await click(button('项目看板', { within: NAV }));
      const canvas = { role: 'radio', name: '画布', exact: true };
      await appear(canvas);
      await click(canvas);
      const until = Math.min(deadline, Date.now() + 15000);
      let row, shown, expected;
      for (;;) {
        row = (await boardView()).tasks.find((task) => task.id === sessionId) ?? null;
        expected = row ? { status: TASK_STATUS_LABEL[row.status] } : null;
        shown = await read(rowShown(row?.title ?? sessionTitle), 'the progress table row status');
        if ((expected && isDeepStrictEqual(shown, expected)) || Date.now() >= until) break;
        await delay(200);
      }
      checks.push({
        moment: 'ended',
        kind: 'board',
        daemon: row && { id: row.id, title: row.title, status: row.status, expected },
        ui: shown,
        matched: !!expected && isDeepStrictEqual(shown, expected),
      });
      await shot('ended-board');
      await probe('final');
    });

    await step('close-scenario-daemon', async () => {
      await collectEvents('events.jsonl');
      page.close();
      page = undefined;
      const stopped = await app.stop(Date.now() + 15000);
      apps.at(-1).stop = stopped;
      if (!stopped.stopped) throw new Error(`The app did not quit: ${stopped.how}`);
      app = undefined;
      await fixture.close();
      fixture = undefined;
    });

    // The same close and reopen with the daemon the app starts itself, outside this process.
    await step('app-daemon-launch', async () => {
      startedBy = 'app';
      stateDir = path.join(appOwnedDir, 'state');
      daemon = projectId = sessionId = sessionTitle = turnId = undefined;
      await mkdir(stateDir, { recursive: true });
      const appRepo = path.join(appOwnedDir, 'repo');
      await seedRepo(appRepo);
      app = await launchDesktopApp({ repoRoot, dataDir: stateDir, deadline });
      apps.push({ moment: 'app-daemon-launch', pid: app.pid, port: app.port });
      const found = await poll(identifyAppDaemon, 'the app to start a daemon');
      appDaemons.push(found);
      if (
        found.pid === process.pid ||
        found.ppid !== app.pid ||
        found.command !== appDaemonCommand()
      )
        throw new Error(
          `daemon.json names ${JSON.stringify(found)}, not a daemon the app started with ${appDaemonCommand()}`,
        );
      daemon = { url: found.url, token: (await readFile(found.token_file, 'utf8')).trim() };
      await startLongTurn(appRepo, 'app-daemon-turn-running');
      await attach();
      await showsRunning('app-daemon-before-close');
      await shot('app-daemon-before-close');
      const entry = await probe('app-daemon-before-close');
      assertRunning(entry);
      assertAppDaemon(entry);
    });

    await step('app-daemon-close-app', async () => {
      page.close();
      page = undefined;
      const stopped = await app.stop(Date.now() + 15000);
      apps.at(-1).stop = stopped;
      if (!stopped.stopped) throw new Error(`The app did not quit: ${stopped.how}`);
      app = undefined;
      for (const moment of ['app-daemon-app-quit', 'app-daemon-app-quit-later']) {
        if (moment !== 'app-daemon-app-quit') await delay(Math.min(CLOSED_MS, Math.max(0, left())));
        const entry = await probe(moment);
        assertAppDaemon(entry);
        assertRunning(entry);
      }
    });

    await step('app-daemon-reopen', async () => {
      await openApp('app-daemon-reopen');
      await showsRunning('app-daemon-reopened');
      await shot('app-daemon-reopened');
      const entry = await probe('app-daemon-reopened');
      assertAppDaemon(entry);
      assertRunning(entry);
      if (entry.project_turn_count !== initialTurns.app)
        throw new Error(
          `app-daemon-reopened: ${entry.project_turn_count} turns, not the ${initialTurns.app} before the app quit`,
        );
    });

    await step('app-daemon-end-turn', async () => {
      await interruptTurn();
      await probe('app-daemon-turn-ended');
      await compareSession('app-daemon-ended');
      await shot('app-daemon-ended');
      await makeMontage();
      page.close();
      page = undefined;
      const stopped = await app.stop(Date.now() + 15000);
      apps.at(-1).stop = stopped;
      if (!stopped.stopped) throw new Error(`The app did not quit: ${stopped.how}`);
      app = undefined;
      await probe('app-daemon-final');
    });
  } catch (error) {
    failure = new Error(`${current}: ${error.message}`, { cause: error });
  }

  // Cleanup runs on every path, each part bounded.
  current = 'shutdown';
  if (page && !page.failure) {
    if (failure)
      try {
        const taken = await page.screenshot('failure', Date.now() + 5000);
        screens.push({ step: 'failure', file: taken.file, sha256: taken.sha256 });
      } catch {}
    await makeMontage();
  }
  if (!evidence[eventsFile()]) await collectEvents(eventsFile());
  // A daemon the app started that the steps have not seen yet, while the app is still its parent.
  if (startedBy === 'app' && app) {
    const found = await identifyAppDaemon();
    if (found && !appDaemons.some((d) => d.pid === found.pid)) appDaemons.push(found);
  }
  page?.close();
  if (app) apps.at(-1).stop = await app.stop(Date.now() + 15000);
  if (fixture) await fixture.close();
  if (startedBy === 'app') {
    const stop = await stopAppDaemons();
    evidence['app-daemon-stop.json'] = stop;
    if (stop.result !== 'stopped')
      failure ??= new Error(`shutdown: the daemon the app started was not stopped: ${stop.how}`);
  }
  timings.total_ms = Date.now() - startedAt;

  /** The probes of one daemon, every named moment among them and all of one live process. */
  const survived = (by, expected, own) => {
    const entries = probes.filter((entry) => entry.started_by === by);
    const first = entries[0]?.daemon;
    return (
      !!first?.pid &&
      own(first) &&
      expected.every((moment) => entries.some((entry) => entry.moment === moment)) &&
      entries.every(
        (entry) =>
          entry.daemon?.alive === true &&
          entry.daemon.pid === first.pid &&
          entry.daemon.started_at === first.started_at &&
          entry.daemon.url === first.url &&
          entry.daemon.command === first.command &&
          !!entry.daemon.process_started &&
          entry.daemon.process_started === first.process_started,
      )
    );
  };
  observations.process = {
    daemon_survived:
      survived(
        'scenario',
        [
          'before-close',
          'app-quit',
          'app-quit-later',
          'reopened',
          'reloaded',
          'reconnected',
          'final',
        ],
        (first) => first.pid === process.pid && first.url === scenarioUrl,
      ) &&
      survived(
        'app',
        [
          'app-daemon-before-close',
          'app-daemon-app-quit',
          'app-daemon-app-quit-later',
          'app-daemon-reopened',
          'app-daemon-final',
        ],
        (first) =>
          first.pid !== process.pid &&
          first.command === appDaemonCommand() &&
          appDaemons[0]?.pid === first.pid &&
          appDaemons[0].ppid === apps.find((a) => a.moment === 'app-daemon-launch')?.pid,
      ),
  };
  const added = ['scenario', 'app'].map((by) => {
    const last = probes.filter((entry) => entry.started_by === by).at(-1);
    return initialTurns[by] !== undefined && last?.project_turn_count !== undefined
      ? last.project_turn_count - initialTurns[by]
      : null;
  });
  if (added.every((count) => count !== null))
    observations.turns = { new_turns_on_reconnect: added[0] + added[1] };
  observations.ui = {
    matches_authoritative_state:
      checks.some((c) => c.moment === 'ended' && c.kind === 'session') &&
      checks.some((c) => c.moment === 'ended' && c.kind === 'board') &&
      checks.some((c) => c.moment === 'app-daemon-reopened' && c.kind === 'session') &&
      checks.some((c) => c.moment === 'app-daemon-ended' && c.kind === 'session') &&
      checks.every((c) => c.matched),
  };
  evidence = {
    ...evidence,
    'process-probes.json': probes,
    'ui-checks.json': checks,
    'apps.json': apps,
    'screens.json': screens,
    'cdp-log.json': cdpLog,
    'timings.json': timings,
    'receipts.json': receipts,
  };
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...evidence,
      'observations-so-far.json': observations,
      'failure.txt': String(failure?.stack ?? failure),
    });
    throw failure;
  }
  return {
    observations,
    evidence,
    adapters: [`fixture@${new FixtureAdapter().report.version}`],
  };
}
