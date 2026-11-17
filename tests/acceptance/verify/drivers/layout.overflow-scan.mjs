import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
import { scanOverflow } from '../overflow.mjs';
const t0 = Date.now();
const runDir = process.argv[2];
const { page, query, call, errors, poll, reset, newProject } = await open(runDir);
const result = { id: 'layout.overflow-scan', checks: [], seed: {}, counts: {}, shots: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Control group: the same scan must find one fault of each kind in boxes built to have them.
const CONTROL = 'overflow-control';
await page.evaluate(`(() => {
  const host = document.createElement('div');
  host.id = ${JSON.stringify(CONTROL)};
  host.style.cssText = 'position:fixed;left:8px;top:8px;width:700px;pointer-events:none;font:12px monospace';
  const loose = document.createElement('div');
  loose.style.cssText = 'width:100px;border:1px solid #888';
  loose.textContent = ${JSON.stringify('0123456789abcdef'.repeat(6))};
  const cut = document.createElement('div');
  cut.style.cssText = 'width:100px;margin-top:8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis';
  cut.textContent = ${JSON.stringify('fedcba9876543210'.repeat(6))};
  const clipped = document.createElement('div');
  clipped.style.cssText = 'width:100px;margin-top:8px;overflow:hidden';
  const line = document.createElement('span');
  line.style.whiteSpace = 'nowrap';
  line.textContent = ${JSON.stringify('0f1e2d3c4b5a6978'.repeat(6))};
  clipped.append(line);
  host.append(loose, cut, clipped);
  document.body.append(host);
})()`);
const count = (findings, kind) => findings.filter((f) => f.kind === kind).length;
const faulty = await scanOverflow(page, { within: `#${CONTROL}` });
await page.evaluate(`(() => {
  const [loose, cut, clipped] = document.getElementById(${JSON.stringify(CONTROL)}).children;
  loose.style.overflowWrap = 'anywhere';
  cut.title = cut.textContent;
  clipped.firstChild.title = clipped.textContent;
})()`);
const fixed = await scanOverflow(page, { within: `#${CONTROL}` });
await page.evaluate(`document.getElementById(${JSON.stringify(CONTROL)}).remove()`);
check(
  'control group: one escape, one hidden by ellipsis and one cut by its box, none once wrapped and titled',
  count(faulty, 'escape') === 1 &&
    count(faulty, 'hidden') === 2 &&
    faulty.length === 3 &&
    fixed.length === 0,
  { faulty, fixed },
);

// Worst-case data: a long project name and README, long session titles and replies, a long plan.
const stamp = Date.now();
const LONG_PATH =
  '/Users/example/Pantheon/.claude/worktrees/agent-a3a7d9612b917097d/apps/web/src/screens/sessions/SessionRowWithALongName.tsx';
const BRANCH = 'worktree-agent-a3a7d9612b917097d-fix-run-changeGrant-after-replan';
const MIXED =
  '修复 daemon 重启后 reconciling 状态的 Attempt 无法 resume_session 的问题(含 worktree 清理与 grant 重绑)';
const HASH = '9f8e7d6c5b4a4c3d8e2f1a0b9c8d7e6f'.repeat(12);
const cap = (text, n) => text.slice(0, n);
const readme = [
  `# 超长项目说明 Konstantin Oberhauser-Wettstein Benachrichtigungseinstellungen ${stamp}`,
  '',
  `${MIXED}。`.repeat(6),
  '',
  `构建产物在 ${LONG_PATH} 旁边，分支 ${BRANCH}。`,
  '',
  HASH,
  '',
].join('\n');
const project = await newProject(
  `超长项目名称 Konstantin Oberhauser-Wettstein Benachrichtigungseinstellungen ${stamp}`,
  {
    'README.md': readme,
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "overflow-fixture", "private": true }\n',
  },
);
const { project_id } = project;
result.seed.project = project.name;
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);

const titles = {
  mixed: `${MIXED}，并且在 1280x800 窗口下侧栏行、看板卡片和命令面板里都不能把文字画出卡片 ${stamp}`,
  token: `检查这个路径 ${LONG_PATH} 在侧栏里的显示 ${stamp}`,
  latin: `Senior Product Design Engineer, Platform Infrastructure: rework onboarding so Benachrichtigungseinstellungen and Paramètres de confidentialité et de sécurité cap ${stamp}`,
  reply: `长回复：一行没有空格的哈希和一张很宽的 markdown 表格，long reply with an unbroken line and a wide markdown table to render in the transcript ${stamp}`,
};
const row = `| ${LONG_PATH} | ${BRANCH} | 等你 | ${MIXED} | ${HASH.slice(0, 64)} |`;
const table = ['| 文件 | 分支 | 状态 | 说明 | 提交 |', '|---|---|---|---|---|', row, row, row].join(
  '\n',
);
const replySteps = [
  { trace: { tool: 'Bash', input: { command: `git log --format=%H ${HASH} -- ${LONG_PATH}` } } },
  {
    say: `下面是一行没有空格的输出：\n\n${HASH}\n\n${table}\n\nhttps://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved`,
  },
];
const ids = {};
for (const [key, title] of Object.entries(titles))
  ids[key] = (
    await call('session.create', {
      project_id,
      runtime: 'fixture',
      input: `${title}\nfixture-script\n${JSON.stringify(key === 'reply' ? replySteps : [{ say: MIXED }])}`,
    })
  ).id;

// The assistant resident writes a plan whose every text field is as long as the schema allows.
const today = new Date();
const day = (offset) => new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const taskId = (i) =>
  cap(`task-${String(i).padStart(2, '0')}-with-a-long-dependency-identifier`, 40);
const lanes = [0, 1, 2].map((i) => ({
  id: `lane-${i}`,
  title: cap(`${i} 泳道 ${MIXED} Benachrichtigungseinstellungen`, 80),
}));
const iterations = [0, 1].map((i) => ({
  id: `iteration-${i}`,
  title: `${i} 迭代 ${MIXED} ${BRANCH} ${stamp}`,
  starts_on: day(i * 7 - 3),
  ends_on: day(i * 7 + 3),
}));
const tasks = Array.from({ length: 10 }, (_, i) => ({
  id: taskId(i),
  title:
    i % 3 === 1 ? cap(`${BRANCH}-${i}-${stamp}`, 80) : cap(`${i} ${MIXED} ${stamp} ${MIXED}`, 80),
  goal: cap(`${MIXED} ${LONG_PATH} ${HASH}`, 400),
  lane: lanes[i % lanes.length].id,
  milestone: 'milestone-long',
  iteration: iterations[i % 2].id,
  estimate: 13,
  depends_on: Array.from({ length: i }, (_, j) => taskId(j)),
  source: [cap(`${MIXED} ${HASH}`, 400)],
  scope: [cap(LONG_PATH.slice(1), 200)],
  acceptance: [cap(`pnpm exec vitest run ${LONG_PATH} --reporter=verbose ${HASH}`, 400)],
  kind: { domain: 'frontend-ui', tier: i % 2 ? 't2' : 't1' },
  priority: 'high',
}));
const plan = {
  base_version: 0,
  headline: cap(`${MIXED} ${stamp}`, 80),
  lanes,
  iterations,
  tasks,
  milestones: [
    {
      id: 'milestone-long',
      title: cap(`里程碑 ${MIXED} ${BRANCH}`, 80),
      criteria: [cap(`${MIXED} ${HASH}`, 400), cap(`${LONG_PATH} ${MIXED}`, 400)],
      tasks: tasks.map((t) => t.id),
      due_on: day(10),
    },
  ],
  risks: [{ text: cap(`风险 ${MIXED} ${HASH}`, 400) }, { text: cap(`${LONG_PATH} ${MIXED}`, 400) }],
  assumptions: [{ text: cap(`假设 ${HASH} ${MIXED}`, 400) }],
};
const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
await call(
  'session.send',
  {
    session_id: assistant,
    input: `fixture-script\n${JSON.stringify([{ tool: { name: 'update_board', arguments: plan } }])}`,
  },
  (await board()).sessions.find((s) => s.id === assistant).revision,
);

const mineOf = async () =>
  (await query('session.list', { project_id })).filter(
    (s) => Object.values(ids).includes(s.id) || s.id === assistant,
  );
const settled = await poll(async () => {
  const mine = await mineOf();
  const done = mine.every((s) => s.last_turn && !['queued', 'running'].includes(s.last_turn.state));
  return mine.length === 5 && done;
}, 30_000);
// The first line becomes a title of at most 40 characters; a rename takes up to 80.
for (const [key, title] of Object.entries(titles))
  await call(
    'session.rename',
    { session_id: ids[key], title: `${cap(key === 'token' ? LONG_PATH : title, 66)}-${stamp}` },
    (await board()).sessions.find((s) => s.id === ids[key]).revision,
  );
const renamed = await poll(async () => {
  const mine = await mineOf();
  return mine.filter((s) => s.title?.length === 80).length === 4 && mine;
});
const planned = await poll(async () => {
  const view = await query('board.view', { project_id, days: '7' });
  return (
    view.tasks?.filter((t) => tasks.some((p) => t.id.endsWith(`:${p.id}`))).length === tasks.length
  );
}, 15_000);
result.seed.sessions = (renamed || (await mineOf())).map((s) => ({
  title_length: s.title?.length,
  last_turn: s.last_turn?.state,
  resident: s.id === assistant,
}));
result.seed.settled = Boolean(settled);
result.seed.plan = planned ? `${tasks.length} tasks` : 'plan not on board.view';

// The resident proposes a change to its plan, which waits on the board for the user.
const leadOf = async () =>
  (await query('board.view', { project_id, days: '7' })).leads?.find(
    (l) => l.session_id === assistant,
  );
const proposal = {
  base_version: (await leadOf())?.plan_version ?? 1,
  reason: cap(`${MIXED} ${LONG_PATH} ${HASH}`, 280),
  ops: [
    { type: 'remove_task', task_id: taskId(9) },
    {
      type: 'add_task',
      task: {
        ...tasks[0],
        id: cap('task-added-with-a-long-dependency-identifier', 40),
        title: cap(`新增 ${MIXED} ${BRANCH}`, 80),
        depends_on: tasks.slice(0, 9).map((t) => t.id),
      },
    },
    {
      type: 'set_dependencies',
      task_id: taskId(8),
      depends_on: tasks.slice(0, 6).map((t) => t.id),
    },
  ],
};
await call(
  'session.send',
  {
    session_id: assistant,
    input: `fixture-script\n${JSON.stringify([{ tool: { name: 'propose_board', arguments: proposal } }])}`,
  },
  (await board()).sessions.find((s) => s.id === assistant).revision,
);
const proposed = await poll(async () => (await leadOf())?.pending_proposals?.length > 0, 15_000);
result.seed.proposal = proposed ? 'pending on board.view' : 'proposal not on board.view';

const findings = [];
/** Scans the screen now shown, records its findings and adds its two checks. */
const record = async (screen, within, shot) => {
  if (shot) result.shots.push(await page.screenshot(`${result.id}-${result.shots.length + 1}`));
  const found = await scanOverflow(page, { within });
  findings.push(...found.map((f) => ({ screen, ...f })));
  const escape = found.filter((f) => f.kind === 'escape');
  const hidden = found.filter((f) => f.kind === 'hidden');
  result.counts[screen] = {
    escape: escape.length,
    hidden: hidden.length,
    errors: (await errors()).length,
  };
  check(`no text escapes its box on ${screen}`, escape.length === 0, escape.slice(0, 5));
  check(`no cut text without its full text on ${screen}`, hidden.length === 0, hidden.slice(0, 5));
};
const quiet = (within) =>
  `!!document.querySelector(${JSON.stringify(within)}) && !document.querySelector(${JSON.stringify(`${within} [aria-busy="true"]`)})`;

// Sessions: the reply session open, its transcript drawn.
const replyRow = (renamed || []).find((s) => s.id === ids.reply);
if (replyRow) {
  await page.click({ role: 'button', name: replyRow.title, exact: false });
  await poll(() =>
    page.evaluate(
      `(document.querySelector('.app-main')?.innerText ?? '').includes(${JSON.stringify(HASH.slice(0, 64))})`,
    ),
  );
}
await record('sessions', '.app-main', true);
await record('sidebar', 'aside.sb', false);

// Board: every view of the view switch.
await page.click({ role: 'button', name: '项目看板', exact: true });
await poll(() => page.evaluate(quiet('.app-main')));
const views = await page.evaluate(
  `[...document.querySelectorAll('[role=radiogroup][aria-label="看板视图"] [role=radio]')].map((r) => r.getAttribute('aria-label'))`,
);
for (const view of views) {
  await page.click({ role: 'radio', name: view, exact: true });
  await poll(() =>
    page.evaluate(
      `document.querySelector('[role=radio][aria-label=${JSON.stringify(view)}]')?.getAttribute('aria-checked') === 'true' && ${quiet('.app-main')}`,
    ),
  );
  await record(`board ${view}`, '.app-main', true);
}
// Leaves the board on its first view for the next run.
if (views.length) await page.click({ role: 'radio', name: views[0], exact: true });

// Insights: every tab, in the bar or in its More menu.
await page.click({ role: 'button', name: '工程看板', exact: true });
await poll(() => page.evaluate(quiet('.app-main')));
const tabs = `[...document.querySelectorAll('[role=tablist][aria-label="工程看板"] [role=tab]')].map((t) => t.textContent.trim())`;
const more = { role: 'button', name: '更多标签页', exact: true };
const moreShown = `!!document.querySelector('button[aria-label="更多标签页"]')`;
// The bar drops tabs that do not fit over a few frames; read it once two reads agree.
let sections = [];
for (let last = null, i = 0; i < 20; last = sections, i++) {
  sections = await page.evaluate(`${tabs}.concat(${moreShown} ? ['+'] : [])`);
  if (last && JSON.stringify(last) === JSON.stringify(sections)) break;
  await new Promise((done) => setTimeout(done, 300));
}
sections = sections.filter((s) => s !== '+');
if (await page.evaluate(moreShown)) {
  await page.click(more);
  sections.push(
    ...(await poll(() =>
      page.evaluate(
        `(() => { const items = [...document.querySelectorAll('[role=menuitem]')].map((m) => m.textContent.trim()); return items.length ? items : null; })()`,
      ),
    )),
  );
  // Escape leaves this menu open; its trigger closes it.
  await page.click(more);
  await poll(() => page.evaluate(`!document.querySelector('[role=menu]')`));
}
for (const section of sections) {
  if ((await page.evaluate(tabs)).includes(section))
    await page.click({ role: 'tab', name: section, exact: true });
  else {
    await page.click(more);
    await page.click({ role: 'menuitem', name: section, exact: true });
  }
  await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('[role=tab][aria-selected=true]')].some((t) => t.textContent.trim() === ${JSON.stringify(section)}) && ${quiet('.app-main')}`,
    ),
  );
  await record(`insights ${section}`, '.app-main', true);
}
check('every insights tab is scanned', sections.length === 7, sections);

// Settings: every page in its nav.
await page.click({ role: 'button', name: '设置', exact: true });
// The locator gives a nav no role, so the nav is found by its name alone.
const nav = { name: '设置分区', exact: true };
await poll(() => page.evaluate(`!!document.querySelector('nav[aria-label="设置分区"]')`));
const pages = await page.evaluate(
  `[...document.querySelectorAll('nav[aria-label="设置分区"] button.ps-page')].map((b) => b.textContent.trim())`,
);
for (const name of pages) {
  await page.click({ role: 'button', name, exact: true, within: nav });
  await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('nav[aria-label="设置分区"] [aria-current=page]')].some((b) => b.textContent.trim() === ${JSON.stringify(name)}) && ${quiet('.ps-frame')}`,
    ),
  );
  await record(`settings ${name}`, '.ps-frame', name === pages[0]);
}
await reset();

// The command palette with a long query.
// Meta+K belongs to the desktop menu, which synthetic keys do not reach.
await page.click({ role: 'button', name: '搜索', exact: true });
await poll(() => page.evaluate(`!!document.querySelector('.cmdk input')`));
const box = await page.evaluate(
  `document.querySelector('.cmdk input')?.getAttribute('aria-label')`,
);
if (box) {
  await page.fill({ role: 'combobox', name: box, exact: true }, `${MIXED} ${LONG_PATH} ${HASH}`);
  await poll(() =>
    page.evaluate(
      `!!document.querySelector('.cmdk [role=option]') || (document.querySelector('.cmdk')?.innerText ?? '').includes('没有匹配的结果')`,
    ),
  );
}
check('the command palette opened from the search button', box, box);
await record('command palette', '.cmdk', true);
await page.press('Escape');

writeFileSync(path.join(runDir, 'overflow.json'), JSON.stringify(findings, null, 2));
result.findings = 'overflow.json';
result.shot = result.shots.at(-1);
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
