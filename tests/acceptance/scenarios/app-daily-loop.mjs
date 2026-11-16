import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ClaudeAdapter, CodexAdapter, nativeEnvironment } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { connect, describeLocator } from '../lib/cdp.mjs';
import { POLL_MS, REQUEST_MS, repositoryRoot, watchApprovals } from '../lib/codex-live.mjs';
import { startNativeDaemon } from '../lib/daemon.mjs';
import { checkDesktopBuild, launchDesktopApp, projectShown } from '../lib/desktop-app.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { findSecrets, identityAlive, redact, redactedLines, scrub } from '../lib/native-live.mjs';

export const title = '真实 app 日常闭环';
export const mode = 'live';

const MINUTE = 60000;
/** Shorter than the case's own timeout, which kills the worker without running its cleanup. */
const RUN_MS = 12.5 * MINUTE;
const PLAN_MS = 6 * MINUTE;
/** Nothing running in the project this long ends the final wait. */
const QUIET_MS = 3 * MINUTE;
const CLOSE_MS = 90000;
const MAX_DENIALS_PER_SESSION = 20;
const PROJECT_NAME = 'text-kit daily loop';
const GATE = [{ name: 'test', argv: ['node', '--test'], timeout_ms: 120000 }];
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];
const THEMES = ['light', 'dark'];
const DOC_TASK = 'cli-deps-note';

const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    timeout: REQUEST_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const PROJECT_FILES = {
  'package.json':
    JSON.stringify(
      {
        name: 'text-kit',
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2,
    ) + '\n',
  'src/words.js': [
    '/** The words of a text, split on whitespace. */',
    'export function words(text) {',
    '  return text.split(/\\s+/).filter(Boolean);',
    '}',
    '',
  ].join('\n'),
  'src/cli.js': [
    "import { words } from './words.js';",
    '',
    '/** What the CLI prints for its arguments. */',
    'export function main(args) {',
    "  return String(words(args.join(' ')).length);",
    '}',
    '',
    'if (import.meta.url === `file://${process.argv[1]}`) console.log(main(process.argv.slice(2)));',
    '',
  ].join('\n'),
  'test/words.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { words } from '../src/words.js';",
    '',
    "test('words splits on whitespace', () => {",
    "  assert.deepEqual(words(' a  b\\tc '), ['a', 'b', 'c']);",
    '});',
    '',
  ].join('\n'),
  'docs/runtime-notes.md': [
    '# Runtime notes',
    '',
    'text-kit runs on Node.js 24 with no installed packages.',
    'The CLI starts in about 40 ms because it loads only its own modules.',
    'Node.js ships util.parseArgs, which parses flags such as --slug without a library.',
    '',
  ].join('\n'),
  'docs/user-feedback.md': [
    '# User feedback',
    '',
    'Users copy the CLI into air-gapped build machines, where npm install is not possible.',
    'Two users asked for --help output that lists every flag.',
    'One user asked for short flags such as -s.',
    '',
  ].join('\n'),
};

const route = (choice) =>
  `runtime "${choice.runtime}", model "${choice.model}"${choice.effort ? `, effort "${choice.effort}"` : ''}`;
const codeGoal = (codex, claude) =>
  [
    'text-kit: add slug support in three tasks',
    'Plan exactly these three tasks with update_board in one lane "main", giving each its kind, source, scope and acceptance:',
    `1. id "slug-fn": add a pure function slugify(text) in src/slug.js that lowercases the text, keeps only a-z and 0-9 and joins the words with "-", with tests in test/slug.test.js. Scope src/slug.js and test/slug.test.js; acceptance "node --test test/slug.test.js". Use ${route(codex)}.`,
    `2. id "title-fn": add a pure function titleCase(text) in src/title.js that capitalises the first letter of every word, with tests in test/title.test.js. Scope src/title.js and test/title.test.js; acceptance "node --test test/title.test.js". Use ${route(claude)}.`,
    `3. id "cli-slug": make main(args) in src/cli.js return slugify of the other arguments when the first one is --slug, with tests in test/cli.test.js. Scope src/cli.js and test/cli.test.js; acceptance "node --test test/cli.test.js"; depends_on ["slug-fn"]. Use ${route(claude)}.`,
    'Give every task path "dispatch" with a one-sentence flow_reason, since each must run in its own task session. Then call start_task with ["slug-fn", "title-fn", "cli-slug"] and end your turn. Do not implement or commit anything yourself.',
  ].join('\n');
const SUPPLEMENT =
  'Supplementary requirement: text-kit must stay free of dependencies, so no task may add a package to package.json; tell any running task that needs to know.';
const docGoal = (claude) =>
  [
    'text-kit research: should the CLI keep parsing its flags by hand or adopt an argument-parsing package?',
    `Add one task to your plan and keep the other tasks as they are: id "${DOC_TASK}", done_when "report", path "dispatch", scope [], acceptance [], ${route(claude)}.`,
    'Its session reads docs/runtime-notes.md and docs/user-feedback.md and delivers, as its report with kind done, a Markdown note of at most 200 words: a recommendation, the reasons, and a "Sources" list in which every reason cites `docs/<file>.md:<line>` and quotes that line verbatim.',
    'Start it with start_task. When its done report arrives, check each quote against the files and accept the task with accept_task. Do not write the note yourself.',
  ].join('\n');

/** Hard-to-reach items a human confirms about the document. */
const REVIEW_CHECKLIST = [
  '# Document review',
  '',
  'Confirm each item about cli-deps-note.md:',
  '',
  '1. Requirement: it answers whether the text-kit CLI should keep parsing flags by hand or adopt a package, with a recommendation and reasons, in at most 200 words.',
  '2. Citations: every reason cites docs/<file>.md:<line> and the quoted text is that line of the file, verbatim.',
  '3. Usability: a maintainer can act on it without reading anything else.',
  '',
].join('\n');

const ended = (turn) => !['queued', 'running'].includes(turn.state);
const planId = (taskId) => taskId.slice(taskId.indexOf(':') + 1);
const tokensOf = (usage) => (usage ? usage.input_tokens + usage.output_tokens : null);

const NAV = { name: '导航', exact: true };
const button = (name, extra = {}) => ({ role: 'button', name, exact: true, ...extra });
const REQUIREMENT = { role: 'textbox', name: '需求', exact: true };
const ALERTS = `[...document.querySelectorAll('[role="alert"]')]
  .filter((el) => el.getClientRects().length > 0)
  .map((el) => el.innerText.trim() || 'an empty alert')
  .join(' | ')`;
const present = (locator) =>
  `(() => { try { globalThis.__acceptanceLocator.find(${JSON.stringify(locator)}); return true; } catch { return false; } })()`;
const nodeSelector = (taskId) => `.react-flow__node[data-id=${JSON.stringify(taskId)}]`;
// A drafted edge carries the same id until it is sent and takes effect.
const edgeSelector = (from, to) =>
  `.react-flow__edge:not(.draft)[data-id=${JSON.stringify(`${from}->${to}`)}]`;
// Merged tasks of one band share a stack node; opened, it lists each as a row.
const openStacks = `(document.querySelectorAll('.bd-stk-h[aria-expanded="false"]').forEach((el) => el.click()), true)`;
const taskElement = (taskId, title) =>
  `(${query(nodeSelector(taskId))} ?? [...document.querySelectorAll('.bd-stk-r')].find((el) => el.querySelector('.bd-stk-rt')?.textContent === ${JSON.stringify(title)}) ?? null)`;
const drawnNodes = `[...document.querySelectorAll('.bd-em-canvas .react-flow__node')].map((el) => el.dataset.id)`;
const SEND_UNSENT = `document.querySelector('.bd-em-bar .btn.pri')`;
const query = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
/**
 * The centre of the element the expression finds, once it is in view and, with `mustHit`, a click
 * there lands on it; else false.
 */
const boxOf = (element, mustHit = true) => `(() => {
  document.querySelector('.bd-fc')?.scrollIntoView({ block: 'nearest' });
  const miss = (why) => ((globalThis.__acceptanceMiss = why), false);
  const el = ${element};
  if (!el) return miss('not found');
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2,
    y = r.top + r.height / 2;
  if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
    return miss('box ' + [r.left, r.top, r.width, r.height].join());
  const hit = document.elementFromPoint(x, y);
  if (${!mustHit} || (hit && (hit === el || el.contains(hit))))
    return { x, y, missed: globalThis.__acceptanceMiss ?? null };
  return miss('covered by <' + hit?.localName + ' class="' + (hit?.getAttribute('class') ?? '') + '">');
})()`;
const drawerText = `(document.querySelector('aside.bd-drw')?.innerText ?? '')`;
const MODEL_SELECT = 'aside.bd-drw [aria-label="模型"]';
const MODEL_OPTION = '[role="listbox"] [role="option"]';
const modelOptions = `[...document.querySelectorAll(${JSON.stringify(MODEL_OPTION)})].map((o) => o.dataset.value ?? '')`;
const waitingShown = (taskId) => `(() => {
  const drawer = [...document.querySelectorAll('aside.bd-drw [role="status"]')].some((el) => el.textContent.includes('等待 lead 决定'));
  const chip = (document.querySelector(${JSON.stringify(nodeSelector(taskId))})?.textContent ?? '').includes('待 lead');
  return drawer || chip ? { drawer, chip } : false;
})()`;
const chartFacts = `(() => ({
  nodes: document.querySelectorAll('.react-flow__node').length,
  running: document.querySelectorAll('.bd-nd[data-state="running"]').length,
  edges: [...document.querySelectorAll('.react-flow__edge')].map((e) => e.getAttribute('data-id')),
  dark: document.documentElement.classList.contains('dark'),
  viewport: [innerWidth, innerHeight],
}))()`;
const nextFrames =
  'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))';

export async function run({ spec, workspace, evidenceDir, humanReview }) {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_MS;
  const stateDir = path.join(workspace, 'state');
  const repo = path.join(workspace, 'text-kit');
  const receipts = [],
    cdpLog = [],
    screens = [],
    timings = { steps: [] },
    views = {},
    denials = [],
    events = [],
    processes = new Map(),
    observations = {},
    outcomes = { interventions: [] },
    preflight = {};
  let fixture, daemon, app, page, projectId, leadId, failure, current, lastBoard, usage;
  let adapters = [],
    watcher,
    watchFailure,
    stopWatch = false,
    cursor = 0,
    pulling,
    checkLogs = '',
    review;

  const left = () => deadline - Date.now();
  /** Half a minute from now, within the scenario deadline. */
  const soon = (ms = 30000) => Math.min(Date.now() + ms, deadline);
  const request = async (pathname, init = {}) => {
    const response = await fetch(`${daemon.url}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${daemon.token}`, ...init.headers },
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
  const call = async (type, input, revision = null) => {
    const result = await send(current, type, input, revision);
    if (result.status !== 200 || result.data.receipt?.error)
      throw new Error(`${type}: ${JSON.stringify(result.data)}`);
    return result.data.receipt;
  };
  const get = async (method, params) => {
    const result = await request(`/v1/${method}?${new URLSearchParams(params)}`);
    if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.data)}`);
    return result.data;
  };
  const board = async () => {
    const snapshot = await get('board', { project_id: projectId });
    for (const row of [
      ...snapshot.sessions.map((session) => session.process_identity),
      ...snapshot.workspaces.map((row) => row.provisioning?.process_identity),
    ])
      if (row) processes.set(`${row.pid}:${row.start_time_us ?? ''}`, row);
    return (lastBoard = snapshot);
  };
  const boardView = () => get('board.view', { project_id: projectId, days: '14' });
  const projectRead = () => get('project.read', { project_id: projectId });
  const revision = async () => (await projectRead()).project.revision;
  const pullEvents = () =>
    (pulling ??= (async () => {
      for (;;) {
        const batch = await get('events', { after: String(cursor), project_id: projectId });
        if (batch.snapshot_required)
          throw new Error('Event log no longer reaches the unread events');
        if (!batch.events.length) return events;
        events.push(...batch.events);
        cursor = batch.events.at(-1).sequence;
      }
    })().finally(() => (pulling = undefined)));
  const poll = async (check, description, capMs = left()) => {
    const until = Math.min(Date.now() + capMs, deadline);
    for (;;) {
      if (watchFailure) throw watchFailure;
      const value = await check();
      if (value) return value;
      if (Date.now() >= until)
        throw new Error(
          `${Date.now() >= deadline ? 'Scenario deadline reached' : 'Timed out'} waiting for ${description}`,
        );
      await delay(POLL_MS);
    }
  };
  const turnsOf = (snapshot, sessionId) =>
    snapshot.session_turns.filter((turn) => turn.session_id === sessionId);
  const leadRow = (model) => model.leads?.find((lead) => lead.session_id === leadId);
  const planOf = async () =>
    (await projectRead()).plans.find((plan) => plan.lead_session_id === leadId);
  const storedPlan = () => daemon.store.get('board_plans', leadId);

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
  const fill = (locator, text) =>
    logged('fill', describeLocator(locator), () => page.fill(locator, text), {
      length: text.length,
    });
  const press = (key, modifiers = []) =>
    logged('press', [...modifiers, key].join('+'), () => page.press(key, modifiers));
  const waitUi = (expression, description, { until = deadline, failWhen = ALERTS } = {}) =>
    logged('waitFor', description, () =>
      page.waitFor(expression, description, Math.min(until, deadline), { failWhen }),
    );
  const read = (expression, description) =>
    logged('evaluate', description, () => page.evaluate(expression));
  const appear = (locator) => waitUi(present(locator), `${describeLocator(locator)} to show`);
  const shot = async (name) => {
    const taken = await logged('screenshot', name, () => page.screenshot(name));
    screens.push({ ...taken, name });
    return taken;
  };
  const mouse = (type, point, extra = {}) =>
    page.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra });
  /** Clicks the centre of the element the expression finds, once nothing covers it. */
  const clickAt = (element, description) =>
    logged('clickAt', description, async () => {
      const point = await page.waitFor(boxOf(element), `${description} to be clickable`, soon());
      await mouse('mouseMoved', point);
      await mouse('mousePressed', point, { button: 'left', buttons: 1, clickCount: 1 });
      await mouse('mouseReleased', point, { button: 'left', buttons: 0, clickCount: 1 });
    });
  /** Drags with the left button held from one element's centre to another's, in small moves. */
  const dragBetween = (fromElement, toElement, description) =>
    logged('drag', description, async () => {
      const begun = Date.now();
      const from = await page.waitFor(
        boxOf(fromElement),
        `the drag start of ${description}`,
        soon(),
      );
      from.waited_ms = Date.now() - begun;
      // The target handle sits under its card; the connection snaps to the nearest handle.
      const to = await page.waitFor(
        boxOf(toElement, false),
        `the drag end of ${description}`,
        soon(),
      );
      await mouse('mouseMoved', from);
      await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 12; i++)
        await mouse(
          'mouseMoved',
          { x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12 },
          { button: 'left', buttons: 1 },
        );
      await mouse('mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 });
      return { from, to };
    });
  const publish = async (text) => {
    await click(button('项目看板', { within: NAV }));
    await appear(REQUIREMENT);
    await waitUi(
      `document.querySelector('textarea[aria-label="需求"]')?.disabled === false`,
      'the requirement box to take input',
    );
    await fill(REQUIREMENT, text);
    await press('Enter', ['Meta']);
    await waitUi(
      `document.querySelector('textarea[aria-label="需求"]')?.value === ''`,
      'the requirement box to clear once sent',
    );
  };
  const openFlow = async () => {
    await click(button('流程图', { within: NAV }));
    await waitUi(`document.querySelectorAll('.react-flow__node').length > 0`, 'the flow chart');
  };
  /** The board's now view in edit mode, where changes on the chart go into the draft. */
  const openEditing = async () => {
    await click(button('项目看板', { within: NAV }));
    await click({ role: 'radio', name: '现在', exact: true });
    // With changes left unsent the edit button's name counts them.
    await click(button('编辑', { exact: false }));
    await waitUi(
      `document.querySelectorAll('.bd-em-canvas .react-flow__node').length > 0`,
      'the flow chart in edit mode',
    );
  };

  const flush = () => writeEvidence(evidenceDir, evidenceContents());
  const step = async (name, action) => {
    current = name;
    const begun = Date.now();
    try {
      return await action();
    } finally {
      timings.steps.push({ name, ms: Date.now() - begun });
      if (projectId)
        try {
          views[name] = await boardView();
        } catch (error) {
          views[name] = { error: error.message };
        }
      await flush();
    }
  };

  try {
    await step('seed', async () => {
      const build = await checkDesktopBuild(repositoryRoot);
      timings.build = build;
      if (!build.fresh)
        throw new Error(
          `apps/desktop/out is older than its inputs (newest input ${JSON.stringify(build.newest_input)}); run pnpm build && pnpm --filter @pantheon/desktop bundle first`,
        );
      for (const dir of [repo, path.join(workspace, 'workspaces'), path.join(workspace, 'backups')])
        await mkdir(dir, { recursive: true });
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.name', 'Daily Loop Scenario');
      git(repo, 'config', 'user.email', 'daily-loop@example.invalid');
      git(repo, 'config', 'commit.gpgsign', 'false');
      for (const [name, content] of Object.entries(PROJECT_FILES)) {
        await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
        await writeFile(path.join(repo, name), content);
      }
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'Initial commit');
      preflight.base = git(repo, 'rev-parse', 'HEAD').trim();

      const runBinary = async (binary, args) => {
        try {
          const { stdout, stderr } = await promisify(execFile)(binary, args, {
            env: nativeEnvironment(),
            encoding: 'utf8',
            timeout: REQUEST_MS,
          });
          return { exit_code: 0, text: `${stdout}\n${stderr}`.trim() };
        } catch (error) {
          return {
            exit_code: error.code ?? null,
            text: `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim(),
          };
        }
      };
      const claudeVersion = await runBinary('claude', ['--version']);
      const codexVersion = await runBinary('codex', ['--version']);
      const codexLogin = await runBinary('codex', ['login', 'status']);
      preflight.claude = {
        version: claudeVersion.text.split('\n')[0],
        exit_code: claudeVersion.exit_code,
      };
      preflight.codex = {
        version: codexVersion.text.split('\n')[0],
        exit_code: codexVersion.exit_code,
        // Only whether a subscription login is in use; the rest of the line can name the account.
        subscription_login: /Logged in using ChatGPT/i.test(codexLogin.text),
      };
      if (claudeVersion.exit_code !== 0) throw new Error('Preflight: claude --version failed');
      if (codexVersion.exit_code !== 0) throw new Error('Preflight: codex --version failed');
      if (!preflight.codex.subscription_login)
        throw new Error('Preflight: Codex is not logged in with a subscription');
      adapters = [
        new ClaudeAdapter('claude', preflight.claude.version),
        new CodexAdapter('codex', preflight.codex.version),
      ];

      fixture = await startNativeDaemon(workspace, adapters, { intervalMs: 200 });
      ({ daemon } = fixture);
      const project = await call('project.open', { name: PROJECT_NAME, roots: [repo] });
      projectId = project.id;
      preflight.inventories = {};
      for (const runtime of ['claude', 'codex']) {
        const inventory = await get('extensions.inventory', { project_id: projectId, runtime });
        preflight.inventories[runtime] = {
          mcp_servers: inventory.mcp_servers.map((server) => server.name),
          plugins: inventory.plugins.map((plugin) => plugin.id),
        };
        await call(
          'project.extensions.set',
          {
            project_id: projectId,
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
          await revision(),
        );
      }
      await call(
        'project.gate.set',
        { project_id: projectId, root: project.roots[0], commands: GATE },
        await revision(),
      );
      await call(
        'project.sessionDefaults.set',
        { project_id: projectId, runtime: 'claude', permission_mode: 'auto_edit' },
        await revision(),
      );
      await call(
        'project.autoMerge.set',
        { project_id: projectId, enabled: true },
        await revision(),
      );
      // One task session at a time keeps a task running and others not started while the user edits.
      await call('workflow.policy.set', { project_id: projectId, max_parallel: 1 });

      // The cheapest listed model of each runtime by name, at its lowest effort.
      const choose = async (runtime, pattern) => {
        const models = await get('runtime.models', { project_id: projectId, runtime });
        const model =
          models.find((row) => pattern.test(row.id)) ?? models.find((row) => !row.default);
        if (!model) throw new Error(`Preflight: runtime.models lists no ${runtime} model`);
        const effort = ['low', 'medium', 'high'].find((level) => model.efforts?.includes(level));
        return { runtime, model: model.id, effort, listed: models.map((row) => row.id) };
      };
      outcomes.models = {
        claude: await choose('claude', /haiku/i),
        codex: await choose('codex', /luna|mini/i),
      };

      // Every permission request is refused, so a session stays inside its sandbox.
      watcher = watchApprovals({
        projectId,
        get,
        send,
        pullEvents,
        events,
        denials,
        deadline,
        stopped: () => stopWatch,
        fail: (error) => (watchFailure = error),
        maxPerSession: MAX_DENIALS_PER_SESSION,
      });
    });

    await step('launch', async () => {
      app = await launchDesktopApp({ repoRoot: repositoryRoot, dataDir: stateDir, deadline });
      timings.app = { pid: app.pid, port: app.port };
      page = await logged('connect', `DevTools port ${app.port}`, () =>
        connect(app.port, deadline, { evidenceDir }),
      );
      await waitUi(projectShown(PROJECT_NAME), 'the sidebar to name the project');
    });

    await step('publish-code-goal', async () => {
      const before = new Set((await board()).sessions.map((row) => row.id));
      await publish(codeGoal(outcomes.models.codex, outcomes.models.claude));
      const lead = await poll(async () => {
        const added = (await board()).sessions.filter((row) => !before.has(row.id));
        return added[0] ?? false;
      }, 'the lead session to be created');
      if (lead.task) throw new Error(`The lead is bound to task ${JSON.stringify(lead.task)}`);
      if (lead.runtime !== 'claude')
        throw new Error(`The lead runs on ${lead.runtime}, not claude`);
      leadId = lead.id;
      outcomes.lead = { session_id: leadId, runtime: lead.runtime };
      await shot('code-goal-sent');
    });

    const planned = await step('plan', () =>
      poll(
        async () => {
          const snapshot = await board();
          await pullEvents();
          const failed = turnsOf(snapshot, leadId).find(
            (turn) => ended(turn) && turn.state !== 'completed',
          );
          const model = await boardView();
          const tasks = model.tasks.filter((task) => task.owner_session_id === leadId);
          if (failed && !tasks.length) throw new Error(`The lead's turn ended ${failed.state}`);
          const edges = model.edges.filter((edge) => tasks.some((task) => task.id === edge.to));
          return tasks.length >= 3 &&
            edges.length >= 1 &&
            tasks.some((task) => task.state === 'running') &&
            tasks.some((task) => !task.claim && ['todo', 'waiting_upstream'].includes(task.state))
            ? { model, tasks }
            : false;
        },
        'the plan with a dependency and a running task session',
        PLAN_MS,
      ),
    );
    outcomes.plan_at_start = {
      version: leadRow(planned.model)?.plan_version ?? null,
      tasks: planned.tasks.map((task) => ({
        id: planId(task.id),
        state: task.state,
        depends_on: task.depends_on,
        planned: task.planned,
      })),
      edges: planned.model.edges.map((edge) => `${planId(edge.from)}->${planId(edge.to)}`),
    };

    let modelEdit;
    await step('model-edit', async () => {
      await openFlow();
      const model = await boardView();
      const tasks = model.tasks.filter((task) => task.owner_session_id === leadId);
      const running = tasks.filter((task) => task.state === 'running' && task.claim);
      const target = running.find((task) => task.claim.runtime === 'claude') ?? running[0] ?? null;
      if (!target) throw new Error('No task is running when the model is to be changed');
      const runtime = target.planned?.runtime ?? target.claim.runtime;
      const before = target.planned?.model ?? null;
      modelEdit = {
        kind: 'model',
        via: 'task drawer',
        task: planId(target.id),
        task_state: target.state,
        runtime,
        model_before: before,
        plan_version_before: leadRow(model)?.plan_version ?? null,
      };
      outcomes.interventions.push(modelEdit);
      await clickAt(query(nodeSelector(target.id)), `the node of ${modelEdit.task}`);
      await waitUi(
        `(document.querySelector('#bd-drw-title')?.textContent ?? '') === ${JSON.stringify(target.title)}`,
        'the drawer of the running task',
      );
      await clickAt(query(MODEL_SELECT), 'the model list of the drawer');
      const options = await waitUi(
        `(() => { const o = ${modelOptions}; return o.filter((v) => v).length >= 2 ? o : false; })()`,
        'the model list of the task runtime',
      );
      const others = options.filter((value) => value && value !== before && value !== 'default');
      const next =
        others.find((value) => (runtime === 'claude' ? /sonnet/i : /luna|mini/i).test(value)) ??
        others[0];
      if (!next) throw new Error(`No other ${runtime} model to switch to: ${options.join(', ')}`);
      modelEdit.model_after = next;
      modelEdit.options = options;
      await clickAt(
        query(`${MODEL_OPTION}[data-value=${JSON.stringify(next)}]`),
        `the model ${next}`,
      );
      modelEdit.waiting_shown = await waitUi(
        waitingShown(target.id),
        'the drawer to show the edit waits for the lead',
        { until: soon() },
      );
      const pendingRow = await poll(
        async () => {
          const now = await boardView();
          return (
            leadRow(now)?.pending_edits?.find((edit) => edit.task_ids.includes(modelEdit.task)) ??
            false
          );
        },
        'the board to list the edit as waiting for the lead',
        30000,
      );
      modelEdit.edit_id = pendingRow.id;
      modelEdit.board_pending = true;
      await shot('model-edit-waiting');
      await click(button('关闭详情'));
    });

    await step('dependency-edit', async () => {
      await openEditing();
      // A stacked merged task has no node of its own to drag from or to.
      const drawn = new Set(await read(drawnNodes, 'the tasks drawn as their own nodes'));
      const model = await boardView();
      const tasks = model.tasks.filter((task) => task.owner_session_id === leadId);
      const reaches = (from, to) => {
        const seen = new Set([from]);
        for (const at of seen) {
          if (at === to) return true;
          for (const edge of model.edges) if (edge.from === at) seen.add(edge.to);
        }
        return false;
      };
      const waiting = tasks.filter(
        (task) =>
          !task.claim && ['todo', 'waiting_upstream'].includes(task.state) && drawn.has(task.id),
      );
      const pairs = waiting.flatMap((to) =>
        tasks
          .filter(
            (from) =>
              from.id !== to.id &&
              drawn.has(from.id) &&
              !model.edges.some((edge) => edge.from === from.id && edge.to === to.id) &&
              !reaches(to.id, from.id),
          )
          .map((from) => ({ from, to })),
      );
      // A running upstream keeps the extra wait short.
      const pair = pairs.find(({ from }) => from.state === 'running') ?? pairs[0] ?? null;
      const versionBefore = leadRow(model)?.plan_version ?? null;
      const entry = {
        kind: 'dependency',
        via: 'flow chart',
        plan_version_before: versionBefore,
      };
      outcomes.interventions.push(entry);
      if (pair) {
        entry.action = 'add';
        entry.from = planId(pair.from.id);
        entry.to = planId(pair.to.id);
        entry.to_state = pair.to.state;
        const source = `${nodeSelector(pair.from.id)} .react-flow__handle.source`;
        const target = `${nodeSelector(pair.to.id)} .react-flow__handle.target`;
        await waitUi(
          `document.querySelectorAll(${JSON.stringify(`${source}.connectionindicator, ${target}.connectionindicator`)}).length === 2`,
          'both handles of the new dependency to take a connection',
          { until: soon() },
        );
        entry.drag = await dragBetween(
          query(source),
          query(target),
          `${entry.from} to ${entry.to}`,
        );
      } else {
        // Every task already waits on every task it can; drop an edge into a task not started instead.
        const edge = model.edges.find(
          (row) => drawn.has(row.from) && waiting.some((task) => task.id === row.to),
        );
        if (!edge) throw new Error('No task that has not started has a dependency to change');
        entry.action = 'remove';
        entry.from = planId(edge.from);
        entry.to = planId(edge.to);
        await read(
          `(() => { const el = ${query(edgeSelector(edge.from, edge.to))}; el.focus(); return document.activeElement === el; })()`,
          'focus the edge to remove',
        );
        await press('Backspace');
      }
      // The change stays a draft until it is sent from the unsent changes of the task column.
      await waitUi(
        `(() => { const send = ${SEND_UNSENT}; send?.click(); return !!send; })()`,
        'the send button of the unsent changes',
        { until: soon() },
      );
      const toId = `${leadId}:${entry.to}`;
      const fromId = `${leadId}:${entry.from}`;
      const settled = await poll(
        async () => {
          const now = await boardView();
          const task = now.tasks.find((row) => row.id === toId);
          const has = task?.depends_on?.includes(entry.from);
          const edgeShown = now.edges.some((row) => row.from === fromId && row.to === toId);
          if (task?.pending_edit) return { now, pending: true };
          return (entry.action === 'add' ? has && edgeShown : !has && !edgeShown)
            ? { now, pending: false }
            : false;
        },
        'the dependency edit to take effect on the board',
        60000,
      );
      entry.applied = !settled.pending;
      entry.plan_version_after = leadRow(settled.now)?.plan_version ?? null;
      entry.board_edges_after = settled.now.edges
        .filter((row) => row.from.startsWith(`${leadId}:`))
        .map((row) => `${planId(row.from)}->${planId(row.to)}`);
      if (entry.applied) {
        const drawn = query(edgeSelector(fromId, toId));
        await waitUi(
          entry.action === 'add' ? `Boolean(${drawn})` : `!${drawn}`,
          `the flow chart to ${entry.action === 'add' ? 'draw' : 'drop'} the edge`,
          { until: soon() },
        );
        entry.chart_follows = true;
      }
      await shot('dependency-edited');
    });

    await step('screens', async () => {
      outcomes.screens = [];
      for (const size of SIZES)
        for (const theme of THEMES) {
          await page.send('Emulation.setDeviceMetricsOverride', {
            ...size,
            deviceScaleFactor: 0,
            mobile: false,
          });
          await page.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: theme }],
          });
          await waitUi(
            `innerWidth === ${size.width} && document.documentElement.classList.contains('dark') === ${theme === 'dark'}`,
            `the ${size.width}x${size.height} ${theme} frame`,
          );
          await read(nextFrames, 'two frames');
          const facts = await waitUi(
            `(() => { const f = ${chartFacts}; return f.running > 0 && f.edges.length > 0 ? f : false; })()`,
            'the chart to show a running task and an edge',
            { until: soon(90000) },
          );
          const taken = await shot(`flow-${size.width}x${size.height}-${theme}`);
          outcomes.screens.push({ ...size, theme, file: taken.file, ...facts });
        }
      await page.send('Emulation.clearDeviceMetricsOverride', {});
      await page.send('Emulation.setEmulatedMedia', { features: [] });
    });

    await step('lead-view', async () => {
      const viewSwitch = { role: 'radiogroup', name: '视图', exact: true };
      await click({ role: 'radio', name: 'lead', exact: true, within: viewSwitch });
      await waitUi(
        `document.querySelectorAll('[role="radiogroup"][aria-label="轮次"] [role="radio"]').length > 0`,
        'the lead rounds',
      );
      const names = await read(
        `[...document.querySelectorAll('[role="radiogroup"][aria-label="轮次"] [role="radio"]')].map((r) => r.textContent.trim())`,
        'the round names',
      );
      const steps = `(() => {
        const items = [...document.querySelectorAll('ol[aria-label="这一轮的步骤"] > li')];
        const dispatch = items.find((li) => li.querySelector('h3')?.textContent.trim() === '派发');
        return {
          steps: items.map((li) => li.querySelector('h3')?.textContent.trim() ?? ''),
          dispatched: dispatch ? [...dispatch.querySelectorAll('.lw-fan li')].map((li) => li.querySelector('.lw-task span')?.textContent.trim() ?? '') : null,
        };
      })()`;
      let found = null;
      for (const [index, name] of names.entries()) {
        await clickAt(
          `document.querySelectorAll('[role="radiogroup"][aria-label="轮次"] [role="radio"]')[${index}]`,
          `the round ${name}`,
        );
        await waitUi(
          `document.querySelectorAll('[role="radiogroup"][aria-label="轮次"] [role="radio"]')[${index}]?.getAttribute('aria-checked') === 'true'`,
          `the round ${name} to be chosen`,
          { until: soon() },
        );
        await read(nextFrames, 'two frames');
        const facts = await read(steps, `the steps of ${name}`);
        if (facts.dispatched?.length) {
          found = { round: name, ...facts };
          break;
        }
      }
      outcomes.lead_view = { rounds: names, round_with_dispatch: found };
      if (!found) throw new Error(`No lead round shows a dispatch step: ${names.join(', ')}`);
      outcomes.lead_view.file = (await shot('flow-lead-view-1280x800')).file;
      await click({ role: 'radio', name: '任务', exact: true, within: viewSwitch });
    });

    await step('supplement', async () => {
      const before = new Set(turnsOf(await board(), leadId).map((turn) => turn.id));
      await publish(SUPPLEMENT);
      const turn = await poll(
        async () => {
          const turns = turnsOf(await board(), leadId);
          return (
            turns.find((row) => !before.has(row.id) && row.input?.includes(SUPPLEMENT)) ?? false
          );
        },
        'the lead to take the supplementary requirement',
        30000,
      );
      outcomes.interventions.push({
        kind: 'requirement',
        via: 'publish bar',
        turn_id: turn.id,
        turn_kind: turn.kind ?? null,
        state_when_sent: turn.state,
      });
    });

    await step('publish-doc-goal', async () => {
      await publish(docGoal(outcomes.models.claude));
      await poll(
        async () =>
          (await planOf())?.tasks.some(
            (task) => task.id === DOC_TASK && task.done_when === 'report',
          ),
        'the lead to plan the document task',
        5 * MINUTE,
      );
    });

    let quietSince;
    const done = await step('work', () =>
      poll(async () => {
        const snapshot = await board();
        await pullEvents();
        const model = await boardView();
        const tasks = model.tasks.filter((task) => task.owner_session_id === leadId);
        const failed = tasks.find((task) => task.state === 'failed');
        if (failed) throw new Error(`Task ${planId(failed.id)} failed`);
        const lead = snapshot.sessions.find((row) => row.id === leadId);
        if (lead?.state === 'closed') throw new Error('The lead session closed');
        const edit = storedPlan()?.pending_edits?.find((row) => row.edit_id === modelEdit.edit_id);
        const busy =
          snapshot.session_turns.some((turn) => !ended(turn)) ||
          snapshot.sessions.some((session) => session.merge?.state === 'running') ||
          snapshot.workspaces.some((row) =>
            ['queued', 'running'].includes(row.provisioning?.state),
          );
        const finished =
          tasks.some((task) => planId(task.id) === DOC_TASK) &&
          tasks.every((task) => task.state === 'merged') &&
          edit?.status !== 'pending' &&
          !busy;
        if (finished) return { snapshot, model, tasks, edit };
        if (busy) quietSince = undefined;
        else if (Date.now() - (quietSince ??= Date.now()) > QUIET_MS)
          throw new Error(
            `Nothing ran in the project for ${QUIET_MS / MINUTE} minutes; tasks ${tasks.map((task) => `${planId(task.id)}=${task.state}`).join(', ')}, edit ${edit?.status}`,
          );
        return false;
      }, 'every task to finish and the lead to settle the model edit'),
    );

    await step('model-edit-result', async () => {
      modelEdit.resolution = done.edit?.status ?? null;
      modelEdit.reason = done.edit?.reason ?? null;
      modelEdit.plan_version_after = leadRow(done.model)?.plan_version ?? null;
      const task = done.tasks.find((row) => planId(row.id) === modelEdit.task);
      modelEdit.planned_model_after = task?.planned?.model ?? null;
      const rejected = leadRow(done.model)?.rejected_edits?.some(
        (row) => row.id === modelEdit.edit_id,
      );
      modelEdit.board_shows =
        modelEdit.resolution === 'applied'
          ? modelEdit.planned_model_after === modelEdit.model_after
          : modelEdit.resolution === 'rejected'
            ? rejected === true
            : false;
      await openFlow();
      // Every task has merged by now, so the edited one may sit in a stack.
      await read(openStacks, 'open the stacks of merged tasks');
      await clickAt(taskElement(task.id, task.title), `the node of ${modelEdit.task}`);
      await waitUi(
        `(document.querySelector('#bd-drw-title')?.textContent ?? '') === ${JSON.stringify(task.title)}`,
        'the drawer of the edited task',
      );
      const drawer = await read(drawerText, 'the drawer text');
      modelEdit.drawer_waiting_after = drawer.includes('等待 lead 决定');
      modelEdit.drawer_rejected_after = drawer.includes('lead 已拒绝');
      await shot('model-edit-resolved');
      await click(button('关闭详情'));
    });

    await step('code-check', async () => {
      const all = await pullEvents();
      const plan = await planOf();
      const code = plan.tasks.filter((task) => task.done_when !== 'report');
      outcomes.code = { tasks: [] };
      for (const task of code) {
        const sessions = done.snapshot.sessions.filter(
          (row) => row.task?.lead_session_id === leadId && row.task.id === task.id,
        );
        const session = sessions.find((row) => row.outcome === 'merged');
        const merged = session
          ? all.findLast((e) => e.kind === 'session.merged' && e.aggregate_id === session.id)
          : undefined;
        const gate = merged
          ? all.findLast(
              (e) =>
                e.kind === 'session.gate_checked' &&
                e.aggregate_id === session.id &&
                e.sequence < merged.sequence,
            )
          : undefined;
        let onMain = false;
        if (merged?.payload.to_sha)
          try {
            git(repo, 'merge-base', '--is-ancestor', merged.payload.to_sha, 'main');
            onMain = true;
          } catch {}
        const results = gate?.payload.results ?? [];
        outcomes.code.tasks.push({
          id: task.id,
          runtime: session?.runtime ?? null,
          session_id: session?.id ?? null,
          acceptance: task.acceptance,
          merged_to: merged?.payload.to_sha ?? null,
          on_main: onMain,
          gate_passed:
            results.length > 0 &&
            results.every((result) => result.exit_code === 0 && !result.timed_out),
          gate_results: results.map(({ name, argv, exit_code, timed_out }) => ({
            name,
            argv,
            exit_code,
            timed_out,
          })),
        });
        checkLogs += `## ${task.id} (${session?.runtime ?? 'no session'}) session ${session?.id ?? '-'}\n`;
        checkLogs += `gate on ${gate?.payload.commit ?? '-'}, merged to ${merged?.payload.to_sha ?? '-'}\n`;
        for (const result of results)
          checkLogs += `\n$ ${(result.argv ?? [result.name]).join(' ')}\nexit ${result.exit_code}${result.timed_out ? ' (timed out)' : ''}\n${result.output ?? ''}\n`;
        checkLogs += '\n';
      }
      // The merged main, checked out fresh, passes the same gate.
      const clone = path.join(workspace, 'main-check');
      git(workspace, 'clone', '-q', '--no-local', repo, clone);
      let final;
      try {
        const { stdout, stderr } = await promisify(execFile)('node', ['--test'], {
          cwd: clone,
          encoding: 'utf8',
          timeout: 120000,
        });
        final = { exit_code: 0, output: `${stdout}${stderr}` };
      } catch (error) {
        final = {
          exit_code: error.code ?? null,
          output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
        };
      }
      const manifest = JSON.parse(await readFile(path.join(clone, 'package.json'), 'utf8'));
      outcomes.code.main = {
        head: git(repo, 'rev-parse', 'main').trim(),
        log: git(repo, 'log', '--oneline', '-n', '20', 'main').trim().split('\n'),
        test_exit_code: final.exit_code,
        dependency_free: !manifest.dependencies && !manifest.devDependencies,
      };
      checkLogs += `## main ${outcomes.code.main.head}\n\n$ node --test\nexit ${final.exit_code}\n${final.output}\n`;
    });

    await step('document', async () => {
      const all = await pullEvents();
      const session = done.snapshot.sessions.find(
        (row) => row.task?.lead_session_id === leadId && row.task.id === DOC_TASK,
      );
      const report = all.findLast(
        (e) =>
          e.kind === 'task.reported' &&
          e.payload.session_id === session?.id &&
          e.payload.kind === 'done',
      );
      const accepted = done.tasks.find((task) => planId(task.id) === DOC_TASK);
      outcomes.document = {
        session_id: session?.id ?? null,
        runtime: session?.runtime ?? null,
        reported: Boolean(report),
        done_by: accepted?.done_by ?? null,
      };
      if (!report) throw new Error('The document task has no done report');
      const [doc, checklist] = await writeEvidence(evidenceDir, {
        'cli-deps-note.md': scrub(report.payload.text) + '\n',
        'document-review-checklist.md': REVIEW_CHECKLIST,
      });
      review = await humanReview(
        [
          { name: 'cli-deps-note.md', path: doc.path },
          { name: 'document-review-checklist.md', path: checklist.path },
        ],
        { waitMs: 0 },
      );
      outcomes.document.review = { ok: review.ok, reasons: review.reasons };
    });
  } catch (error) {
    failure = new Error(`${current}: ${error.message}`, { cause: error });
  }

  // Cleanup runs on every path, each part bounded.
  current = 'shutdown';
  if (failure && page && !page.failure)
    try {
      screens.push({ ...(await page.screenshot('failure', Date.now() + 5000)), name: 'failure' });
    } catch {}
  stopWatch = true;
  await watcher;
  if (daemon)
    try {
      await board();
      await pullEvents();
      views.final = await boardView();
      usage = await get('project.usage.read', { project_id: projectId });
    } catch (error) {
      timings.collection_error = String(error?.message ?? error);
    }
  page?.close();
  const shutdown = {};
  if (app) shutdown.app = await app.stop(Date.now() + 20000);
  if (fixture) {
    let closed = false;
    await Promise.race([
      fixture.close().then(
        () => (closed = true),
        (error) => (shutdown.daemon_error = String(error?.message ?? error)),
      ),
      delay(CLOSE_MS, undefined, { ref: false }),
    ]);
    shutdown.daemon_closed = closed;
    // Recorded, not signalled: the session processes carry no marker of this run.
    shutdown.still_running = [...processes.values()].filter(identityAlive);
    shutdown.recorded_processes = processes.size;
  }
  timings.shutdown = shutdown;
  timings.total_ms = Date.now() - startedAt;

  const sessions = (lastBoard?.sessions ?? []).map((session) => {
    const turns = lastBoard.session_turns.filter((turn) => turn.session_id === session.id);
    return {
      id: session.id,
      role: session.id === leadId ? 'lead' : session.task ? `task ${session.task.id}` : 'other',
      runtime: session.runtime,
      model: session.reported_model ?? session.requested_model ?? null,
      requested_model: session.requested_model ?? null,
      reported_model: session.reported_model ?? null,
      effort: session.requested_effort ?? null,
      turns: turns.length,
      completed_turns: turns.filter((turn) => turn.state === 'completed').length,
      tokens: tokensOf(session.usage),
      input_tokens: session.usage?.input_tokens ?? null,
      output_tokens: session.usage?.output_tokens ?? null,
      cost_usd: session.usage?.cost_usd ?? null,
      usage_source: session.usage ? 'runtime_reported' : 'unknown',
      outcome: session.outcome ?? null,
    };
  });
  outcomes.sessions = sessions;
  outcomes.approvals_denied = denials;
  const ran = (runtime) =>
    sessions.some(
      (row) =>
        row.runtime === runtime &&
        row.completed_turns > 0 &&
        events.some((e) => e.aggregate_id === row.id && String(e.kind).startsWith('agent.message')),
    );
  const [dependency, model, requirement] = ['dependency', 'model', 'requirement'].map((kind) =>
    outcomes.interventions.find((row) => row.kind === kind),
  );
  if (requirement && lastBoard)
    requirement.final_state =
      lastBoard.session_turns.find((turn) => turn.id === requirement.turn_id)?.state ?? null;
  observations.live = {
    both_harnesses_used: ran('claude') && ran('codex'),
    code_acceptance_passed:
      (outcomes.code?.tasks.length ?? 0) >= 3 &&
      outcomes.code.tasks.every((task) => task.gate_passed && task.on_main) &&
      outcomes.code.main.test_exit_code === 0,
    document_acceptance_recorded: review?.ok === true,
    manual_interventions_logged:
      outcomes.interventions.length === 3 &&
      requirement?.final_state === 'completed' &&
      model?.waiting_shown !== undefined &&
      model.board_pending === true &&
      ['applied', 'rejected'].includes(model.resolution) &&
      model.board_shows === true &&
      dependency?.applied === true &&
      dependency.chart_follows === true &&
      dependency.plan_version_after > dependency.plan_version_before,
    cost_provenance_recorded:
      sessions.length > 0 &&
      sessions.every(
        (row) =>
          typeof row.runtime === 'string' &&
          ['runtime_reported', 'unknown'].includes(row.usage_source) &&
          (row.usage_source === 'unknown' || typeof row.tokens === 'number'),
      ),
  };
  observations.shutdown = {
    app_stopped: shutdown.app?.stopped ?? null,
    daemon_closed: shutdown.daemon_closed ?? null,
    processes_left: shutdown.still_running?.length ?? null,
  };

  const contents = evidenceContents();
  const scan = await findSecrets(evidenceDir, contents, [daemon?.token]);
  contents['secret-scan.json'] = scan;
  if (scan.matches.length)
    failure ??= new Error(`Evidence holds a credential shape: ${JSON.stringify(scan.matches)}`);
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...contents,
      'observations-so-far.json': observations,
      'failure.txt': scrub(String(failure?.stack ?? failure)),
    });
    throw failure;
  }
  return {
    observations,
    evidence: contents,
    adapters: adapters.map((adapter) => `${adapter.name}@${adapter.report.version}`),
  };

  function evidenceContents() {
    return {
      'redacted-native-events.jsonl': redactedLines(events),
      'check-logs.txt': scrub(checkLogs || 'No gate ran before the scenario stopped\n'),
      'human-review.json': {
        requested: Boolean(review),
        ok: review?.ok ?? false,
        reasons: review?.reasons ?? ['the scenario stopped before the document was ready'],
        receipt: review?.receipt ?? null,
        how: `node scripts/acceptance-review.mjs ${spec.id}`,
      },
      'outcomes.json': redact({ ...outcomes, preflight, timings }),
      'board-views.json': redact(views),
      'receipts.json': redact(receipts),
      'cdp-log.json': redact(cdpLog),
      'screens.json': screens,
      'usage.json': redact(usage ?? {}),
    };
  }
}
