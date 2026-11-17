import { open } from '../page.mjs';
const runDir = process.argv[2];
let { page, query, call, errors, poll, newProject } = await open(runDir);
const result = { id: 'sessions.view-filters', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const NAME = `verify-filter-${stamp}`;
const { project_id } = await newProject(NAME);
const board = () => query('board', { project_id });
const projectRow = async () => (await board()).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);

// One resident and one worker of it that keeps running.
const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const plan = {
  base_version: 0,
  headline: 'One running worker',
  lanes: [{ id: 'work', title: `Lane ${stamp}` }],
  tasks: [
    {
      id: 'hold',
      title: `Hold ${stamp}`,
      goal: `Hold the slot\nfixture-script\n${JSON.stringify([{ hang: true }])}`,
      lane: 'work',
      depends_on: [],
      source: ['Hold the slot'],
      scope: ['hold.txt'],
      acceptance: ['test -f hold.txt'],
      kind: { domain: 'backend-logic', tier: 't1' },
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};
const steps = [
  { tool: { name: 'update_board', arguments: plan } },
  { tool: { name: 'start_task', arguments: { task_ids: ['hold'] } } },
];
await call(
  'session.send',
  { session_id: assistant, input: `fixture-script\n${JSON.stringify(steps)}` },
  (await board()).sessions.find((s) => s.id === assistant).revision,
);
const worker = await poll(
  async () =>
    (await query('session.list', { project_id })).find(
      (s) => s.lead === assistant && s.state === 'running',
    ),
  30_000,
);
check('前置：session.list 有运行中的 worker', worker, worker?.id);

const shownRows = () =>
  page.evaluate(`({
    worker: !!document.querySelector('nav.ss-list [data-session="${worker?.id}"]'),
    resident: !!document.querySelector('nav.ss-list [data-stop="resident:assistant"]'),
  })`);
const menuItems = () =>
  page.evaluate(`(() => {
    const pop = document.querySelector('.sb-vm');
    if (!pop) return null;
    return {
      heads: [...pop.querySelectorAll('.sb-vm-h')].map((h) => h.textContent.trim()),
      checks: [...pop.querySelectorAll('[role=menuitemcheckbox]')].map((m) => ({
        name: m.textContent.trim(),
        checked: m.getAttribute('aria-checked'),
      })),
    };
  })()`);
const openMenu = async () => {
  await page.click({ role: 'button', name: '分组、排序与筛选', exact: true });
  return poll(menuItems);
};
const toggleWorker = async () => {
  await openMenu();
  await page.click({ role: 'menuitemcheckbox', name: 'Worker', exact: true });
  await page.press('Escape');
};

await poll(async () => (await shownRows()).worker);
const menu = await openMenu();
result.menu = menu;
check(
  '视图菜单有 类型 和 运行时 两组',
  menu?.heads.includes('类型') && menu.heads.includes('运行时'),
  menu?.heads,
);
check(
  '类型组有 常驻/Worker/直接/分析 四个勾选项，起初都勾上',
  ['常驻', 'Worker', '直接', '分析'].every((n) =>
    menu?.checks.some((c) => c.name === n && c.checked === 'true'),
  ),
  menu?.checks,
);
check(
  '运行时组列出 fixture',
  menu?.checks.some((c) => /fixture/i.test(c.name)),
  menu?.checks.map((c) => c.name),
);
await page.press('Escape');

await toggleWorker();
const hidden = await poll(async () => {
  const rows = await shownRows();
  return !rows.worker && rows;
});
check('取消勾选 Worker 后 worker 行消失、常驻行还在', hidden && hidden.resident, hidden);

// Reload the page: the view is stored per project and must still apply.
const before = await errors();
try {
  await page.evaluate('location.reload()');
} catch {}
page.close();
({ page, query, call, errors, poll } = await open(runDir));
await page.click({ role: 'button', name: '切换项目', exact: true });
await page.click({ role: 'menuitemradio', name: NAME, exact: false });
await page.waitFor(
  `(document.querySelector('button[aria-label="切换项目"]')?.textContent ?? '').includes(${JSON.stringify(NAME)})`,
  `the sidebar to show project ${NAME}`,
);
const afterReload = await poll(async () => {
  const rows = await shownRows();
  return rows.resident && rows;
});
const stored = await page.evaluate(
  `Object.keys(localStorage).filter((k) => k.endsWith(${JSON.stringify(project_id)})).map((k) => localStorage.getItem(k))`,
);
result.stored = stored;
check('刷新后筛选还在：worker 行仍隐藏、常驻行在', afterReload && !afterReload.worker, afterReload);
check(
  '刷新后存下的视图 hiddenTypes 含 worker',
  stored.some((v) => v?.includes('"worker"')),
  stored,
);
const reopened = await openMenu();
check(
  '刷新后菜单里 Worker 未勾选',
  reopened?.checks.some((c) => c.name === 'Worker' && c.checked === 'false'),
  reopened?.checks,
);
await page.press('Escape');

await toggleWorker();
const back = await poll(async () => {
  const rows = await shownRows();
  return rows.worker && rows;
});
check('对照组：重新勾上 Worker 后 worker 行回来', back, back);
result.shot = await page.screenshot(result.id);
result.errors = [...before, ...(await errors())];
console.log(JSON.stringify(result, null, 2));
page.close();
