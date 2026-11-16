import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { buildManifest } from '../lib/build-manifest.mjs';
import { connect, describeLocator } from '../lib/cdp.mjs';
import { startNativeDaemon } from '../lib/daemon.mjs';
import { checkDesktopBuild, launchDesktopApp, projectShown } from '../lib/desktop-app.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '工作台闭环(界面)';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Shorter than the case's own timeout, which kills the worker without running its cleanup. */
const RUN_MS = 8 * 60 * 1000;
const PROJECT_NAME = 'Workbench loop UI';
const GATE_ARGV = ['git', 'rev-parse', 'HEAD'];
const MERGED_TEXT = 'merged: The session merged into its source.';
const plan = {
  base_version: 0,
  headline: 'Workbench loop through the app',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    {
      id: 'A',
      title: 'Task A',
      goal: 'Add a.txt',
      lane: 'main',
      milestone: 'M',
      depends_on: [],
      source: ['Add a.txt'],
      scope: ['a.txt'],
      acceptance: ['test -f a.txt'],
    },
    {
      id: 'B',
      title: 'Task B',
      goal: 'Add b.txt',
      lane: 'main',
      milestone: 'M',
      depends_on: [],
      source: ['Add b.txt'],
      scope: ['b.txt'],
      acceptance: ['test -f b.txt'],
    },
  ],
  milestones: [
    { id: 'M', title: 'Milestone M', criteria: ['A and B are merged'], tasks: ['A', 'B'] },
  ],
  risks: [],
  assumptions: [],
};
const MILESTONE_TITLE = plan.milestones[0].title;

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const taskScript = (task) => {
  const file = `${task.id.toLowerCase()}.txt`;
  return script(
    { write: { path: file, text: `${task.title}\n` } },
    { commit: `Add ${file} for ${task.title}` },
    { tool: { name: 'report', arguments: { kind: 'done', text: `${task.title} is finished` } } },
  );
};
const ended = (turn) => !['queued', 'running'].includes(turn.state);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sorted = (values) => [...values].sort();

const NAV = { name: '导航', exact: true };
const SETTINGS = { role: 'dialog', name: '设置', exact: true };
const button = (name, extra = {}) => ({ role: 'button', name, exact: true, ...extra });
const COMPOSER = { role: 'textbox', name: '新会话的第一条消息', exact: true };
/** Visible role="alert" texts; any of them fails the wait it guards. */
const ALERTS = `[...document.querySelectorAll('[role="alert"]')]
  .filter((el) => el.getClientRects().length > 0)
  .map((el) => el.innerText.trim() || 'an empty alert')
  .join(' | ')`;
const present = (locator) =>
  `(() => { try { globalThis.__acceptanceLocator.find(${JSON.stringify(locator)}); return true; } catch { return false; } })()`;
const byLabel = (selector, label) =>
  `document.querySelector(${JSON.stringify(`${selector}[aria-label="${label}"]`)})`;
const composerValue = `${byLabel('textarea', '新会话的第一条消息')}?.value`;
// The trigger's name is "模型：" and its choices; its text starts with the runtime's display name.
// Scoped to the new-session composer: the closed settings dialog keeps a model menu in the document.
const modelText = `(document.querySelector('section[aria-label="新会话"] button[aria-label^="模型"]')?.textContent ?? '').trim().toLowerCase()`;
/** The titles of the cards in the board column headed by the status label. */
const columnTitles = (label) => `(() => {
  const column = [...document.querySelectorAll('.bd-col')].find(
    (col) => col.querySelector('.bd-col-h')?.textContent.includes(${JSON.stringify(label)}),
  );
  return column
    ? [...column.querySelectorAll('[data-task-card] .bd-col-t')].map((t) => t.textContent.trim())
    : null;
})()`;
const nextFrames =
  'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))';

export async function run({ workspace, evidenceDir }) {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_MS;
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const stateDir = path.join(workspace, 'state');
  const repo = path.join(workspace, 'repo');
  const observations = {},
    receipts = [],
    snapshots = {},
    cdpLog = [],
    screens = [],
    timings = { steps: [] },
    sessions = {};
  let fixture, daemon, app, page, projectId, root, leadId, failure, buildBefore, current;
  let lost = null,
    rejectLost;
  const ownLost = new Promise((_, reject) => (rejectLost = reject));
  ownLost.catch(() => {});
  let watcher;

  const left = (until = deadline) => until - Date.now();
  const ownDaemon = async () => {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(stateDir, 'daemon.json'), 'utf8'));
    } catch (error) {
      return `daemon.json is unreadable: ${error.message}`;
    }
    return manifest.url === daemon.url && manifest.pid === process.pid
      ? null
      : `daemon.json names ${manifest.url} pid ${manifest.pid}`;
  };
  const loseDaemon = (reason) => {
    if (lost) return;
    lost = reason;
    rejectLost(new Error(`The app no longer uses this scenario's daemon: ${reason}`));
  };
  const assertOwn = async () => {
    const reason = lost ?? (await ownDaemon());
    if (reason) {
      loseDaemon(reason);
      throw new Error(`The app no longer uses this scenario's daemon: ${reason}`);
    }
  };
  /** Races a page action against the daemon watcher, so a replaced daemon fails it at once. */
  const guard = (promise) => Promise.race([promise, ownLost]);

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
  const projectRead = async () => (await get('project.read', { project_id: projectId })).project;
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
  const turnsOf = (snapshot, sessionId) =>
    snapshot.session_turns.filter((turn) => turn.session_id === sessionId);
  /** Polls the daemon until check returns a value; every round first checks the daemon is ours. */
  const poll = async (check, description) => {
    for (;;) {
      await assertOwn();
      const value = await check();
      if (value) return value;
      if (left() <= 0) throw new Error(`Timed out: ${description}`);
      await delay(Math.min(200, Math.max(0, left())));
    }
  };
  /** The one session created since `before`, once it shows up. */
  const newSession = (before, description) =>
    poll(async () => {
      const snapshot = await board();
      const added = snapshot.sessions.filter((row) => !before.has(row.id));
      if (added.length > 1)
        throw new Error(`${description}: ${added.length} sessions were created, not one`);
      return added[0] ?? false;
    }, description);

  // Every page action is logged with its target, duration and result.
  const logged = async (op, target, action, extra = {}) => {
    const entry = { step: current, op, target, ...extra };
    const begun = Date.now();
    try {
      const value = await guard(action());
      cdpLog.push({ ...entry, ms: Date.now() - begun, result: 'ok' });
      return value;
    } catch (error) {
      cdpLog.push({ ...entry, ms: Date.now() - begun, result: error.message.slice(0, 2000) });
      throw error;
    }
  };
  const click = (locator) => logged('click', describeLocator(locator), () => page.click(locator));
  const fill = (locator, text) =>
    logged('fill', describeLocator(locator), () => page.fill(locator, text), {
      length: text.length,
      sha256: sha256(text),
    });
  const press = (key, modifiers = []) =>
    logged('press', [...modifiers, key].join('+'), () => page.press(key, modifiers));
  const waitUi = (expression, description) =>
    logged('waitFor', description, () =>
      page.waitFor(expression, description, deadline, { failWhen: ALERTS }),
    );
  const read = (expression, description) =>
    logged('evaluate', description, () => page.evaluate(expression));
  const shot = async (name) => {
    const taken = await logged('screenshot', name, () => page.screenshot(name));
    screens.push(taken);
    return taken;
  };
  const appear = (locator) => waitUi(present(locator), `${describeLocator(locator)} to show`);

  const flush = () =>
    writeEvidence(evidenceDir, {
      'snapshots.json': snapshots,
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
      if (projectId && !lost)
        try {
          snapshots[name] = { board_view: await boardView(), project: await projectRead() };
        } catch (error) {
          snapshots[name] = { error: error.message };
        }
      await flush();
    }
  };

  /** Board › 画布 › 近 7 天 › 任务列; opening a task session resets the progress table to its table. */
  const openColumns = async () => {
    await click(button('项目看板', { within: NAV }));
    const canvas = { role: 'radio', name: '画布', exact: true };
    await appear(canvas);
    await click(canvas);
    // The board opens on the unfinished tasks; the columns here also hold the finished ones.
    await click({ role: 'radio', name: '近 7 天', exact: true });
    const columns = { role: 'radio', name: '任务列', exact: true };
    await click(columns);
    await waitUi(
      `[...document.querySelectorAll('[role="radiogroup"][aria-label="进度表视图"] [role="radio"]')].some((r) => r.textContent.trim() === '任务列' && r.getAttribute('aria-checked') === 'true')`,
      'the progress table to show the task columns',
    );
  };

  try {
    await step('seed', async () => {
      const build = await checkDesktopBuild(repoRoot);
      timings.build = build;
      if (!build.fresh)
        throw new Error(
          `apps/desktop/out is older than its inputs (newest input ${JSON.stringify(build.newest_input)}, oldest output ${JSON.stringify(build.oldest_output)}); run pnpm build && pnpm --filter @pantheon/desktop bundle first`,
        );
      buildBefore = await buildManifest(repoRoot);
      const noHooks = path.join(workspace, 'no-hooks');
      for (const dir of [
        repo,
        noHooks,
        path.join(workspace, 'workspaces'),
        path.join(workspace, 'backups'),
      ])
        await mkdir(dir, { recursive: true });
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.name', 'Workbench Loop UI');
      git(repo, 'config', 'user.email', 'workbench-loop-ui@example.invalid');
      git(repo, 'config', 'commit.gpgsign', 'false');
      git(repo, 'config', 'core.hooksPath', noHooks);
      await writeFile(path.join(repo, 'README.md'), 'Workbench loop UI\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-q', '-m', 'Initial commit');
      await mkdir(path.join(workspace, 'home'), { recursive: true });
      fixture = await startNativeDaemon(workspace, [new FixtureAdapter()], {
        intervalMs: 200,
        home: path.join(workspace, 'home'),
      });
      ({ daemon } = fixture);
      watcher = setInterval(() => {
        if (!lost) void ownDaemon().then((reason) => reason && loseDaemon(reason));
      }, 200);
      const project = await call('project.open', { name: PROJECT_NAME, roots: [repo] });
      projectId = project.id;
      root = project.roots[0];
    });

    await step('launch', async () => {
      app = await launchDesktopApp({ repoRoot, dataDir: stateDir, deadline });
      timings.app = { pid: app.pid, port: app.port };
      page = await logged('connect', `DevTools port ${app.port}`, () =>
        connect(app.port, deadline, { evidenceDir }),
      );
      await waitUi(projectShown(PROJECT_NAME), 'the sidebar to name the project');
      observations.ui = { project_listed: true };
      await shot('project-listed');
    });

    await step('session-defaults', async () => {
      await click(button('设置', { within: NAV }));
      await click(button('默认模型', { within: SETTINGS }));
      // The lead's model control names the runtime; every change on this page saves at once.
      await waitUi(
        `(document.querySelector('[data-setting-id="defaults.model"] .cp-mdl')?.getAttribute('aria-label') ?? '').includes('fixture')`,
        'the runtime choice to settle on fixture',
      );
      const autoEdit = { role: 'radio', name: '自动编辑', exact: true };
      await click(autoEdit);
      await waitUi(
        `[...document.querySelectorAll('[role="radiogroup"][aria-label="权限模式"] [role="radio"]')].some((r) => r.textContent.trim() === '自动编辑' && r.getAttribute('aria-checked') === 'true')`,
        'the permission mode to show 自动编辑',
      );
      // The settings page writes the global defaults every project without its own follows.
      const saved = await poll(async () => {
        const read = await get('project.defaults', {});
        return read.settings.find((s) => s.key === 'session_defaults')?.global ?? false;
      }, 'the session defaults to be saved');
      if (saved.permission_mode !== 'auto_edit')
        throw new Error(`Saved defaults ${JSON.stringify(saved)}`);
      observations.settings = { session_runtime: saved.runtime };
    });

    await step('gate', async () => {
      // A project's gate and worktree settings are on its page under 项目.
      await click(button('项目', { within: SETTINGS }));
      await click(button(PROJECT_NAME, { within: SETTINGS }));
      await click(button('加一步'));
      const row = { role: 'group', name: '第 1 步', exact: true };
      await fill({ role: 'textbox', name: '名字', exact: true, within: row }, 'Passes');
      await fill({ role: 'textbox', name: '超时(秒)', exact: true, within: row }, '60');
      // A row without a command line is not saved, so the command line written last saves the whole
      // row in one revision; the auto-merge switch below sends the revision the board shows.
      await fill(
        { role: 'textbox', name: '命令行', exact: true, within: row },
        GATE_ARGV.join(' '),
      );
      // A field saves when Enter is pressed in it; the page has no save button.
      await press('Enter');
      const gated = await poll(async () => {
        const project = await projectRead();
        return project.gates?.[root]?.[0]?.timeout_ms === 60000 ? project : false;
      }, 'the gate to be saved with its timeout');
      if (gated.revision !== 2) throw new Error(`The gate took ${gated.revision - 1} saves`);
      const commands = gated.gates[root];
      if (
        commands.length !== 1 ||
        commands[0].name !== 'Passes' ||
        commands[0].timeout_ms !== 60000
      )
        throw new Error(`Saved gate ${JSON.stringify(commands)}`);
      observations.settings.gate_argv = commands[0].argv;
      const toggle = byLabel('input[type="checkbox"]', '门禁通过后自动合并');
      await waitUi(`${toggle}?.disabled === false`, 'the auto-merge switch to be enabled');
      await click({ role: 'checkbox', name: '门禁通过后自动合并', exact: true });
      const merging = await poll(async () => {
        const project = await projectRead();
        return project.auto_merge === true ? project : false;
      }, 'auto-merge to be on');
      observations.settings.auto_merge = merging.auto_merge;
      await waitUi(
        `${toggle}?.checked === true && ${toggle}?.disabled === false`,
        'the auto-merge switch to show on',
      );
      await shot('gate-and-auto-merge');
      await click(button('关闭设置', { within: SETTINGS }));
    });

    await step('lead', async () => {
      const before = new Set((await board()).sessions.map((row) => row.id));
      await click(button('新会话', { within: NAV }));
      await appear(COMPOSER);
      await waitUi(
        `${modelText}.startsWith('fixture')`,
        'the model menu to name the fixture runtime',
      );
      await fill(COMPOSER, script({ tool: { name: 'update_board', arguments: plan } }));
      await press('Enter');
      const lead = await newSession(before, 'the lead session to be created');
      if (lead.task) throw new Error(`The lead is bound to task ${JSON.stringify(lead.task)}`);
      leadId = lead.id;
      const done = await poll(async () => {
        const snapshot = await board();
        const session = snapshot.sessions.find((row) => row.id === leadId);
        const turns = turnsOf(snapshot, leadId);
        if (snapshot.sessions.length !== before.size + 1)
          throw new Error(
            `${snapshot.sessions.length - before.size} sessions were created, not one`,
          );
        return session?.state === 'open' && turns.length >= 1 && turns.every(ended) ? turns : false;
      }, 'the lead to write the plan');
      if (done.some((turn) => turn.state !== 'completed'))
        throw new Error(`The lead's turn ended ${done.map((turn) => turn.state).join(', ')}`);
      timings.lead = { model_menu: await read(modelText, 'the model menu text') };
      await shot('lead-planned');
    });

    await step('plan-cards', async () => {
      await openColumns();
      const cards = `[...document.querySelectorAll('button.bd-col-card[data-task-card]')].map((card) => (card.querySelector('.bd-col-t')?.textContent ?? '').trim())`;
      const titles = await waitUi(
        `(() => { const t = ${cards}; return t.length === 2 ? t : false; })()`,
        'two task cards',
      );
      observations.plan = { cards: sorted(titles) };
      await shot('plan-cards');
    });

    observations.work = { sessions_match_tasks: [] };
    for (const task of plan.tasks) {
      await step(`task-${task.id}`, async () => {
        await openColumns();
        // The main view above shows the same task as another card.
        await click(button(task.title, { within: { role: 'group', name: '任务列', exact: true } }));
        await click(button(`开会话做它 ${task.title}`));
        await appear(COMPOSER);
        await waitUi(
          `${composerValue} === ${JSON.stringify(`${task.title}\n\n${task.goal}`)}`,
          `the composer to start with the title and goal of ${task.title}`,
        );
        await waitUi(
          `${modelText}.startsWith('fixture')`,
          'the model menu to name the fixture runtime',
        );
        const before = new Set((await board()).sessions.map((row) => row.id));
        await fill(COMPOSER, taskScript(task));
        await press('Enter');
        const session = await newSession(before, `the session of ${task.title} to be created`);
        const expected = {
          lead_session_id: leadId,
          id: task.id,
          generation: 1,
          definition_version: 0,
        };
        if (!isDeepStrictEqual(session.task, expected))
          throw new Error(
            `The session of ${task.title} is bound to ${JSON.stringify(session.task)}`,
          );
        sessions[task.id] = session.id;
        observations.work.sessions_match_tasks.push(task.id);
      });
    }

    await step('work', async () => {
      const ids = plan.tasks.map((task) => sessions[task.id]);
      const settled = await poll(async () => {
        const snapshot = await board();
        for (const task of plan.tasks) {
          const id = sessions[task.id];
          const session = snapshot.sessions.find((row) => row.id === id);
          const failed = turnsOf(snapshot, id).find((turn) =>
            ['failed', 'cancelled'].includes(turn.state),
          );
          if (failed)
            throw new Error(`A turn of the session of ${task.title} ended ${failed.state}`);
          if (session?.merge?.state === 'blocked')
            throw new Error(`The merge of ${task.title} is blocked: ${session.merge.reason}`);
          const provisioning = snapshot.workspaces.find((w) => w.id === session?.workspace_id)
            ?.provisioning?.state;
          if (provisioning === 'failed' || provisioning === 'cancelled')
            throw new Error(`The worktree of ${task.title} could not be prepared: ${provisioning}`);
        }
        const leadTurns = turnsOf(snapshot, leadId);
        const failedLead = leadTurns.find((turn) => turn.state === 'failed');
        if (failedLead) throw new Error(`A turn of the lead failed`);
        const merged = ids.every(
          (id) => snapshot.sessions.find((row) => row.id === id)?.outcome === 'merged',
        );
        const lead = snapshot.sessions.find((row) => row.id === leadId);
        const notes = plan.tasks.map((task) => {
          const sessionTitle = snapshot.sessions.find((row) => row.id === sessions[task.id])?.title;
          return `${task.title} / ${sessionTitle}: ${MERGED_TEXT}`;
        });
        const tracked = leadTurns
          .filter((turn) => turn.origin === 'tracker')
          .map((turn) => turn.input)
          .join('\n');
        return merged &&
          lead?.state === 'open' &&
          leadTurns.every(ended) &&
          notes.every((note) => tracked.includes(note))
          ? { snapshot, notes }
          : false;
      }, 'both task sessions to merge and the lead to hear of it');
      const all = await events();
      const work = {};
      for (const task of plan.tasks) {
        const id = sessions[task.id];
        const of = (kind) =>
          all.filter((event) => event.kind === kind && event.aggregate_id === id);
        const turns = turnsOf(settled.snapshot, id);
        const mergedEvent = of('session.merged').at(-1);
        const gate = of('session.gate_checked').at(-1)?.payload;
        // The project gate runs first, then the task's acceptance commands.
        const [result, check] = gate?.results ?? [];
        work[task.id] = {
          turns_completed: turns.length > 0 && turns.every((turn) => turn.state === 'completed'),
          reported: all.some(
            (event) => event.kind === 'task.reported' && event.payload.session_id === id,
          ),
          gate_passed:
            gate?.results?.length === 2 &&
            check.name === task.acceptance[0] &&
            check.exit_code === 0 &&
            result.name === 'Passes' &&
            isDeepStrictEqual(result.argv, GATE_ARGV) &&
            result.exit_code === 0 &&
            !result.timed_out &&
            !!mergedEvent &&
            gate.commit === mergedEvent.payload.to_sha &&
            result.output.trim() === gate.commit,
          auto_merged:
            !!mergedEvent &&
            isDeepStrictEqual(
              of('session.merge_started').map((event) => event.payload),
              [{ auto: true }],
            ),
          gate,
          merged: mergedEvent?.payload ?? null,
        };
      }
      snapshots.work = work;
      const which = (key) => plan.tasks.filter((task) => work[task.id][key]).map((task) => task.id);
      for (const task of plan.tasks)
        if (!work[task.id].turns_completed)
          throw new Error(`Not every turn of the session of ${task.title} completed`);
      observations.work.gates_passed = which('gate_passed');
      observations.work.auto_merged = which('auto_merged');
      observations.work.reported = which('reported');

      await openColumns();
      const titles = await waitUi(
        `(() => { const t = ${columnTitles('完成')}; return t && ${JSON.stringify(plan.tasks.map((task) => task.title))}.every((title) => t.includes(title)) ? t : false; })()`,
        'the done column to hold both tasks',
      );
      observations.board = { done_cards: sorted(titles) };
      await read(
        `(() => { const column = [...document.querySelectorAll('.bd-col')].find((col) => col.querySelector('.bd-col-h')?.textContent.includes('完成')); column.scrollIntoView({ block: 'center', inline: 'center' }); return ${nextFrames}; })()`,
        'scroll the done column into view',
      );
      await shot('done-cards');

      await click({ role: 'button', name: 'fixture-script', within: NAV });
      await waitUi(
        `(() => { const text = [...document.querySelectorAll('.ss-sys')].map((el) => el.textContent).join('\\n'); return ${JSON.stringify(settled.notes)}.every((note) => text.includes(note)); })()`,
        'the lead thread to show both merge notes',
      );
      observations.lead = { notes_shown: true };
      await shot('lead-notes');
    });

    await step('accept', async () => {
      await click(button('项目看板', { within: NAV }));
      // The milestone's row holds this button.
      const accept = button(`验收 ${MILESTONE_TITLE}`);
      await appear(accept);
      await click(accept);
      const dialog = { role: 'dialog', name: `验收「${MILESTONE_TITLE}」`, exact: true };
      await appear(dialog);
      const options = await read(
        `[...document.querySelectorAll('[role="dialog"] [role="group"][aria-label="证据"] input[type="checkbox"]')].map((input) => ({ name: input.closest('label').textContent.trim(), checked: input.checked }))`,
        'the evidence options',
      );
      snapshots.accept_dialog = options;
      observations.milestone = {
        accept_dialog_evidence: sorted(
          options.map((option) => (option.checked ? option.name : `${option.name} (unchecked)`)),
        ),
      };
      await shot('accept-dialog');
      for (const criterion of plan.milestones[0].criteria)
        await click({ role: 'checkbox', name: criterion, exact: true, within: dialog });
      await click(button('确定', { within: dialog }));
      await waitUi(
        `![...document.querySelectorAll('[role="dialog"]')].some((d) => d.getClientRects().length > 0) && [...document.querySelectorAll('.bp-msr')].some((row) => row.querySelector('.nm')?.textContent.trim() === ${JSON.stringify(MILESTONE_TITLE)} && row.textContent.includes('已验收'))`,
        'the dialog to close and the milestone to show 已验收',
      );
      observations.milestone.accepted_in_ui = true;
      const refs = sorted(plan.tasks.map((task) => `session:${sessions[task.id]}`));
      const accepted = await poll(async () => {
        const row = (await board()).milestones.find(
          (m) => m.owner_session_id === leadId && m.key === 'M',
        );
        return row?.acceptance ? row : false;
      }, 'the milestone to be accepted');
      const status = (await boardView()).milestones.find(
        (m) => m.owner_session_id === leadId,
      )?.status;
      snapshots.accepted = { milestone: accepted, status };
      observations.milestone.evidence_refs =
        status === 'completed' &&
        isDeepStrictEqual(sorted(accepted.acceptance.evidence_refs), refs);
      await shot('accepted');
    });
  } catch (error) {
    failure = new Error(`${current}: ${error.message}`, { cause: error });
  }

  // Cleanup runs on every path, each part bounded.
  current = 'shutdown';
  let evidence;
  if (failure && page && !page.failure)
    try {
      screens.push(await page.screenshot('failure', Date.now() + 5000));
    } catch {}
  try {
    evidence = await collectEvidence();
  } catch (error) {
    evidence = { 'collection-error.txt': String(error?.stack ?? error) };
  }
  page?.close();
  clearInterval(watcher);
  if (fixture) {
    const ownAtEnd = lost ?? (await ownDaemon());
    observations.daemon = { stayed_own: ownAtEnd === null };
  }
  const shutdown = {};
  if (app) {
    const stopped = await app.stop(Date.now() + 20000);
    shutdown.app = stopped;
    observations.shutdown = { app_stopped: stopped.stopped };
  }
  if (fixture) {
    await fixture.close();
    const manifestGone = await stat(path.join(stateDir, 'daemon.json')).then(
      () => false,
      (error) => error.code === 'ENOENT',
    );
    const lockFree = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (error) => resolve(error.code));
      server.listen(path.join(stateDir, 'daemon.lock.sock'), () =>
        server.close(() => resolve(true)),
      );
    });
    shutdown.daemon = { manifest_removed: manifestGone, lock_released: lockFree };
    observations.shutdown = {
      ...observations.shutdown,
      daemon_closed: manifestGone && lockFree === true,
    };
  }
  if (buildBefore) {
    const after = await buildManifest(repoRoot);
    const changed = [
      ...new Set([...buildBefore.files, ...after.files].map((file) => file.path)),
    ].filter(
      (file) =>
        buildBefore.files.find((f) => f.path === file)?.sha256 !==
        after.files.find((f) => f.path === file)?.sha256,
    );
    shutdown.build_changed = changed;
    observations.build = { unchanged: changed.length === 0 };
  }
  snapshots.shutdown = shutdown;
  timings.total_ms = Date.now() - startedAt;
  try {
    for (const screen of screens) {
      const info = await stat(path.join(evidenceDir, screen.file));
      if (!info.isFile() || info.size === 0) throw new Error(`Empty screenshot ${screen.file}`);
    }
  } catch (error) {
    failure ??= error;
  }
  evidence = {
    ...evidence,
    'screens.json': screens,
    'snapshots.json': snapshots,
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

  async function collectEvidence() {
    if (!projectId || lost) return { 'events.json': [] };
    return { 'events.json': await events(Date.now() + 15000) };
  }
}
